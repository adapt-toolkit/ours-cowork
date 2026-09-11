import type { CommunicationRecord } from './contracts.ts';
import type { CoworkStore } from './storage.ts';

export type Item = Extract<CommunicationRecord, { kind: 'message' | 'file' }>;
type Intent = Extract<CommunicationRecord, { kind: 'relay_intent' }>;
type Result = Extract<CommunicationRecord, { kind: 'relay_result' }>;
export type Row = Item | Intent | Result;
export type LogicalParent = { key: string; item: Item };
export type ParentResolution =
  | { state: 'none' }
  | { state: 'unknown_parent' | 'ambiguous_parent' }
  | { state: 'resolved'; parent: LogicalParent };
export type ReplyDecision = {
  state: 'none' | 'unknown_parent' | 'ambiguous_parent' | 'missing_copy' | 'linked';
  parentKey?: string;
  replyTo?: { wire_id: string };
};
const key = (r: { message_id?: string; file_id?: string }): string | undefined =>
  (r.message_id === undefined) === (r.file_id === undefined) ? undefined :
    r.message_id === undefined ? `file:${r.file_id}` : `message:${r.message_id}`;
const nonempty = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

function buildAliasIndex(rows: readonly Row[], roomId: string) {
  const local = rows.filter(r => r.room_id === roomId);
  const items = local.filter((r): r is Item => r.kind === 'message' || r.kind === 'file');
  const intents = local.filter((r): r is Intent => r.kind === 'relay_intent');
  const results = local.filter((r): r is Result => r.kind === 'relay_result');
  const copies = (parent: Item, cid: string): Result[] => results.filter(result => {
    if (result.status !== 'queued' || result.recipient_identity !== cid
      || key(result) !== key(parent) || !parent.recipient_identities.includes(cid)) return false;
    const matches = intents.filter(intent => intent.record_id === result.intent_record_id);
    if (matches.length !== 1) return false;
    const intent = matches[0]!;
    return key(intent) === key(parent) && intent.recipient_identity === cid
      && parent.seq < intent.seq && intent.seq < result.seq;
  }).sort((a, b) => a.seq - b.seq);
  const wires = (result: Result, parent: Item): string[] =>
    [result.wire_id, ...(parent.kind === 'file' ? [result.metadata_wire_id] : [])].filter(nonempty);
  const ownersFor = (wireId: string, cid: string): Item[] => items.filter(item => (
    (item.author.identity === cid && item.source_wire_id === wireId)
    || copies(item, cid).some(result => wires(result, item).includes(wireId))
  ));
  return { items, copies, wires, ownersFor };
}

// Call under the existing room mutex. Continue until an empty page.
export async function readReplyRows(
  store: Pick<CoworkStore, 'read'>, roomId: string,
): Promise<Row[]> {
  const rows: Row[] = [];
  let after = 0;
  for (;;) {
    const page = await store.read(roomId, { after, limit: 64 });
    if (page.length === 0) return rows;
    const last = page[page.length - 1]!;
    if (last.seq <= after) throw new Error('reply archive cursor did not advance');
    for (const r of page) {
      if (r.room_id !== roomId) throw new Error('reply archive room mismatch');
      if (r.kind === 'message') rows.push({ ...r, text: '' });
      else if (r.kind === 'file') rows.push({ ...r, data_base64: '' });
      else if (r.kind === 'relay_intent' || r.kind === 'relay_result') rows.push(r);
    }
    after = last.seq;
  }
}

export function resolveReplyParent(
  rows: readonly Row[], roomId: string, senderCid: string,
  wireId: string | undefined, beforeSeq: number,
): ParentResolution {
  if (wireId === undefined) return { state: 'none' };
  if (!nonempty(wireId)) return { state: 'unknown_parent' };
  const index = buildAliasIndex(rows, roomId);
  const candidates = index.ownersFor(wireId, senderCid);
  if (candidates.length === 0) return { state: 'unknown_parent' };
  if (candidates.length !== 1) return { state: 'ambiguous_parent' };
  const parent = candidates[0]!;
  if (parent.seq >= beforeSeq) return { state: 'unknown_parent' };
  const parentKey = key(parent)!;
  if (index.items.filter(item => key(item) === parentKey).length !== 1) {
    return { state: 'ambiguous_parent' };
  }
  return { state: 'resolved', parent: { key: parentKey, item: parent } };
}

export function mapReplyParent(
  rows: readonly Row[], roomId: string, logicalParent: LogicalParent,
  recipientCid: string,
): ReplyDecision {
  const index = buildAliasIndex(rows, roomId);
  if (logicalParent.item.room_id !== roomId || key(logicalParent.item) !== logicalParent.key) {
    return { state: 'ambiguous_parent', parentKey: logicalParent.key };
  }
  const matches = index.items.filter(item => key(item) === logicalParent.key);
  if (matches.length !== 1) {
    return { state: 'ambiguous_parent', parentKey: logicalParent.key };
  }
  const parent = matches[0]!;
  const recipientCopies = index.copies(parent, recipientCid);
  const sourceWire = parent.author.identity === recipientCid && nonempty(parent.source_wire_id)
    ? parent.source_wire_id : undefined;
  const sourceOwners = sourceWire === undefined ? [] : index.ownersFor(sourceWire, recipientCid);
  const wireId = sourceOwners.length === 1 && key(sourceOwners[0]!) === logicalParent.key
    ? sourceWire
    : recipientCopies.map(copy => index.wires(copy, parent)[0]).find(nonempty);
  if (!nonempty(wireId)) return { state: 'missing_copy', parentKey: logicalParent.key };
  const owners = index.ownersFor(wireId, recipientCid);
  if (owners.length !== 1 || key(owners[0]!) !== logicalParent.key) {
    return { state: 'ambiguous_parent', parentKey: logicalParent.key };
  }
  return { state: 'linked', parentKey: logicalParent.key, replyTo: { wire_id: wireId } };
}

export function selectReply(
  rows: readonly Row[], roomId: string, child: Item, recipientCid: string,
): ReplyDecision {
  if (child.room_id !== roomId) throw new Error('reply child room mismatch');
  const resolution = resolveReplyParent(
    rows, roomId, child.author.identity, child.source_reply_to?.wire_id, child.seq,
  );
  if (resolution.state !== 'resolved') return resolution;
  return mapReplyParent(rows, roomId, resolution.parent, recipientCid);
}
