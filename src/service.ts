import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  AcceptExternalInviteInputSchema,
  ContainerIdSchema,
  configuredRoomIdentityName,
  CreateRoomInputSchema,
  DEFAULT_ROLE,
  defaultRoomName,
  InviteModeSchema,
  isPersistedRoomIdentityName,
  LowerCrockfordUlidSchema,
  MAX_EXTERNAL_INVITE_BYTES,
  MAX_HISTORY_PAGE_BYTES,
  PostMessageInputSchema,
  RoleBriefingDeleteInputSchema,
  RoleBriefingSetInputSchema,
  RoleSchema,
  RoomInviteSchema,
  RoomSchema,
  UpdateRoomInputSchema,
  type CommunicationRecord,
  type InviteMode,
  type RelayStatus,
  type Room,
  type RoomIdentityNameMode,
  type RoomInvite,
  type Seat,
} from './contracts.ts';
import { unpackInvite, type RoomPacket } from './packets.ts';
import type { ArchiveReadOptions, CoworkStore, RoomMutex } from './storage.ts';
import { IntakePump } from './intake.ts';
import { generateUlid } from './ulid.ts';

const ROOM_ROLE = 'room';

function byteBoundedHistoryPage<T>(records: T[]): T[] {
  const page: T[] = [];
  let bytes = 2; // JSON array brackets
  for (const record of records) {
    const encoded = JSON.stringify(record);
    const nextBytes = Buffer.byteLength(encoded, 'utf8') + (page.length === 0 ? 0 : 1);
    if (bytes + nextBytes > MAX_HISTORY_PAGE_BYTES) {
      if (page.length === 0) {
        throw new RangeError(`one history record exceeds the ${MAX_HISTORY_PAGE_BYTES}-byte page contract`);
      }
      break;
    }
    page.push(record);
    bytes += nextBytes;
  }
  return page;
}

const CreateInviteInputSchema = z.object({
  mode: InviteModeSchema,
  role: RoleSchema.optional(),
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
  view: z.enum(['operator', 'participant']).optional(),
}).strict();

/**
 * The participant-facing history projection (§4.4 item 7): message records
 * only, authors redacted to alias form in anonymous rooms, and no routing
 * identities, so no other participant's cid or contact name ever leaves the
 * operator boundary through this view.
 */
export interface ParticipantHistoryRecord {
  version: 1;
  room_id: string;
  seq: number;
  record_id: string;
  at: string;
  kind: 'message';
  message_id: string;
  author: { identity: string; display_name: string; role: string };
  category: 'briefing' | 'role_briefing' | 'chat' | 'membership';
  briefing_role?: string;
  briefing_version?: number;
  membership?: unknown;
  text: string;
}

const DeleteRoomInputSchema = z.object({
  confirm: z.literal(true),
}).strict();

const RemoveParticipantInputSchema = z.object({
  participant: z.string().min(1),
  notify: z.boolean().optional(),
}).strict();

const ReplaceParticipantInputSchema = z.object({
  participant: z.string().min(1),
  notify: z.boolean().optional(),
  mode: InviteModeSchema.optional(),
  min_accepts: z.number().int().positive().safe().optional(),
}).strict();

type Store = Pick<CoworkStore, 'mutex' | 'create' | 'load' | 'save' | 'list' | 'append' | 'read' | 'delete'>;
type MessageRecord = Extract<CommunicationRecord, { kind: 'message' }>;
type CloseNoticeIntentRecord = Extract<CommunicationRecord, { kind: 'close_notice_intent' }>;
type MembershipIntentRecord = Extract<CommunicationRecord, { kind: 'membership_intent' }>;

export interface RoomPacketRegistry {
  get(roomId: string): RoomPacket | undefined;
  create(roomId: string, identityName?: string, bio?: string): Promise<RoomPacket>;
  restore?(roomId: string, expectedCid: string, identityName?: string, bio?: string): Promise<RoomPacket>;
  destroy(roomId: string): Promise<string[]>;
}

export interface RoomServiceOptions {
  now?: () => string;
  roomId?: () => string;
  messageId?: () => string;
  provisioningCheckpoint?: (stage: 'metadata') => void;
  identityNameMode?: RoomIdentityNameMode;
}

export interface InviteReceipt {
  room_id: string;
  invite: RoomInvite;
  blob: string;
  reusable: boolean;
  recovery_of?: string;
}

export interface DeleteRoomReceipt {
  version: 1;
  room_id: string;
  deleted: true;
  scope: 'this_host';
}

/** Honest per-removal outcome, mirroring the close-notice honesty rules. */
export interface RemovalReceipt {
  room_id: string;
  participant_id: string;
  epoch: number;
  status: RelayStatus | 'cancelled_pending';
  notified: boolean;
  key_material_retained: true;
}

export interface ReplacementReceipt extends InviteReceipt {
  removal: RemovalReceipt;
}

export interface ExternalInviteReceipt {
  room_id: string;
  participant_id: string;
  state: 'pending' | 'active';
  role: string;
  identity: string;
  invite_id: string;
  inviter_name: string;
  pending_name: string;
  requested_at: string;
  accepted_at?: string;
  replaces_seat?: string;
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
  private readonly provisioningCheckpoint: NonNullable<RoomServiceOptions['provisioningCheckpoint']>;
  private readonly identityNameMode: RoomIdentityNameMode;

