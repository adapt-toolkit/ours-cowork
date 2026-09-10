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

  async save(room) {
    this.rooms.set(room.room_id, structuredClone(room));
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
  fileInbox = [];
  sendCalls = [];
  sendFileCalls = [];
  consumeCalls = [];
  consumeFileCalls = [];
  acknowledgeCalls = [];
  listCalls = [];
  acknowledgeOrder = [];
  nextSend = { status: 'queued', wire_id: 'wire-out' };
  nextSendFile = { status: 'queued', wire_id: 'wire-file-out' };
  beforeConsume;
  afterConsume;
  beforeSend;
  beforeConsumeFile;
  afterConsumeFile;
  beforeSendFile;
  drainCalls = 0;
  onDrain;

  async drainRuntimeCommands(onUnexpected) {
    this.drainCalls += 1;
    if (this.onDrain) await this.onDrain(onUnexpected);
  }

  async listUnreadMessages(limit) {
    this.listCalls.push(['messages', limit]);
    return structuredClone(this.inbox.slice(0, limit));
  }
  async listUnreadFiles(limit) {
    this.listCalls.push(['files', limit]);
    return structuredClone(this.fileInbox.slice(0, limit));
  }

  async acknowledgeMessage(expected, onUnexpected) {
    this.acknowledgeCalls.push(expected.msg_id);
    if (this.beforeConsume) await this.beforeConsume([expected.msg_id]);
    for (;;) {
      const item = this.inbox.shift();
      if (!item) {
        if (this.afterConsume) await this.afterConsume({ consumed: [], deferred: [] });
        return;
      }
      this.consumeCalls.push([item.msg_id]);
      this.acknowledgeOrder.push(`message:${item.msg_id}`);
      if (item.msg_id === expected.msg_id && item.wire_id === expected.wire_id) {
        if (this.afterConsume) await this.afterConsume({ consumed: [item.msg_id], deferred: [] });
        return;
      }
      await onUnexpected(structuredClone(item));
    }
  }

  async acknowledgeFile(expected) {
    if (this.beforeConsumeFile) await this.beforeConsumeFile([expected.file_id]);
    const index = this.fileInbox.findIndex(
      (item) => item.file_id === expected.file_id && item.wire_id === expected.wire_id,
    );
    const consumed = index < 0 ? [] : [this.fileInbox.splice(index, 1)[0].file_id];
    this.consumeFileCalls.push([expected.file_id]);
    this.acknowledgeOrder.push(`file:${expected.file_id}`);
    if (this.afterConsumeFile) await this.afterConsumeFile({ consumed, deferred: [] });
  }

  async send(recipient, body, replyTo) {
    this.sendCalls.push({ recipient, body, ...(replyTo ? { replyTo } : {}) });
    if (this.beforeSend) await this.beforeSend(recipient, body);
    return structuredClone(typeof this.nextSend === 'function'
      ? this.nextSend(recipient, body) : this.nextSend);
  }

  async sendFile(recipient, filename, mime, data, replyTo) {
    this.sendFileCalls.push({ recipient, filename, mime, data: Buffer.from(data),
      ...(replyTo ? { replyTo } : {}) });
    if (this.beforeSendFile) await this.beforeSendFile(recipient, filename, mime, data);
    return structuredClone(typeof this.nextSendFile === 'function'
      ? this.nextSendFile(recipient, filename, mime, data) : this.nextSendFile);
  }

  mintInvite() { throw new Error('not used'); }
  revokeInvite() { throw new Error('not used'); }
  listInvites() { return []; }
  listContacts() { return []; }
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
    room_name: 'Release room',
    identity_name: `cowork-room-${ROOM_ID}`,
    identity_cid: 'cid-room',
    mission: { goal: 'Ship', briefing: 'Read the mission.', briefing_version: 1 },
    role_briefings: {},
    rest_roles: [],
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
    reply_to: null,
    ...overrides,
  };
}

function incomingFile(overrides = {}) {
  return {
    file_id: 9,
    sender_id: 'cid-alice',
    sender_name: 'Untrusted current name',
    filename: 'evidence.bin',
    mime: 'application/octet-stream',
    data: Buffer.from([0, 1, 2, 255]),
    date: '2026-08-02T10:12:30.000Z',
    wire_id: 'wire-file-in-9',
    reply_to: null,
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

function activeSeat(identity, displayName, role, suffix) {
  return {
    identity, display_name: displayName, role, invite_id: `invite-${suffix}`,
    accepted_at: AT, participant_id: `01jz6y7n8p9q0r1s2t3v4w5x${suffix}`, state: 'active',
  };
}

// ---- Durable file broadcast -------------------------------------------------

test('intake preserves standard SDK reply references on archived messages and files', async () => {
  const f = fixture();
  await seedLegacyParent(f, 'wire-parent-message', MESSAGE_IDS[2]);
  await seedLegacyParent(f, 'wire-parent-file', MESSAGE_IDS[3]);
  f.packet.inbox.push(incoming({ reply_to: { wire_id: 'wire-parent-message', sentence: 2 } }));
  f.packet.fileInbox.push(incomingFile({ reply_to: { wire_id: 'wire-parent-file' } }));

  await f.pump.pump(ROOM_ID);

  const records = await f.store.read(ROOM_ID);
  assert.deepEqual(byKind(records, 'message').find(r => r.source_msg_id === 7).source_reply_to, {
    wire_id: 'wire-parent-message', sentence: 2,
  });
  assert.deepEqual(byKind(records, 'file')[0].source_reply_to, { wire_id: 'wire-parent-file' });
});

test('broadcast reply references original for A, recipient copy for C, no B echo', async () => {
  const f = fixture();
  let serial = 0;
  f.packet.nextSend = () => ({ status: 'queued', wire_id: `wire-relay-${++serial}` });
  f.packet.inbox.push(incoming({ wire_id: 'wire-A-original' }));
  await f.pump.pump(ROOM_ID);
  const archive = await f.store.read(ROOM_ID);
  const parent = byKind(archive, 'message')[0];
  const copies = byKind(archive, 'relay_result').filter(r => r.message_id === parent.message_id);
  const parentB = copies.find(r => r.recipient_identity === 'cid-bob').wire_id;
  const parentC = copies.find(r => r.recipient_identity === 'cid-cara').wire_id;
  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(incoming({ msg_id: 8, sender_id: 'cid-bob',
    text: 'B answer', wire_id: 'wire-B-answer', reply_to: { wire_id: parentB } }));
  await f.pump.pump(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls.map(c => c.recipient).sort(), ['cid-alice', 'cid-cara']);
  assert.deepEqual(f.packet.sendCalls.find(c => c.recipient === 'cid-alice').replyTo,
    { wire_id: 'wire-A-original' });
  assert.deepEqual(f.packet.sendCalls.find(c => c.recipient === 'cid-cara').replyTo,
    { wire_id: parentC });
  assert.equal(byKind(await f.store.read(ROOM_ID), 'message').length, 2);
});

test('nested intake replies use the immediate parent copies for every destination', async () => {
  const f = fixture();
  let serial = 0;
  f.packet.nextSend = (recipient) => ({ status: 'queued', wire_id: `${recipient}-${++serial}` });
  f.packet.inbox.push(incoming({ wire_id: 'wire-A-root' }));
  await f.pump.pump(ROOM_ID);

  let records = await f.store.read(ROOM_ID);
  const root = byKind(records, 'message')[0];
  const rootResults = byKind(records, 'relay_result').filter(r => r.message_id === root.message_id);
  const rootB = rootResults.find(r => r.recipient_identity === 'cid-bob').wire_id;
  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(incoming({
    msg_id: 8, sender_id: 'cid-bob', text: 'B answers A', wire_id: 'wire-B-original',
    reply_to: { wire_id: rootB, sentence: 4 },
  }));
  await f.pump.pump(ROOM_ID);

  records = await f.store.read(ROOM_ID);
  const answer = byKind(records, 'message').find(message => message.text === 'B answers A');
  const answerResults = byKind(records, 'relay_result').filter(r => r.message_id === answer.message_id);
  const answerA = answerResults.find(r => r.recipient_identity === 'cid-alice').wire_id;
  const answerC = answerResults.find(r => r.recipient_identity === 'cid-cara').wire_id;
  assert.deepEqual(answer.source_reply_to, { wire_id: rootB, sentence: 4 });
  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(incoming({
    msg_id: 9, sender_id: 'cid-alice', text: 'A follows up to B', wire_id: 'wire-A-followup',
    reply_to: { wire_id: answerA },
  }));
  await f.pump.pump(ROOM_ID);

  assert.deepEqual(f.packet.sendCalls.map(call => call.recipient), ['cid-bob', 'cid-cara']);
  assert.deepEqual(f.packet.sendCalls.find(call => call.recipient === 'cid-bob').replyTo,
    { wire_id: 'wire-B-original' });
  assert.deepEqual(f.packet.sendCalls.find(call => call.recipient === 'cid-cara').replyTo,
    { wire_id: answerC });
  assert(f.packet.sendCalls.every(call => call.replyTo.sentence === undefined));
});

test('two participant answers remain distinct broadcasts against their own parent copies', async () => {
  const f = fixture();
  let serial = 0;
  f.packet.nextSend = (recipient) => ({ status: 'queued', wire_id: `${recipient}-${++serial}` });
  f.packet.inbox.push(incoming({ wire_id: 'wire-A-root' }));
  await f.pump.pump(ROOM_ID);
  const rootRecords = await f.store.read(ROOM_ID);
  const root = byKind(rootRecords, 'message')[0];
  const rootResults = byKind(rootRecords, 'relay_result').filter(r => r.message_id === root.message_id);
  const rootB = rootResults.find(r => r.recipient_identity === 'cid-bob').wire_id;
  const rootC = rootResults.find(r => r.recipient_identity === 'cid-cara').wire_id;

  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(
    incoming({ msg_id: 8, sender_id: 'cid-bob', text: 'B answer', wire_id: 'wire-B-answer', reply_to: { wire_id: rootB } }),
    incoming({ msg_id: 9, sender_id: 'cid-cara', text: 'C answer', wire_id: 'wire-C-answer', reply_to: { wire_id: rootC } }),
  );
  await f.pump.pump(ROOM_ID);

  const answers = byKind(await f.store.read(ROOM_ID), 'message')
    .filter(message => message.message_id !== root.message_id);
  assert.equal(new Set(answers.map(message => message.message_id)).size, 2);
  assert.deepEqual(answers.map(message => message.source_reply_to.wire_id), [rootB, rootC]);
  const bCalls = f.packet.sendCalls.filter(call => JSON.parse(call.body).text === 'B answer');
  const cCalls = f.packet.sendCalls.filter(call => JSON.parse(call.body).text === 'C answer');
  assert.deepEqual(bCalls.map(call => call.recipient), ['cid-alice', 'cid-cara']);
  assert.deepEqual(cCalls.map(call => call.recipient), ['cid-alice', 'cid-bob']);
  assert.deepEqual(bCalls.map(call => call.replyTo.wire_id), ['wire-A-root', rootC]);
  assert.deepEqual(cCalls.map(call => call.replyTo.wire_id), ['wire-A-root', rootB]);
});

test('late participants get an unthreaded body and a removed parent author gets no send', async () => {
  const f = fixture();
  let serial = 0;
  f.packet.nextSend = (recipient) => ({ status: 'queued', wire_id: `${recipient}-${++serial}` });
  f.packet.inbox.push(incoming({ wire_id: 'wire-A-root' }));
  await f.pump.pump(ROOM_ID);
  const parentRows = await f.store.read(ROOM_ID);
  const parent = byKind(parentRows, 'message')[0];
  const results = byKind(parentRows, 'relay_result').filter(r => r.message_id === parent.message_id);
  const rootB = results.find(r => r.recipient_identity === 'cid-bob').wire_id;
  const rootC = results.find(r => r.recipient_identity === 'cid-cara').wire_id;
  f.store.rooms.get(ROOM_ID).seats.push(activeSeat('cid-dana', 'Dana', 'tester', 'd1'));

  f.packet.sendCalls.length = 0;
  f.packet.afterConsume = async ({ consumed }) => {
    if (!consumed.includes(8)) return;
    const current = f.store.rooms.get(ROOM_ID);
    current.membership_epoch += 1;
    current.seats = current.seats.map(seat => seat.identity === 'cid-alice'
      ? { ...seat, state: 'removed', removed_at: AT, removed_epoch: current.membership_epoch }
      : seat);
  };
  f.packet.inbox.push(incoming({
    msg_id: 8, sender_id: 'cid-bob', text: 'Answer after membership change',
    wire_id: 'wire-B-answer', reply_to: { wire_id: rootB },
  }));
  await f.pump.pump(ROOM_ID);

  assert.deepEqual(f.packet.sendCalls.map(call => call.recipient), ['cid-cara', 'cid-dana']);
  assert.deepEqual(f.packet.sendCalls[0].replyTo, { wire_id: rootC });
  assert.equal('replyTo' in f.packet.sendCalls[1], false);
  const answer = byKind(await f.store.read(ROOM_ID), 'message').find(message => message.text === 'Answer after membership change');
  const answerResults = byKind(await f.store.read(ROOM_ID), 'relay_result')
    .filter(result => result.message_id === answer.message_id);
  assert.deepEqual(answer.recipient_identities, ['cid-alice', 'cid-cara', 'cid-dana']);
  assert.equal(answerResults.find(result => result.recipient_identity === 'cid-alice').status,
    'skipped_removed');
});

test('valid parent keeps legacy per-destination fallback while unknown target is privately refused', async () => {
  const f = fixture();
  f.store.rooms.get(ROOM_ID).seats.push(activeSeat('cid-dana', 'Dana', 'tester', 'd1'));
  f.packet.nextSend = (recipient, body) => {
    const text = JSON.parse(body).text;
    if (text === 'Participant update' && recipient === 'cid-dana') return { status: 'send_failed' };
    return { status: 'queued', wire_id: `${text}:${recipient}` };
  };
  f.packet.inbox.push(incoming({ wire_id: 'wire-A-root' }));
  await f.pump.pump(ROOM_ID);
  const parentRows = await f.store.read(ROOM_ID);
  const parent = byKind(parentRows, 'message')[0];
  const parentResults = byKind(parentRows, 'relay_result').filter(r => r.message_id === parent.message_id);
  const rootB = parentResults.find(r => r.recipient_identity === 'cid-bob').wire_id;

  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(
    incoming({ msg_id: 8, sender_id: 'cid-bob', text: 'Known parent', wire_id: 'wire-B-known', reply_to: { wire_id: rootB } }),
    incoming({ msg_id: 9, sender_id: 'cid-bob', text: 'Unknown parent', wire_id: 'wire-B-unknown', reply_to: { wire_id: 'unrecorded-wire' } }),
  );
  await f.pump.pump(ROOM_ID);

  const known = f.packet.sendCalls.filter(call => JSON.parse(call.body).text === 'Known parent');
  const unknown = f.packet.sendCalls.filter(call => JSON.parse(call.body).text === 'Unknown parent');
  assert.deepEqual(known.map(call => call.recipient), ['cid-alice', 'cid-cara', 'cid-dana']);
  assert.deepEqual(known.find(call => call.recipient === 'cid-alice').replyTo, { wire_id: 'wire-A-root' });
  assert.equal('replyTo' in known.find(call => call.recipient === 'cid-dana'), false);
  assert.deepEqual(unknown, []);
  assert.equal(f.packet.sendCalls.filter(call => JSON.parse(call.body).text === 'reply_target_unavailable')[0].recipient, 'cid-bob');
  const archivedUnknown = byKind(await f.store.read(ROOM_ID), 'message')
    .find(message => message.text === 'Unknown parent');
  assert.equal(archivedUnknown, undefined);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'intake_rejection').length, 1);
});

