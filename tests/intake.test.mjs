import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';

import { IntakePump, canonicalJson } from '../src/intake.ts';
import { RoomService } from '../src/service.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const MESSAGE_IDS = [
  '01jz6y7n8p9q0r1s2t3v4w5x6z',
  '01jz6y7n8p9q0r1s2t3v4w5x70',
  '01jz6y7n8p9q0r1s2t3v4w5x71',
  '01jz6y7n8p9q0r1s2t3v4w5x72',
];
const AT = '2026-08-02T10:11:12.000Z';

class MemoryStore {
  rooms = new Map();
  records = new Map();
  tails = new Map();
  ownership = new AsyncLocalStorage();
  beforeAppend;
  afterAppend;

  mutex(roomId, work) {
    if (!work) return { runExclusive: (nested) => this.mutex(roomId, nested) };
    if (this.ownership.getStore() === roomId) return Promise.resolve().then(work);
    const previous = this.tails.get(roomId) ?? Promise.resolve();
    const result = previous.then(() => this.ownership.run(roomId, work));
    this.tails.set(roomId, result.then(() => undefined, () => undefined));
    return result;
  }

  async load(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`missing room ${roomId}`);
    return structuredClone(room);
  }

  async append(roomId, draft) {
    if (this.beforeAppend) await this.beforeAppend(draft);
    const records = this.records.get(roomId);
    const record = {
      ...structuredClone(draft),
      seq: records.length + 1,
      record_id: `${roomId}:${records.length + 1}`,
    };
    records.push(record);
    if (this.afterAppend) await this.afterAppend(record);
    return structuredClone(record);
  }

  async read(roomId, options = {}) {
    const after = options.after ?? 0;
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    return this.records.get(roomId)
      .filter((record) => record.seq > after)
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }
}

class FakePacket {
  name = `cowork-room-${ROOM_ID}`;
  cid = 'cid-room';
  inbox = [];
  sendCalls = [];
  signCalls = [];
  consumeCalls = [];
  nextSend = { status: 'queued', wire_id: 'wire-out' };
  beforeConsume;
  afterConsume;
  beforeSign;
  beforeSend;

  peekInbox() { return structuredClone(this.inbox); }

  async consumeInbox(expectedIds) {
    if (this.beforeConsume) await this.beforeConsume(expectedIds);
    this.consumeCalls.push([...expectedIds]);
    const expected = new Set(expectedIds);
    const consumed = this.inbox.filter((item) => expected.has(item.msg_id)).map((item) => item.msg_id);
    // This is the observable contract of HostedRoomPacket: messages arriving
    // after peek are drained and immediately deferred, so remain unread.
    const deferred = this.inbox.filter((item) => !expected.has(item.msg_id)).map((item) => item.msg_id);
    this.inbox = this.inbox.filter((item) => !expected.has(item.msg_id));
    if (this.afterConsume) await this.afterConsume({ consumed, deferred });
    return { consumed, deferred };
  }

  async sign(body) {
    this.signCalls.push(body);
    if (this.beforeSign) await this.beforeSign(body);
    return 'stable-signature';
  }

  async send(recipient, body) {
    this.sendCalls.push({ recipient, body });
    if (this.beforeSend) await this.beforeSend(recipient, body);
    return structuredClone(this.nextSend);
  }

  mintInvite() { throw new Error('not used'); }
  revokeInvite() { throw new Error('not used'); }
  listInvites() { return []; }
  listContacts() { return []; }
  listContactOrigins() { return {}; }
  removeContact() { throw new Error('not used'); }
}

class Registry {
  constructor(packet) { this.packet = packet; }
  get(roomId) { return roomId === ROOM_ID ? this.packet : undefined; }
  create() { throw new Error('not used'); }
}

