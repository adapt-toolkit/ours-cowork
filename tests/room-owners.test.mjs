import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PacketRegistry } from '../src/packets.ts';
import { RoomOwnerLedger } from '../src/room-owners.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const IDENTITY = 'ours-cowork:Room 01jz6y7n';
const CID = 'AB'.repeat(32);
const DAEMON = '11111111-2222-4333-8444-555555555555';
const OTHER_DAEMON = '99999999-2222-4333-8444-555555555555';

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-room-owners-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A daemon that keeps external leases until their exact owner releases them. */
class FakeDaemon {
  leases = new Map();
  retired = new Set();
  attached = [];
  identities = new Set();
  failure;
  releaseFailure;

  host() {
    return {
      listIdentityNames: async () => new Set(this.identities),
      createClient: async (owner) => {
        assert.match(owner, /^cowork-[0-9a-f]{32}$/, 'a V1 attach must carry a ledger owner ID');
        this.attached.push(owner);
        return this.client(owner);
      },
      onIdentityNotify: () => () => {},
      trackIdentity: () => () => {},
    };
  }

  client(owner) {
    return {
      chooseIdentity: async ({ name, force }) => {
        assert.equal(force, false);
        if (this.failure) throw this.failure;
        if (this.retired.has(owner)) throw Object.assign(new Error('owner retired'), { code: 'BINDING_REASSIGNED' });
        const holder = this.leases.get(name);
        if (holder !== undefined && holder !== owner) {
          throw Object.assign(new Error('currently bound to another live session'), { code: 'TX_FAILED' });
        }
        this.leases.set(name, owner);
        return { name, cid: CID, switchedFrom: null };
      },
      createIdentity: async ({ name }) => { this.identities.add(name); this.leases.set(name, owner); return { info: { cid: CID } }; },
      listContacts: async () => ({ contacts: [], origins: {} }),
      listInvites: async () => [],
      releaseLease: async () => {
        if (this.releaseFailure === 'throw') throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
        if (this.releaseFailure === 'partial') return { released: [], closed: [], attempted: 1, notified: 0, failed: 1 };
        for (const [name, holder] of this.leases) if (holder === owner) this.leases.delete(name);
        this.retired.add(owner);
        return { released: [], closed: [], attempted: 0, notified: 0, failed: 0 };
      },
      close: async () => {},
    };
  }
}

const registryFor = (daemon, dir, daemonId = DAEMON) =>
  new PacketRegistry(daemon.host(), dir, { owners: new RoomOwnerLedger(dir, daemonId) });

test('ledger records a private owner before use and forgets only that exact owner', (t) => {
  const dir = stateDir(t);
  const ledger = new RoomOwnerLedger(dir, DAEMON);
  assert.equal(ledger.recorded(ROOM_ID), undefined);
  const owner = ledger.mint(ROOM_ID);
  assert.match(owner, /^cowork-[0-9a-f]{32}$/);
  assert.equal(new RoomOwnerLedger(dir, DAEMON).recorded(ROOM_ID), owner);
  assert.deepEqual(readdirSync(ledger.directory), [`${ROOM_ID}.json`]);
  assert.equal(new RoomOwnerLedger(dir, OTHER_DAEMON).recorded(ROOM_ID), undefined, 'another daemon instance never inherits an owner');
  ledger.forget(ROOM_ID, 'cowork-' + '0'.repeat(32));
  assert.equal(ledger.recorded(ROOM_ID), owner);
  chmodSync(join(ledger.directory, `${ROOM_ID}.json`), 0o644);
  assert.throws(() => ledger.recorded(ROOM_ID), /private 0600/);
  chmodSync(join(ledger.directory, `${ROOM_ID}.json`), 0o600);
  ledger.forget(ROOM_ID, owner);
  assert.equal(existsSync(join(ledger.directory, `${ROOM_ID}.json`)), false);
  assert.throws(() => new RoomOwnerLedger(dir, 'not-a-uuid'), /daemon instance UUID/);

  // Reads and deletes refuse a ledger directory that is not private.
  const kept = ledger.mint(ROOM_ID);
  chmodSync(ledger.directory, 0o755);
  assert.throws(() => ledger.recorded(ROOM_ID), /private and owned/);
  assert.throws(() => ledger.forget(ROOM_ID, kept), /private and owned/);
  assert.throws(() => ledger.mint(ROOM_ID), /private and owned/);
  chmodSync(ledger.directory, 0o700);
  assert.equal(ledger.recorded(ROOM_ID), kept);
});

