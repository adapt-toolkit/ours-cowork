import { createHash } from 'node:crypto';

import { z } from 'zod';

const MAX_TEXT_BYTES = 262_144;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * History remains an array-shaped public response, but each daemon page is
 * byte-bounded.  Three MiB fits one maximum-size file record after base64
 * expansion; the management envelope gets a separate one-MiB allowance.
 */
export const MAX_HISTORY_PAGE_BYTES = 3 * 1024 * 1024;
export const MAX_MANAGEMENT_RESPONSE_BYTES = MAX_HISTORY_PAGE_BYTES + (1024 * 1024);
export const MAX_EXTERNAL_INVITE_BYTES = 48 * 1024;
const MAX_FILE_NAME_BYTES = 255;
const MAX_MIME_BYTES = 255;
const MAX_ROLE_BYTES = 256;
export const MAX_ROOM_NAME_CHARACTERS = 64;
export const MAX_ROOM_IDENTITY_NAME_CHARACTERS = 64;
export const MAX_FRIENDLY_IDENTITY_SLUG_CHARACTERS = 25;

function utf8Bounded(label: string, maximumBytes: number): z.ZodType<string> {
  return z.string()
    .refine((value) => Buffer.byteLength(value, 'utf8') >= 1, `${label} must be at least 1 UTF-8 byte`)
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') <= maximumBytes,
      `${label} must be at most ${maximumBytes} UTF-8 bytes`,
    );
}

const NonEmptyStringSchema = z.string().min(1);
const PositiveSafeIntegerSchema = z.number().int().positive().safe();

export const LowerCrockfordUlidSchema = z.string().regex(
  /^[0-7][0-9a-hjkmnp-tv-z]{25}$/,
  'must be a 26-character lowercase Crockford ULID',
);

function isStrictRfc3339(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

export const Rfc3339Schema = z.string().refine(isStrictRfc3339, 'must be a valid RFC3339 timestamp');
export function normalizeRoomName(value: string): string {
  return value.trim().normalize('NFC');
}

export const RoomNameSchema = z.string()
  .refine(
    (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
    'room name must not contain Unicode control or format characters',
  )
  .transform(normalizeRoomName)
  .superRefine((value, context) => {
    const length = Array.from(value).length;
    if (length < 1 || length > MAX_ROOM_NAME_CHARACTERS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `room name must contain 1-${MAX_ROOM_NAME_CHARACTERS} Unicode characters after normalization`,
      });
    }
  });

/** Supported creation-time behavior for the room's immutable SDK identity name. */
export const RoomIdentityNameModeSchema = z.enum(['stable_id', 'friendly']);
export type RoomIdentityNameMode = z.infer<typeof RoomIdentityNameModeSchema>;

/** ASCII, globally unique SDK identity name for rooms created by vNext. */
export const ROOM_IDENTITY_PREFIX = 'ours-cowork-';
const SDK_IDENTITY_NAME_PATTERN = /^[A-Za-z0-9 _.@-]{1,64}$/;
const FRIENDLY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function roomIdentityName(roomId: string): string {
  return `${ROOM_IDENTITY_PREFIX}${LowerCrockfordUlidSchema.parse(roomId)}`;
}

export function roomIdentitySlug(roomName: string): string {
  const normalized = RoomNameSchema.parse(roomName)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const bounded = normalized
    .slice(0, MAX_FRIENDLY_IDENTITY_SLUG_CHARACTERS)
    .replace(/-+$/g, '');
  return bounded || 'room';
}

export function friendlyRoomIdentityName(roomId: string, roomName: string): string {
  const id = LowerCrockfordUlidSchema.parse(roomId);
  const name = `${ROOM_IDENTITY_PREFIX}${roomIdentitySlug(roomName)}-${id}`;
  if (name.length > MAX_ROOM_IDENTITY_NAME_CHARACTERS || !SDK_IDENTITY_NAME_PATTERN.test(name)) {
    throw new TypeError('generated room identity name violates the shared ours daemon contract');
  }
  return name;
}

export function configuredRoomIdentityName(
  roomId: string,
  roomName: string,
  mode: RoomIdentityNameMode,
): string {
  return mode === 'friendly'
    ? friendlyRoomIdentityName(roomId, roomName)
    : roomIdentityName(roomId);
}