test('a conflicting destination wire is omitted while another destination keeps its valid parent', async () => {
  const firstId = MESSAGE_IDS[2];
  const otherId = MESSAGE_IDS[3];
  const records = [
    {
      version: 1, kind: 'message', room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: AT,
      message_id: firstId, author: { identity: 'cid-alice', display_name: 'Alice', role: 'builder' },
      category: 'chat', text: 'First parent', source_wire_id: 'wire-A-first',
      recipient_identities: ['cid-bob', 'cid-cara'],
    },
    { version: 1, kind: 'relay_intent', room_id: ROOM_ID, seq: 2, record_id: `${ROOM_ID}:2`, at: AT,
      message_id: firstId, recipient_identity: 'cid-bob' },
    { version: 1, kind: 'relay_result', room_id: ROOM_ID, seq: 3, record_id: `${ROOM_ID}:3`, at: AT,
      intent_record_id: `${ROOM_ID}:2`, message_id: firstId, recipient_identity: 'cid-bob',
      status: 'queued', wire_id: 'wire-first-bob' },
    { version: 1, kind: 'relay_intent', room_id: ROOM_ID, seq: 4, record_id: `${ROOM_ID}:4`, at: AT,
      message_id: firstId, recipient_identity: 'cid-cara' },
    { version: 1, kind: 'relay_result', room_id: ROOM_ID, seq: 5, record_id: `${ROOM_ID}:5`, at: AT,
      intent_record_id: `${ROOM_ID}:4`, message_id: firstId, recipient_identity: 'cid-cara',
      status: 'queued', wire_id: 'wire-shared-cara' },
    {
      version: 1, kind: 'message', room_id: ROOM_ID, seq: 6, record_id: `${ROOM_ID}:6`, at: AT,
      message_id: otherId, author: { identity: 'cid-bob', display_name: 'Bob', role: 'reviewer' },
      category: 'chat', text: 'Other parent', source_wire_id: 'wire-B-other',
      recipient_identities: ['cid-cara'],
    },
    { version: 1, kind: 'relay_intent', room_id: ROOM_ID, seq: 7, record_id: `${ROOM_ID}:7`, at: AT,
      message_id: otherId, recipient_identity: 'cid-cara' },
    { version: 1, kind: 'relay_result', room_id: ROOM_ID, seq: 8, record_id: `${ROOM_ID}:8`, at: AT,
      intent_record_id: `${ROOM_ID}:7`, message_id: otherId, recipient_identity: 'cid-cara',
      status: 'queued', wire_id: 'wire-shared-cara' },
  ];
  const f = fixture({ records });
  f.packet.inbox.push(incoming({
    sender_id: 'cid-bob', wire_id: 'wire-B-child', text: 'Child of first parent',
    reply_to: { wire_id: 'wire-first-bob' },
  }));
  await f.pump.pump(ROOM_ID);

  const calls = f.packet.sendCalls.filter(call => JSON.parse(call.body).text === 'Child of first parent');
  assert.deepEqual(calls.map(call => call.recipient), ['cid-alice', 'cid-cara']);
  assert.deepEqual(calls[0].replyTo, { wire_id: 'wire-A-first' });
  assert.equal('replyTo' in calls[1], false);

  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(incoming({
    msg_id: 8, sender_id: 'cid-cara', wire_id: 'wire-C-child', text: 'Ambiguous child',
    reply_to: { wire_id: 'wire-shared-cara' },
  }));
  await f.pump.pump(ROOM_ID);
  const ambiguous = f.packet.sendCalls.filter(call => JSON.parse(call.body).text === 'Ambiguous child');
  assert.deepEqual(ambiguous, []);
  assert.deepEqual(f.packet.sendCalls.map(call => call.recipient), ['cid-cara']);
  assert.equal(JSON.parse(f.packet.sendCalls[0].body).text, 'reply_target_unavailable');
  const archived = byKind(await f.store.read(ROOM_ID), 'message')
    .find(message => message.text === 'Ambiguous child');
  assert.equal(archived, undefined);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'intake_rejection').length, 1);
});

test('answers to a room-authored parent use participant copies and never self-send', async () => {
  const f = fixture();
  let serial = 0;
  f.packet.nextSend = (recipient) => ({ status: 'queued', wire_id: `${recipient}-${++serial}` });
  const parent = await f.service.postMessage(ROOM_ID, { text: 'Room direction' });
  const records = await f.store.read(ROOM_ID);
  const results = byKind(records, 'relay_result').filter(result => result.message_id === parent.message_id);
  const parentB = results.find(result => result.recipient_identity === 'cid-bob').wire_id;
  const parentA = results.find(result => result.recipient_identity === 'cid-alice').wire_id;
  const parentC = results.find(result => result.recipient_identity === 'cid-cara').wire_id;

  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(incoming({
    sender_id: 'cid-bob', wire_id: 'wire-B-answer', text: 'Reply to room', reply_to: { wire_id: parentB },
  }));
  await f.pump.pump(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls.map(call => call.recipient), ['cid-alice', 'cid-cara']);
  assert.deepEqual(f.packet.sendCalls.map(call => call.replyTo.wire_id), [parentA, parentC]);
  assert(f.packet.sendCalls.every(call => call.recipient !== 'cid-room'));
});

test('restart intake drains legacy invalid file metadata without archiving it or blocking later files', async () => {
  const f = fixture();
  f.packet.fileInbox.push(
    incomingFile({ file_id: 8, filename: '../poison.bin' }),
    incomingFile({ file_id: 9, mime: 'x'.repeat(256) }),
    incomingFile({ file_id: 10, filename: 'after-restart.bin', data: Buffer.from('usable') }),
  );

  await f.pump.resumePending(ROOM_ID);

  assert.deepEqual(f.packet.consumeFileCalls, [[8], [9], [10]]);
  assert.deepEqual(f.packet.fileInbox, []);
  const files = byKind(await f.store.read(ROOM_ID), 'file');
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'after-restart.bin');
  assert.equal(JSON.stringify(await f.store.read(ROOM_ID)).includes('poison.bin'), false);
});

test('participant files archive bytes before consume and relay a readable notice before bytes to every other seat', async () => {
  const f = fixture();
  f.packet.fileInbox.push(incomingFile());
  const sends = [];
  f.packet.beforeSend = (recipient, body) => sends.push(['notice', recipient, JSON.parse(body).text]);
  f.packet.beforeSendFile = (recipient) => sends.push(['file', recipient]);

  await f.pump.pump(ROOM_ID);

  const records = await f.store.read(ROOM_ID);
  const [file] = byKind(records, 'file');
  assert.equal(file.filename, 'evidence.bin');
  assert.equal(file.mime, 'application/octet-stream');
  assert.equal(file.size, 4);
  assert.equal(file.data_base64, Buffer.from([0, 1, 2, 255]).toString('base64'));
  assert.deepEqual(file.author, { identity: 'cid-alice', display_name: 'Alice', role: 'builder' });
  assert.deepEqual(file.recipient_identities, ['cid-bob', 'cid-cara']);
  assert.deepEqual(f.packet.consumeFileCalls, [[9]]);
  assert.deepEqual(f.packet.sendFileCalls.map((call) => call.recipient), ['cid-bob', 'cid-cara']);
  assert(f.packet.sendFileCalls.every((call) => call.data.equals(Buffer.from([0, 1, 2, 255]))));
  assert.deepEqual(byKind(records, 'relay_intent').map((intent) => intent.file_id), [file.file_id, file.file_id]);
  assert.deepEqual(byKind(records, 'relay_result').map((result) => ({
    file_id: result.file_id,
    status: result.status,
    wire_id: result.wire_id,
    metadata_wire_id: result.metadata_wire_id,
  })), [
    { file_id: file.file_id, status: 'queued', wire_id: 'wire-file-out', metadata_wire_id: 'wire-out' },
    { file_id: file.file_id, status: 'queued', wire_id: 'wire-file-out', metadata_wire_id: 'wire-out' },
  ]);
  assert.deepEqual(sends, [
    ['notice', 'cid-bob', 'Alice sent a file'],
    ['file', 'cid-bob'],
    ['notice', 'cid-cara', 'Alice sent a file'],
    ['file', 'cid-cara'],
  ]);
  const notice = JSON.parse(f.packet.sendCalls[0].body);
  assert.deepEqual(notice, {
    version: 1,
    kind: 'room_msg',
    room_id: ROOM_ID,
    room_name: 'Release room',
    message_id: file.file_id,
    author: { identity: room().identity_cid, display_name: room().identity_name, role: 'room' },
    text: 'Alice sent a file',
    at: file.at,
  });
  assert.equal(f.packet.sendCalls[0].body, canonicalJson(notice));
});

