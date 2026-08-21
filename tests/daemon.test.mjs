import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as realFs from 'node:fs';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { acquireDaemonLock, CoworkDaemon, isIntakeNotification } from '../src/daemon-runtime.ts';
import { DAEMON_SHUTDOWN_TIMEOUT_MS, DaemonSupervisor } from '../src/daemon.ts';
import {
  ensureRuntimeState,
  loadConfig,
} from '../src/config.ts';

const DAEMON_EXECUTABLE = fileURLToPath(new URL('../dist/daemon.js', import.meta.url));
const DAEMON_EXECUTABLE_URL = new URL('../dist/daemon.js', import.meta.url).href;

test('room intake wakes for messages, files, and contact admission only', () => {
  assert.equal(isIntakeNotification('message_received'), true);
  assert.equal(isIntakeNotification('file_received'), true);
  assert.equal(isIntakeNotification('contact_accepted'), true);
  assert.equal(isIntakeNotification('contact_added'), true);
  assert.equal(isIntakeNotification('notification_registered'), false);
});

async function waitForChildExitOrKill(child, timeoutMs) {
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let watchdog;
  const outcome = await Promise.race([
    exited.then((result) => ({ timedOut: false, result })),
    new Promise((resolve) => {
      watchdog = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      watchdog.unref();
    }),
  ]);
  clearTimeout(watchdog);
  if (!outcome.timedOut) return outcome;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  return { timedOut: true, result: await exited };
}

test('test child watchdog kills and reaps before reporting a timeout', async () => {
  const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const outcome = await waitForChildExitOrKill(child, 50);
  assert.equal(outcome.timedOut, true);
  assert.deepEqual(outcome.result, { code: null, signal: 'SIGKILL' });
  assert.equal(child.signalCode, 'SIGKILL', 'timed-out child was not reaped');
});