/** Existing rooms retain this room-id-based identity name without migration. */
export function legacyRoomIdentityName(roomId: string): string {
  return `cowork-room-${LowerCrockfordUlidSchema.parse(roomId)}`;
}

/** Accept exact durable names without recomputing a slug from mutable room_name. */
export function isPersistedRoomIdentityName(roomId: string, identityName: string): boolean {
  const id = LowerCrockfordUlidSchema.safeParse(roomId);
  if (!id.success) return false;
  if (identityName === roomIdentityName(id.data) || identityName === legacyRoomIdentityName(id.data)) return true;
  const suffix = `-${id.data}`;
  if (!identityName.startsWith(ROOM_IDENTITY_PREFIX) || !identityName.endsWith(suffix)) return false;
  const slug = identityName.slice(ROOM_IDENTITY_PREFIX.length, -suffix.length);
  return slug.length >= 1
    && slug.length <= MAX_FRIENDLY_IDENTITY_SLUG_CHARACTERS
    && FRIENDLY_SLUG_PATTERN.test(slug)
    && identityName.length <= MAX_ROOM_IDENTITY_NAME_CHARACTERS
    && SDK_IDENTITY_NAME_PATTERN.test(identityName);
}

/** Standard SDK formats are restorable; the exact legacy format remains loadable but refused later. */
export function isStandardRoomIdentityName(roomId: string, identityName: string): boolean {
  return isPersistedRoomIdentityName(roomId, identityName)
    && identityName !== legacyRoomIdentityName(roomId);
}
export const RoleSchema = utf8Bounded('role', MAX_ROLE_BYTES);
export const ROOM_ROLE = 'room';
export const MissionTextSchema = utf8Bounded('mission text', MAX_TEXT_BYTES);
export const MessageTextSchema = utf8Bounded('message text', MAX_TEXT_BYTES);
export const FileNameSchema = utf8Bounded('file name', MAX_FILE_NAME_BYTES)
  .refine((value) => value !== '.' && value !== '..', 'file name must not be a relative path token')
  .refine((value) => !/[\x00/\\]/.test(value), 'file name must be a single path-free name');
/** MIME is opaque metadata, not an execution allowlist; empty means unspecified. */
export const FileMimeSchema = z.string().refine(
  (value) => Buffer.byteLength(value, 'utf8') <= MAX_MIME_BYTES,
  `file MIME metadata must be at most ${MAX_MIME_BYTES} UTF-8 bytes`,
);

export const RoomStateSchema = z.enum(['provisioning', 'active', 'closing', 'closed']);
export const SeatStateSchema = z.enum(['pending', 'active', 'removed']);
export const InviteModeSchema = z.enum(['one_time', 'public']);

/** Built-in role assigned when an invite omits one. */
export const DEFAULT_ROLE = 'Participant';
export const InviteStateSchema = z.enum([
  'live',
  'consumed',
  'revoked',
  'replacement_required',
  'receipt_pending',
]);
export const RelayStatusSchema = z.enum(['queued', 'send_failed']);

const SeatV1Schema = z.object({
  identity: NonEmptyStringSchema,
  display_name: NonEmptyStringSchema,
  role: RoleSchema,
  invite_id: NonEmptyStringSchema,
  accepted_at: Rfc3339Schema,
}).strict();

