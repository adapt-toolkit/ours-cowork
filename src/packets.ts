import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import type {
  IncomingFileMeta,
  OursClient,
  SendOutcome,
  FileSendOutcome,
} from '@ours.network/sdk';

import { FileMimeSchema, FileNameSchema, MAX_EXTERNAL_INVITE_BYTES, MAX_FILE_BYTES } from './contracts.ts';
import type { OursRuntimeClientFactory } from './ours-runtime.ts';

export type InviteMode = 'one_time' | 'public';
export type RelayStatus = 'queued' | 'send_failed';

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
  mintInvite(mode: InviteMode): Promise<{ blob: string; invite_id: string; reusable: boolean }>;
  addContact(invite: string): Promise<{
    invite_id: string;
    container_id: string;
    inviter_name: string;
    pending_name: string;
  }>;
  revokeInvite(inviteId: string): Promise<{ revoked: boolean }>;
  listInvites(): Array<{ invite_id: string; mode: InviteMode }>;
  listContacts(): Array<{ name: string; container_id: string }>;
  peekInbox(): InboxItem[];
  consumeInbox(expectedIds: number[]): Promise<{ consumed: number[]; deferred: number[] }>;
  peekFileInbox(): FileInboxItem[];
  consumeFileInbox(expectedIds: number[]): Promise<{ consumed: number[]; deferred: number[] }>;
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

/** Standard-SDK identities owned by the one embedded runtime. */
export class PacketRegistry {
  private readonly packets = new Map<string, SdkRoomPacket>();
  private readonly trackers = new Map<string, () => void>();
  private readonly host: OursRuntimeClientFactory;
  private readonly stateDir: string;
  private readonly fs: typeof fs;
  private readonly log: (...parts: unknown[]) => void;
  private readonly onNotify: (roomId: string, event: string) => void;
  private readonly unsubscribe: () => void;

