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
  afterSave;
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
    if (this.afterSave) await this.afterSave(room);
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
  revokeFailures = new Map();
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
    const failure = this.revokeFailures.get(inviteId);
    if (failure) {
      this.revokeFailures.delete(inviteId);
      throw failure;
    }
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
  restoreCalls = [];
  failCreate;
  restoreResult;
  restoreFailure = new Error('live packet state is missing');

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

  async restore(roomId, expectedCid) {
    this.restoreCalls.push({ roomId, expectedCid });
    if (this.restoreResult) {
      this.packets.set(roomId, this.restoreResult);
      return this.restoreResult;
    }
    throw this.restoreFailure;
  }
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
  assert.equal(provisional.identity_cid, '');
  assert.equal(provisional.status, 'packet_pending');
  assert.equal(f.registry.packets.size, 0);

  const recovered = await f.service.recoverRoom(ROOM_ID);
  assert.equal(recovered.identity_cid, `cid-room-${ROOM_ID}`);
  assert.equal(f.registry.packets.size, 1);
  assert.equal(f.registry.createCalls.length, 2);
});

test('metadata-boundary crash resumes the already provisioned packet without duplication', async () => {
  const f = fixture();
  let crashed = false;
  const interrupted = new RoomService(f.store, f.registry, {
    roomId: () => ROOM_ID,
    messageId: () => MESSAGE_IDS[0],
    now: () => TIMES[0],
    provisioningCheckpoint(stage) {
      if (!crashed && stage === 'metadata') {
        crashed = true;
        throw new Error('crash at metadata');
      }
    },
  });
  await assert.rejects(
    interrupted.createRoom({ goal: 'Ship the room', briefing: 'Read the mission.' }),
    /crash at metadata/,
  );
  assert.equal(f.registry.packets.size, 1);
  const recovered = await f.service.recoverPacket(ROOM_ID);
  assert.equal(recovered.identity_cid, `cid-room-${ROOM_ID}`);
  assert.equal(f.registry.packets.size, 1);
  assert.equal(f.registry.createCalls.length, 1);
});

test('recoverRoom restores rather than creates when a packet exists behind the provisioning sentinel', async () => {
  const f = fixture();
  f.registry.failCreate = new Error('crash after metadata reservation');
  await assert.rejects(create(f), /metadata reservation/);
  const restored = new FakePacket(`cowork-room-${ROOM_ID}`, 'cid-restored-from-live');
  f.registry.restoreResult = restored;
  const createCount = f.registry.createCalls.length;
  const recovered = await f.service.recoverRoom(ROOM_ID);
  assert.equal(recovered.identity_cid, restored.cid);
  assert.equal('status' in recovered, false);
  assert.equal(f.registry.createCalls.length, createCount);
  assert.deepEqual(f.registry.restoreCalls, [{ roomId: ROOM_ID, expectedCid: undefined }]);
});

test('recoverRoom never creates over an established CID when restore fails', async () => {
  for (const state of ['active', 'closing', 'provisioning']) {
    const f = fixture();
    await create(f);
    const created = await f.store.load(ROOM_ID);
    const established = {
      ...created,
      state,
      ...(state === 'active' ? { activated_at: TIMES[2] } : {}),
    };
    await f.store.save(established);
    f.registry.packets.clear();
    f.registry.restoreFailure = new Error(`injected ${state} restore failure`);
    const createCount = f.registry.createCalls.length;
    await assert.rejects(f.service.recoverRoom(ROOM_ID), new RegExp(`${state} restore failure`));
    assert.deepEqual(f.registry.restoreCalls, [{ roomId: ROOM_ID, expectedCid: established.identity_cid }]);
    assert.equal(f.registry.createCalls.length, createCount, `${state} must be restore-only`);
    assert.deepEqual(await f.store.load(ROOM_ID), established, `${state} metadata must remain unchanged`);
  }
});

test('recoverRoom rejects a restored CID mismatch without changing established metadata', async () => {
  for (const state of ['active', 'closing', 'provisioning']) {
    const f = fixture();
    await create(f);
    const created = await f.store.load(ROOM_ID);
    const established = {
      ...created,
      state,
      ...(state === 'active' ? { activated_at: TIMES[2] } : {}),
    };
    await f.store.save(established);
    f.registry.packets.clear();
    f.registry.restoreResult = new FakePacket(`cowork-room-${ROOM_ID}`, `cid-wrong-${state}`);
    const createCount = f.registry.createCalls.length;
    await assert.rejects(f.service.recoverRoom(ROOM_ID), /CID mismatch/i);
    assert.deepEqual(f.registry.restoreCalls, [{ roomId: ROOM_ID, expectedCid: established.identity_cid }]);
    assert.equal(f.registry.createCalls.length, createCount);
    assert.deepEqual(await f.store.load(ROOM_ID), established);
  }
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

test('revoke rejects closing and closed rooms before calling core', async () => {
  for (const state of ['closing', 'closed']) {
    const f = fixture();
    await create(f);
    const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'one_time', role: 'builder', min_accepts: 1 });
    const packet = f.registry.get(ROOM_ID);
    const room = await f.store.load(ROOM_ID);
    await f.store.save({ ...room, state, ...(state === 'closed' ? { closed_at: TIMES[3] } : {}) });
    await assert.rejects(f.service.revokeInvite(ROOM_ID, invite.invite_id), new RegExp(state));
    assert.deepEqual(packet.revokeCalls, []);
  }
});

