import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HostedRoomPacket, PacketPersistenceError, PacketRegistry } from '../src/packets.ts';
import { RoomService } from '../src/service.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const AT = '2026-08-02T10:11:12.000Z';
const LATER = '2026-08-02T10:11:13.000Z';

class MemoryStore {
  rooms = new Map();
  records = new Map();
  tails = new Map();
  ownership = new AsyncLocalStorage();
  deleteCalls = [];
  beforeSave;
  afterSave;
  beforeAppend;
  afterAppend;
  beforeDelete;

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
    if (this.beforeSave) await this.beforeSave(room);
    this.rooms.set(room.room_id, structuredClone(room));
    if (this.afterSave) await this.afterSave(room);
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
    return (this.records.get(roomId) ?? [])
      .filter((record) => record.seq > after)
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async list() { return [...this.rooms.values()].map((room) => structuredClone(room)); }

  async delete(roomId) {
    this.deleteCalls.push(roomId);
    if (this.beforeDelete) await this.beforeDelete(roomId);
    this.records.delete(roomId);
    this.rooms.delete(roomId);
  }
}

class FakePacket {
  name = `cowork-room-${ROOM_ID}`;
  cid = 'cid-room';
  contacts = [
    { name: 'Alice', container_id: 'cid-alice' },
    { name: 'Outsider', container_id: 'cid-outsider' },
  ];
  removeCalls = [];
  outcomes = new Map([
    ['cid-alice', { status: 'queued', notified: true, key_material_retained: true }],
    ['cid-outsider', { status: 'send_failed', notified: false, key_material_retained: true }],
  ]);
  beforeRemove;
  afterRemove;

  listContacts() { return structuredClone(this.contacts); }

  async removeContact(identity) {
    this.removeCalls.push(identity);
    if (this.beforeRemove) await this.beforeRemove(identity);
    this.contacts = this.contacts.filter((contact) => contact.container_id !== identity);
    if (this.afterRemove) await this.afterRemove(identity);
    return structuredClone(this.outcomes.get(identity)
      ?? { status: 'queued', notified: false, key_material_retained: true });
  }

  mintInvite() { throw new Error('not used'); }
  revokeInvite() { throw new Error('not used'); }
  listInvites() { return []; }
  listContactOrigins() { return {}; }
  peekInbox() { return []; }
  consumeInbox() { throw new Error('not used'); }
  send() { throw new Error('not used'); }
  sign() { throw new Error('not used'); }
}

class FakeRegistry {
  packets = new Map();
  live = new Set();
  destroyCalls = [];
  afterWrapperRemoval;
  afterLiveDeletion;
  purgeFailure;

  constructor(packet) {
    this.packets.set(ROOM_ID, packet);
    this.live.add(ROOM_ID);
  }

  get(roomId) { return this.packets.get(roomId); }
  create() { throw new Error('not used'); }

  async destroy(roomId) {
    this.destroyCalls.push(roomId);
    this.packets.delete(roomId);
    if (this.afterWrapperRemoval) await this.afterWrapperRemoval(roomId);
    if (this.purgeFailure) return [`/state/rooms/${roomId}/live`];
    this.live.delete(roomId);
    if (this.afterLiveDeletion) await this.afterLiveDeletion(roomId);
    return this.live.has(roomId) ? [`/state/rooms/${roomId}/live`] : [];
  }
}

function room(overrides = {}) {
  return {
    version: 1,
    room_id: ROOM_ID,
    identity_name: `cowork-room-${ROOM_ID}`,
    identity_cid: 'cid-room',
    mission: { goal: 'Ship', briefing: 'Read the mission.' },
    state: 'active',
    invites: [],
    seats: [
      { identity: 'cid-alice', display_name: 'Alice', role: 'builder', invite_id: 'invite-a', accepted_at: AT },
      // A historical seat which is no longer a current core contact must not
      // cause a fabricated remove call or close-notice outcome.
      { identity: 'cid-former', display_name: 'Former', role: 'reviewer', invite_id: 'invite-b', accepted_at: AT },
    ],
    created_at: AT,
    activated_at: AT,
    ...overrides,
  };
}

