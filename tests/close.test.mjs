import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RoomService } from '../src/service.ts';
import { CoworkStore } from '../src/storage.ts';

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
  beforeRefresh;
  refreshCalls = 0;

  listContacts() { return structuredClone(this.contacts); }

  async refreshContacts() {
    this.refreshCalls++;
    if (this.beforeRefresh) await this.beforeRefresh();
  }

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
  listUnreadMessages() { return Promise.resolve([]); }
  listUnreadFiles() { return Promise.resolve([]); }
  acknowledgeFile() { return Promise.resolve(); }
  sendFile() { throw new Error('not used'); }
  acknowledgeMessage() { throw new Error('not used'); }
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
    version: 2,
    room_id: ROOM_ID,
    room_name: 'Release room',
    identity_name: `cowork-room-${ROOM_ID}`,
    identity_cid: 'cid-room',
    mission: { goal: 'Ship', briefing: 'Read the mission.', briefing_version: 1 },
    role_briefings: {},
    anonymous: false,
    quiet_membership: false,
    membership_epoch: 2,
    state: 'active',
    invites: [],
    seats: [
      { identity: 'cid-alice', display_name: 'Alice', role: 'builder', invite_id: 'invite-a', accepted_at: AT, participant_id: '01jz6y7n8p9q0r1s2t3v4w5xb1', state: 'active' },
      // A historical seat which is no longer a current core contact must not
      // cause a fabricated remove call or close-notice outcome.
      { identity: 'cid-former', display_name: 'Former', role: 'reviewer', invite_id: 'invite-b', accepted_at: AT, participant_id: '01jz6y7n8p9q0r1s2t3v4w5xb2', state: 'active' },
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

function fsyncFaultStore(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-close-fsync-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  const pathsByFd = new Map();
  const events = [];
  let renamedState;
  let faultState;
  const ops = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') return (path, ...args) => {
        const fd = target.openSync(path, ...args);
        pathsByFd.set(fd, String(path));
        return fd;
      };
      if (property === 'closeSync') return (fd) => {
        pathsByFd.delete(fd);
        return target.closeSync(fd);
      };
      if (property === 'renameSync') return (from, to) => {
        if (String(to).endsWith('room.json')) {
          renamedState = JSON.parse(target.readFileSync(from, 'utf8')).state;
          events.push(['metadata-rename', renamedState]);
        }
        return target.renameSync(from, to);
      };
      if (property === 'fsyncSync') return (fd) => {
        const path = pathsByFd.get(fd);
        if (path === roomDir && renamedState !== undefined) {
          const state = renamedState;
          renamedState = undefined;
          if (faultState === state) {
            faultState = undefined;
            events.push(['metadata-directory-fsync-failed', state]);
            throw Object.assign(new Error(`injected ${state} metadata directory fsync failure`), { code: 'EIO' });
          }
          events.push(['metadata-directory-fsync', state]);
        }
        return target.fsyncSync(fd);
      };
      return Reflect.get(target, property);
    },
  });
  return {
    store: new CoworkStore(stateDir, { fs: ops }),
    events,
    faultOn(state) { faultState = state; },
  };
}

