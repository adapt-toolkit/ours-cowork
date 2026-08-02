import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';

import { RoomService } from '../src/service.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const MESSAGE_IDS = [
  '01jz6y7n8p9q0r1s2t3v4w5x6z',
  '01jz6y7n8p9q0r1s2t3v4w5x70',
  '01jz6y7n8p9q0r1s2t3v4w5x71',
];
const TIMES = [
  '2026-08-02T10:11:12.000Z',
  '2026-08-02T10:11:13.000Z',
  '2026-08-02T10:11:14.000Z',
  '2026-08-02T10:11:15.000Z',
  '2026-08-02T10:11:16.000Z',
  '2026-08-02T10:11:17.000Z',
  '2026-08-02T10:11:18.000Z',
  '2026-08-02T10:11:19.000Z',
];

class MemoryStore {
  rooms = new Map();
  records = new Map();
  tails = new Map();
  ownership = new AsyncLocalStorage();
  beforeSave;
  beforeAppend;

  mutex(roomId, work) {
    if (!work) return { runExclusive: (nested) => this.mutex(roomId, nested) };
    if (this.ownership.getStore() === roomId) return Promise.resolve().then(work);
    const previous = this.tails.get(roomId) ?? Promise.resolve();
    const result = previous.then(() => this.ownership.run(roomId, work));
    this.tails.set(roomId, result.then(() => undefined, () => undefined));
    return result;
  }

  async create(room) {
    assert(!this.rooms.has(room.room_id));
    this.rooms.set(room.room_id, structuredClone(room));
    this.records.set(room.room_id, []);
    return structuredClone(room);
  }

  async load(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`missing room ${roomId}`);
    return structuredClone(room);
  }

  async save(room) {
    if (this.beforeSave) await this.beforeSave(room);
    this.rooms.set(room.room_id, structuredClone(room));
    return structuredClone(room);
  }

  async list() { return [...this.rooms.values()].map((room) => structuredClone(room)); }

  async append(roomId, draft) {
    if (this.beforeAppend) await this.beforeAppend(draft);
    const list = this.records.get(roomId);
    const record = { ...structuredClone(draft), seq: list.length + 1, record_id: `${roomId}:${list.length + 1}` };
    list.push(record);
    return structuredClone(record);
  }

  async read(roomId, options = {}) {
    const after = options.after ?? 0;
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    return this.records.get(roomId).filter((record) => record.seq > after).slice(0, limit).map((record) => structuredClone(record));
  }
}

class FakePacket {
  name;
  cid;
  mintCalls = [];
  revokeCalls = [];
  invites = [];
  contacts = [];
  origins = {};
  nextInvite = 1;

  constructor(name, cid) { this.name = name; this.cid = cid; }

  async mintInvite(mode) {
    this.mintCalls.push(mode);
    const invite_id = `core-invite-${this.nextInvite++}`;
    this.invites.push({ invite_id, mode });
    return { blob: `SECRET-BLOB-${invite_id}`, invite_id, reusable: mode === 'public' };
  }

  async revokeInvite(inviteId) {
    this.revokeCalls.push(inviteId);
    this.invites = this.invites.filter((invite) => invite.invite_id !== inviteId);
    return { revoked: true };
  }

  listInvites() { return structuredClone(this.invites); }
  listContacts() { return structuredClone(this.contacts); }
  listContactOrigins() { return structuredClone(this.origins); }
  peekInbox() { return []; }
  async consumeInbox() { return { consumed: [], deferred: [] }; }
  async send() { return { status: 'queued', wire_id: 'wire' }; }
  async removeContact() { return { status: 'queued', notified: true, key_material_retained: true }; }
  async sign() { return 'signature'; }
}

class FakeRegistry {
  packets = new Map();
  createCalls = [];
  failCreate;

  get(roomId) { return this.packets.get(roomId); }

  async create(roomId, identityName, bio) {
    this.createCalls.push({ roomId, identityName, bio });
    if (this.failCreate) {
      const failure = this.failCreate;
      this.failCreate = undefined;
      throw failure;
    }
    assert.equal(this.packets.has(roomId), false, 'must never provision a duplicate packet');
    const packet = new FakePacket(`cowork-room-${roomId}`, `cid-room-${roomId}`);
    this.packets.set(roomId, packet);
    return packet;
  }

  async restore() { throw new Error('live packet state is missing'); }
}

function fixture() {
  const store = new MemoryStore();
  const registry = new FakeRegistry();
  let timeIndex = 0;
  let messageIndex = 0;
  const service = new RoomService(store, registry, {
    roomId: () => ROOM_ID,
    messageId: () => MESSAGE_IDS[messageIndex++],
    now: () => TIMES[timeIndex++],
  });
  return { store, registry, service };
}