test('a host lost without any terminal release reconnects as its recorded room owner', async (t) => {
  const dir = stateDir(t);
  const daemon = new FakeDaemon();
  await registryFor(daemon, dir).create(ROOM_ID, IDENTITY);
  const [original] = daemon.attached;
  assert.equal(daemon.leases.get(IDENTITY), original);

  // The first registry is abandoned exactly like a killed process tree.
  const packet = await registryFor(daemon, dir).restore(ROOM_ID, CID, IDENTITY);
  assert.equal(packet.cid, CID);
  assert.deepEqual(daemon.attached, [original, original]);
  assert.equal(daemon.leases.get(IDENTITY), original);
  assert.equal(daemon.retired.size, 0);
});

test('orderly release retires the owner, and the next host mints a distinct one', async (t) => {
  const dir = stateDir(t);
  const daemon = new FakeDaemon();
  const first = registryFor(daemon, dir);
  await first.create(ROOM_ID, IDENTITY);
  await first.unhostAll();
  assert.equal(new RoomOwnerLedger(dir, DAEMON).recorded(ROOM_ID), undefined);
  await registryFor(daemon, dir).restore(ROOM_ID, CID, IDENTITY);
  assert.equal(daemon.attached.length, 2);
  assert.notEqual(daemon.attached[1], daemon.attached[0]);
});

test('only typed terminal retirement of the recorded owner permits a replacement', async (t) => {
  const dir = stateDir(t);
  const daemon = new FakeDaemon();
  await registryFor(daemon, dir).create(ROOM_ID, IDENTITY);
  const [original] = daemon.attached;
  // A surviving supervisor delivered process-exit for the dead worker's owner.
  daemon.leases.delete(IDENTITY);
  daemon.retired.add(original);
  await registryFor(daemon, dir).restore(ROOM_ID, CID, IDENTITY);
  assert.equal(daemon.attached.length, 3);
  assert.equal(daemon.attached[1], original);
  assert.notEqual(daemon.attached[2], original);
  assert.equal(new RoomOwnerLedger(dir, DAEMON).recorded(ROOM_ID), daemon.attached[2]);
});

test('a live competing owner is refused without takeover, release, or record loss', async (t) => {
  const dir = stateDir(t);
  const daemon = new FakeDaemon();
  const first = registryFor(daemon, dir);
  await first.create(ROOM_ID, IDENTITY);
  await first.unhostAll();
  daemon.leases.set(IDENTITY, 'competitor');
  await assert.rejects(registryFor(daemon, dir).restore(ROOM_ID, CID, IDENTITY), /another live session/);
  assert.equal(daemon.leases.get(IDENTITY), 'competitor');

  // An ambiguous failure while reconnecting keeps both the lease and its record.
  const dirTwo = stateDir(t);
  const second = new FakeDaemon();
  await registryFor(second, dirTwo).create(ROOM_ID, IDENTITY);
  const [original] = second.attached;
  second.failure = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
  await assert.rejects(registryFor(second, dirTwo).restore(ROOM_ID, CID, IDENTITY), /fetch failed/);
  assert.equal(second.leases.get(IDENTITY), original);
  assert.equal(second.retired.size, 0);
  assert.equal(new RoomOwnerLedger(dirTwo, DAEMON).recorded(ROOM_ID), original);
  assert.equal(JSON.parse(readFileSync(join(dirTwo, 'room-owners', `${ROOM_ID}.json`), 'utf8')).daemon_instance_id, DAEMON);
});