function room(overrides = {}) {
  return {
    version: 2,
    room_id: ROOM_ID,
    identity_name: `cowork-room-${ROOM_ID}`,
    identity_cid: 'cid-room',
    mission: { goal: 'Ship', briefing: 'Read the mission.', briefing_version: 1 },
    role_briefings: {},
    anonymous: false,
    quiet_membership: false,
    membership_epoch: 3,
    state: 'active',
    invites: [],
    seats: [
      { identity: 'cid-alice', display_name: 'Alice', role: 'builder', invite_id: 'invite-a', accepted_at: AT, participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa1', state: 'active' },
      { identity: 'cid-bob', display_name: 'Bob', role: 'reviewer', invite_id: 'invite-b', accepted_at: AT, participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa2', state: 'active' },
      { identity: 'cid-cara', display_name: 'Cara', role: 'observer', invite_id: 'invite-c', accepted_at: AT, participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa3', state: 'active' },
    ],
    created_at: AT,
    activated_at: AT,
    ...overrides,
  };
}

function incoming(overrides = {}) {
  return {
    msg_id: 7,
    sender_id: 'cid-alice',
    sender_name: 'Untrusted current name',
    text: 'Participant update',
    date: '2026-08-02T10:12:00.000Z',
    wire_id: 'wire-in-7',
    ...overrides,
  };
}

function fixture(options = {}) {
  const store = new MemoryStore();
  const packet = new FakePacket();
  const registry = new Registry(packet);
  store.rooms.set(ROOM_ID, room(options.room));
  store.records.set(ROOM_ID, structuredClone(options.records ?? []));
  let messageIndex = 0;
  const pump = new IntakePump(store, registry, {
    now: () => AT,
    messageId: () => MESSAGE_IDS[messageIndex++],
  });
  const service = new RoomService(store, registry, {
    now: () => AT,
    roomId: () => ROOM_ID,
    messageId: () => MESSAGE_IDS[messageIndex++],
  });
  return { store, packet, registry, pump, service };
}

function byKind(records, kind) { return records.filter((record) => record.kind === kind); }

test('canonical JSON recursively sorts keys and participant fan-out excludes its durable seat author', async () => {
  assert.equal(
    canonicalJson({ z: [{ b: 2, a: 1 }], a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}',
  );
  const f = fixture();
  f.packet.inbox.push(incoming());

  await f.pump.pump(ROOM_ID);

  const records = await f.store.read(ROOM_ID);
  const [message] = byKind(records, 'message');
  assert.deepEqual(message.author, { identity: 'cid-alice', display_name: 'Alice', role: 'builder' });
  assert.equal(message.source_msg_id, 7);
  assert.equal(message.source_wire_id, 'wire-in-7');
  assert.deepEqual(message.recipient_identities, ['cid-bob', 'cid-cara']);
  assert.deepEqual(byKind(records, 'relay_intent').map((record) => record.recipient_identity), ['cid-bob', 'cid-cara']);
  assert.deepEqual(f.packet.consumeCalls, [[7]]);
  assert.deepEqual(f.packet.sendCalls.map((call) => call.recipient), ['cid-bob', 'cid-cara']);
  const results = byKind(records, 'relay_result');
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(({ status, wire_id }) => ({ status, wire_id })), [
    { status: 'queued', wire_id: 'wire-out' },
    { status: 'queued', wire_id: 'wire-out' },
  ]);

  const unsigned = JSON.parse(f.packet.signCalls[0]);
  assert.deepEqual(unsigned, {
    at: incoming().date,
    author: message.author,
    kind: 'room_msg',
    message_id: message.message_id,
    room_id: ROOM_ID,
    text: incoming().text,
    version: 1,
  });
  assert.equal('signature' in unsigned, false);
  assert.equal('recipient_identities' in unsigned, false);
  assert.deepEqual(Object.keys(JSON.parse(f.packet.sendCalls[0].body)).sort(),
    ['at', 'author', 'kind', 'message_id', 'room_id', 'signature', 'text', 'version']);
});

test('crash before message append leaves the input unread and creates no archive records', async () => {
  const f = fixture();
  f.packet.inbox.push(incoming());
  let fail = true;
  f.store.beforeAppend = (draft) => {
    if (fail && draft.kind === 'message') {
      fail = false;
      throw new Error('crash before message append');
    }
  };
  await assert.rejects(f.pump.pump(ROOM_ID), /before message append/);
  assert.equal((await f.store.read(ROOM_ID)).length, 0);
  assert.equal(f.packet.inbox.length, 1);
  assert.equal(f.packet.consumeCalls.length, 0);
  assert.equal(f.packet.sendCalls.length, 0);

  f.store.beforeAppend = undefined;
  await f.pump.pump(ROOM_ID);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'message').length, 1);
});

test('crash after message fsync resumes missing intents without duplicating the message', async () => {
  const f = fixture();
  f.packet.inbox.push(incoming());
  let fail = true;
  f.store.beforeAppend = (draft) => {
    if (fail && draft.kind === 'relay_intent') {
      fail = false;
      throw new Error('crash after message fsync');
    }
  };
  await assert.rejects(f.pump.pump(ROOM_ID), /after message fsync/);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'message').length, 1);
  assert.equal(f.packet.consumeCalls.length, 0);

  f.store.beforeAppend = undefined;
  await f.pump.pump(ROOM_ID);
  const records = await f.store.read(ROOM_ID);
  assert.equal(byKind(records, 'message').length, 1);
  assert.equal(byKind(records, 'relay_intent').length, 2);
});