test('config is exact, env overrides are strict, and malformed input fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-config-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({
      version: 1, stateDir: join(dir, 'state'), rest: { enabled: false, port: 3010 },
    }), { mode: 0o600 });
    const config = loadConfig({
      OURS_COWORK_CONFIG: path,
      OURS_COWORK_STATE_DIR: join(dir, 'override'),
      OURS_COWORK_REST_PORT: '4010',
    });
    assert.deepEqual(config, {
      version: 1, stateDir: join(dir, 'override'), rest: { enabled: true, port: 4010 },
    });
    writeFileSync(path, JSON.stringify({ version: 1, stateDir: dir, rest: { enabled: false, port: 3010 }, extra: true }));
    assert.throws(() => loadConfig({ OURS_COWORK_CONFIG: path }), /config/i);
    writeFileSync(path, JSON.stringify({
      version: 1, stateDir: join(dir, 'state'), rest: { enabled: false, port: 3010 },
    }));
    assert.throws(() => loadConfig({ OURS_COWORK_CONFIG: path, OURS_COWORK_REST_PORT: '3x' }), /REST_PORT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('supervisor entry stays SDK-free and preserves unrelated signal listeners at every worker stage', async () => {
  const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.\/adapt|\.\/packets|\.\/service|@adapt-toolkit|sdk-native/);
  assert.doesNotMatch(source, /removeAllListeners|process\.exit\(/);
  assert.match(source, /execArgv:\s*\[\]/);
  assert.doesNotMatch(source, /process\.execArgv|workerExecArgv/);
  assert.match(source, /delete workerEnv\.NODE_OPTIONS/);
  assert.equal(DAEMON_SHUTDOWN_TIMEOUT_MS, 10_000);
  for (const stage of ['pre-lock', 'post-lock', 'during-host-init', 'post-host', 'pre-pid', 'ready']) {
    const capability = 'ab'.repeat(32);
    const signals = new EventEmitter();
    let unrelated = 0;
    const listener = () => { unrelated += 1; };
    signals.on('SIGTERM', listener);
    const sent = [];
    const child = Object.assign(new EventEmitter(), {
      connected: true, exitCode: null,
      send(message) { sent.push(message); },
      kill() { assert.fail('acknowledged cleanup must not be force-killed'); },
    });
    const supervisor = new DaemonSupervisor({ child, signals, shutdownTimeoutMs: 500, capability });
    supervisor.start();
    child.emit('message', { type: 'init_ack', capability });
    child.emit('message', { type: 'stage', stage, capability });
    signals.emit('SIGTERM');
    assert.equal(unrelated, 1);
    assert.deepEqual(sent, [
      { type: 'init', capability },
      { type: 'shutdown', signal: 'SIGTERM', capability },
    ]);
    child.emit('message', { type: 'shutdown_ack', requiresProcessExit: true, capability });
    child.exitCode = 0;
    child.emit('exit', 0, null);
    assert.deepEqual(await supervisor.done, { code: 0, signal: null });
    assert(signals.listeners('SIGTERM').includes(listener));
  }
});

test('an authenticated worker shutdown request enters the supervisor bounded shutdown path', async () => {
  const capability = 'cd'.repeat(32);
  const signals = new EventEmitter();
  const sent = [];
  const child = Object.assign(new EventEmitter(), {
    connected: true, exitCode: null,
    send(message) { sent.push(message); },
    kill() { assert.fail('responsive worker must not be force-killed'); },
  });
  const supervisor = new DaemonSupervisor({ child, signals, shutdownTimeoutMs: 500, capability });
  supervisor.start();
  child.emit('message', { type: 'init_ack', capability });
  child.emit('message', { type: 'shutdown_request', capability });
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  assert.deepEqual(sent, [
    { type: 'init', capability },
    { type: 'shutdown', signal: 'SIGTERM', capability },
  ]);
  child.emit('message', { type: 'shutdown_ack', requiresProcessExit: true, capability });
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.deepEqual(await supervisor.done, { code: 0, signal: null });
});

test('an authenticated worker shutdown request arms the exit watchdog', async () => {
  const capability = 'de'.repeat(32);
  const signals = new EventEmitter();
  const sent = [];
  const killed = [];
  const child = Object.assign(new EventEmitter(), {
    connected: true, exitCode: null,
    send(message) { sent.push(message); },
    kill(signal) { killed.push(signal); },
  });
  const supervisor = new DaemonSupervisor({ child, signals, shutdownTimeoutMs: 20, capability });
  supervisor.start();
  child.emit('message', { type: 'init_ack', capability });
  child.emit('message', { type: 'shutdown_request', capability });
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.deepEqual(sent, [
    { type: 'init', capability },
    { type: 'shutdown', signal: 'SIGTERM', capability },
  ]);
  assert.deepEqual(killed, ['SIGKILL']);
  child.exitCode = null;
  child.emit('exit', null, 'SIGKILL');
  assert.deepEqual(await supervisor.done, { code: null, signal: 'SIGKILL' });
});

test('supervisor strips inherited preload and execution modes from its worker', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-exec-argv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, 'preload.cjs');
  writeFileSync(preload, "require('node:fs').appendFileSync(process.env.COWORK_PRELOAD_MARKER, `${process.pid}\\n`);\n");
  const daemonUrl = DAEMON_EXECUTABLE_URL;
  const program = `
    const { runSupervisor } = await import(${JSON.stringify(daemonUrl)});
    const done = runSupervisor({ quiet: true });
    process.kill(process.pid, 'SIGTERM');
    const code = await done;
    process.exitCode = code;
  `;
  const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;

  for (const mode of ['cli-require', 'node-options']) {
    const marker = join(dir, `${mode}.marker`);
    const args = ['--input-type=module', '--eval', program];
    if (mode === 'cli-require') args.unshift('--require', preload);
    const child = spawn(process.execPath, args, {
      env: {
        ...baseEnv,
        ...(mode === 'node-options' ? { NODE_OPTIONS: `--require=${preload}` } : {}),
        COWORK_PRELOAD_MARKER: marker,
        OURS_COWORK_STATE_DIR: join(dir, `${mode}-state`),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const outcome = await waitForChildExitOrKill(child, DAEMON_SHUTDOWN_TIMEOUT_MS * 2);
    assert.equal(outcome.timedOut, false, `${mode} exceeded the bounded supervisor lifecycle and was reaped: ${stderr}`);
    assert.deepEqual(outcome.result, { code: 0, signal: null }, `${mode}: ${stderr}`);
    assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1, `${mode}: preload reached daemon worker`);
  }
});

test('supervisor watchdog kills acknowledged and unacknowledged hangs and contains IPC failures', async () => {
  for (const acknowledged of [true, false]) {
    const capability = 'cd'.repeat(32);
    const signals = new EventEmitter();
    const killed = [];
    const child = Object.assign(new EventEmitter(), {
      connected: true, exitCode: null,
      send(_message, callback) { callback?.(); },
      kill(signal) { killed.push(signal); },
    });
    const supervisor = new DaemonSupervisor({ child, signals, shutdownTimeoutMs: 20, capability });
    supervisor.start();
    child.emit('message', { type: 'init_ack', capability });
    signals.emit('SIGTERM');
    if (acknowledged) child.emit('message', { type: 'shutdown_ack', requiresProcessExit: true, capability });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(killed, ['SIGKILL'], acknowledged ? 'ACK must not disarm exit deadline' : 'missing ACK must time out');
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await supervisor.done;
  }

  for (const failure of ['throw', 'callback', 'disconnect']) {
    const capability = 'ef'.repeat(32);
    const signals = new EventEmitter();
    const killed = [];
    const child = Object.assign(new EventEmitter(), {
      connected: true, exitCode: null,
      send(_message, callback) {
        if (failure === 'throw') throw new Error('IPC send threw');
        if (failure === 'callback') callback?.(new Error('IPC callback failed'));
        else callback?.();
      },
      kill(signal) { killed.push(signal); },
    });
    const supervisor = new DaemonSupervisor({ child, signals, shutdownTimeoutMs: 20, capability });
    supervisor.start();
    if (failure === 'disconnect') child.emit('disconnect');
    else assert.doesNotThrow(() => signals.emit('SIGINT'));
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(killed, ['SIGKILL']);
    child.exitCode = 1;
    child.emit('exit', 1, null);
    assert.equal((await supervisor.done).code, 1);
  }
});

test('supervisor settles idempotently on error and close terminal events', async () => {
  for (const terminal of ['error-only', 'error-close', 'close-only']) {
    const capability = 'fa'.repeat(32);
    const signals = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      connected: true, exitCode: null,
      send(_message, callback) { callback?.(); },
      kill() {},
    });
    const supervisor = new DaemonSupervisor({ child, signals, shutdownTimeoutMs: 20, capability });
    supervisor.start();
    const primary = new Error(`${terminal} spawn failure`);
    if (terminal !== 'close-only') child.emit('error', primary);
    if (terminal !== 'error-only') child.emit('close', 1, null);
    const result = await Promise.race([
      supervisor.done,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 75)),
    ]);
    assert.notEqual(result, 'timeout', `${terminal} left supervisor.done pending`);
    assert.equal(result.code, terminal === 'close-only' ? 1 : null);
    assert.equal(result.signal, null);
    if (terminal !== 'close-only') assert.equal(result.error, primary);
    child.emit('exit', 2, 'SIGKILL');
    child.emit('close', 2, 'SIGKILL');
    assert.equal(await supervisor.done, result);
  }
});