export const SeatSchema = z.object({
  identity: NonEmptyStringSchema,
  display_name: NonEmptyStringSchema,
  role: RoleSchema,
  invite_id: NonEmptyStringSchema,
  accepted_at: Rfc3339Schema.optional(),
  requested_at: Rfc3339Schema.optional(),
  invite_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  participant_id: LowerCrockfordUlidSchema,
  state: SeatStateSchema,
  alias: NonEmptyStringSchema.optional(),
  removed_at: Rfc3339Schema.optional(),
  removed_epoch: z.number().int().nonnegative().safe().optional(),
  replaces_seat: LowerCrockfordUlidSchema.optional(),
  bounced_at: Rfc3339Schema.optional(),
}).strict().superRefine((seat, context) => {
  if (seat.state === 'pending') {
    for (const field of ['requested_at', 'invite_sha256'] as const) {
      if (seat[field] === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `pending seats require ${field}` });
      }
    }
    for (const field of ['accepted_at', 'removed_at', 'removed_epoch', 'bounced_at'] as const) {
      if (seat[field] !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is forbidden on pending seats` });
      }
    }
  } else if (seat.state === 'removed') {
    if (seat.accepted_at === undefined && seat.requested_at === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accepted_at'],
        message: 'removed seats require accepted_at unless they are cancelled external admissions',
      });
    }
    if (seat.removed_at === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['removed_at'],
        message: 'removed seats require removed_at',
      });
    }
    if (seat.removed_epoch === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['removed_epoch'],
        message: 'removed seats require removed_epoch',
      });
    }
  } else {
    if (seat.accepted_at === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['accepted_at'], message: 'active seats require accepted_at' });
    }
    for (const field of ['removed_at', 'removed_epoch', 'bounced_at'] as const) {
      if (seat[field] !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is reserved for removed seats`,
        });
      }
    }
  }
  if ((seat.requested_at === undefined) !== (seat.invite_sha256 === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invite_sha256'],
      message: 'external admission metadata requires both requested_at and invite_sha256',
    });
  }
});

export const RoomInviteSchema = z.object({
  invite_id: NonEmptyStringSchema,
  mode: InviteModeSchema,
  role: RoleSchema,
  min_accepts: PositiveSafeIntegerSchema,
  accepted_cids: z.array(NonEmptyStringSchema),
  state: InviteStateSchema,
  recovery_of: NonEmptyStringSchema.optional(),
  recovery_confirmed: z.boolean().optional(),
  created_at: Rfc3339Schema,
  replaces_seat: LowerCrockfordUlidSchema.optional(),
}).strict().superRefine((invite, context) => {
  if (invite.mode === 'one_time' && invite.min_accepts !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['min_accepts'],
      message: 'one_time invites require min_accepts === 1',
    });
  }
  if (invite.state === 'receipt_pending' && invite.recovery_of === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recovery_of'],
      message: 'receipt_pending invites require recovery_of',
    });
  }
  if (invite.recovery_of === undefined && invite.recovery_confirmed !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recovery_confirmed'],
      message: 'recovery_confirmed is forbidden without recovery_of',
    });
  }
  if (invite.recovery_of !== undefined && invite.recovery_confirmed === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recovery_confirmed'],
      message: 'recovery_confirmed is required with recovery_of',
    });
  }
  if (invite.state === 'receipt_pending' && invite.recovery_confirmed !== false) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recovery_confirmed'],
      message: 'receipt_pending recovery lineage must be unconfirmed',
    });
  }
  if (invite.recovery_of !== undefined
    && (invite.state === 'live' || invite.state === 'consumed' || invite.state === 'replacement_required')
    && invite.recovery_confirmed !== true) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recovery_confirmed'],
      message: 'live, consumed, and replacement_required recovery lineage must be confirmed',
    });
  }
  if (invite.state === 'receipt_pending' && invite.accepted_cids.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accepted_cids'],
      message: 'receipt_pending invites cannot have accepted CIDs',
    });
  }
});

const MissionV1Schema = z.object({
  goal: MissionTextSchema,
  briefing: MissionTextSchema,
}).strict();

export const MissionSchema = z.object({
  goal: MissionTextSchema,
  briefing: MissionTextSchema,
  briefing_version: PositiveSafeIntegerSchema,
}).strict();

export const RoleBriefingSchema = z.object({
  text: MissionTextSchema,
  version: PositiveSafeIntegerSchema,
  updated_at: Rfc3339Schema,
}).strict();

interface RoomLineageView {
  room_id: string;
  room_name?: string;
  identity_name: string;
  identity_cid: string;
  state: z.infer<typeof RoomStateSchema>;
  status?: string;
  invites: z.infer<typeof RoomInviteSchema>[];
  seats: unknown[];
  activated_at?: string;
  closed_at?: string;
}

