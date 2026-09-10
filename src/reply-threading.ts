import type { CommunicationRecord } from './contracts.ts';
import type { CoworkStore } from './storage.ts';

type Item = Extract<CommunicationRecord, { kind: 'message' | 'file' }>;
type Intent = Extract<CommunicationRecord, { kind: 'relay_intent' }>;
type Result = Extract<CommunicationRecord, { kind: 'relay_result' }>;
type Row = Item | Intent | Result;
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

export function selectReply(
  rows: readonly Row[], roomId: string, child: Item, recipientCid: string,
): ReplyDecision {
  if (child.room_id !== roomId) throw new Error('reply child room mismatch');
  const incoming = child.source_reply_to?.wire_id;
  if (!nonempty(incoming)) return { state: 'none' };
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
  const wires = (r: Result, parent: Item): string[] =>
    [r.wire_id, ...(parent.kind === 'file' ? [r.metadata_wire_id] : [])].filter(nonempty);
  const candidates = items.filter(parent => parent.seq < child.seq && (
    (parent.author.identity === child.author.identity && parent.source_wire_id === incoming)
    || copies(parent, child.author.identity).some(result => wires(result, parent).includes(incoming))
  ));
  if (candidates.length === 0) return { state: 'unknown_parent' };
  if (candidates.length !== 1) return { state: 'ambiguous_parent' };
  const parent = candidates[0]!;
  const parentKey = key(parent)!;
  // Duplicate logical source rows are corruption, even if only one matched this wire.
  if (items.filter(item => key(item) === parentKey).length !== 1) {
    return { state: 'ambiguous_parent' };
  }
  const recipientCopies = copies(parent, recipientCid);
  const wireId = parent.author.identity === recipientCid && nonempty(parent.source_wire_id)
    ? parent.source_wire_id
    : recipientCopies.map(copy => wires(copy, parent)[0]).find(nonempty);
  if (!nonempty(wireId)) return { state: 'missing_copy', parentKey };
  const owners = items.filter(item => item.seq < child.seq && (
    (item.author.identity === recipientCid && item.source_wire_id === wireId)
    || copies(item, recipientCid).some(result => wires(result, item).includes(wireId))
  ));
  if (owners.length !== 1 || key(owners[0]!) !== parentKey) {
    return { state: 'ambiguous_parent', parentKey };
  }
  return { state: 'linked', parentKey, replyTo: { wire_id: wireId } };
}