test('revoking a replacement source cascades pending child first and retry converges after failure', async () => {
  const f = fixture();
  await create(f);
  const original = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.invites = [];
  const [receipt] = await f.service.recoverInvites(ROOM_ID);
  packet.revokeCalls.length = 0;
  packet.revokeFailures.set(original.invite.invite_id, new Error('injected source revoke failure'));

  await assert.rejects(f.service.revokeInvite(ROOM_ID, original.invite.invite_id), /source revoke failure/);
  assert.deepEqual(packet.revokeCalls, [receipt.invite.invite_id, original.invite.invite_id]);
  let stored = await f.store.load(ROOM_ID);
  assert.equal(stored.invites.find((invite) => invite.invite_id === original.invite.invite_id).state, 'replacement_required');
  assert.equal(stored.invites.find((invite) => invite.invite_id === receipt.invite.invite_id).state, 'receipt_pending');

  const revoked = await f.service.revokeInvite(ROOM_ID, original.invite.invite_id);
  assert.equal(revoked.state, 'revoked');
  assert.deepEqual(packet.revokeCalls, [
    receipt.invite.invite_id, original.invite.invite_id,
    receipt.invite.invite_id, original.invite.invite_id,
  ]);
  stored = await f.store.load(ROOM_ID);
  assert.equal(stored.invites.find((invite) => invite.invite_id === original.invite.invite_id).state, 'revoked');
  const child = stored.invites.find((invite) => invite.invite_id === receipt.invite.invite_id);
  assert.equal(child.state, 'revoked');
  assert.equal(child.recovery_of, original.invite.invite_id);
  await f.service.revokeInvite(ROOM_ID, original.invite.invite_id);
  assert.equal(packet.revokeCalls.length, 4, 'committed cascade replay must have no effects');
});

test('recovery persists a pending descriptor, rotates a lost receipt, and confirms idempotently', async () => {
  const f = fixture();
  await create(f);
  const original = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 2 });
  const packet = f.registry.get(ROOM_ID);
  packet.invites = []; // faithful recreation: the public-invite secret is absent

  const [lostReceipt] = await f.service.recoverInvites(ROOM_ID);
  assert.equal(lostReceipt.recovery_of, original.invite.invite_id);
  assert.equal(lostReceipt.invite.invite_id, 'core-invite-2');
  let stored = await f.store.load(ROOM_ID);
  assert.equal(stored.invites.find((invite) => invite.invite_id === original.invite.invite_id).state, 'replacement_required');
  assert.deepEqual(stored.invites.find((invite) => invite.invite_id === 'core-invite-2'), {
    ...lostReceipt.invite,
    state: 'receipt_pending',
    recovery_of: original.invite.invite_id,
    recovery_confirmed: false,
  });
  assert.equal(JSON.stringify(stored).includes('SECRET-BLOB'), false);

  // The first response was lost before confirm. Retry must invalidate that
  // inaccessible blob and return a freshly persisted descriptor/blob pair.
  const [receipt] = await f.service.recoverInvites(ROOM_ID);
  assert(packet.revokeCalls.includes('core-invite-2'));
  assert.equal(receipt.invite.invite_id, 'core-invite-3');
  assert.equal(receipt.blob, 'SECRET-BLOB-core-invite-3');
  stored = await f.store.load(ROOM_ID);
  assert.equal(stored.invites.find((invite) => invite.invite_id === 'core-invite-2').state, 'revoked');
  assert.equal(stored.invites.find((invite) => invite.invite_id === 'core-invite-3').state, 'receipt_pending');

  const confirmed = await f.service.confirmRecoveredInvite(ROOM_ID, original.invite.invite_id, receipt.invite.invite_id);
  assert.equal(confirmed.state, 'live');
  assert.equal(confirmed.recovery_of, original.invite.invite_id);
  assert.equal(confirmed.recovery_confirmed, true);
  const replay = await f.service.confirmRecoveredInvite(ROOM_ID, original.invite.invite_id, receipt.invite.invite_id);
  assert.deepEqual(replay, confirmed);
  stored = await f.store.load(ROOM_ID);
  assert.equal(stored.invites.find((invite) => invite.invite_id === original.invite.invite_id).state, 'revoked');
  assert.equal(stored.invites.find((invite) => invite.invite_id === 'core-invite-3').state, 'live');
});

