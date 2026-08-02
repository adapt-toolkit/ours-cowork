import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import {
  CreateRoomInputSchema,
  InviteModeSchema,
  LowerCrockfordUlidSchema,
  RoleSchema,
  RoomSchema,
  UpdateRoomInputSchema,
  type CommunicationRecord,
  type Room,
  type RoomInvite,
  type Seat,
} from './contracts.ts';
import type { RoomPacket } from './packets.ts';
import type { ArchiveReadOptions, CoworkStore, RoomMutex } from './storage.ts';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const ROOM_ROLE = 'room';

const CreateInviteInputSchema = z.object({
  mode: InviteModeSchema,
  role: RoleSchema,
  min_accepts: z.number().int().positive().safe(),
}).strict().superRefine((input, context) => {
  if (input.mode === 'one_time' && input.min_accepts !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['min_accepts'],
      message: 'one_time invites require min_accepts === 1',
    });
  }
});

const HistoryOptionsSchema = z.object({
  after: z.number().int().nonnegative().safe().optional(),
  limit: z.number().int().positive().safe().optional(),
}).strict();

type Store = Pick<CoworkStore, 'mutex' | 'create' | 'load' | 'save' | 'list' | 'append' | 'read'>;
type MessageRecord = Extract<CommunicationRecord, { kind: 'message' }>;

export interface RoomPacketRegistry {
  get(roomId: string): RoomPacket | undefined;
  create(roomId: string, identityName?: string, bio?: string): Promise<RoomPacket>;
  restore?(roomId: string): Promise<RoomPacket>;
}

export interface RoomServiceOptions {
  now?: () => string;
  roomId?: () => string;
  messageId?: () => string;
}

export interface InviteReceipt {
  room_id: string;
  invite: RoomInvite;
  blob: string;
  reusable: boolean;
  recovery_of?: string;
}

export class RoomServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RoomServiceError';
  }
}

/** Operator lifecycle and read projections for one standalone cowork host. */
export class RoomService {
  private readonly store: Store;
  private readonly packets: RoomPacketRegistry;
  private readonly nowValue: () => string;
  private readonly nextRoomId: () => string;
  private readonly nextMessageId: () => string;

  constructor(store: Store, packets: RoomPacketRegistry, options: RoomServiceOptions = {}) {
    this.store = store;
    this.packets = packets;
    this.nowValue = options.now ?? (() => new Date().toISOString());
    this.nextRoomId = options.roomId ?? generateUlid;
    this.nextMessageId = options.messageId ?? generateUlid;
  }

  async createRoom(input: unknown): Promise<Room> {
    // Parse the caller's complete object before generating or adding any
    // host-owned identity, state, ID, or timestamp fields.
    const settings = CreateRoomInputSchema.parse(input);
    const roomId = LowerCrockfordUlidSchema.parse(this.nextRoomId());
    const identityName = `cowork-room-${roomId}`;
    return this.lock(roomId, async () => {
      const provisional = RoomSchema.parse({
        version: 1,
        room_id: roomId,
        identity_name: identityName,
        // PacketRegistry needs the durable room directory to exist first. A
        // valid, explicitly provisional value lets startup resume this exact
        // two-resource boundary without claiming a packet CID yet.
        identity_cid: `provisioning:${roomId}`,
        mission: { goal: settings.goal, briefing: settings.briefing },
        state: 'provisioning',
        invites: [],
        seats: [],
        created_at: this.now(),
      });
      await this.store.create(provisional);
      const packet = await this.packets.create(
        roomId,
        identityName,
        `ours-cowork mission room ${roomId}`,
      );
      return this.store.save(RoomSchema.parse({ ...provisional, identity_cid: packet.cid }));
    });
  }

