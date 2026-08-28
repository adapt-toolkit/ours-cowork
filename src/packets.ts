import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import type { OursClient } from '@ours.network/sdk';

import {
  FileMimeSchema,
  FileNameSchema,
  isStandardRoomIdentityName,
  MAX_EXTERNAL_INVITE_BYTES,
  MAX_FILE_BYTES,
} from './contracts.ts';
import type { OursRuntimeClientFactory } from './ours-runtime.ts';

export type InviteMode = 'one_time' | 'public';
export type RelayStatus = 'queued' | 'send_failed';
type IncomingFileMeta = Awaited<ReturnType<OursClient['listIncomingFiles']>>[number];
type HistoryMessage = NonNullable<Awaited<ReturnType<OursClient['getHistoryItem']>>>;
type ReceivedFile = Awaited<ReturnType<OursClient['getFiles']>>['files'][number];
type SendOutcome = Awaited<ReturnType<OursClient['sendMessage']>>;
type FileSendOutcome = Awaited<ReturnType<OursClient['sendFile']>>;

export interface ReplyReference {
  wire_id: string;
  sentence?: number;
}

export interface InboxItem {
  msg_id: number;
  sender_id: string;
  sender_name: string;
  text: string;
  date: string;
  wire_id: string;
  reply_to: ReplyReference | null;
}

export interface FileInboxItem {
  file_id: number;
  sender_id: string;
  sender_name: string;
  filename: string;
  mime: string;
  data: Buffer;
  date: string;
  wire_id: string;
  reply_to: ReplyReference | null;
}

export interface RoomPacket {
  readonly name: string;
  readonly cid: string;
  /** Prove and restore this packet's exact persisted daemon identity lease. */
  rebind(): Promise<{ name: string; cid: string; status: 'rebound' }>;
  mintInvite(mode: InviteMode): Promise<{ blob: string; invite_id: string; reusable: boolean }>;
  addContact(invite: string): Promise<{
    invite_id: string;
    container_id: string;
    inviter_name: string;
    pending_name: string;
  }>;
  revokeInvite(inviteId: string): Promise<{ revoked: boolean }>;
  listInvites(): Array<{ invite_id: string; mode: InviteMode }>;
  /** Whether contact records carry authenticated core invite provenance. */
  readonly supportsInviteProvenance: boolean;
  listContacts(): Array<{
    name: string;
    container_id: string;
    accepted_via_invite_id?: string;
  }>;
  /** Reconcile only contacts before retry-sensitive removal work. */
  refreshContacts(): Promise<void>;
  listUnreadMessages(limit: number): Promise<InboxItem[]>;
  acknowledgeMessage(expected: InboxItem, onUnexpected: (item: InboxItem) => Promise<void>): Promise<void>;
  listUnreadFiles(limit: number): Promise<FileInboxItem[]>;
  acknowledgeFile(expected: FileInboxItem): Promise<void>;
  send(contactCid: string, body: string, replyTo?: ReplyReference): Promise<{ status: RelayStatus; wire_id?: string }>;
  sendFile(contactCid: string, filename: string, mime: string, data: Buffer, replyTo?: ReplyReference): Promise<{ status: RelayStatus; wire_id?: string }>;
  removeContact(contactCid: string): Promise<{
    status: RelayStatus;
    notified: boolean;
    key_material_retained: true;
  }>;
}

export interface PacketRegistryOptions {
  fs?: typeof fs;
  log?: (...parts: unknown[]) => void;
  onNotify?: (roomId: string, event: string) => void;
  rebindSleep?: (ms: number) => Promise<void>;
  rebindRandom?: () => number;
}

export class LegacyCoworkStateError extends Error {
  constructor(roomId: string) {
    super(
      `room "${roomId}" uses the pre-1.0 custom packet format and cannot be opened by the standard ours SDK runtime; ` +
      'back it up with the old release, recreate the room for cowork 1.0, and re-invite its participants',
    );
    this.name = 'LegacyCoworkStateError';
  }
}