test('confirm replay requires exact durable lineage and one-time consumption retains it', async () => {
  const f = fixture();
  await create(f);
  const original = await f.service.createInvite(ROOM_ID, { mode: 'one_time', role: 'builder', min_accepts: 1 });
  const unrelated = await f.service.createInvite(ROOM_ID, { mode: 'one_time', role: 'other', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.invites = packet.invites.filter((invite) => invite.invite_id === unrelated.invite.invite_id);
  const [receipt] = await f.service.recoverInvites(ROOM_ID);
  await f.service.confirmRecoveredInvite(ROOM_ID, original.invite.invite_id, receipt.invite.invite_id);
  await assert.rejects(
    f.service.confirmRecoveredInvite(ROOM_ID, original.invite.invite_id, unrelated.invite.invite_id),
    /lineage|pointer|descriptor/i,
  );

  packet.contacts = [{ name: 'Alice', container_id: 'cid-alice' }];
  packet.origins = {
    'cid-alice': { via: 'invite_one_time', invite_id: receipt.invite.invite_id, at: TIMES[5] },
  };
  packet.invites = packet.invites.filter((invite) => invite.invite_id !== receipt.invite.invite_id);
  const reconciled = await f.service.reconcileRoom(ROOM_ID);
  const consumed = reconciled.invites.find((invite) => invite.invite_id === receipt.invite.invite_id);
  assert.equal(consumed.state, 'consumed');
  assert.equal(consumed.recovery_of, original.invite.invite_id);
  assert.equal(consumed.recovery_confirmed, true);
  assert.deepEqual(
    await f.service.confirmRecoveredInvite(ROOM_ID, original.invite.invite_id, receipt.invite.invite_id),
    consumed,
  );
});

test('discarded pending lineage cannot admit or satisfy confirm after rotation/cascade', async () => {
  const f = fixture();
  await create(f);
  const original = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.invites = [];
  const [discarded] = await f.service.recoverInvites(ROOM_ID);
  await f.service.recoverInvites(ROOM_ID); // rotates discarded to revoked/unconfirmed

  packet.contacts = [{ name: 'Discarded contact', container_id: 'cid-discarded' }];
  packet.origins = {
    'cid-discarded': { via: 'invite_public', invite_id: discarded.invite.invite_id, at: TIMES[5] },
  };
  let room = await f.service.reconcileRoom(ROOM_ID);
  const retired = room.invites.find((invite) => invite.invite_id === discarded.invite.invite_id);
  assert.equal(retired.state, 'revoked');
  assert.equal(retired.recovery_confirmed, false);
  assert.deepEqual(room.seats, [], 'a discarded pending blob must never authorize a seat');

  const latestPending = room.invites.find((invite) =>
    invite.state === 'receipt_pending' && invite.recovery_of === original.invite.invite_id);
  await f.service.revokeInvite(ROOM_ID, original.invite.invite_id); // cascade latest pending + source
  await assert.rejects(
    f.service.confirmRecoveredInvite(ROOM_ID, original.invite.invite_id, latestPending.invite_id),
    /confirm|lineage|pointer|state/i,
  );
  room = await f.service.showRoom(ROOM_ID);
  assert.equal(room.invites.find((invite) => invite.invite_id === latestPending.invite_id).recovery_confirmed, false);
});

test('confirmed then revoked recovery lineage remains historically admissible and replay-valid', async () => {
  const f = fixture();
  await create(f);
  const original = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'confirmed-role', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.invites = [];
  const [receipt] = await f.service.recoverInvites(ROOM_ID);
  await f.service.confirmRecoveredInvite(ROOM_ID, original.invite.invite_id, receipt.invite.invite_id);
  await f.service.revokeInvite(ROOM_ID, receipt.invite.invite_id);

  packet.contacts = [{ name: 'Accepted before confirmed revoke', container_id: 'cid-confirmed' }];
  packet.origins = {
    'cid-confirmed': { via: 'invite_public', invite_id: receipt.invite.invite_id, at: TIMES[5] },
  };
  const room = await f.service.reconcileRoom(ROOM_ID);
  assert.deepEqual(room.seats.map((seat) => [seat.identity, seat.role]), [['cid-confirmed', 'confirmed-role']]);
  const revoked = room.invites.find((invite) => invite.invite_id === receipt.invite.invite_id);
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.recovery_confirmed, true);
  assert.deepEqual(
    await f.service.confirmRecoveredInvite(ROOM_ID, original.invite.invite_id, receipt.invite.invite_id),
    revoked,
  );
});

test('contacts accepted before revocation or replacement are still admitted by exact origin', async () => {
  const f = fixture();
  await create(f);
  const revokedInvite = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'revoked-role', min_accepts: 1 });
  const missingInvite = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'missing-role', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.contacts = [
    { name: 'Before revoke', container_id: 'cid-revoked' },
    { name: 'Before restore', container_id: 'cid-replacement' },
  ];
  packet.origins = {
    'cid-revoked': { via: 'invite_public', invite_id: revokedInvite.invite.invite_id, at: TIMES[4] },
    'cid-replacement': { via: 'invite_public', invite_id: missingInvite.invite.invite_id, at: TIMES[5] },
  };
  await f.service.revokeInvite(ROOM_ID, revokedInvite.invite.invite_id);
  packet.invites = packet.invites.filter((invite) => invite.invite_id !== missingInvite.invite.invite_id);

  const room = await f.service.reconcileRoom(ROOM_ID);
  assert.deepEqual(room.seats.map((seat) => [seat.identity, seat.role]), [
    ['cid-revoked', 'revoked-role'],
    ['cid-replacement', 'missing-role'],
  ]);
  assert.equal(room.invites.find((invite) => invite.invite_id === revokedInvite.invite.invite_id).state, 'revoked');
  assert.equal(room.invites.find((invite) => invite.invite_id === missingInvite.invite.invite_id).state, 'replacement_required');
});