function refineRoomLineage(room: RoomLineageView, context: z.RefinementCtx): void {
  const exactPacketPending = room.state === 'provisioning'
    && room.status === 'packet_pending'
    && isPersistedRoomIdentityName(room.room_id, room.identity_name)
    && room.invites.length === 0
    && room.seats.length === 0
    && room.activated_at === undefined
    && room.closed_at === undefined;
  if (room.identity_cid === '' && !exactPacketPending) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['identity_cid'],
      message: 'empty identity_cid is reserved for the exact packet_pending provisioning sentinel',
    });
  }
  if (room.identity_cid !== '' && room.status === 'packet_pending') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'packet_pending status requires an empty identity_cid',
    });
  }
  const pendingByRecovery = new Map<string, number>();
  for (const [index, invite] of room.invites.entries()) {
    if (invite.recovery_of === undefined) continue;
    const recoveryOf = invite.recovery_of;
    const source = room.invites.find((candidate) => candidate.invite_id === recoveryOf);
    const validSourceState = invite.state === 'receipt_pending'
      ? source?.state === 'replacement_required'
      : invite.state === 'live' || invite.state === 'consumed' || invite.state === 'replacement_required'
        ? source?.state === 'revoked'
        : invite.state === 'revoked'
          ? invite.recovery_confirmed === true
            ? source?.state === 'revoked'
            : source?.state === 'replacement_required' || source?.state === 'revoked'
          : false;
    if (!source || source.invite_id === invite.invite_id || !validSourceState) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invites', index, 'recovery_of'],
        message: 'recovery_of must point to a source invite in the state required by this recovery lineage',
      });
    } else if (invite.mode !== source.mode
      || invite.role !== source.role
      || invite.min_accepts !== source.min_accepts) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invites', index],
        message: 'receipt_pending descriptor must copy source mode, role, and min_accepts',
      });
    }
    if (invite.state === 'receipt_pending') {
      const count = (pendingByRecovery.get(recoveryOf) ?? 0) + 1;
      pendingByRecovery.set(recoveryOf, count);
      if (count > 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['invites', index, 'recovery_of'],
          message: 'only one receipt_pending invite may exist per recovery_of pointer',
        });
      }
    }
  }
}

const RoomCommonShape = {
  room_id: LowerCrockfordUlidSchema,
  identity_name: NonEmptyStringSchema,
  identity_cid: z.string(),
  state: RoomStateSchema,
  status: NonEmptyStringSchema.optional(),
  invites: z.array(RoomInviteSchema),
  created_at: Rfc3339Schema,
  activated_at: Rfc3339Schema.optional(),
  closed_at: Rfc3339Schema.optional(),
} as const;

/** The pre-evolution on-disk shape, accepted only by the explicit migration path. */
export const RoomV1Schema = z.object({
  ...RoomCommonShape,
  version: z.literal(1),
  mission: MissionV1Schema,
  seats: z.array(SeatV1Schema),
}).strict().superRefine(refineRoomLineage);