test('an owner recorded for another daemon instance is never presented', async (t) => {
  const dir = stateDir(t);
  const daemon = new FakeDaemon();
  await registryFor(daemon, dir, OTHER_DAEMON).create(ROOM_ID, IDENTITY);
  const [foreign] = daemon.attached;
  await assert.rejects(registryFor(daemon, dir).restore(ROOM_ID, CID, IDENTITY), /another live session/);
  assert(!daemon.attached.slice(1).includes(foreign));
});

test('an unacknowledged terminal release keeps the owner record for the next host', async (t) => {
  for (const releaseFailure of ['throw', 'partial']) {
    const dir = stateDir(t);
    const daemon = new FakeDaemon();
    const registry = registryFor(daemon, dir);
    await registry.create(ROOM_ID, IDENTITY);
    const [original] = daemon.attached;
    daemon.releaseFailure = releaseFailure;
    await assert.rejects(registry.unhostAll(), /failed to release room SDK leases/);
    assert.equal(new RoomOwnerLedger(dir, DAEMON).recorded(ROOM_ID), original);
    daemon.releaseFailure = undefined;
    await registryFor(daemon, dir).restore(ROOM_ID, CID, IDENTITY);
    assert.deepEqual(daemon.attached, [original, original], 'the still-leased owner reconnects');
  }
});

test('a corrupt or unsafe owner record fails the restore closed before any attach', async (t) => {
  for (const corrupt of [
    (path) => writeFileSync(path, '{not json', { mode: 0o600 }),
    (path) => writeFileSync(path, JSON.stringify({ version: 1, room_id: ROOM_ID, daemon_instance_id: DAEMON, owner_instance_id: 'someone-else' }), { mode: 0o600 }),
    (path) => writeFileSync(path, JSON.stringify({ version: 1, room_id: '01jz6y7n8p9q0r1s2t3v4w5x6z', daemon_instance_id: DAEMON, owner_instance_id: 'cowork-' + 'a'.repeat(32) }), { mode: 0o600 }),
    (path) => chmodSync(path, 0o640),
    (path) => { nodeFs.renameSync(path, path + '.real'); nodeFs.symlinkSync(path + '.real', path); },
    (path) => nodeFs.linkSync(path, path + '.alias'),
  ]) {
    const dir = stateDir(t);
    const daemon = new FakeDaemon();
    await registryFor(daemon, dir).create(ROOM_ID, IDENTITY);
    const [original] = daemon.attached;
    corrupt(join(dir, 'room-owners', `${ROOM_ID}.json`));
    await assert.rejects(registryFor(daemon, dir).restore(ROOM_ID, CID, IDENTITY));
    assert.deepEqual(daemon.attached, [original], 'no client may attach on an untrusted record');
    assert.equal(daemon.leases.get(IDENTITY), original);
    assert.equal(daemon.retired.size, 0);
  }
});

test('ledger creation confirms its directory entry even after an interrupted first attempt', (t) => {
  const dir = stateDir(t);
  let failParent = true;
  const synced = [];
  const fs = { ...nodeFs,
    openSync(path, ...rest) { const fd = nodeFs.openSync(path, ...rest); if (path === dir) synced.push(fd); return fd; },
    fsyncSync(fd) {
      if (synced.includes(fd) && failParent) { failParent = false; throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
      return nodeFs.fsyncSync(fd);
    },
  };
  const ledger = new RoomOwnerLedger(dir, DAEMON, fs);
  assert.throws(() => ledger.mint(ROOM_ID), /EIO/);
  assert.equal(ledger.recorded(ROOM_ID), undefined, 'no owner is recorded before the directory is durable');
  const before = synced.length;
  ledger.mint(ROOM_ID);
  assert(synced.length > before, 'the retry fsyncs the state directory again');
});