test('ambiguous recovery save revokes/records the pending replacement and retry converges', async () => {
  const f = fixture();
  await create(f);
  await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.invites = [];
  let failReplacementReply = true;
  f.store.afterSave = (room) => {
    if (failReplacementReply && room.invites.some((invite) => invite.invite_id === 'core-invite-2' && invite.state === 'receipt_pending')) {
      failReplacementReply = false;
      throw new Error('injected post-save pre-reply failure');
    }
  };
  await assert.rejects(f.service.recoverInvites(ROOM_ID), /post-save pre-reply/);
  assert(packet.revokeCalls.includes('core-invite-2'), 'the unrecorded blob must be invalidated when possible');
  assert.notEqual((await f.store.load(ROOM_ID)).invites.find((invite) => invite.invite_id === 'core-invite-2')?.state, 'live');

  f.store.afterSave = undefined;
  const retried = await f.service.recoverInvites(ROOM_ID);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].invite.invite_id, 'core-invite-3');
  assert.equal(retried[0].blob, 'SECRET-BLOB-core-invite-3');
});

test('receipt-pending IDs never admit seats and survive startup reconciliation as known descriptors', async () => {
  const f = fixture();
  await create(f);
  await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.invites = [];
  const [receipt] = await f.service.recoverInvites(ROOM_ID);
  const revokeCount = packet.revokeCalls.length;
  packet.contacts = [{ name: 'Pending Alice', container_id: 'cid-pending' }];
  packet.origins = {
    'cid-pending': { via: 'invite_public', invite_id: receipt.invite.invite_id, at: TIMES[4] },
  };

  const reconciled = await f.service.reconcileRoom(ROOM_ID);
  assert.deepEqual(reconciled.seats, []);
  assert.equal(reconciled.invites.find((invite) => invite.invite_id === receipt.invite.invite_id).state, 'receipt_pending');
  assert.equal(packet.revokeCalls.length, revokeCount, 'startup reconcile must not treat pending as an orphan');
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
  assert.equal(room.seats.length, 1);
  const { participant_id, ...seat } = room.seats[0];
  assert.match(participant_id, /^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  assert.deepEqual(seat, {
    identity: 'cid-alice', display_name: 'Alice', role: 'trusted-looking label',
    invite_id: invite.invite_id, accepted_at: TIMES[2], state: 'active',
  });
  assert.deepEqual(room.invites[0].accepted_cids, ['cid-alice']);
  assert.equal(room.state, 'provisioning', 'two accepts are required');
});

test('live contact acceptance admits and activates before immediate intake without manual recovery', async () => {
  const f = fixture();
  await create(f);
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.contacts = [{ name: 'Alice', container_id: 'cid-alice' }];
  packet.origins = {
    'cid-alice': { via: 'invite_public', invite_id: invite.invite_id, at: TIMES[2] },
  };

  await Promise.all([
    f.service.notifyRoom(ROOM_ID, 'contact_accepted'),
    f.service.notifyRoom(ROOM_ID, 'message_received'),
    f.service.notifyRoom(ROOM_ID, 'contact_accepted'),
  ]);

  const room = await f.service.showRoom(ROOM_ID);
  assert.equal(room.state, 'active');
  assert.deepEqual(room.seats.map((seat) => [seat.identity, seat.role]), [['cid-alice', 'reviewer']]);
  assert.deepEqual(room.invites[0].accepted_cids, ['cid-alice']);
  const records = await f.service.history(ROOM_ID);
  assert.equal(records.filter((record) => record.kind === 'message' && record.category === 'briefing').length, 1);
  assert.equal(records.filter((record) => record.kind === 'relay_intent').length, 1);
  assert.equal(records.filter((record) => record.kind === 'relay_result').length, 1);
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
  assert.deepEqual(briefing[0].recipient_identities, ['cid-alice', 'cid-bob']);
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
  assert.deepEqual(briefings[1].recipient_identities, ['cid-bob']);
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

test('a seat appearing after activation briefing fsync gets a distinct exact-snapshot briefing on recovery', async () => {
  const f = fixture();
  await create(f);
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 1 });
  const packet = f.registry.get(ROOM_ID);
  packet.contacts = [{ name: 'Alice', container_id: 'cid-alice' }];
  packet.origins = { 'cid-alice': { via: 'invite_public', invite_id: invite.invite_id, at: TIMES[3] } };
  let fail = true;
  f.store.beforeAppend = (draft) => {
    if (fail && draft.kind === 'relay_intent') {
      fail = false;
      throw new Error('crash after exact briefing snapshot');
    }
  };
  await assert.rejects(f.service.reconcileRoom(ROOM_ID), /exact briefing snapshot/);

  packet.contacts.push({ name: 'Bob', container_id: 'cid-bob' });
  packet.origins['cid-bob'] = { via: 'invite_public', invite_id: invite.invite_id, at: TIMES[4] };
  f.store.beforeAppend = undefined;
  assert.equal((await f.service.reconcileRoom(ROOM_ID)).state, 'active');
  const records = await f.store.read(ROOM_ID);
  const briefings = records.filter((record) => record.kind === 'message');
  assert.deepEqual(briefings.map((message) => message.recipient_identities), [['cid-alice'], ['cid-bob']]);
  assert.deepEqual(records.filter((record) => record.kind === 'relay_intent')
    .map((intent) => intent.recipient_identity), ['cid-alice', 'cid-bob']);
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

// ---- Rooms evolution Phase A2 (spec §3.3, §8.2) — dual briefings ----

function evolutionFixture() {
  const store = new MemoryStore();
  const registry = new FakeRegistry();
  let messageIndex = 0;
  let tick = 0;
  const service = new RoomService(store, registry, {
    roomId: () => ROOM_ID,
    messageId: () => `01jz6y7n8p9q0r1s2t3v4w6${String(messageIndex++).padStart(3, '0')}`.slice(0, 26),
    now: () => new Date(Date.UTC(2026, 7, 2, 10, 11, 12, tick++)).toISOString(),
  });
  return { store, registry, service };
}

async function admit(f, invite, cid, name, at = '2026-08-02T10:20:00.000Z') {
  const packet = f.registry.get(ROOM_ID);
  packet.contacts.push({ name, container_id: cid });
  packet.origins[cid] = { via: 'invite_public', invite_id: invite.invite_id, at };
  return f.service.reconcileRoom(ROOM_ID);
}

function briefingsOf(records, category) {
  return records.filter((record) => record.kind === 'message' && record.category === category);
}

function intentsFor(records, messageId) {
  return records.filter((record) => record.kind === 'relay_intent' && record.message_id === messageId)
    .map((record) => record.recipient_identity);
}

test('activation delivers the common briefing and the seat role briefing exactly once', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common mission.' });
  await f.service.setRoleBriefing(ROOM_ID, { role: 'reviewer', text: 'Review the diffs.' });
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 1 });
  await admit(f, invite, 'cid-alice', 'Alice');
  await f.service.reconcileRoom(ROOM_ID);

  const records = await f.store.read(ROOM_ID);
  const common = briefingsOf(records, 'briefing');
  const roled = briefingsOf(records, 'role_briefing');
  assert.equal(common.length, 1);
  assert.equal(common[0].briefing_version, 1);
  assert.equal(common[0].text, 'Common mission.');
  assert.deepEqual(common[0].recipient_identities, ['cid-alice']);
  assert.equal(roled.length, 1);
  assert.equal(roled[0].briefing_role, 'reviewer');
  assert.equal(roled[0].briefing_version, 1);
  assert.equal(roled[0].text, 'Review the diffs.');
  assert.deepEqual(roled[0].recipient_identities, ['cid-alice']);
  assert.deepEqual(intentsFor(records, common[0].message_id), ['cid-alice']);
  assert.deepEqual(intentsFor(records, roled[0].message_id), ['cid-alice']);
  // the room voice authors both
  assert.equal(common[0].author.role, 'room');
  assert.equal(roled[0].author.role, 'room');
});