const CurrentRoomSchema = z.object({
  ...RoomCommonShape,
  room_name: RoomNameSchema,
  version: z.literal(2),
  mission: MissionSchema,
  role_briefings: z.record(RoleSchema, RoleBriefingSchema),
  /**
   * Roles a REST caller may author under. A plain array of names:
   * the role name IS the identifier, so there is nothing per-role to store.
   * Not a seat, not a membership: seat and membership invariants do not apply.
   * The registry itself is an exact-name set, and reserves `room` for the
   * room's own voice.
   */
  rest_roles: z.array(RoleSchema).superRefine((roles, context) => {
    const seen = new Set<string>();
    for (const [index, role] of roles.entries()) {
      if (role === ROOM_ROLE) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `role "${ROOM_ROLE}" is reserved for the room's own voice`,
        });
      }
      if (seen.has(role)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'REST role names must be unique within the room',
        });
      }
      seen.add(role);
    }
  }),
  anonymous: z.boolean(),
  quiet_membership: z.boolean(),
  membership_epoch: z.number().int().nonnegative().safe(),
  seats: z.array(SeatSchema),
}).strict().superRefine((room, context) => {
  refineRoomLineage(room, context);
  const byParticipant = new Map<string, z.infer<typeof SeatSchema>>();
  const activeAliases = new Set<string>();
  const authorizedCids = new Set<string>();
  for (const [index, seat] of room.seats.entries()) {
    if (byParticipant.has(seat.participant_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seats', index, 'participant_id'],
        message: 'participant_id must be unique within the room',
      });
    }
    byParticipant.set(seat.participant_id, seat);
    if (seat.state === 'pending' || seat.state === 'active') {
      if (authorizedCids.has(seat.identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['seats', index, 'identity'],
          message: 'at most one pending or active seat may exist per CID',
        });
      }
      authorizedCids.add(seat.identity);
    }
    if (room.anonymous && seat.alias === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seats', index, 'alias'],
        message: 'anonymous rooms require an alias on every seat',
      });
    }
    if (!room.anonymous && seat.alias !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seats', index, 'alias'],
        message: 'aliases are reserved for anonymous rooms',
      });
    }
    if (seat.state === 'active' && seat.alias !== undefined) {
      if (activeAliases.has(seat.alias)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['seats', index, 'alias'],
          message: 'active seats must hold distinct aliases',
        });
      }
      activeAliases.add(seat.alias);
    }
    if (seat.removed_epoch !== undefined && seat.removed_epoch > room.membership_epoch) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seats', index, 'removed_epoch'],
        message: 'removed_epoch cannot exceed the room membership_epoch',
      });
    }
  }
  for (const [index, seat] of room.seats.entries()) {
    if (seat.replaces_seat === undefined) continue;
    const predecessor = byParticipant.get(seat.replaces_seat);
    if (!predecessor || predecessor === seat || predecessor.state !== 'removed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seats', index, 'replaces_seat'],
        message: 'replaces_seat must reference a removed seat in this room',
      });
      continue;
    }
    if (predecessor.role !== seat.role) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seats', index, 'role'],
        message: 'a replacement seat must inherit the predecessor role',
      });
    }
    if (room.anonymous && seat.alias !== predecessor.alias) {
      // The alias binds to the seat/role lineage.
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seats', index, 'alias'],
        message: 'an anonymous replacement seat must inherit the predecessor alias',
      });
    }
  }
});

/** Deterministic display name for metadata created before room_name existed. */
export function defaultRoomName(roomId: string): string {
  return `Room ${LowerCrockfordUlidSchema.parse(roomId).slice(0, 8)}`;
}

/**
 * room_name and rest_roles were added additively to metadata v2. Accept an
 * otherwise-valid room missing either one long enough for the default to apply.
 *
 * TRAP: each default is injected independently. A single guard on the first
 * field would skip the second on every room that already carries the first —
 * i.e. every already-named room would load without rest_roles.
 */
export const RoomSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null) return value;
  const patch: Record<string, unknown> = {};
  if (!Object.hasOwn(value, 'room_name')) {
    const roomId = (value as { room_id?: unknown }).room_id;
    if (typeof roomId === 'string' && LowerCrockfordUlidSchema.safeParse(roomId).success) {
      patch.room_name = defaultRoomName(roomId);
    }
  }
  if (!Object.hasOwn(value, 'rest_roles')) patch.rest_roles = [];
  if (Object.keys(patch).length === 0) return value;
  return { ...value, ...patch };
}, CurrentRoomSchema);

/** Additive v1 → v2 mapping. Existing rooms keep their exact behavior. */
export function migrateRoomV1(
  room: z.infer<typeof RoomV1Schema>,
  mintParticipantId: () => string,
): z.infer<typeof RoomSchema> {
  return RoomSchema.parse({
    ...room,
    version: 2,
    mission: { ...room.mission, briefing_version: 1 },
    role_briefings: {},
    rest_roles: [],
    anonymous: false,
    quiet_membership: false,
    membership_epoch: 0,
    seats: room.seats.map((seat) => ({
      ...seat,
      participant_id: LowerCrockfordUlidSchema.parse(mintParticipantId()),
      state: 'active',
    })),
  });
}

/** Caller-controlled room creation fields. Identity and authorship are host-owned. */
export const CreateRoomInputSchema = z.object({
  name: RoomNameSchema.optional(),
  goal: MissionTextSchema,
  briefing: MissionTextSchema,
  anonymous: z.boolean().optional(),
  quiet_membership: z.boolean().optional(),
}).strict();

