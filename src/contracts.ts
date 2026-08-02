import { z } from 'zod';

const MAX_TEXT_BYTES = 262_144;
const MAX_ROLE_BYTES = 256;

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
export const Rfc3339Schema = z.string().datetime({ offset: true });
export const RoleSchema = utf8Bounded('role', MAX_ROLE_BYTES);
export const MissionTextSchema = utf8Bounded('mission text', MAX_TEXT_BYTES);
export const MessageTextSchema = utf8Bounded('message text', MAX_TEXT_BYTES);

export const RoomStateSchema = z.enum(['provisioning', 'active', 'closing', 'closed']);
export const InviteModeSchema = z.enum(['one_time', 'public']);
export const InviteStateSchema = z.enum(['live', 'consumed', 'revoked', 'replacement_required']);
export const RelayStatusSchema = z.enum(['queued', 'send_failed']);

export const SeatSchema = z.object({
  identity: NonEmptyStringSchema,
  display_name: NonEmptyStringSchema,
  role: RoleSchema,
  invite_id: NonEmptyStringSchema,
  accepted_at: Rfc3339Schema,
}).strict();

export const RoomInviteSchema = z.object({
  invite_id: NonEmptyStringSchema,
  mode: InviteModeSchema,
  role: RoleSchema,
  min_accepts: PositiveSafeIntegerSchema,
  accepted_cids: z.array(NonEmptyStringSchema),
  state: InviteStateSchema,
  created_at: Rfc3339Schema,
}).strict().superRefine((invite, context) => {
  if (invite.mode === 'one_time' && invite.min_accepts !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['min_accepts'],
      message: 'one_time invites require min_accepts === 1',
    });
  }
});

export const MissionSchema = z.object({
  goal: MissionTextSchema,
  briefing: MissionTextSchema,
}).strict();

export const RoomSchema = z.object({
  version: z.literal(1),
  room_id: LowerCrockfordUlidSchema,
  identity_name: NonEmptyStringSchema,
  identity_cid: NonEmptyStringSchema,
  mission: MissionSchema,
  state: RoomStateSchema,
  status: NonEmptyStringSchema.optional(),
  invites: z.array(RoomInviteSchema),
  seats: z.array(SeatSchema),
  created_at: Rfc3339Schema,
  activated_at: Rfc3339Schema.optional(),
  closed_at: Rfc3339Schema.optional(),
}).strict();

/** Caller-controlled room creation fields. Identity and authorship are host-owned. */
export const CreateRoomInputSchema = z.object({
  goal: MissionTextSchema,
  briefing: MissionTextSchema,
}).strict();

export const UpdateRoomInputSchema = z.object({
  goal: MissionTextSchema.optional(),
  briefing: MissionTextSchema.optional(),
  status: NonEmptyStringSchema.optional(),
}).strict().refine((input) => Object.keys(input).length > 0, 'at least one setting is required');

/** Caller-controlled operator message fields. The service assigns room authorship. */
export const PostMessageInputSchema = z.object({
  text: MessageTextSchema,
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

const MessageShape = {
  kind: z.literal('message'),
  message_id: LowerCrockfordUlidSchema,
  author: AuthorSnapshotSchema,
  category: z.enum(['briefing', 'chat']),
  text: MessageTextSchema,
  source_msg_id: z.number().int().nonnegative().safe().optional(),
  source_wire_id: NonEmptyStringSchema.optional(),
} as const;

const RelayIntentShape = {
  kind: z.literal('relay_intent'),
  message_id: LowerCrockfordUlidSchema,
  recipient_identity: NonEmptyStringSchema,
} as const;

const RelayResultShape = {
  kind: z.literal('relay_result'),
  intent_record_id: NonEmptyStringSchema,
  message_id: LowerCrockfordUlidSchema,
  recipient_identity: NonEmptyStringSchema,
  status: RelayStatusSchema,
  wire_id: NonEmptyStringSchema.optional(),
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
export const RelayIntentRecordSchema = z.object({ ...RecordCommonShape, ...RelayIntentShape }).strict();
export const RelayResultRecordSchema = z.object({ ...RecordCommonShape, ...RelayResultShape }).strict();
export const CloseNoticeIntentRecordSchema = z.object({ ...RecordCommonShape, ...CloseNoticeIntentShape }).strict();
export const CloseNoticeResultRecordSchema = z.object({ ...RecordCommonShape, ...CloseNoticeResultShape }).strict();

const RawCommunicationRecordSchema = z.discriminatedUnion('kind', [
  MessageRecordSchema,
  RelayIntentRecordSchema,
  RelayResultRecordSchema,
  CloseNoticeIntentRecordSchema,
  CloseNoticeResultRecordSchema,
]);

export const CommunicationRecordSchema = RawCommunicationRecordSchema.superRefine((record, context) => {
  if (record.record_id !== `${record.room_id}:${record.seq}`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['record_id'],
      message: 'record_id must equal room_id + ":" + seq',
    });
  }
});

export const AppendRecordSchema = z.discriminatedUnion('kind', [
  z.object({ ...AppendCommonShape, ...MessageShape }).strict(),
  z.object({ ...AppendCommonShape, ...RelayIntentShape }).strict(),
  z.object({ ...AppendCommonShape, ...RelayResultShape }).strict(),
  z.object({ ...AppendCommonShape, ...CloseNoticeIntentShape }).strict(),
  z.object({ ...AppendCommonShape, ...CloseNoticeResultShape }).strict(),
]);

export type RoomState = z.infer<typeof RoomStateSchema>;
export type InviteMode = z.infer<typeof InviteModeSchema>;
export type RelayStatus = z.infer<typeof RelayStatusSchema>;
export type Seat = z.infer<typeof SeatSchema>;
export type RoomInvite = z.infer<typeof RoomInviteSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type AuthorSnapshot = z.infer<typeof AuthorSnapshotSchema>;
export type CommunicationRecord = z.infer<typeof CommunicationRecordSchema>;
export type AppendRecord = z.infer<typeof AppendRecordSchema>;