test('file reply sends notice and bytes with each recipient parent reference', async () => {
  const f = fixture();
  let serial = 0;
  f.packet.nextSend = () => ({ status: 'queued', wire_id: `wire-relay-${++serial}` });
  f.packet.inbox.push(incoming({ wire_id: 'wire-A-original' }));
  await f.pump.pump(ROOM_ID);

  const archive = await f.store.read(ROOM_ID);
  const parent = byKind(archive, 'message')[0];
  const copies = byKind(archive, 'relay_result').filter(r => r.message_id === parent.message_id);
  const parentB = copies.find(r => r.recipient_identity === 'cid-bob').wire_id;
  const parentC = copies.find(r => r.recipient_identity === 'cid-cara').wire_id;
  f.packet.sendCalls.length = 0;
  f.packet.sendFileCalls.length = 0;

  f.packet.fileInbox.push(incomingFile({ sender_id: 'cid-bob', wire_id: 'wire-B-file-answer',
    reply_to: { wire_id: parentB, sentence: 3 } }));
  await f.pump.pump(ROOM_ID);

  const storedReplyFile = byKind(await f.store.read(ROOM_ID), 'file')
    .find(file => file.source_wire_id === 'wire-B-file-answer');
  assert.deepEqual(storedReplyFile.source_reply_to, { wire_id: parentB, sentence: 3 });
  assert.deepEqual(f.packet.sendCalls.map(c => c.recipient), ['cid-alice', 'cid-cara']);
  assert.deepEqual(f.packet.sendFileCalls.map(c => c.recipient), ['cid-alice', 'cid-cara']);
  for (const calls of [f.packet.sendCalls, f.packet.sendFileCalls]) {
    assert.deepEqual(calls.find(c => c.recipient === 'cid-alice').replyTo,
      { wire_id: 'wire-A-original' });
    assert.deepEqual(calls.find(c => c.recipient === 'cid-cara').replyTo,
      { wire_id: parentC });
    assert(calls.every(call => call.replyTo.sentence === undefined));
  }
});

test('binary and notice replies resolve one file and use the earliest recipient result fallback', async () => {
  const f = fixture();
  f.packet.nextSend = (recipient) => ({ status: 'queued', wire_id: `notice-${recipient}` });
  f.packet.nextSendFile = (recipient) => recipient === 'cid-cara'
    ? { status: 'queued' }
    : { status: 'queued', wire_id: `binary-${recipient}` };
  f.packet.fileInbox.push(incomingFile({ wire_id: 'wire-A-file-original' }));
  await f.pump.pump(ROOM_ID);

  let records = await f.store.read(ROOM_ID);
  const file = byKind(records, 'file')[0];
  const initial = byKind(records, 'relay_result').filter(result => result.file_id === file.file_id);
  const bResult = initial.find(result => result.recipient_identity === 'cid-bob');
  const cResult = initial.find(result => result.recipient_identity === 'cid-cara');
  assert.equal(cResult.wire_id, undefined);
  assert.equal(cResult.metadata_wire_id, 'notice-cid-cara');

  const laterIntent = await f.store.append(ROOM_ID, {
    version: 1, kind: 'relay_intent', room_id: ROOM_ID, at: AT,
    file_id: file.file_id, recipient_identity: 'cid-cara',
  });
  await f.store.append(ROOM_ID, {
    version: 1, kind: 'relay_result', room_id: ROOM_ID, at: AT,
    intent_record_id: laterIntent.record_id, file_id: file.file_id,
    recipient_identity: 'cid-cara', status: 'queued', wire_id: 'later-binary-cara',
    metadata_wire_id: 'later-notice-cara',
  });

  f.packet.sendCalls.length = 0;
  f.packet.sendFileCalls.length = 0;
  f.packet.nextSend = (recipient, body) => ({
    status: 'queued', wire_id: `${JSON.parse(body).text}:${recipient}`,
  });
  f.packet.inbox.push(
    incoming({ msg_id: 10, sender_id: 'cid-bob', text: 'Reply to binary', wire_id: 'wire-B-binary-answer',
      reply_to: { wire_id: bResult.wire_id } }),
    incoming({ msg_id: 11, sender_id: 'cid-bob', text: 'Reply to notice', wire_id: 'wire-B-notice-answer',
      reply_to: { wire_id: bResult.metadata_wire_id } }),
  );
  await f.pump.pump(ROOM_ID);

  for (const text of ['Reply to binary', 'Reply to notice']) {
    const calls = f.packet.sendCalls.filter(call => JSON.parse(call.body).text === text);
    assert.deepEqual(calls.map(call => call.recipient), ['cid-alice', 'cid-cara']);
    assert.deepEqual(calls.find(call => call.recipient === 'cid-alice').replyTo,
      { wire_id: 'wire-A-file-original' });
    assert.deepEqual(calls.find(call => call.recipient === 'cid-cara').replyTo,
      { wire_id: 'notice-cid-cara' });
  }
  records = await f.store.read(ROOM_ID);
  assert.deepEqual(byKind(records, 'message').map(message => message.source_reply_to.wire_id),
    [bResult.wire_id, bResult.metadata_wire_id]);

  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(incoming({
    msg_id: 12, sender_id: 'cid-cara', text: 'C replies to its notice', wire_id: 'wire-C-answer',
    reply_to: { wire_id: cResult.metadata_wire_id },
  }));
  await f.pump.pump(ROOM_ID);
  const cReply = f.packet.sendCalls.filter(call => JSON.parse(call.body).text === 'C replies to its notice');
  assert.deepEqual(cReply.map(call => call.recipient), ['cid-alice', 'cid-bob']);
  assert.deepEqual(cReply.find(call => call.recipient === 'cid-alice').replyTo,
    { wire_id: 'wire-A-file-original' });
  assert.deepEqual(cReply.find(call => call.recipient === 'cid-bob').replyTo,
    { wire_id: bResult.wire_id });
});

test('a refused file notice prevents binary sends and records terminal failures', async () => {
  const f = fixture();
  f.packet.fileInbox.push(incomingFile());
  f.packet.nextSend = { status: 'send_failed' };
  await f.pump.pump(ROOM_ID);
  assert.equal(f.packet.sendCalls.length, 2);
  assert.equal(f.packet.sendFileCalls.length, 0);
  const results = byKind(await f.store.read(ROOM_ID), 'relay_result');
  assert.equal(results.length, 2);
  assert(results.every((result) => result.status === 'send_failed' && result.wire_id === undefined));
});

test('file crash redrive keeps archive/intents stable and retries only a result-less recipient', async () => {
  const f = fixture();
  f.store.rooms.set(ROOM_ID, room({ seats: room().seats.slice(0, 2) }));
  f.packet.fileInbox.push(incomingFile());
  let crashBeforeConsume = true;
  f.packet.beforeConsumeFile = () => {
    if (crashBeforeConsume) {
      crashBeforeConsume = false;
      throw new Error('crash after durable file intents');
    }
  };
  await assert.rejects(f.pump.pump(ROOM_ID), /durable file intents/);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'file').length, 1);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_intent').length, 1);
  assert.equal(f.packet.sendFileCalls.length, 0, 'consume precedes every file send');

  f.packet.beforeConsumeFile = undefined;
  let crashBeforeResult = true;
  f.store.beforeAppend = (draft) => {
    if (crashBeforeResult && draft.kind === 'relay_result') {
      crashBeforeResult = false;
      throw new Error('crash before file result fsync');
    }
  };
  await assert.rejects(f.pump.pump(ROOM_ID), /file result fsync/);
  assert.equal(f.packet.sendFileCalls.length, 1);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 0);

  f.store.beforeAppend = undefined;
  await f.pump.resumePending(ROOM_ID);
  assert.equal(f.packet.sendFileCalls.length, 2);
  assert(f.packet.sendFileCalls[0].data.equals(f.packet.sendFileCalls[1].data));
  assert.equal(f.packet.sendCalls[0].body, f.packet.sendCalls[1].body, 'notice retry keeps the stable message_id and body');
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 1);
  await f.pump.resumePending(ROOM_ID);
  assert.equal(f.packet.sendFileCalls.length, 2, 'terminal file result suppresses later redrive');
});

test('a file intent frozen before seat removal resolves skipped_removed without sending bytes or metadata', async () => {
  const f = fixture();
  f.packet.fileInbox.push(incomingFile());
  let crash = true;
  f.packet.beforeConsumeFile = () => {
    if (crash) {
      crash = false;
      throw new Error('freeze file fanout before removal');
    }
  };
  await assert.rejects(f.pump.pump(ROOM_ID), /freeze file fanout/);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_intent').length, 2);

  const changed = await f.store.load(ROOM_ID);
  changed.membership_epoch += 1;
  changed.seats = changed.seats.map((seat) => seat.identity === 'cid-bob'
    ? { ...seat, state: 'removed', removed_at: AT, removed_epoch: changed.membership_epoch }
    : seat);
  await f.store.save(changed);
  f.packet.beforeConsumeFile = undefined;

  await f.pump.pump(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls.map((call) => call.recipient), ['cid-cara']);
  assert.deepEqual(f.packet.sendFileCalls.map((call) => call.recipient), ['cid-cara']);
  const results = byKind(await f.store.read(ROOM_ID), 'relay_result');
  assert.deepEqual(
    results.map((result) => [result.recipient_identity, result.status]).sort(),
    [['cid-bob', 'skipped_removed'], ['cid-cara', 'queued']],
  );
  await f.pump.resumePending(ROOM_ID);
  assert.equal(f.packet.sendFileCalls.length, 1, 'terminal skip and queue results suppress every later retry');
});

test('oversized files fail loudly without archive, consume, or relay effects', async () => {
  const f = fixture();
  f.packet.fileInbox.push(incomingFile({ data: Buffer.alloc(2 * 1024 * 1024 + 1) }));
  await assert.rejects(f.pump.pump(ROOM_ID), /at most 2097152 bytes \(2 MiB\)/);
  assert.deepEqual(await f.store.read(ROOM_ID), []);
  assert.equal(f.packet.fileInbox.length, 1);
  assert.equal(f.packet.consumeFileCalls.length, 0);
  assert.equal(f.packet.sendFileCalls.length, 0);
});