function fixture(roomOverrides = {}) {
  const store = new MemoryStore();
  const packet = new FakePacket();
  const registry = new FakeRegistry(packet);
  store.rooms.set(ROOM_ID, room(roomOverrides));
  store.records.set(ROOM_ID, []);
  const service = new RoomService(store, registry, { now: () => LATER });
  return { store, packet, registry, service };
}

function byKind(records, kind) { return records.filter((record) => record.kind === kind); }

test('hosted contact removal propagates every unknown mutation failure', async () => {
  for (const failure of [
    new Error('transaction outcome unknown'),
    new Error('packet closed concurrently'),
    new PacketPersistenceError('disk full'),
  ]) {
    const native = {
      name: 'fake-room', cid: 'cid-fake', pw: {},
      mutatingTx: async () => { throw failure; },
    };
    const hosted = new HostedRoomPacket(native, () => {}, () => {});
    await assert.rejects(hosted.removeContact('cid-peer'), (error) => error === failure);
  }
});

async function assertConverged(f) {
  f.store.beforeSave = undefined;
  f.store.afterSave = undefined;
  f.store.beforeAppend = undefined;
  f.store.afterAppend = undefined;
  f.packet.beforeRemove = undefined;
  f.packet.afterRemove = undefined;
  f.registry.afterWrapperRemoval = undefined;
  f.registry.afterLiveDeletion = undefined;
  f.registry.purgeFailure = undefined;
  const closed = await f.service.closeRoom(ROOM_ID);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closed_at, LATER);
  assert.equal(f.registry.get(ROOM_ID), undefined);
  assert.equal(f.registry.live.has(ROOM_ID), false);
  return closed;
}

test('close uses current unique contacts, records actual outcomes, purges live last, and is idempotent', async () => {
  const f = fixture();
  f.packet.contacts.unshift({ name: 'Duplicate Alice', container_id: 'cid-alice' });
  const closed = await f.service.closeRoom(ROOM_ID);
  assert.equal(closed.state, 'closed');
  assert.deepEqual(f.packet.removeCalls, ['cid-alice', 'cid-outsider']);
  const records = await f.store.read(ROOM_ID);
  assert.deepEqual(byKind(records, 'close_notice_intent').map((record) => record.recipient_identity),
    ['cid-alice', 'cid-outsider']);
  assert.deepEqual(byKind(records, 'close_notice_result').map((record) => ({
    recipient: record.recipient_identity,
    status: record.status,
    notified: record.notified,
    retained: record.key_material_retained,
  })), [
    { recipient: 'cid-alice', status: 'queued', notified: true, retained: true },
    { recipient: 'cid-outsider', status: 'send_failed', notified: false, retained: true },
  ]);
  assert.equal(records.some((record) => record.recipient_identity === 'cid-former'), false);
  assert.deepEqual(f.registry.destroyCalls, [ROOM_ID]);

  const snapshot = structuredClone(records);
  const replay = await f.service.closeRoom(ROOM_ID);
  assert.deepEqual(replay, closed);
  assert.deepEqual(await f.store.read(ROOM_ID), snapshot);
  assert.deepEqual(f.registry.destroyCalls, [ROOM_ID]);
  assert.deepEqual(f.packet.removeCalls, ['cid-alice', 'cid-outsider']);
});