export class RoomIdentityMismatchError extends Error {
  constructor(expected: string, found: string) {
    super(`room identity CID mismatch during rebind: expected "${expected}", found "${found}"`);
    this.name = 'RoomIdentityMismatchError';
  }
}

/** Standard-SDK room identities selected from the shared daemon by local name. */
export class PacketRegistry {
  private readonly packets = new Map<string, SdkRoomPacket>();
  private readonly trackers = new Map<string, () => void>();
  private readonly host: OursRuntimeClientFactory;
  private readonly stateDir: string;
  private readonly fs: typeof fs;
  private readonly log: (...parts: unknown[]) => void;
  private readonly onNotify: (roomId: string, event: string) => void;
  private readonly rebindSleep: (ms: number) => Promise<void>;
  private readonly rebindRandom: () => number;
  private readonly unsubscribe: () => void;

  constructor(host: OursRuntimeClientFactory, stateDir: string, options: PacketRegistryOptions = {}) {
    this.host = host;
    this.stateDir = stateDir;
    this.fs = options.fs ?? fs;
    this.log = options.log ?? (() => {});
    this.onNotify = options.onNotify ?? (() => {});
    this.rebindSleep = options.rebindSleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rebindRandom = options.rebindRandom ?? Math.random;
    this.unsubscribe = host.onIdentityNotify((name) => {
      const found = [...this.packets.entries()].find(([, packet]) => packet.name === name);
      if (!found) return;
      const [roomId, packet] = found;
      void packet.refresh().then(
        () => this.onNotify(roomId, 'message_received'),
        (error) => this.log(`[${name}] failed to refresh SDK state after notification:`, error),
      );
    });
  }

  get size(): number { return this.packets.size; }
  get(roomId: string): RoomPacket | undefined { return this.packets.get(roomId); }

  async create(roomId: string, identityName: string, bio = `ours-cowork mission room ${roomId}`): Promise<RoomPacket> {
    validateRoomId(roomId);
    this.assertStandardIdentity(roomId, identityName);
    this.assertNoLegacyState(roomId);
    if (this.packets.has(roomId)) throw new Error(`room identity "${roomId}" is already hosted`);
    const localNames = new Set([identityName]);
    const available = await this.host.listIdentityNames(localNames);
    if (available.has(identityName)) {
      throw new Error(
        `shared ours daemon already contains unproven room identity "${identityName}"; ` +
        'refusing to adopt it without a durably recorded CID',
      );
    }
    const client = await this.host.createClient();
    try {
      const created = await client.createIdentity({
        name: identityName,
        bio,
        exposeLocal: false,
        localAutoAccept: true,
      });
      const cid = created.info.cid;
      const packet = new SdkRoomPacket(identityName, cid, client, {
        roomId, log: this.log, sleep: this.rebindSleep, random: this.rebindRandom,
      });
      await packet.refresh();
      this.packets.set(roomId, packet);
      this.track(roomId, identityName);
      return packet;
    } catch (error) {
      await client.releaseLease().catch(() => {});
      throw new Error(`failed to provision standard SDK identity for room "${roomId}"`, { cause: error });
    }
  }

  async restore(roomId: string, expectedCid: string, identityName: string): Promise<RoomPacket> {
    validateRoomId(roomId);
    this.assertStandardIdentity(roomId, identityName);
    this.assertNoLegacyState(roomId);
    if (expectedCid === undefined || expectedCid.length === 0) {
      throw new Error(`refusing to restore room identity "${identityName}" without a durably recorded expected CID`);
    }
    if (this.packets.has(roomId)) throw new Error(`room identity "${roomId}" is already hosted`);
    const available = await this.host.listIdentityNames(new Set([identityName]));
    if (!available.has(identityName)) {
      throw new Error(`shared ours daemon does not contain the established room identity "${identityName}"`);
    }
    const client = await this.host.createClient();
    try {
      const bound = await client.chooseIdentity({ name: identityName, force: false });
      if (expectedCid !== undefined && bound.cid !== expectedCid) {
        throw new Error(`restored room identity CID mismatch: expected "${expectedCid}", found "${bound.cid}"`);
      }
      const packet = new SdkRoomPacket(identityName, bound.cid, client, {
        roomId, log: this.log, sleep: this.rebindSleep, random: this.rebindRandom,
      });
      await packet.refresh();
      this.packets.set(roomId, packet);
      this.track(roomId, identityName);
      return packet;
    } catch (error) {
      await client.releaseLease().catch(() => {});
      throw error;
    }
  }

