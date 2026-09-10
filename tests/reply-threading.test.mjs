import assert from 'node:assert/strict';
import test from 'node:test';
import { selectReply, readReplyRows } from '../src/reply-threading.ts';
const item = (id, seq, author, wire, recipients, reply) => ({
  room_id: 'R', record_id: `r${seq}`, kind: 'message', message_id: id, seq,
  author: { identity: author }, source_wire_id: wire, recipient_identities: recipients,
  ...(reply ? { source_reply_to: { wire_id: reply, sentence: 2 } } : {}),
});
const parent = item('L_a', 1, 'A', 'w_a', ['B', 'C']);
const pair = (seq, cid, wire, status = 'queued') => [
  { room_id: 'R', seq, record_id: `r${seq}`, kind: 'relay_intent', message_id: 'L_a', recipient_identity: cid },
  { room_id: 'R', seq: seq + 1, record_id: `r${seq + 1}`, kind: 'relay_result', message_id: 'L_a', recipient_identity: cid, intent_record_id: `r${seq}`, status, wire_id: wire },
];
const rows = [parent, ...pair(2, 'B', 'w_aB1'), ...pair(4, 'B', 'w_aB2'), ...pair(6, 'C', 'w_aC')];
test('both duplicate aliases route to A original and C own copy', () => {
  for (const wire of ['w_aB1', 'w_aB2']) {
    const child = item('L_b', 10, 'B', 'w_b', ['A', 'C'], wire);
    assert.deepEqual(selectReply(rows, 'R', child, 'A'), { state: 'linked', parentKey: 'message:L_a', replyTo: { wire_id: 'w_a' } });
    assert.deepEqual(selectReply(rows, 'R', child, 'C').replyTo, { wire_id: 'w_aC' });
  }
});
test('foreign participant, failed result, and unknown wire do not authorize parent', () => {
  for (const wire of ['w_aC', 'missing']) {
    assert.equal(selectReply(rows, 'R', item('L_b', 10, 'B', 'w_b', [], wire), 'A').state, 'unknown_parent');
  }
  const failed = [parent, ...pair(2, 'B', 'failed', 'send_failed')];
  assert.equal(selectReply(failed, 'R', item('L_b', 10, 'B', 'w_b', [], 'failed'), 'A').state, 'unknown_parent');
});
test('late recipient gets no invented wire and source sentence is not copied', () => {
  const child = item('L_b', 10, 'B', 'w_b', [], 'w_aB1');
  assert.deepEqual(selectReply(rows, 'R', child, 'D'), { state: 'missing_copy', parentKey: 'message:L_a' });
  assert.equal(selectReply(rows, 'R', child, 'A').replyTo.sentence, undefined);
});
test('duplicate logical sources cannot be resolved arbitrarily', () => {
  const conflict = [...rows, item('L_a', 8, 'X', 'w_x', [])];
  assert.equal(selectReply(conflict, 'R', item('L_b', 10, 'B', 'w_b', [], 'w_aB1'), 'A').state, 'ambiguous_parent');
});
test('short pages are continued until empty and large bodies are discarded', async () => {
  const source = [{ ...parent, text: 'large body' }, ...pair(2, 'B', 'w_aB1')];
  const calls = [];
  const store = { async read(room, { after, limit }) {
    calls.push([room, after, limit]); return source.filter(r => r.seq > after).slice(0, 1);
  } };
  assert.equal((await readReplyRows(store, 'R'))[0].text, '');
  assert.equal(calls.length, 4);
});
test('nested reply chooses immediate original, not thread root', () => {
  const b = item('L_b', 10, 'B', 'w_b', ['A', 'C'], 'w_aB1');
  const bc = pair(11, 'C', 'w_bC').map(r => ({ ...r, message_id: 'L_b' }));
  const c = item('L_c', 20, 'C', 'w_c', ['A', 'B'], 'w_bC');
  assert.deepEqual(selectReply([...rows, b, ...bc], 'R', c, 'B').replyTo, { wire_id: 'w_b' });
  assert.equal(selectReply([...rows, b, ...bc], 'R', c, 'A').state, 'missing_copy');
});
test('file metadata and binary copies share one original', () => {
  const file = { ...parent, kind: 'file', file_id: 'F_a', source_wire_id: 'f_a' };
  delete file.message_id;
  const fr = pair(2, 'B', 'f_B').map(r => {
    const out = { ...r, file_id: 'F_a' }; delete out.message_id;
    if (out.kind === 'relay_result') out.metadata_wire_id = 'notice_B';
    return out;
  });
  for (const wire of ['f_B', 'notice_B']) {
    assert.deepEqual(selectReply([file, ...fr], 'R', item('L_b', 10, 'B', 'w_b', [], wire), 'A').replyTo,
      { wire_id: 'f_a' });
  }
});
test('wrong room, dangling intent and skipped result are not aliases', () => {
  const b = item('L_b', 10, 'B', 'w_b', [], 'bad');
  const fixtures = [
    [parent, ...pair(2, 'B', 'bad').map(r => ({ ...r, room_id: 'OTHER' }))],
    [parent, pair(2, 'B', 'bad')[1]],
    [parent, ...pair(2, 'B', 'bad', 'skipped_removed')],
  ];
  for (const fixture of fixtures) assert.equal(selectReply(fixture, 'R', b, 'A').state, 'unknown_parent');
});
test('concurrent replies remain independent and target same logical parent', () => {
  for (const child of [item('L_b1', 10, 'B', 'w_b1', [], 'w_aB1'), item('L_b2', 11, 'B', 'w_b2', [], 'w_aB2')]) {
    assert.equal(selectReply(rows, 'R', child, 'A').parentKey, 'message:L_a');
  }
});
test('conflicting outgoing alias is never selected', () => {
  const other = item('L_other', 8, 'X', 'w_x', ['C']);
  const sameWire = pair(9, 'C', 'w_aC').map(r => ({ ...r, message_id: 'L_other' }));
  assert.equal(selectReply([...rows, other, ...sameWire], 'R', item('L_b', 20, 'B', 'w_b', [], 'w_aB1'), 'C').state, 'ambiguous_parent');
});
test('known aliases survive ordinary archive serialization and reload', () => {
  const restored = JSON.parse(JSON.stringify(rows));
  const child = item('L_b', 10, 'B', 'w_b', [], 'w_aB2');
  assert.deepEqual(selectReply(restored, 'R', child, 'C'), selectReply(rows, 'R', child, 'C'));
});
test('no reply and room-authored parent have explicit behavior', () => {
  assert.equal(selectReply(rows, 'R', item('L_b', 10, 'B', 'w_b', []), 'A').state, 'none');
  const roomParent = { ...parent, author: { identity: 'ROOM' }, source_wire_id: undefined };
  assert.deepEqual(selectReply([roomParent, ...rows.slice(1)], 'R', item('L_b', 10, 'B', 'w_b', [], 'w_aB1'), 'C').replyTo, { wire_id: 'w_aC' });
});

test('source author without source wire falls back to eligible own relay', () => {
  const p = { ...parent, source_wire_id: undefined, recipient_identities: ['A', 'B', 'C'] };
  const evidence = [p, ...rows.slice(1), ...pair(8, 'A', 'w_aA')];
  assert.deepEqual(selectReply(evidence, 'R', item('L_b', 12, 'B', 'w_b', [], 'w_aB1'), 'A').replyTo, { wire_id: 'w_aA' });
});
