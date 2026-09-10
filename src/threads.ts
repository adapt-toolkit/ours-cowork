import { createHash } from 'node:crypto';

import type { CommunicationRecord, Room, Seat } from './contracts.ts';
import {
  ThreadFailure,
  ThreadRootSchema,
  ThreadScopeSchema,
  type StartThreadInput,
  type ThreadMember,
  type ThreadRoot,
} from './thread-contracts.ts';

type MessageRecord = Extract<CommunicationRecord, { kind: 'message' }>;

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
