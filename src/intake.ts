import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  LowerCrockfordUlidSchema,
  FileMimeSchema,
  FileNameSchema,
  MAX_FILE_BYTES,
  Rfc3339Schema,
  RoomSchema,
  ROOM_ROLE,
  type CommunicationRecord,
  type Room,
} from './contracts.ts';
import type { FileInboxItem, InboxItem, RoomPacket, RelayDispatchOptions } from './packets.ts';
import type { CoworkStore, RoomMutex } from './storage.ts';
import { generateUlid } from './ulid.ts';
import { readReplyRows, selectReply } from './reply-threading.ts';
import { classifyThreadAssociation, publicThreadAuthor, publicThreadMetadata, resolveIntakeScope, threadRelayEligible } from './threads.ts';
import { ThreadFailure } from './thread-contracts.ts';

type IntakeStore = Pick<CoworkStore, 'mutex' | 'load' | 'save' | 'append' | 'read'>
  & Partial<Pick<CoworkStore, 'query' | 'recordsNeedingRelayIntents' | 'relayRecipientsNeedingIntent'>>;
type MessageRecord = Extract<CommunicationRecord, { kind: 'message' }>;
type FileRecord = Extract<CommunicationRecord, { kind: 'file' }>;
type RelayIntentRecord = Extract<CommunicationRecord, { kind: 'relay_intent' }>;
type RelayResultDraft = Omit<Extract<CommunicationRecord, { kind: 'relay_result' }>, 'seq' | 'record_id'>;

