import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import {
  CreateRoomInputSchema,
  InviteModeSchema,
  LowerCrockfordUlidSchema,
  PostMessageInputSchema,
  RoleSchema,
  RoomInviteSchema,
  RoomSchema,
  UpdateRoomInputSchema,
  type CommunicationRecord,
  type Room,
  type RoomInvite,
  type Seat,
} from './contracts.ts';
import type { RoomPacket } from './packets.ts';
import type { ArchiveReadOptions, CoworkStore, RoomMutex } from './storage.ts';
import { IntakePump } from './intake.ts';

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
  restore?(roomId: string, expectedCid?: string): Promise<RoomPacket>;
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
  private readonly intake: IntakePump;

  constructor(store: Store, packets: RoomPacketRegistry, options: RoomServiceOptions = {}) {
    this.store = store;
    this.packets = packets;
    this.nowValue = options.now ?? (() => new Date().toISOString());
    this.nextRoomId = options.roomId ?? generateUlid;
    this.nextMessageId = options.messageId ?? generateUlid;
    this.intake = new IntakePump(store, packets, {
      now: this.nowValue,
      messageId: this.nextMessageId,
    });
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
        identity_cid: '',
        mission: { goal: settings.goal, briefing: settings.briefing },
        state: 'provisioning',
        status: 'packet_pending',
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
      const { status: _packetPending, ...created } = provisional;
      return this.store.save(RoomSchema.parse({ ...created, identity_cid: packet.cid }));
    });
  }

  async recoverRoom(roomId: string): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    return this.lock(id, async () => {
      let room = await this.store.load(id);
      if (room.state === 'closed') return room;
      const packetPending = this.isPacketPending(room);
      let packet = this.packets.get(id);
      if (packet) {
        if (!packetPending && packet.cid !== room.identity_cid) {
          throw new RoomServiceError(
            `restored room packet CID mismatch for "${id}": expected "${room.identity_cid}", found "${packet.cid}"`,
          );
        }
      } else if (packetPending) {
        if (this.packets.restore) {
          try {
            packet = await this.packets.restore(id);
          } catch { /* no live packet was durably established; provision below */ }
        }
        if (!packet) {
          try {
            packet = await this.packets.create(id, room.identity_name, `ours-cowork mission room ${id}`);
          } catch (createFailure) {
            throw new RoomServiceError(`failed to recover room packet "${id}"`, {
              cause: createFailure,
            });
          }
        }
      } else {
        if (!this.packets.restore) {
          throw new RoomServiceError(`room packet "${id}" with established CID must be restored, not created`);
        }
        try {
          packet = await this.packets.restore(id, room.identity_cid);
        } catch (error) {
          throw new RoomServiceError(
            `failed to restore established room packet "${id}": ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        if (packet.cid !== room.identity_cid) {
          throw new RoomServiceError(
            `restored room packet CID mismatch for "${id}": expected "${room.identity_cid}", found "${packet.cid}"`,
          );
        }
      }
      if (packetPending) {
        const { status: _packetPending, ...established } = room;
        room = await this.store.save(RoomSchema.parse({ ...established, identity_cid: packet.cid }));
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
      const invite = RoomInviteSchema.parse({
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
      this.assertMutable(room, 'revoke an invite for');
      const index = room.invites.findIndex((invite) => invite.invite_id === parsedInviteId);
      if (index < 0) throw new RoomServiceError(`invite "${parsedInviteId}" does not belong to room "${id}"`);
      const current = room.invites[index]!;
      if (current.state === 'revoked') return current;
      const packet = this.packet(id);
      const pendingChildren = current.state === 'replacement_required'
        ? room.invites.filter((invite) =>
          invite.state === 'receipt_pending' && invite.recovery_of === current.invite_id)
        : [];
      for (const pending of pendingChildren) await packet.revokeInvite(pending.invite_id);
      await packet.revokeInvite(parsedInviteId);
      const cascadeIds = new Set([parsedInviteId, ...pendingChildren.map((invite) => invite.invite_id)]);
      const invites = room.invites.map((invite): RoomInvite =>
        cascadeIds.has(invite.invite_id) ? { ...invite, state: 'revoked' } : invite);
      const revoked = invites[index]!;
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
        const priorPending = room.invites.filter((invite) =>
          invite.state === 'receipt_pending' && invite.recovery_of === stale.invite_id);
        for (const pending of priorPending) {
          await packet.revokeInvite(pending.invite_id);
        }
        if (priorPending.length > 0) {
          const pendingIds = new Set(priorPending.map((invite) => invite.invite_id));
          room = await this.store.save(RoomSchema.parse({
            ...room,
            invites: room.invites.map((invite) => {
              if (!pendingIds.has(invite.invite_id)) return invite;
              return { ...invite, state: 'revoked' as const };
            }),
          }));
        }
        try { await packet.revokeInvite(stale.invite_id); } catch { /* the missing secret is already unusable */ }
        const minted = await packet.mintInvite(stale.mode);
        const replacement: RoomInvite = RoomInviteSchema.parse({
          invite_id: minted.invite_id,
          mode: stale.mode,
          role: stale.role,
          min_accepts: stale.min_accepts,
          accepted_cids: [],
          state: 'receipt_pending',
          recovery_of: stale.invite_id,
          recovery_confirmed: false,
          created_at: this.now(),
        });
        try {
          room = await this.store.save(RoomSchema.parse({ ...room, invites: [...room.invites, replacement] }));
        } catch (error) {
          let replacementRevoked = false;
          try {
            await packet.revokeInvite(minted.invite_id);
            replacementRevoked = true;
          } catch { /* leave a persisted descriptor pending so retry revokes it */ }
          try {
            const observed = await this.store.load(id);
            if (replacementRevoked && observed.invites.some((invite) =>
              invite.invite_id === minted.invite_id && invite.state === 'receipt_pending')) {
              await this.store.save(RoomSchema.parse({
                ...observed,
                invites: observed.invites.map((invite) => {
                  if (invite.invite_id !== minted.invite_id) return invite;
                  return { ...invite, state: 'revoked' as const };
                }),
              }));
            }
          } catch { /* retry rotates any still-pending descriptor */ }
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

  async confirmRecoveredInvite(roomId: string, recoveryOf: string, inviteId: string): Promise<RoomInvite> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const oldId = z.string().min(1).parse(recoveryOf);
    const replacementId = z.string().min(1).parse(inviteId);
    return this.lock(id, async () => {
      const room = await this.store.load(id);
      this.assertMutable(room, 'confirm a recovered invite for');
      const oldIndex = room.invites.findIndex((invite) => invite.invite_id === oldId);
      const replacementIndex = room.invites.findIndex((invite) => invite.invite_id === replacementId);
      if (oldIndex < 0 || replacementIndex < 0 || oldIndex === replacementIndex) {
        throw new RoomServiceError('recovered invite confirmation does not match a persisted descriptor');
      }
      const old = room.invites[oldIndex]!;
      const replacement = room.invites[replacementIndex]!;
      if (old.state === 'revoked'
        && replacement.recovery_of === oldId
        && replacement.recovery_confirmed === true
        && (replacement.state === 'live'
          || replacement.state === 'consumed'
          || replacement.state === 'replacement_required'
          || replacement.state === 'revoked')) {
        return replacement;
      }
      if (old.state !== 'replacement_required'
        || replacement.state !== 'receipt_pending'
        || replacement.recovery_of !== oldId
        || replacement.recovery_confirmed !== false) {
        throw new RoomServiceError('recovered invite confirmation pointer/state mismatch');
      }
      const coreInvite = this.packet(id).listInvites().find((invite) => invite.invite_id === replacementId);
      if (!coreInvite || coreInvite.mode !== replacement.mode) {
        throw new RoomServiceError('recovered invite is no longer present in packet state');
      }
      const confirmed: RoomInvite = {
        invite_id: replacement.invite_id,
        mode: replacement.mode,
        role: replacement.role,
        min_accepts: replacement.min_accepts,
        accepted_cids: [],
        state: 'live',
        recovery_of: oldId,
        recovery_confirmed: true,
        created_at: replacement.created_at,
      };
      const invites = [...room.invites];
      invites[oldIndex] = { ...old, state: 'revoked' };
      invites[replacementIndex] = confirmed;
      await this.store.save(RoomSchema.parse({ ...room, invites }));
      return confirmed;
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

  async postMessage(roomId: string, input: unknown): Promise<MessageRecord> {
    // Parse the caller-controlled object in full before consulting or assigning
    // any host-owned authorship fields. Strict parsing rejects every author-like
    // field, including spellings the service does not otherwise recognize.
    const request = PostMessageInputSchema.parse(input);
    const id = LowerCrockfordUlidSchema.parse(roomId);
    return this.lock(id, async () => {
      const room = await this.store.load(id);
      if (room.state !== 'active') {
        throw new RoomServiceError(`cannot post a room message while room "${id}" is not active`);
      }
      const appended = await this.store.append(id, {
        version: 1,
        kind: 'message',
        room_id: id,
        at: this.now(),
        message_id: LowerCrockfordUlidSchema.parse(this.nextMessageId()),
        author: {
          identity: room.identity_cid,
          display_name: room.identity_name,
          role: ROOM_ROLE,
        },
        category: 'chat',
        text: request.text,
      });
      if (appended.kind !== 'message') throw new RoomServiceError('storage returned the wrong room message kind');
      for (const seat of room.seats) {
        await this.store.append(id, {
          version: 1,
          kind: 'relay_intent',
          room_id: id,
          at: this.now(),
          message_id: appended.message_id,
          recipient_identity: seat.identity,
        });
      }
      await this.intake.resumePending(id);
      return appended;
    });
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
      if (!invite
        || invite.state === 'receipt_pending'
        || (invite.recovery_of !== undefined && invite.recovery_confirmed !== true)) continue;
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

  private isPacketPending(room: Room): boolean {
    return room.identity_cid === ''
      && room.state === 'provisioning'
      && room.status === 'packet_pending'
      && room.identity_name === `cowork-room-${room.room_id}`;
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