  constructor(store: Store, packets: RoomPacketRegistry, options: RoomServiceOptions = {}) {
    this.store = store;
    this.packets = packets;
    this.nowValue = options.now ?? (() => new Date().toISOString());
    this.nextRoomId = options.roomId ?? generateUlid;
    this.nextMessageId = options.messageId ?? generateUlid;
    this.provisioningCheckpoint = options.provisioningCheckpoint ?? (() => {});
    this.identityNameMode = options.identityNameMode ?? 'stable_id';
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
    const roomName = settings.name ?? defaultRoomName(roomId);
    const identityName = configuredRoomIdentityName(roomId, roomName, this.identityNameMode);
    return this.lock(roomId, async () => {
      const provisional = RoomSchema.parse({
        version: 2,
        room_id: roomId,
        room_name: roomName,
        identity_name: identityName,
        // PacketRegistry needs the durable room directory to exist first. A
        // valid, explicitly provisional value lets startup resume this exact
        // two-resource boundary without claiming a packet CID yet.
        identity_cid: '',
        mission: { goal: settings.goal, briefing: settings.briefing, briefing_version: 1 },
        role_briefings: {},
        anonymous: settings.anonymous ?? false,
        quiet_membership: settings.quiet_membership ?? false,
        membership_epoch: 0,
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
      this.provisioningCheckpoint('metadata');
      const { status: _packetPending, ...created } = provisional;
      return this.store.save(RoomSchema.parse({ ...created, identity_cid: packet.cid }));
    });
  }

  async recoverRoom(roomId: string): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    return this.lock(id, async () => {
      const room = await this.recoverPacketUnlocked(id, await this.store.load(id));
      if (room.state === 'closed' || room.state === 'closing') return room;
      return this.reconcileUnlocked(room, this.packet(id));
    });
  }

  /** Restore/provision only the durable packet boundary; daemon reconciliation is a later phase. */
  async recoverPacket(roomId: string): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    return this.lock(id, async () => this.recoverPacketUnlocked(id, await this.store.load(id)));
  }

  private async recoverPacketUnlocked(id: string, initial: Room): Promise<Room> {
    let room = initial;
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
      try {
        packet = await this.packets.create(id, room.identity_name, `ours-cowork mission room ${id}`);
      } catch (createFailure) {
        throw new RoomServiceError(
          `failed to recover unproven packet-pending room identity "${room.identity_name}"; ` +
          'cowork will not adopt an existing identity without a durably recorded CID',
          { cause: createFailure },
        );
      }
    } else {
      if (!this.packets.restore) {
        throw new RoomServiceError(`room packet "${id}" with established CID must be restored, not created`);
      }
      try {
        packet = await this.packets.restore(id, room.identity_cid, room.identity_name);
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
      this.provisioningCheckpoint('metadata');
      const { status: _packetPending, ...established } = room;
      room = await this.store.save(RoomSchema.parse({ ...established, identity_cid: packet.cid }));
    }
    return room;
  }