test('crash after every recipient intent fsync retries consume before any send', async () => {
  const f = fixture();
  f.packet.inbox.push(incoming());
  let fail = true;
  f.packet.beforeConsume = () => {
    if (fail) {
      fail = false;
      throw new Error('crash after all intents fsync');
    }
  };
  await assert.rejects(f.pump.pump(ROOM_ID), /all intents fsync/);
  const before = await f.store.read(ROOM_ID);
  assert.equal(byKind(before, 'message').length, 1);
  assert.equal(byKind(before, 'relay_intent').length, 2);
  assert.equal(byKind(before, 'relay_result').length, 0);
  assert.equal(f.packet.sendCalls.length, 0);

  await f.pump.pump(ROOM_ID);
  assert.equal(f.packet.inbox.length, 0);
  assert.equal(f.packet.sendCalls.length, 2);
});

test('crash after consume leaves durable intents which resume without the inbox item', async () => {
  const f = fixture();
  f.packet.inbox.push(incoming());
  let fail = true;
  f.packet.afterConsume = () => {
    if (fail) {
      fail = false;
      throw new Error('crash after consume');
    }
  };
  await assert.rejects(f.pump.pump(ROOM_ID), /after consume/);
  assert.equal(f.packet.inbox.length, 0);
  assert.equal(f.packet.sendCalls.length, 0);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 0);

  await f.pump.resumePending(ROOM_ID);
  assert.equal(f.packet.sendCalls.length, 2);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 2);
});

test('crash after transport acceptance and before result fsync resends one stable envelope then writes one result', async () => {
  const f = fixture();
  f.store.rooms.set(ROOM_ID, room({ seats: room().seats.slice(0, 2) }));
  f.packet.inbox.push(incoming());
  let fail = true;
  f.store.beforeAppend = (draft) => {
    if (fail && draft.kind === 'relay_result') {
      fail = false;
      throw new Error('crash before result fsync');
    }
  };
  await assert.rejects(f.pump.pump(ROOM_ID), /before result fsync/);
  assert.equal(f.packet.sendCalls.length, 1, 'the first transport accepted the message');
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 0);

  f.store.beforeAppend = undefined;
  await f.pump.resumePending(ROOM_ID);
  assert.equal(f.packet.sendCalls.length, 2, 'the result-less durable intent is deliberately retried');
  assert.equal(f.packet.sendCalls[0].body, f.packet.sendCalls[1].body, 'retry keeps exact signed envelope stable');
  assert.equal(JSON.parse(f.packet.sendCalls[0].body).message_id, MESSAGE_IDS[0]);
  const results = byKind(await f.store.read(ROOM_ID), 'relay_result');
  assert.equal(results.length, 1, 'one eventual terminal result belongs to the durable intent');
  assert.equal(results[0].intent_record_id, `${ROOM_ID}:2`);

  await f.pump.resumePending(ROOM_ID);
  assert.equal(f.packet.sendCalls.length, 2);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 1);
});

