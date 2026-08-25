import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  LowerCrockfordUlidSchema,
  FileMimeSchema,
  FileNameSchema,
  MAX_FILE_BYTES,
  Rfc3339Schema,
  RoomSchema,
  type CommunicationRecord,
  type Room,
} from './contracts.ts';
import type { FileInboxItem, InboxItem, RoomPacket } from './packets.ts';
import type { CoworkStore, RoomMutex } from './storage.ts';
import { generateUlid } from './ulid.ts';

type IntakeStore = Pick<CoworkStore, 'mutex' | 'load' | 'save' | 'append' | 'read'>
  & Partial<Pick<CoworkStore, 'query' | 'recordsNeedingRelayIntents' | 'relayRecipientsNeedingIntent'>>;
type MessageRecord = Extract<CommunicationRecord, { kind: 'message' }>;
type FileRecord = Extract<CommunicationRecord, { kind: 'file' }>;
type RelayIntentRecord = Extract<CommunicationRecord, { kind: 'relay_intent' }>;

export interface IntakePacketRegistry {
  get(roomId: string): RoomPacket | undefined;
}

export interface IntakePumpOptions {
  now?: () => string;
  messageId?: () => string;
}

interface NotificationState {
  dirty: boolean;
  work: Promise<void>;
}

const JOURNAL_WORK_BATCH_SIZE = 64;

const INTAKE_BATCH_SIZE = 32;

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
): Promise<Awaited<ReturnType<RoomPacket['send']>>> {
  return packet.send(recipientIdentity, canonicalJson(unsigned));
}

/** Archive, consume, and relay participant messages for hosted room packets. */
export class IntakePump {
  private readonly store: IntakeStore;
  private readonly packets: IntakePacketRegistry;
  private readonly nowValue: () => string;
  private readonly nextMessageId: () => string;
  private readonly notifications = new Map<string, NotificationState>();
  private acceptingNotifications = true;

  constructor(store: IntakeStore, packets: IntakePacketRegistry, options: IntakePumpOptions = {}) {
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
    // The unread item remains in SDK identity state and is resumed on next boot.
    if (!this.acceptingNotifications) return Promise.resolve();
    const existing = this.notifications.get(id);
    if (existing) {
      existing.dirty = true;
      return existing.work;
    }

    const state: NotificationState = { dirty: true, work: Promise.resolve() };
    this.notifications.set(id, state);
    state.work = this.runNotificationWorker(id, state);
    return state.work;
  }