test('anonymous file notices use only the stored alias and never leak real seat or claimed names', async () => {
  const f = fixture({ room: anonymousRoom() });
  f.packet.fileInbox.push(incomingFile());
  await f.pump.pump(ROOM_ID);
  const [file] = byKind(await f.store.read(ROOM_ID), 'file');
  assert.equal(file.author.identity, 'cid-alice');
  assert.equal(file.author_alias.alias, 'builder #1');
  for (const call of f.packet.sendCalls.map((send) => send.body)) {
    const bytes = Buffer.from(call, 'utf8');
    for (const leak of ['cid-alice', 'Alice', 'cid-bob', 'cid-cara', 'Untrusted current name']) {
      assert.equal(bytes.includes(leak), false, `${leak} leaked into file metadata`);
    }
  }
  const notice = JSON.parse(f.packet.sendCalls[0].body);
  assert.equal(notice.kind, 'room_msg');
  assert.equal(notice.text, 'builder #1 sent a file');
  assert.deepEqual(notice.author, {
    identity: anonymousRoom().identity_cid,
    display_name: anonymousRoom().identity_name,
    role: 'room',
  });
});

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

  const envelope = JSON.parse(f.packet.sendCalls[0].body);
  assert.deepEqual(envelope, {
    at: incoming().date,
    author: message.author,
    kind: 'room_msg',
    message_id: message.message_id,
    room_id: ROOM_ID,
    room_name: 'Release room',
    text: incoming().text,
    version: 1,
  });
  assert.equal('signature' in envelope, false);
  assert.equal('recipient_identities' in envelope, false);
  assert.deepEqual(Object.keys(JSON.parse(f.packet.sendCalls[0].body)).sort(),
    ['at', 'author', 'kind', 'message_id', 'room_id', 'room_name', 'text', 'version']);
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
  let attempt = 0;
  f.packet.nextSend = () => ({ status: 'queued', wire_id: `wire-attempt-${++attempt}` });
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
  let restartedMessage = 1;
  const restarted = new IntakePump(f.store, f.registry, {
    now: () => AT, messageId: () => MESSAGE_IDS[restartedMessage++],
  });
  await restarted.resumePending(ROOM_ID);
  assert.equal(f.packet.sendCalls.length, 2, 'the result-less durable intent is deliberately retried');
  assert.equal(f.packet.sendCalls[0].body, f.packet.sendCalls[1].body, 'retry keeps the canonical envelope byte-stable');
  assert.equal(JSON.parse(f.packet.sendCalls[0].body).message_id, MESSAGE_IDS[0]);
  const results = byKind(await f.store.read(ROOM_ID), 'relay_result');
  assert.equal(results.length, 1, 'one eventual terminal result belongs to the durable intent');
  assert.equal(results[0].intent_record_id, `${ROOM_ID}:2`);
  assert.equal(results[0].wire_id, 'wire-attempt-2');

  const secondRestart = new IntakePump(f.store, f.registry, { now: () => AT, messageId: () => MESSAGE_IDS[3] });
  await secondRestart.resumePending(ROOM_ID);
  assert.equal(f.packet.sendCalls.length, 2);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 1);

  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(
    incoming({ msg_id: 8, sender_id: 'cid-bob', text: 'Reply to unrecorded attempt',
      wire_id: 'wire-B-unknown', reply_to: { wire_id: 'wire-attempt-1' } }),
    incoming({ msg_id: 9, sender_id: 'cid-bob', text: 'Reply to durable attempt',
      wire_id: 'wire-B-known', reply_to: { wire_id: 'wire-attempt-2' } }),
  );
  await restarted.pump(ROOM_ID);
  const unknown = f.packet.sendCalls.find(call => JSON.parse(call.body).text === 'Reply to unrecorded attempt');
  const known = f.packet.sendCalls.find(call => JSON.parse(call.body).text === 'Reply to durable attempt');
  assert.equal(unknown, undefined, 'an unrecorded accepted wire never gains recovery authority');
  assert.equal(byKind(await f.store.read(ROOM_ID), 'intake_rejection').length, 1);
  assert.deepEqual(known.replyTo, { wire_id: 'wire-in-7' });
  const children = byKind(await f.store.read(ROOM_ID), 'message').filter(message => message.source_msg_id !== 7);
  assert.equal(children.length, 1, 'only the durable target produces a child message');
});

test('thrown send failures leave intents result-less and create no ghost results', async () => {
  const f = fixture();
  f.store.rooms.set(ROOM_ID, room({ seats: room().seats.slice(0, 2) }));
  f.packet.inbox.push(incoming());
  let failSend = true;
  f.packet.beforeSend = () => {
    if (failSend) {
      failSend = false;
      throw new Error('send outcome unknown');
    }
  };
  await assert.rejects(f.pump.pump(ROOM_ID), /send outcome unknown/);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 0);

  await f.pump.resumePending(ROOM_ID);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 1);
});