test('sign and thrown send failures leave intents result-less and create no ghost results', async () => {
  const f = fixture();
  f.store.rooms.set(ROOM_ID, room({ seats: room().seats.slice(0, 2) }));
  f.packet.inbox.push(incoming());
  let failSign = true;
  f.packet.beforeSign = () => {
    if (failSign) {
      failSign = false;
      throw new Error('sign unavailable');
    }
  };
  await assert.rejects(f.pump.pump(ROOM_ID), /sign unavailable/);
  assert.equal(f.packet.sendCalls.length, 0);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 0);

  let failSend = true;
  f.packet.beforeSend = () => {
    if (failSend) {
      failSend = false;
      throw new Error('send outcome unknown');
    }
  };
  await assert.rejects(f.pump.resumePending(ROOM_ID), /send outcome unknown/);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 0);

  await f.pump.resumePending(ROOM_ID);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 1);
});

test('an observed transport refusal appends a terminal send_failed result without a wire id', async () => {
  const f = fixture();
  f.store.rooms.set(ROOM_ID, room({ seats: room().seats.slice(0, 2) }));
  f.packet.nextSend = { status: 'send_failed' };
  f.packet.inbox.push(incoming());
  await f.pump.pump(ROOM_ID);
  const [result] = byKind(await f.store.read(ROOM_ID), 'relay_result');
  assert.equal(result.status, 'send_failed');
  assert.equal('wire_id' in result, false);
});

test('non-seat and non-active messages are consumed but never archived, signed, or relayed', async () => {
  for (const roomOverride of [{}, { state: 'provisioning', activated_at: undefined }]) {
    const f = fixture({ room: roomOverride });
    f.packet.inbox.push(incoming(roomOverride.state ? {} : { sender_id: 'cid-outsider' }));
    await f.pump.pump(ROOM_ID);
    assert.equal(f.packet.inbox.length, 0);
    assert.deepEqual(await f.store.read(ROOM_ID), []);
    assert.equal(f.packet.signCalls.length, 0);
    assert.equal(f.packet.sendCalls.length, 0);
  }
});

test('an arrival between peek and consume is deferred to the next pass', async () => {
  const f = fixture();
  f.store.rooms.set(ROOM_ID, room({ seats: room().seats.slice(0, 2) }));
  f.packet.inbox.push(incoming());
  let injected = false;
  f.packet.beforeConsume = () => {
    if (!injected) {
      injected = true;
      f.packet.inbox.push(incoming({ msg_id: 8, sender_id: 'cid-bob', wire_id: 'wire-in-8', text: 'Raced arrival' }));
    }
  };
  await f.pump.pump(ROOM_ID);
  assert.deepEqual(f.packet.consumeCalls, [[7]], 'the snapshot does not absorb the later arrival');
  assert.deepEqual(f.packet.inbox.map((item) => item.msg_id), [8]);

  await f.pump.pump(ROOM_ID);
  assert.deepEqual(f.packet.consumeCalls, [[7], [8]]);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'message').length, 2);
});

test('concurrent notify and pump calls serialize one archive message, intent, send, and result', async () => {
  const f = fixture();
  f.store.rooms.set(ROOM_ID, room({ seats: room().seats.slice(0, 2) }));
  f.packet.inbox.push(incoming());
  await Promise.all([
    f.pump.notify(ROOM_ID),
    f.pump.notify(ROOM_ID),
    f.pump.pump(ROOM_ID),
    f.pump.resumePending(ROOM_ID),
  ]);
  const records = await f.store.read(ROOM_ID);
  assert.equal(byKind(records, 'message').length, 1);
  assert.equal(byKind(records, 'relay_intent').length, 1);
  assert.equal(f.packet.sendCalls.length, 1);
  assert.equal(byKind(records, 'relay_result').length, 1);
});

test('resumePending reconciles Task 5 briefing intents into signed room_briefing envelopes', async () => {
  const briefingId = MESSAGE_IDS[2];
  const f = fixture({
    records: [
      {
        version: 1, kind: 'message', room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: AT,
        message_id: briefingId,
        author: { identity: 'cid-room', display_name: `cowork-room-${ROOM_ID}`, role: 'room' },
        category: 'briefing', text: 'Read the mission.', recipient_identities: ['cid-alice'],
      },
      {
        version: 1, kind: 'relay_intent', room_id: ROOM_ID, seq: 2, record_id: `${ROOM_ID}:2`, at: AT,
        message_id: briefingId, recipient_identity: 'cid-alice',
      },
    ],
  });
  await f.pump.resumePending(ROOM_ID);
  const unsigned = JSON.parse(f.packet.signCalls[0]);
  assert.equal(unsigned.kind, 'room_briefing');
  assert.equal(unsigned.message_id, briefingId);
  assert.equal(f.packet.sendCalls[0].recipient, 'cid-alice');
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 1);
});