test('a role without a briefing gets only the common briefing and no failure', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common mission.' });
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'writer', min_accepts: 1 });
  await admit(f, invite, 'cid-alice', 'Alice');
  const records = await f.store.read(ROOM_ID);
  assert.equal(briefingsOf(records, 'briefing').length, 1);
  assert.equal(briefingsOf(records, 'role_briefing').length, 0);
});

test('late and replacement seats receive both briefings at their current versions once', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common v1.' });
  await f.service.setRoleBriefing(ROOM_ID, { role: 'reviewer', text: 'Role v1.' });
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 1 });
  await admit(f, invite, 'cid-alice', 'Alice');

  // bump both briefings after activation
  await f.service.updateRoom(ROOM_ID, { briefing: 'Common v2.' });
  await f.service.setRoleBriefing(ROOM_ID, { role: 'reviewer', text: 'Role v2.' });

  await admit(f, invite, 'cid-bob', 'Bob', '2026-08-02T10:30:00.000Z');
  await f.service.reconcileRoom(ROOM_ID);

  const records = await f.store.read(ROOM_ID);
  const common = briefingsOf(records, 'briefing');
  const roled = briefingsOf(records, 'role_briefing');
  // v1 to alice, v2 re-delivery to alice, v2 to late bob
  assert.deepEqual(
    common.map((message) => [message.briefing_version, message.recipient_identities]),
    [[1, ['cid-alice']], [2, ['cid-alice']], [2, ['cid-bob']]],
  );
  assert.deepEqual(
    roled.map((message) => [message.briefing_version, message.recipient_identities]),
    [[1, ['cid-alice']], [2, ['cid-alice']], [2, ['cid-bob']]],
  );
  assert.equal(common.at(-1).text, 'Common v2.');
  assert.equal(roled.at(-1).text, 'Role v2.');
});