export const UpdateRoomInputSchema = z.object({
  name: RoomNameSchema.optional(),
  goal: MissionTextSchema.optional(),
  briefing: MissionTextSchema.optional(),
  status: NonEmptyStringSchema.optional(),
  quiet_membership: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0, 'at least one setting is required');

export const RoleBriefingSetInputSchema = z.object({
  role: RoleSchema,
  text: MissionTextSchema,
}).strict();

export const RoleBriefingDeleteInputSchema = z.object({
  role: RoleSchema,
}).strict();

/** Caller-controlled operator message fields. The service assigns room authorship. */
export const PostMessageInputSchema = z.object({
  text: MessageTextSchema,
}).strict();

/**
 * Caller-controlled role-authored message fields. `role` is the only
 * authorship input a caller may supply; `identity` and `display_name` stay
 * host-owned. Strict for the same reason PostMessageInputSchema is: the caller's
 * object is parsed in full before any host-owned field is consulted, so every
 * author-like spelling is rejected rather than ignored.
 */
export const PostAsRoleInputSchema = z.object({
  role: RoleSchema,
  text: MessageTextSchema,
}).strict();

/** Register or unregister one REST-addressable role. */
export const RestRoleInputSchema = z.object({
  role: RoleSchema,
}).strict();

export const ContainerIdSchema = z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 64-character hexadecimal CID')
  .transform((value) => value.toUpperCase());

export const AcceptExternalInviteInputSchema = z.object({
  role: RoleSchema,
  invite: z.string().refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_EXTERNAL_INVITE_BYTES,
    `invite input must be at most ${MAX_EXTERNAL_INVITE_BYTES} UTF-8 bytes`,
  ),
  expected_cid: ContainerIdSchema.optional(),
  replaces_seat: LowerCrockfordUlidSchema.optional(),
}).strict();

export const AuthorSnapshotSchema = z.object({
  identity: NonEmptyStringSchema,
  display_name: NonEmptyStringSchema,
  role: RoleSchema,
}).strict();

const RecordCommonShape = {
  version: z.literal(1),
  room_id: LowerCrockfordUlidSchema,
  seq: PositiveSafeIntegerSchema,
  record_id: NonEmptyStringSchema,
  at: Rfc3339Schema,
} as const;

const AppendCommonShape = {
  version: z.literal(1),
  room_id: LowerCrockfordUlidSchema,
  at: Rfc3339Schema,
} as const;

export const MembershipNoticeSchema = z.object({
  action: z.enum(['remove']),
  alias: NonEmptyStringSchema.optional(),
  role: RoleSchema.optional(),
  epoch: z.number().int().nonnegative().safe(),
}).strict();

/**
 * Archived alongside the real author snapshot in anonymous rooms:
 * the operator keeps both, the relay uses only this room-scoped pseudonym.
 */
export const AuthorAliasSchema = z.object({
  participant_id: LowerCrockfordUlidSchema,
  alias: NonEmptyStringSchema,
}).strict();

export const ReplyReferenceSchema = z.object({
  wire_id: NonEmptyStringSchema,
  sentence: PositiveSafeIntegerSchema.optional(),
}).strict();

const MessageShape = {
  kind: z.literal('message'),
  message_id: LowerCrockfordUlidSchema,
  author: AuthorSnapshotSchema,
  author_alias: AuthorAliasSchema.optional(),
  category: z.enum(['briefing', 'role_briefing', 'chat', 'membership']),
  briefing_role: RoleSchema.optional(),
  briefing_version: PositiveSafeIntegerSchema.optional(),
  membership: MembershipNoticeSchema.optional(),
  text: MessageTextSchema,
  recipient_identities: z.array(NonEmptyStringSchema).superRefine((identities, context) => {
    const seen = new Set<string>();
    for (const [index, identity] of identities.entries()) {
      if (seen.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'recipient identities must be unique',
        });
      }
      seen.add(identity);
    }
  }),
  source_msg_id: z.number().int().nonnegative().safe().optional(),
  source_wire_id: NonEmptyStringSchema.optional(),
  source_reply_to: ReplyReferenceSchema.optional(),
} as const;

const RelayIntentShape = {
  kind: z.literal('relay_intent'),
  message_id: LowerCrockfordUlidSchema.optional(),
  file_id: LowerCrockfordUlidSchema.optional(),
  recipient_identity: NonEmptyStringSchema,
} as const;

