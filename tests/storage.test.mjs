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

  failRename = true;
  await assert.rejects(store.save(room({ state: 'closed', closed_at: AT })), /rename failure/i);
  assert.equal((await new CoworkStore(stateDir).load(ROOM_ID)).state, 'active');
  assert.equal(fs.readdirSync(join(stateDir, 'rooms', ROOM_ID)).some((name) => name.includes('.tmp-')), false);
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

test('delete removes archive then metadata without creating an on-disk lock', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore();
  t.after(cleanup);
  await store.create(room({ state: 'closed', closed_at: AT }));
  assert.deepEqual(fs.readdirSync(join(stateDir, 'rooms', ROOM_ID)).sort(), ['archive.jsonl', 'room.json']);
  await store.delete(ROOM_ID);
  assert.equal(fs.existsSync(join(stateDir, 'rooms', ROOM_ID)), false);
  assert.equal(fs.readdirSync(join(stateDir, 'rooms')).some((name) => name.includes('lock')), false);
});
