import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CoworkStore } from '../src/storage.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const MESSAGE_ID = '01jz6y7n8p9q0r1s2t3v4w5x6z';
const AT = '2026-08-02T10:11:12.345Z';

function room(overrides = {}) {
  return {
    version: 2,
    room_id: ROOM_ID,
    room_name: 'Release room',
    identity_name: `cowork-room-${ROOM_ID}`,
    identity_cid: 'cid-room',
    mission: { goal: 'Ship it', briefing: 'Work together.', briefing_version: 1 },
    role_briefings: {},
    rest_roles: [],
    anonymous: false,
    quiet_membership: false,
    membership_epoch: 0,
    state: 'provisioning',
    invites: [],
    seats: [],
    created_at: AT,
    ...overrides,
  };
}

function message(text) {
  return {
    version: 1,
    kind: 'message',
    room_id: ROOM_ID,
    at: AT,
    message_id: MESSAGE_ID,
    author: { identity: 'cid-alice', display_name: 'Alice', role: 'researcher' },
    category: 'chat',
    text,
    recipient_identities: [],
  };
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function temporaryStore(options) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-store-'));
  return { stateDir, store: new CoworkStore(stateDir, options), cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test('create/save/load/list provisions private directories and atomic metadata', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);

  await store.create(room());
  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  const metadata = join(roomDir, 'room.json');
  const archive = join(roomDir, 'archive.jsonl');
  assert.equal(mode(stateDir), 0o700);
  assert.equal(mode(join(stateDir, 'rooms')), 0o700);
  assert.equal(mode(roomDir), 0o700);
  assert.equal(mode(metadata), 0o600);
  assert.equal(mode(archive), 0o600);
  assert.deepEqual(await store.load(ROOM_ID), room());
  assert.deepEqual((await store.list()).map((entry) => entry.room_id), [ROOM_ID]);

  await store.save(room({ state: 'active', activated_at: AT }));
  assert.equal((await store.load(ROOM_ID)).state, 'active');
  assert.equal(mode(metadata), 0o600);
  assert.deepEqual(fs.readdirSync(roomDir).sort(), ['archive.jsonl', 'room.json']);
});

test('metadata replacement fsyncs the temp file before rename and the directory after it', async (t) => {
  const events = [];
  const pathsByFd = new Map();
  let failRename = false;
  const ops = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') return (path, ...args) => {
        const fd = target.openSync(path, ...args);
        pathsByFd.set(fd, String(path));
        events.push(['open', String(path)]);
        return fd;
      };
      if (property === 'fsyncSync') return (fd) => {
        events.push(['fsync', pathsByFd.get(fd)]);
        return target.fsyncSync(fd);
      };
      if (property === 'closeSync') return (fd) => {
        pathsByFd.delete(fd);
        return target.closeSync(fd);
      };
      if (property === 'renameSync') return (from, to) => {
        events.push(['rename', String(from), String(to)]);
        if (failRename && String(to).endsWith('room.json')) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
        return target.renameSync(from, to);
      };
      if (property === 'chmodSync') return (path, mode) => {
        events.push(['chmod', String(path), mode]);
        return target.chmodSync(path, mode);
      };
      return Reflect.get(target, property);
    },
  });
  const { stateDir, store, cleanup } = temporaryStore({ fs: ops });
  t.after(cleanup);
  await store.create(room());

  events.length = 0;
  await store.save(room({ state: 'active', activated_at: AT }));
  const renameIndex = events.findIndex(([kind]) => kind === 'rename');
  assert(renameIndex > 0);
  assert(events.slice(0, renameIndex).some(([kind, path]) => kind === 'fsync' && path.includes('room.json.tmp-')));
  assert(events.slice(renameIndex + 1).some(([kind, path]) => kind === 'fsync' && path.endsWith(`rooms/${ROOM_ID}`)));
  assert.equal(events.slice(renameIndex + 1).some(([kind, path]) => kind === 'chmod' && path.endsWith('room.json')), false);

  failRename = true;
  await assert.rejects(store.save(room({ state: 'closed', closed_at: AT })), /rename failure/i);
  assert.equal((await new CoworkStore(stateDir).load(ROOM_ID)).state, 'active');
  assert.equal(fs.readdirSync(join(stateDir, 'rooms', ROOM_ID)).some((name) => name.includes('.tmp-')), false);
});