/** An observed effect has no acknowledged durable result; never waive it on teardown. */
export class RelayDurabilityError extends Error {
  constructor(cause: unknown) {
    super(`relay result durability unresolved: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'RelayDurabilityError';
  }
}

export interface IntakePacketRegistry {
  get(roomId: string): RoomPacket | undefined;
}

export interface IntakePumpOptions {
  now?: () => string;
  messageId?: () => string;
  shouldPause?: (roomId: string) => Promise<boolean>;
  afterPump?: (roomId: string) => Promise<void>;
}

interface NotificationState {
  dirty: boolean;
  work: Promise<void>;
}

const JOURNAL_WORK_BATCH_SIZE = 64;

const INTAKE_BATCH_SIZE = 32;

interface ClaimedNotice {
  recipient: string;
  body: Record<string, unknown>;
  participantId: string;
  epoch: number;
  removedEpoch?: number;
  seatState: Room['seats'][number]['state'];
  roomState: Room['state'];
  kind: 'rejection' | 'bounce';
}

/**
 * Produce the byte-stable JSON representation sent by room identities.
 * Arrays retain their order; keys of every object nested inside them are
 * sorted as well. Envelope values are already schema-controlled JSON values.
 */
export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value));
  if (encoded === undefined) throw new TypeError('canonical JSON value is not serializable');
  return encoded;
}

/**
 * THE ONLY PLACE A ROOM BODY CROSSES THE WIRE.
 *
 * Every outbound envelope is canonicalised and sent here. Standard SDK
 * identities authenticate the transport; cowork 1.0 no longer reaches into a
 * custom actor to add a second application-level signature.
 *
 * The byte-level privacy tests assert that no real cid, contact display
 * name or sender-claimed name appears in any relayed body of an anonymous room.
 * They read the bodies produced by the send sites that existed when they were
 * written. There were two. NOTHING ASSERTED THAT THERE WERE ONLY TWO, so the
 * moment someone added a third — a file relay, a receipt, a control notice —
 * the pins would go on passing while covering strictly less of the code. A
 * gate that silently stops covering new code is worse than no gate, because
 * its green is read as though it still means what it did.
 *
 * So: one funnel, and `tests/intake.test.mjs` enumerates the `packet.send`
 * call sites in `src/` and fails if there is more than this one. Adding an
 * outbound path now forces you through the funnel the pins already read.
 *
 * It deliberately does NOT interpret the outcome or touch the ledger — callers
 * differ on that (the bounce is best-effort, the relay journals a result), and
 * folding either in here would make the funnel a policy decision instead of a
 * choke point.
 */
export async function sendRoomBody(
  packet: Pick<RoomPacket, 'send'>,
  recipientIdentity: string,
  unsigned: Record<string, unknown>,
  replyTo?: Parameters<RoomPacket['send']>[2],
  options?: RelayDispatchOptions,
): Promise<Awaited<ReturnType<RoomPacket['send']>>> {
  return packet.send(recipientIdentity, canonicalJson(unsigned), replyTo, options);
}

/** Archive, consume, and relay participant messages for hosted room packets. */
export class IntakePump {
  private readonly processing = new AsyncLocalStorage<{ roomId: string; active: boolean }>();
  private readonly store: IntakeStore;
  private readonly packets: IntakePacketRegistry;
  private readonly nowValue: () => string;
  private readonly nextMessageId: () => string;
  private readonly pumps = new Map<string, NotificationState>();
  private readonly notifications = new Map<string, NotificationState>();
  private acceptingNotifications = true;
  private readonly relays = new Map<string, NotificationState>();
  private readonly notices = new Map<string, ClaimedNotice[]>();
  private readonly relayRequests = new Map<string, number>();
  private readonly failedRelayRequests = new Map<string, { epoch: number; work: Promise<void> }>();
  private readonly quiescing = new Set<string>();
  private readonly commitFailures = new Map<string, RelayDurabilityError>();

  constructor(store: IntakeStore, packets: IntakePacketRegistry, private readonly options: IntakePumpOptions = {}) {
    this.store = store;
    this.packets = packets;
    this.nowValue = options.now ?? (() => new Date().toISOString());
    this.nextMessageId = options.messageId ?? generateUlid;
  }

  /**
   * Coalesce packet notifications without losing one that arrives while a
   * previous readonly snapshot is being consumed. The returned promise is
   * useful to orderly shutdown and deterministic tests; callbacks may ignore
   * it only if they attach their own rejection handler.
   */
  notify(roomId: string): Promise<void> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    if (!this.acceptingNotifications) return Promise.resolve();
    this.requestRelay(id);
    // Wake the sole reader immediately even if the notification's previous
    // forwarding completion is still awaiting an RPC response.
    void this.ensureIngress(id).catch(() => {});
    const existing = this.notifications.get(id);
    if (existing) { existing.dirty = true; return existing.work; }
    const state: NotificationState = { dirty: true, work: Promise.resolve() };
    this.notifications.set(id, state);
    state.work = this.runNotificationWorker(id, state);
    return state.work;
  }

  async pump(roomId: string): Promise<void> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    if (!this.packets.get(id)) return;
    this.requestRelay(id);
    await this.pumpWork(id);
  }

  private requestRelay(roomId: string): void {
    this.relayRequests.set(roomId, (this.relayRequests.get(roomId) ?? 0) + 1);
  }

  private async pumpWork(roomId: string): Promise<void> {
    const current = this.processing.getStore();
    const work = this.ensureIngress(roomId);
    if (current?.active && current.roomId === roomId) return;
    try { await work; } catch (error) {
      // Notice attempts are independently tracked. Compatibility callers can
      // await them here without occupying the sole ingress reader.
      await this.relays.get(roomId)?.work.catch(() => {});
      throw error;
    }
    await this.scheduleRelay(roomId);
  }

  private ensureIngress(roomId: string): Promise<void> {
    if (!this.acceptingNotifications || this.quiescing.has(roomId) || !this.packets.get(roomId)) return Promise.resolve();
    const existing = this.pumps.get(roomId);
    if (existing) { existing.dirty = true; return existing.work; }
    const state: NotificationState = { dirty: true, work: Promise.resolve() };
    this.pumps.set(roomId, state);
    state.work = this.runPump(roomId, state);
    return state.work;
  }

  async resumePending(roomId: string): Promise<void> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    this.requestRelay(id);
    const alreadyActive = this.pumps.has(id) || this.relays.has(id);
    const ingress = this.ensureIngress(id);
    if (alreadyActive) { void ingress.catch(() => {}); return; }
    await ingress;
    await this.scheduleRelay(id);
  }

  /** Called only after the service has durably marked this room closing. */
  async quiesceRelay(roomId: string): Promise<void> {
    this.quiescing.add(roomId);
    const relay = this.relays.get(roomId);
    if (relay) await relay.work;
    const failure = this.commitFailures.get(roomId);
    if (failure) throw failure;
    // Claimed notices are at-most-once; closing must not dispatch them later.
    this.notices.delete(roomId);
  }

  private async runPump(roomId: string, state: NotificationState): Promise<void> {
    const scope = { roomId, active: true };
    try {
      await this.processing.run(scope, async () => {
        const packet = this.packet(roomId);
        while (state.dirty) {
          state.dirty = false;
          const more = await this.drainIngress(roomId, packet);
          state.dirty ||= more;
          void this.scheduleRelay(roomId).catch(() => {});
          await this.options.afterPump?.(roomId);
          if (!this.packets.get(roomId) || !this.acceptingNotifications) break;
          if (state.dirty) await new Promise<void>(resolve => setImmediate(resolve));
        }
      });
    } finally {
      scope.active = false;
      if (this.pumps.get(roomId) === state) this.pumps.delete(roomId);
    }
  }

  beginShutdown(): void {
    this.acceptingNotifications = false;
  }

  async drain(): Promise<void> {
    while (this.notifications.size > 0 || this.pumps.size > 0 || this.relays.size > 0) {
      await Promise.allSettled([...this.notifications.values(), ...this.pumps.values(), ...this.relays.values()].map((state) => state.work));
    }
    const failure = this.commitFailures.values().next().value;
    if (failure) throw failure;
  }

  private async runNotificationWorker(roomId: string, state: NotificationState): Promise<void> {
    try {
      while (state.dirty) {
        state.dirty = false;
        await this.pumpWork(roomId);
      }
    } finally {
      // Failed work ends this pass: dirty ingress backlog is not a fresh retry.
      if (this.notifications.get(roomId) === state) this.notifications.delete(roomId);
    }
  }

  private scheduleRelay(roomId: string): Promise<void> {
    const failure = this.commitFailures.get(roomId);
    if (failure) return Promise.reject(failure);
    const active = this.relays.get(roomId);
    if (active) { active.dirty = true; return active.work; }
    if (!this.acceptingNotifications || this.quiescing.has(roomId) || !this.packets.get(roomId)) return Promise.resolve();
    const failed = this.failedRelayRequests.get(roomId);
    if (failed && failed.epoch >= (this.relayRequests.get(roomId) ?? 0)) return failed.work;
    const state: NotificationState = { dirty: true, work: Promise.resolve() };
    this.relays.set(roomId, state);
    state.work = this.runRelay(roomId, state);
    void state.work.catch(() => {});
    return state.work;
  }

  private async runRelay(roomId: string, state: NotificationState): Promise<void> {
    try {
      const packet = this.packet(roomId);
      while (state.dirty && this.acceptingNotifications && !this.quiescing.has(roomId)) {
        state.dirty = false;
        await this.relayPending(roomId, packet);
      }
      this.failedRelayRequests.delete(roomId);
    } catch (error) {
      // Consume already-coalesced requests; only a subsequent explicit wake
      // may resume existing at-least-once recovery, never an automatic turn.
      this.failedRelayRequests.set(roomId, { epoch: this.relayRequests.get(roomId) ?? 0, work: state.work });
      throw error;
    } finally {
      if (this.relays.get(roomId) === state) this.relays.delete(roomId);
    }
  }

  private async drainIngress(roomId: string, packet: RoomPacket): Promise<boolean> {
    if (await this.options.shouldPause?.(roomId)) return false;
    let more = await packet.drainRuntimeCommands?.(
      (item) => this.lock(roomId, () => this.processInboxItem(roomId, item)),
    ) === true;
    if (await this.options.shouldPause?.(roomId)) return false;
    const messages = await packet.listUnreadMessages(INTAKE_BATCH_SIZE);
    const files = await packet.listUnreadFiles(INTAKE_BATCH_SIZE);
    for (const item of messages) {
      if (await this.options.shouldPause?.(roomId)) break;
      await this.lock(roomId, () => this.processInboxItem(roomId, item));
      // Unexpected read rows are archived before the next SDK consume.
      const deferred = await packet.acknowledgeMessage(item,
        (unexpected) => this.lock(roomId, () => this.processInboxItem(roomId, unexpected)));
      more ||= deferred === true;
      if (deferred === true) break;
    }
    for (const item of files) {
      if (await this.options.shouldPause?.(roomId)) break;
      await this.lock(roomId, () => this.processFileInboxItem(roomId, item));
      await packet.acknowledgeFile(item);
    }
    if (await this.options.shouldPause?.(roomId)) return false;
    const unread = await packet.listUnreadSourceIds();
    await this.lock(roomId, () => this.completeSnapshotIntents(roomId));
    // Do not require an empty unread queue before offering a forwarding turn.
    return more || unread.messages.size > 0 || unread.files.size > 0;
  }

  private async processFileInboxItem(
    roomId: string,
    item: FileInboxItem,
  ): Promise<void> {
    const room = await this.store.load(roomId);
    const [stored] = await queryStore(this.store, roomId, { sourceFileId: item.file_id, limit: 1 });
    if (this.isRejectedReplay(stored, item)) {
      return;
    }
    let file = this.findSourceFile(stored === undefined ? [] : [stored], item);
    if (!file) {
      const seat = room.seats.find(candidate => candidate.identity === item.sender_id && candidate.state === 'active');
      const known = room.seats.some(candidate => candidate.identity === item.sender_id);
      if (!known || (item.reply_to == null && (room.state !== 'active' || !seat))) {
        if (room.state === 'active') await this.bounceRemovedSender(roomId, room, item);
        return;
      }
      const disposition = await this.freshScopeUnlocked(room, item);
      if (!disposition) {
        return;
      }
      if (!seat) throw new Error('authorized file sender has no active seat');
      const parsedName = FileNameSchema.safeParse(item.filename);
      const parsedMime = FileMimeSchema.safeParse(item.mime);
      // Drain legacy poison metadata after checking saved-source integrity and scope.
      if (!parsedName.success || !parsedMime.success) {
        return;
      }
      if (item.data.length > MAX_FILE_BYTES) {
        throw new RangeError(`room files must be at most ${MAX_FILE_BYTES} bytes (2 MiB)`);
      }
      const bytes = Buffer.from(item.data);
      const appended = await this.store.append(roomId, {
        version: 1,
        kind: 'file',
        room_id: roomId,
        at: Rfc3339Schema.parse(item.date),
        file_id: LowerCrockfordUlidSchema.parse(this.nextMessageId()),
        author: { identity: seat.identity, display_name: seat.display_name, role: seat.role },
        ...(room.anonymous && seat.alias !== undefined
          ? { author_alias: { participant_id: seat.participant_id, alias: seat.alias } }
          : {}),
        filename: parsedName.data,
        mime: parsedMime.data,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        data_base64: bytes.toString('base64'),
        recipient_identities: disposition.recipients,
        source_file_id: item.file_id,
        ...(item.wire_id === '' ? {} : { source_wire_id: item.wire_id }),
        ...(item.reply_to == null ? {} : { source_reply_to: item.reply_to }),
      });
      if (appended.kind !== 'file') throw new Error('storage returned the wrong participant file kind');
      file = appended;
    }

    await this.completeFileIntents(roomId, file);
  }

  private async processInboxItem(
    roomId: string,
    item: InboxItem,
  ): Promise<void> {
    const room = await this.store.load(roomId);
    const [stored] = await queryStore(this.store, roomId, { sourceMsgId: item.msg_id, limit: 1 });
    if (this.isRejectedReplay(stored, item)) {
      return;
    }
    let message = this.findSourceMessage(stored === undefined ? [] : [stored], item);
    if (!message) {
      const seat = room.seats.find(candidate => candidate.identity === item.sender_id && candidate.state === 'active');
      const known = room.seats.some(candidate => candidate.identity === item.sender_id);
      if (!known || (item.reply_to == null && (room.state !== 'active' || !seat))) {
        // A wholly unknown sender has no room seat to bind a rejection to.
        if (room.state === 'active') await this.bounceRemovedSender(roomId, room, item);
        return;
      }
      const disposition = await this.freshScopeUnlocked(room, item);
      if (!disposition) {
        return;
      }
      if (!seat) throw new Error('authorized message sender has no active seat');
      const appended = await this.store.append(roomId, {
        version: 1,
        kind: 'message',
        room_id: roomId,
        at: Rfc3339Schema.parse(item.date),
        message_id: LowerCrockfordUlidSchema.parse(this.nextMessageId()),
        author: {
          identity: seat.identity,
          display_name: seat.display_name,
          role: seat.role,
        },
        // In an anonymous room the archive keeps both identities;
        // the relay pump substitutes the alias into every outbound body.
        ...(room.anonymous && seat.alias !== undefined
          ? { author_alias: { participant_id: seat.participant_id, alias: seat.alias } }
          : {}),
        category: 'chat',
        text: item.text,
        recipient_identities: disposition.recipients,
        ...(disposition.scope === undefined ? {} : { scope: disposition.scope }),
        source_msg_id: item.msg_id,
        ...(item.wire_id === '' ? {} : { source_wire_id: item.wire_id }),
        ...(item.reply_to == null ? {} : { source_reply_to: item.reply_to }),
      });
      if (appended.kind !== 'message') throw new Error('storage returned the wrong participant message kind');
      message = appended;
    }

    await this.completeMessageIntents(roomId, message);

  }

  private async freshScopeUnlocked(room: Room, item: InboxItem | FileInboxItem) {
    try {
      const rows = item.reply_to == null ? [] : await readReplyRows(this.store, room.room_id);
      const beforeSeq = item.reply_to == null ? 1 : await this.nextRecordSeq(room.room_id);
      return resolveIntakeScope(room, rows, item, beforeSeq);
    } catch (error) {
      if (!(error instanceof ThreadFailure)) throw error;
      await this.recordRejectionUnlocked(room, item, error);
      return undefined;
    }
  }

  private async nextRecordSeq(roomId: string): Promise<number> {
    if (this.store.query) {
      const [last] = await this.store.query(roomId, { descending: true, limit: 1 });
      if (last && (last.room_id !== roomId || !Number.isSafeInteger(last.seq) || last.seq < 1)) {
        throw new Error('intake archive tail is invalid');
      }
      return (last?.seq ?? 0) + 1;
    }
    let after = 0;
    for (;;) {
      const page = await this.store.read(roomId, { after, limit: JOURNAL_WORK_BATCH_SIZE });
      if (page.length === 0) return after + 1;
      for (const row of page) {
        if (row.room_id !== roomId || !Number.isSafeInteger(row.seq) || row.seq <= after) {
          throw new Error('intake archive cursor did not advance');
        }
        after = row.seq;
      }
    }
  }

  private isRejectedReplay(record: CommunicationRecord | undefined, item: InboxItem | FileInboxItem): boolean {
    if (record?.kind !== 'intake_rejection') return false;
    const file = 'file_id' in item;
    if (record.source_kind !== (file ? 'file' : 'message')
      || (file ? record.source_file_id !== item.file_id : record.source_msg_id !== item.msg_id)
      || record.source_wire_id !== item.wire_id || record.sender_identity !== item.sender_id
      || record.fingerprint !== inputFingerprint(item)) {
      throw new Error('inbox source does not match its durable intake rejection');
    }
    return true;
  }

  private async recordRejectionUnlocked(room: Room, item: InboxItem | FileInboxItem, error: ThreadFailure): Promise<void> {
    const seat = room.seats.find(seat => seat.identity === item.sender_id && seat.state === 'active')
      ?? room.seats.find(seat => seat.identity === item.sender_id);
    if (!seat || typeof item.wire_id !== 'string' || item.wire_id.length === 0) {
      throw new Error('intake rejection requires a known seat and source wire');
    }
    if (error.code !== 'reply_target_unavailable' && error.code !== 'thread_files_unsupported') throw error;
    await this.store.append(room.room_id, {
      version: 1, kind: 'intake_rejection', room_id: room.room_id, at: this.now(),
      ...('file_id' in item ? { source_kind: 'file' as const, source_file_id: item.file_id }
        : { source_kind: 'message' as const, source_msg_id: item.msg_id }),
      source_wire_id: item.wire_id, sender_identity: item.sender_id, sender_participant_id: seat.participant_id,
      fingerprint: inputFingerprint(item), error: error.code, notification_attempt_claimed: true,
    });
    // Claim and enqueue atomically before the SDK reader acknowledges it.
    this.enqueueNotice(room, seat, item.sender_id, 'rejection', {
      version: 1, kind: 'room_msg', room_id: room.room_id, room_name: room.room_name,
      message_id: this.nextMessageId(), at: this.now(), text: error.code,
      author: { identity: room.identity_cid, display_name: room.identity_name, role: ROOM_ROLE },
    });
  }

  /**
   * One content-free self-assertion per removed seat, so a
   * healthy ex-client stops sending. The durable bounced_at mark precedes the
   * best-effort send: at-most-once, and a hostile peer gets nothing further.
   */
  private async bounceRemovedSender(
    roomId: string,
    room: Room,
    item: Pick<InboxItem | FileInboxItem, 'sender_id'>,
  ): Promise<void> {
    const removed = room.seats.find(
      (candidate) => candidate.identity === item.sender_id && candidate.state === 'removed',
    );
    if (!removed || removed.bounced_at !== undefined) return;
    if (room.seats.some(
      (candidate) => candidate.identity === item.sender_id && candidate.state === 'active',
    )) return;
    const seats = room.seats.map((candidate) =>
      candidate.participant_id === removed.participant_id
        ? { ...candidate, bounced_at: this.now() }
        : candidate);
    await this.store.save(RoomSchema.parse({ ...room, seats }));
    this.enqueueNotice(room, removed, item.sender_id, 'bounce', {
      version: 1, kind: 'room_not_member', room_id: roomId, room_name: room.room_name,
    });
  }

  private enqueueNotice(
    room: Room, seat: Room['seats'][number], recipient: string,
    kind: ClaimedNotice['kind'], body: Record<string, unknown>,
  ): void {
    const queue = this.notices.get(room.room_id) ?? [];
    queue.push({ recipient, kind, body: structuredClone(body), participantId: seat.participant_id,
      epoch: room.membership_epoch, seatState: seat.state, roomState: room.state,
      ...(seat.removed_epoch === undefined ? {} : { removedEpoch: seat.removed_epoch }) });
    this.notices.set(room.room_id, queue);
    void this.scheduleRelay(room.room_id).catch(() => {});
  }

  private async relayNotice(roomId: string, packet: RoomPacket): Promise<void> {
    const notice = this.notices.get(roomId)?.shift();
    if (!notice) return;
    for (let bindingRecovery = 0; ; bindingRecovery++) {
      const dispatched = await this.lock(roomId, async () => {
        const room = await this.store.load(roomId);
        const seat = room.seats.find(seat => seat.participant_id === notice.participantId && seat.identity === notice.recipient);
        if (!this.acceptingNotifications || this.quiescing.has(roomId) || room.state === 'closing' || room.state !== notice.roomState || room.membership_epoch !== notice.epoch || !seat
          || (notice.kind === 'rejection' ? seat.state !== notice.seatState
            : seat.state !== 'removed' || seat.removed_epoch !== notice.removedEpoch
              || room.seats.some(other => other.identity === notice.recipient && other.state === 'active'))) return undefined;
        const work = sendRoomBody(packet, notice.recipient, notice.body, undefined, { recoverBinding: false });
        void work.catch(() => {});
        return { work };
      });
      if (!dispatched) return;
      try { await dispatched.work; return; } catch (error) {
        if (bindingRecovery === 0 && isDefiniteBindingRefusal(error)) {
          try { await packet.rebind(); } catch { return; }
          continue;
        }
        return; // Durable one-time claim forbids replay of ambiguous notice.
      }
    }
  }

  private async completeSnapshotIntents(roomId: string): Promise<void> {
    if (!this.store.recordsNeedingRelayIntents) {
      const records = await this.store.read(roomId);
      for (const message of records.filter(
        (record): record is MessageRecord => record.kind === 'message',
      )) await this.completeMessageIntents(roomId, message);
      for (const file of records.filter(
        (record): record is FileRecord => record.kind === 'file',
      )) await this.completeFileIntents(roomId, file);
      return;
    }
    for (;;) {
      const records = await this.store.recordsNeedingRelayIntents(
        roomId, { limit: JOURNAL_WORK_BATCH_SIZE },
      );
      if (records.length === 0) return;
      for (const record of records) {
        if (record.kind === 'message') await this.completeMessageIntents(roomId, record);
        else if (record.kind === 'file') await this.completeFileIntents(roomId, record);
      }
    }
  }

  private async completeFileIntents(roomId: string, file: FileRecord): Promise<void> {
    if (this.store.relayRecipientsNeedingIntent) {
      for (const recipientIdentity of await this.store.relayRecipientsNeedingIntent(roomId, file.seq)) {
        await this.appendFileIntent(roomId, file.file_id, recipientIdentity);
      }
      return;
    }
    const records = await queryStore(this.store, roomId, { kind: 'relay_intent', fileId: file.file_id });
    const intended = new Set(records.map((record) => (record as RelayIntentRecord).recipient_identity));
    for (const recipientIdentity of file.recipient_identities) {
      if (intended.has(recipientIdentity)) continue;
      await this.appendFileIntent(roomId, file.file_id, recipientIdentity);
      intended.add(recipientIdentity);
    }
  }

  private async appendFileIntent(roomId: string, fileId: string, recipientIdentity: string): Promise<void> {
      await this.store.append(roomId, {
        version: 1,
        kind: 'relay_intent',
        room_id: roomId,
        at: this.now(),
        file_id: fileId,
        recipient_identity: recipientIdentity,
      });
  }

  private async completeMessageIntents(roomId: string, message: MessageRecord): Promise<void> {
    if (this.store.relayRecipientsNeedingIntent) {
      for (const recipientIdentity of await this.store.relayRecipientsNeedingIntent(roomId, message.seq)) {
        await this.appendMessageIntent(roomId, message.message_id, recipientIdentity);
      }
      return;
    }
    const records = await queryStore(this.store, roomId, { kind: 'relay_intent', messageId: message.message_id });
    const intended = new Set(records.map((record) => (record as RelayIntentRecord).recipient_identity));
    for (const recipientIdentity of message.recipient_identities) {
      if (intended.has(recipientIdentity)) continue;
      await this.appendMessageIntent(roomId, message.message_id, recipientIdentity);
      intended.add(recipientIdentity);
    }
  }

  private async appendMessageIntent(roomId: string, messageId: string, recipientIdentity: string): Promise<void> {
      await this.store.append(roomId, {
        version: 1,
        kind: 'relay_intent',
        room_id: roomId,
        at: this.now(),
        message_id: messageId,
        recipient_identity: recipientIdentity,
      });
  }

  private async relayPending(roomId: string, packet: RoomPacket): Promise<void> {
    const deferredRecipients = new Set<string>();
    let firstError: unknown;
    let failed = false;
    let after = 0;
    for (;;) {
      if (!this.acceptingNotifications || this.quiescing.has(roomId)) break;
      await this.relayNotice(roomId, packet);
      const pending = await queryStore(this.store, roomId, {
        kind: 'relay_intent', unresolvedResultKind: 'relay_result', after, limit: JOURNAL_WORK_BATCH_SIZE,
      }) as RelayIntentRecord[];
      if (pending.length === 0) {
        if ((this.notices.get(roomId)?.length ?? 0) > 0) continue;
        break;
      }
      for (const intent of pending) {
        after = intent.seq;
        if (!this.acceptingNotifications || this.quiescing.has(roomId)) break;
        if (deferredRecipients.has(intent.recipient_identity)) continue;
        let metadataWire: string | undefined;
        let phase: 'first' | 'binary' = 'first';
        let recoveredBinding = false;
        for (;;) {
          try {
            // Read marks outside the room mutex. A stale positive unread mark
            // delays safely; failed metadata is never interpreted as consumed.
            const unread = await packet.listUnreadSourceIds();
            const prepared = await this.prepareEffect(roomId, packet, intent, unread, phase, metadataWire);
            if (prepared.kind === 'deferred') {
              if (phase === 'binary') throw new Error('accepted file notice has unresolved binary eligibility');
              deferredRecipients.add(intent.recipient_identity); break;
            }
            if (prepared.kind === 'skipped') break;
            const outcome = await prepared.work;
            if (prepared.file && phase === 'first' && outcome.status === 'queued') {
              metadataWire = outcome.wire_id;
              phase = 'binary';
              recoveredBinding = false;
              continue; // Fresh eligibility before dispatching actual bytes.
            }
            await this.lock(roomId, async () => {
              await this.appendRelayResult(roomId, {
                version: 1, kind: 'relay_result', room_id: roomId, at: this.now(),
                intent_record_id: intent.record_id, recipient_identity: intent.recipient_identity,
                ...(prepared.file ? { file_id: prepared.file.file_id } : { message_id: intent.message_id! }),
                status: outcome.status,
                ...(outcome.wire_id ? { wire_id: outcome.wire_id } : {}),
                ...(metadataWire ? { metadata_wire_id: metadataWire } : {}),
              });
            });
            break;
          } catch (error) {
            const refusal = error instanceof RelayEffectFailure ? error.cause : error;
            if (!recoveredBinding && isDefiniteBindingRefusal(refusal)) {
              recoveredBinding = true;
              try { await packet.rebind(); continue; } catch (rebindError) { error = new RelayEffectFailure(rebindError); }
            }
            if (phase === 'binary') {
              // An accepted notice is already an observed effect. Every unresolved
              // exit must retain ownership, including unknown binary outcomes.
              const failure = error instanceof RelayDurabilityError ? error
                : new RelayDurabilityError(error instanceof RelayEffectFailure ? error.cause : error);
              this.commitFailures.set(roomId, failure);
              throw failure;
            }
            // Storage and preparation failure must stop immediately; a send
            // failure may leave independent recipients eligible in this pass.
            if (!(error instanceof RelayEffectFailure)) throw error;
            deferredRecipients.add(intent.recipient_identity);
            if (!failed) firstError = error.cause;
            failed = true;
            break;
          }
        }
        await this.relayNotice(roomId, packet);
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (failed) throw firstError;
  }

  private async prepareEffect(
    roomId: string, packet: RoomPacket, intent: RelayIntentRecord,
    unread: { messages: Set<number>; files: Set<number> }, phase: 'first' | 'binary', metadataWire?: string,
  ): Promise<{ kind: 'skipped' } | { kind: 'deferred' } | {
    kind: 'effect'; work: Promise<{ status: 'queued' | 'send_failed'; wire_id?: string }>;
    file?: FileRecord;
  }> {
    return this.lock(roomId, async () => {
      const room = await this.store.load(roomId);
      if (!this.acceptingNotifications || this.quiescing.has(roomId) || room.state === 'closing' || room.state === 'closed') {
        if (phase === 'binary') {
          // The notice was accepted, but lifecycle authority suppresses bytes.
          // Record that partial observed phase before allowing teardown.
          await this.skipRelay(roomId, intent, 'send_failed', metadataWire, true);
          return { kind: 'skipped' as const };
        }
        return { kind: 'deferred' as const };
      }
      if ((await queryStore(this.store, roomId, { kind: 'relay_result', intentRecordId: intent.record_id, limit: 1 })).length > 0) return { kind: 'skipped' as const };
      const [message] = intent.message_id === undefined ? [] : await queryStore(this.store, roomId, { kind: 'message', messageId: intent.message_id, limit: 1 }) as MessageRecord[];
      const [file] = intent.file_id === undefined ? [] : await queryStore(this.store, roomId, { kind: 'file', fileId: intent.file_id, limit: 1 }) as FileRecord[];
      if ((message === undefined) === (file === undefined)) {
        if (phase === 'binary') throw new Error('accepted file notice source is unavailable');
        return { kind: 'skipped' as const };
      }
      const source = message ?? file!;
      if ((message?.source_msg_id !== undefined && unread.messages.has(message.source_msg_id))
        || (file?.source_file_id !== undefined && unread.files.has(file.source_file_id))) return { kind: 'deferred' as const };
      const activeCids = new Set(room.seats.filter(seat => seat.state === 'active').map(seat => seat.identity));
      const removedCids = new Set(room.seats.filter(seat => seat.state === 'removed').map(seat => seat.identity));
      const replyRows = source.source_reply_to === undefined && message?.scope === undefined
        && message?.thread_root === undefined ? [] : await readReplyRows(this.store, roomId);
      const decision = selectReply(replyRows, roomId, source, intent.recipient_identity);
      let publicThread: Record<string, unknown> = {};
      let scopedAuthor: MessageRecord['author'] | undefined;
      try {
        const association = classifyThreadAssociation(room, replyRows, source);
        if (association.state === 'scoped') {
          const { root, scope } = association;
          if (!message || !message.recipient_identities.includes(intent.recipient_identity)
            || message.seq >= intent.seq
            || !root.thread_root.members.some(member => member.identity === intent.recipient_identity)) {
            throw new ThreadFailure('reply_target_unavailable');
          }
          if (!threadRelayEligible(room, root.thread_root, intent.recipient_identity)) {
            await this.skipRelay(roomId, intent, 'skipped_removed', metadataWire, phase === 'binary');
            return { kind: 'skipped' as const };
          }
          const metadata = publicThreadMetadata({ ...root, thread_root: root.thread_root }, room);
          scopedAuthor = publicThreadAuthor(message, root.thread_root, room);
          if (message.message_id === root.message_id) {
            publicThread = { thread: { schema_version: 1, thread_id: root.message_id }, thread_root: metadata };
          } else {
            if (decision.state !== 'linked' || decision.parentKey !== scope.parent_key) {
              throw new ThreadFailure('reply_target_unavailable');
            }
            publicThread = { thread: { schema_version: 1, thread_id: root.message_id } };
          }
        } else {
          if (!source.recipient_identities.includes(intent.recipient_identity)) {
            if (phase === 'binary') throw new Error('accepted file notice source recipient changed');
            return { kind: 'skipped' as const };
          }
          if (!activeCids.has(intent.recipient_identity) && removedCids.has(intent.recipient_identity)) {
            await this.skipRelay(roomId, intent, 'skipped_removed', metadataWire, phase === 'binary');
            return { kind: 'skipped' as const };
          }
        }
      } catch (error) {
        if (!(error instanceof ThreadFailure)) throw error;
        await this.skipRelay(roomId, intent, 'skipped_reply_unavailable', metadataWire, phase === 'binary');
        return { kind: 'skipped' as const };
      }
      const replyTo = decision.replyTo;
      let dispatched: Promise<{ status: 'queued' | 'send_failed'; wire_id?: string }>;
      if (file) {
        dispatched = phase === 'binary' ? packet.sendFile(
          intent.recipient_identity, file.filename, file.mime, Buffer.from(file.data_base64, 'base64'), replyTo,
          { recoverBinding: false },
        ) : sendRoomBody(packet, intent.recipient_identity, {
          version: 1, kind: 'room_msg', room_id: roomId, room_name: room.room_name, message_id: file.file_id,
          author: { identity: room.identity_cid, display_name: room.identity_name, role: ROOM_ROLE },
          text: `${file.author_alias?.alias ?? file.author.display_name} sent a file`, at: file.at,
        }, replyTo, { recoverBinding: false });
      } else {
        const unsigned = {
          version: 1 as const,
          kind: wireKind(message!.category),
          room_id: roomId,
          room_name: room.room_name,
          message_id: message!.message_id,
          // An anonymous author leaves the archive only in alias form.
          author: scopedAuthor ?? (message!.author_alias === undefined ? message!.author : {
            identity: message!.author_alias.participant_id,
            display_name: message!.author_alias.alias,
            role: message!.author.role,
          }),
          ...publicThread,
          text: message!.text,
          at: message!.at,
          ...(message!.briefing_role === undefined ? {} : { briefing_role: message!.briefing_role }),
          ...(message!.briefing_version === undefined ? {} : { briefing_version: message!.briefing_version }),
          ...(message!.membership === undefined ? {} : { membership: message!.membership }),
        };

        dispatched = sendRoomBody(packet, intent.recipient_identity, unsigned, replyTo, { recoverBinding: false });
      }
      // Invoke the real effect under current authorization, then BOX its promise
      // so the async room mutex releases before waiting for the response.
      const work = dispatched.catch(error => { throw new RelayEffectFailure(error); });
      void work.catch(() => {});
      return { kind: 'effect' as const, work, ...(file ? { file } : {}) };
    });
  }

  private async skipRelay(
    roomId: string, intent: RelayIntentRecord,
    status: 'skipped_removed' | 'skipped_reply_unavailable' | 'send_failed', metadataWire?: string, observed = false,
  ): Promise<void> {
    const draft: RelayResultDraft = {
      version: 1, kind: 'relay_result', room_id: roomId, at: this.now(),
      intent_record_id: intent.record_id,
      ...(intent.message_id === undefined ? {} : { message_id: intent.message_id }),
      ...(intent.file_id === undefined ? {} : { file_id: intent.file_id }),
      recipient_identity: intent.recipient_identity, status,
      ...(metadataWire ? { metadata_wire_id: metadataWire } : {}),
    };
    await this.appendRelayResult(roomId, draft, observed);
  }

  private async appendRelayResult(roomId: string, draft: RelayResultDraft, observed = true): Promise<void> {
    try {
      const result = await this.store.append(roomId, draft);
      if (result.kind !== 'relay_result') throw new Error('storage returned the wrong relay result kind');
    } catch (error) {
      if (!observed) throw error;
      const failure = new RelayDurabilityError(error);
      this.commitFailures.set(roomId, failure);
      throw failure;
    }
  }

  private findSourceMessage(records: CommunicationRecord[], item: InboxItem): MessageRecord | undefined {
    const message = records.find((record): record is MessageRecord =>
      record.kind === 'message' && record.source_msg_id === item.msg_id);
    if (!message) return undefined;
    const observedWireId = item.wire_id === '' ? undefined : item.wire_id;
    if (message.source_wire_id !== observedWireId
      || !sameReply(message.source_reply_to, item.reply_to)
      || message.author.identity !== item.sender_id
      || message.text !== item.text
      || message.at !== item.date) {
      throw new Error(`inbox source ${item.msg_id} does not match its durable room message`);
    }
    return message;
  }

  private findSourceFile(records: CommunicationRecord[], item: FileInboxItem): FileRecord | undefined {
    const file = records.find((record): record is FileRecord =>
      record.kind === 'file' && record.source_file_id === item.file_id);
    if (!file) return undefined;
    const observedWireId = item.wire_id === '' ? undefined : item.wire_id;
    const bytes = Buffer.from(item.data);
    if (file.source_wire_id !== observedWireId
      || !sameReply(file.source_reply_to, item.reply_to)
      || file.author.identity !== item.sender_id
      || file.filename !== item.filename
      || file.mime !== item.mime
      || file.at !== item.date
      || file.size !== bytes.length
      || file.data_base64 !== bytes.toString('base64')) {
      throw new Error(`file inbox source ${item.file_id} does not match its durable room file`);
    }
    return file;
  }

  private lock<T>(roomId: string, work: () => T | Promise<T>): Promise<T> {
    return (this.store.mutex(roomId) as RoomMutex).runExclusive(work);
  }

  private packet(roomId: string): RoomPacket {
    const packet = this.packets.get(roomId);
    if (!packet) throw new Error(`room packet "${roomId}" is not hosted`);
    return packet;
  }

  private now(): string {
    return z.string().datetime({ offset: true }).parse(this.nowValue());
  }
}

function sameReply(
  stored: { wire_id: string; sentence?: number } | undefined,
  observed: { wire_id: string; sentence?: number } | null | undefined,
): boolean {
  if (stored === undefined || observed == null) return stored === undefined && observed == null;
  return stored.wire_id === observed.wire_id && stored.sentence === observed.sentence;
}

async function queryStore(
  store: IntakeStore,
  roomId: string,
  options: Parameters<CoworkStore['query']>[1],
): Promise<CommunicationRecord[]> {
  if (store.query) return store.query(roomId, options);
  const archive: CommunicationRecord[] = [];
  let after = 0;
  for (;;) {
    const page = await store.read(roomId, { after, limit: JOURNAL_WORK_BATCH_SIZE });
    if (page.length === 0) break;
    for (const row of page) {
      if (row.room_id !== roomId || !Number.isSafeInteger(row.seq) || row.seq <= after) {
        throw new Error('intake archive cursor did not advance');
      }
      archive.push(row);
      after = row.seq;
    }
  }
  let records = archive.filter((record) => {
    const value = record as CommunicationRecord & Record<string, unknown>;
    return (options.after === undefined || record.seq > options.after)
      && (options.kind === undefined || record.kind === options.kind)
      && (options.messageId === undefined || value.message_id === options.messageId)
      && (options.fileId === undefined || value.file_id === options.fileId)
      && (options.sourceMsgId === undefined || value.source_msg_id === options.sourceMsgId)
      && (options.sourceFileId === undefined || value.source_file_id === options.sourceFileId)
      && (options.intentRecordId === undefined || value.intent_record_id === options.intentRecordId)
      && (options.recipientIdentity === undefined || value.recipient_identity === options.recipientIdentity);
  });
  if (options.unresolvedResultKind) {
    const completed = new Set(archive
      .filter((record) => record.kind === options.unresolvedResultKind)
      .map((record) => (record as CommunicationRecord & { intent_record_id: string }).intent_record_id));
    records = records.filter((record) => !completed.has(record.record_id));
  }
  if (options.descending) records.reverse();
  return records.slice(0, options.limit);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] !== undefined) output[key] = canonicalValue(input[key]);
    }
    return output;
  }
  return value;
}

/** Fingerprint authenticated input only; sender-claimed display names are inert. */
export function inputFingerprint(item: InboxItem | FileInboxItem): string {
  return createHash('sha256').update(canonicalJson({
    sender: item.sender_id, wire: item.wire_id, date: item.date, reply: item.reply_to ?? null,
    ...('file_id' in item ? { kind: 'file', id: item.file_id, filename: item.filename, mime: item.mime,
      sha256: createHash('sha256').update(item.data).digest('hex') }
      : { kind: 'message', id: item.msg_id, text: item.text }),
  })).digest('hex');
}

function wireKind(
  category: 'briefing' | 'role_briefing' | 'chat' | 'membership',
): 'room_briefing' | 'room_role_briefing' | 'room_msg' | 'room_membership' {
  switch (category) {
    case 'briefing': return 'room_briefing';
    case 'role_briefing': return 'room_role_briefing';
    case 'membership': return 'room_membership';
    default: return 'room_msg';
  }
}

class RelayEffectFailure extends Error {
  constructor(cause: unknown) { super('room relay effect failed', { cause }); }
}

function isDefiniteBindingRefusal(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error.code === 'NOT_BOUND' || error.code === 'BINDING_REASSIGNED');
}