test('operator postMessage rejects all author-like keys before host authorship and room voice includes every seat', async () => {
  const f = fixture();
  for (const forged of [
    { text: 'hello', author: 'Mallory' },
    { text: 'hello', author_id: 'cid-mallory' },
    { text: 'hello', identity: 'cid-mallory' },
    { text: 'hello', display_name: 'Mallory' },
    { text: 'hello', role: 'owner' },
  ]) {
    await assert.rejects(f.service.postMessage(ROOM_ID, forged), /unrecognized|invalid/i);
  }
  assert.deepEqual(await f.store.read(ROOM_ID), []);

  const message = await f.service.postMessage(ROOM_ID, { text: 'Operator direction' });
  assert.deepEqual(message.author, {
    identity: 'cid-room', display_name: `cowork-room-${ROOM_ID}`, role: 'room',
  });
  assert.deepEqual(message.recipient_identities, ['cid-alice', 'cid-bob', 'cid-cara']);
  const records = await f.store.read(ROOM_ID);
  assert.deepEqual(byKind(records, 'relay_intent').map((record) => record.recipient_identity),
    ['cid-alice', 'cid-bob', 'cid-cara']);
  assert.deepEqual(f.packet.sendCalls.map((call) => call.recipient), ['cid-alice', 'cid-bob', 'cid-cara']);
});

test('operator postMessage rejects a non-active room without appending anything', async () => {
  const f = fixture({ room: { state: 'provisioning', activated_at: undefined } });
  await assert.rejects(f.service.postMessage(ROOM_ID, { text: 'too soon' }), /active/i);
  assert.deepEqual(await f.store.read(ROOM_ID), []);
});

test('operator room voice resumes a crash during intent creation before sending any seat', async () => {
  const f = fixture();
  let intents = 0;
  f.store.beforeAppend = (draft) => {
    if (draft.kind === 'relay_intent' && ++intents === 2) {
      throw new Error('crash during room fanout');
    }
  };
  await assert.rejects(f.service.postMessage(ROOM_ID, { text: 'Durable direction' }), /room fanout/);
  assert.equal(f.packet.sendCalls.length, 0);
  let records = await f.store.read(ROOM_ID);
  assert.equal(byKind(records, 'message').length, 1);
  assert.equal(byKind(records, 'relay_intent').length, 1);

  f.store.rooms.get(ROOM_ID).seats.push({
    identity: 'cid-late', display_name: 'Late', role: 'late', invite_id: 'invite-late', accepted_at: AT,
  });
  f.store.beforeAppend = undefined;
  await f.pump.resumePending(ROOM_ID);
  records = await f.store.read(ROOM_ID);
  assert.deepEqual(byKind(records, 'relay_intent').map((record) => record.recipient_identity),
    ['cid-alice', 'cid-bob', 'cid-cara']);
  assert.deepEqual(f.packet.sendCalls.map((call) => call.recipient), ['cid-alice', 'cid-bob', 'cid-cara']);
});

