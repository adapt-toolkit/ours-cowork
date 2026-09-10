import { z } from 'zod';

const ParticipantIdSchema = z.string().regex(
  /^[0-7][0-9a-hjkmnp-tv-z]{25}$/,
  'must be a 26-character lowercase Crockford ULID',
);
const ContainerIdSchema = z.string()
  .regex(/^[0-9a-f]{64}$/i, 'must be a 64-character hexadecimal CID')
  .transform((value) => value.toUpperCase());
const TopicTextSchema = z.string()
  .refine(
    (value) => Array.from(value).length >= 1
      && Array.from(value).length <= 120
      && value.trim().length > 0
      && !/[\p{Cc}\p{Cf}]/u.test(value),
    'topic must contain 1-120 Unicode characters without control or format characters',
  );
const InputTopicSchema = TopicTextSchema.transform((value) => value.trim());
const StoredTopicSchema = TopicTextSchema.refine(
  (value) => value === value.trim(),
  'stored topic must already be trimmed',
);
const IdempotencyKeySchema = z.string().regex(
  /^[A-Za-z0-9._:-]{1,128}$/,
  'must contain 1-128 portable idempotency-key characters',
);

export const ThreadMemberSchema = z.object({
  participant_id: ParticipantIdSchema,
  identity: ContainerIdSchema,
}).strict();

export const ThreadRootSchema = z.object({
  schema_version: z.literal(1),
  thread_id: ParticipantIdSchema,
  topic: StoredTopicSchema,
  creator_participant_id: ParticipantIdSchema,
  members: z.array(ThreadMemberSchema).min(1),
  idempotency_key: IdempotencyKeySchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 digest'),
}).strict().superRefine((root, context) => {
  const participantIds = new Set<string>();
  const identities = new Set<string>();
  for (const [index, member] of root.members.entries()) {
    if (participantIds.has(member.participant_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['members', index, 'participant_id'],
        message: 'thread member participant IDs must be unique',
      });
    }
    participantIds.add(member.participant_id);
    if (identities.has(member.identity)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['members', index, 'identity'],
        message: 'thread member identities must be unique',
      });
    }
    identities.add(member.identity);
  }
  if (!participantIds.has(root.creator_participant_id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['creator_participant_id'],
      message: 'thread creator must be a member',
    });
  }
});

export const ThreadScopeSchema = z.object({
  thread_id: ParticipantIdSchema,
  parent_key: z.string().regex(
    /^(?:message|file):[0-7][0-9a-hjkmnp-tv-z]{25}$/,
    'must identify an immediate message or file parent',
  ).optional(),
}).strict();

export const StartThreadInputSchema = z.object({
  topic: InputTopicSchema,
  participant_ids: z.array(ParticipantIdSchema).min(1),
  idempotency_key: IdempotencyKeySchema,
}).strict();

export type ThreadMember = z.infer<typeof ThreadMemberSchema>;
export type ThreadRoot = z.infer<typeof ThreadRootSchema>;
export type ThreadScope = z.infer<typeof ThreadScopeSchema>;
export type StartThreadInput = z.infer<typeof StartThreadInputSchema>;

export type ThreadError =
  | 'invalid_request'
  | 'invalid_members'
  | 'unauthorized'
  | 'idempotency_conflict'
  | 'reply_target_unavailable'
  | 'thread_files_unsupported';

export class ThreadFailure extends Error {
  constructor(readonly code: ThreadError) {
    super(code);
    this.name = 'ThreadFailure';
  }
}