test('create persists base and room directory entries before creating files', async (t) => {
  const events = [];
  const pathsByFd = new Map();
  const { stateDir, cleanup } = temporaryStore();
  cleanup();
  fs.mkdirSync(stateDir, { mode: 0o700 });
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ops = new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') return (path, options) => {
        events.push(['mkdir', String(path)]);
        return target.mkdirSync(path, options);
      };
      if (property === 'openSync') return (path, ...args) => {
        const fd = target.openSync(path, ...args);
        pathsByFd.set(fd, String(path));
        events.push(['open', String(path)]);
        return fd;
      };
      if (property === 'closeSync') return (fd) => { pathsByFd.delete(fd); return target.closeSync(fd); };
      if (property === 'fsyncSync') return (fd) => {
        events.push(['fsync', pathsByFd.get(fd)]);
        return target.fsyncSync(fd);
      };
      return Reflect.get(target, property);
    },
  });
  await new CoworkStore(stateDir, { fs: ops }).create(room());
  const roomsDir = join(stateDir, 'rooms');
  const roomDir = join(roomsDir, ROOM_ID);
  const roomsMkdir = events.findIndex(([kind, path]) => kind === 'mkdir' && path === roomsDir);
  const stateFsync = events.findIndex(([kind, path]) => kind === 'fsync' && path === stateDir);
  const roomMkdir = events.findIndex(([kind, path]) => kind === 'mkdir' && path === roomDir);
  const roomsFsync = events.findIndex(([kind, path], index) => index > roomMkdir && kind === 'fsync' && path === roomsDir);
  const archiveOpen = events.findIndex(([kind, path]) => kind === 'open' && path.endsWith('archive.jsonl'));
  assert(roomsMkdir >= 0 && stateFsync > roomsMkdir, JSON.stringify(events));
  assert(roomMkdir >= 0 && roomsFsync > roomMkdir && roomsFsync < archiveOpen, JSON.stringify(events));
});

test('room mkdir/chmod failure cleans the reservation and permits retry', async (t) => {
  let failRoomChmod = true;
  let stateDir;
  const ops = new Proxy(fs, {
    get(target, property) {
      if (property === 'chmodSync') return (path, mode) => {
        if (failRoomChmod && stateDir && String(path) === join(stateDir, 'rooms', ROOM_ID)) {
          throw Object.assign(new Error('injected room chmod failure'), { code: 'EIO' });
        }
        return target.chmodSync(path, mode);
      };
      return Reflect.get(target, property);
    },
  });
  const temporary = temporaryStore({ fs: ops });
  stateDir = temporary.stateDir;
  t.after(temporary.cleanup);
  await assert.rejects(temporary.store.create(room()), /chmod failure/i);
  assert.equal(fs.existsSync(join(stateDir, 'rooms', ROOM_ID)), false);
  failRoomChmod = false;
  await temporary.store.create(room());
  assert.equal((await temporary.store.load(ROOM_ID)).room_id, ROOM_ID);
});

test('room mkdir EEXIST race preserves the other creator directory and content', async (t) => {
  let stateDir;
  let injectRacingCreator = true;
  const ops = new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') return (path, options) => {
        if (injectRacingCreator && stateDir && String(path) === join(stateDir, 'rooms', ROOM_ID)) {
          injectRacingCreator = false;
          target.mkdirSync(path, options);
          target.writeFileSync(join(String(path), 'other-creator'), 'preserve-me');
        }
        return target.mkdirSync(path, options);
      };
      return Reflect.get(target, property);
    },
  });
  const temporary = temporaryStore({ fs: ops });
  stateDir = temporary.stateDir;
  t.after(temporary.cleanup);
  await assert.rejects(temporary.store.create(room()), /exist|EEXIST/i);
  assert.equal(readFileSync(join(stateDir, 'rooms', ROOM_ID, 'other-creator'), 'utf8'), 'preserve-me');
});

test('room parent fsync failure cleans the mkdir entry and permits retry', async (t) => {
  let stateDir;
  let roomWasMade = false;
  let failParentFsync = true;
  const pathsByFd = new Map();
  const ops = new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') return (path, options) => {
        const result = target.mkdirSync(path, options);
        if (stateDir && String(path) === join(stateDir, 'rooms', ROOM_ID)) roomWasMade = true;
        return result;
      };
      if (property === 'openSync') return (path, ...args) => {
        const fd = target.openSync(path, ...args);
        pathsByFd.set(fd, String(path));
        return fd;
      };
      if (property === 'closeSync') return (fd) => { pathsByFd.delete(fd); return target.closeSync(fd); };
      if (property === 'fsyncSync') return (fd) => {
        if (failParentFsync && roomWasMade && pathsByFd.get(fd) === join(stateDir, 'rooms')) {
          failParentFsync = false;
          throw Object.assign(new Error('injected parent fsync failure'), { code: 'EIO' });
        }
        return target.fsyncSync(fd);
      };
      return Reflect.get(target, property);
    },
  });
  const temporary = temporaryStore({ fs: ops });
  stateDir = temporary.stateDir;
  t.after(temporary.cleanup);
  await assert.rejects(temporary.store.create(room()), /parent fsync failure/i);
  assert.equal(fs.existsSync(join(stateDir, 'rooms', ROOM_ID)), false);
  await temporary.store.create(room());
});