test('resumePending completes participant snapshot fanout and consumes its unread source before any send', async () => {
  const f = fixture({
    records: [
      {
        version: 1, kind: 'message', room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`,
        at: incoming().date, message_id: MESSAGE_IDS[0],
        author: { identity: 'cid-alice', display_name: 'Alice', role: 'builder' },
        category: 'chat', text: incoming().text, source_msg_id: 7, source_wire_id: 'wire-in-7',
        recipient_identities: ['cid-bob', 'cid-cara'],
      },
      {
        version: 1, kind: 'relay_intent', room_id: ROOM_ID, seq: 2, record_id: `${ROOM_ID}:2`,
        at: AT, message_id: MESSAGE_IDS[0], recipient_identity: 'cid-bob',
      },
    ],
  });
  f.packet.inbox.push(incoming());
  f.packet.beforeSend = async () => {
    assert.deepEqual(f.packet.consumeCalls, [[7]], 'source must be consumed before the first wire attempt');
    assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_intent').length, 2,
      'the complete snapshot fanout must be durable before the first wire attempt');
  };

  await f.pump.resumePending(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls.map((call) => call.recipient), ['cid-bob', 'cid-cara']);
  assert.deepEqual(f.packet.consumeCalls, [[7]]);
});

test('resumePending after a pre-consume crash consumes before sending already-complete intents', async () => {
  const f = fixture({
    records: [
      {
        version: 1, kind: 'message', room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`,
        at: incoming().date, message_id: MESSAGE_IDS[0],
        author: { identity: 'cid-alice', display_name: 'Alice', role: 'builder' },
        category: 'chat', text: incoming().text, source_msg_id: 7, source_wire_id: 'wire-in-7',
        recipient_identities: ['cid-bob'],
      },
      {
        version: 1, kind: 'relay_intent', room_id: ROOM_ID, seq: 2, record_id: `${ROOM_ID}:2`,
        at: AT, message_id: MESSAGE_IDS[0], recipient_identity: 'cid-bob',
      },
    ],
    room: { seats: room().seats.slice(0, 2) },
  });
  f.packet.inbox.push(incoming());
  f.packet.beforeSend = () => assert.deepEqual(f.packet.consumeCalls, [[7]]);
  await f.pump.resumePending(ROOM_ID);
  assert.equal(f.packet.sendCalls.length, 1);
});