test('real metadata post-rename fsync ambiguity is re-barriered before close effects or success', async (t) => {
  await t.test('closing retry barriers before remove_contact', async (t) => {
    const durable = fsyncFaultStore(t);
    await durable.store.create(room());
    const packet = new FakePacket();
    const registry = new FakeRegistry(packet);
    const service = new RoomService(durable.store, registry, { now: () => LATER });
    packet.beforeRemove = () => { durable.events.push(['remove_contact']); };

    durable.faultOn('closing');
    await assert.rejects(service.closeRoom(ROOM_ID), /closing metadata directory fsync failure/);
    assert.equal((await durable.store.load(ROOM_ID)).state, 'closing', 'rename committed despite uncertain directory fsync');
    assert.equal(packet.removeCalls.length, 0, 'no effect follows the ambiguous closing barrier');
    assert.equal(registry.destroyCalls.length, 0);

    durable.events.length = 0;
    await service.closeRoom(ROOM_ID);
    const barrier = durable.events.findIndex(([kind, state]) => kind === 'metadata-directory-fsync' && state === 'closing');
    const removal = durable.events.findIndex(([kind]) => kind === 'remove_contact');
    assert(barrier >= 0, 'retry must resave and fsync the exact closing metadata');
    assert(removal > barrier, 'retry metadata barrier must precede remove_contact');
  });

  await t.test('closed retry barriers before successful return', async (t) => {
    const durable = fsyncFaultStore(t);
    await durable.store.create(room());
    const packet = new FakePacket();
    const registry = new FakeRegistry(packet);
    const service = new RoomService(durable.store, registry, { now: () => LATER });

    durable.faultOn('closed');
    await assert.rejects(service.closeRoom(ROOM_ID), /closed metadata directory fsync failure/);
    assert.equal((await durable.store.load(ROOM_ID)).state, 'closed', 'terminal rename committed before failed barrier');
    const effects = { removals: packet.removeCalls.length, destroys: registry.destroyCalls.length };

    durable.events.length = 0;
    const closed = await service.closeRoom(ROOM_ID);
    durable.events.push(['returned']);
    assert.equal(closed.state, 'closed');
    const barrier = durable.events.findIndex(([kind, state]) => kind === 'metadata-directory-fsync' && state === 'closed');
    const returned = durable.events.findIndex(([kind]) => kind === 'returned');
    assert(barrier >= 0, 'retry must resave and fsync the exact closed metadata');
    assert(returned > barrier, 'closed metadata barrier must precede successful return');
    assert.deepEqual({ removals: packet.removeCalls.length, destroys: registry.destroyCalls.length }, effects,
      'closed retry performs no packet or contact effects');
  });
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

test('close refreshes contacts before effects and a refresh failure is a clean retry boundary', async () => {
  const f = fixture();
  f.packet.beforeRefresh = () => { throw new Error('contact refresh unavailable'); };
  await assert.rejects(f.service.closeRoom(ROOM_ID), /contact refresh unavailable/);
  assert.equal((await f.store.load(ROOM_ID)).state, 'closing');
  assert.equal(f.packet.removeCalls.length, 0);
  assert.equal(byKind(await f.store.read(ROOM_ID), 'close_notice_intent').length, 0);
  assert.equal(f.registry.destroyCalls.length, 0);

  f.packet.beforeRefresh = undefined;
  await assertConverged(f);
  assert.equal(f.packet.refreshCalls, 2);
});

test('close does not depend on unrelated invite listing', async () => {
  const f = fixture();
  f.packet.listInvites = () => { throw new Error('invite listing unavailable'); };
  await assertConverged(f);
  assert.equal(f.packet.refreshCalls, 1);
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

test('delete requires exact confirmation, closes first and returns only a host-scoped receipt', async () => {
  const f = fixture();
  for (const input of [{}, { confirm: false }, { confirm: true, remote: true }]) {
    await assert.rejects(f.service.deleteRoom(ROOM_ID, input));
  }
  assert.equal(f.store.deleteCalls.length, 0);
  assert.equal((await f.service.showRoom(ROOM_ID)).state, 'active');
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
  assert.deepEqual(f.registry.destroyCalls, [ROOM_ID]);
});

async function commandFixture(command) {
  const cid = 'A'.repeat(64);
  const f = fixture({
    seats: [{ identity: cid, display_name: 'Alice', role: 'builder', invite_id: 'invite-a', accepted_at: AT,
      participant_id: '01jz6y7n8p9q0r1s2t3v4w5xb1', state: 'active' }],
    command_grants: [{ caller_cid: cid, command }], role_command_grants: [],
  });
  f.packet.contacts = [{ name: 'Alice', container_id: cid }];
  f.packet.registerRuntimeCommands = async (handlers) => { f.packet.runtimeCommands = handlers; };
  await f.service.recoverPacket(ROOM_ID);
  return { ...f, context: { sender_cid: cid, sender_name: 'Alice', request_wire_id: 'B'.repeat(64) } };
}

test('lifecycle command acceptance is durable before reply and execution follows SDK completion', async () => {
  for (const command of ['room.close', 'room.delete']) {
    const f = await commandFixture(command);
    let sdkHandling = false;
    let replied = false;
    let receipt;
    f.packet.beforeRemove = async () => {
      assert.equal(sdkHandling, false, 'cannot destroy the reply channel during SDK handling');
      assert.equal(replied, true);
    };
    f.packet.drainRuntimeCommands = async () => {
      sdkHandling = true;
      receipt = await f.packet.runtimeCommands.sharedCommand(command, command === 'room.delete' ? { confirm: true } : {}, f.context);
      assert.equal(receipt.result.status, 'accepted');
      assert.equal((await f.store.load(ROOM_ID)).lifecycle_request.state, 'pending');
      assert.equal((await f.store.load(ROOM_ID)).state, 'active');
      replied = true;
      sdkHandling = false;
    };
    await f.service.resumePending(ROOM_ID);
    if (command === 'room.close') {
      const closed = await f.store.load(ROOM_ID);
      assert.equal(closed.state, 'closed');
      assert.equal(closed.lifecycle_request.state, 'completed');
      assert((await f.service.history(ROOM_ID)).length > 0);
    } else assert.equal(f.store.rooms.has(ROOM_ID), false);
    assert.equal(receipt.result.command, command);
  }
});

test('competing lifecycle requests cannot overwrite an accepted delete and missing acknowledgement can resume', async () => {
  const f = await commandFixture('room.delete');
  await f.service.grantRuntimeCommand(ROOM_ID, { caller_cid: f.context.sender_cid, command: 'room.close' });
  const call = f.packet.runtimeCommands.sharedCommand;
  assert.equal((await call('room.delete', { confirm: true }, f.context)).result.status, 'accepted');
  assert.equal((await call('room.delete', { confirm: true }, f.context)).result.status, 'accepted', 'same request is idempotent');
  assert.deepEqual(await call('room.close', {}, { ...f.context, request_wire_id: 'C'.repeat(64) }), { ok: false, error: 'invalid_state' });
  const restored = new RoomService(f.store, f.registry, { now: () => LATER });
  assert.equal(await restored.resumeLifecycleRequest(ROOM_ID), true, 'restart need not have observed reply delivery');
  assert.equal(f.store.rooms.has(ROOM_ID), false);
});

test('failed lifecycle work remains inspectable and explicit management retry completes it', async () => {
  const f = await commandFixture('room.close');
  await f.packet.runtimeCommands.sharedCommand('room.close', {}, f.context);
  f.packet.beforeRemove = async () => { throw new Error('temporary SDK refusal'); };
  assert.equal(await f.service.resumeLifecycleRequest(ROOM_ID), true);
  const failed = await f.service.showRoom(ROOM_ID);
  assert.equal(failed.lifecycle_request.state, 'failed');
  assert.equal(failed.lifecycle_request.error, 'lifecycle_failed');
  f.packet.beforeRemove = undefined;
  await f.service.closeRoom(ROOM_ID);
  assert.equal((await f.service.showRoom(ROOM_ID)).lifecycle_request.state, 'completed');
});

test('interrupted deletion keeps its pending intent through archive removal and startup listing finishes final cleanup', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-lifecycle-disk-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const request = { request_id: 'B'.repeat(64), caller_cid: 'A'.repeat(64), command: 'room.delete', state: 'pending', accepted_at: AT };
  const initial = new CoworkStore(stateDir);
  await initial.create(room({ state: 'closed', closed_at: LATER, lifecycle_request: request }));
  const otherId = '01jz6y7n8p9q0r1s2t3v4w5x6z';
  await initial.create(room({ room_id: otherId, identity_name: `cowork-room-${otherId}`, state: 'closed', closed_at: LATER }));
  let inject = true;
  const failingFs = new Proxy(fs, { get(target, property) {
    if (property === 'unlinkSync') return (path) => {
      target.unlinkSync(path);
      if (inject && String(path).endsWith('/archive.sqlite3')) { inject = false; throw new Error('simulated interruption after archive removal'); }
    };
    return target[property];
  } });
  await assert.rejects(new CoworkStore(stateDir, { fs: failingFs }).delete(ROOM_ID), /interruption/);
  const restarted = new CoworkStore(stateDir);
  assert.equal((await restarted.load(ROOM_ID)).lifecycle_request.state, 'pending');
  const service = new RoomService(restarted, { get: () => undefined }, { now: () => LATER });
  assert.equal(await service.resumeLifecycleRequest(ROOM_ID), true);
  assert.equal(fs.existsSync(join(stateDir, 'rooms', ROOM_ID)), false);
  assert.equal((await restarted.load(otherId)).room_id, otherId);

  // A crash after removing the last metadata file leaves only an empty
  // directory; listing can finish that stage without recreating the room.
  fs.mkdirSync(join(stateDir, 'rooms', ROOM_ID), { mode: 0o700 });
  assert.deepEqual((await new CoworkStore(stateDir).list()).map((entry) => entry.room_id), [otherId]);
  assert.equal(fs.existsSync(join(stateDir, 'rooms', ROOM_ID)), false);
});


test('text acknowledgement promoting close stops later snapshot work and shared commands', async () => {
  const f = await commandFixture('room.close');
  await f.service.grantRuntimeCommand(ROOM_ID, { caller_cid: f.context.sender_cid, command: 'room.settings' });
  const rows = [1, 2].map((n) => ({ msg_id: n, wire_id: String(n).repeat(64), sender_id: f.context.sender_cid,
    sender_name: 'Alice', text: `text ${n}`, date: AT }));
  let acknowledgements = 0;
  f.packet.listUnreadMessages = async () => rows;
  f.packet.acknowledgeMessage = async () => {
    acknowledgements++;
    const receipt = await f.packet.runtimeCommands.sharedCommand('room.close', {}, f.context);
    assert.equal(receipt.result.status, 'accepted');
    assert.deepEqual(await f.packet.runtimeCommands.sharedCommand('room.settings', { status: 'too late' }, f.context),
      { ok: false, error: 'room_unavailable' });
  };
  await f.service.resumePending(ROOM_ID);
  assert.equal(acknowledgements, 1);
  const history = await f.service.history(ROOM_ID);
  assert.equal(history.some((record) => record.kind === 'message' && record.text === 'text 1'), true);
  assert.equal(history.some((record) => record.kind === 'message' && record.text === 'text 2'), false);
  assert.equal((await f.service.showRoom(ROOM_ID)).state, 'closed');
});