  /** Process bounded unread history batches, then service durable intents. */
  async pump(roomId: string): Promise<void> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    await this.lock(id, () => this.processAndRelayUnlocked(id, this.packet(id)));
  }

  /** Retry every durable relay intent which has no terminal result. */
  async resumePending(roomId: string): Promise<void> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    await this.lock(id, () => this.processAndRelayUnlocked(id, this.packet(id)));
  }

  beginShutdown(): void {
    this.acceptingNotifications = false;
  }

  async drain(): Promise<void> {
    while (this.notifications.size > 0) {
      await Promise.allSettled([...this.notifications.values()].map((state) => state.work));
    }
  }

  private async runNotificationWorker(roomId: string, state: NotificationState): Promise<void> {
    let failure: unknown;
    try {
      while (state.dirty) {
        state.dirty = false;
        await this.pump(roomId);
      }
    } catch (error) {
      failure = error;
    }

    // Cleanup is deliberately inside this async worker, not Promise.finally:
    // the map entry disappears synchronously before this work promise settles.
    // A wakeup already marked dirty is handed to a replacement and awaited so
    // shutdown cannot observe the original worker complete while work is lost.
    if (this.notifications.get(roomId) === state) this.notifications.delete(roomId);
    let replacementWork: Promise<void> | undefined;
    if (state.dirty) {
      replacementWork = this.notify(roomId);
    }
    // Give a wakeup which was already queued at the final-drain boundary one
    // microtask to install its replacement after the synchronous deletion.
    // The original work promise then chains that replacement before settling.
    await Promise.resolve();
    replacementWork ??= this.notifications.get(roomId)?.work;
    if (replacementWork) {
      try {
        await replacementWork;
      } catch (replacementFailure) {
        if (failure === undefined) failure = replacementFailure;
      }
    }
    if (failure !== undefined) throw failure;
  }

  private async processAndRelayUnlocked(roomId: string, packet: RoomPacket): Promise<void> {
    for (;;) {
      const messages = await packet.listUnreadMessages(INTAKE_BATCH_SIZE);
      const files = await packet.listUnreadFiles(INTAKE_BATCH_SIZE);
      if (messages.length === 0 && files.length === 0) break;
      for (const item of messages) await this.processInboxItem(roomId, packet, item);
      for (const item of files) await this.processFileInboxItem(roomId, packet, item);
    }
    await this.completeSnapshotIntents(roomId);
    await this.relayPendingUnlocked(roomId, packet);
  }

  private async processFileInboxItem(
    roomId: string,
    packet: RoomPacket,
    item: FileInboxItem,
  ): Promise<void> {
    const parsedName = FileNameSchema.safeParse(item.filename);
    const parsedMime = FileMimeSchema.safeParse(item.mime);
    // The current SDK boundary rejects this metadata before persistence. This
    // defensive drain handles an older archived item so one poison unread item cannot
    // make every daemon restart fail at resumePending.
    if (!parsedName.success || !parsedMime.success) {
      await packet.acknowledgeFile(item);
      return;
    }
    if (item.data.length > MAX_FILE_BYTES) {
      throw new RangeError(`room files must be at most ${MAX_FILE_BYTES} bytes (2 MiB)`);
    }
    const room = await this.store.load(roomId);
    const seat = room.seats.find(
      (candidate) => candidate.identity === item.sender_id && candidate.state === 'active',
    );
    if (room.state !== 'active' || !seat) {
      if (room.state === 'active') await this.bounceRemovedSender(roomId, room, packet, item);
      await packet.acknowledgeFile(item);
      return;
    }
    const [storedFile] = await queryStore(this.store, roomId, { kind: 'file', sourceFileId: item.file_id, limit: 1 });
    let file = this.findSourceFile(storedFile === undefined ? [] : [storedFile], item);
    if (!file) {
      const recipientIdentities = unique(room.seats
        .filter((recipient) => recipient.state === 'active')
        .map((recipient) => recipient.identity)
        .filter((identity) => identity !== seat.identity));
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
        recipient_identities: recipientIdentities,
        source_file_id: item.file_id,
        ...(item.wire_id === '' ? {} : { source_wire_id: item.wire_id }),
        ...(item.reply_to == null ? {} : { source_reply_to: item.reply_to }),
      });
      if (appended.kind !== 'file') throw new Error('storage returned the wrong participant file kind');
      file = appended;
    }

    await this.completeFileIntents(roomId, file);
    await packet.acknowledgeFile(item);
  }

  private async processInboxItem(
    roomId: string,
    packet: RoomPacket,
    item: InboxItem,
    acknowledge = true,
  ): Promise<void> {
    const room = await this.store.load(roomId);
    const seat = room.seats.find(
      (candidate) => candidate.identity === item.sender_id && candidate.state === 'active',
    );
    if (room.state !== 'active' || !seat) {
      // Inbox entries are ordinary SDK identity state, not an authorization source.
      // Refused entries are deliberately drained without creating an archive
      // message, intent, wire send, or result.
      if (room.state === 'active') await this.bounceRemovedSender(roomId, room, packet, item);
      if (acknowledge) await this.acknowledgeMessage(roomId, packet, item);
      return;
    }

    const [storedMessage] = await queryStore(this.store, roomId, { kind: 'message', sourceMsgId: item.msg_id, limit: 1 });
    let message = this.findSourceMessage(storedMessage === undefined ? [] : [storedMessage], item);
    if (!message) {
      const recipientIdentities = unique(room.seats
        .filter((recipient) => recipient.state === 'active')
        .map((recipient) => recipient.identity)
        .filter((identity) => identity !== seat.identity));
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
        recipient_identities: recipientIdentities,
        source_msg_id: item.msg_id,
        ...(item.wire_id === '' ? {} : { source_wire_id: item.wire_id }),
        ...(item.reply_to == null ? {} : { source_reply_to: item.reply_to }),
      });
      if (appended.kind !== 'message') throw new Error('storage returned the wrong participant message kind');
      message = appended;
    }

    await this.completeMessageIntents(roomId, message);

    // This is the irreversible SDK read mark. Every preceding append resolves
    // only after its file fsync, so both the message and the complete fan-out
    // exist durably first. If an older row became unread after the snapshot,
    // the SDK returns that row first; archive it through this same path before
    // retrying the expected row. The promoted row is already read and must not
    // be acknowledged a second time.
    if (acknowledge) await this.acknowledgeMessage(roomId, packet, item);
  }

  private acknowledgeMessage(roomId: string, packet: RoomPacket, expected: InboxItem): Promise<void> {
    return packet.acknowledgeMessage(
      expected,
      (unexpected) => this.processInboxItem(roomId, packet, unexpected, false),
    );
  }

  /**
   * One content-free self-assertion per removed seat, so a
   * healthy ex-client stops sending. The durable bounced_at mark precedes the
   * best-effort send: at-most-once, and a hostile peer gets nothing further.
   */
  private async bounceRemovedSender(
    roomId: string,
    room: Room,
    packet: RoomPacket,
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
    try {
      const unsigned = {
        version: 1 as const,
        kind: 'room_not_member' as const,
        room_id: roomId,
        room_name: room.room_name,
      };
      await sendRoomBody(packet, item.sender_id, unsigned);
    } catch { /* best effort — the channel is severed or severing */ }
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

  private async relayPendingUnlocked(roomId: string, packet: RoomPacket): Promise<void> {
    const room = await this.store.load(roomId);
    const activeCids = new Set(room.seats
      .filter((seat) => seat.state === 'active')
      .map((seat) => seat.identity));
    const removedCids = new Set(room.seats
      .filter((seat) => seat.state === 'removed')
      .map((seat) => seat.identity));
    let after = 0;
    for (;;) {
      const pending = await queryStore(this.store, roomId, {
        kind: 'relay_intent', unresolvedResultKind: 'relay_result', after,
        limit: JOURNAL_WORK_BATCH_SIZE,
      }) as RelayIntentRecord[];
      if (pending.length === 0) return;
      for (const intent of pending) {
        after = intent.seq;
      const [message] = intent.message_id === undefined ? [] : await queryStore(this.store, roomId, { kind: 'message', messageId: intent.message_id, limit: 1 }) as MessageRecord[];
      const [file] = intent.file_id === undefined ? [] : await queryStore(this.store, roomId, { kind: 'file', fileId: intent.file_id, limit: 1 }) as FileRecord[];
      // A dangling intent is invalid cross-record state. Do not compound it
      // with a network effect or a result that would claim a send was tried.
      if ((message === undefined) === (file === undefined)) continue;
      const recipients = message?.recipient_identities ?? file!.recipient_identities;
      if (!recipients.includes(intent.recipient_identity)) continue;
      if (!activeCids.has(intent.recipient_identity) && removedCids.has(intent.recipient_identity)) {
        // The seat was removed after fan-out: terminal result, never a send.
        const skipped = await this.store.append(roomId, {
          version: 1,
          kind: 'relay_result',
          room_id: roomId,
          at: this.now(),
          intent_record_id: intent.record_id,
          ...(intent.message_id === undefined ? {} : { message_id: intent.message_id }),
          ...(intent.file_id === undefined ? {} : { file_id: intent.file_id }),
          recipient_identity: intent.recipient_identity,
          status: 'skipped_removed',
        });
        if (skipped.kind !== 'relay_result') throw new Error('storage returned the wrong relay result kind');
        continue;
      }

      if (file !== undefined) {
        const author = file.author_alias === undefined ? file.author : {
          identity: file.author_alias.participant_id,
          display_name: file.author_alias.alias,
          role: file.author.role,
        };
        const metadata = await sendRoomBody(packet, intent.recipient_identity, {
          version: 1 as const,
          kind: 'room_file' as const,
          room_id: roomId,
          room_name: room.room_name,
          file_id: file.file_id,
          author,
          filename: file.filename,
          mime: file.mime,
          size: file.size,
          sha256: file.sha256,
          at: file.at,
        });
        if (metadata.status === 'send_failed') {
          const failed = await this.store.append(roomId, {
            version: 1,
            kind: 'relay_result',
            room_id: roomId,
            at: this.now(),
            intent_record_id: intent.record_id,
            file_id: file.file_id,
            recipient_identity: intent.recipient_identity,
            status: 'send_failed',
          });
          if (failed.kind !== 'relay_result') throw new Error('storage returned the wrong relay result kind');
          continue;
        }
        const outcome = await packet.sendFile(
          intent.recipient_identity,
          file.filename,
          file.mime,
          Buffer.from(file.data_base64, 'base64'),
        );
        const appended = await this.store.append(roomId, {
          version: 1,
          kind: 'relay_result',
          room_id: roomId,
          at: this.now(),
          intent_record_id: intent.record_id,
          file_id: file.file_id,
          recipient_identity: intent.recipient_identity,
          status: outcome.status,
          ...(outcome.wire_id === undefined || outcome.wire_id === '' ? {} : { wire_id: outcome.wire_id }),
          ...(metadata.wire_id === undefined || metadata.wire_id === '' ? {} : { metadata_wire_id: metadata.wire_id }),
        });
        if (appended.kind !== 'relay_result') throw new Error('storage returned the wrong relay result kind');
        continue;
      }

      const unsigned = {
        version: 1 as const,
        kind: wireKind(message!.category),
        room_id: roomId,
        room_name: room.room_name,
        message_id: message!.message_id,
        // An anonymous author leaves the archive only in alias form.
        author: message!.author_alias === undefined ? message!.author : {
          identity: message!.author_alias.participant_id,
          display_name: message!.author_alias.alias,
          role: message!.author.role,
        },
        text: message!.text,
        at: message!.at,
        ...(message!.briefing_role === undefined ? {} : { briefing_role: message!.briefing_role }),
        ...(message!.briefing_version === undefined ? {} : { briefing_version: message!.briefing_version }),
        ...(message!.membership === undefined ? {} : { membership: message!.membership }),
      };
      // RoomPacket.send returns only an observed queued/refused outcome. A
      // thrown call remains result-less because its acceptance is unknown and
      // will deliberately be retried on restart with the stable message ID.
      const outcome = await sendRoomBody(packet, intent.recipient_identity, unsigned);
      const appended = await this.store.append(roomId, {
        version: 1,
        kind: 'relay_result',
        room_id: roomId,
        at: this.now(),
        intent_record_id: intent.record_id,
        message_id: intent.message_id!,
        recipient_identity: intent.recipient_identity,
        status: outcome.status,
        ...(outcome.wire_id === undefined || outcome.wire_id === '' ? {} : { wire_id: outcome.wire_id }),
      });
      if (appended.kind !== 'relay_result') throw new Error('storage returned the wrong relay result kind');
      }
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
  let records = await store.read(roomId);
  records = records.filter((record) => {
    const value = record as CommunicationRecord & Record<string, unknown>;
    return (options.kind === undefined || record.kind === options.kind)
      && (options.messageId === undefined || value.message_id === options.messageId)
      && (options.fileId === undefined || value.file_id === options.fileId)
      && (options.sourceMsgId === undefined || value.source_msg_id === options.sourceMsgId)
      && (options.sourceFileId === undefined || value.source_file_id === options.sourceFileId)
      && (options.recipientIdentity === undefined || value.recipient_identity === options.recipientIdentity);
  });
  if (options.unresolvedResultKind) {
    const completed = new Set((await store.read(roomId))
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