test('late parent evidence affects only a pending attempt and never replays delivered copies', async () => {
  const parentId = MESSAGE_IDS[3];
  const records = [
    {
      version: 1, kind: 'message', room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: AT,
      message_id: parentId,
      author: { identity: 'cid-alice', display_name: 'Alice', role: 'builder' },
      category: 'chat', text: 'Earlier parent', source_msg_id: 6, source_wire_id: 'wire-A-parent',
      recipient_identities: ['cid-bob', 'cid-cara', 'cid-dana'],
    },
    { version: 1, kind: 'relay_intent', room_id: ROOM_ID, seq: 2, record_id: `${ROOM_ID}:2`, at: AT,
      message_id: parentId, recipient_identity: 'cid-bob' },
    { version: 1, kind: 'relay_result', room_id: ROOM_ID, seq: 3, record_id: `${ROOM_ID}:3`, at: AT,
      intent_record_id: `${ROOM_ID}:2`, message_id: parentId, recipient_identity: 'cid-bob',
      status: 'queued', wire_id: 'wire-parent-bob' },
    { version: 1, kind: 'relay_intent', room_id: ROOM_ID, seq: 4, record_id: `${ROOM_ID}:4`, at: AT,
      message_id: parentId, recipient_identity: 'cid-cara' },
    { version: 1, kind: 'relay_result', room_id: ROOM_ID, seq: 5, record_id: `${ROOM_ID}:5`, at: AT,
      intent_record_id: `${ROOM_ID}:4`, message_id: parentId, recipient_identity: 'cid-cara',
      status: 'send_failed' },
    { version: 1, kind: 'relay_intent', room_id: ROOM_ID, seq: 6, record_id: `${ROOM_ID}:6`, at: AT,
      message_id: parentId, recipient_identity: 'cid-dana' },
    { version: 1, kind: 'relay_result', room_id: ROOM_ID, seq: 7, record_id: `${ROOM_ID}:7`, at: AT,
      intent_record_id: `${ROOM_ID}:6`, message_id: parentId, recipient_identity: 'cid-dana',
      status: 'send_failed' },
  ];
  const f = fixture({
    records,
    room: { seats: [...room().seats, activeSeat('cid-dana', 'Dana', 'tester', 'd1')] },
  });
  f.packet.nextSend = (recipient) => ({ status: 'queued', wire_id: `wire-child-${recipient}` });
  let crashDana = true;
  f.packet.beforeSend = (recipient, body) => {
    if (crashDana && recipient === 'cid-dana' && JSON.parse(body).text === 'Child with late evidence') {
      crashDana = false;
      throw new Error('crash before Dana outcome');
    }
  };
  f.packet.inbox.push(incoming({
    sender_id: 'cid-bob', wire_id: 'wire-B-child', text: 'Child with late evidence',
    reply_to: { wire_id: 'wire-parent-bob' },
  }));
  await assert.rejects(f.pump.pump(ROOM_ID), /Dana outcome/);
  const firstAttempts = f.packet.sendCalls.filter(call => JSON.parse(call.body).text === 'Child with late evidence');
  assert.deepEqual(firstAttempts.map(call => call.recipient), ['cid-alice', 'cid-cara', 'cid-dana']);
  assert.deepEqual(firstAttempts[0].replyTo, { wire_id: 'wire-A-parent' });
  assert.equal('replyTo' in firstAttempts[1], false);
  assert.equal('replyTo' in firstAttempts[2], false);

  await f.store.append(ROOM_ID, {
    version: 1, kind: 'relay_result', room_id: ROOM_ID, at: AT,
    intent_record_id: `${ROOM_ID}:4`, message_id: parentId, recipient_identity: 'cid-cara',
    status: 'queued', wire_id: 'wire-parent-cara-late',
  });
  await f.store.append(ROOM_ID, {
    version: 1, kind: 'relay_result', room_id: ROOM_ID, at: AT,
    intent_record_id: `${ROOM_ID}:6`, message_id: parentId, recipient_identity: 'cid-dana',
    status: 'queued', wire_id: 'wire-parent-dana-late',
  });
  f.packet.beforeSend = undefined;
  f.packet.sendCalls.length = 0;
  const restarted = new IntakePump(f.store, f.registry, { now: () => AT, messageId: () => MESSAGE_IDS[1] });
  await restarted.resumePending(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls.map(call => call.recipient), ['cid-dana']);
  assert.deepEqual(f.packet.sendCalls[0].replyTo, { wire_id: 'wire-parent-dana-late' });
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

test('non-seat and non-active messages are consumed but never archived or relayed', async () => {
  for (const roomOverride of [{}, { state: 'provisioning', activated_at: undefined }]) {
    const f = fixture({ room: roomOverride });
    f.packet.inbox.push(incoming(roomOverride.state ? {} : { sender_id: 'cid-outsider' }));
    await f.pump.pump(ROOM_ID);
    assert.equal(f.packet.inbox.length, 0);
    assert.deepEqual(await f.store.read(ROOM_ID), []);
    assert.equal(f.packet.sendCalls.length, 0);
  }
});

test('an older row promoted after listing takes the full intake path before the expected acknowledgement retries', async () => {
  const f = fixture();
  f.packet.inbox.push(incoming({
    msg_id: 8, sender_id: 'cid-bob', wire_id: 'wire-in-8', text: 'Expected snapshot row',
  }));
  let injected = false;
  f.packet.beforeConsume = () => {
    if (!injected) {
      injected = true;
      f.packet.inbox.unshift(incoming({ msg_id: 7, wire_id: 'wire-in-7', text: 'Older introduction row' }));
    }
  };
  await f.pump.pump(ROOM_ID);
  const records = await f.store.read(ROOM_ID);
  assert.deepEqual(byKind(records, 'message').map((message) => message.source_msg_id), [8, 7]);
  assert.deepEqual(f.packet.consumeCalls, [[7], [8]], 'each SDK read result is handled exactly once');
  assert.deepEqual(f.packet.acknowledgeCalls, [8], 'the already-read promoted row is never acknowledged again');
  assert.equal(byKind(records, 'relay_intent').length, 4);
  assert.equal(byKind(records, 'relay_result').length, 4);
  assert.deepEqual(f.packet.inbox, []);
});

test('typed command draining runs under the room mutex before each ordinary inbox snapshot', async () => {
  const f = fixture();
  let first = true;
  f.packet.onDrain = async (onUnexpected) => {
    if (!first) return;
    first = false;
    await onUnexpected(incoming({ text: 'Raced ordinary row', wire_id: 'wire-raced-text' }));
  };
  await f.pump.pump(ROOM_ID);
  const messages = (await f.store.read(ROOM_ID)).filter((record) => record.kind === 'message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source_wire_id, 'wire-raced-text');
  assert.equal(f.packet.drainCalls >= 1, true);
  assert.deepEqual(f.packet.listCalls.slice(0, 2).map(([kind]) => kind), ['messages', 'files']);
});

test('an empty acknowledgement response treats the durably archived expected row as already read', async () => {
  const f = fixture();
  f.store.rooms.set(ROOM_ID, room({ seats: room().seats.slice(0, 2) }));
  f.packet.inbox.push(incoming());
  f.packet.beforeConsume = () => { f.packet.inbox = []; };

  await f.pump.pump(ROOM_ID);

  const records = await f.store.read(ROOM_ID);
  assert.deepEqual(f.packet.acknowledgeCalls, [7]);
  assert.deepEqual(f.packet.consumeCalls, []);
  assert.equal(byKind(records, 'message').length, 1);
  assert.equal(byKind(records, 'relay_intent').length, 1);
  assert.equal(byKind(records, 'relay_result').length, 1);
});

test('intake bounds each history query and services files between message backlog batches', async () => {
  const f = fixture({ room: { state: 'provisioning', activated_at: undefined } });
  for (let msgId = 1; msgId <= 40; msgId += 1) {
    f.packet.inbox.push(incoming({ msg_id: msgId, wire_id: `wire-backlog-${msgId}` }));
  }
  f.packet.fileInbox.push(incomingFile({ file_id: 41, wire_id: 'wire-backlog-file' }));

  await f.pump.pump(ROOM_ID);

  assert(f.packet.listCalls.every(([, limit]) => limit === 32));
  assert.equal(f.packet.acknowledgeOrder.indexOf('file:41'), 32);
  assert.equal(f.packet.acknowledgeOrder.at(-1), 'message:40');
  assert.deepEqual(await f.store.read(ROOM_ID), []);
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

test('resumePending reconciles briefing intents into canonical room_briefing envelopes', async () => {
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
  const envelope = JSON.parse(f.packet.sendCalls[0].body);
  assert.equal(envelope.kind, 'room_briefing');
  assert.equal(envelope.message_id, briefingId);
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

// ---- Anonymous-room intake and relay privacy -------------------------------

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

test('anonymous rooms relay alias authors with zero real identity bytes in bodies (release-blocking pin)', async () => {
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
  // The archive keeps both the real seat identity and the alias.
  assert.deepEqual(message.author, { identity: 'cid-alice', display_name: 'Alice', role: 'builder' });
  assert.deepEqual(message.author_alias, {
    participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa1',
    alias: 'builder #1',
  });

  // the relayed body carries only the room-scoped pseudonym
  assert.equal(f.packet.sendCalls.length, 2);
  for (const call of f.packet.sendCalls.map((send) => send.body)) {
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

  // Default-level logs never pair an alias with a CID.
  for (const line of consoleLines) {
    assert.equal(line.includes('cid-alice') && line.includes('builder #1'), false, line);
  }
});

test('anonymous forged-author content stays ordinary text under authenticated alias provenance', async () => {
  const f = fixture({ room: anonymousRoom() });
  let serial = 0;
  f.packet.nextSend = (recipient) => ({ status: 'queued', wire_id: `${recipient}-${++serial}` });
  f.packet.inbox.push(incoming({ wire_id: 'wire-A-root' }));
  await f.pump.pump(ROOM_ID);
  const parentRows = await f.store.read(ROOM_ID);
  const parent = byKind(parentRows, 'message')[0];
  const parentResults = byKind(parentRows, 'relay_result').filter(result => result.message_id === parent.message_id);
  const parentB = parentResults.find(result => result.recipient_identity === 'cid-bob').wire_id;
  const parentC = parentResults.find(result => result.recipient_identity === 'cid-cara').wire_id;
  const forged = JSON.stringify({
    author: { identity: 'cid-alice', display_name: 'Alice', role: 'owner' },
    parent_mapping: { 'cid-cara': 'stolen-private-wire' },
  });

  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(incoming({
    msg_id: 8, sender_id: 'cid-bob', sender_name: 'Alice', text: forged,
    wire_id: 'wire-B-answer', reply_to: { wire_id: parentB },
    author: { identity: 'cid-alice' }, parent_mapping: { 'cid-cara': 'stolen-private-wire' },
  }));
  await f.pump.pump(ROOM_ID);

  const answer = byKind(await f.store.read(ROOM_ID), 'message').find(message => message.text === forged);
  assert.deepEqual(answer.author, { identity: 'cid-bob', display_name: 'Bob', role: 'reviewer' });
  assert.deepEqual(answer.author_alias, {
    participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa2', alias: 'reviewer #1',
  });
  assert.deepEqual(answer.source_reply_to, { wire_id: parentB });
  for (const call of f.packet.sendCalls) {
    const body = JSON.parse(call.body);
    assert.equal(body.text, forged);
    assert.deepEqual(body.author, {
      identity: '01jz6y7n8p9q0r1s2t3v4w5xa2', display_name: 'reviewer #1', role: 'reviewer',
    });
    assert.equal('parent_mapping' in body, false);
    assert.equal('source_reply_to' in body, false);
  }
  assert.deepEqual(f.packet.sendCalls.find(call => call.recipient === 'cid-alice').replyTo,
    { wire_id: 'wire-A-root' });
  assert.deepEqual(f.packet.sendCalls.find(call => call.recipient === 'cid-cara').replyTo,
    { wire_id: parentC });
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

test('role-authored messages in anonymous rooms inherit the room-voice exemption from aliasing', async () => {
  // A REST role is room-side authorship, so it takes the same unaliased path the
  // room's own voice already takes here. The alias invariants constrain SEATS;
  // There is no seat to substitute, so seat-alias rules do not apply.
  const f = fixture({ room: anonymousRoom({ rest_roles: ['Bot'] }) });
  await f.service.postAsRole(ROOM_ID, { role: 'Bot', text: 'Scripted update.' });
  assert.equal(f.packet.sendCalls.length, 3);
  for (const call of f.packet.sendCalls) {
    const body = JSON.parse(call.body);
    assert.deepEqual(body.author, { identity: 'cid-room', display_name: 'Bot', role: 'Bot' });
    assert.equal('author_alias' in body, false);
    // No `via` marker and no other new field: author.identity + author.role already
    // discriminate, so the relayed key set stays exactly what it pins above.
    assert.deepEqual(Object.keys(body).sort(),
      ['at', 'author', 'kind', 'message_id', 'room_id', 'room_name', 'text', 'version']);
    for (const leak of ['cid-alice', 'cid-bob', 'cid-cara', 'Alice', 'Bob', 'Cara', 'builder #1']) {
      assert.equal(Buffer.from(call.body, 'utf8').includes(leak), false, `${leak} leaked into a role body`);
    }
  }
  const [message] = byKind(await f.store.read(ROOM_ID), 'message');
  assert.equal(message.author_alias, undefined);
});

test('history views: participant redacts to alias form and drops identities; operator keeps both', async () => {
  const f = fixture({ room: anonymousRoom() });
  const sourceReply = { wire_id: 'private-parent-wire', sentence: 3 };
  await seedLegacyParent(f, sourceReply.wire_id);
  f.packet.inbox.push(incoming({ reply_to: sourceReply }));
  await f.pump.pump(ROOM_ID);
  f.packet.sendCalls.length = 0;

  const operatorView = await f.service.history(ROOM_ID, { after: 1 });
  assert.equal(f.packet.sendCalls.length, 0);
  assert.equal(operatorView.some((record) => record.kind === 'relay_intent'), true);
  const operatorMessage = operatorView.find((record) => record.kind === 'message');
  assert.equal(operatorMessage.author.identity, 'cid-alice');
  assert.equal(operatorMessage.author_alias.alias, 'builder #1');
  assert.deepEqual(operatorMessage.source_reply_to, sourceReply);

  const participantView = await f.service.history(ROOM_ID, { view: 'participant', after: 1 });
  assert.equal(f.packet.sendCalls.length, 0);
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
  assert.equal('source_reply_to' in redacted, false);
  const rendered = Buffer.from(JSON.stringify(participantView), 'utf8');
  for (const leak of ['cid-alice', 'cid-bob', 'cid-cara', 'Alice', 'Untrusted current name',
    sourceReply.wire_id]) {
    assert.equal(rendered.includes(leak), false, `${leak} leaked into the participant history view`);
  }

  // non-anonymous participant view keeps real authors but still drops routing identities
  const plain = fixture();
  await seedLegacyParent(plain, sourceReply.wire_id);
  plain.packet.inbox.push(incoming({ reply_to: sourceReply }));
  await plain.pump.pump(ROOM_ID);
  plain.packet.sendCalls.length = 0;
  const plainView = await plain.service.history(ROOM_ID, { view: 'participant', after: 1 });
  assert.equal(plain.packet.sendCalls.length, 0);
  assert.equal(plainView[0].author.identity, 'cid-alice');
  assert.equal('recipient_identities' in plainView[0], false);
  assert.equal('source_reply_to' in plainView[0], false);
});

// ---- Removed members at intake ---------------------------------------------

function roomWithRemovedAlice(overrides = {}) {
  const base = room();
  return {
    ...base,
    membership_epoch: 4,
    seats: [
      { ...base.seats[0], state: 'removed', removed_at: AT, removed_epoch: 4 },
      base.seats[1],
      base.seats[2],
    ],
    ...overrides,
  };
}

test('a removed member gets exactly one content-free bounce and no archive residue', async () => {
  const f = fixture({ room: roomWithRemovedAlice() });
  f.packet.inbox.push(incoming());
  await f.pump.pump(ROOM_ID);

  // consumed, never archived/relayed to others
  assert.deepEqual(f.packet.consumeCalls, [[7]]);
  assert.equal((await f.store.read(ROOM_ID)).length, 0);

  // one bounce to the removed sender only, content-free about everyone else
  assert.equal(f.packet.sendCalls.length, 1);
  assert.equal(f.packet.sendCalls[0].recipient, 'cid-alice');
  const bounce = JSON.parse(f.packet.sendCalls[0].body);
  assert.equal(bounce.kind, 'room_not_member');
  assert.equal(bounce.room_id, ROOM_ID);
  assert.equal(bounce.room_name, 'Release room');
  assert.deepEqual(Object.keys(bounce).sort(), ['kind', 'room_id', 'room_name', 'version']);
  for (const leak of ['cid-bob', 'cid-cara', 'Bob', 'Cara', 'builder #1', 'Alice']) {
    assert.equal(Buffer.from(f.packet.sendCalls[0].body, 'utf8').includes(leak), false, `${leak} leaked into the bounce`);
  }
  const persisted = await f.store.load(ROOM_ID);
  assert.equal(typeof persisted.seats[0].bounced_at, 'string');

  // the bounce is once-only: a second message is dropped silently
  f.packet.inbox.push(incoming({ msg_id: 8, wire_id: 'wire-in-8' }));
  await f.pump.pump(ROOM_ID);
  assert.equal(f.packet.sendCalls.length, 1);
  assert.equal((await f.store.read(ROOM_ID)).length, 0);
});

test('relay intents addressed to a removed seat resolve as skipped_removed and are never sent', async () => {
  const base = room();
  const records = [
    {
      version: 1, kind: 'message', room_id: ROOM_ID, at: AT, seq: 1, record_id: `${ROOM_ID}:1`,
      message_id: MESSAGE_IDS[0],
      author: { identity: 'cid-room', display_name: `cowork-room-${ROOM_ID}`, role: 'room' },
      category: 'chat', text: 'Fanned before the removal.',
      recipient_identities: ['cid-alice', 'cid-bob'],
    },
    { version: 1, kind: 'relay_intent', room_id: ROOM_ID, at: AT, seq: 2, record_id: `${ROOM_ID}:2`, message_id: MESSAGE_IDS[0], recipient_identity: 'cid-alice' },
    { version: 1, kind: 'relay_intent', room_id: ROOM_ID, at: AT, seq: 3, record_id: `${ROOM_ID}:3`, message_id: MESSAGE_IDS[0], recipient_identity: 'cid-bob' },
  ];
  const f = fixture({ room: roomWithRemovedAlice(), records });
  await f.pump.pump(ROOM_ID);

  assert.deepEqual(f.packet.sendCalls.map((call) => call.recipient), ['cid-bob']);
  const results = byKind(await f.store.read(ROOM_ID), 'relay_result');
  assert.deepEqual(
    results.map((result) => [result.recipient_identity, result.status]).sort(),
    [['cid-alice', 'skipped_removed'], ['cid-bob', 'queued']],
  );

  // re-pumping never retries a terminally skipped intent
  await f.pump.pump(ROOM_ID);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 2);
  assert.deepEqual(f.packet.sendCalls.map((call) => call.recipient), ['cid-bob']);
});

// ---- The outbound privacy-test funnel --------------------------------------

test('there is exactly ONE packet.send call site in src/, and it is the canonical envelope funnel', async () => {
  // WHAT THIS GUARDS, and why a count is the right shape for it.
  //
  // The byte-level privacy pins assert that no real cid, contact display name or
  // sender-claimed name reaches a relayed body in an anonymous room. They read
  // the bodies produced by the send sites that existed when they were written.
  // There were two — the relay and the removed-member bounce — and both were
  // pinned. NOTHING ASSERTED THAT THERE WERE ONLY TWO.
  //
  // So a third outbound path — a file relay, a receipt, a control notice — could
  // be added and the pins would go on passing while covering strictly less of
  // the code than the day they were written. Their green would be read as though
  // it still meant what it did. That is worse than having no pin, because nobody
  // re-reads a green.
  //
  // Counting the sites is the only assertion that fails when the code GROWS.
  // Every other test here asserts about behaviour that exists; this one asserts
  // about behaviour that does not exist yet.
  //
  // If you are here because you added an outbound path: route it through
  // `sendRoomBody` rather than raising the number. That is the whole point —
  // the funnel is what the pins already read, so going through it means your new
  // path is covered on the day you write it.
  const { readdirSync, readFileSync } = await import('node:fs');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  walk(SRC);

  // The scan must have something to read. A walk that finds nothing passes every
  // assertion below it, and is one renamed directory away.
  assert.ok(files.length >= 8, `expected at least 8 files under src/, found ${files.length}`);

  const sites = [];
  for (const file of files) {
    // Comments are stripped because this repo documents the rule in prose that
    // necessarily contains the very expression being counted — including the
    // docstring on the funnel itself. A scanner that cannot tell code from the
    // comment explaining the code forces people to stop writing the comment.
    // Block comments are replaced by the SAME NUMBER OF NEWLINES rather than
    // deleted, so reported line numbers still point at the real file. A guard
    // that names the wrong line costs more time than it saves — the first
    // version of this test reported intake.ts:46 for a call on line 73.
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (block) => '\n'.repeat((block.match(/\n/g) ?? []).length))
      .replace(/^[ \t]*\/\/.*$/gm, '');
    code.split('\n').forEach((line, index) => {
      // `packet.send(` and `this.packet(...).send(` — the room-packet wire call.
      // `this.send(` / `this.child.send(` in src/daemon.ts are node IPC to the
      // supervised child process, not the ours wire, and are deliberately out of
      // scope: they carry no room body and no participant identity.
      if (/\bpacket\.send\s*\(/.test(line)) sites.push(`${file.slice(SRC.length + 1)}:${index + 1}`);
    });
  }

  assert.equal(
    sites.length,
    1,
    'every room body must leave through sendRoomBody.\n'
    + `  found: ${JSON.stringify(sites)}\n`
    + '  If you added an outbound path, route it through sendRoomBody instead of\n'
    + '  adding a site here — that is what puts it inside the anonymity pins.',
  );
  assert.match(sites[0], /^intake\.ts:\d+$/, `the one packet.send site moved outside intake.ts: ${sites[0]}`);

  // And the one site must actually BE the funnel, not merely the first match:
  // a rename that moved the call out of sendRoomBody while keeping the count
  // at one would satisfy the assertion above and defeat its purpose.
  const intake = readFileSync(join(SRC, 'intake.ts'), 'utf8');
  const funnel = intake.slice(intake.indexOf('export async function sendRoomBody'));
  const funnelBody = funnel.slice(0, funnel.indexOf('\n}\n') + 3);
  assert.ok(
    /\bpacket\.send\s*\(/.test(funnelBody),
    'the single packet.send call site must live inside sendRoomBody',
  );
  assert.doesNotMatch(funnelBody, /packet\.sign\s*\(/);
  assert.match(funnelBody, /canonicalJson\s*\(/);
});


test('concurrent pumps share one SDK reader and callback resume queues without deadlock', async () => {
  const f = fixture();
  let readers = 0;
  let maximum = 0;
  let passes = 0;
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.packet.drainRuntimeCommands = async () => {
    readers++;
    maximum = Math.max(maximum, readers);
    try {
      passes++;
      if (passes === 1) {
        entered();
        await gate;
        await f.pump.resumePending(ROOM_ID);
      }
    } finally { readers--; }
  };
  const first = f.pump.pump(ROOM_ID);
  await started;
  const second = f.pump.pump(ROOM_ID);
  release();
  await Promise.all([first, second, f.pump.drain()]);
  assert.equal(maximum, 1);
  assert.equal(passes, 2);
});

// Scoped intake must select its audience before a durable source or intent exists.
async function threadFixture({ solo = false, anonymous = false, deferRelay = false } = {}) {
  const seats = room().seats.map((seat, i) => ({ ...seat, identity: ['A', 'B', 'C'][i].repeat(64),
    ...(anonymous ? { alias: ['Otter', 'Finch', 'Lynx'][i] } : {}) }));
  const f = fixture({ room: { seats, anonymous, command_grants: [], role_command_grants: [] } });
  const [a, b, c] = seats;
  const tid = '01jz6y7n8p9q0r1s2t3v4w5xt0';
  const members = (solo ? [b] : [a, b]).map(({ participant_id, identity }) => ({ participant_id, identity }));
  const creator = solo ? b : a;
  const root = await f.store.append(ROOM_ID, {
    version: 1, kind: 'message', room_id: ROOM_ID, at: AT, message_id: tid,
    author: { identity: creator.identity, display_name: creator.display_name, role: creator.role },
    ...(anonymous ? { author_alias: { participant_id: creator.participant_id, alias: creator.alias } } : {}),
    category: 'chat', text: 'Thread: Review', recipient_identities: members.map(m => m.identity),
    scope: { thread_id: tid }, thread_root: { schema_version: 1, thread_id: tid, topic: 'Review',
      creator_participant_id: creator.participant_id, members, idempotency_key: 'request-1', fingerprint: '0'.repeat(64) },
  });
  let serial = 0;
  f.packet.nextSend = cid => ({ status: 'queued', wire_id: `copy-${cid[0]}-${++serial}` });
  if (deferRelay) return { ...f, a, b, c, root };
  await f.pump.resumePending(ROOM_ID);
  const result = (await f.store.read(ROOM_ID)).find(r => r.kind === 'relay_result' && r.recipient_identity === b.identity);
  assert(result);
  const rootCalls = structuredClone(f.packet.sendCalls);
  f.packet.sendCalls.length = 0;
  return { ...f, a, b, c, root, rootCalls, bWire: result.wire_id };
}

async function assertBroadcastAfter(f) {
  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(incoming({ msg_id: 18, sender_id: f.c.identity, wire_id: 'ordinary-after', reply_to: null }));
  await f.pump.pump(ROOM_ID);
  const active = f.store.rooms.get(ROOM_ID).seats.filter(s => s.state === 'active' && s.identity !== f.c.identity);
  assert.deepEqual(f.packet.sendCalls.map(x => x.recipient).sort(), active.map(s => s.identity).sort());
  const saved = (await f.store.read(ROOM_ID)).find(r => r.kind === 'message' && r.source_msg_id === 18);
  assert.equal(saved.scope, undefined);
  assert.deepEqual(saved.recipient_identities.sort(), active.map(s => s.identity).sort());
}

test('scoped reply then ordinary broadcast select different audiences without creation grants', async () => {
  const f = await threadFixture();
  f.packet.inbox.push(incoming({ sender_id: f.b.identity, wire_id: 'b-reply', reply_to: { wire_id: f.bWire } }));
  await f.pump.pump(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls.map(x => x.recipient), [f.a.identity]);
  const saved = (await f.store.read(ROOM_ID)).find(r => r.kind === 'message' && r.source_wire_id === 'b-reply');
  assert.deepEqual(saved.scope, { thread_id: f.root.message_id, parent_key: `message:${f.root.message_id}` });
  await assertBroadcastAfter(f);
});

test('one-member thread reply stores and acknowledges an empty audience', async () => {
  const f = await threadFixture({ solo: true });
  f.packet.inbox.push(incoming({ sender_id: f.b.identity, reply_to: { wire_id: f.bWire } }));
  await f.pump.pump(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls, []);
  assert.deepEqual(f.packet.inbox, []);
  const saved = (await f.store.read(ROOM_ID)).find(r => r.kind === 'message' && r.source_msg_id === 7);
  assert.deepEqual(saved.recipient_identities, []);
  assert.equal(saved.scope.thread_id, f.root.message_id);
  await assertBroadcastAfter(f);
});

for (const kind of ['message', 'file']) {
  for (const denial of ['unknown', 'foreign', 'ambiguous', 'missing-root', 'removed', 'readded', 'empty-target', 'malformed-target', 'closed', 'pending-close', ...(kind === 'file' ? ['root', 'descendant'] : [])]) {
    test(`${kind} ${denial} reply has a durable content-free refusal before ACK`, async () => {
      const f = await threadFixture();
      let reply = { wire_id: f.bWire };
      const current = f.store.rooms.get(ROOM_ID);
      if (denial === 'unknown') reply = { wire_id: 'private-unknown-target' };
      if (denial === 'foreign') reply = { wire_id: (await f.store.read(ROOM_ID)).find(r => r.kind === 'relay_result' && r.recipient_identity === f.a.identity).wire_id };
      if (denial === 'empty-target') reply = { wire_id: '' };
      if (denial === 'malformed-target') reply = {};
      if (denial === 'ambiguous') {
        await f.store.append(ROOM_ID, { version: 1, kind: 'message', room_id: ROOM_ID, at: AT,
          message_id: MESSAGE_IDS[3], author: { identity: f.b.identity, display_name: f.b.display_name, role: f.b.role },
          category: 'chat', text: 'Other owner', source_wire_id: f.bWire, recipient_identities: [] });
      }
      if (denial === 'missing-root' || denial === 'descendant') {
        await f.store.append(ROOM_ID, { version: 1, kind: 'message', room_id: ROOM_ID, at: AT,
          message_id: MESSAGE_IDS[3], author: { identity: f.b.identity, display_name: f.b.display_name, role: f.b.role },
          category: 'chat', text: 'Private descendant', source_wire_id: 'descendant-source', recipient_identities: [],
          scope: { thread_id: denial === 'missing-root' ? MESSAGE_IDS[2] : f.root.message_id, parent_key: `message:${f.root.message_id}` } });
        reply = { wire_id: 'descendant-source' };
      }
      if (denial === 'removed' || denial === 'readded') {
        current.seats.find(s => s.identity === f.b.identity).state = 'removed';
        if (denial === 'readded') current.seats.push({ ...f.b, state: 'active', participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa4' });
      }
      if (denial === 'closed') current.state = 'closed';
      if (denial === 'pending-close') current.lifecycle_request = { state: 'pending', command: 'room.close' };
      const item = kind === 'message'
        ? incoming({ sender_id: f.b.identity, text: 'SECRET participant body', reply_to: reply })
        : incomingFile({ sender_id: f.b.identity, filename: 'SECRET-filename.bin', data: Buffer.from('SECRET bytes'), reply_to: reply });
      (kind === 'message' ? f.packet.inbox : f.packet.fileInbox).push(item);
      const checkBeforeAck = async () => {
        const records = await f.store.read(ROOM_ID);
        assert.equal(records.filter(r => r.kind === 'intake_rejection').length, 1);
        assert.equal(records.some(r => r.source_msg_id === 7 && r.kind === 'message' || r.source_file_id === 9 && r.kind === 'file'), false);
      };
      if (kind === 'message') f.packet.beforeConsume = checkBeforeAck;
      else f.packet.beforeConsumeFile = checkBeforeAck;
      await f.pump.pump(ROOM_ID);
      const rejection = (await f.store.read(ROOM_ID)).find(r => r.kind === 'intake_rejection');
      assert.equal(rejection.error, ['root', 'descendant'].includes(denial) ? 'thread_files_unsupported' : 'reply_target_unavailable');
      assert.equal(rejection.notification_attempt_claimed, true);
      assert.equal(f.packet.sendCalls.length, 1);
      assert.equal(f.packet.sendCalls[0].recipient, f.b.identity);
      assert.equal(JSON.parse(f.packet.sendCalls[0].body).text, rejection.error);
      assert.equal(f.packet.sendCalls[0].replyTo, undefined);
      for (const secret of ['SECRET', f.root.message_id, f.a.identity, f.c.identity, f.bWire]) {
        assert.equal(f.packet.sendCalls[0].body.includes(secret), false);
        assert.equal(JSON.stringify(rejection).includes(secret), false);
      }
      assert.deepEqual(f.packet.sendFileCalls, []);
      f.packet.beforeConsume = undefined;
      current.state = 'active'; delete current.lifecycle_request;
      await assertBroadcastAfter(f);
    });
  }

  for (const failure of ['before-append', 'after-append', 'before-ack', 'error-send']) {
    test(`${kind} rejection ${failure} survives restart without repeat notification`, async () => {
      const f = await threadFixture();
      const item = kind === 'message' ? incoming({ sender_id: f.b.identity, reply_to: { wire_id: 'unknown' } })
        : incomingFile({ sender_id: f.b.identity, reply_to: { wire_id: 'unknown' } });
      const inbox = kind === 'message' ? f.packet.inbox : f.packet.fileInbox;
      inbox.push(item);
      const fail = () => { throw new Error('injected crash'); };
      if (failure === 'before-append') f.store.beforeAppend = fail;
      if (failure === 'after-append') f.store.afterAppend = fail;
      if (failure === 'before-ack') {
        if (kind === 'message') f.packet.beforeConsume = fail;
        else f.packet.beforeConsumeFile = fail;
      }
      if (failure === 'error-send') f.packet.beforeSend = fail;
      if (failure === 'error-send') await f.pump.pump(ROOM_ID);
      else await assert.rejects(f.pump.pump(ROOM_ID), /injected crash/);
      assert.equal(inbox.length, failure === 'error-send' ? 0 : 1);
      assert.equal((await f.store.read(ROOM_ID)).filter(r => r.kind === 'intake_rejection').length, failure === 'before-append' ? 0 : 1);
      f.store.beforeAppend = undefined; f.store.afterAppend = undefined;
      f.packet.beforeConsume = undefined; f.packet.beforeConsumeFile = undefined; f.packet.beforeSend = undefined;
      if (!inbox.length) inbox.push(item);
      const restarted = new IntakePump(f.store, f.registry, { now: () => AT, messageId: () => MESSAGE_IDS[2] });
      await restarted.pump(ROOM_ID);
      assert.equal(inbox.length, 0);
      assert.equal((await f.store.read(ROOM_ID)).filter(r => r.kind === 'intake_rejection').length, 1);
      assert.equal(f.packet.sendCalls.length, failure === 'after-append' ? 0 : 1);
      assert.deepEqual(f.packet.sendFileCalls, []);
    });
  }

  test(`${kind} accepted and rejected source replays validate input before inactive-seat drain`, async () => {
    for (const rejected of [false, true]) {
      const f = await threadFixture();
      const item = kind === 'message' ? incoming({ sender_id: f.b.identity, reply_to: rejected ? { wire_id: 'unknown' } : null })
        : incomingFile({ sender_id: f.b.identity, reply_to: rejected ? { wire_id: 'unknown' } : null });
      const inbox = kind === 'message' ? f.packet.inbox : f.packet.fileInbox;
      inbox.push(item);
      await f.pump.pump(ROOM_ID);
      f.packet.sendCalls.length = 0; f.packet.sendFileCalls.length = 0;
      f.store.rooms.get(ROOM_ID).seats.find(s => s.identity === f.b.identity).state = 'removed';
      const changes = [{ sender_id: f.c.identity }, { wire_id: 'different' }, { date: AT }, { reply_to: { wire_id: 'different' } },
        ...(kind === 'message' ? [{ text: 'changed' }] : [{ filename: 'changed.bin' }, { mime: 'text/plain' }, { data: Buffer.from('changed') }])];
      for (const change of changes) {
        inbox.push({ ...item, ...change });
        await assert.rejects(f.pump.pump(ROOM_ID), /does not match/);
        assert.equal(inbox.length, 1);
        inbox.length = 0;
      }
      inbox.push({ ...item, sender_name: 'Another untrusted name' });
      await f.pump.pump(ROOM_ID);
      assert.equal(inbox.length, 0);
      assert.deepEqual(f.packet.sendCalls, []);
      assert.deepEqual(f.packet.sendFileCalls, []);
    }
  });

  test(`${kind} empty source preserves ordinary intake but cannot durably refuse invalid target`, async () => {
    const f = fixture();
    const item = kind === 'message' ? incoming({ wire_id: '' }) : incomingFile({ wire_id: '' });
    const inbox = kind === 'message' ? f.packet.inbox : f.packet.fileInbox;
    inbox.push(item);
    await f.pump.pump(ROOM_ID);
    assert.equal(inbox.length, 0);
    assert.equal((await f.store.read(ROOM_ID)).find(r => r.kind === kind).source_wire_id, undefined);
    f.packet.sendCalls.length = 0; f.packet.sendFileCalls.length = 0;
    inbox.push({ ...item, ...(kind === 'message' ? { msg_id: 8 } : { file_id: 10 }), reply_to: { wire_id: 'unknown' } });
    await assert.rejects(f.pump.pump(ROOM_ID), /source wire/);
    assert.equal(inbox.length, 1);
    assert.deepEqual(f.packet.sendCalls, []); assert.deepEqual(f.packet.sendFileCalls, []);
  });
}

async function seedLegacyParent(f, wire, id = MESSAGE_IDS[3]) {
  const seat = f.store.rooms.get(ROOM_ID).seats[0];
  return f.store.append(ROOM_ID, { version: 1, kind: 'message', room_id: ROOM_ID, at: AT,
    message_id: id, author: { identity: seat.identity, display_name: seat.display_name, role: seat.role },
    ...(seat.alias ? { author_alias: { participant_id: seat.participant_id, alias: seat.alias } } : {}),
    category: 'chat', text: 'Legacy parent', source_wire_id: wire, recipient_identities: [] });
}

for (const kind of ['message', 'file']) {
  test(`${kind} rejection replay is found beyond a capped archive read page`, async () => {
    const f = fixture();
    for (let i = 0; i < 70; i++) await f.store.append(ROOM_ID, {
      version: 1, kind: 'intake_rejection', room_id: ROOM_ID, at: AT,
      source_kind: 'message', source_msg_id: 100 + i, source_wire_id: `refused-${i}`,
      sender_identity: 'cid-alice', sender_participant_id: room().seats[0].participant_id,
      fingerprint: '0'.repeat(64), error: 'reply_target_unavailable', notification_attempt_claimed: true,
    });
    const item = kind === 'message' ? incoming({ reply_to: { wire_id: 'unknown' } })
      : incomingFile({ reply_to: { wire_id: 'unknown' } });
    const inbox = kind === 'message' ? f.packet.inbox : f.packet.fileInbox;
    inbox.push(item);
    await f.pump.pump(ROOM_ID);
    const read = f.store.read.bind(f.store);
    f.store.read = (id, options = {}) => read(id, { ...options, limit: Math.min(options.limit ?? 2, 2) });
    f.packet.sendCalls.length = 0;
    inbox.push(item);
    await f.pump.pump(ROOM_ID);
    assert.deepEqual(f.packet.sendCalls, []);
    assert.equal((await read(ROOM_ID)).length, 71);
    assert.equal(inbox.length, 0);
  });

  test(`${kind} wholly unknown sender is drained without resolving or disclosing a target`, async () => {
    const f = fixture();
    const item = kind === 'message' ? incoming({ sender_id: 'unknown-sender', reply_to: { wire_id: 'private-target' } })
      : incomingFile({ sender_id: 'unknown-sender', reply_to: { wire_id: 'private-target' } });
    (kind === 'message' ? f.packet.inbox : f.packet.fileInbox).push(item);
    await f.pump.pump(ROOM_ID);
    assert.deepEqual(await f.store.read(ROOM_ID), []);
    assert.deepEqual(f.packet.sendCalls, []); assert.deepEqual(f.packet.sendFileCalls, []);
    assert.equal(f.packet.inbox.length + f.packet.fileInbox.length, 0);
  });

  test(`${kind} valid legacy reply accepts an empty source wire`, async () => {
    const f = fixture();
    await seedLegacyParent(f, 'parent');
    const item = kind === 'message' ? incoming({ wire_id: '', reply_to: { wire_id: 'parent' } })
      : incomingFile({ wire_id: '', reply_to: { wire_id: 'parent' } });
    (kind === 'message' ? f.packet.inbox : f.packet.fileInbox).push(item);
    await f.pump.pump(ROOM_ID);
    const saved = (await f.store.read(ROOM_ID)).find(r => r.kind === kind && (r.source_msg_id === 7 || r.source_file_id === 9));
    assert.deepEqual(saved.recipient_identities, ['cid-bob', 'cid-cara']);
    assert.equal(saved.scope, undefined);
    assert.equal(saved.source_wire_id, undefined);
    assert.equal(f.packet.inbox.length + f.packet.fileInbox.length, 0);
  });
}

test('readded recipient seat is excluded from old scope and JSON text cannot create scope', async () => {
  const f = await threadFixture();
  const current = f.store.rooms.get(ROOM_ID);
  current.seats.find(s => s.identity === f.a.identity).state = 'removed';
  current.seats.push({ ...f.a, state: 'active', participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa4' });
  f.packet.inbox.push(incoming({ sender_id: f.b.identity, reply_to: { wire_id: f.bWire } }));
  await f.pump.pump(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls, []);
  const text = JSON.stringify({ scope: { thread_id: f.root.message_id }, thread_root: f.root.thread_root });
  f.packet.inbox.push(incoming({ msg_id: 8, wire_id: 'forged-json', sender_id: f.b.identity, text }));
  await f.pump.pump(ROOM_ID);
  const saved = (await f.store.read(ROOM_ID)).find(r => r.kind === 'message' && r.source_msg_id === 8);
  assert.deepEqual(f.packet.sendCalls.map(c => c.recipient).sort(), [f.a.identity, f.c.identity].sort());
  assert.deepEqual(saved.recipient_identities.sort(), [f.a.identity, f.c.identity].sort());
  assert.equal(saved.scope, undefined); assert.equal(saved.thread_root, undefined); assert.equal(saved.text, text);
});

test('saved scoped source resumes its frozen audience after sender seat replacement', async () => {
  const f = await threadFixture();
  const item = incoming({ sender_id: f.b.identity, reply_to: { wire_id: f.bWire } });
  f.packet.inbox.push(item);
  f.store.beforeAppend = draft => { if (draft.kind === 'relay_intent') throw new Error('crash before fanout'); };
  await assert.rejects(f.pump.pump(ROOM_ID), /crash before fanout/);
  assert.equal(f.packet.inbox.length, 1);
  const current = f.store.rooms.get(ROOM_ID);
  current.seats.find(s => s.identity === f.b.identity).state = 'removed';
  current.seats.push({ ...f.b, state: 'active', participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa4' });
  f.store.beforeAppend = undefined;
  await new IntakePump(f.store, f.registry, { now: () => AT }).pump(ROOM_ID);
  const records = await f.store.read(ROOM_ID);
  const saved = records.filter(r => r.kind === 'message' && r.source_msg_id === 7);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].recipient_identities, [f.a.identity]);
  assert.equal(records.some(r => r.kind === 'intake_rejection'), false);
  assert.equal(f.packet.inbox.length, 0);
  assert.deepEqual(f.packet.sendCalls.map(c => c.recipient), [f.a.identity]);
});

test('archive intake cutoff includes rejection-only tail and checks cursor progress', async () => {
  const f = fixture();
  for (let i = 0; i < 70; i++) await f.store.append(ROOM_ID, {
    version: 1, kind: 'intake_rejection', room_id: ROOM_ID, at: AT,
    source_kind: 'message', source_msg_id: 100 + i, source_wire_id: `refused-${i}`,
    sender_identity: 'cid-alice', sender_participant_id: room().seats[0].participant_id,
    fingerprint: '0'.repeat(64), error: 'reply_target_unavailable', notification_attempt_claimed: true,
  });
  const read = f.store.read.bind(f.store);
  f.store.read = (id, options = {}) => read(id, { ...options, limit: Math.min(options.limit ?? 2, 2) });
  assert.equal(await f.pump.nextRecordSeq(ROOM_ID), 71);
  f.store.query = async (_id, options) => {
    assert.deepEqual(options, { descending: true, limit: 1 });
    return read(ROOM_ID, { after: 69, limit: 1 });
  };
  assert.equal(await f.pump.nextRecordSeq(ROOM_ID), 71);
  f.store.query = undefined;
  f.store.read = () => read(ROOM_ID, { after: 0, limit: 1 });
  await assert.rejects(f.pump.nextRecordSeq(ROOM_ID), /cursor did not advance/);
});

// These exercise the real pump: omitting scoped validation leaks bodies or identities,
// and projecting a root by spreading archive fields leaks routing metadata.
for (const anonymous of [false, true]) {
  test(`scoped ${anonymous ? 'anonymous' : 'named'} roots and nested replies expose only public metadata`, async () => {
    const f = await threadFixture({ anonymous });
    assert.deepEqual(f.rootCalls.map(c => c.recipient), [f.a.identity, f.b.identity]);
    const rootResults = byKind(await f.store.read(ROOM_ID), 'relay_result');
    const aWire = rootResults.find(r => r.recipient_identity === f.a.identity).wire_id;
    assert.notEqual(aWire, f.bWire);
    for (const call of f.rootCalls) {
      const body = JSON.parse(call.body);
      assert.equal(call.replyTo, undefined);
      assert.deepEqual(body.thread, { schema_version: 1, thread_id: f.root.message_id });
      assert.deepEqual(body.thread_root, { schema_version: 1, thread_id: f.root.message_id,
        topic: 'Review', creator: { identity: anonymous ? f.a.participant_id : f.a.identity,
          display_name: anonymous ? 'Otter' : 'Alice', role: 'builder' },
        participant_ids: [f.a.participant_id, f.b.participant_id], created_at: AT });
    }
    const allCalls = [...f.rootCalls];
    for (const [msg, sender, wire, target, recipient, expectedParent] of [
      [7, f.b, 'b-source', f.bWire, f.a, aWire],
      [8, f.a, 'a-source', 'copy-A-3', f.b, 'b-source'],
      [9, f.b, 'b-source-2', 'copy-B-4', f.a, 'a-source'],
    ]) {
      f.packet.sendCalls.length = 0;
      f.packet.inbox.push(incoming({ msg_id: msg, sender_id: sender.identity, wire_id: wire,
        reply_to: { wire_id: target, sentence: 2 } }));
      await f.pump.pump(ROOM_ID);
      assert.equal(f.packet.sendCalls.length, 1);
      const [call] = f.packet.sendCalls;
      assert.equal(call.recipient, recipient.identity);
      assert.deepEqual(call.replyTo, { wire_id: expectedParent });
      const body = JSON.parse(call.body);
      assert.deepEqual(body.thread, { schema_version: 1, thread_id: f.root.message_id });
      assert.equal(body.thread_root, undefined);
      assert.deepEqual(body.author, { identity: anonymous ? sender.participant_id : sender.identity,
        display_name: anonymous ? sender.alias : sender.display_name, role: sender.role });
      allCalls.push(call);
    }
    for (const call of allCalls) {
      assert.equal(call.recipient === f.c.identity, false);
      const body = JSON.parse(call.body);
      assert.equal(body.version, 1); assert.equal(body.kind, 'room_msg');
      for (const internal of ['parent_key', 'recipient_identities', 'source_wire_id', 'source_reply_to',
        'members', 'idempotency_key', 'fingerprint', 'seq', 'record_id', 'intent_record_id']) {
        assert.equal(call.body.includes(`"${internal}"`), false, internal);
      }
      if (anonymous) for (const secret of [f.a.identity, f.b.identity, f.c.identity, 'Alice', 'Bob', 'Cara']) {
        assert.equal(call.body.includes(secret), false, secret);
      }
    }
  });
}

test('missing scoped copy is terminal across restart and never sends unlinked content', async () => {
  const f = await threadFixture();
  f.store.records.set(ROOM_ID, f.store.records.get(ROOM_ID).map(r => r.kind === 'relay_result'
    && r.recipient_identity === f.a.identity ? { ...r, status: 'send_failed', wire_id: undefined } : r));
  f.packet.inbox.push(incoming({ sender_id: f.b.identity, reply_to: { wire_id: f.bWire } }));
  await f.pump.pump(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls, []);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').filter(r => r.status === 'skipped_reply_unavailable').length, 1);
  await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls, []);
});

for (const replacement of ['removed', 'same-cid-new-participant', 'same-participant-new-cid']) {
  test(`scoped recipient ${replacement} after intake is terminal skipped_removed`, async () => {
    const f = await threadFixture();
    f.packet.afterConsume = () => {
      const seats = f.store.rooms.get(ROOM_ID).seats;
      seats.find(s => s.identity === f.a.identity).state = 'removed';
      if (replacement !== 'removed') seats.push({ ...f.a, state: 'active',
        ...(replacement === 'same-cid-new-participant' ? { participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa4' } : { identity: 'D'.repeat(64) }) });
    };
    f.packet.inbox.push(incoming({ sender_id: f.b.identity, reply_to: { wire_id: f.bWire } }));
    await f.pump.pump(ROOM_ID);
    assert.deepEqual(f.packet.sendCalls, []);
    assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').at(-1).status, 'skipped_removed');
    await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
    assert.deepEqual(f.packet.sendCalls, []);
  });
}

// A crash after ACK leaves only durable state, so restart must independently validate it.
async function pendingScopedReply(options = {}) {
  const f = await threadFixture(options);
  f.packet.inbox.push(incoming({ sender_id: f.b.identity, text: 'PRIVATE descendant', reply_to: { wire_id: f.bWire } }));
  f.packet.afterConsume = () => { throw new Error('crash after ACK'); };
  await assert.rejects(f.pump.pump(ROOM_ID), /crash after ACK/);
  f.packet.afterConsume = undefined;
  return f;
}

for (const corruption of ['missing-root', 'missing-scope', 'malformed-scope', 'wrong-thread', 'missing-parent',
  'wrong-parent', 'parent-thread', 'duplicate-root', 'duplicate-child', 'unsaved-recipient', 'unselected-recipient']) {
  test(`scoped restart rejects ${corruption} association without sending private body`, async () => {
    const f = await pendingScopedReply();
    const records = f.store.records.get(ROOM_ID);
    const root = records.find(r => r.kind === 'message' && r.thread_root);
    const child = records.find(r => r.kind === 'message' && r.source_msg_id === 7);
    if (corruption === 'missing-root') { delete root.thread_root; }
    if (corruption === 'missing-scope') delete child.scope;
    if (corruption === 'malformed-scope') child.scope = {};
    if (corruption === 'wrong-thread') child.scope.thread_id = MESSAGE_IDS[3];
    if (corruption === 'missing-parent') child.scope.parent_key = `message:${MESSAGE_IDS[3]}`;
    if (corruption === 'wrong-parent') child.scope.parent_key = `message:${child.message_id}`;
    if (corruption === 'parent-thread') root.scope.thread_id = MESSAGE_IDS[3];
    if (corruption === 'duplicate-root' || corruption === 'duplicate-child') {
      const duplicate = { ...(corruption === 'duplicate-root' ? root : child) };
      delete duplicate.seq; delete duplicate.record_id;
      await f.store.append(ROOM_ID, duplicate);
    }
    if (corruption === 'unsaved-recipient') child.recipient_identities = [];
    if (corruption === 'unselected-recipient') {
      child.recipient_identities.push(f.c.identity);
      await f.store.append(ROOM_ID, { version: 1, kind: 'relay_intent', room_id: ROOM_ID, at: AT,
        message_id: child.message_id, recipient_identity: f.c.identity });
    }
    await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
    const calls = f.packet.sendCalls.filter(c => corruption !== 'unselected-recipient' || c.recipient === f.c.identity);
    assert.deepEqual(calls, []);
    const results = byKind(await f.store.read(ROOM_ID), 'relay_result').filter(r => r.message_id === child.message_id);
    assert.ok(results.some(r => r.status === 'skipped_reply_unavailable'));
    const count = f.packet.sendCalls.length;
    await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
    assert.equal(f.packet.sendCalls.length, count);
  });
}

for (const subject of ['root', 'descendant']) for (const alias of ['missing', 'malformed', 'null', 'mismatched']) {
  test(`anonymous scoped ${subject} ${alias} alias fails closed on restart`, async () => {
    const f = subject === 'root' ? await threadFixture({ anonymous: true, deferRelay: true })
      : await pendingScopedReply({ anonymous: true });
    const target = f.store.records.get(ROOM_ID).find(r => r.kind === 'message'
      && (subject === 'root' ? r.thread_root : r.source_msg_id === 7));
    if (alias === 'missing') delete target.author_alias;
    if (alias === 'null') target.author_alias = null;
    if (alias === 'malformed') target.author_alias.alias = '';
    if (alias === 'mismatched') target.author_alias.participant_id = f.c.participant_id;
    await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
    assert.deepEqual(f.packet.sendCalls, []);
    assert.deepEqual(f.packet.sendFileCalls, []);
    const results = byKind(await f.store.read(ROOM_ID), 'relay_result').filter(r => r.message_id === target.message_id);
    assert.equal(results.length, subject === 'root' ? 2 : 1);
    assert.ok(results.every(r => r.status === 'skipped_reply_unavailable'));
    await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
    assert.deepEqual(f.packet.sendCalls, []);
  });
}

test('restart before scoped root fanout sends stable roots once to original seats', async () => {
  const f = await threadFixture({ deferRelay: true });
  await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls.map(c => c.recipient), [f.a.identity, f.b.identity]);
  assert.ok(f.packet.sendCalls.every(c => JSON.parse(c.body).thread_root.thread_id === f.root.message_id));
  await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
  assert.equal(f.packet.sendCalls.length, 2);
});

test('relay fallback advances past unresolved dangling intents without looping archive reads', async () => {
  const f = fixture();
  await f.store.append(ROOM_ID, { version: 1, kind: 'relay_intent', room_id: ROOM_ID, at: AT,
    message_id: MESSAGE_IDS[0], recipient_identity: 'cid-alice' });
  const read = f.store.read.bind(f.store);
  let reads = 0;
  f.store.read = (...args) => {
    if (++reads > 20) throw new Error('relay archive pagination repeated');
    return read(...args);
  };
  await f.pump.resumePending(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls, []);
});

test('scoped relay rejects a descendant parent whose saved parent association was erased', async () => {
  const f = await threadFixture();
  f.packet.inbox.push(incoming({ sender_id: f.b.identity, wire_id: 'b-descendant', reply_to: { wire_id: f.bWire } }));
  await f.pump.pump(ROOM_ID);
  f.packet.sendCalls.length = 0;
  f.packet.inbox.push(incoming({ msg_id: 8, sender_id: f.a.identity, wire_id: 'a-descendant', reply_to: { wire_id: 'copy-A-3' } }));
  f.packet.afterConsume = () => { delete f.store.records.get(ROOM_ID).find(r => r.source_msg_id === 7).scope.parent_key; };
  await f.pump.pump(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls, []);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').at(-1).status, 'skipped_reply_unavailable');
});

test('uncertain scoped root send retries stable metadata and retains every observed reply alias', async () => {
  const f = await threadFixture({ anonymous: true, deferRelay: true });
  f.packet.beforeSend = () => { throw new Error('acceptance unknown'); };
  await assert.rejects(f.pump.resumePending(ROOM_ID), /acceptance unknown/);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 0);
  const attempted = f.packet.sendCalls[0].body;
  f.packet.beforeSend = undefined;
  await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
  assert.equal(f.packet.sendCalls[1].body, attempted);
  const results = byKind(await f.store.read(ROOM_ID), 'relay_result');
  const bResult = results.find(r => r.recipient_identity === f.b.identity);
  // A second observed successful alias for the same durable intent remains valid.
  const duplicate = { ...bResult, wire_id: 'b-other-observed-copy' };
  delete duplicate.seq; delete duplicate.record_id;
  await f.store.append(ROOM_ID, duplicate);
  f.store.records.set(ROOM_ID, JSON.parse(JSON.stringify(f.store.records.get(ROOM_ID))));
  for (const [index, alias] of [bResult.wire_id, 'b-other-observed-copy'].entries()) {
    f.packet.sendCalls.length = 0;
    f.packet.inbox.push(incoming({ msg_id: 7 + index, sender_id: f.b.identity,
      wire_id: `b-reply-${index}`, reply_to: { wire_id: alias } }));
    await f.pump.pump(ROOM_ID);
    assert.equal(f.packet.sendCalls.length, 1);
    assert.equal(f.packet.sendCalls[0].recipient, f.a.identity);
    assert.deepEqual(f.packet.sendCalls[0].replyTo, { wire_id: 'copy-A-1' });
    assert.equal(JSON.parse(f.packet.sendCalls[0].body).thread.thread_id, f.root.message_id);
  }
});

test('corrupt anonymous root metadata blocks an already accepted descendant on restart', async () => {
  const f = await pendingScopedReply({ anonymous: true });
  delete f.store.records.get(ROOM_ID).find(r => r.kind === 'message' && r.thread_root).author_alias;
  await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls, []);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').at(-1).status, 'skipped_reply_unavailable');
});

test('saved file reply to a scoped root never emits a file notice or binary', async () => {
  const f = await threadFixture();
  await f.store.append(ROOM_ID, { version: 1, kind: 'file', room_id: ROOM_ID, at: AT,
    file_id: MESSAGE_IDS[3], author: { identity: f.b.identity, display_name: 'Bob', role: 'reviewer' },
    filename: 'PRIVATE.bin', mime: 'application/octet-stream', size: 7, data_base64: Buffer.from('PRIVATE').toString('base64'),
    source_file_id: 9, source_wire_id: 'file-source', source_reply_to: { wire_id: f.bWire },
    recipient_identities: [f.a.identity] });
  await new IntakePump(f.store, f.registry).resumePending(ROOM_ID);
  assert.deepEqual(f.packet.sendCalls, []); assert.deepEqual(f.packet.sendFileCalls, []);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').at(-1).status, 'skipped_reply_unavailable');
});