test('append serializes by room, assigns monotonic records, and survives restart', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);
  await store.create(room());

  const records = await Promise.all(Array.from({ length: 24 }, (_, index) => store.append(ROOM_ID, message(`message-${index}`))));
  assert.deepEqual(records.map((record) => record.seq).sort((a, b) => a - b), Array.from({ length: 24 }, (_, index) => index + 1));
  assert.deepEqual((await store.read(ROOM_ID)).map((record) => record.seq), Array.from({ length: 24 }, (_, index) => index + 1));

  const restarted = new CoworkStore(stateDir);
  const next = await restarted.append(ROOM_ID, message('after restart'));
  assert.equal(next.seq, 25);
  assert.equal(next.record_id, `${ROOM_ID}:25`);
  assert.equal(readFileSync(join(stateDir, 'rooms', ROOM_ID, 'archive.jsonl'), 'utf8').split('\n').filter(Boolean).length, 25);
});

test('append handles partial writes, closes descriptors, rolls back, and never advances sequence on failure', async (t) => {
  let injected = true;
  let opened = 0;
  let closed = 0;
  const ops = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') return (...args) => { opened += 1; return target.openSync(...args); };
      if (property === 'closeSync') return (fd) => { closed += 1; return target.closeSync(fd); };
      if (property === 'writeSync') return (fd, bytes, offset, length, position) => {
        if (injected && Buffer.from(bytes).includes(Buffer.from('will-fail'))) {
          injected = false;
          target.writeSync(fd, bytes, offset, Math.max(1, Math.floor(length / 2)), position);
          throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
        }
        return target.writeSync(fd, bytes, offset, length, position);
      };
      return Reflect.get(target, property);
    },
  });
  const { stateDir, store, cleanup } = temporaryStore({ fs: ops });
  t.after(cleanup);
  await store.create(room());
  const baselineOpened = opened;
  const baselineClosed = closed;

  await assert.rejects(store.append(ROOM_ID, message('will-fail')), /append|persist|ENOSPC/i);
  assert.equal(opened - baselineOpened, closed - baselineClosed);
  assert.equal(readFileSync(join(stateDir, 'rooms', ROOM_ID, 'archive.jsonl'), 'utf8'), '');
  const record = await store.append(ROOM_ID, message('works'));
  assert.equal(record.seq, 1);
});

test('append fchmod failure cannot truncate an existing archive', async (t) => {
  let failArchiveChmod = false;
  const archiveFds = new Set();
  const ops = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') return (path, ...args) => {
        const fd = target.openSync(path, ...args);
        if (String(path).endsWith('archive.jsonl')) archiveFds.add(fd);
        return fd;
      };
      if (property === 'closeSync') return (fd) => { archiveFds.delete(fd); return target.closeSync(fd); };
      if (property === 'fchmodSync') return (fd, mode) => {
        if (failArchiveChmod && archiveFds.has(fd)) throw Object.assign(new Error('injected fchmod failure'), { code: 'EIO' });
        return target.fchmodSync(fd, mode);
      };
      return Reflect.get(target, property);
    },
  });
  const { stateDir, store, cleanup } = temporaryStore({ fs: ops });
  t.after(cleanup);
  await store.create(room());
  await store.append(ROOM_ID, message('preserve-me'));
  const archivePath = join(stateDir, 'rooms', ROOM_ID, 'archive.jsonl');
  const before = readFileSync(archivePath);
  failArchiveChmod = true;
  await assert.rejects(store.append(ROOM_ID, message('must-fail')), /fchmod failure/i);
  assert.deepEqual(readFileSync(archivePath), before);
  failArchiveChmod = false;
  assert.equal((await store.append(ROOM_ID, message('second'))).seq, 2);
});