test('supervisor settles on an actual OS spawn failure without exit', async (t) => {
  const child = spawn(join(tmpdir(), `cowork-missing-executable-${process.pid}`), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => {
    try { child.disconnect(); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  });
  const supervisor = new DaemonSupervisor({
    child,
    signals: new EventEmitter(),
    shutdownTimeoutMs: 20,
    capability: 'fb'.repeat(32),
  });
  supervisor.start();
  const result = await Promise.race([
    supervisor.done,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
  ]);
  assert.notEqual(result, 'timeout');
  assert(result.error instanceof Error);
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(result.signal, null);
});

test('authorized worker shutdown before and during capability handshake never creates runtime state', async (t) => {
  for (const phase of ['before-init', 'during-handshake']) {
    const dir = mkdtempSync(join(tmpdir(), `cowork-worker-${phase}-`));
    const capability = phase === 'before-init' ? '12'.repeat(32) : '34'.repeat(32);
    const child = spawn(process.execPath, [DAEMON_EXECUTABLE], {
      env: {
        ...process.env,
        OURS_COWORK_DAEMON_WORKER: '1',
        OURS_COWORK_SUPERVISOR_PID: String(process.pid),
        OURS_COWORK_STATE_DIR: dir,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
    if (phase === 'before-init') {
      child.send({ type: 'shutdown', signal: 'SIGTERM', capability });
    } else {
      child.send({ type: 'init', capability });
      child.send({ type: 'shutdown', signal: 'SIGINT', capability });
    }
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 3_000);
        timer.unref();
      }),
    ]);
    assert.notEqual(exited, 'timeout', `${phase}: ${stderr}`);
    assert.deepEqual(exited, { code: 0, signal: null }, `${phase}: ${stderr}`);
    assert.equal(existsSync(join(dir, 'daemon.lock')), false);
    assert.equal(existsSync(join(dir, 'daemon.pid')), false);
    assert.equal(existsSync(join(dir, 'management.sock')), false);
  }
});

