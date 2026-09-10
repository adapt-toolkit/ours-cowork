import { createHash } from 'node:crypto';

import type { FileInboxItem, InboxItem } from './packets.ts';
import { resolveReplyParent, type Row } from './reply-threading.ts';

import { AuthorAliasSchema, type CommunicationRecord, type Room, type Seat } from './contracts.ts';
import {
  ThreadFailure,
  ThreadRootSchema,
  ThreadScopeSchema,
  type StartThreadInput,
  type ThreadMember,
  type ThreadRoot,
  type ThreadScope,
} from './thread-contracts.ts';

type MessageRecord = Extract<CommunicationRecord, { kind: 'message' }>;

export interface PublicThreadMetadata {
  schema_version: 1;
  thread_id: string;
  topic: string;
  creator: { identity: string; display_name: string; role: string };
  participant_ids: string[];
  created_at: string;
}

export function publicThreadMetadata(
  root: Pick<MessageRecord, 'at' | 'author' | 'author_alias' | 'message_id' | 'scope'>
    & { thread_root: ThreadRoot },
  room: Pick<Room, 'anonymous'>,
): PublicThreadMetadata {
  let creator: PublicThreadMetadata['creator'];
  if (room.anonymous) {
    const alias = AuthorAliasSchema.safeParse(root.author_alias);
    if (!alias.success
      || alias.data.participant_id !== root.thread_root.creator_participant_id) {
      throw new ThreadFailure('reply_target_unavailable');
    }
    creator = {
      identity: alias.data.participant_id,
      display_name: alias.data.alias,
      role: root.author.role,
    };
  } else {
    creator = {
      identity: root.author.identity,
      display_name: root.author.display_name,
      role: root.author.role,
    };
  }
  return {
    schema_version: 1,
    thread_id: root.thread_root.thread_id,
    topic: root.thread_root.topic,
    creator,
    participant_ids: root.thread_root.members.map((member) => member.participant_id),
    created_at: root.at,
  };
}

export function selectThreadMembers(
  room: Room,
  cid: string,
  input: StartThreadInput,
): ThreadMember[] {
  const selected = new Set(input.participant_ids);
  const active = room.seats.filter((seat) => seat.state === 'active');
  const creator = active.find((seat) => seat.identity === cid);
  if (creator === undefined
    || selected.size === 0
    || selected.size !== input.participant_ids.length
    || selected.size > active.length
    || !selected.has(creator.participant_id)) {
    throw new ThreadFailure('invalid_members');
  }
  const members = active.filter((seat) => selected.has(seat.participant_id));
  if (members.length !== selected.size) throw new ThreadFailure('invalid_members');
  return members
    .map(({ participant_id, identity }) => ({ participant_id, identity }))
    .sort((left, right) => left.participant_id.localeCompare(right.participant_id));
}

export function activeThreadSeat(room: Room, root: ThreadRoot, cid: string): Seat | undefined {
  return room.seats.find((seat) => seat.state === 'active'
    && seat.identity === cid
    && root.members.some((member) => member.identity === cid
      && member.participant_id === seat.participant_id));
}

export function threadFingerprint(input: StartThreadInput): string {
  return createHash('sha256').update(JSON.stringify({
    topic: input.topic,
    participant_ids: [...input.participant_ids].sort(),
  })).digest('hex');
}

export function findThreadRoot(
  rows: readonly CommunicationRecord[],
  id: string,
): MessageRecord | undefined {
  const candidates = rows.filter((row): row is MessageRecord => row.kind === 'message' && (
    row.message_id === id
    || row.thread_root?.thread_id === id
    || (row.scope?.thread_id === id && row.scope.parent_key === undefined)
  ));
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1) throw new ThreadFailure('reply_target_unavailable');
  const root = candidates[0]!;
  const parsedRoot = ThreadRootSchema.safeParse(root.thread_root);
  const parsedScope = ThreadScopeSchema.safeParse(root.scope);
  const creator = parsedRoot.success
    ? parsedRoot.data.members.find((member) => member.participant_id === parsedRoot.data.creator_participant_id)
    : undefined;
  if (!parsedRoot.success
    || !parsedScope.success
    || root.message_id !== id
    || parsedRoot.data.thread_id !== id
    || parsedScope.data.thread_id !== id
    || parsedScope.data.parent_key !== undefined
    || root.category !== 'chat'
    || creator?.identity !== root.author.identity
    || (root.author_alias !== undefined
      && root.author_alias.participant_id !== parsedRoot.data.creator_participant_id)
    || root.source_msg_id !== undefined
    || root.source_wire_id !== undefined
    || root.source_reply_to !== undefined) {
    throw new ThreadFailure('reply_target_unavailable');
  }
  return root;
}

/** Authorize the authenticated sender's explicit target before any source append. */
export function resolveIntakeScope(
  room: Room, rows: readonly Row[], item: InboxItem | FileInboxItem, beforeSeq: number,
): { recipients: string[]; scope?: ThreadScope } {
  const ordinary = () => ({ recipients: [...new Set(room.seats
    .filter(seat => seat.state === 'active' && seat.identity !== item.sender_id)
    .map(seat => seat.identity))] });
  if (item.reply_to == null) return ordinary();
  const reply = item.reply_to;
  if (typeof reply.wire_id !== 'string' || reply.wire_id.length === 0 || reply.wire_id.length > 256
    || (reply.sentence !== undefined && (!Number.isSafeInteger(reply.sentence) || reply.sentence < 1))
    || room.state !== 'active' || room.lifecycle_request?.state === 'pending'
    || !room.seats.some(seat => seat.identity === item.sender_id && seat.state === 'active')) {
    throw new ThreadFailure('reply_target_unavailable');
  }
  const resolved = resolveReplyParent(rows, room.room_id, item.sender_id, reply.wire_id, beforeSeq);
  if (resolved.state !== 'resolved') throw new ThreadFailure('reply_target_unavailable');
  const parent = resolved.parent.item;
  if (parent.kind === 'file' || (parent.scope === undefined && parent.thread_root === undefined)) return ordinary();
  const scope = ThreadScopeSchema.safeParse(parent.scope);
  if (!scope.success) throw new ThreadFailure('reply_target_unavailable');
  const root = findThreadRoot(rows, scope.data.thread_id);
  if (!root?.thread_root || !activeThreadSeat(room, root.thread_root, item.sender_id)) {
    throw new ThreadFailure('reply_target_unavailable');
  }
  if ('file_id' in item) throw new ThreadFailure('thread_files_unsupported');
  return {
    recipients: root.thread_root.members.filter(member => member.identity !== item.sender_id
      && activeThreadSeat(room, root.thread_root!, member.identity) !== undefined).map(member => member.identity),
    scope: { thread_id: root.message_id, parent_key: resolved.parent.key },
  };
}