test('room mutex ownership is reentrant, excludes competitors, and releases after exceptions', async (t) => {
  const { store, cleanup } = temporaryStore();
  t.after(cleanup);
  await store.create(room());
  let enterOuter;
  let leaveOuter;
  const entered = new Promise((resolve) => { enterOuter = resolve; });
  const leave = new Promise((resolve) => { leaveOuter = resolve; });
  let competitorEntered = false;

  const outer = store.mutex(ROOM_ID, async () => {
    assert.equal((await store.load(ROOM_ID)).room_id, ROOM_ID);
    await store.save(room({ state: 'active', activated_at: AT }));
    await store.mutex(ROOM_ID).runExclusive(() => store.append(ROOM_ID, message('nested')));
    enterOuter();
    await leave;
  });
  await Promise.race([outer, entered, new Promise((_, reject) => setTimeout(() => reject(new Error('nested room mutex deadlocked')), 250))]);
  const competitor = store.mutex(ROOM_ID, () => { competitorEntered = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(competitorEntered, false);
  leaveOuter();
  await outer;
  await competitor;
  assert.equal(competitorEntered, true);

  await assert.rejects(store.mutex(ROOM_ID, async () => { throw new Error('release me'); }), /release me/);
  await store.mutex(ROOM_ID, () => {});
});

test('room mutex waits for unawaited and recursively registered children before FIFO release', async (t) => {
  const { store, cleanup } = temporaryStore();
  t.after(cleanup);
  await store.create(room());

  let signalChildStarted;
  let releaseChild;
  let releaseCompetitor;
  const childStarted = new Promise((resolve) => { signalChildStarted = resolve; });
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  const competitorGate = new Promise((resolve) => { releaseCompetitor = resolve; });
  let childSettled = false;
  let competitorEntered = false;
  let outerSettled = false;

  const outer = store.mutex(ROOM_ID, () => {
    void store.mutex(ROOM_ID, async () => {
      signalChildStarted();
      await childGate;
      childSettled = true;
    });
  });
  void outer.then(() => { outerSettled = true; });
  await childStarted;
  const competitor = store.mutex(ROOM_ID, async () => {
    competitorEntered = true;
    await competitorGate;
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(outerSettled, false);
    assert.equal(competitorEntered, false);
  } finally {
    releaseChild();
    releaseCompetitor();
  }
  await outer;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(childSettled, true);
  assert.equal(competitorEntered, true);
  await competitor;

  let signalGrandchild;
  let releaseGrandchild;
  const grandchildStarted = new Promise((resolve) => { signalGrandchild = resolve; });
  const grandchildGate = new Promise((resolve) => { releaseGrandchild = resolve; });
  let recursiveOuterSettled = false;
  const recursiveOuter = store.mutex(ROOM_ID, () => {
    void store.mutex(ROOM_ID, () => {
      void store.mutex(ROOM_ID, async () => {
        signalGrandchild();
        await grandchildGate;
      });
    });
  });
  void recursiveOuter.then(() => { recursiveOuterSettled = true; });
  await grandchildStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recursiveOuterSettled, false);
  releaseGrandchild();
  await recursiveOuter;
});

test('unawaited nested mutex rejection rejects the root and never leaks the lock', async (t) => {
  const { store, cleanup } = temporaryStore();
  t.after(cleanup);
  await store.create(room());
  const outer = store.mutex(ROOM_ID, () => {
    void store.mutex(ROOM_ID, async () => {
      await Promise.resolve();
      throw new Error('unawaited nested failure');
    });
  });
  await assert.rejects(outer, /unawaited nested failure/);
  await Promise.race([
    store.mutex(ROOM_ID, () => {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('lock leaked after nested rejection')), 250)),
  ]);
});

test('fsync failure does not leave an in-memory sequence reservation', async (t) => {
  let failArchiveFsync = false;
  const archiveFds = new Set();
  const ops = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') return (path, ...args) => {
        const fd = target.openSync(path, ...args);
        if (String(path).endsWith('archive.jsonl')) archiveFds.add(fd);
        return fd;
      };
      if (property === 'closeSync') return (fd) => { archiveFds.delete(fd); return target.closeSync(fd); };
      if (property === 'fsyncSync') return (fd) => {
        if (failArchiveFsync && archiveFds.has(fd)) {
          failArchiveFsync = false;
          throw Object.assign(new Error('injected fsync failure'), { code: 'EIO' });
        }
        return target.fsyncSync(fd);
      };
      return Reflect.get(target, property);
    },
  });
  const { store, cleanup } = temporaryStore({ fs: ops });
  t.after(cleanup);
  await store.create(room());
  failArchiveFsync = true;
  await assert.rejects(store.append(ROOM_ID, message('not durable')));
  assert.equal((await store.append(ROOM_ID, message('durable'))).seq, 1);
});