test('ambient worker environment or mismatched live IPC fails before runtime state', async (t) => {
  for (const scenario of ['no-ipc', 'wrong-parent']) {
    const dir = mkdtempSync(join(tmpdir(), `cowork-unauthorized-${scenario}-`));
    const child = spawn(process.execPath, [DAEMON_EXECUTABLE], {
      env: {
        ...process.env,
        OURS_COWORK_DAEMON_WORKER: '1',
        OURS_COWORK_SUPERVISOR_PID: scenario === 'no-ipc' ? String(process.pid) : String(process.pid === 1 ? 2 : 1),
        OURS_COWORK_STATE_DIR: dir,
      },
      stdio: scenario === 'no-ipc' ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 3_000);
        timer.unref();
      }),
    ]);
    assert.notEqual(exited, 'timeout', `${scenario}: unauthorized worker imported/started runtime: ${stderr}`);
    assert.deepEqual(exited, { code: 1, signal: null });
    assert.match(stderr, /authorized IPC|supervisor|worker/i);
    assert.equal(existsSync(join(dir, 'daemon.lock')), false);
    assert.equal(existsSync(join(dir, 'daemon.pid')), false);
    assert.equal(existsSync(join(dir, 'management.sock')), false);
  }
});

test('runtime state creates no token and rejects insecure modes and symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-perms-'));
  try {
    const stateDir = join(dir, 'state');
    const config = { version: 1, stateDir, rest: { enabled: true, port: 3010 } };
    const runtime = ensureRuntimeState(config);
    assert.equal('token' in runtime, false);
    assert.equal('tokenPath' in runtime, false);
    assert.equal(lstatSync(stateDir).mode & 0o777, 0o700);
    assert.equal(existsSync(join(stateDir, 'management-token')), false);
    chmodSync(stateDir, 0o755);
    assert.throws(() => ensureRuntimeState(config), /state directory.*mode/i);

    const real = join(dir, 'real');
    const link = join(dir, 'linked');
    writeFileSync(real, 'not-dir');
    symlinkSync(real, link);
    assert.throws(() => ensureRuntimeState({ ...config, stateDir: link, rest: { enabled: false, port: 3010 } }), /symbolic link|symlink/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('state setup rejects a hostile writable ancestor and config validates the opened fd after a swap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-path-race-'));
  try {
    const hostile = join(dir, 'hostile');
    realFs.mkdirSync(hostile, { mode: 0o777 });
    chmodSync(hostile, 0o777);
    assert.throws(() => ensureRuntimeState({
      version: 1, stateDir: join(hostile, 'state'), rest: { enabled: false, port: 3010 },
    }), /unsafe writable ancestor/i);

    const configPath = join(dir, 'config.json');
    const config = { version: 1, stateDir: join(dir, 'state'), rest: { enabled: false, port: 3010 } };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const replacement = join(dir, 'replacement.json');
    writeFileSync(replacement, JSON.stringify(config), { mode: 0o644 });
    let swapped = false;
    const fs = new Proxy(realFs, {
      get(target, property) {
        if (property === 'openSync') return (path, ...args) => {
          if (!swapped && path === configPath) {
            swapped = true;
            renameSync(replacement, configPath);
          }
          return target.openSync(path, ...args);
        };
        return target[property];
      },
    });
    assert.throws(() => loadConfig({ OURS_COWORK_CONFIG: configPath }, { fs }), /config|0600|mode/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('safe foreign ancestors are allowed, but foreign-owned sticky writable ancestors are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-ancestor-policy-'));
  try {
    const foreign = join(dir, 'foreign');
    realFs.mkdirSync(foreign, { mode: 0o755 });
    const foreignUid = (typeof process.getuid === 'function' ? process.getuid() : 0) + 10_000;
    const fsWithAncestor = (mode) => new Proxy(realFs, {
      get(target, property) {
        if (property === 'lstatSync') return (path, ...args) => {
          const stat = target.lstatSync(path, ...args);
          if (path !== foreign) return stat;
          return new Proxy(stat, {
            get(value, key) {
              if (key === 'uid') return foreignUid;
              if (key === 'mode') return (value.mode & ~0o7777) | mode;
              return Reflect.get(value, key, value);
            },
          });
        };
        return target[property];
      },
    });
    const config = {
      version: 1, stateDir: join(foreign, 'state'),
      rest: { enabled: false, port: 3010 },
    };
    ensureRuntimeState(config, { fs: fsWithAncestor(0o755) });
    rmSync(join(foreign, 'state'), { recursive: true, force: true });
    assert.throws(
      () => ensureRuntimeState(config, { fs: fsWithAncestor(0o1777) }),
      /unsafe writable ancestor/i,
    );
    const rootOwnedSticky = new Proxy(realFs, {
      get(target, property) {
        if (property === 'lstatSync') return (path, ...args) => {
          const stat = target.lstatSync(path, ...args);
          if (path !== foreign && path !== '/' && path !== tmpdir()) return stat;
          return new Proxy(stat, {
            get(value, key) {
              if (key === 'uid') return foreignUid;
              if (key === 'mode' && path === foreign) return (value.mode & ~0o7777) | 0o1777;
              return Reflect.get(value, key, value);
            },
          });
        };
        return target[property];
      },
    });
    ensureRuntimeState(config, { fs: rootOwnedSticky });
    assert.equal(loadConfig({}, { home: dir }).stateDir, join(dir, '.ours-cowork'));
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
  const config = { version: 1, stateDir: dir, rest: { enabled: false, port: 3010 } };
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
    config: { version: 1, stateDir: dir, rest: { enabled: false, port: 3010 } },
    prepare: () => ({ socketPath: join(dir, 'management.sock') }),
    lock: () => ({ release: () => events.push('lock.release') }),
    host: new FakeHost(events),
    store: { async list() { return [{ room_id: '01jz6y7n8p9q0r1s2t3v4w5x6y', state: 'active' }]; } },
    registry: new FakeRegistry(events),
    service: Object.assign(new FakeService(events, []), {
      recoverPacket: async () => { throw new Error('restore crash'); },
    }),
    transports: { async start() { events.push('transports.start'); }, async stop() { events.push('transports.stop'); } },
    writePid: () => events.push('pid.write'), removePid: () => events.push('pid.remove'),
  });
  await assert.rejects(daemon.boot(), /restore crash/);
  assert.deepEqual(events.slice(-4), ['pid.remove', 'packets.remove', 'host.close', 'lock.release']);
  await daemon.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test('runtime shutdown is idempotent and does not own process signal listeners', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-runtime-shutdown-'));
  const events = [];
  const daemon = new CoworkDaemon({
    config: { version: 1, stateDir: dir, rest: { enabled: false, port: 3010 } },
    prepare: () => ({ socketPath: join(dir, 'management.sock') }),
    lock: () => ({ release: () => events.push('lock.release') }),
    host: new FakeHost(events),
    store: { async list() { return []; } },
    registry: new FakeRegistry(events),
    service: new FakeService(events, []),
    transports: { async start() { events.push('transports.start'); }, async stop() { events.push('transports.stop'); } },
    writePid: () => events.push('pid.write'), removePid: () => events.push('pid.remove'),
  });
  await daemon.boot();
  await Promise.all([daemon.shutdown(), daemon.shutdown()]);
  assert.equal(events.filter((event) => event === 'transports.stop').length, 1);
  assert.equal(events.filter((event) => event === 'host.close').length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('runtime shutdown preserves requiresProcessExit on aggregated cleanup failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-runtime-exit-result-'));
  const stopFailure = Object.assign(new Error('wrapper stop failed'), { requiresProcessExit: true });
  const events = [];
  const daemon = new CoworkDaemon({
    config: { version: 1, stateDir: dir, rest: { enabled: false, port: 3010 } },
    prepare: () => ({ socketPath: join(dir, 'management.sock') }),
    lock: () => ({ release() { events.push('lock.release'); } }),
    host: { async boot() {}, async shutdown() { throw stopFailure; }, close() {} },
    store: { async list() { return []; } }, registry: new FakeRegistry(events), service: new FakeService(events, []),
    transports: { async start() {}, async stop() {} }, writePid() {}, removePid() {},
  });
  await daemon.boot();
  await assert.rejects(daemon.shutdown(), (error) => error instanceof AggregateError
    && error.requiresProcessExit === true
    && error.errors.includes(stopFailure));
  rmSync(dir, { recursive: true, force: true });
});