test('briefing version bumps re-deliver exactly to the affected seats', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common v1.' });
  await f.service.setRoleBriefing(ROOM_ID, { role: 'reviewer', text: 'Reviewer v1.' });
  await f.service.setRoleBriefing(ROOM_ID, { role: 'writer', text: 'Writer v1.' });
  const { invite: reviewerInvite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 1 });
  const { invite: writerInvite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'writer', min_accepts: 1 });
  await admit(f, reviewerInvite, 'cid-alice', 'Alice');
  await admit(f, writerInvite, 'cid-bob', 'Bob', '2026-08-02T10:21:00.000Z');

  // reviewer-only bump touches only alice
  await f.service.setRoleBriefing(ROOM_ID, { role: 'reviewer', text: 'Reviewer v2.' });
  let records = await f.store.read(ROOM_ID);
  const reviewerV2 = briefingsOf(records, 'role_briefing')
    .filter((message) => message.briefing_role === 'reviewer' && message.briefing_version === 2);
  assert.deepEqual(reviewerV2.map((message) => message.recipient_identities), [['cid-alice']]);
  assert.equal(briefingsOf(records, 'role_briefing')
    .filter((message) => message.briefing_role === 'writer').length, 1);

  // common bump touches everyone
  await f.service.updateRoom(ROOM_ID, { briefing: 'Common v2.' });
  records = await f.store.read(ROOM_ID);
  const commonV2 = briefingsOf(records, 'briefing').filter((message) => message.briefing_version === 2);
  assert.equal(commonV2.length, 1);
  assert.deepEqual([...commonV2[0].recipient_identities].sort(), ['cid-alice', 'cid-bob']);

  // setting identical text is a no-op, not a version bump
  const before = (await f.store.read(ROOM_ID)).length;
  await f.service.setRoleBriefing(ROOM_ID, { role: 'reviewer', text: 'Reviewer v2.' });
  await f.service.updateRoom(ROOM_ID, { briefing: 'Common v2.' });
  assert.equal((await f.store.read(ROOM_ID)).length, before);
  const room = await f.service.showRoom(ROOM_ID);
  assert.equal(room.mission.briefing_version, 2);
  assert.equal(room.role_briefings.reviewer.version, 2);
});

test('role briefing authoring is operator-gated state with delete support', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common.' });
  const set = await f.service.setRoleBriefing(ROOM_ID, { role: 'reviewer', text: 'Role v1.' });
  assert.equal(set.role_briefings.reviewer.version, 1);
  assert.equal(set.role_briefings.reviewer.text, 'Role v1.');
  const removed = await f.service.deleteRoleBriefing(ROOM_ID, { role: 'reviewer' });
  assert.equal(removed.role_briefings.reviewer, undefined);
  // deleting an absent role briefing is an explicit error
  await assert.rejects(f.service.deleteRoleBriefing(ROOM_ID, { role: 'reviewer' }), /no role briefing/i);
  // closed rooms refuse briefing authoring
  f.store.rooms.get(ROOM_ID).state = 'closed';
  f.store.rooms.get(ROOM_ID).closed_at = '2026-08-02T11:00:00.000Z';
  await assert.rejects(f.service.setRoleBriefing(ROOM_ID, { role: 'reviewer', text: 'x' }), /closing|closed/i);
});

test('a crash between role-briefing append and its intent re-drives without duplication', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common mission.' });
  await f.service.setRoleBriefing(ROOM_ID, { role: 'reviewer', text: 'Role v1.' });
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'reviewer', min_accepts: 1 });

  let armed = true;
  f.store.beforeAppend = (draft) => {
    if (armed && draft.kind === 'relay_intent') {
      const messages = f.store.records.get(ROOM_ID).filter((record) =>
        record.kind === 'message' && record.category === 'role_briefing');
      if (messages.some((message) => message.message_id === draft.message_id)) {
        armed = false;
        throw new Error('crash after role briefing append');
      }
    }
  };
  const packet = f.registry.get(ROOM_ID);
  packet.contacts.push({ name: 'Alice', container_id: 'cid-alice' });
  packet.origins['cid-alice'] = { via: 'invite_public', invite_id: invite.invite_id, at: '2026-08-02T10:20:00.000Z' };
  await assert.rejects(f.service.reconcileRoom(ROOM_ID), /crash after role briefing/);

  f.store.beforeAppend = undefined;
  await f.service.reconcileRoom(ROOM_ID);
  await f.service.reconcileRoom(ROOM_ID);
  const records = await f.store.read(ROOM_ID);
  const roled = briefingsOf(records, 'role_briefing');
  assert.equal(roled.length, 1);
  assert.deepEqual(intentsFor(records, roled[0].message_id), ['cid-alice']);
  const common = briefingsOf(records, 'briefing');
  assert.equal(common.length, 1);
  assert.deepEqual(intentsFor(records, common[0].message_id), ['cid-alice']);
});

// ---- Rooms evolution Phase A4 (spec §5.2–§5.3, §8.4) — removal & replacement ----

