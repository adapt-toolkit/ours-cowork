import assert from 'node:assert/strict';
import test from 'node:test';

import { StartThreadInputSchema } from '../src/thread-contracts.ts';
import {
  activeThreadSeat,
  findThreadRoot,
  selectThreadMembers,
  threadFingerprint,
} from '../src/threads.ts';

const ids = ['01jz6y7n8p9q0r1s2t3v4w5xa1', '01jz6y7n8p9q0r1s2t3v4w5xa2'];
const seats = ids.map((participant_id, index) => ({
  participant_id,
  identity: (index ? 'B' : 'A').repeat(64),
  state: 'active',
}));
const room = { seats };
const input = { topic: ' Review ', participant_ids: ids, idempotency_key: 'request-1' };

test('selection is explicit and includes the active creator', () => {
  const normalized = StartThreadInputSchema.parse(input);
  assert.equal(normalized.topic, 'Review');
  assert.deepEqual(
    selectThreadMembers(room, seats[0].identity, normalized),
    seats.map(({ participant_id, identity }) => ({ participant_id, identity })),
  );
  for (const participant_ids of [
    [],
    [ids[1]],
    [ids[0], ids[0]],
    ['01jz6y7n8p9q0r1s2t3v4w5xff'],
  ]) {
    assert.throws(
      () => selectThreadMembers(room, seats[0].identity, { ...normalized, participant_ids }),
      /invalid_members/,
    );
  }
  assert.throws(
    () => selectThreadMembers(
      { seats: [{ ...seats[0], state: 'removed' }, seats[1]] },
      seats[0].identity,
      normalized,
    ),
    /invalid_members/,
  );
});

test('retry normalization and seat incarnation are stable', () => {
  const normalized = StartThreadInputSchema.parse(input);
  assert.equal(
    threadFingerprint(normalized),
    threadFingerprint({ ...normalized, participant_ids: [...ids].reverse() }),
  );
  assert.match(threadFingerprint(normalized), /^[0-9a-f]{64}$/);
  const root = {
    members: seats.map(({ participant_id, identity }) => ({ participant_id, identity })),
  };
  assert.equal(activeThreadSeat(room, root, seats[0].identity).participant_id, ids[0]);
  assert.equal(activeThreadSeat(
    { seats: [{ ...seats[0], participant_id: '01jz6y7n8p9q0r1s2t3v4w5xff' }] },
    root,
    seats[0].identity,
  ), undefined);
});

test('topic and retry bounds reject invalid input', () => {
  for (const topic of ['', ' ', 'x'.repeat(121), 'bad\u0000name', 'bad\u200bname', '😀'.repeat(121)]) {
    assert.equal(StartThreadInputSchema.safeParse({ ...input, topic }).success, false);
  }
  assert.equal(
    StartThreadInputSchema.parse({ ...input, topic: '😀'.repeat(120) }).topic,
    '😀'.repeat(120),
  );
  assert.equal(
    StartThreadInputSchema.parse({ ...input, topic: '😀'.repeat(61) }).topic,
    '😀'.repeat(61),
  );
  for (const idempotency_key of ['', 'x'.repeat(129), 'has space']) {
    assert.equal(StartThreadInputSchema.safeParse({ ...input, idempotency_key }).success, false);
  }
  assert.equal(StartThreadInputSchema.safeParse({ ...input, caller_cid: seats[0].identity }).success, false);
});

function rootMessage(overrides = {}) {
  const thread_id = '01jz6y7n8p9q0r1s2t3v4w5xb1';
  return {
    version: 1,
    kind: 'message',
    room_id: '01jz6y7n8p9q0r1s2t3v4w5x6y',
    seq: 1,
    record_id: '01jz6y7n8p9q0r1s2t3v4w5x6y:1',
    at: '2026-09-10T10:11:12Z',
    message_id: thread_id,
    author: { identity: seats[0].identity, display_name: 'Alice', role: 'reviewer' },
    category: 'chat',
    text: '',
    recipient_identities: seats.map((seat) => seat.identity),
    scope: { thread_id },
    thread_root: {
      schema_version: 1,
      thread_id,
      topic: 'Review',
      creator_participant_id: ids[0],
      members: seats.map(({ participant_id, identity }) => ({ participant_id, identity })),
      idempotency_key: 'request-1',
      fingerprint: 'a'.repeat(64),
    },
    ...overrides,
  };
}

test('root lookup accepts one structurally valid text-stripped root', () => {
  const root = rootMessage();
  assert.equal(findThreadRoot([root], root.message_id), root);
  assert.equal(findThreadRoot([root], '01jz6y7n8p9q0r1s2t3v4w5xff'), undefined);
});

test('root lookup rejects ordinary, duplicate, and malformed root rows', () => {
  const root = rootMessage();
  const { scope: _scope, thread_root: _threadRoot, ...ordinary } = root;
  assert.throws(() => findThreadRoot([ordinary], root.message_id), /reply_target_unavailable/);
  assert.throws(() => findThreadRoot([root, { ...root, seq: 2 }], root.message_id), /reply_target_unavailable/);
  assert.throws(
    () => findThreadRoot([{ ...root, scope: { thread_id: root.message_id, parent_key: `message:${root.message_id}` } }], root.message_id),
    /reply_target_unavailable/,
  );
  assert.throws(
    () => findThreadRoot([{ ...root, thread_root: { ...root.thread_root, thread_id: ids[0] } }], root.message_id),
    /reply_target_unavailable/,
  );
  assert.throws(
    () => findThreadRoot([{
      ...root,
      message_id: ids[0],
      scope: { thread_id: root.message_id },
    }], root.message_id),
    /reply_target_unavailable/,
  );
});

// Consumers must resolve each hop in its saved author's namespace, with ordering
// guards, instead of trusting a scope.parent_key or recursively scanning wire text.
test('association uses authenticated ancestry and bounds cyclic or forward private targets', async () => {
  const { classifyThreadAssociation: classify } = await import('../src/threads.ts');
  const root = rootMessage();
  const r = { room_id: root.room_id, anonymous: false };
  const child = { ...root, seq: 2, record_id: `${root.room_id}:2`, message_id: ids[0],
    thread_root: undefined, source_wire_id: 'child-source', source_reply_to: { wire_id: 'loop' },
    scope: { thread_id: root.message_id, parent_key: `message:${root.message_id}` } };
  for (const target of ['child-source', 'forward', 'unknown']) {
    const source = { ...child, source_reply_to: { wire_id: target } };
    const future = { ...child, seq: 3, record_id: `${root.room_id}:3`, message_id: ids[1], source_wire_id: 'forward',
      source_reply_to: { wire_id: 'child-source' } };
    assert.throws(() => classify(r, [root, source, future], source), /reply_target_unavailable/);
  }
  const legacy = { ...child, scope: undefined, source_reply_to: { wire_id: 'old-unknown' } };
  assert.deepEqual(classify(r, [root, legacy], legacy), { state: 'ordinary' });
  // The same wire belongs to a different author; it is not this legacy row's parent.
  const other = { ...child, author: { ...child.author, identity: seats[1].identity }, source_wire_id: 'old-unknown' };
  assert.deepEqual(classify(r, [root, other, legacy], legacy), { state: 'ordinary' });
});
