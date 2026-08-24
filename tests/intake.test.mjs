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
  beforeConsume;
  afterConsume;
  beforeSend;
  beforeConsumeFile;
  afterConsumeFile;
  beforeSendFile;

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

  async send(recipient, body) {
    this.sendCalls.push({ recipient, body });
    if (this.beforeSend) await this.beforeSend(recipient, body);
    return structuredClone(this.nextSend);
  }

  async sendFile(recipient, filename, mime, data) {
    this.sendFileCalls.push({ recipient, filename, mime, data: Buffer.from(data) });
    if (this.beforeSendFile) await this.beforeSendFile(recipient, filename, mime, data);
    return { status: 'queued', wire_id: 'wire-file-out' };
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

// ---- Durable file broadcast -------------------------------------------------

test('intake preserves standard SDK reply references on archived messages and files', async () => {
  const f = fixture();
  f.packet.inbox.push(incoming({ reply_to: { wire_id: 'wire-parent-message', sentence: 2 } }));
  f.packet.fileInbox.push(incomingFile({ reply_to: { wire_id: 'wire-parent-file' } }));

  await f.pump.pump(ROOM_ID);

  const records = await f.store.read(ROOM_ID);
  assert.deepEqual(byKind(records, 'message')[0].source_reply_to, {
    wire_id: 'wire-parent-message', sentence: 2,
  });
  assert.deepEqual(byKind(records, 'file')[0].source_reply_to, { wire_id: 'wire-parent-file' });
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

test('participant files archive bytes before consume and relay metadata + core bytes to every other seat', async () => {
  const f = fixture();
  f.packet.fileInbox.push(incomingFile());

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
  const metadata = JSON.parse(f.packet.sendCalls[0].body);
  assert.equal(metadata.kind, 'room_file');
  assert.equal(metadata.file_id, file.file_id);
  assert.equal(metadata.sha256, file.sha256);
  assert.equal('data_base64' in metadata, false, 'file bytes must use the core binary path, not text JSON');
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
  assert.equal(f.packet.sendCalls[0].body, f.packet.sendCalls[1].body, 'metadata retry keeps the stable file_id');
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

test('anonymous file metadata uses only the alias author and never leaks real seat or claimed names', async () => {
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
  assert.deepEqual(JSON.parse(f.packet.sendCalls[0].body).author, {
    identity: '01jz6y7n8p9q0r1s2t3v4w5xa1',
    display_name: 'builder #1',
    role: 'builder',
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
    text: incoming().text,
    version: 1,
  });
  assert.equal('signature' in envelope, false);
  assert.equal('recipient_identities' in envelope, false);
  assert.deepEqual(Object.keys(JSON.parse(f.packet.sendCalls[0].body)).sort(),
    ['at', 'author', 'kind', 'message_id', 'room_id', 'text', 'version']);
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
  assert.equal(f.packet.sendCalls[0].body, f.packet.sendCalls[1].body, 'retry keeps the canonical envelope byte-stable');
  assert.equal(JSON.parse(f.packet.sendCalls[0].body).message_id, MESSAGE_IDS[0]);
  const results = byKind(await f.store.read(ROOM_ID), 'relay_result');
  assert.equal(results.length, 1, 'one eventual terminal result belongs to the durable intent');
  assert.equal(results[0].intent_record_id, `${ROOM_ID}:2`);

  await f.pump.resumePending(ROOM_ID);
  assert.equal(f.packet.sendCalls.length, 2);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'relay_result').length, 1);
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
      ['at', 'author', 'kind', 'message_id', 'room_id', 'text', 'version']);
    for (const leak of ['cid-alice', 'cid-bob', 'cid-cara', 'Alice', 'Bob', 'Cara', 'builder #1']) {
      assert.equal(Buffer.from(call.body, 'utf8').includes(leak), false, `${leak} leaked into a role body`);
    }
  }
  const [message] = byKind(await f.store.read(ROOM_ID), 'message');
  assert.equal(message.author_alias, undefined);
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
  assert.deepEqual(Object.keys(bounce).sort(), ['kind', 'room_id', 'version']);
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