test('tail validation reports exact byte offsets for partial, malformed, and non-monotonic records', async (t) => {
  const cases = [
    { name: 'partial', content: '{"version":1', pattern: /partial JSON record.*byte offset 0/i },
    { name: 'malformed', content: '{not-json}\n', pattern: /malformed JSON.*byte offset 0/i },
    {
      name: 'non-monotonic',
      content: `${JSON.stringify({ ...message('first'), seq: 1, record_id: `${ROOM_ID}:1` })}\n${JSON.stringify({ ...message('third'), seq: 3, record_id: `${ROOM_ID}:3` })}\n`,
      offset: Buffer.byteLength(`${JSON.stringify({ ...message('first'), seq: 1, record_id: `${ROOM_ID}:1` })}\n`),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const { stateDir, store, cleanup } = temporaryStore();
      t.after(cleanup);
      await store.create(room());
      writeFileSync(join(stateDir, 'rooms', ROOM_ID, 'archive.jsonl'), entry.content, { mode: 0o600 });
      const restarted = new CoworkStore(stateDir);
      const pattern = entry.pattern ?? new RegExp(`non-monotonic sequence.*byte offset ${entry.offset}`, 'i');
      await assert.rejects(restarted.read(ROOM_ID), pattern);
      await assert.rejects(restarted.append(ROOM_ID, message('blocked')), pattern);
    });
  }
});

test('room IDs cannot traverse paths and room symlinks fail closed', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);
  await assert.rejects(store.load('../outside'));

  const target = mkdtempSync(join(tmpdir(), 'ours-cowork-outside-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  fs.mkdirSync(join(stateDir, 'rooms'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(target, join(stateDir, 'rooms', ROOM_ID));
  await assert.rejects(store.create(room()), /symbolic link|symlink/i);
});

test('hardlink and open/path inode substitution cannot expose or modify another file', async (t) => {
  await t.test('archive hardlink', async (t) => {
    const { stateDir, store, cleanup } = temporaryStore();
    t.after(cleanup);
    await store.create(room());
    const archivePath = join(stateDir, 'rooms', ROOM_ID, 'archive.jsonl');
    const victimPath = join(stateDir, 'victim');
    writeFileSync(victimPath, 'do-not-touch', { mode: 0o640 });
    fs.unlinkSync(archivePath);
    fs.linkSync(victimPath, archivePath);
    const before = readFileSync(victimPath);
    const beforeMode = mode(victimPath);
    await assert.rejects(store.append(ROOM_ID, message('attack')), /hardlink|link count|inode/i);
    assert.deepEqual(readFileSync(victimPath), before);
    assert.equal(mode(victimPath), beforeMode);
  });

  await t.test('metadata hardlink', async (t) => {
    const { stateDir, store, cleanup } = temporaryStore();
    t.after(cleanup);
    await store.create(room());
    const metadataPath = join(stateDir, 'rooms', ROOM_ID, 'room.json');
    const victimPath = join(stateDir, 'metadata-victim');
    fs.renameSync(metadataPath, victimPath);
    fs.linkSync(victimPath, metadataPath);
    await assert.rejects(store.load(ROOM_ID), /hardlink|link count|inode/i);
  });

  await t.test('path inode swapped after open', async (t) => {
    let swap = false;
    let metadataPath;
    const ops = new Proxy(fs, {
      get(target, property) {
        if (property === 'openSync') return (path, ...args) => {
          const fd = target.openSync(path, ...args);
          if (swap && String(path) === metadataPath) {
            swap = false;
            const heldPath = `${metadataPath}.held`;
            target.renameSync(metadataPath, heldPath);
            target.writeFileSync(metadataPath, `${JSON.stringify(room({ state: 'closed', closed_at: AT }))}\n`, { mode: 0o600 });
          }
          return fd;
        };
        return Reflect.get(target, property);
      },
    });
    const temporary = temporaryStore({ fs: ops });
    t.after(temporary.cleanup);
    metadataPath = join(temporary.stateDir, 'rooms', ROOM_ID, 'room.json');
    await temporary.store.create(room());
    swap = true;
    await assert.rejects(temporary.store.load(ROOM_ID), /inode|changed during open/i);
  });
});

test('delete removes archive then metadata without creating an on-disk lock', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);
  await store.create(room({ state: 'closed', closed_at: AT }));
  assert.deepEqual(fs.readdirSync(join(stateDir, 'rooms', ROOM_ID)).sort(), ['archive.jsonl', 'room.json']);
  await store.delete(ROOM_ID);
  assert.equal(fs.existsSync(join(stateDir, 'rooms', ROOM_ID)), false);
  assert.equal(fs.readdirSync(join(stateDir, 'rooms')).some((name) => name.includes('lock')), false);
});

