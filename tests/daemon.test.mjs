import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acquireDaemonLock,
  CoworkDaemon,
} from '../src/daemon.ts';
import {
  ensureRuntimeState,
  loadConfig,
} from '../src/config.ts';

test('config is exact, env overrides are strict, and malformed input fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-config-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({
      version: 1, brokerUrl: 'ws://file', stateDir: join(dir, 'state'), rest: { enabled: false, port: 3010 },
    }), { mode: 0o600 });
    const config = loadConfig({
      OURS_COWORK_CONFIG: path,
      OURS_COWORK_BROKER_URL: 'ws://env',
      OURS_COWORK_STATE_DIR: join(dir, 'override'),
      OURS_COWORK_REST_PORT: '4010',
    });
    assert.deepEqual(config, {
      version: 1, brokerUrl: 'ws://env', stateDir: join(dir, 'override'), rest: { enabled: true, port: 4010 },
    });
    writeFileSync(path, JSON.stringify({ version: 1, brokerUrl: 'ws://file', stateDir: dir, rest: { enabled: false, port: 3010 }, extra: true }));
    assert.throws(() => loadConfig({ OURS_COWORK_CONFIG: path }), /config/i);
    writeFileSync(path, JSON.stringify({
      version: 1, brokerUrl: 'ws://file', stateDir: join(dir, 'state'), rest: { enabled: false, port: 3010 },
    }));
    assert.throws(() => loadConfig({ OURS_COWORK_CONFIG: path, OURS_COWORK_REST_PORT: '3x' }), /REST_PORT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runtime state and token reject insecure modes and symlinks; token creation failure is fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-perms-'));
  try {
    const stateDir = join(dir, 'state');
    const config = { version: 1, brokerUrl: 'ws://broker', stateDir, rest: { enabled: true, port: 3010 } };
    const runtime = ensureRuntimeState(config);
    assert.match(runtime.token, /^[0-9a-f]{64}$/);
    assert.equal(lstatSync(stateDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(stateDir, 'management-token')).mode & 0o777, 0o600);
    chmodSync(join(stateDir, 'management-token'), 0o644);
    assert.throws(() => ensureRuntimeState(config), /management token.*mode/i);
    rmSync(join(stateDir, 'management-token'));
    chmodSync(stateDir, 0o755);
    assert.throws(() => ensureRuntimeState(config), /state directory.*mode/i);

    const real = join(dir, 'real');
    const link = join(dir, 'linked');
    writeFileSync(real, 'not-dir');
    symlinkSync(real, link);
    assert.throws(() => ensureRuntimeState({ ...config, stateDir: link, rest: { enabled: false, port: 3010 } }), /symbolic link|symlink/i);

    const failedDir = join(dir, 'random-failure');
    assert.throws(() => ensureRuntimeState(
      { ...config, stateDir: failedDir },
      { random: () => { throw new Error('entropy unavailable'); } },
    ), /generate management token/);
    assert.equal(existsSync(join(failedDir, 'management-token')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('single-instance lock refuses live owners, recovers stale owners, and is ownership-safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-lock-'));
  try {
    chmodSync(dir, 0o700);
    const live = acquireDaemonLock(dir, { pid: 111, isProcessAlive: (pid) => pid === 111 });
    assert.throws(() => acquireDaemonLock(dir, { pid: 222, isProcessAlive: (pid) => pid === 111 }), /already running/);
    live.release();
    writeFileSync(join(dir, 'daemon.lock'), '333\n', { mode: 0o600 });
    const recovered = acquireDaemonLock(dir, { pid: 444, isProcessAlive: () => false });
    assert.equal(readFileSync(join(dir, 'daemon.lock'), 'utf8'), '444\n');
    recovered.release();
    assert.equal(existsSync(join(dir, 'daemon.lock')), false);

    writeFileSync(join(dir, 'daemon.pid'), '555\n', { mode: 0o600 });
    assert.throws(
      () => acquireDaemonLock(dir, { pid: 666, isProcessAlive: (owner) => owner === 555 }),
      /already running.*555/,
    );
    assert.equal(existsSync(join(dir, 'daemon.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

class FakeSignals {
  listeners = new Map();
  on(event, listener) { this.listeners.set(event, listener); }
  off(event, listener) { if (this.listeners.get(event) === listener) this.listeners.delete(event); }
  emit(event) { this.listeners.get(event)?.(); }
}

class FakeHost {
  events;
  constructor(events) { this.events = events; }
  async boot() { this.events.push('wrapper'); }
  close() { this.events.push('host.close'); }
}

class FakeRegistry {
  events;
  constructor(events) { this.events = events; }
  async unhostAll() { this.events.push('packets.remove'); }
}

class FakeService {
  events;
  rooms;
  constructor(events, rooms) { this.events = events; this.rooms = rooms; }
  async recoverPacket(id) { this.events.push(`restore:${id}`); }
  async reconcileRoom(id) { this.events.push(`reconcile:${id}`); }
  async closeRoom(id) { this.events.push(`close:${id}`); }
  async resumePending(id) { this.events.push(`pending:${id}`); }
  beginShutdown() { this.events.push('service.reject'); }
  async drain() { this.events.push('service.drain'); }
}

test('daemon boot uses phased recovery order and shutdown drains before unhosting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-daemon-'));
  const events = [];
  const rooms = [
    { room_id: '01jz6y7n8p9q0r1s2t3v4w5x6y', state: 'active' },
    { room_id: '01jz6y7n8p9q0r1s2t3v4w5x6z', state: 'closing' },
    { room_id: '01jz6y7n8p9q0r1s2t3v4w5x70', state: 'closed' },
  ];
  const config = { version: 1, brokerUrl: 'ws://broker', stateDir: dir, rest: { enabled: false, port: 3010 } };
  const transports = {
    async start() { events.push('transports.start'); },
    async stop() { events.push('transports.stop'); },
  };
  const daemon = new CoworkDaemon({
    config,
    prepare: () => ({ socketPath: join(dir, 'management.sock') }),
    lock: () => ({ release: () => events.push('lock.release') }),
    host: new FakeHost(events),
    store: { async list() { events.push('rooms.list'); return rooms; } },
    registry: new FakeRegistry(events),
    service: new FakeService(events, rooms),
    transports,
    writePid: () => events.push('pid.write'),
    removePid: () => events.push('pid.remove'),
  });
  try {
    await daemon.boot();
    assert.deepEqual(events.slice(0, 10), [
      'wrapper', 'rooms.list',
      `restore:${rooms[0].room_id}`, `restore:${rooms[1].room_id}`,
      `reconcile:${rooms[0].room_id}`,
      `close:${rooms[1].room_id}`,
      `pending:${rooms[0].room_id}`,
      'transports.start', 'pid.write',
    ].slice(0, 10));
    await Promise.all([daemon.shutdown(), daemon.shutdown()]);
    assert.deepEqual(events.slice(-7), [
      'service.reject', 'transports.stop', 'service.drain', 'pid.remove', 'packets.remove', 'host.close', 'lock.release',
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('partial boot failure rolls back transports, PID, packets, host, and lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-rollback-'));
  const events = [];
  const daemon = new CoworkDaemon({
    config: { version: 1, brokerUrl: 'ws://broker', stateDir: dir, rest: { enabled: false, port: 3010 } },
    prepare: () => ({ socketPath: join(dir, 'management.sock') }),
    lock: () => ({ release: () => events.push('lock.release') }),
    host: new FakeHost(events),
    store: { async list() { return [{ room_id: '01jz6y7n8p9q0r1s2t3v4w5x6y', state: 'active' }]; } },
    registry: new FakeRegistry(events),
    service: { ...new FakeService(events, []), recoverPacket: async () => { throw new Error('restore crash'); } },
    transports: { async start() { events.push('transports.start'); }, async stop() { events.push('transports.stop'); } },
    writePid: () => events.push('pid.write'), removePid: () => events.push('pid.remove'),
  });
  await assert.rejects(daemon.boot(), /restore crash/);
  assert.deepEqual(events.slice(-4), ['pid.remove', 'packets.remove', 'host.close', 'lock.release']);
  await daemon.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test('SIGINT and SIGTERM share one idempotent shutdown and remove listeners', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-signals-'));
  const events = [];
  const signals = new FakeSignals();
  const daemon = new CoworkDaemon({
    config: { version: 1, brokerUrl: 'ws://broker', stateDir: dir, rest: { enabled: false, port: 3010 } },
    prepare: () => ({ socketPath: join(dir, 'management.sock') }),
    lock: () => ({ release: () => events.push('lock.release') }),
    host: new FakeHost(events),
    store: { async list() { return []; } },
    registry: new FakeRegistry(events),
    service: new FakeService(events, []),
    transports: { async start() { events.push('transports.start'); }, async stop() { events.push('transports.stop'); } },
    writePid: () => events.push('pid.write'), removePid: () => events.push('pid.remove'),
    signals,
  });
  await daemon.boot();
  assert.deepEqual([...signals.listeners.keys()].sort(), ['SIGINT', 'SIGTERM']);
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  await daemon.shutdown();
  assert.equal(events.filter((event) => event === 'transports.stop').length, 1);
  assert.equal(events.filter((event) => event === 'host.close').length, 1);
  assert.equal(signals.listeners.size, 0);
  rmSync(dir, { recursive: true, force: true });
});