  async rebind(roomId: string): Promise<{ name: string; cid: string; status: 'rebound' }> {
    validateRoomId(roomId);
    const packet = this.packets.get(roomId);
    if (!packet) throw new Error(`room packet "${roomId}" is not hosted`);
    return packet.rebind();
  }

  /** Release one local SDK lease without deleting the persisted daemon identity. */
  async unhost(roomId: string): Promise<void> {
    validateRoomId(roomId);
    const packet = this.packets.get(roomId);
    if (!packet) return;
    this.untrack(roomId);
    this.packets.delete(roomId);
    await packet.close();
  }

  async destroy(roomId: string): Promise<string[]> {
    validateRoomId(roomId);
    const packet = this.packets.get(roomId);
    if (!packet) return [];
    try {
      await packet.destroy();
      this.packets.delete(roomId);
      return [];
    } catch (error) {
      throw new Error(`failed to remove standard SDK identity for room "${roomId}"`, { cause: error });
    } finally {
      // A failed destroy must not leave a watch polling an identity this
      // registry has stopped answering for.
      this.untrack(roomId);
    }
  }

  async unhostAll(): Promise<void> {
    this.unsubscribe();
    for (const roomId of [...this.trackers.keys()]) this.untrack(roomId);
    const errors: unknown[] = [];
    for (const [roomId, packet] of [...this.packets]) {
      try { await packet.close(); } catch (error) { errors.push(error); }
      this.packets.delete(roomId);
    }
    if (errors.length) throw new AggregateError(errors, 'failed to release room SDK leases');
  }

  /** Begin the shared daemon notification watch for one locally known name. */
  private track(roomId: string, identityName: string): void {
    this.trackers.set(roomId, this.host.trackIdentity(identityName));
  }

  private untrack(roomId: string): void {
    const dispose = this.trackers.get(roomId);
    if (!dispose) return;
    this.trackers.delete(roomId);
    try { dispose(); } catch (error) {
      this.log(`failed to stop the notification watch for room "${roomId}":`, error);
    }
  }

  private assertNoLegacyState(roomId: string): void {
    const live = join(this.stateDir, 'rooms', roomId, 'live');
    if (this.fs.existsSync(join(live, 'identity.key')) || this.fs.existsSync(join(live, 'state_data.bin'))) {
      throw new LegacyCoworkStateError(roomId);
    }
  }

  private assertStandardIdentity(roomId: string, identityName: string): void {
    if (!isStandardRoomIdentityName(roomId, identityName)) throw new LegacyCoworkStateError(roomId);
  }
}

export class SdkRoomPacket implements RoomPacket {
  readonly name: string;
  readonly cid: string;
  private readonly client: OursClient;
  private readonly roomId: string;
  private readonly log: (...parts: unknown[]) => void;
  private readonly rebindSleep: (ms: number) => Promise<void>;
  private readonly rebindRandom: () => number;
  private rebindWork?: Promise<{ name: string; cid: string; status: 'rebound' }>;
  private contacts: Array<{
    name: string;
    container_id: string;
    accepted_via_invite_id?: string;
  }> = [];
  private hasInviteProvenance = false;
  private invites: Array<{ invite_id: string; mode: InviteMode }> = [];
  private refreshWork?: Promise<void>;
  private contactRefreshWork?: Promise<void>;