test('delete resumes every expected partial stage and removes explicitly authorized provisioning artifacts', async (t) => {
  for (const stage of ['archive-gone', 'files-gone', 'directory-gone']) {
    await t.test(stage, async (t) => {
      const { stateDir, store, cleanup } = temporaryStore();
      t.after(cleanup);
      await store.create(room({ state: 'closed', closed_at: AT }));
      const roomDir = join(stateDir, 'rooms', ROOM_ID);
      fs.unlinkSync(join(roomDir, 'archive.jsonl'));
      if (stage !== 'archive-gone') fs.unlinkSync(join(roomDir, 'room.json'));
      if (stage === 'directory-gone') fs.rmdirSync(roomDir);
      await store.delete(ROOM_ID);
      assert.equal(fs.existsSync(roomDir), false);
    });
  }

  await t.test('retry after metadata unlink failure', async (t) => {
    let failMetadataUnlink = true;
    const ops = new Proxy(fs, {
      get(target, property) {
        if (property === 'unlinkSync') return (path) => {
          if (failMetadataUnlink && String(path).endsWith('room.json')) {
            failMetadataUnlink = false;
            throw Object.assign(new Error('injected metadata unlink failure'), { code: 'EIO' });
          }
          return target.unlinkSync(path);
        };
        return Reflect.get(target, property);
      },
    });
    const { stateDir, store, cleanup } = temporaryStore({ fs: ops });
    t.after(cleanup);
    await store.create(room({ state: 'closed', closed_at: AT }));
    await assert.rejects(store.delete(ROOM_ID), /unlink failure/i);
    assert.equal(fs.existsSync(join(stateDir, 'rooms', ROOM_ID, 'archive.jsonl')), false);
    await store.delete(ROOM_ID);
    assert.equal(fs.existsSync(join(stateDir, 'rooms', ROOM_ID)), false);
  });

  await t.test('known provisioning artifacts', async (t) => {
    const { stateDir, store, cleanup } = temporaryStore();
    t.after(cleanup);
    await store.create(room({ state: 'closed', closed_at: AT }));
    const roomDir = join(stateDir, 'rooms', ROOM_ID);
    const stagingName = `live.staging-${'ab'.repeat(16)}`;
    for (const name of ['live', 'provisioning-residue', stagingName]) {
      fs.mkdirSync(join(roomDir, name), { mode: 0o700 });
      fs.writeFileSync(join(roomDir, name, 'retained'), name);
    }
    fs.writeFileSync(join(roomDir, '.cowork-provisioning-stage'), `${stagingName}\n`, { mode: 0o600 });
    await store.delete(ROOM_ID);
    assert.equal(fs.existsSync(roomDir), false);
  });

  await t.test('untracked staging residue', async (t) => {
    const { stateDir, store, cleanup } = temporaryStore();
    t.after(cleanup);
    await store.create(room({ state: 'closed', closed_at: AT }));
    const unknown = join(stateDir, 'rooms', ROOM_ID, `live.staging-${'cd'.repeat(16)}`);
    fs.mkdirSync(unknown, { mode: 0o700 });
    await assert.rejects(store.delete(ROOM_ID), /unexpected residue/i);
    assert.equal(fs.existsSync(unknown), true);
  });
});

// ---- Lazy room metadata v1 → v2 migration ----------------------------------

function roomV1(overrides = {}) {
  return {
    version: 1,
    room_id: ROOM_ID,
    identity_name: `cowork-room-${ROOM_ID}`,
    identity_cid: 'cid-room',
    mission: { goal: 'Ship it', briefing: 'Work together.' },
    state: 'provisioning',
    invites: [],
    seats: [],
    created_at: AT,
    ...overrides,
  };
}