test('every named close crash boundary resumes without success fabrication', async (t) => {
  const cases = [
    {
      name: 'after entering closing',
      arm(f) {
        f.store.afterSave = (saved) => {
          if (saved.state === 'closing') throw new Error('crash after entering closing');
        };
      },
    },
    ...[1, 2].map((ordinal) => ({
      name: `after notice intent ${ordinal}`,
      arm(f) {
        let seen = 0;
        f.store.afterAppend = (record) => {
          if (record.kind === 'close_notice_intent' && ++seen === ordinal) {
            throw new Error(`crash after notice intent ${ordinal}`);
          }
        };
      },
    })),
    {
      name: 'after core removal',
      arm(f) {
        let once = true;
        f.packet.afterRemove = () => {
          if (once) { once = false; throw new Error('crash after core removal'); }
        };
      },
      verify(records) {
        const [intent] = byKind(records, 'close_notice_intent');
        const result = byKind(records, 'close_notice_result')
          .find((candidate) => candidate.intent_record_id === intent.record_id);
        assert.deepEqual(result, {
          version: 1,
          kind: 'close_notice_result',
          room_id: ROOM_ID,
          at: LATER,
          intent_record_id: intent.record_id,
          recipient_identity: 'cid-alice',
          status: 'send_failed',
          notified: false,
          key_material_retained: true,
          uncertain_after_restart: true,
          seq: result.seq,
          record_id: result.record_id,
        });
      },
    },
    {
      name: 'after durable result',
      arm(f) {
        let once = true;
        f.store.afterAppend = (record) => {
          if (once && record.kind === 'close_notice_result') {
            once = false;
            throw new Error('crash after durable result');
          }
        };
      },
    },
    {
      name: 'after wrapper removal',
      arm(f) {
        let once = true;
        f.registry.afterWrapperRemoval = () => {
          if (once) { once = false; throw new Error('crash after wrapper removal'); }
        };
      },
    },
    {
      name: 'after live-directory deletion',
      arm(f) {
        let once = true;
        f.registry.afterLiveDeletion = () => {
          if (once) { once = false; throw new Error('crash after live deletion'); }
        };
      },
    },
    {
      name: 'before terminal metadata save',
      arm(f) {
        f.store.beforeSave = (saved) => {
          if (saved.state === 'closed') throw new Error('crash before terminal metadata save');
        };
      },
    },
    {
      name: 'after ambiguous terminal metadata save',
      arm(f) {
        f.store.afterSave = (saved) => {
          if (saved.state === 'closed') throw new Error('ambiguous terminal metadata save');
        };
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const f = fixture();
      entry.arm(f);
      await assert.rejects(f.service.closeRoom(ROOM_ID), /crash|ambiguous/);
      const persisted = await f.store.load(ROOM_ID);
      assert(['closing', 'closed'].includes(persisted.state));
      await assertConverged(f);
      const records = await f.store.read(ROOM_ID);
      entry.verify?.(records);
      const intents = byKind(records, 'close_notice_intent');
      const results = byKind(records, 'close_notice_result');
      assert.equal(results.length, intents.length);
      assert.equal(new Set(results.map((record) => record.intent_record_id)).size, results.length);
    });
  }
});

test('a thrown unknown removal remains result-less until retry observes the contact state', async () => {
  const f = fixture();
  let throwBefore = true;
  f.packet.beforeRemove = () => {
    if (throwBefore) { throwBefore = false; throw new Error('unknown before removal'); }
  };
  await assert.rejects(f.service.closeRoom(ROOM_ID), /unknown before removal/);
  let records = await f.store.read(ROOM_ID);
  assert.equal(byKind(records, 'close_notice_intent').length, 1);
  assert.equal(byKind(records, 'close_notice_result').length, 0);
  assert.deepEqual(f.packet.contacts.map((contact) => contact.container_id), ['cid-alice', 'cid-outsider']);

  f.packet.beforeRemove = undefined;
  await assertConverged(f);
  records = await f.store.read(ROOM_ID);
  const aliceIntents = byKind(records, 'close_notice_intent')
    .filter((record) => record.recipient_identity === 'cid-alice');
  assert.equal(aliceIntents.length, 1, 'retry reuses the durable result-less intent');
  const result = byKind(records, 'close_notice_result')
    .find((record) => record.intent_record_id === aliceIntents[0].record_id);
  assert.equal(result.status, 'queued');
  assert.equal(result.notified, true);
  assert.equal('uncertain_after_restart' in result, false);
});