/** A relay intent may terminate without a send when its seat was removed. */
export const RelayResultStatusSchema = z.enum(['queued', 'send_failed', 'skipped_removed']);

const RelayResultShape = {
  kind: z.literal('relay_result'),
  intent_record_id: NonEmptyStringSchema,
  message_id: LowerCrockfordUlidSchema.optional(),
  file_id: LowerCrockfordUlidSchema.optional(),
  recipient_identity: NonEmptyStringSchema,
  status: RelayResultStatusSchema,
  wire_id: NonEmptyStringSchema.optional(),
  metadata_wire_id: NonEmptyStringSchema.optional(),
} as const;

const FileShape = {
  kind: z.literal('file'),
  file_id: LowerCrockfordUlidSchema,
  author: AuthorSnapshotSchema,
  author_alias: AuthorAliasSchema.optional(),
  filename: FileNameSchema,
  mime: FileMimeSchema,
  size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  data_base64: z.string(),
  recipient_identities: z.array(NonEmptyStringSchema).superRefine((identities, context) => {
    const seen = new Set<string>();
    for (const [index, identity] of identities.entries()) {
      if (seen.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'recipient identities must be unique',
        });
      }
      seen.add(identity);
    }
  }),
  source_file_id: z.number().int().nonnegative().safe(),
  source_wire_id: NonEmptyStringSchema.optional(),
  source_reply_to: ReplyReferenceSchema.optional(),
} as const;

const MembershipIntentShape = {
  kind: z.literal('membership_intent'),
  action: z.enum(['remove']),
  participant_id: LowerCrockfordUlidSchema,
  recipient_identity: NonEmptyStringSchema,
  role: RoleSchema,
  alias: NonEmptyStringSchema.optional(),
  epoch: PositiveSafeIntegerSchema,
  notify: z.boolean(),
} as const;

const MembershipResultShape = {
  kind: z.literal('membership_result'),
  intent_record_id: NonEmptyStringSchema,
  participant_id: LowerCrockfordUlidSchema,
  status: RelayStatusSchema,
  notified: z.boolean(),
  key_material_retained: z.literal(true),
  uncertain_after_restart: z.literal(true).optional(),
} as const;

const CloseNoticeIntentShape = {
  kind: z.literal('close_notice_intent'),
  recipient_identity: NonEmptyStringSchema,
} as const;

const CloseNoticeResultShape = {
  kind: z.literal('close_notice_result'),
  intent_record_id: NonEmptyStringSchema,
  recipient_identity: NonEmptyStringSchema,
  status: RelayStatusSchema,
  notified: z.boolean(),
  key_material_retained: z.literal(true),
  uncertain_after_restart: z.literal(true).optional(),
} as const;

export const MessageRecordSchema = z.object({ ...RecordCommonShape, ...MessageShape }).strict();
export const FileRecordSchema = z.object({ ...RecordCommonShape, ...FileShape }).strict();
export const RelayIntentRecordSchema = z.object({ ...RecordCommonShape, ...RelayIntentShape }).strict();
export const RelayResultRecordSchema = z.object({ ...RecordCommonShape, ...RelayResultShape }).strict();
export const MembershipIntentRecordSchema = z.object({ ...RecordCommonShape, ...MembershipIntentShape }).strict();
export const MembershipResultRecordSchema = z.object({ ...RecordCommonShape, ...MembershipResultShape }).strict();
export const CloseNoticeIntentRecordSchema = z.object({ ...RecordCommonShape, ...CloseNoticeIntentShape }).strict();
export const CloseNoticeResultRecordSchema = z.object({ ...RecordCommonShape, ...CloseNoticeResultShape }).strict();

const RawCommunicationRecordSchema = z.discriminatedUnion('kind', [
  MessageRecordSchema,
  FileRecordSchema,
  RelayIntentRecordSchema,
  RelayResultRecordSchema,
  MembershipIntentRecordSchema,
  MembershipResultRecordSchema,
  CloseNoticeIntentRecordSchema,
  CloseNoticeResultRecordSchema,
]);