test('load migrates a v1 room.json to v2 with a one-time .v1.bak beside it', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);

  const v1 = roomV1({
    state: 'active',
    activated_at: AT,
    invites: [{
      invite_id: 'invite-1', mode: 'public', role: 'reviewer', min_accepts: 1,
      accepted_cids: ['cid-alice'], state: 'live', created_at: AT,
    }],
    seats: [{
      identity: 'cid-alice', display_name: 'Alice', role: 'reviewer',
      invite_id: 'invite-1', accepted_at: AT,
    }],
  });
  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  fs.mkdirSync(roomDir, { recursive: true, mode: 0o700 });
  const originalBytes = `${JSON.stringify(v1)}\n`;
  writeFileSync(join(roomDir, 'room.json'), originalBytes, { mode: 0o600 });
  writeFileSync(join(roomDir, 'archive.jsonl'), '', { mode: 0o600 });

  const migrated = await store.load(ROOM_ID);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.room_name, 'Room 01jz6y7n');
  assert.equal(migrated.anonymous, false);
  assert.equal(migrated.quiet_membership, false);
  assert.equal(migrated.membership_epoch, 0);
  assert.deepEqual(migrated.role_briefings, {});
  assert.equal(migrated.mission.briefing_version, 1);
  assert.equal(migrated.seats[0].state, 'active');
  assert.match(migrated.seats[0].participant_id, /^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  assert.equal(migrated.seats[0].alias, undefined);

  // one-time backup keeps the exact pre-migration bytes
  const backupPath = join(roomDir, 'room.json.v1.bak');
  assert.equal(readFileSync(backupPath, 'utf8'), originalBytes);
  assert.equal(mode(backupPath), 0o600);

  // the durable metadata is now v2 and stable across loads
  const persisted = JSON.parse(readFileSync(join(roomDir, 'room.json'), 'utf8'));
  assert.equal(persisted.version, 2);
  const again = await store.load(ROOM_ID);
  assert.deepEqual(again, migrated);
  assert.equal(readFileSync(backupPath, 'utf8'), originalBytes);
});

test('load atomically persists the deterministic name for legacy unnamed v2 metadata', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);

  const legacy = room();
  delete legacy.room_name;
  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  fs.mkdirSync(roomDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  writeFileSync(join(roomDir, 'archive.jsonl'), '', { mode: 0o600 });

  const migrated = await store.load(ROOM_ID);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.room_name, 'Room 01jz6y7n');
  assert.equal(migrated.room_id, ROOM_ID);
  assert.equal(migrated.identity_name, legacy.identity_name);
  const persisted = JSON.parse(readFileSync(join(roomDir, 'room.json'), 'utf8'));
  assert.equal(persisted.room_name, 'Room 01jz6y7n');
  assert.equal(fs.existsSync(join(roomDir, 'room.json.v1.bak')), false);
  assert.deepEqual(await store.load(ROOM_ID), migrated);
});

test('load canonicalizes and persists non-NFC v2 room names at the storage boundary', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);

  const legacy = room({ room_name: '  Cafe\u0301 launch  ' });
  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  fs.mkdirSync(roomDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  writeFileSync(join(roomDir, 'archive.jsonl'), '', { mode: 0o600 });

  assert.equal((await store.load(ROOM_ID)).room_name, 'Café launch');
  const persisted = JSON.parse(readFileSync(join(roomDir, 'room.json'), 'utf8'));
  assert.equal(persisted.room_name, 'Café launch');
});