  constructor(
    name: string,
    cid: string,
    client: OursClient,
    recovery: {
      roomId?: string;
      log?: (...parts: unknown[]) => void;
      sleep?: (ms: number) => Promise<void>;
      random?: () => number;
    } = {},
  ) {
    this.roomId = recovery.roomId ?? name;
    this.name = name;
    this.cid = cid;
    this.client = client;
    this.log = recovery.log ?? (() => {});
    this.rebindSleep = recovery.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rebindRandom = recovery.random ?? Math.random;
  }

  rebind(): Promise<{ name: string; cid: string; status: 'rebound' }> {
    this.rebindWork ??= this.rebindUnlocked().finally(() => { this.rebindWork = undefined; });
    return this.rebindWork;
  }

  private async rebindUnlocked(): Promise<{ name: string; cid: string; status: 'rebound' }> {
    this.observe('identity_rebind_detected');
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.observe('identity_rebind_attempt', { attempt });
      try {
        const bound = await this.client.chooseIdentity({ name: this.name, force: false });
        if (bound.cid !== this.cid) {
          throw new RoomIdentityMismatchError(this.cid, bound.cid);
        }
        // Direct calls are intentional: calling refresh()/runBound() while the
        // single-flight promise is active would recursively wait on itself.
        await this.refreshUnlocked();
        this.observe('identity_rebind_succeeded', { attempt });
        return { name: this.name, cid: this.cid, status: 'rebound' };
      } catch (error) {
        lastError = error;
        const code = sdkErrorCode(error);
        if (error instanceof RoomIdentityMismatchError || !isTransientTransportError(error) || attempt === 3) {
          this.observe('identity_rebind_failed', {
            attempt,
            code: code ?? (error instanceof RoomIdentityMismatchError ? 'CID_MISMATCH' : 'RECOVERY_FAILED'),
          });
          throw error;
        }
        const delay_ms = Math.round(100 * (2 ** (attempt - 1)) * (0.75 + this.rebindRandom() * 0.5));
        this.observe('identity_rebind_retry', { attempt, delay_ms });
        await this.rebindSleep(delay_ms);
      }
    }
    throw lastError;
  }

  private async runBound<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const code = sdkErrorCode(error);
      if (code !== 'NOT_BOUND' && code !== 'BINDING_REASSIGNED') throw error;
      await this.rebind();
      return operation();
    }
  }

  private observe(event: string, detail: Record<string, unknown> = {}): void {
    this.log(JSON.stringify({ event, room_id: this.roomId, identity_name: this.name, identity_cid: this.cid, ...detail }));
  }

  refresh(): Promise<void> {
    this.refreshWork ??= this.runBound(() => this.refreshUnlocked()).finally(() => { this.refreshWork = undefined; });
    return this.refreshWork;
  }

  private async refreshUnlocked(): Promise<void> {
    await this.refreshContactsUnlocked();
    this.invites = (await this.client.listInvites()).flatMap((invite) =>
      invite.mode === 'one_time' || invite.mode === 'public'
        ? [{ invite_id: invite.invite_id, mode: invite.mode }]
        : []);
  }

  refreshContacts(): Promise<void> {
    this.contactRefreshWork ??= this.runBound(() => this.refreshContactsUnlocked())
      .finally(() => { this.contactRefreshWork = undefined; });
    return this.contactRefreshWork;
  }

  private async refreshContactsUnlocked(): Promise<void> {
    type ContactsWithOrigins = Awaited<ReturnType<OursClient['listContacts']>> & {
      origins?: Record<string, string>;
    };
    const listed = await this.client.listContacts() as ContactsWithOrigins;
    this.hasInviteProvenance = listed.origins !== undefined;
    this.contacts = listed.contacts.map((contact) => ({
      ...contact,
      ...(listed.origins?.[contact.container_id] === undefined
        ? {}
        : { accepted_via_invite_id: listed.origins[contact.container_id] }),
    }));
  }

  async mintInvite(mode: InviteMode): Promise<{ blob: string; invite_id: string; reusable: boolean }> {
    const result = await this.runBound(() => this.client.generateInvite({ mode }));
    await this.refresh();
    return { blob: result.blob, invite_id: result.inviteId, reusable: mode === 'public' };
  }

  async addContact(invite: string): Promise<{ invite_id: string; container_id: string; inviter_name: string; pending_name: string }> {
    const decoded = unpackInvite(invite, MAX_EXTERNAL_INVITE_BYTES);
    const result = await this.runBound(() => this.client.addContact({ invite }));
    await this.refresh();
    return {
      invite_id: createHash('sha256').update(decoded).digest('hex'),
      container_id: result.cid,
      inviter_name: result.display,
      pending_name: result.display,
    };
  }

  async revokeInvite(inviteId: string): Promise<{ revoked: boolean }> {
    const result = await this.runBound(() => this.client.revokeInvite({ invite_id: inviteId }));
    await this.refresh();
    return { revoked: result.revoked };
  }

  listInvites(): Array<{ invite_id: string; mode: InviteMode }> { return this.invites.map((invite) => ({ ...invite })); }
  get supportsInviteProvenance(): boolean { return this.hasInviteProvenance; }
  listContacts(): Array<{
    name: string;
    container_id: string;
    accepted_via_invite_id?: string;
  }> {
    return this.contacts.map((contact) => ({ ...contact }));
  }

  async listUnreadMessages(limit: number): Promise<InboxItem[]> {
    validateBatchLimit(limit);
    const metadata = (await this.runBound(() => this.client.listIncomingMessages()))
      .filter((message) => message.status === 'unread')
      .sort((left, right) => left.seq - right.seq)
      .slice(0, limit);
    return Promise.all(metadata.map(async (listed) => {
      const history = await this.runBound(() => this.client.getHistoryItem({ wire_id: listed.wire_id }));
      if (history === null) throw new Error(`SDK history is missing unread message ${listed.wire_id}`);
      assertListedMessage(listed, history);
      return messageItem(history);
    }));
  }

  async acknowledgeMessage(
    expected: InboxItem,
    onUnexpected: (item: InboxItem) => Promise<void>,
  ): Promise<void> {
    for (;;) {
      const pulled = await this.runBound(() => this.client.getMessages({ limit: 1 }));
      if (pulled.messages.length > 1) throw new Error('SDK returned more than one message for limit 1');
      const [history] = pulled.messages;
      if (history === undefined) return;
      const item = messageItem(history, 'read');
      if (sameMessageSource(item, expected)) {
        assertSameMessage(item, expected);
        return;
      }
      await onUnexpected(item);
    }
  }

  async listUnreadFiles(limit: number): Promise<FileInboxItem[]> {
    validateBatchLimit(limit);
    const unread = (await this.runBound(() => this.client.listIncomingFiles()))
      .filter((file) => file.status === 'unread')
      .sort((left, right) => left.seq - right.seq)
      .slice(0, limit);
    return Promise.all(unread.map(async (file) => fileItem(file, await this.runBound(() => this.client.fetchFile(file.wire_id)))));
  }

  async acknowledgeFile(expected: FileInboxItem): Promise<void> {
    const pulled = await this.runBound(() => this.client.getFiles({ wire_ids: [expected.wire_id] }));
    if (pulled.files.length !== 1) {
      throw new Error(`SDK did not acknowledge selected file ${expected.wire_id}`);
    }
    assertReceivedFile(expected, pulled.files[0]!);
  }

  async send(contactCid: string, body: string, replyTo?: ReplyReference): Promise<{ status: RelayStatus; wire_id?: string }> {
    return sendResult(await this.runBound(() => this.client.sendMessage({
      contact: contactCid,
      text: body,
      ...(replyTo === undefined ? {} : {
        reply_to_wire_id: replyTo.wire_id,
        ...(replyTo.sentence === undefined ? {} : { reply_to_sentence: replyTo.sentence }),
      }),
    })));
  }

  async sendFile(contactCid: string, filename: string, mime: string, data: Buffer, replyTo?: ReplyReference): Promise<{ status: RelayStatus; wire_id?: string }> {
    const validName = FileNameSchema.parse(filename);
    const validMime = FileMimeSchema.parse(mime);
    if (data.length > MAX_FILE_BYTES) throw new RangeError(`room files must be at most ${MAX_FILE_BYTES} bytes (2 MiB)`);
    return sendResult(await this.runBound(() => this.client.sendFile({
      contact: contactCid,
      data_base64: data.toString('base64'),
      filename: validName,
      mime: validMime,
      ...(replyTo === undefined ? {} : {
        reply_to_wire_id: replyTo.wire_id,
        ...(replyTo.sentence === undefined ? {} : { reply_to_sentence: replyTo.sentence }),
      }),
    })));
  }

  async removeContact(contactCid: string): Promise<{ status: RelayStatus; notified: boolean; key_material_retained: true }> {
    const result = await this.runBound(() => this.client.removeContact({ contact: contactCid }));
    const notified = result.notified === true;
    // The mutation response is authoritative for this exact target, but it is
    // not a replacement contact list. Evict only that target synchronously so
    // a later, unrelated refresh failure cannot resurrect it in this process.
    // The next close attempt refreshes the complete view before taking effects.
    this.contacts = this.contacts.filter((contact) => contact.container_id !== contactCid);
    return { status: notified ? 'queued' : 'send_failed', notified, key_material_retained: true };
  }

  async close(): Promise<void> { await this.client.releaseLease(); }

  async destroy(): Promise<void> {
    await this.client.removeIdentity({ name: this.name });
    await this.client.releaseLease();
  }
}

function sdkErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function isTransientTransportError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false;
  return new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])
    .has(String(error.code));
}

function sendResult(result: SendOutcome | FileSendOutcome): { status: RelayStatus; wire_id?: string } {
  if (result.kind === 'refused' || result.kind === 'migrating') {
    return { status: 'send_failed' };
  }
  return { status: 'queued', wire_id: result.wireId };
}

async function fileItem(file: IncomingFileMeta, bytes: Uint8Array): Promise<FileInboxItem> {
  assertIncomingFile(file, bytes);
  return {
    file_id: file.file_id,
    sender_id: file.from.id,
    sender_name: file.from.name,
    filename: file.filename,
    mime: file.mime,
    data: Buffer.from(bytes),
    date: normalizeDate(file.date),
    wire_id: file.wire_id,
    reply_to: cloneReply(file.reply_to),
  };
}

function messageItem(history: HistoryMessage, expectedState: 'unread' | 'read' = 'unread'): InboxItem {
  if (history.direction !== 'in'
    || history.inbox_state !== expectedState
    || history.status !== expectedState
    || history.text !== history.body) {
    throw new Error(`SDK returned an invalid ${expectedState} message history row ${history.wire_id}`);
  }
  validateSequence(history.seq, 'message');
  validateNumericId(history.msg_id, 'message');
  validateHistoryWireId(history.wire_id, 'message');
  validateReply(history.reply_to, 'message');
  return {
    msg_id: history.msg_id,
    sender_id: history.from.id,
    sender_name: history.from.name,
    text: history.text,
    date: normalizeDate(history.date),
    wire_id: history.wire_id,
    reply_to: cloneReply(history.reply_to),
  };
}