interface MessageCategoryView {
  category: 'briefing' | 'role_briefing' | 'chat' | 'membership';
  briefing_role?: string;
  briefing_version?: number;
  membership?: z.infer<typeof MembershipNoticeSchema>;
}

function refineRelaySubject(
  record: { kind: string; message_id?: string; file_id?: string },
  context: z.RefinementCtx,
): void {
  if (record.kind !== 'relay_intent' && record.kind !== 'relay_result') return;
  if ((record.message_id === undefined) === (record.file_id === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['message_id'],
      message: 'relay records require exactly one of message_id or file_id',
    });
  }
}

function refineFileRecord(
  record: { kind: string; data_base64?: string; size?: number; sha256?: string },
  context: z.RefinementCtx,
): void {
  if (record.kind !== 'file' || record.data_base64 === undefined) return;
  const bytes = Buffer.from(record.data_base64, 'base64');
  if (bytes.toString('base64') !== record.data_base64) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['data_base64'], message: 'file bytes must use canonical base64' });
  }
  if (bytes.length !== record.size) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['size'], message: 'file size must match decoded bytes' });
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== record.sha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sha256'], message: 'file sha256 must match decoded bytes' });
  }
}

function refineMessageCategory(message: MessageCategoryView, context: z.RefinementCtx): void {
  const requires = (field: 'briefing_role' | 'briefing_version' | 'membership', present: boolean): void => {
    if (present && message[field] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${message.category} messages require ${field}`,
      });
    }
    if (!present && message[field] !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is forbidden on ${message.category} messages`,
      });
    }
  };
  requires('briefing_role', message.category === 'role_briefing');
  requires('membership', message.category === 'membership');
  if (message.category === 'role_briefing' && message.briefing_version === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['briefing_version'],
      message: 'role_briefing messages require briefing_version',
    });
  }
  // Common briefings may carry briefing_version (absent on pre-evolution records).
  if (message.category === 'chat' || message.category === 'membership') {
    if (message.briefing_version !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['briefing_version'],
        message: `briefing_version is forbidden on ${message.category} messages`,
      });
    }
  }
}

export const CommunicationRecordSchema = RawCommunicationRecordSchema.superRefine((record, context) => {
  if (record.record_id !== `${record.room_id}:${record.seq}`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['record_id'],
      message: 'record_id must equal room_id + ":" + seq',
    });
  }
  if (record.kind === 'message') refineMessageCategory(record, context);
  refineRelaySubject(record, context);
  refineFileRecord(record, context);
});

export const AppendRecordSchema = z.discriminatedUnion('kind', [
  z.object({ ...AppendCommonShape, ...MessageShape }).strict(),
  z.object({ ...AppendCommonShape, ...FileShape }).strict(),
  z.object({ ...AppendCommonShape, ...RelayIntentShape }).strict(),
  z.object({ ...AppendCommonShape, ...RelayResultShape }).strict(),
  z.object({ ...AppendCommonShape, ...MembershipIntentShape }).strict(),
  z.object({ ...AppendCommonShape, ...MembershipResultShape }).strict(),
  z.object({ ...AppendCommonShape, ...CloseNoticeIntentShape }).strict(),
  z.object({ ...AppendCommonShape, ...CloseNoticeResultShape }).strict(),
]).superRefine((record, context) => {
  if (record.kind === 'message') refineMessageCategory(record, context);
  refineRelaySubject(record, context);
  refineFileRecord(record, context);
});

export type RoomState = z.infer<typeof RoomStateSchema>;
export type SeatState = z.infer<typeof SeatStateSchema>;
export type InviteMode = z.infer<typeof InviteModeSchema>;
export type RelayStatus = z.infer<typeof RelayStatusSchema>;
export type Seat = z.infer<typeof SeatSchema>;
export type RoomInvite = z.infer<typeof RoomInviteSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type RoomV1 = z.infer<typeof RoomV1Schema>;
export type RoleBriefing = z.infer<typeof RoleBriefingSchema>;
export type MembershipNotice = z.infer<typeof MembershipNoticeSchema>;
export type AuthorSnapshot = z.infer<typeof AuthorSnapshotSchema>;
export type CommunicationRecord = z.infer<typeof CommunicationRecordSchema>;
export type AppendRecord = z.infer<typeof AppendRecordSchema>;