  async updateRoom(roomId: string, input: unknown): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const settings = UpdateRoomInputSchema.parse(input);
    const { room: updated, redelivered } = await this.lock(id, async () => {
      const room = await this.store.load(id);
      this.assertMutable(room, 'update');
      const briefingChanged = settings.briefing !== undefined && settings.briefing !== room.mission.briefing;
      const mission = {
        goal: settings.goal ?? room.mission.goal,
        briefing: settings.briefing ?? room.mission.briefing,
        briefing_version: briefingChanged ? room.mission.briefing_version + 1 : room.mission.briefing_version,
      };
      const next = await this.store.save(RoomSchema.parse({
        ...room,
        room_name: settings.name ?? room.room_name,
        mission,
        ...(settings.quiet_membership === undefined ? {} : { quiet_membership: settings.quiet_membership }),
        ...(settings.status === undefined ? {} : { status: settings.status }),
      }));
      if (briefingChanged && next.state === 'active') {
        await this.redeliverCommonBriefing(next);
        return { room: next, redelivered: true };
      }
      return { room: next, redelivered: false };
    });
    if (redelivered) await this.intake.resumePending(id);
    return updated;
  }

  /** Author or edit one role's briefing; an edit bumps its version and re-delivers to seats of that role only (spec §3.3). */
  async setRoleBriefing(roomId: string, input: unknown): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const request = RoleBriefingSetInputSchema.parse(input);
    const { room: updated, redelivered } = await this.lock(id, async () => {
      const room = await this.store.load(id);
      this.assertMutable(room, 'set a role briefing for');
      const existing = room.role_briefings[request.role];
      if (existing && existing.text === request.text) return { room, redelivered: false };
      const briefing = {
        text: request.text,
        version: existing === undefined ? 1 : existing.version + 1,
        updated_at: this.now(),
      };
      const next = await this.store.save(RoomSchema.parse({
        ...room,
        role_briefings: { ...room.role_briefings, [request.role]: briefing },
      }));
      if (next.state !== 'active') return { room: next, redelivered: false };
      const holders = activeSeats(next).filter((seat) => seat.role === request.role);
      if (holders.length === 0) return { room: next, redelivered: false };
      await this.ensureBriefingKind(next, holders, {
        category: 'role_briefing',
        briefing_role: request.role,
        text: briefing.text,
        briefing_version: briefing.version,
      });
      return { room: next, redelivered: true };
    });
    if (redelivered) await this.intake.resumePending(id);
    return updated;
  }

  async deleteRoleBriefing(roomId: string, input: unknown): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const request = RoleBriefingDeleteInputSchema.parse(input);
    return this.lock(id, async () => {
      const room = await this.store.load(id);
      this.assertMutable(room, 'delete a role briefing for');
      if (room.role_briefings[request.role] === undefined) {
        throw new RoomServiceError(`no role briefing exists for "${request.role}" in room "${id}"`);
      }
      const { [request.role]: _removed, ...rest } = room.role_briefings;
      return this.store.save(RoomSchema.parse({ ...room, role_briefings: rest }));
    });
  }

  async createInvite(roomId: string, input: unknown): Promise<InviteReceipt> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const request = CreateInviteInputSchema.parse(input);
    return this.lock(id, async () => {
      const room = await this.store.load(id);
      this.assertMutable(room, 'create an invite for');
      if (room.invites.some((invite) => invite.state === 'live' || invite.state === 'receipt_pending')) {
        throw new RoomServiceError(
          'standard SDK rooms permit one live invitation at a time so every accepted contact has unambiguous room admission metadata',
        );
      }
      return this.mintInviteUnlocked(room, {
        mode: request.mode,
        role: request.role ?? DEFAULT_ROLE,
        min_accepts: request.min_accepts,
      });
    });
  }

  /** Redeem an external invite without retaining its secret-bearing bytes. */
  async acceptExternalInvite(roomId: string, input: unknown): Promise<ExternalInviteReceipt> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const request = AcceptExternalInviteInputSchema.parse(input);
    let decoded: Buffer;
    try {
      decoded = unpackInvite(request.invite, MAX_EXTERNAL_INVITE_BYTES);
    } catch {
      throw new RoomServiceError('external invite is invalid or exceeds the 48 KiB decoded limit');
    }
    const digest = createHash('sha256').update(decoded).digest('hex');
    const receipt = await this.lock(id, async () => {
      const room = await this.store.load(id);
      this.assertMutable(room, 'accept an external invite for');
      const contactsBeforeRedemption = new Set(
        this.packet(id).listContacts().map((contact) => contact.container_id),
      );
      const predecessor = request.replaces_seat === undefined
        ? undefined
        : room.seats.find((seat) => seat.participant_id === request.replaces_seat);
      if (request.replaces_seat !== undefined
        && (!predecessor || predecessor.state !== 'removed' || predecessor.role !== request.role)) {
        throw new RoomServiceError('external replacement must reference a removed seat with the configured role');
      }
      if (predecessor && room.seats.some((seat) => seat.replaces_seat === predecessor.participant_id
        && (seat.state === 'pending' || seat.state === 'active'))) {
        throw new RoomServiceError('external replacement seat already has a pending or active successor');
      }

      let added: Awaited<ReturnType<RoomPacket['addContact']>>;
      try {
        added = await this.packet(id).addContact(request.invite);
      } catch {
        throw new RoomServiceError('external invite was rejected');
      }
      const cid = ContainerIdSchema.parse(added.container_id);
      if (request.expected_cid !== undefined && cid !== request.expected_cid) {
        throw new RoomServiceError('external invite inviter CID did not match --expected-cid');
      }
      if (contactsBeforeRedemption.has(cid)) {
        throw new RoomServiceError('external invite inviter is already a contact; redemption provenance is ambiguous');
      }
      if (room.seats.some((seat) => seat.identity === cid
        && (seat.state === 'pending' || seat.state === 'active'))) {
        throw new RoomServiceError('external inviter already has a pending or active seat in this room');
      }
      const requestedAt = this.now();
      const participantId = LowerCrockfordUlidSchema.parse(generateUlid());
      const seated = room.seats;
      const pending = {
        identity: cid,
        display_name: added.inviter_name,
        role: request.role,
        invite_id: added.invite_id,
        requested_at: requestedAt,
        invite_sha256: digest,
        participant_id: participantId,
        state: 'pending' as const,
        ...(predecessor === undefined ? {} : { replaces_seat: predecessor.participant_id }),
        ...(room.anonymous
          ? { alias: predecessor?.alias ?? mintAlias(seated, request.role) }
          : {}),
      };
      await this.store.save(RoomSchema.parse({ ...room, seats: [...room.seats, pending] }));
      const reconciled = await this.reconcileUnlocked(await this.store.load(id), this.packet(id));
      const seat = reconciled.seats.find((candidate) => candidate.participant_id === participantId)!;
      return {
        room_id: id,
        participant_id: participantId,
        state: seat.state as 'pending' | 'active',
        role: seat.role,
        identity: seat.identity,
        invite_id: seat.invite_id,
        inviter_name: added.inviter_name,
        pending_name: added.pending_name,
        requested_at: requestedAt,
        ...(seat.accepted_at === undefined ? {} : { accepted_at: seat.accepted_at }),
        ...(seat.replaces_seat === undefined ? {} : { replaces_seat: seat.replaces_seat }),
      };
    });
    await this.intake.resumePending(id);
    return receipt;
  }

  private async mintInviteUnlocked(
    room: Room,
    request: { mode: InviteMode; role: string; min_accepts: number; replaces_seat?: string },
  ): Promise<InviteReceipt> {
    if (room.invites.some((invite) => invite.state === 'live' || invite.state === 'receipt_pending')) {
      throw new RoomServiceError(
        'standard SDK rooms permit one live invitation at a time; revoke or consume the current invitation first',
      );
    }
    const packet = this.packet(room.room_id);
    const minted = await packet.mintInvite(request.mode);
    const invite = RoomInviteSchema.parse({
      invite_id: minted.invite_id,
      mode: request.mode,
      role: request.role,
      min_accepts: request.min_accepts,
      accepted_cids: [],
      state: 'live',
      created_at: this.now(),
      ...(request.replaces_seat === undefined ? {} : { replaces_seat: request.replaces_seat }),
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
      room_id: room.room_id,
      invite,
      blob: minted.blob,
      reusable: minted.reusable,
    };
  }

  /**
   * Operator-only removal (spec §5.2): archive-before-act membership intent,
   * seat state flip + epoch bump, core 0.13 bilateral sever with an honest
   * receipt, and an alias-form announcement unless the room or call is quiet.
   */
  async removeParticipant(roomId: string, input: unknown): Promise<RemovalReceipt> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const request = RemoveParticipantInputSchema.parse(input);
    const receipt = await this.lock(id, async () => {
      const room = await this.store.load(id);
      this.assertMutable(room, 'remove a participant from');
      const seat = this.findSeatForRemoval(room, request.participant);
      const notify = (request.notify ?? true) && !room.quiet_membership;
      return this.beginRemovalUnlocked(room, seat, notify);
    });
    await this.intake.resumePending(id);
    return receipt;
  }

  /**
   * Removal plus a same-role invite stamped with the seat lineage (spec §5.3).
   * Owner override OC-2/OC-6: in an anonymous room the flow is unconditionally
   * silent — the successor inherits the alias and other members see nothing.
   */
  async replaceParticipant(roomId: string, input: unknown): Promise<ReplacementReceipt> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const request = ReplaceParticipantInputSchema.parse(input);
    const receipt = await this.lock(id, async () => {
      const room = await this.store.load(id);
      this.assertMutable(room, 'replace a participant in');
      const seat = this.findActiveSeat(room, request.participant);
      const notify = room.anonymous
        ? false
        : (request.notify ?? true) && !room.quiet_membership;
      const removal = await this.beginRemovalUnlocked(room, seat, notify);
      const current = await this.store.load(id);
      const invite = await this.mintInviteUnlocked(current, {
        mode: request.mode ?? 'one_time',
        role: seat.role,
        min_accepts: request.min_accepts ?? 1,
        replaces_seat: seat.participant_id,
      });
      return { ...invite, removal };
    });
    await this.intake.resumePending(id);
    return receipt;
  }

  private findSeatForRemoval(room: Room, participant: string): Seat {
    const matches = (candidate: Seat): boolean =>
      candidate.identity === participant || candidate.participant_id === participant;
    const seat = room.seats.find((candidate) => candidate.state !== 'removed' && matches(candidate))
      ?? room.seats.find((candidate) => isCancelledExternalSeat(candidate) && matches(candidate));
    if (!seat) {
      throw new RoomServiceError(
        `"${participant}" is not a pending, active, or recoverable cancelled participant of room "${room.room_id}"`,
      );
    }
    return seat;
  }

  private findActiveSeat(room: Room, participant: string): Seat {
    const seat = room.seats.find((candidate) => candidate.state === 'active'
      && (candidate.identity === participant || candidate.participant_id === participant));
    if (!seat) {
      throw new RoomServiceError(`"${participant}" is not an active participant of room "${room.room_id}"`);
    }
    return seat;
  }

  private async beginRemovalUnlocked(room: Room, seat: Seat, notify: boolean): Promise<RemovalReceipt> {
    if (seat.state === 'pending' || isCancelledExternalSeat(seat)) {
      let cancelled = seat;
      if (seat.state === 'pending') {
        const removedAt = this.now();
        cancelled = {
          ...seat,
          state: 'removed',
          removed_at: removedAt,
          removed_epoch: room.membership_epoch,
        };
      }
      const seats = room.seats.map((candidate): Seat => candidate.participant_id === seat.participant_id
        ? cancelled
        : candidate);
      if (seat.state === 'pending') await this.store.save(RoomSchema.parse({ ...room, seats }));
      const established = this.packet(room.room_id).listContacts()
        .some((contact) => contact.container_id === seat.identity);
      if (established) {
        const outcome = await this.packet(room.room_id).removeContact(seat.identity);
        return {
          room_id: room.room_id,
          participant_id: seat.participant_id,
          epoch: room.membership_epoch,
          status: outcome.status,
          notified: outcome.notified,
          key_material_retained: true,
        };
      }
      return {
        room_id: room.room_id,
        participant_id: seat.participant_id,
        epoch: room.membership_epoch,
        status: 'cancelled_pending',
        notified: false,
        key_material_retained: true,
      };
    }
    const intent = await this.store.append(room.room_id, {
      version: 1,
      kind: 'membership_intent',
      room_id: room.room_id,
      at: this.now(),
      action: 'remove',
      participant_id: seat.participant_id,
      recipient_identity: seat.identity,
      role: seat.role,
      // The participant-visible label: the alias in anonymous rooms, the
      // contact display name otherwise (INV-R3 holds either way).
      alias: seat.alias ?? seat.display_name,
      epoch: room.membership_epoch + 1,
      notify,
    });
    if (intent.kind !== 'membership_intent') {
      throw new RoomServiceError('storage returned the wrong membership intent kind');
    }
    const { receipt } = await this.completeRemovalUnlocked(room, intent);
    return receipt;
  }

  /**
   * Idempotent completion of a durable removal intent: each step re-checks the
   * archive/state it would produce, so a crash anywhere re-drives cleanly
   * (INV-R5; the 0.13 sever is replay-safe by design).
   */
  private async completeRemovalUnlocked(
    room: Room,
    intent: MembershipIntentRecord,
  ): Promise<{ room: Room; receipt: RemovalReceipt }> {
    let current = room;
    const index = current.seats.findIndex(
      (candidate) => candidate.participant_id === intent.participant_id,
    );
    if (index < 0) {
      throw new RoomServiceError(
        `membership intent ${intent.record_id} references an unknown seat in room "${current.room_id}"`,
      );
    }
    if (current.seats[index]!.state !== 'removed') {
      const seats = [...current.seats];
      seats[index] = {
        ...seats[index]!,
        state: 'removed',
        removed_at: intent.at,
        removed_epoch: intent.epoch,
      };
      current = await this.store.save(RoomSchema.parse({
        ...current,
        seats,
        membership_epoch: Math.max(current.membership_epoch, intent.epoch),
      }));
    }
    const records = await this.store.read(current.room_id);
    const existing = records.find((record) =>
      record.kind === 'membership_result' && record.intent_record_id === intent.record_id);
    let outcome: { status: RelayStatus; notified: boolean; key_material_retained: true };
    if (existing !== undefined && existing.kind === 'membership_result') {
      outcome = {
        status: existing.status,
        notified: existing.notified,
        key_material_retained: true,
      };
    } else {
      outcome = await this.packet(current.room_id).removeContact(intent.recipient_identity);
      const result = await this.store.append(current.room_id, {
        version: 1,
        kind: 'membership_result',
        room_id: current.room_id,
        at: this.now(),
        intent_record_id: intent.record_id,
        participant_id: intent.participant_id,
        status: outcome.status,
        notified: outcome.notified,
        key_material_retained: true,
      });
      if (result.kind !== 'membership_result') {
        throw new RoomServiceError('storage returned the wrong membership result kind');
      }
    }
    if (intent.notify) await this.ensureMembershipNotice(current, intent);
    return {
      room: current,
      receipt: {
        room_id: current.room_id,
        participant_id: intent.participant_id,
        epoch: intent.epoch,
        status: outcome.status,
        notified: outcome.notified,
        key_material_retained: true,
      },
    };
  }

  private async ensureMembershipNotice(room: Room, intent: MembershipIntentRecord): Promise<void> {
    const records = await this.store.read(room.room_id);
    const already = records.some((record) => record.kind === 'message'
      && record.category === 'membership'
      && record.membership?.action === 'remove'
      && record.membership.epoch === intent.epoch);
    if (already) return;
    const remaining = activeSeats(room);
    if (remaining.length === 0) return;
    const label = intent.alias ?? intent.role;
    const appended = await this.store.append(room.room_id, {
      version: 1,
      kind: 'message',
      room_id: room.room_id,
      at: this.now(),
      message_id: LowerCrockfordUlidSchema.parse(this.nextMessageId()),
      author: { identity: room.identity_cid, display_name: room.identity_name, role: ROOM_ROLE },
      category: 'membership',
      text: `${label} left the room · epoch ${intent.epoch}`,
      membership: { action: 'remove', alias: label, role: intent.role, epoch: intent.epoch },
      recipient_identities: uniqueIdentities(remaining.map((seat) => seat.identity)),
    });
    if (appended.kind !== 'message') {
      throw new RoomServiceError('storage returned the wrong membership notice kind');
    }
    for (const recipientIdentity of appended.recipient_identities) {
      await this.store.append(room.room_id, {
        version: 1,
        kind: 'relay_intent',
        room_id: room.room_id,
        at: this.now(),
        message_id: appended.message_id,
        recipient_identity: recipientIdentity,
      });
    }
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
    const receipts = await this.lock(id, async () => {
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
    // Live admission uses this operator recovery boundary. Reconciliation
    // durably creates briefing intents while holding the room lock; drain them
    // only after releasing it because IntakePump acquires the same mutex.
    await this.intake.resumePending(id);
    return receipts;
  }

  async confirmRecoveredInvite(roomId: string, recoveryOf: string, inviteId: string): Promise<RoomInvite> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const oldId = z.string().min(1).parse(recoveryOf);
    const replacementId = z.string().min(1).parse(inviteId);
    const confirmed = await this.lock(id, async () => {
      let room = await this.store.load(id);
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
        await this.reconcileUnlocked(room, this.packet(id));
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
        throw new RoomServiceError('recovered invite is no longer present in SDK identity state');
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
      room = await this.store.save(RoomSchema.parse({ ...room, invites }));
      await this.reconcileUnlocked(room, this.packet(id));
      return confirmed;
    });
    await this.intake.resumePending(id);
    return confirmed;
  }

  async reconcileRoom(roomId: string): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    return this.lock(id, async () => this.reconcileUnlocked(await this.store.load(id), this.packet(id)));
  }

  async notifyRoom(roomId: string, _event = 'message_received'): Promise<void> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    // Contact acceptance and message delivery are separate core callbacks.
    // Reconcile first under the room mutex for either callback so the first
    // immediately-following participant message can never be drained as an
    // unauthorized non-seat. Intake takes the same mutex only after admission.
    await this.lock(id, async () => {
      const room = await this.store.load(id);
      await this.reconcileUnlocked(room, this.packet(id));
    });
    await this.intake.notify(id);
  }

  resumePending(roomId: string): Promise<void> {
    return this.intake.resumePending(roomId);
  }

  beginShutdown(): void {
    this.intake.beginShutdown();
  }

  drain(): Promise<void> {
    return this.intake.drain();
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

  async history(
    roomId: string,
    options: unknown = {},
  ): Promise<CommunicationRecord[] | ParticipantHistoryRecord[]> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    const { view, ...page } = HistoryOptionsSchema.parse(options);
    const records = await this.store.read(id, view === 'participant'
      ? { after: page.after }
      : page as ArchiveReadOptions);
    if (view !== 'participant') return byteBoundedHistoryPage(records);
    const projected = records
      .filter((record): record is MessageRecord => record.kind === 'message')
      .map((record): ParticipantHistoryRecord => {
        const {
          author_alias,
          recipient_identities: _recipients,
          source_msg_id: _sourceMsg,
          source_wire_id: _sourceWire,
          ...rest
        } = record;
        return {
          ...rest,
          author: author_alias === undefined ? record.author : {
            identity: author_alias.participant_id,
            display_name: author_alias.alias,
            role: record.author.role,
          },
        };
      });
    return byteBoundedHistoryPage(projected.slice(0, page.limit ?? Number.MAX_SAFE_INTEGER));
  }

  /**
   * Forward-only close. Every external contact mutation is preceded by a
   * durable intent and the packet/live-state purge precedes terminal metadata.
   */
  async closeRoom(roomId: string): Promise<Room> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    return this.lock(id, async () => {
      let room = await this.store.load(id);
      if (room.state === 'closed') {
        // A previous atomic rename may have committed closed metadata while
        // its directory fsync failed. Replacing the exact snapshot repeats
        // that durability barrier before close reports success.
        return this.store.save(room);
      }
      if (room.state === 'closing') {
        // Likewise, never resume external effects from a merely observed
        // closing rename. Re-save the exact snapshot and complete its parent
        // directory barrier first.
        room = await this.store.save(room);
      } else {
        room = await this.store.save(RoomSchema.parse({ ...room, state: 'closing' }));
      }
      return this.closeUnlocked(room);
    });
  }

  /** Delete only retained state belonging to this host after explicit consent. */
  async deleteRoom(roomId: string, input: unknown): Promise<DeleteRoomReceipt> {
    const id = LowerCrockfordUlidSchema.parse(roomId);
    DeleteRoomInputSchema.parse(input);
    return this.lock(id, async () => {
      let room: Room | undefined;
      try {
        room = await this.store.load(id);
      } catch (error) {
        // CoworkStore.delete is itself fail-closed and recognizes only the
        // archive-first partial stages produced by an earlier confirmed call.
        // Let it distinguish such a resumable stage from malformed live data.
        try {
          await this.store.delete(id);
        } catch {
          throw error;
        }
        return this.deleteReceipt(id);
      }
      if (room.state !== 'closed') {
        throw new RoomServiceError(`room "${id}" must be closed before it can be deleted`);
      }
      await this.store.delete(id);
      return this.deleteReceipt(id);
    });
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
        recipient_identities: uniqueIdentities(activeSeats(room).map((seat) => seat.identity)),
      });
      if (appended.kind !== 'message') throw new RoomServiceError('storage returned the wrong room message kind');
      for (const recipientIdentity of appended.recipient_identities) {
        await this.store.append(id, {
          version: 1,
          kind: 'relay_intent',
          room_id: id,
          at: this.now(),
          message_id: appended.message_id,
          recipient_identity: recipientIdentity,
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
    const inviteById = new Map(room.invites.map((invite) => [invite.invite_id, invite]));
    const existingCids = new Set(room.seats
      .filter((seat) => seat.state === 'active' || seat.state === 'pending')
      .map((seat) => seat.identity));
    // The public standard SDK intentionally does not expose custom actor
    // contact-origin records. Cowork 1.0 therefore keeps at most one live room
    // invite and assigns newly accepted contacts to that unambiguous descriptor.
    const lastRemovedAt = new Map<string, string>();
    for (const seat of room.seats) {
      if (seat.state !== 'removed' || seat.removed_at === undefined) continue;
      const previous = lastRemovedAt.get(seat.identity);
      if (previous === undefined || seat.removed_at > previous) {
        lastRemovedAt.set(seat.identity, seat.removed_at);
      }
    }
    const activatedPending: Seat[] = [];
    const seatsWithActivations = [...room.seats];
    for (const [seatIndex, seat] of room.seats.entries()) {
      if (seat.state !== 'pending') continue;
      const displayName = contactsByCid.get(seat.identity);
      if (displayName === undefined) continue;
      const { alias: _alias, replaces_seat: _replacesSeat, ...base } = seat;
      const activated: Seat = {
        ...base,
        state: 'active',
        display_name: displayName,
        accepted_at: this.now(),
        ...(_replacesSeat === undefined ? {} : { replaces_seat: _replacesSeat }),
        ...(room.anonymous ? { alias: _alias! } : {}),
      };
      activatedPending.push(activated);
      seatsWithActivations[seatIndex] = activated;
    }
    const newSeats: Seat[] = [];

    const eligibleInvites = room.invites.filter((invite) => invite.state === 'live'
      && (invite.recovery_of === undefined || invite.recovery_confirmed === true));
    const admissionInvite = eligibleInvites.length === 1 ? eligibleInvites[0] : undefined;
    for (const [cid, displayName] of contactsByCid) {
      if (existingCids.has(cid)) continue;
      const invite = admissionInvite;
      if (!invite) continue;
      const removedAt = lastRemovedAt.get(cid);
      if (removedAt !== undefined && invite.created_at <= removedAt) continue;
      const seated = [...seatsWithActivations, ...newSeats];
      const predecessor = invite.replaces_seat === undefined
        ? undefined
        : seated.find((seat) => seat.participant_id === invite.replaces_seat && seat.state === 'removed');
      if (invite.replaces_seat !== undefined && !predecessor) continue;
      newSeats.push({
        identity: cid,
        display_name: displayName,
        role: invite.role,
        invite_id: invite.invite_id,
        accepted_at: this.now(),
        participant_id: LowerCrockfordUlidSchema.parse(generateUlid()),
        state: 'active',
        ...(predecessor === undefined ? {} : { replaces_seat: predecessor.participant_id }),
        // OC-6 (owner override): a replacement into a role inherits the
        // predecessor's alias — the alias binds to the seat/role lineage.
        ...(room.anonymous
          ? { alias: predecessor?.alias ?? mintAlias(seated, invite.role) }
          : {}),
      });
      existingCids.add(cid);
    }

    const seats = [...seatsWithActivations, ...newSeats];
    const acceptedByInvite = new Map<string, string[]>();
    for (const seat of seats) {
      if (seat.state === 'pending' || !inviteById.has(seat.invite_id)) continue;
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

    let next: Room = RoomSchema.parse({
      ...room,
      seats,
      invites,
      membership_epoch: room.membership_epoch + activatedPending.length + newSeats.length,
    });
    // Re-drive any removal whose intent has no terminal result (INV-R5).
    const journal = await this.store.read(next.room_id);
    const completedIntents = new Set(journal
      .filter((record) => record.kind === 'membership_result')
      .map((record) => record.kind === 'membership_result' ? record.intent_record_id : ''));
    for (const intent of journal.filter(
      (record): record is MembershipIntentRecord => record.kind === 'membership_intent',
    )) {
      if (completedIntents.has(intent.record_id)) continue;
      ({ room: next } = await this.completeRemovalUnlocked(next, intent));
    }
    const requirementsMet = invites
      .filter((invite) => invite.state !== 'revoked')
      .every((invite) => invite.accepted_cids.length >= invite.min_accepts);
    const admitted = [...activatedPending, ...newSeats];
    if (next.state === 'provisioning' && activeSeats(next).length > 0 && requirementsMet) {
      const activationAt = await this.ensureActivationBriefing(next, activeSeats(next));
      next = RoomSchema.parse({ ...next, state: 'active', activated_at: activationAt });
    } else if (next.state === 'active' && admitted.length > 0) {
      await this.ensureActivationBriefing(next, admitted);
    }
    return this.store.save(next);
  }

  private async closeUnlocked(room: Room): Promise<Room> {
    const roomId = room.room_id;
    const packet = this.packets.get(roomId);
    if (packet) {
      // A preceding remove may have committed in the daemon even when its
      // caller observed a transport failure. Reconcile before interpreting a
      // result-less intent, so retries never rely on an in-process cache.
      await packet.refreshContacts();
      let records = await this.store.read(roomId);
      let contacts = currentContactIdentities(packet);
      const completed = new Set(records
        .filter((record) => record.kind === 'close_notice_result')
        .map((record) => record.kind === 'close_notice_result' ? record.intent_record_id : ''));
      const pending = records.filter(
        (record): record is CloseNoticeIntentRecord =>
          record.kind === 'close_notice_intent' && !completed.has(record.record_id),
      );

      // A result-less intent plus an absent contact is the only durable proof
      // available after an origin-ambiguous remove. It is explicitly recorded
      // as uncertain, never upgraded into a successful notice claim.
      for (const intent of pending) {
        if (contacts.has(intent.recipient_identity)) continue;
        await this.appendUncertainCloseResult(roomId, intent);
        completed.add(intent.record_id);
      }

      for (const recipientIdentity of contacts) {
        records = await this.store.read(roomId);
        const currentCompleted = new Set(records
          .filter((record) => record.kind === 'close_notice_result')
          .map((record) => record.kind === 'close_notice_result' ? record.intent_record_id : ''));
        let intent = [...records].reverse().find(
          (record): record is CloseNoticeIntentRecord => record.kind === 'close_notice_intent'
            && record.recipient_identity === recipientIdentity
            && !currentCompleted.has(record.record_id),
        );
        if (!intent) {
          const appended = await this.store.append(roomId, {
            version: 1,
            kind: 'close_notice_intent',
            room_id: roomId,
            at: this.now(),
            recipient_identity: recipientIdentity,
          });
          if (appended.kind !== 'close_notice_intent') {
            throw new RoomServiceError('storage returned the wrong close notice intent kind');
          }
          intent = appended;
        }

        // Throws are origin-ambiguous: deliberately leave the intent without
        // a result so recovery can inspect the contact before deciding.
        const outcome = await packet.removeContact(recipientIdentity);
        const appended = await this.store.append(roomId, {
          version: 1,
          kind: 'close_notice_result',
          room_id: roomId,
          at: this.now(),
          intent_record_id: intent.record_id,
          recipient_identity: recipientIdentity,
          status: outcome.status,
          notified: outcome.notified,
          key_material_retained: outcome.key_material_retained,
        });
        if (appended.kind !== 'close_notice_result') {
          throw new RoomServiceError('storage returned the wrong close notice result kind');
        }
      }

      contacts = currentContactIdentities(packet);
      if (contacts.size > 0) {
        throw new RoomServiceError(
          `room "${roomId}" still has contacts after removal: ${[...contacts].join(', ')}`,
        );
      }
    }

    const residue = await this.packets.destroy(roomId);
    if (this.packets.get(roomId) || residue.length > 0) {
      throw new RoomServiceError(
        `room "${roomId}" live-state purge left residue: ${residue.join(', ') || 'packet registry entry'}`,
      );
    }

    // If the packet was already absent, successful bounded purge is proof
    // that result-less contacts no longer exist locally. Preserve uncertainty.
    const afterPurge = await this.store.read(roomId);
    const completedAfterPurge = new Set(afterPurge
      .filter((record) => record.kind === 'close_notice_result')
      .map((record) => record.kind === 'close_notice_result' ? record.intent_record_id : ''));
    for (const intent of afterPurge.filter(
      (record): record is CloseNoticeIntentRecord =>
        record.kind === 'close_notice_intent' && !completedAfterPurge.has(record.record_id),
    )) {
      await this.appendUncertainCloseResult(roomId, intent);
      completedAfterPurge.add(intent.record_id);
    }

    return this.store.save(RoomSchema.parse({ ...room, state: 'closed', closed_at: this.now() }));
  }

  private async appendUncertainCloseResult(
    roomId: string,
    intent: CloseNoticeIntentRecord,
  ): Promise<void> {
    const appended = await this.store.append(roomId, {
      version: 1,
      kind: 'close_notice_result',
      room_id: roomId,
      at: this.now(),
      intent_record_id: intent.record_id,
      recipient_identity: intent.recipient_identity,
      status: 'send_failed',
      notified: false,
      key_material_retained: true,
      uncertain_after_restart: true,
    });
    if (appended.kind !== 'close_notice_result') {
      throw new RoomServiceError('storage returned the wrong uncertain close notice result kind');
    }
  }

  private deleteReceipt(roomId: string): DeleteRoomReceipt {
    return { version: 1, room_id: roomId, deleted: true, scope: 'this_host' };
  }

  /**
   * Deliver the common briefing followed by the seat's role briefing (spec
   * §3.3): exactly once per (seat, briefing kind, version) via the message +
   * relay-intent ledger. Returns the timestamp of the common briefing message
   * that admitted the earliest of the given recipients (activation time).
   */
  private async ensureActivationBriefing(room: Room, recipients: Seat[]): Promise<string> {
    const at = await this.ensureBriefingKind(room, recipients, {
      category: 'briefing',
      text: room.mission.briefing,
      briefing_version: room.mission.briefing_version,
    });
    await this.ensureRoleBriefings(room, recipients);
    return at;
  }

  private async ensureRoleBriefings(room: Room, recipients: Seat[]): Promise<void> {
    for (const seat of recipients) {
      const briefing = room.role_briefings[seat.role];
      if (!briefing) continue;
      await this.ensureBriefingKind(room, [seat], {
        category: 'role_briefing',
        briefing_role: seat.role,
        text: briefing.text,
        briefing_version: briefing.version,
      });
    }
  }

  /** Re-deliver the (just bumped) common briefing to every active seat. */
  private async redeliverCommonBriefing(room: Room): Promise<void> {
    await this.ensureBriefingKind(room, activeSeats(room), {
      category: 'briefing',
      text: room.mission.briefing,
      briefing_version: room.mission.briefing_version,
    });
  }

  private async ensureBriefingKind(
    room: Room,
    recipients: Seat[],
    briefing: {
      category: 'briefing' | 'role_briefing';
      briefing_role?: string;
      text: string;
      briefing_version: number;
    },
  ): Promise<string> {
    const records = await this.store.read(room.room_id);
    // A pre-evolution briefing record carries no version stamp; it delivered
    // what is now version 1, so migration alone never re-sends anything.
    const matching = records.filter((record): record is MessageRecord =>
      record.kind === 'message'
      && record.category === briefing.category
      && record.briefing_role === briefing.briefing_role
      && (record.briefing_version ?? 1) === briefing.briefing_version);
    const intentsByMessage = new Map<string, Set<string>>();
    for (const record of records) {
      if (record.kind !== 'relay_intent' || record.message_id === undefined) continue;
      const intents = intentsByMessage.get(record.message_id) ?? new Set<string>();
      intents.add(record.recipient_identity);
      intentsByMessage.set(record.message_id, intents);
    }
    const covered = new Set<string>();
    for (const message of matching) {
      const intents = intentsByMessage.get(message.message_id) ?? new Set<string>();
      for (const recipientIdentity of message.recipient_identities) {
        covered.add(recipientIdentity);
        if (!intents.has(recipientIdentity)) {
          await this.store.append(room.room_id, {
            version: 1,
            kind: 'relay_intent',
            room_id: room.room_id,
            at: this.now(),
            message_id: message.message_id,
            recipient_identity: recipientIdentity,
          });
        }
      }
    }
    const missing = recipients.filter((seat) => !covered.has(seat.identity));
    let appendedAt: string | undefined;
    if (missing.length > 0) {
      const appended = await this.store.append(room.room_id, {
        version: 1,
        kind: 'message',
        room_id: room.room_id,
        at: this.now(),
        message_id: LowerCrockfordUlidSchema.parse(this.nextMessageId()),
        author: { identity: room.identity_cid, display_name: room.identity_name, role: ROOM_ROLE },
        category: briefing.category,
        ...(briefing.briefing_role === undefined ? {} : { briefing_role: briefing.briefing_role }),
        briefing_version: briefing.briefing_version,
        text: briefing.text,
        recipient_identities: uniqueIdentities(missing.map((seat) => seat.identity)),
      });
      if (appended.kind !== 'message') throw new RoomServiceError('storage returned the wrong briefing record kind');
      appendedAt = appended.at;
      for (const recipientIdentity of appended.recipient_identities) {
        await this.store.append(room.room_id, {
          version: 1,
          kind: 'relay_intent',
          room_id: room.room_id,
          at: this.now(),
          message_id: appended.message_id,
          recipient_identity: recipientIdentity,
        });
      }
    }
    return matching[0]?.at ?? appendedAt ?? this.now();
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
      && isPersistedRoomIdentityName(room.room_id, room.identity_name);
  }

  private now(): string {
    return z.string().datetime({ offset: true }).parse(this.nowValue());
  }
}

function activeSeats(room: Room): Seat[] {
  return room.seats.filter((seat) => seat.state === 'active');
}

function isCancelledExternalSeat(seat: Seat): boolean {
  return seat.state === 'removed'
    && seat.accepted_at === undefined
    && seat.requested_at !== undefined
    && seat.invite_sha256 !== undefined;
}

/**
 * Room-scoped pseudonym "<role> #<n>": n is the per-role admission ordinal
 * counted over every seat ever admitted with the role (removed seats keep
 * their ordinal; replacements inherit instead of minting).
 */
function mintAlias(seated: Seat[], role: string): string {
  return `${role} #${seated.filter((seat) => seat.role === role).length + 1}`;
}

function uniqueIdentities(identities: string[]): string[] {
  return [...new Set(identities)];
}

function currentContactIdentities(packet: RoomPacket): Set<string> {
  return new Set(packet.listContacts().map((contact) => contact.container_id));
}
