import { createHash } from 'node:crypto';

import type { FileInboxItem, InboxItem } from './packets.ts';
import { resolveReplyParent, type Item, type ParentResolution, type Row } from './reply-threading.ts';

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

/** Match the selected participant incarnation, even when its CID has rejoined. */
export function threadRelayEligible(room: Room, root: ThreadRoot, cid: string): boolean {
  return activeThreadSeat(room, root, cid) !== undefined;
}

/** Project a saved scoped author without falling back to a real anonymous identity. */
export function publicThreadAuthor(
  message: Pick<MessageRecord, 'author' | 'author_alias'>,
  root: ThreadRoot,
  room: Pick<Room, 'anonymous'>,
): MessageRecord['author'] {
  const member = root.members.find(member => member.identity === message.author.identity);
  if (!member) throw new ThreadFailure('reply_target_unavailable');
  if (!room.anonymous) return message.author;
  const alias = AuthorAliasSchema.safeParse(message.author_alias);
  if (!alias.success || alias.data.participant_id !== member.participant_id) {
    throw new ThreadFailure('reply_target_unavailable');
  }
  return { identity: alias.data.participant_id, display_name: alias.data.alias, role: message.author.role };
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
  const parsedAlias = AuthorAliasSchema.safeParse(root.author_alias);
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
      && (!parsedAlias.success || parsedAlias.data.participant_id !== parsedRoot.data.creator_participant_id))
    || root.source_msg_id !== undefined
    || root.source_wire_id !== undefined
    || root.source_reply_to !== undefined) {
    throw new ThreadFailure('reply_target_unavailable');
  }
  return root;
}

type ThreadAssociation =
  | { state: 'ordinary' }
  | { state: 'scoped'; root: MessageRecord & { thread_root: ThreadRoot }; scope: ThreadScope };

/**
 * Classify saved routing evidence, never message text. Walk native ancestry in each
 * saved author's namespace, then validate every association from oldest to newest.
 * Missing legacy targets remain ordinary; proven private ancestry cannot lose scope.
 * Iteration and strictly decreasing sequence numbers bound corrupt/cyclic archives.
 */
export function classifyThreadAssociation(
  room: Pick<Room, 'room_id' | 'anonymous'>, rows: readonly Row[], source: Item,
): ThreadAssociation {
  const chain: { item: Item; resolved: ParentResolution }[] = [];
  const seen = new Set<string>();
  let item = source;
  for (;;) {
    const key = item.kind === 'message' ? `message:${item.message_id}` : `file:${item.file_id}`;
    if (item.room_id !== room.room_id || seen.has(key) || chain.length > rows.length) {
      throw new ThreadFailure('reply_target_unavailable');
    }
    seen.add(key);
    const resolved = resolveReplyParent(rows, room.room_id, item.author.identity,
      item.source_reply_to?.wire_id, item.seq);
    chain.push({ item, resolved });
    if (resolved.state !== 'resolved') break;
    if (resolved.parent.item.seq >= item.seq) throw new ThreadFailure('reply_target_unavailable');
    item = resolved.parent.item;
  }
  let association: ThreadAssociation = { state: 'ordinary' };
  for (const { item, resolved } of chain.reverse()) {
    const declared = item.kind === 'message' && (item.scope !== undefined || item.thread_root !== undefined);
    if (!declared && association.state === 'ordinary') continue;
    const scope = ThreadScopeSchema.safeParse(item.kind === 'message' ? item.scope : undefined);
    if (item.kind !== 'message' || !scope.success || item.category !== 'chat'
      || rows.filter(row => row.room_id === room.room_id && row.kind === 'message'
        && row.message_id === item.message_id).length !== 1) {
      throw new ThreadFailure('reply_target_unavailable');
    }
    const root = findThreadRoot(rows.filter(row => row.room_id === room.room_id), scope.data.thread_id);
    if (!root?.thread_root) throw new ThreadFailure('reply_target_unavailable');
    publicThreadMetadata({ ...root, thread_root: root.thread_root }, room);
    publicThreadAuthor(item, root.thread_root, room);
    if (item.message_id !== root.message_id) {
      if (item.thread_root !== undefined || root.seq >= item.seq
        || resolved.state !== 'resolved' || scope.data.parent_key !== resolved.parent.key
        || association.state !== 'scoped' || association.root.message_id !== root.message_id) {
        throw new ThreadFailure('reply_target_unavailable');
      }
    }
    association = { state: 'scoped', root: { ...root, thread_root: root.thread_root }, scope: scope.data };
  }
  return association;
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
  const association = classifyThreadAssociation(room, rows, resolved.parent.item);
  if (association.state === 'ordinary') return ordinary();
  const { root } = association;
  if (!activeThreadSeat(room, root.thread_root, item.sender_id)) {
    throw new ThreadFailure('reply_target_unavailable');
  }
  if ('file_id' in item) throw new ThreadFailure('thread_files_unsupported');
  return {
    recipients: root.thread_root.members.filter(member => member.identity !== item.sender_id
      && activeThreadSeat(room, root.thread_root!, member.identity) !== undefined).map(member => member.identity),
    scope: { thread_id: root.message_id, parent_key: resolved.parent.key },
  };
}