test('shutdown during delayed wrapper boot cancels every later boot phase before releasing ownership', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-boot-cancel-'));
  const events = [];
  let releaseBoot;
  const host = {
    boot() { events.push('wrapper.begin'); return new Promise((resolve) => { releaseBoot = () => { events.push('wrapper.end'); resolve(); }; }); },
    async shutdown() { events.push('host.shutdown'); },
    close() { assert.fail('legacy close must not be used when shutdown exists'); },
  };
  const daemon = new CoworkDaemon({
    config: { version: 1, stateDir: dir, rest: { enabled: false, port: 3010 } },
    prepare: () => ({ socketPath: join(dir, 'management.sock') }),
    lock: () => ({ release: () => events.push('lock.release') }), host,
    store: { async list() { events.push('rooms.list'); return []; } },
    registry: new FakeRegistry(events), service: new FakeService(events, []),
    transports: { async start() { events.push('transports.start'); }, async stop() { events.push('transports.stop'); } },
    writePid: () => events.push('pid.write'), removePid: () => events.push('pid.remove'),
  });
  const boot = daemon.boot();
  await Promise.resolve();
  const stopped = daemon.shutdown();
  releaseBoot();
  await assert.rejects(boot, /cancel|shutdown/i);
  await stopped;
  assert.deepEqual(events, [
    'wrapper.begin', 'wrapper.end', 'service.reject', 'service.drain', 'pid.remove',
    'packets.remove', 'host.shutdown', 'lock.release',
  ]);
  assert(!events.includes('rooms.list'));
  assert(!events.includes('transports.start'));
  assert(!events.includes('pid.write'));
  rmSync(dir, { recursive: true, force: true });
});

