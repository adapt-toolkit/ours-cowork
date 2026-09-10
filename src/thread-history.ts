import { z } from 'zod';
import {
  AuthorAliasSchema, AuthorSnapshotSchema, LowerCrockfordUlidSchema, MAX_HISTORY_PAGE_BYTES,
  MembershipNoticeSchema, MessageTextSchema, Rfc3339Schema, RoleSchema,
  type CommunicationRecord, type Room,
} from './contracts.ts';
import { resolveReplyParent, type Row } from './reply-threading.ts';
import { ThreadFailure, ThreadScopeSchema } from './thread-contracts.ts';
import { activeThreadSeat, findThreadRoot, publicThreadAuthor, publicThreadMetadata } from './threads.ts';

const PublicThreadSchema = z.object({ schema_version: z.literal(1), thread_id: LowerCrockfordUlidSchema }).strict();
const PublicThreadMetadataSchema = PublicThreadSchema.extend({
  topic: z.string(), creator: AuthorSnapshotSchema,
  participant_ids: z.array(LowerCrockfordUlidSchema), created_at: Rfc3339Schema,
}).strict();
const PublicMessageShape = {
  version: z.literal(1), room_id: LowerCrockfordUlidSchema, seq: z.number().int().positive().safe(),
  record_id: z.string(), at: Rfc3339Schema, kind: z.literal('message'), message_id: LowerCrockfordUlidSchema,
  author: AuthorSnapshotSchema, category: z.enum(['briefing', 'role_briefing', 'chat', 'membership']),
  briefing_role: RoleSchema.optional(), briefing_version: z.number().int().positive().safe().optional(),
  membership: MembershipNoticeSchema.optional(), text: MessageTextSchema,
};

/** Authenticated participant rows use visible-message ordinals, never archive positions. */
export const ParticipantHistoryRecordSchema = z.object({
  ...PublicMessageShape, thread: PublicThreadSchema.optional(), thread_root: PublicThreadMetadataSchema.optional(),
}).strict().superRefine((row, ctx) => {
  const prefix = `${row.room_id}:participant:`;
  const participantId = row.record_id.slice(prefix.length, -(String(row.seq).length + 1));
  if (!row.record_id.startsWith(prefix) || !LowerCrockfordUlidSchema.safeParse(participantId).success
    || row.record_id !== `${prefix}${participantId}:${row.seq}`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['record_id'], message: 'must identify the viewer and visible ordinal' });
  }
  if (row.thread_root && (!row.thread || row.thread.thread_id !== row.thread_root.thread_id
    || row.message_id !== row.thread.thread_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['thread_root'], message: 'must identify this thread root' });
  }
});
export type ParticipantHistoryRecord = z.infer<typeof ParticipantHistoryRecordSchema>;
/** Host-only compatibility projection: alias-redacted messages with global archive cursors. */
export type HostParticipantHistoryRecord = z.infer<z.ZodObject<typeof PublicMessageShape>>;

type MessageRecord = Extract<CommunicationRecord, { kind: 'message' }>;

/** Explicit allowlist shared by public messages and the host's legacy redacted view. */
export function publicHistoryMessage(record: MessageRecord, author = record.author): HostParticipantHistoryRecord {
  return {
    version: 1, room_id: record.room_id, seq: record.seq, record_id: record.record_id, at: record.at,
    kind: 'message', message_id: record.message_id,
    author: { identity: author.identity, display_name: author.display_name, role: author.role },
    category: record.category, text: record.text,
    ...(record.category === 'role_briefing' ? { briefing_role: record.briefing_role } : {}),
    ...((record.category === 'briefing' || record.category === 'role_briefing') && record.briefing_version !== undefined
      ? { briefing_version: record.briefing_version } : {}),
    ...(record.category === 'membership' && record.membership ? { membership: {
      action: record.membership.action, epoch: record.membership.epoch,
      ...(record.membership.alias === undefined ? {} : { alias: record.membership.alias }),
      ...(record.membership.role === undefined ? {} : { role: record.membership.role }),
    } } : {}),
  };
}

export const ParticipantHistoryPageSchema = z.object({
  after: z.number().int().nonnegative().safe().optional(),
  limit: z.number().int().positive().safe().optional(),
}).strict();

/** Caller supplies the complete sequence-ordered archive from bounded reads under the room mutex. */
export function projectParticipantHistory(
  room: Room, records: readonly CommunicationRecord[], viewerCid: string,
  page: { after?: number; limit?: number },
): ParticipantHistoryRecord[] {
  const viewer = room.seats.find(seat => seat.state === 'active' && seat.identity === viewerCid);
  if (!viewer || room.state !== 'active') throw new ThreadFailure('unauthorized');
  const { after = 0, limit = 200 } = ParticipantHistoryPageSchema.parse(page);
  const replyRows = records.filter((row): row is Row => ['message', 'file', 'relay_intent', 'relay_result'].includes(row.kind));
  const output: ParticipantHistoryRecord[] = [];
  let ordinal = 0, bytes = 2;
  for (const record of records) {
    if (record.kind !== 'message' || record.room_id !== room.room_id) continue;
    const resolved = resolveReplyParent(replyRows, room.room_id, record.author.identity,
      record.source_reply_to?.wire_id, record.seq);
    const parent = resolved.state === 'resolved' ? resolved.parent.item : undefined;
    const scoped = record.scope !== undefined || record.thread_root !== undefined
      || (parent?.kind === 'message' && (parent.scope !== undefined || parent.thread_root !== undefined));
    let author = record.author;
    let thread: ParticipantHistoryRecord['thread'];
    let thread_root: ParticipantHistoryRecord['thread_root'];
    try {
      if (scoped) {
        const scope = ThreadScopeSchema.safeParse(record.scope);
        if (!scope.success || record.category !== 'chat') continue;
        const root = findThreadRoot(records, scope.data.thread_id);
        if (!root?.thread_root || !activeThreadSeat(room, root.thread_root, viewerCid)) continue;
        const metadata = publicThreadMetadata({ ...root, thread_root: root.thread_root }, room);
        author = publicThreadAuthor(record, root.thread_root, room);
        if (record.message_id === root.message_id) thread_root = metadata;
        else {
          const parentScope = ThreadScopeSchema.safeParse(parent?.kind === 'message' ? parent.scope : undefined);
          if (record.thread_root !== undefined || root.seq >= record.seq || resolved.state !== 'resolved'
            || scope.data.parent_key !== resolved.parent.key || !parentScope.success
            || parentScope.data.thread_id !== root.message_id) continue;
        }
        thread = { schema_version: 1, thread_id: root.message_id };
      } else if (record.author_alias !== undefined) {
        const alias = AuthorAliasSchema.parse(record.author_alias);
        author = { identity: alias.participant_id, display_name: alias.alias, role: record.author.role };
      }
    } catch (error) {
      if (error instanceof ThreadFailure || error instanceof z.ZodError) continue;
      throw error;
    }
    ordinal += 1;
    if (ordinal <= after) continue;
    const projected: ParticipantHistoryRecord = {
      ...publicHistoryMessage(record, author), seq: ordinal,
      record_id: `${room.room_id}:participant:${viewer.participant_id}:${ordinal}`,
      ...(thread ? { thread } : {}), ...(thread_root ? { thread_root } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(projected), 'utf8') + (output.length ? 1 : 0);
    if (bytes + size > MAX_HISTORY_PAGE_BYTES) {
      if (output.length === 0) throw new RangeError('one participant history record exceeds the page byte contract');
      break;
    }
    output.push(projected); bytes += size;
    if (output.length >= limit) break;
  }
  return output;
}