async function create(f) {
  return f.service.createRoom({ goal: 'Ship the room', briefing: 'Read the mission.' });
}

test('create validates caller input first and provisions exactly one named room packet', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.createRoom({ goal: 'Ship', briefing: 'Brief', identity_cid: 'forged' }),
    /unrecognized|invalid/i,
  );
  assert.equal(f.registry.createCalls.length, 0);

  const room = await create(f);
  assert.deepEqual(f.registry.createCalls, [{
    roomId: ROOM_ID,
    identityName: `cowork-room-${ROOM_ID}`,
    bio: `ours-cowork mission room ${ROOM_ID}`,
  }]);
  assert.equal(room.identity_name, `cowork-room-${ROOM_ID}`);
  assert.equal(room.identity_cid, `cid-room-${ROOM_ID}`);
  assert.equal(room.state, 'provisioning');
});

test('recoverRoom resumes the durable provisioning boundary with exactly one live packet', async () => {
  const f = fixture();
  f.registry.failCreate = new Error('crash before live packet creation');
  await assert.rejects(create(f), /crash before live/);
  const provisional = await f.store.load(ROOM_ID);
  assert.equal(provisional.identity_cid, `provisioning:${ROOM_ID}`);
  assert.equal(f.registry.packets.size, 0);

  const recovered = await f.service.recoverRoom(ROOM_ID);
  assert.equal(recovered.identity_cid, `cid-room-${ROOM_ID}`);
  assert.equal(f.registry.packets.size, 1);
  assert.equal(f.registry.createCalls.length, 2);
});

test('invite passes the typed mode and persists metadata without the secret blob', async () => {
  const f = fixture();
  await create(f);
  const receipt = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 2 });
  const packet = f.registry.get(ROOM_ID);
  assert.deepEqual(packet.mintCalls, ['public']);
  assert.equal(receipt.blob, 'SECRET-BLOB-core-invite-1');
  assert.equal(receipt.invite.invite_id, 'core-invite-1');
  assert.equal(receipt.invite.mode, 'public');
  assert.equal(receipt.reusable, true);
  assert.equal(JSON.stringify(await f.store.load(ROOM_ID)).includes('SECRET-BLOB'), false);
  await assert.rejects(
    f.service.createInvite(ROOM_ID, { mode: 'one_time', role: 'x', min_accepts: 1, invite_id: 'forged' }),
    /unrecognized|invalid/i,
  );
  assert.deepEqual(packet.mintCalls, ['public']);
});

test('revoke calls the packet once and repeated revocation is idempotent', async () => {
  const f = fixture();
  await create(f);
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'one_time', role: 'builder', min_accepts: 1 });
  const first = await f.service.revokeInvite(ROOM_ID, invite.invite_id);
  const second = await f.service.revokeInvite(ROOM_ID, invite.invite_id);
  assert.equal(first.state, 'revoked');
  assert.deepEqual(second, first);
  assert.deepEqual(f.registry.get(ROOM_ID).revokeCalls, [invite.invite_id]);
});

test('recovery replaces absent core secrets, returns only the new blob, and is idempotent', async () => {
  const f = fixture();
  await create(f);
  const original = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 2 });
  const packet = f.registry.get(ROOM_ID);
  packet.invites = []; // faithful recreation: the public-invite secret is absent

  const receipts = await f.service.recoverInvites(ROOM_ID);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].recovery_of, original.invite.invite_id);
  assert.equal(receipts[0].invite.invite_id, 'core-invite-2');
  assert.equal(receipts[0].invite.mode, 'public');
  assert.equal(receipts[0].invite.role, 'reviewer');
  assert.equal(receipts[0].invite.min_accepts, 2);
  assert.equal(receipts[0].blob, 'SECRET-BLOB-core-invite-2');
  const stored = await f.store.load(ROOM_ID);
  assert.equal(stored.invites.find((invite) => invite.invite_id === original.invite.invite_id).state, 'revoked');
  assert.equal(stored.invites.find((invite) => invite.invite_id === 'core-invite-2').state, 'live');
  assert.equal(JSON.stringify(stored).includes('SECRET-BLOB'), false);
  assert.deepEqual(await f.service.recoverInvites(ROOM_ID), []);
});