function assertListedMessage(
  listed: Awaited<ReturnType<OursClient['listIncomingMessages']>>[number],
  history: HistoryMessage,
): void {
  if (listed.seq !== history.seq
    || listed.msg_id !== history.msg_id
    || listed.wire_id !== history.wire_id
    || listed.from.id !== history.from.id
    || listed.from.name !== history.from.name
    || normalizeDate(listed.date) !== normalizeDate(history.date)
    || listed.encryption !== history.encryption
    || !sameReply(listed.reply_to, history.reply_to)) {
    throw new Error(`SDK unread metadata does not match message history ${listed.wire_id}`);
  }
}

function assertIncomingFile(file: IncomingFileMeta, bytes: Uint8Array): void {
  if (file.direction !== 'in' || file.inbox_state !== 'unread' || file.status !== 'unread') {
    throw new Error(`SDK returned an invalid unread file history row ${file.wire_id}`);
  }
  validateSequence(file.seq, 'file');
  validateNumericId(file.file_id, 'file');
  validateSelectableFileWireId(file.wire_id);
  validateReply(file.reply_to, 'file');
  if (file.byte_length !== bytes.byteLength
    || file.size !== bytes.byteLength
    || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new Error(`SDK blob does not match unread file metadata ${file.wire_id}`);
  }
}

