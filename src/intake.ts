import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import {
  LowerCrockfordUlidSchema,
  Rfc3339Schema,
  type CommunicationRecord,
} from './contracts.ts';
import type { InboxItem, RoomPacket } from './packets.ts';
import type { CoworkStore, RoomMutex } from './storage.ts';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

type IntakeStore = Pick<CoworkStore, 'mutex' | 'load' | 'append' | 'read'>;
type MessageRecord = Extract<CommunicationRecord, { kind: 'message' }>;
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

/**
 * Produce the byte-stable JSON representation signed by room packets.
 * Arrays retain their order; keys of every object nested inside them are
 * sorted as well. Envelope values are already schema-controlled JSON values.
 */
export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value));
  if (encoded === undefined) throw new TypeError('canonical JSON value is not serializable');
  return encoded;
}

/** Archive, consume, and relay participant messages for hosted room packets. */
export class IntakePump {
  private readonly store: IntakeStore;
  private readonly packets: IntakePacketRegistry;
  private readonly nowValue: () => string;
  private readonly nextMessageId: () => string;
  private readonly notifications = new Map<string, NotificationState>();

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
    const existing = this.notifications.get(id);
    if (existing) {
      existing.dirty = true;
      return existing.work;
    }

    const state: NotificationState = { dirty: true, work: Promise.resolve() };
    state.work = (async () => {
      while (state.dirty) {
        state.dirty = false;
        await this.pump(id);
      }
    })().finally(() => {
      if (this.notifications.get(id) === state) this.notifications.delete(id);
    });
    this.notifications.set(id, state);
    return state.work;
  }

  /** Process the current readonly inbox snapshot, then service durable intents. */
  async pump(roomId: string): Promise<void> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    await this.lock(id, async () => {
      const packet = this.packet(id);
      const snapshot = packet.peekInbox();
      for (const item of snapshot) await this.processInboxItem(id, packet, item);
      await this.resumePendingUnlocked(id, packet);
    });
  }

  /** Retry every durable relay intent which has no terminal result. */
  async resumePending(roomId: string): Promise<void> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    await this.lock(id, () => this.resumePendingUnlocked(id, this.packet(id)));
  }

  private async processInboxItem(roomId: string, packet: RoomPacket, item: InboxItem): Promise<void> {
    const room = await this.store.load(roomId);
    const seat = room.seats.find((candidate) => candidate.identity === item.sender_id);
    if (room.state !== 'active' || !seat) {
      // Inbox entries are ordinary packet state, not an authorization source.
      // Refused entries are deliberately drained without creating an archive
      // message, intent, signature, or result.
      await packet.consumeInbox([item.msg_id]);
      return;
    }

    const before = await this.store.read(roomId);
    let message = this.findSourceMessage(before, item);
    if (!message) {
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
        category: 'chat',
        text: item.text,
        source_msg_id: item.msg_id,
        ...(item.wire_id === '' ? {} : { source_wire_id: item.wire_id }),
      });
      if (appended.kind !== 'message') throw new Error('storage returned the wrong participant message kind');
      message = appended;
    }

    const records = await this.store.read(roomId);
    const intended = new Set(records
      .filter((record): record is RelayIntentRecord =>
        record.kind === 'relay_intent' && record.message_id === message!.message_id)
      .map((intent) => intent.recipient_identity));
    for (const recipient of room.seats) {
      if (recipient.identity === seat.identity || intended.has(recipient.identity)) continue;
      await this.store.append(roomId, {
        version: 1,
        kind: 'relay_intent',
        room_id: roomId,
        at: this.now(),
        message_id: message.message_id,
        recipient_identity: recipient.identity,
      });
      intended.add(recipient.identity);
    }

    // This is the irreversible packet effect. Every preceding append resolves
    // only after its file fsync, so both the message and the complete fan-out
    // exist durably first. HostedRoomPacket defers IDs not in this snapshot.
    await packet.consumeInbox([item.msg_id]);
  }

  private async resumePendingUnlocked(roomId: string, packet: RoomPacket): Promise<void> {
    let records = await this.store.read(roomId);
    const room = await this.store.load(roomId);
    let completedRoomFanout = false;
    for (const message of records.filter((record): record is MessageRecord =>
      record.kind === 'message'
      && record.category === 'chat'
      && record.author.identity === room.identity_cid
      && record.author.role === 'room'
      && record.source_msg_id === undefined)) {
      const recipients = new Set(records
        .filter((record): record is RelayIntentRecord =>
          record.kind === 'relay_intent' && record.message_id === message.message_id)
        .map((intent) => intent.recipient_identity));
      for (const seat of room.seats) {
        if (recipients.has(seat.identity)) continue;
        await this.store.append(roomId, {
          version: 1,
          kind: 'relay_intent',
          room_id: roomId,
          at: this.now(),
          message_id: message.message_id,
          recipient_identity: seat.identity,
        });
        recipients.add(seat.identity);
        completedRoomFanout = true;
      }
    }
    if (completedRoomFanout) records = await this.store.read(roomId);
    const messages = new Map(records
      .filter((record): record is MessageRecord => record.kind === 'message')
      .map((message) => [message.message_id, message]));
    const completed = new Set(records
      .filter((record) => record.kind === 'relay_result')
      .map((result) => result.kind === 'relay_result' ? result.intent_record_id : ''));

    for (const intent of records.filter(
      (record): record is RelayIntentRecord => record.kind === 'relay_intent',
    )) {
      if (completed.has(intent.record_id)) continue;
      const message = messages.get(intent.message_id);
      // A dangling intent is invalid cross-record state. Do not compound it
      // with a network effect or a result that would claim a send was tried.
      if (!message) continue;

      const unsigned = {
        version: 1 as const,
        kind: message.category === 'briefing' ? 'room_briefing' as const : 'room_msg' as const,
        room_id: roomId,
        message_id: message.message_id,
        author: message.author,
        text: message.text,
        at: message.at,
      };
      const signature = await packet.sign(canonicalJson(unsigned));
      const body = canonicalJson({ ...unsigned, signature });
      // RoomPacket.send returns only an observed queued/refused outcome. A
      // thrown call remains result-less because its acceptance is unknown and
      // will deliberately be retried on restart with the stable message ID.
      const outcome = await packet.send(intent.recipient_identity, body);
      const appended = await this.store.append(roomId, {
        version: 1,
        kind: 'relay_result',
        room_id: roomId,
        at: this.now(),
        intent_record_id: intent.record_id,
        message_id: intent.message_id,
        recipient_identity: intent.recipient_identity,
        status: outcome.status,
        ...(outcome.wire_id === undefined || outcome.wire_id === '' ? {} : { wire_id: outcome.wire_id }),
      });
      if (appended.kind !== 'relay_result') throw new Error('storage returned the wrong relay result kind');
      completed.add(intent.record_id);
    }
  }

  private findSourceMessage(records: CommunicationRecord[], item: InboxItem): MessageRecord | undefined {
    const message = records.find((record): record is MessageRecord =>
      record.kind === 'message' && record.source_msg_id === item.msg_id);
    if (!message) return undefined;
    const observedWireId = item.wire_id === '' ? undefined : item.wire_id;
    if (message.source_wire_id !== observedWireId
      || message.author.identity !== item.sender_id
      || message.text !== item.text
      || message.at !== item.date) {
      throw new Error(`inbox source ${item.msg_id} does not match its durable room message`);
    }
    return message;
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

function generateUlid(): string {
  let time = Date.now();
  const output = new Array<string>(26);
  for (let index = 9; index >= 0; index -= 1) {
    output[index] = CROCKFORD[time % 32]!;
    time = Math.floor(time / 32);
  }
  const entropy = randomBytes(10);
  let bits = 0;
  let value = 0;
  let byteIndex = 0;
  for (let index = 10; index < 26; index += 1) {
    while (bits < 5) {
      value = (value << 8) | entropy[byteIndex++]!;
      bits += 8;
    }
    bits -= 5;
    output[index] = CROCKFORD[(value >>> bits) & 31]!;
  }
  return output.join('');
}