  constructor(host: OursRuntimeClientFactory, stateDir: string, options: PacketRegistryOptions = {}) {
    this.host = host;
    this.stateDir = stateDir;
    this.fs = options.fs ?? fs;
    this.log = options.log ?? (() => {});
    this.onNotify = options.onNotify ?? (() => {});
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

  async create(roomId: string, identityName = `ours-cowork-${roomId}`, bio = `ours-cowork mission room ${roomId}`): Promise<RoomPacket> {
    validateRoomId(roomId);
    this.assertStandardIdentity(roomId, identityName);
    this.assertNoLegacyState(roomId);
    if (this.packets.has(roomId)) throw new Error(`room identity "${roomId}" is already hosted`);
    const client = this.host.createClient();
    try {
      let cid: string;
      try {
        cid = (await client.chooseIdentity({ name: identityName, force: false })).cid;
      } catch (error) {
        if (!hasOursCode(error, 'NO_SUCH_IDENTITY')) throw error;
        const created = await client.createIdentity({
          name: identityName,
          bio,
          exposeLocal: false,
          localAutoAccept: true,
        });
        cid = created.info.cid;
      }
      const packet = new SdkRoomPacket(identityName, cid, client);
      await packet.refresh();
      this.packets.set(roomId, packet);
      this.track(roomId, identityName);
      return packet;
    } catch (error) {
      await client.releaseLease().catch(() => {});
      throw new Error(`failed to provision standard SDK identity for room "${roomId}"`, { cause: error });
    }
  }

  async restore(roomId: string, expectedCid?: string, identityName = `ours-cowork-${roomId}`): Promise<RoomPacket> {
    validateRoomId(roomId);
    this.assertStandardIdentity(roomId, identityName);
    this.assertNoLegacyState(roomId);
    if (this.packets.has(roomId)) throw new Error(`room identity "${roomId}" is already hosted`);
    const client = this.host.createClient();
    try {
      const bound = await client.chooseIdentity({ name: identityName, force: false });
      if (expectedCid !== undefined && bound.cid !== expectedCid) {
        throw new Error(`restored room identity CID mismatch: expected "${expectedCid}", found "${bound.cid}"`);
      }
      const packet = new SdkRoomPacket(identityName, bound.cid, client);
      await packet.refresh();
      this.packets.set(roomId, packet);
      this.track(roomId, identityName);
      return packet;
    } catch (error) {
      await client.releaseLease().catch(() => {});
      throw error;
    }
  }

  async destroy(roomId: string): Promise<string[]> {
    validateRoomId(roomId);
    const packet = this.packets.get(roomId);
    if (!packet) return [];
    try {
      await packet.destroy();
      this.packets.delete(roomId);
      this.untrack(roomId);
      return [];
    } catch (error) {
      throw new Error(`failed to remove standard SDK identity for room "${roomId}"`, { cause: error });
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

  /**
   * Hosts that watch the runtime from outside need to be told which identities
   * exist; an embedded host omits `trackIdentity` and keeps its own callback.
   */
  private track(roomId: string, identityName: string): void {
    const dispose = this.host.trackIdentity?.(identityName);
    if (dispose) this.trackers.set(roomId, dispose);
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
    if (identityName !== `ours-cowork-${roomId}`) throw new LegacyCoworkStateError(roomId);
  }
}

export class SdkRoomPacket implements RoomPacket {
  readonly name: string;
  readonly cid: string;
  private readonly client: OursClient;
  private contacts: Array<{ name: string; container_id: string }> = [];
  private invites: Array<{ invite_id: string; mode: InviteMode }> = [];
  private inbox: InboxItem[] = [];
  private fileInbox: FileInboxItem[] = [];
  private refreshWork?: Promise<void>;

  constructor(name: string, cid: string, client: OursClient) {
    this.name = name;
    this.cid = cid;
    this.client = client;
  }

  refresh(): Promise<void> {
    this.refreshWork ??= this.refreshUnlocked().finally(() => { this.refreshWork = undefined; });
    return this.refreshWork;
  }

  private async refreshUnlocked(): Promise<void> {
    const contacts = await this.client.listContacts();
    this.contacts = contacts.contacts.map((contact) => ({ ...contact }));
    this.invites = (await this.client.listInvites()).flatMap((invite) =>
      invite.mode === 'one_time' || invite.mode === 'public'
        ? [{ invite_id: invite.invite_id, mode: invite.mode }]
        : []);
    this.inbox = (await this.client.listIncomingMessages())
      .filter((message) => message.status === 'unread')
      .map((message) => ({
        msg_id: message.msg_id,
        sender_id: message.sender_id,
        sender_name: message.sender_name,
        text: message.text,
        date: normalizeDate(message.date),
        wire_id: message.wire_id,
        reply_to: cloneReply(message.reply_to),
      }));
    await this.refreshFiles();
  }

  private async refreshFiles(): Promise<void> {
    const unread = (await this.client.listIncomingFiles()).filter((file) => file.status === 'unread');
    if (unread.length === 0) {
      this.fileInbox = [];
      return;
    }
    const ids = unread.map((file) => file.file_id);
    const wires = unread.map((file) => file.wire_id);
    try {
      await this.client.getFiles({ wire_ids: wires });
      this.fileInbox = await Promise.all(unread.map(async (file) => fileItem(file, await this.client.fetchFile(file.wire_id))));
    } finally {
      await this.client.deferFiles({ file_ids: ids }).catch(() => {});
    }
  }

  async mintInvite(mode: InviteMode): Promise<{ blob: string; invite_id: string; reusable: boolean }> {
    const result = await this.client.generateInvite({ mode });
    await this.refresh();
    return { blob: result.blob, invite_id: result.inviteId, reusable: mode === 'public' };
  }

  async addContact(invite: string): Promise<{ invite_id: string; container_id: string; inviter_name: string; pending_name: string }> {
    const decoded = unpackInvite(invite, MAX_EXTERNAL_INVITE_BYTES);
    const result = await this.client.addContact({ invite });
    await this.refresh();
    return {
      invite_id: createHash('sha256').update(decoded).digest('hex'),
      container_id: result.cid,
      inviter_name: result.display,
      pending_name: result.display,
    };
  }

  async revokeInvite(inviteId: string): Promise<{ revoked: boolean }> {
    const result = await this.client.revokeInvite({ invite_id: inviteId });
    await this.refresh();
    return { revoked: result.revoked };
  }

  listInvites(): Array<{ invite_id: string; mode: InviteMode }> { return this.invites.map((invite) => ({ ...invite })); }
  listContacts(): Array<{ name: string; container_id: string }> { return this.contacts.map((contact) => ({ ...contact })); }
  peekInbox(): InboxItem[] { return this.inbox.map((item) => ({ ...item })); }
  peekFileInbox(): FileInboxItem[] { return this.fileInbox.map((item) => ({ ...item, data: Buffer.from(item.data) })); }

  async consumeInbox(expectedIds: number[]): Promise<{ consumed: number[]; deferred: number[] }> {
    if (expectedIds.length === 0) return { consumed: [], deferred: [] };
    const pulled = await this.client.getMessages();
    const expected = new Set(expectedIds);
    const consumed = pulled.messages.filter((message) => expected.has(message.msg_id)).map((message) => message.msg_id);
    const deferred = pulled.messages.filter((message) => !expected.has(message.msg_id)).map((message) => message.msg_id);
    if (deferred.length) await this.client.deferMessages({ msg_ids: deferred });
    await this.refresh();
    return { consumed, deferred };
  }

  async consumeFileInbox(expectedIds: number[]): Promise<{ consumed: number[]; deferred: number[] }> {
    const expected = new Set(expectedIds);
    const selected = this.fileInbox.filter((file) => expected.has(file.file_id));
    if (selected.length) await this.client.getFiles({ wire_ids: selected.map((file) => file.wire_id) });
    this.fileInbox = this.fileInbox.filter((file) => !expected.has(file.file_id));
    return { consumed: selected.map((file) => file.file_id), deferred: [] };
  }

  async send(contactCid: string, body: string, replyTo?: ReplyReference): Promise<{ status: RelayStatus; wire_id?: string }> {
    return sendResult(await this.client.sendMessage({
      contact: contactCid,
      text: body,
      ...(replyTo === undefined ? {} : {
        reply_to_wire_id: replyTo.wire_id,
        ...(replyTo.sentence === undefined ? {} : { reply_to_sentence: replyTo.sentence }),
      }),
    }));
  }

  async sendFile(contactCid: string, filename: string, mime: string, data: Buffer, replyTo?: ReplyReference): Promise<{ status: RelayStatus; wire_id?: string }> {
    const validName = FileNameSchema.parse(filename);
    const validMime = FileMimeSchema.parse(mime);
    if (data.length > MAX_FILE_BYTES) throw new RangeError(`room files must be at most ${MAX_FILE_BYTES} bytes (2 MiB)`);
    return sendResult(await this.client.sendFile({
      contact: contactCid,
      data_base64: data.toString('base64'),
      filename: validName,
      mime: validMime,
      ...(replyTo === undefined ? {} : {
        reply_to_wire_id: replyTo.wire_id,
        ...(replyTo.sentence === undefined ? {} : { reply_to_sentence: replyTo.sentence }),
      }),
    }));
  }

  async removeContact(contactCid: string): Promise<{ status: RelayStatus; notified: boolean; key_material_retained: true }> {
    const result = await this.client.removeContact({ contact: contactCid });
    const notified = result.notified === true;
    await this.refresh();
    return { status: notified ? 'queued' : 'send_failed', notified, key_material_retained: true };
  }

  async close(): Promise<void> { await this.client.releaseLease(); }

  async destroy(): Promise<void> {
    await this.client.removeIdentity({ name: this.name });
    await this.client.releaseLease();
  }
}

function sendResult(result: SendOutcome | FileSendOutcome): { status: RelayStatus; wire_id?: string } {
  if (result.kind === 'refused' || result.kind === 'migrating') return { status: 'send_failed' };
  if (result.kind === 'introduced') return { status: 'queued' };
  return { status: 'queued', wire_id: result.wireId };
}

async function fileItem(file: IncomingFileMeta, bytes: Uint8Array): Promise<FileInboxItem> {
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

function hasOursCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as Error & { code?: unknown }).code === code;
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