test('purge residue leaves closing durable and an already absent packet resumes purge', async () => {
  const f = fixture();
  f.registry.purgeFailure = true;
  await assert.rejects(f.service.closeRoom(ROOM_ID), /live.*residue|purge/i);
  assert.equal((await f.store.load(ROOM_ID)).state, 'closing');
  assert.equal(f.registry.get(ROOM_ID), undefined, 'wrapper/registry removal is not rolled back');
  assert.equal(f.registry.live.has(ROOM_ID), true);
  const records = await f.store.read(ROOM_ID);
  const removeCount = f.packet.removeCalls.length;

  f.registry.purgeFailure = undefined;
  await assertConverged(f);
  assert.equal(f.packet.removeCalls.length, removeCount, 'absent packet is not reconstructed or re-removed');
  assert.deepEqual(await f.store.read(ROOM_ID), records, 'purge retry adds no communication claims');
});

test('close serializes duplicate close and rejects lifecycle work queued behind closing', async () => {
  const f = fixture();
  let release;
  let entered;
  const paused = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.store.afterSave = async (saved) => {
    if (saved.state === 'closing') { entered(); await gate; }
  };
  const first = f.service.closeRoom(ROOM_ID);
  await paused;
  const duplicate = f.service.closeRoom(ROOM_ID);
  const update = f.service.updateRoom(ROOM_ID, { status: 'too late' });
  release();
  const [one, two] = await Promise.all([first, duplicate]);
  assert.deepEqual(two, one);
  await assert.rejects(update, /while it is closed/i);
  assert.deepEqual(f.registry.destroyCalls, [ROOM_ID]);
});

test('delete requires exact confirmation and a closed room, then returns only a host-scoped receipt', async () => {
  const f = fixture();
  for (const input of [{}, { confirm: false }, { confirm: true, remote: true }]) {
    await assert.rejects(f.service.deleteRoom(ROOM_ID, input));
  }
  assert.equal(f.store.deleteCalls.length, 0);
  await assert.rejects(f.service.deleteRoom(ROOM_ID, { confirm: true }), /only.*closed|must be closed/i);
  assert.equal(f.store.deleteCalls.length, 0);

  await f.service.closeRoom(ROOM_ID);
  const archiveBefore = await f.service.history(ROOM_ID);
  assert(archiveBefore.length > 0, 'archive stays readable after close');
  const receipt = await f.service.deleteRoom(ROOM_ID, { confirm: true });
  assert.deepEqual(receipt, {
    version: 1,
    room_id: ROOM_ID,
    deleted: true,
    scope: 'this_host',
  });
  assert.deepEqual(Object.keys(receipt).sort(), ['deleted', 'room_id', 'scope', 'version']);
  assert.equal(JSON.stringify(receipt).match(/backup|remote|secure|erase/gi), null);
  assert.deepEqual(f.store.deleteCalls, [ROOM_ID]);
});

test('PacketRegistry destroy is idempotent, retries purge, and never follows a live symlink', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-close-registry-'));
  const outside = mkdtempSync(join(tmpdir(), 'ours-cowork-close-outside-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(join(outside, 'keep'), 'untouched');
  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  fs.mkdirSync(roomDir, { recursive: true, mode: 0o700 });
  const live = join(roomDir, 'live');
  fs.symlinkSync(outside, live);
  const removed = [];
  const host = { removePacket: (cid) => removed.push(cid) };
  const registry = new PacketRegistry(host, stateDir);
  registry.packets.set(ROOM_ID, { name: 'room', cid: 'cid-room' });

  assert.deepEqual(await registry.destroy(ROOM_ID), []);
  assert.deepEqual(removed, ['cid-room']);
  assert.equal(fs.lstatSync(outside).isDirectory(), true);
  assert.equal(fs.readFileSync(join(outside, 'keep'), 'utf8'), 'untouched');
  assert.equal(fs.existsSync(live), false);
  assert.deepEqual(await registry.destroy(ROOM_ID), []);
  assert.deepEqual(removed, ['cid-room']);
});