test('notify does not lose a wakeup queued in the final-drain microtask gap', async () => {
  const f = fixture();
  let calls = 0;
  let releaseReplacement;
  const replacementGate = new Promise((resolve) => { releaseReplacement = resolve; });
  f.pump.pump = async () => {
    calls += 1;
    if (calls === 2) await replacementGate;
  };
  const first = f.pump.notify(ROOM_ID);
  let replacement;
  queueMicrotask(() => { replacement = f.pump.notify(ROOM_ID); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  let firstSettled = false;
  void first.then(() => { firstSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false, 'the original work promise must chain the replacement');
  releaseReplacement();
  await first;
  await replacement;
  assert.equal(calls, 2);
});

test('notify chains a dirty replacement after a failed worker and still reports the original failure', async () => {
  const f = fixture();
  let calls = 0;
  f.pump.pump = async () => {
    calls += 1;
    if (calls === 1) throw new Error('worker failed');
  };
  const first = f.pump.notify(ROOM_ID);
  let replacement;
  queueMicrotask(() => { replacement = f.pump.notify(ROOM_ID); });
  await assert.rejects(first, /worker failed/);
  await replacement.catch(() => {});
  assert.equal(calls, 2, 'dirty shutdown work must be handed to a replacement worker');
});

// ---- Rooms evolution Phase A3 (spec §4.2, §4.4, §8.3) — anonymity ----

function anonymousRoom(overrides = {}) {
  const base = room();
  return {
    ...base,
    anonymous: true,
    seats: [
      { ...base.seats[0], alias: 'builder #1' },
      { ...base.seats[1], alias: 'reviewer #1' },
      { ...base.seats[2], alias: 'observer #1' },
    ],
    ...overrides,
  };
}

test('anonymous rooms relay alias authors with zero real identity bytes in signed bodies (release-blocking pin)', async () => {
  const f = fixture({ room: anonymousRoom() });
  f.packet.inbox.push(incoming());

  const consoleLines = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const level of Object.keys(original)) {
    console[level] = (...parts) => { consoleLines.push(parts.map(String).join(' ')); };
  }
  try {
    await f.pump.pump(ROOM_ID);
  } finally {
    for (const level of Object.keys(original)) console[level] = original[level];
  }

  const records = await f.store.read(ROOM_ID);
  const [message] = byKind(records, 'message');
  // the archive keeps BOTH the real seat identity and the alias (INV-R4)
  assert.deepEqual(message.author, { identity: 'cid-alice', display_name: 'Alice', role: 'builder' });
  assert.deepEqual(message.author_alias, {
    participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa1',
    alias: 'builder #1',
  });

  // the relayed signed body carries only the room-scoped pseudonym
  assert.equal(f.packet.sendCalls.length, 2);
  for (const call of [...f.packet.sendCalls.map((send) => send.body), ...f.packet.signCalls]) {
    const bytes = Buffer.from(call, 'utf8');
    assert.equal(bytes.includes('cid-alice'), false, 'no author cid bytes in a relayed body');
    assert.equal(bytes.includes('Alice'), false, 'no author display-name bytes in a relayed body');
    assert.equal(bytes.includes('cid-bob'), false, 'no recipient cid bytes in a relayed body');
    assert.equal(bytes.includes('Untrusted current name'), false, 'no sender-claimed name bytes');
  }
  const body = JSON.parse(f.packet.sendCalls[0].body);
  assert.deepEqual(body.author, {
    identity: '01jz6y7n8p9q0r1s2t3v4w5xa1',
    display_name: 'builder #1',
    role: 'builder',
  });

  // default-level logs never pair an alias with a cid (§4.4 item 6)
  for (const line of consoleLines) {
    assert.equal(line.includes('cid-alice') && line.includes('builder #1'), false, line);
  }
});

test('non-anonymous rooms keep the real author snapshot on the wire (regression)', async () => {
  const f = fixture();
  f.packet.inbox.push(incoming());
  await f.pump.pump(ROOM_ID);
  const body = JSON.parse(f.packet.sendCalls[0].body);
  assert.deepEqual(body.author, { identity: 'cid-alice', display_name: 'Alice', role: 'builder' });
  const records = await f.store.read(ROOM_ID);
  assert.equal(byKind(records, 'message')[0].author_alias, undefined);
});

test('room-voice messages in anonymous rooms carry the room author and no seat identity bytes', async () => {
  const f = fixture({ room: anonymousRoom() });
  await f.service.postMessage(ROOM_ID, { text: 'Operator update.' });
  assert.equal(f.packet.sendCalls.length, 3);
  for (const call of f.packet.sendCalls) {
    const body = JSON.parse(call.body);
    assert.deepEqual(body.author, { identity: 'cid-room', display_name: `cowork-room-${ROOM_ID}`, role: 'room' });
    for (const leak of ['cid-alice', 'cid-bob', 'cid-cara', 'Alice', 'Bob', 'Cara']) {
      assert.equal(Buffer.from(call.body, 'utf8').includes(leak), false, `${leak} leaked into a room-voice body`);
    }
  }
});

test('history views: participant redacts to alias form and drops identities; operator keeps both', async () => {
  const f = fixture({ room: anonymousRoom() });
  f.packet.inbox.push(incoming());
  await f.pump.pump(ROOM_ID);

  const operatorView = await f.service.history(ROOM_ID, {});
  assert.equal(operatorView.some((record) => record.kind === 'relay_intent'), true);
  const operatorMessage = operatorView.find((record) => record.kind === 'message');
  assert.equal(operatorMessage.author.identity, 'cid-alice');
  assert.equal(operatorMessage.author_alias.alias, 'builder #1');

  const participantView = await f.service.history(ROOM_ID, { view: 'participant' });
  assert.equal(participantView.length, 1);
  const [redacted] = participantView;
  assert.equal(redacted.kind, 'message');
  assert.deepEqual(redacted.author, {
    identity: '01jz6y7n8p9q0r1s2t3v4w5xa1',
    display_name: 'builder #1',
    role: 'builder',
  });
  assert.equal('author_alias' in redacted, false);
  assert.equal('recipient_identities' in redacted, false);
  assert.equal('source_msg_id' in redacted, false);
  assert.equal('source_wire_id' in redacted, false);
  const rendered = Buffer.from(JSON.stringify(participantView), 'utf8');
  for (const leak of ['cid-alice', 'cid-bob', 'cid-cara', 'Alice', 'Untrusted current name']) {
    assert.equal(rendered.includes(leak), false, `${leak} leaked into the participant history view`);
  }

  // non-anonymous participant view keeps real authors but still drops routing identities
  const plain = fixture();
  plain.packet.inbox.push(incoming());
  await plain.pump.pump(ROOM_ID);
  const plainView = await plain.service.history(ROOM_ID, { view: 'participant' });
  assert.equal(plainView[0].author.identity, 'cid-alice');
  assert.equal('recipient_identities' in plainView[0], false);
});