test('migration does not clobber an INTACT existing .v1.bak and v2 rooms load untouched', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);

  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  fs.mkdirSync(roomDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(roomV1())}\n`, { mode: 0o600 });
  writeFileSync(join(roomDir, 'archive.jsonl'), '', { mode: 0o600 });
  // NOTE: this fixture used to be the string 'pre-existing backup\n'. It is now a
  // real v1 document, because the once-only rule was narrowed on purpose: a
  // backup is protected when it is INTACT, not merely when it exists. The
  // corrupt case is the test below, and it is why the rule was narrowed.
  const priorBackup = `${JSON.stringify(roomV1({ mission: { goal: 'Older goal', briefing: 'Older briefing.' } }))}\n`;
  writeFileSync(join(roomDir, 'room.json.v1.bak'), priorBackup, { mode: 0o600 });

  const migrated = await store.load(ROOM_ID);
  assert.equal(migrated.version, 2);
  assert.equal(readFileSync(join(roomDir, 'room.json.v1.bak'), 'utf8'), priorBackup);

  const before = readFileSync(join(roomDir, 'room.json'), 'utf8');
  await store.load(ROOM_ID);
  assert.equal(readFileSync(join(roomDir, 'room.json'), 'utf8'), before);
});

test('a partial .v1.bak from a crashed backup write is REPLACED, not trusted', async (t) => {
  // THE CRASH THIS GUARDS. The backup used to be written in place under
  // O_CREAT|O_EXCL and the once-only rule was an EXISTENCE check. A crash inside
  // that write leaves a partial file that exists, so the next load skipped the
  // backup, wrote v2, and the pre-migration bytes were gone with no error and no
  // warning — the one artefact that exists to undo a bad migration reduced to a
  // fragment. Measured before the fix: 40 bytes of 604, JSON.parse false,
  // room.json already v2.
  //
  // COUNTERFACTUAL RUN: reverting migrateUnlocked to the existence check makes
  // this test fail on the final assertion with the 40-byte prefix still on disk.
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);

  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  fs.mkdirSync(roomDir, { recursive: true, mode: 0o700 });
  const originalBytes = `${JSON.stringify(roomV1())}\n`;
  writeFileSync(join(roomDir, 'room.json'), originalBytes, { mode: 0o600 });
  writeFileSync(join(roomDir, 'archive.jsonl'), '', { mode: 0o600 });
  // exactly what a crash mid-write leaves: present, truncated, never fsynced
  const backupPath = join(roomDir, 'room.json.v1.bak');
  writeFileSync(backupPath, originalBytes.slice(0, 40), { mode: 0o600 });

  const migrated = await store.load(ROOM_ID);
  assert.equal(migrated.version, 2);

  const repaired = readFileSync(backupPath, 'utf8');
  assert.equal(repaired, originalBytes, 'the fragment was replaced with the real pre-migration bytes');
  assert.equal(mode(backupPath), 0o600);
  // and what it holds is genuinely a loadable v1 document, not just longer bytes
  assert.equal(JSON.parse(repaired).version, 1);
});

test('the .v1.bak is re-loadable: restoring it migrates again, with FRESH participant ids', async (t) => {
  // Reading this test is the fastest way to learn the property that matters for
  // recovery: restoring the backup is NOT a rollback. It produces a DIFFERENT v2.
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);

  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  fs.mkdirSync(roomDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(roomV1({
    state: 'active',
    activated_at: AT,
    invites: [{
      invite_id: 'invite-1', mode: 'public', role: 'reviewer', min_accepts: 1,
      accepted_cids: ['cid-alice'], state: 'live', created_at: AT,
    }],
    seats: [{
      identity: 'cid-alice', display_name: 'Alice', role: 'reviewer',
      invite_id: 'invite-1', accepted_at: AT,
    }],
  }))}\n`, { mode: 0o600 });
  writeFileSync(join(roomDir, 'archive.jsonl'), '', { mode: 0o600 });

  const first = await store.load(ROOM_ID);
  const backupPath = join(roomDir, 'room.json.v1.bak');

  // the operator's actual recovery: put the backup back and load
  fs.copyFileSync(backupPath, join(roomDir, 'room.json'));
  fs.rmSync(backupPath);
  const second = await store.load(ROOM_ID);

  assert.equal(second.version, 2, 'the restored backup migrates cleanly');
  assert.equal(second.seats[0].identity, 'cid-alice', 'the real seat identity survives');
  assert.notEqual(
    second.seats[0].participant_id,
    first.seats[0].participant_id,
    'participant ids are RE-MINTED — restoring is not a rollback; in an anonymous room every '
    + 'participant gets a new on-wire pseudonymous identity',
  );
});

test('legacy v2 metadata gains rest_roles whether or not it already carries a room name', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);

  // The named case is the one a guarded early-return would miss: room_name is
  // present, so a default injected inside that guard never runs.
  const named = room();
  delete named.rest_roles;
  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  fs.mkdirSync(roomDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(named)}\n`, { mode: 0o600 });
  writeFileSync(join(roomDir, 'archive.jsonl'), '', { mode: 0o600 });
  const loaded = await store.load(ROOM_ID);
  assert.equal(loaded.room_name, 'Release room');
  assert.deepEqual(loaded.rest_roles, []);

  const unnamed = room();
  delete unnamed.room_name;
  delete unnamed.rest_roles;
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(unnamed)}\n`, { mode: 0o600 });
  const defaulted = await store.load(ROOM_ID);
  assert.equal(defaulted.room_name, 'Room 01jz6y7n');
  assert.deepEqual(defaulted.rest_roles, []);

  // and a saved value survives the round trip
  const saved = await store.save({ ...defaulted, rest_roles: ['Reviewer'] });
  assert.deepEqual(saved.rest_roles, ['Reviewer']);
  assert.deepEqual((await store.load(ROOM_ID)).rest_roles, ['Reviewer']);
});

test('a room with REST roles still deletes, so nothing was written outside room.json', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);
  await store.create(room({ state: 'closed', closed_at: AT, rest_roles: ['Reviewer', 'Bot'] }));
  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  assert.deepEqual(fs.readdirSync(roomDir).sort(), ['archive.jsonl', 'room.json']);
  await store.delete(ROOM_ID);
  assert.equal(fs.existsSync(roomDir), false);
});