test('recovery save failure revokes the unrecorded replacement and a retry mints a fresh receipt', async () => {
  const f = fixture();
  await create(f);
  await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.invites = [];
  let failReplacementSave = true;
  f.store.beforeSave = (room) => {
    if (failReplacementSave && room.invites.some((invite) => invite.invite_id === 'core-invite-2')) {
      failReplacementSave = false;
      throw new Error('injected replacement metadata failure');
    }
  };
  await assert.rejects(f.service.recoverInvites(ROOM_ID), /replacement metadata failure/);
  assert(packet.revokeCalls.includes('core-invite-2'), 'the unrecorded blob must be invalidated when possible');
  assert.equal((await f.store.load(ROOM_ID)).invites.some((invite) => invite.invite_id === 'core-invite-2'), false);

  f.store.beforeSave = undefined;
  const retried = await f.service.recoverInvites(ROOM_ID);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].invite.invite_id, 'core-invite-3');
  assert.equal(retried[0].blob, 'SECRET-BLOB-core-invite-3');
});

test('reconciliation revokes a core invite orphaned before its metadata save', async () => {
  const f = fixture();
  await create(f);
  const packet = f.registry.get(ROOM_ID);
  packet.invites = [{ invite_id: 'orphan-after-crash', mode: 'public' }];
  await f.service.reconcileRoom(ROOM_ID);
  assert(packet.revokeCalls.includes('orphan-after-crash'));
  assert.equal((await f.store.load(ROOM_ID)).invites.length, 0);
});

test('admission uses only exact invite origins, never contact names or roles for authorization', async () => {
  const f = fixture();
  await create(f);
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'trusted-looking label', min_accepts: 2 });
  const packet = f.registry.get(ROOM_ID);
  packet.contacts = [
    { name: 'core-invite-1', container_id: 'cid-no-origin' },
    { name: 'Admin', container_id: 'cid-wrong-via' },
    { name: 'Same Role', container_id: 'cid-wrong-invite' },
    { name: 'Alice', container_id: 'cid-alice' },
    { name: 'Alice duplicate', container_id: 'cid-alice' },
  ];
  packet.origins = {
    'cid-wrong-via': { via: 'direct', invite_id: invite.invite_id, at: TIMES[2] },
    'cid-wrong-invite': { via: 'invite_public', invite_id: 'another-room-invite', at: TIMES[2] },
    'cid-alice': { via: 'invite_public', invite_id: invite.invite_id, at: TIMES[2] },
  };
  const room = await f.service.reconcileRoom(ROOM_ID);
  assert.deepEqual(room.seats, [{
    identity: 'cid-alice', display_name: 'Alice', role: 'trusted-looking label',
    invite_id: invite.invite_id, accepted_at: TIMES[2],
  }]);
  assert.deepEqual(room.invites[0].accepted_cids, ['cid-alice']);
  assert.equal(room.state, 'provisioning', 'two accepts are required');
});

test('activation requires every non-revoked requirement and at least one unique seat', async () => {
  const f = fixture();
  await create(f);
  const required = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 2 });
  const waived = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'observer', min_accepts: 5 });
  await f.service.revokeInvite(ROOM_ID, waived.invite.invite_id);
  const packet = f.registry.get(ROOM_ID);
  packet.contacts = [{ name: 'Alice', container_id: 'cid-alice' }];
  packet.origins = { 'cid-alice': { via: 'invite_public', invite_id: required.invite.invite_id, at: TIMES[4] } };
  assert.equal((await f.service.reconcileRoom(ROOM_ID)).state, 'provisioning');

  packet.contacts.push({ name: 'Bob', container_id: 'cid-bob' });
  packet.origins['cid-bob'] = { via: 'invite_public', invite_id: required.invite.invite_id, at: TIMES[5] };
  const active = await f.service.reconcileRoom(ROOM_ID);
  assert.equal(active.state, 'active');
  assert(active.activated_at);
  const briefing = (await f.store.read(ROOM_ID)).filter((record) => record.kind === 'message');
  assert.equal(briefing.length, 1);
  assert.equal(briefing[0].category, 'briefing');
  assert.equal(briefing[0].text, 'Read the mission.');
});

test('a seat admitted after activation gets a new durable briefing and duplicate CID gets none', async () => {
  const f = fixture();
  await create(f);
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.contacts = [{ name: 'Alice', container_id: 'cid-alice' }];
  packet.origins = { 'cid-alice': { via: 'invite_public', invite_id: invite.invite_id, at: TIMES[3] } };
  await f.service.reconcileRoom(ROOM_ID);

  packet.contacts.push({ name: 'Alice again', container_id: 'cid-alice' }, { name: 'Bob', container_id: 'cid-bob' });
  packet.origins['cid-bob'] = { via: 'invite_public', invite_id: invite.invite_id, at: TIMES[4] };
  const afterLateJoin = await f.service.reconcileRoom(ROOM_ID);
  await f.service.reconcileRoom(ROOM_ID);
  assert.deepEqual(afterLateJoin.seats.map((seat) => seat.identity), ['cid-alice', 'cid-bob']);
  const records = await f.store.read(ROOM_ID);
  const briefings = records.filter((record) => record.kind === 'message');
  assert.equal(briefings.length, 2);
  const lateIntents = records.filter((record) => record.kind === 'relay_intent' && record.message_id === briefings[1].message_id);
  assert.deepEqual(lateIntents.map((record) => record.recipient_identity), ['cid-bob']);
});