  async recoverRoom(roomId: string): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    return this.lock(id, async () => {
      let room = await this.store.load(id);
      if (room.state === 'closed') return room;
      let packet = this.packets.get(id);
      if (!packet) {
        let restoreFailure: unknown;
        if (this.packets.restore) {
          try {
            packet = await this.packets.restore(id);
          } catch (error) {
            restoreFailure = error;
          }
        }
        if (!packet) {
          try {
            packet = await this.packets.create(id, room.identity_name, `ours-cowork mission room ${id}`);
          } catch (createFailure) {
            throw new RoomServiceError(`failed to recover room packet "${id}"`, {
              cause: restoreFailure === undefined
                ? createFailure
                : new AggregateError([restoreFailure, createFailure], 'packet restore and provisioning both failed'),
            });
          }
        }
      }
      if (room.identity_cid !== packet.cid) {
        room = await this.store.save(RoomSchema.parse({ ...room, identity_cid: packet.cid }));
      }
      return this.reconcileUnlocked(room, packet);
    });
  }

  async updateRoom(roomId: string, input: unknown): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const settings = UpdateRoomInputSchema.parse(input);
    return this.lock(id, async () => {
      const room = await this.store.load(id);
      this.assertMutable(room, 'update');
      const mission = {
        goal: settings.goal ?? room.mission.goal,
        briefing: settings.briefing ?? room.mission.briefing,
      };
      return this.store.save(RoomSchema.parse({
        ...room,
        mission,
        ...(settings.status === undefined ? {} : { status: settings.status }),
      }));
    });
  }

  async createInvite(roomId: string, input: unknown): Promise<InviteReceipt> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const request = CreateInviteInputSchema.parse(input);
    return this.lock(id, async () => {
      const room = await this.store.load(id);
      this.assertMutable(room, 'create an invite for');
      const packet = this.packet(id);
      const minted = await packet.mintInvite(request.mode);
      const invite = RoomSchema.shape.invites.element.parse({
        invite_id: minted.invite_id,
        mode: request.mode,
        role: request.role,
        min_accepts: request.min_accepts,
        accepted_cids: [],
        state: 'live',
        created_at: this.now(),
      });
      try {
        await this.store.save(RoomSchema.parse({ ...room, invites: [...room.invites, invite] }));
      } catch (error) {
        // This closes failures observable in-process. A hard crash at the same
        // boundary is handled by exact-ID admission (the unrecorded invite can
        // never admit a seat), but its blob cannot be reconstructed.
        try { await packet.revokeInvite(minted.invite_id); } catch { /* original save failure wins */ }
        throw error;
      }
      return {
        room_id: id,
        invite,
        blob: minted.blob,
        reusable: minted.reusable,
      };
    });
  }

  async revokeInvite(roomId: string, inviteId: string): Promise<RoomInvite> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const parsedInviteId = z.string().min(1).parse(inviteId);
    return this.lock(id, async () => {
      const room = await this.store.load(id);
      const index = room.invites.findIndex((invite) => invite.invite_id === parsedInviteId);
      if (index < 0) throw new RoomServiceError(`invite "${parsedInviteId}" does not belong to room "${id}"`);
      const current = room.invites[index]!;
      if (current.state === 'revoked') return current;
      await this.packet(id).revokeInvite(parsedInviteId);
      const revoked: RoomInvite = { ...current, state: 'revoked' };
      const invites = [...room.invites];
      invites[index] = revoked;
      await this.store.save(RoomSchema.parse({ ...room, invites }));
      return revoked;
    });
  }

  /**
   * Replace every recorded invite whose secret is absent from restored core
   * state. Old blobs are intentionally never reproduced or persisted.
   */
  async recoverInvites(roomId: string): Promise<InviteReceipt[]> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    return this.lock(id, async () => {
      let room = await this.reconcileUnlocked(await this.store.load(id), this.packet(id));
      this.assertMutable(room, 'recover invites for');
      const packet = this.packet(id);
      const receipts: InviteReceipt[] = [];
      for (const stale of room.invites.filter((invite) => invite.state === 'replacement_required')) {
        try { await packet.revokeInvite(stale.invite_id); } catch { /* the missing secret is already unusable */ }
        const minted = await packet.mintInvite(stale.mode);
        const replacement: RoomInvite = {
          invite_id: minted.invite_id,
          mode: stale.mode,
          role: stale.role,
          min_accepts: stale.min_accepts,
          accepted_cids: [],
          state: 'live',
          created_at: this.now(),
        };
        const nextInvites = room.invites.map((invite) =>
          invite.invite_id === stale.invite_id ? { ...invite, state: 'revoked' as const } : invite);
        nextInvites.push(replacement);
        try {
          room = await this.store.save(RoomSchema.parse({ ...room, invites: nextInvites }));
        } catch (error) {
          try { await packet.revokeInvite(minted.invite_id); } catch { /* original save failure wins */ }
          throw error;
        }
        receipts.push({
          room_id: id,
          invite: replacement,
          blob: minted.blob,
          reusable: minted.reusable,
          recovery_of: stale.invite_id,
        });
      }
      return receipts;
    });
  }

  async reconcileRoom(roomId: string): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    return this.lock(id, async () => this.reconcileUnlocked(await this.store.load(id), this.packet(id)));
  }

  async listRooms(): Promise<Room[]> {
    return this.store.list();
  }

  async showRoom(roomId: string): Promise<Room> {
    return this.store.load(LowerCrockfordUlidSchema.parse(roomId));
  }

  async participants(roomId: string): Promise<Seat[]> {
    return (await this.showRoom(roomId)).seats;
  }

  async history(roomId: string, options: unknown = {}): Promise<CommunicationRecord[]> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const page = HistoryOptionsSchema.parse(options) as ArchiveReadOptions;
    return this.store.read(id, page);
  }

  private async reconcileUnlocked(room: Room, packet: RoomPacket): Promise<Room> {
    if (room.state === 'closed' || room.state === 'closing') return room;
    const contactsByCid = new Map<string, string>();
    for (const contact of packet.listContacts()) {
      if (!contactsByCid.has(contact.container_id)) contactsByCid.set(contact.container_id, contact.name);
    }
    const origins = packet.listContactOrigins();
    const inviteById = new Map(room.invites.map((invite) => [invite.invite_id, invite]));
    const existingCids = new Set(room.seats.map((seat) => seat.identity));
    const newSeats: Seat[] = [];

    for (const [cid, displayName] of contactsByCid) {
      if (existingCids.has(cid)) continue;
      const origin = origins[cid];
      if (!origin || (origin.via !== 'invite_one_time' && origin.via !== 'invite_public')) continue;
      const invite = inviteById.get(origin.invite_id);
      if (!invite) continue;
      newSeats.push({
        identity: cid,
        display_name: displayName,
        role: invite.role,
        invite_id: invite.invite_id,
        accepted_at: origin.at,
      });
      existingCids.add(cid);
    }

    const seats = [...room.seats, ...newSeats];
    const acceptedByInvite = new Map<string, string[]>();
    for (const seat of seats) {
      const accepted = acceptedByInvite.get(seat.invite_id) ?? [];
      if (!accepted.includes(seat.identity)) accepted.push(seat.identity);
      acceptedByInvite.set(seat.invite_id, accepted);
    }
    const listedCoreInvites = packet.listInvites();
    // A process crash after core persisted an invite but before cowork saved
    // its metadata can leave a usable secret with no attributable role or
    // requirement. It never belongs to the room and must not survive a
    // reconciliation/recovery pass.
    for (const coreInvite of listedCoreInvites) {
      if (!inviteById.has(coreInvite.invite_id)) await packet.revokeInvite(coreInvite.invite_id);
    }
    const coreInvites = new Set(listedCoreInvites
      .filter((invite) => inviteById.has(invite.invite_id))
      .map((invite) => invite.invite_id));
    const invites = room.invites.map((invite): RoomInvite => {
      const accepted_cids = acceptedByInvite.get(invite.invite_id) ?? invite.accepted_cids;
      let state = invite.state;
      if (state === 'live' && !coreInvites.has(invite.invite_id)) {
        state = invite.mode === 'one_time' && accepted_cids.length > 0 ? 'consumed' : 'replacement_required';
      } else if (state === 'live' && invite.mode === 'one_time' && accepted_cids.length > 0) {
        state = 'consumed';
      }
      return { ...invite, accepted_cids, state };
    });

    let next: Room = RoomSchema.parse({ ...room, seats, invites });
    const requirementsMet = invites
      .filter((invite) => invite.state !== 'revoked')
      .every((invite) => invite.accepted_cids.length >= invite.min_accepts);
    if (next.state === 'provisioning' && seats.length > 0 && requirementsMet) {
      const activationAt = await this.ensureActivationBriefing(next, seats);
      next = RoomSchema.parse({ ...next, state: 'active', activated_at: activationAt });
    } else if (next.state === 'active') {
      for (const seat of newSeats) await this.ensureLateBriefing(next, seat);
    }
    return this.store.save(next);
  }

  private async ensureActivationBriefing(room: Room, recipients: Seat[]): Promise<string> {
    const records = await this.store.read(room.room_id);
    let message: MessageRecord | undefined = records.find(
      (record): record is MessageRecord => record.kind === 'message' && record.category === 'briefing',
    );
    if (!message) message = await this.appendBriefing(room);
    const intents = new Set(records
      .filter((record) => record.kind === 'relay_intent' && record.message_id === message!.message_id)
      .map((record) => record.kind === 'relay_intent' ? record.recipient_identity : ''));
    for (const seat of recipients) {
      if (!intents.has(seat.identity)) {
        await this.store.append(room.room_id, {
          version: 1,
          kind: 'relay_intent',
          room_id: room.room_id,
          at: this.now(),
          message_id: message.message_id,
          recipient_identity: seat.identity,
        });
      }
    }
    return message.at;
  }

  private async ensureLateBriefing(room: Room, seat: Seat): Promise<void> {
    const records = await this.store.read(room.room_id);
    const briefingIds = new Set(records
      .filter((record) => record.kind === 'message' && record.category === 'briefing')
      .map((record) => record.kind === 'message' ? record.message_id : ''));
    const alreadyBriefed = records.some((record) =>
      record.kind === 'relay_intent'
      && briefingIds.has(record.message_id)
      && record.recipient_identity === seat.identity);
    if (alreadyBriefed) return;
    const intentsByMessage = new Set(records
      .filter((record) => record.kind === 'relay_intent')
      .map((record) => record.kind === 'relay_intent' ? record.message_id : ''));
    let message: MessageRecord | undefined = [...records].reverse().find(
      (record): record is MessageRecord => record.kind === 'message'
        && record.category === 'briefing'
        && !intentsByMessage.has(record.message_id),
    );
    if (!message) message = await this.appendBriefing(room);
    await this.store.append(room.room_id, {
      version: 1,
      kind: 'relay_intent',
      room_id: room.room_id,
      at: this.now(),
      message_id: message.message_id,
      recipient_identity: seat.identity,
    });
  }

  private async appendBriefing(room: Room): Promise<MessageRecord> {
    const record = await this.store.append(room.room_id, {
      version: 1,
      kind: 'message',
      room_id: room.room_id,
      at: this.now(),
      message_id: LowerCrockfordUlidSchema.parse(this.nextMessageId()),
      author: { identity: room.identity_cid, display_name: room.identity_name, role: ROOM_ROLE },
      category: 'briefing',
      text: room.mission.briefing,
    });
    if (record.kind !== 'message') throw new RoomServiceError('storage returned the wrong briefing record kind');
    return record;
  }

  private lock<T>(roomId: string, work: () => T | Promise<T>): Promise<T> {
    return (this.store.mutex(roomId) as RoomMutex).runExclusive(work);
  }

  private packet(roomId: string): RoomPacket {
    const packet = this.packets.get(roomId);
    if (!packet) throw new RoomServiceError(`room packet "${roomId}" is not hosted`);
    return packet;
  }

  private assertMutable(room: Room, action: string): void {
    if (room.state === 'closing' || room.state === 'closed') {
      throw new RoomServiceError(`cannot ${action} room "${room.room_id}" while it is ${room.state}`);
    }
  }

  private now(): string {
    return z.string().datetime({ offset: true }).parse(this.nowValue());
  }
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