function assertReceivedFile(expected: FileInboxItem, received: ReceivedFile): void {
  if (received.status !== 'processed'
    || received.file_id !== expected.file_id
    || received.wire_id !== expected.wire_id
    || received.from.id !== expected.sender_id
    || received.from.name !== expected.sender_name
    || received.filename !== expected.filename
    || received.mime !== expected.mime
    || received.size !== expected.data.byteLength
    || received.sha256 !== createHash('sha256').update(expected.data).digest('hex')
    || normalizeDate(received.date) !== expected.date) {
    throw new Error(`SDK selected file response does not match ${expected.wire_id}`);
  }
}

function sameMessageSource(left: InboxItem, right: InboxItem): boolean {
  return left.msg_id === right.msg_id && left.wire_id === right.wire_id;
}

function assertSameMessage(observed: InboxItem, expected: InboxItem): void {
  if (observed.sender_id !== expected.sender_id
    || observed.sender_name !== expected.sender_name
    || observed.text !== expected.text
    || observed.date !== expected.date
    || !sameReply(observed.reply_to, expected.reply_to)) {
    throw new Error(`SDK acknowledged message does not match ${expected.wire_id}`);
  }
}

function sameReply(left: ReplyReference | null, right: ReplyReference | null): boolean {
  if (left === null || right === null) return left === right;
  return left.wire_id === right.wire_id && left.sentence === right.sentence;
}

function validateBatchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw new RangeError('SDK intake batch limit must be an integer from 1 through 32');
  }
}

function validateSequence(value: number, kind: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`SDK returned an invalid ${kind} history sequence`);
}

function validateNumericId(value: number, kind: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`SDK returned an invalid ${kind} inbox id`);
}

function validateHistoryWireId(value: string, kind: string): void {
  if (value.length < 1 || value.length > 256) throw new Error(`SDK returned an invalid ${kind} wire id`);
}

function validateSelectableFileWireId(value: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('SDK returned an invalid selectable file wire id');
}

function validateReply(value: ReplyReference | null, kind: string): void {
  if (value === null) return;
  validateHistoryWireId(value.wire_id, `${kind} reply`);
  if (value.sentence !== undefined && (!Number.isSafeInteger(value.sentence) || value.sentence < 1)) {
    throw new Error(`SDK returned an invalid ${kind} reply sentence`);
  }
}

function cloneReply(reply: ReplyReference | null): ReplyReference | null {
  return reply === null ? null : {
    wire_id: reply.wire_id,
    ...(reply.sentence === undefined ? {} : { sentence: reply.sentence }),
  };
}

function normalizeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`SDK returned an invalid message timestamp: ${value}`);
  return date.toISOString();
}

function validateRoomId(roomId: string): void {
  if (!/^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(roomId)) throw new Error(`invalid room id "${roomId}"`);
}

export function unpackInvite(encoded: string, maximumBytes?: number): Buffer {
  const normalized = encoded.replace(/\s+/g, '');
  if ((maximumBytes !== undefined && Buffer.byteLength(encoded, 'utf8') > maximumBytes)
    || normalized.length === 0 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error('the invite blob is empty, oversized, or invalid base64url');
  }
  const compressed = Buffer.from(normalized, 'base64url');
  if (compressed.length === 0) throw new Error('the invite blob is empty or invalid base64url');
  return Buffer.from(maximumBytes === undefined
    ? brotliDecompressSync(compressed)
    : brotliDecompressSync(compressed, { maxOutputLength: maximumBytes }));
}

export function packInvite(raw: Buffer): string {
  return brotliCompressSync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  }).toString('base64url');
}