function membershipRecords(records) {
  return {
    intents: records.filter((record) => record.kind === 'membership_intent'),
    results: records.filter((record) => record.kind === 'membership_result'),
    notices: records.filter((record) => record.kind === 'message' && record.category === 'membership'),
  };
}

test('removeParticipant journals intent/result, severs the channel, bumps the epoch once, and announces', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common.' });
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 1 });
  await admit(f, invite, 'cid-alice', 'Alice');
  await admit(f, invite, 'cid-bob', 'Bob', '2026-08-02T10:21:00.000Z');
  const packet = f.registry.get(ROOM_ID);
  packet.removeContactCalls = packet.removeContactCalls ?? [];
  const epochBefore = (await f.service.showRoom(ROOM_ID)).membership_epoch;

  const receipt = await f.service.removeParticipant(ROOM_ID, { participant: 'cid-alice' });
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.notified, true);
  assert.equal(receipt.key_material_retained, true);

  const room = await f.service.showRoom(ROOM_ID);
  const seat = room.seats.find((candidate) => candidate.identity === 'cid-alice');
  assert.equal(seat.state, 'removed');
  assert.equal(typeof seat.removed_at, 'string');
  assert.equal(seat.removed_epoch, epochBefore + 1);
  assert.equal(room.membership_epoch, epochBefore + 1);

  const records = await f.store.read(ROOM_ID);
  const { intents, results, notices } = membershipRecords(records);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].action, 'remove');
  assert.equal(intents[0].participant_id, seat.participant_id);
  assert.equal(intents[0].recipient_identity, 'cid-alice');
  assert.equal(intents[0].epoch, epochBefore + 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].intent_record_id, intents[0].record_id);
  assert.deepEqual(
    { status: results[0].status, notified: results[0].notified, key_material_retained: results[0].key_material_retained },
    { status: 'queued', notified: true, key_material_retained: true },
  );

  // announcement goes to the remaining active seats only, epoch stamped
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].recipient_identities, ['cid-bob']);
  assert.deepEqual(notices[0].membership, { action: 'remove', alias: 'Alice', role: 'builder', epoch: epochBefore + 1 });
  assert.equal(notices[0].author.role, 'room');

  // fan-out after removal excludes the removed seat
  await f.service.postMessage(ROOM_ID, { text: 'After removal.' });
  const chat = (await f.store.read(ROOM_ID)).filter((record) =>
    record.kind === 'message' && record.category === 'chat').at(-1);
  assert.deepEqual(chat.recipient_identities, ['cid-bob']);

  // a second removal of the same participant is an explicit error
  await assert.rejects(f.service.removeParticipant(ROOM_ID, { participant: 'cid-alice' }), /active/i);
});

test('quiet_membership and notify:false suppress the announcement but never the journal', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common.', quiet_membership: true });
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 1 });
  await admit(f, invite, 'cid-alice', 'Alice');
  await admit(f, invite, 'cid-bob', 'Bob', '2026-08-02T10:21:00.000Z');
  await f.service.removeParticipant(ROOM_ID, { participant: 'cid-alice' });
  let { intents, results, notices } = membershipRecords(await f.store.read(ROOM_ID));
  assert.equal(intents.length, 1);
  assert.equal(intents[0].notify, false);
  assert.equal(results.length, 1);
  assert.equal(notices.length, 0);

  const g = evolutionFixture();
  await g.service.createRoom({ goal: 'Ship', briefing: 'Common.' });
  const { invite: inviteG } = await g.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 1 });
  await admit(g, inviteG, 'cid-alice', 'Alice');
  await admit(g, inviteG, 'cid-bob', 'Bob', '2026-08-02T10:21:00.000Z');
  await g.service.removeParticipant(ROOM_ID, { participant: 'cid-alice', notify: false });
  ({ intents, results, notices } = membershipRecords(await g.store.read(ROOM_ID)));
  assert.equal(intents[0].notify, false);
  assert.equal(notices.length, 0);
});