test('rejected host boot and transport start still invoke their idempotent cleanup boundaries', async () => {
  const room = { room_id: '01jz6y7n8p9q0r1s2t3v4w5x6y', state: 'active' };
  for (const failAt of ['host', 'transport']) {
    const dir = mkdtempSync(join(tmpdir(), `cowork-attempt-${failAt}-`));
    const events = [];
    const host = {
      async boot() { events.push('host.boot'); if (failAt === 'host') throw new Error('primary boot failure'); },
      async shutdown() { events.push('host.shutdown'); }, close() {},
    };
    const transports = {
      async start() { events.push('transport.start'); if (failAt === 'transport') throw new Error('primary transport failure'); },
      async stop() { events.push('transport.stop'); },
    };
    const daemon = new CoworkDaemon({
      config: { version: 1, stateDir: dir, rest: { enabled: false, port: 3010 } },
      prepare: () => ({ socketPath: join(dir, 'management.sock') }), lock: () => ({ release() { events.push('lock.release'); } }),
      host, store: { async list() { return failAt === 'transport' ? [room] : []; } }, registry: new FakeRegistry(events),
      service: new FakeService(events, []), transports,
      writePid() {}, removePid() { events.push('pid.remove'); },
    });
    await assert.rejects(daemon.boot(), failAt === 'host' ? /primary boot/ : /primary transport/);
    assert(events.includes('host.shutdown'));
    if (failAt === 'transport') assert(events.includes('transport.stop'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot failure preserves the primary error and aggregates cleanup failures without resurrection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-error-aggregate-'));
  const primary = new Error('primary host boot failure');
  const cleanup = new Error('host cleanup failure');
  const events = [];
  const daemon = new CoworkDaemon({
    config: { version: 1, stateDir: dir, rest: { enabled: false, port: 3010 } },
    prepare: () => ({ socketPath: join(dir, 'management.sock') }),
    lock: () => ({ release() { events.push('lock.release'); } }),
    host: { async boot() { throw primary; }, async shutdown() { throw cleanup; }, close() {} },
    store: { async list() { return []; } }, registry: new FakeRegistry(events), service: new FakeService(events, []),
    transports: { async start() {}, async stop() {} }, writePid() {}, removePid() { events.push('pid.remove'); },
  });
  await assert.rejects(daemon.boot(), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.equal(error.errors[0], primary);
    assert(error.errors.some((entry) => entry instanceof AggregateError && entry.errors.includes(cleanup)));
    return true;
  });
  await assert.rejects(daemon.shutdown(), (error) => error instanceof AggregateError && error.errors.includes(cleanup));
  assert.deepEqual(events.slice(-3), ['pid.remove', 'packets.remove', 'lock.release']);
  assert(!events.includes('transports.start'));
  rmSync(dir, { recursive: true, force: true });
});

test('real executable fails closed when the shared daemon is absent and creates no embedded state', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-real-shared-absent-'));
  const coworkState = join(dir, 'cowork');
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    stateDir: coworkState,
    rest: { enabled: false, port: 3052 },
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [DAEMON_EXECUTABLE], {
    env: {
      ...process.env,
      OURS_COWORK_CONFIG: configPath,
      OURS_PORT: '1',
      OURS_STATE_DIR: join(dir, 'shared-ours'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
  ]);
  assert.notEqual(exited, 'timeout', stderr);
  assert.deepEqual(exited, { code: 1, signal: null });
  assert.equal(existsSync(join(coworkState, 'ours-sdk')), false);
  assert.equal(existsSync(join(coworkState, 'daemon.pid')), false);
  assert.equal(existsSync(join(coworkState, 'management.sock')), false);
});