test('activation resumes after crashes between briefing, intents, and metadata without duplication', async () => {
  const f = fixture();
  await create(f);
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.contacts = [{ name: 'Alice', container_id: 'cid-alice' }];
  packet.origins = { 'cid-alice': { via: 'invite_public', invite_id: invite.invite_id, at: TIMES[3] } };

  let failIntent = true;
  f.store.beforeAppend = (draft) => {
    if (failIntent && draft.kind === 'relay_intent') {
      failIntent = false;
      throw new Error('crash after briefing append');
    }
  };
  await assert.rejects(f.service.reconcileRoom(ROOM_ID), /crash after briefing/);
  assert.equal((await f.store.read(ROOM_ID)).filter((record) => record.kind === 'message').length, 1);
  assert.equal((await f.store.load(ROOM_ID)).state, 'provisioning');

  f.store.beforeAppend = undefined;
  let failActivationSave = true;
  f.store.beforeSave = (room) => {
    if (failActivationSave && room.state === 'active') {
      failActivationSave = false;
      throw new Error('crash after intent append');
    }
  };
  await assert.rejects(f.service.reconcileRoom(ROOM_ID), /crash after intent/);
  f.store.beforeSave = undefined;
  const active = await f.service.reconcileRoom(ROOM_ID);
  assert.equal(active.state, 'active');
  const records = await f.store.read(ROOM_ID);
  assert.equal(records.filter((record) => record.kind === 'message').length, 1);
  assert.equal(records.filter((record) => record.kind === 'relay_intent').length, 1);
});

test('concurrent reconciliation and a late-seat save retry produce one seat and one late briefing', async () => {
  const f = fixture();
  await create(f);
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.contacts = [{ name: 'Alice', container_id: 'cid-alice' }];
  packet.origins = { 'cid-alice': { via: 'invite_public', invite_id: invite.invite_id, at: TIMES[3] } };
  await Promise.all([f.service.reconcileRoom(ROOM_ID), f.service.reconcileRoom(ROOM_ID)]);
  assert.equal((await f.service.participants(ROOM_ID)).length, 1);

  packet.contacts.push({ name: 'Bob', container_id: 'cid-bob' });
  packet.origins['cid-bob'] = { via: 'invite_public', invite_id: invite.invite_id, at: TIMES[4] };
  let failLateSeatSave = true;
  f.store.beforeSave = (room) => {
    if (failLateSeatSave && room.seats.some((seat) => seat.identity === 'cid-bob')) {
      failLateSeatSave = false;
      throw new Error('crash after late briefing intent');
    }
  };
  await assert.rejects(f.service.reconcileRoom(ROOM_ID), /late briefing intent/);
  f.store.beforeSave = undefined;
  await Promise.all([f.service.reconcileRoom(ROOM_ID), f.service.reconcileRoom(ROOM_ID)]);
  const room = await f.service.showRoom(ROOM_ID);
  assert.deepEqual(room.seats.map((seat) => seat.identity), ['cid-alice', 'cid-bob']);
  const records = await f.store.read(ROOM_ID);
  assert.equal(records.filter((record) => record.kind === 'message').length, 2);
  assert.equal(records.filter((record) => record.kind === 'relay_intent' && record.recipient_identity === 'cid-bob').length, 1);
});

test('projections update settings and page numeric history without exposing invite blobs', async () => {
  const f = fixture();
  await create(f);
  await f.service.createInvite(ROOM_ID, { mode: 'one_time', role: 'builder', min_accepts: 1 });
  const updated = await f.service.updateRoom(ROOM_ID, { status: 'working', goal: 'New goal' });
  assert.equal(updated.status, 'working');
  assert.equal(updated.mission.goal, 'New goal');
  assert.equal((await f.service.listRooms()).length, 1);
  assert.equal((await f.service.showRoom(ROOM_ID)).room_id, ROOM_ID);
  assert.deepEqual(await f.service.participants(ROOM_ID), []);
  assert.deepEqual(await f.service.history(ROOM_ID, { after: 0, limit: 10 }), []);
  assert.equal(JSON.stringify(await f.service.showRoom(ROOM_ID)).includes('SECRET-BLOB'), false);
});