test('anonymous replacement is unconditionally silent and the successor inherits the alias (OC-6/OC-2 override)', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common.', anonymous: true });
  await f.service.setRoleBriefing(ROOM_ID, { role: 'Developer', text: 'Build.' });
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'Developer', min_accepts: 1 });
  await admit(f, invite, 'cid-alice', 'Alice');
  await admit(f, invite, 'cid-bob', 'Bob', '2026-08-02T10:21:00.000Z');
  const before = await f.service.showRoom(ROOM_ID);
  const aliceSeat = before.seats.find((seat) => seat.identity === 'cid-alice');
  assert.equal(aliceSeat.alias, 'Developer #1');
  const recordCountForBobBefore = (await f.store.read(ROOM_ID)).filter((record) =>
    record.kind === 'message' && record.recipient_identities.includes('cid-bob')).length;

  const replacement = await f.service.replaceParticipant(ROOM_ID, { participant: 'cid-alice', mode: 'one_time' });
  assert.equal(replacement.invite.role, 'Developer');
  assert.equal(replacement.invite.replaces_seat, aliceSeat.participant_id);
  assert.equal(typeof replacement.blob, 'string');

  // the removal half was silent: no membership notice despite quiet_membership=false
  assert.equal(membershipRecords(await f.store.read(ROOM_ID)).notices.length, 0);

  await admit(f, replacement.invite, 'cid-carol', 'Carol', '2026-08-02T10:40:00.000Z');
  const after = await f.service.showRoom(ROOM_ID);
  const carolSeat = after.seats.find((seat) => seat.identity === 'cid-carol');
  assert.equal(carolSeat.alias, 'Developer #1', 'successor inherits the predecessor alias');
  assert.equal(carolSeat.replaces_seat, aliceSeat.participant_id);
  assert.notEqual(carolSeat.participant_id, aliceSeat.participant_id, 'internal identity still tracks the change');
  assert.equal(after.membership_epoch > before.membership_epoch, true);

  // the successor got the current common + role briefings, addressed only to it
  const records = await f.store.read(ROOM_ID);
  const carolBriefings = records.filter((record) => record.kind === 'message'
    && record.recipient_identities.includes('cid-carol'));
  assert.deepEqual(carolBriefings.map((message) => message.category).sort(), ['briefing', 'role_briefing']);
  for (const briefing of carolBriefings) {
    assert.deepEqual(briefing.recipient_identities, ['cid-carol']);
  }

  // the switch is unnoticeable to bob: not one new message addressed to it
  const recordCountForBobAfter = records.filter((record) =>
    record.kind === 'message' && record.recipient_identities.includes('cid-bob')).length;
  assert.equal(recordCountForBobAfter, recordCountForBobBefore);
});

test('removal crash points re-drive from the intent ledger without duplicate epochs or results', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common.' });
  const { invite } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 1 });
  await admit(f, invite, 'cid-alice', 'Alice');
  await admit(f, invite, 'cid-bob', 'Bob', '2026-08-02T10:21:00.000Z');
  const packet = f.registry.get(ROOM_ID);

  // crash after the intent append, before the seat-state save
  let armed = true;
  f.store.beforeSave = (room) => {
    if (armed && room.seats.some((seat) => seat.state === 'removed')) {
      armed = false;
      throw new Error('crash after membership intent');
    }
  };
  await assert.rejects(f.service.removeParticipant(ROOM_ID, { participant: 'cid-alice' }), /crash after membership intent/);
  f.store.beforeSave = undefined;
  assert.equal((await f.service.showRoom(ROOM_ID)).seats.find((seat) => seat.identity === 'cid-alice').state, 'active');

  // recovery re-drives the pending intent to completion
  await f.service.reconcileRoom(ROOM_ID);
  const room = await f.service.showRoom(ROOM_ID);
  assert.equal(room.seats.find((seat) => seat.identity === 'cid-alice').state, 'removed');
  const { intents, results } = membershipRecords(await f.store.read(ROOM_ID));
  assert.equal(intents.length, 1);
  assert.equal(results.length, 1);
  assert.equal(room.membership_epoch, intents[0].epoch);

  // a second reconcile is a no-op
  await f.service.reconcileRoom(ROOM_ID);
  const settled = membershipRecords(await f.store.read(ROOM_ID));
  assert.equal(settled.intents.length, 1);
  assert.equal(settled.results.length, 1);
});

test('a removed cid re-admits only through an invite minted after its removal', async () => {
  const f = evolutionFixture();
  await f.service.createRoom({ goal: 'Ship', briefing: 'Common.' });
  const { invite: original } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 1 });
  await admit(f, original, 'cid-alice', 'Alice');
  await admit(f, original, 'cid-bob', 'Bob', '2026-08-02T10:21:00.000Z');
  await f.service.removeParticipant(ROOM_ID, { participant: 'cid-alice' });

  // the pre-removal public invite cannot silently re-admit the removed cid
  const packet = f.registry.get(ROOM_ID);
  packet.contacts.push({ name: 'Alice returns', container_id: 'cid-alice' });
  packet.origins['cid-alice'] = { via: 'invite_public', invite_id: original.invite_id, at: '2026-08-02T10:50:00.000Z' };
  await f.service.reconcileRoom(ROOM_ID);
  let seats = (await f.service.showRoom(ROOM_ID)).seats.filter((seat) => seat.identity === 'cid-alice');
  assert.equal(seats.length, 1);
  assert.equal(seats[0].state, 'removed');

  // a deliberate fresh invite admits it with a fresh seat
  const { invite: fresh } = await f.service.createInvite(ROOM_ID, { mode: 'public', role: 'builder', min_accepts: 1 });
  packet.origins['cid-alice'] = { via: 'invite_public', invite_id: fresh.invite_id, at: '2026-08-02T10:55:00.000Z' };
  await f.service.reconcileRoom(ROOM_ID);
  seats = (await f.service.showRoom(ROOM_ID)).seats.filter((seat) => seat.identity === 'cid-alice');
  assert.equal(seats.length, 2);
  assert.deepEqual(seats.map((seat) => seat.state).sort(), ['active', 'removed']);
  assert.notEqual(seats[0].participant_id, seats[1].participant_id);
});
