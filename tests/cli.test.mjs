import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import { NATIVE_RPC_TIMEOUT_MS, rpcCall, rpcTimeoutForMethod } from '../src/cli.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CLI = join(ROOT, 'dist', 'cli.js');
const TOKEN_PATTERN = /\b[0-9a-f]{64}\b/;

async function runCli(args, options = {}) {
  const cli = options.cli ?? CLI;
  const nodeArgs = options.platform === undefined
    ? [cli, ...args]
    : ['--input-type=module', '--eval', `
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(options.platform)} });
      process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
      await import(${JSON.stringify(new URL(`file://${cli}`).href)});
    `];
  const child = spawn(process.execPath, nodeArgs, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', resolveCode);
  });
  return { code, stdout, stderr };
}

async function withRawRpc(handler, action) {
  const stateDir = await mkdtemp(join(tmpdir(), 'cowork-cli-raw-'));
  await chmod(stateDir, 0o700);
  const socketPath = join(stateDir, 'management.sock');
  const server = createServer(handler);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolveListen);
  });
  try {
    return await action({ OURS_COWORK_STATE_DIR: stateDir });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function withRpc(response, action) {
  const stateDir = await mkdtemp(join(tmpdir(), 'cowork-cli-'));
  await chmod(stateDir, 0o700);
  const socketPath = join(stateDir, 'management.sock');
  const requests = [];
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    let bytes = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      bytes += chunk;
      const lines = bytes.split('\n');
      bytes = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line);
        requests.push(request);
        const value = typeof response === 'function' ? response(request) : response;
        socket.end(`${JSON.stringify({ version: 1, id: request.id, ...value })}\n`);
      }
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolveListen);
  });
  try {
    return await action({
      env: { OURS_COWORK_STATE_DIR: stateDir },
      requests,
      get connections() { return connections; },
    });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('usage errors exit 2 before touching the daemon', async () => {
  for (const args of [
    ['unknown'],
    ['room'],
    ['room', 'show'],
    ['room', 'create', '--goal', 'g'],
    ['docs', 'not-a-topic'],
  ]) {
    const result = await runCli(args, { env: { OURS_COWORK_STATE_DIR: join(tmpdir(), 'absent-cowork-cli') } });
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage|unknown|requires/i);
  }
});

test('room commands send exactly one JSONL request over management.sock', async () => {
  const cases = [
    { args: ['room', 'create', '--goal', 'Ship', '--briefing', 'Stay focused'], method: 'room.create', params: { goal: 'Ship', briefing: 'Stay focused' } },
    { args: ['room', 'settings', 'room1', '--goal', 'G', '--status', 'ready'], method: 'room.settings', params: { room_id: 'room1', goal: 'G', status: 'ready' } },
    { args: ['room', 'invite', 'room1', '--mode', 'public', '--role', 'reviewer', '--min-accepts', '2'], method: 'room.invite', params: { room_id: 'room1', mode: 'public', role: 'reviewer', min_accepts: 2 } },
    { args: ['room', 'revoke', 'room1', 'invite1'], method: 'room.revoke', params: { room_id: 'room1', invite_id: 'invite1' } },
    { args: ['room', 'list'], method: 'room.list', params: {} },
    { args: ['room', 'show', 'room1'], method: 'room.show', params: { room_id: 'room1' } },
    { args: ['room', 'participants', 'room1'], method: 'room.participants', params: { room_id: 'room1' } },
    { args: ['room', 'history', 'room1', '--after', '5', '--limit', '20'], method: 'room.history', params: { room_id: 'room1', after: 5, limit: 20 } },
    { args: ['room', 'message', 'room1', '--text', 'Hello'], method: 'room.message', params: { room_id: 'room1', text: 'Hello' } },
    { args: ['room', 'close', 'room1'], method: 'room.close', params: { room_id: 'room1' } },
    { args: ['room', 'delete', 'room1', '--yes'], method: 'room.delete', params: { room_id: 'room1', confirm: true } },
    { args: ['room', 'recover', 'room1'], method: 'room.recover', params: { room_id: 'room1' } },
    { args: ['room', 'recover', 'room1', '--confirm', 'old1', 'new1'], method: 'room.recover.confirm', params: { room_id: 'room1', recovery_of: 'old1', invite_id: 'new1' } },
  ];
  for (const expected of cases) {
    await withRpc({ result: { ok: true } }, async (rpc) => {
      const result = await runCli(expected.args, { env: rpc.env });
      assert.equal(result.code, 0, `${expected.args.join(' ')}: ${result.stderr}`);
      assert.equal(rpc.connections, 1);
      assert.equal(rpc.requests.length, 1);
      assert.equal(rpc.requests[0].version, 1);
      assert.equal(typeof rpc.requests[0].id, 'string');
      assert.equal(rpc.requests[0].method, expected.method);
      assert.deepEqual(rpc.requests[0].params, expected.params);
    });
  }
});

test('native mutations wait for one slow response while reads stay short and timeout is an honest unknown outcome', { timeout: 20_000 }, async () => {
  assert.equal(NATIVE_RPC_TIMEOUT_MS, 120_000);
  for (const method of ['room.create', 'room.invite', 'room.revoke', 'room.message', 'room.close', 'room.recover', 'room.recover.confirm']) {
    assert.equal(rpcTimeoutForMethod(method), NATIVE_RPC_TIMEOUT_MS, method);
  }
  for (const method of ['room.list', 'room.show', 'room.participants', 'room.history', 'room.settings', 'room.delete', 'daemon.status']) {
    assert.equal(rpcTimeoutForMethod(method), 10_000, method);
  }

  let slowRequests = 0;
  await withRawRpc((socket) => {
    socket.once('data', (bytes) => {
      const request = JSON.parse(bytes.toString('utf8'));
      slowRequests += 1;
      setTimeout(() => socket.end(`${JSON.stringify({ version: 1, id: request.id, result: { room_id: 'slow-room' } })}\n`), 10_250);
    });
  }, async (env) => {
    const result = await runCli(['room', 'create', '--goal', 'Slow', '--briefing', 'Exactly once'], { env });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { room_id: 'slow-room' });
  });
  assert.equal(slowRequests, 1, 'slow native mutation must never be retried');

  let timedOutRequests = 0;
  await withRawRpc((socket) => {
    socket.once('data', () => { timedOutRequests += 1; });
  }, async (env) => {
    const socketPath = join(env.OURS_COWORK_STATE_DIR, 'management.sock');
    await assert.rejects(
      rpcCall(socketPath, 'room.create', { goal: 'Unknown', briefing: 'Outcome' }, 25),
      (error) => error?.code === 'daemon_unavailable' && error?.connected === true,
    );
  });
  assert.equal(timedOutRequests, 1, 'timed-out mutation must remain one unknown-outcome request');
});

test('JSON mode emits one stdout-only JSON value on success and errors', async () => {
  await withRpc({ result: { room_id: 'room1' } }, async (rpc) => {
    const result = await runCli(['--json', 'room', 'show', 'room1'], { env: rpc.env });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: { room_id: 'room1' } });
    assert.equal(result.stdout.trim().split('\n').length, 1);
  });
  await withRpc({ error: { code: 'not_found', message: 'room missing' } }, async (rpc) => {
    const result = await runCli(['room', 'show', 'room1', '--json'], { env: rpc.env });
    assert.equal(result.code, 3);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: 'not_found', message: 'room missing' } });
  });
});

test('RPC and connection failures use the stable exit-code contract', async () => {
  for (const [code, expected] of [
    ['not_found', 3],
    ['invalid_state', 4],
    ['invalid_params', 4],
    ['unauthorized', 5],
    ['internal', 7],
    ['method_not_found', 7],
  ]) {
    await withRpc({ error: { code, message: code } }, async (rpc) => {
      const result = await runCli(['room', 'list', '--json'], { env: rpc.env });
      assert.equal(result.code, expected, code);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).error.code, code);
    });
  }
  const stateDir = await mkdtemp(join(tmpdir(), 'cowork-cli-down-'));
  await chmod(stateDir, 0o700);
  try {
    const result = await runCli(['room', 'list', '--json'], { env: { OURS_COWORK_STATE_DIR: stateDir } });
    assert.equal(result.code, 6);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).error.code, 'daemon_unavailable');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('delete requires --yes and message author-spoof flags are rejected locally', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'cowork-cli-local-'));
  await chmod(stateDir, 0o700);
  try {
    for (const args of [
      ['room', 'delete', 'room1'],
      ['room', 'message', 'room1', '--text', 'hi', '--author', 'mallory'],
      ['room', 'message', 'room1', '--text', 'hi', '--author-identity', 'mallory'],
      ['room', 'message', 'room1', '--text', 'hi', '--display-name', 'Mallory'],
      ['room', 'message', 'room1', '--text', 'hi', '--role', 'owner'],
    ]) {
      const result = await runCli(args, { env: { OURS_COWORK_STATE_DIR: stateDir } });
      assert.equal(result.code, 2, args.join(' '));
      assert.match(result.stderr, /--yes|author|unknown|not allowed/i);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('option values beginning -- are unambiguous and global --json never steals inline data', async () => {
  for (const value of ['--help', '--json']) {
    await withRpc({ result: { accepted: true } }, async (rpc) => {
      const result = await runCli(['--json', 'room', 'message', 'room1', `--text=${value}`], { env: rpc.env });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(rpc.requests.length, 1);
      assert.equal(rpc.requests[0].params.text, value);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: { accepted: true } });
    });
  }
  const local = await runCli(['room', 'message', 'room1', '--text=hello', '--author=mallory']);
  assert.equal(local.code, 2);
  assert.match(local.stderr, /unknown|not allowed/i);
});

test('malformed, incomplete, and oversized RPC replies fail fast without a lingering timeout', async () => {
  const cases = [
    (socket) => socket.end('{not-json}\n'),
    (socket) => socket.end('{"version":1'),
    (socket) => socket.end(`${'x'.repeat(1024 * 1024 + 1)}\n`),
  ];
  for (const handler of cases) {
    await withRawRpc((socket) => {
      socket.once('data', () => handler(socket));
    }, async (env) => {
      const before = Date.now();
      const result = await runCli(['room', 'list', '--json'], { env });
      const elapsed = Date.now() - before;
      assert.equal(result.code, 7);
      assert.equal(result.stderr, '');
      assert(elapsed < 2_000, `protocol failure kept the CLI alive for ${elapsed}ms`);
      assert.equal(JSON.parse(result.stdout).ok, false);
    });
  }
});

test('status, stop, and restart ignore a purpose-built argv/PPID/PID/lock/socket spoof', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'cowork-cli-owner-'));
  await chmod(stateDir, 0o700);
  const fakeWorkerProgram = 'setInterval(() => {}, 1000)';
  const fakeParentProgram = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const worker = spawn(process.execPath, ['--eval', ${JSON.stringify(fakeWorkerProgram)}, ${JSON.stringify(join(ROOT, 'dist', 'daemon.js'))}], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(join(stateDir, 'daemon.lock'))}, worker.pid + '\\n', { mode: 0o600 });
    process.on('exit', () => { try { worker.kill('SIGTERM'); } catch {} });
    setInterval(() => {}, 1000);
  `;
  const unrelated = spawn(process.execPath, ['--eval', fakeParentProgram, CLI, 'serve'], { stdio: 'ignore' });
  assert(unrelated.pid);
  await writeFile(join(stateDir, 'daemon.pid'), `${unrelated.pid}\n`, { mode: 0o600 });
  const lockDeadline = Date.now() + 2_000;
  while (spawnSync('test', ['-f', join(stateDir, 'daemon.lock')]).status !== 0 && Date.now() < lockDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const workerPid = Number((await readFile(join(stateDir, 'daemon.lock'), 'utf8')).trim());
  assert(Number.isSafeInteger(workerPid));
  const listener = createServer((socket) => {
    socket.once('data', (bytes) => {
      const request = JSON.parse(bytes.toString('utf8'));
      socket.end(`${JSON.stringify({ version: 1, id: request.id, error: { code: 'method_not_found', message: 'no control capability' } })}\n`);
    });
  });
  await new Promise((resolveListen, reject) => {
    listener.once('error', reject);
    listener.listen(join(stateDir, 'management.sock'), resolveListen);
  });
  const env = { OURS_COWORK_STATE_DIR: stateDir };
  try {
    const status = await runCli(['status', '--json'], { env });
    assert.equal(status.code, 6);
    assert.equal(JSON.parse(status.stdout).error.code, 'daemon_unavailable');

    const stop = await runCli(['stop', '--json'], { env });
    assert.equal(stop.code, 4);
    assert.equal(unrelated.exitCode, null, 'stop killed an unrelated process');
    assert.doesNotThrow(() => process.kill(workerPid, 0), 'stop killed the unrelated child');

    const restart = await runCli(['restart', '--json'], { env });
    assert.equal(restart.code, 4);
    assert.equal(unrelated.exitCode, null, 'restart killed an unrelated process');
    assert.doesNotThrow(() => process.kill(workerPid, 0), 'restart killed the unrelated child');
  } finally {
    await new Promise((resolveClose) => listener.close(resolveClose));
    if (unrelated.exitCode === null) unrelated.kill('SIGTERM');
    await new Promise((resolveClose) => unrelated.once('close', resolveClose));
    try { process.kill(workerPid, 'SIGTERM'); } catch { /* already exited */ }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a silent but accepting control endpoint cannot prove its session stopped', { timeout: 20_000 }, async () => {
  const session = 'ab'.repeat(16);
  let requests = 0;
  await withRawRpc((socket) => {
    let bytes = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      bytes += chunk;
      const newline = bytes.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(bytes.slice(0, newline));
      requests += 1;
      const result = request.method === 'daemon.status'
        ? requests === 1
          ? { version: 1, protocol: 'cowork-supervisor-control', running: true, session }
          : undefined
        : request.method === 'daemon.shutdown'
          ? { accepted: true, session }
          : undefined;
      if (result === undefined) return;
      socket.end(`${JSON.stringify({ version: 1, id: request.id, result })}\n`);
    });
  }, async (env) => {
    const before = Date.now();
    const result = await runCli(['stop', '--json'], { env });
    const elapsed = Date.now() - before;
    assert.equal(result.code, 4);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).error.code, 'invalid_state');
    assert(elapsed >= 11_000, `silent live endpoint was treated as stopped after ${elapsed}ms`);
    assert(requests > 2, 'stop did not continue polling the accepting endpoint');
  });
});

test('replacement of the authenticated control session proves the original session stopped', async () => {
  const original = 'ab'.repeat(16);
  const replacement = 'cd'.repeat(16);
  let shutdownAccepted = false;
  await withRpc((request) => {
    if (request.method === 'daemon.status') {
      return { result: {
        version: 1,
        protocol: 'cowork-supervisor-control',
        running: true,
        session: shutdownAccepted ? replacement : original,
      } };
    }
    if (request.method === 'daemon.shutdown') {
      shutdownAccepted = true;
      return { result: { accepted: true, session: original } };
    }
    return { error: { code: 'method_not_found', message: 'unsupported' } };
  }, async (rpc) => {
    const result = await runCli(['stop', '--json'], { env: rpc.env });
    assert.equal(result.code, 0, `${result.stdout} ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout).result, { stopped: true });
  });
});

test('real daemon start, status, and stop use the management control session', { timeout: 30_000 }, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'cowork-cli-real-control-'));
  await chmod(stateDir, 0o700);
  const configPath = join(stateDir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    brokerUrl: 'ws://127.0.0.1:1',
    stateDir,
    rest: { enabled: false, port: 3052 },
  }), { mode: 0o600 });
  const env = {
    OURS_COWORK_CONFIG: configPath,
  };
  t.after(async () => {
    const pidPath = join(stateDir, 'daemon.pid');
    try {
      const pid = Number((await readFile(pidPath, 'utf8')).trim());
      if (Number.isSafeInteger(pid)) process.kill(pid, 'SIGKILL');
    } catch { /* daemon stopped or never started */ }
    await rm(stateDir, { recursive: true, force: true });
  });
  const started = await runCli(['start', '--json'], { env });
  assert.equal(started.code, 0, `${started.stdout} ${started.stderr}`);
  const status = await runCli(['status', '--json'], { env });
  assert.equal(status.code, 0, `${status.stdout} ${status.stderr}`);
  assert.deepEqual(JSON.parse(status.stdout).result, { running: true });
  const stopped = await runCli(['stop', '--json'], { env });
  assert.equal(stopped.code, 0, `${stopped.stdout} ${stopped.stderr}`);
  assert.equal(JSON.parse(stopped.stdout).result.stopped, true);
  const after = await runCli(['status', '--json'], { env });
  assert.equal(after.code, 6);
});

test('--json serve emits exactly one JSON value and suppresses supervised diagnostics', async () => {
  for (const behavior of ['clean', 'nonzero', 'throw']) {
    const directory = await mkdtemp(join(tmpdir(), 'cowork serve copy '));
    const cli = join(directory, 'cli.js');
    await writeFile(cli, await readFile(CLI));
    await chmod(cli, 0o700);
    const daemon = behavior === 'throw'
      ? `export async function runSupervisor(options) { if (!options?.quiet) console.error('worker diagnostic'); throw new Error('supervisor failed'); }\n`
      : `export async function runSupervisor(options) { if (!options?.quiet) console.error('worker diagnostic'); return ${behavior === 'clean' ? 0 : 1}; }\n`;
    await writeFile(join(directory, 'daemon.js'), daemon);
    try {
      const result = await runCli(['--json', 'serve'], { cli });
      assert.equal(result.code, behavior === 'clean' ? 0 : 7);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout.trim().split('\n').length, 1);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, behavior === 'clean');
      if (behavior === 'clean') assert.deepEqual(json.result, { served: true, exit_code: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('offline docs cover operations and exact limitations without exposing a management token', async () => {
  const result = await runCli(['docs', 'limitations'], {
    env: { OURS_COWORK_STATE_DIR: join(tmpdir(), 'does-not-exist'), HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, TOKEN_PATTERN);
  assert.match(result.stdout, /plaintext/i);
  assert.match(result.stdout, /process lifetime/i);
  assert.match(result.stdout, /at-least-once/i);
  assert.match(result.stdout, /duplicate/i);
  assert.match(result.stdout, /does not observe delivery/i);
  assert.match(result.stdout, /stopped/i);
  assert.match(result.stdout, /complete state directory/i);
  assert.match(result.stdout, /uninstall.*retain/i);
  assert.match(result.stdout, /closed.*--yes/i);

  const docNames = [
    '01-prerequisites.md', '02-installation.md', '03-configuration.md',
    '04-daemon-lifecycle.md', '05-room-workflow.md', '06-invites.md',
    '07-messaging-history.md', '08-backup-restore.md',
    '09-service-management.md', '10-limitations.md',
  ];
  const docs = await Promise.all(docNames.map((name) => readFile(join(ROOT, 'docs', name), 'utf8')));
  assert.equal(docs.length, 10);
  assert.doesNotMatch(docs.join('\n'), TOKEN_PATTERN);
});

test('generated service definitions execute the cowork CLI directly and uninstall retains state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cowork-service-home-'));
  const stateDir = join(home, 'state');
  const binDir = join(home, 'bin');
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(binDir, { mode: 0o700 });
  for (const name of ['systemctl', 'loginctl']) {
    const path = join(binDir, name);
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(path, 0o700);
  }
  const env = {
    HOME: home,
    PATH: `${binDir}:${process.env.PATH}`,
    OURS_COWORK_STATE_DIR: stateDir,
  };
  try {
    const installed = await runCli(['install-service'], { env });
    assert.equal(installed.code, 0, installed.stderr);
    const unitPath = join(home, '.config', 'systemd', 'user', 'ours-cowork.service');
    const unit = await readFile(unitPath, 'utf8');
    assert.match(unit, new RegExp(`^ExecStart="${CLI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" serve$`, 'm'));
    const externalDaemonPattern = new RegExp(`${['ours', 'mcp'].join('-')}|(?:^|[ /])\\.ours(?:[ /]|$)`, 'im');
    assert.doesNotMatch(unit, externalDaemonPattern);
    assert.doesNotMatch(unit, /management-token|Bearer/i);

    await writeFile(join(stateDir, 'keep-me'), 'retained');
    const uninstalled = await runCli(['uninstall-service'], { env });
    assert.equal(uninstalled.code, 0, uninstalled.stderr);
    assert.equal(await readFile(join(stateDir, 'keep-me'), 'utf8'), 'retained');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('failed systemd and launchd unloads retain their service definitions and report failure', async () => {
  for (const platform of ['linux', 'darwin']) {
    const home = await mkdtemp(join(tmpdir(), `cowork-${platform}-uninstall-`));
    const binDir = join(home, 'bin');
    await mkdir(binDir, { mode: 0o700 });
    const command = platform === 'linux' ? 'systemctl' : 'launchctl';
    const tool = join(binDir, command);
    await writeFile(tool, '#!/bin/sh\nexit 19\n', { mode: 0o700 });
    await chmod(tool, 0o700);
    const definition = platform === 'linux'
      ? join(home, '.config', 'systemd', 'user', 'ours-cowork.service')
      : join(home, 'Library', 'LaunchAgents', 'network.ours.cowork.plist');
    await mkdir(resolve(definition, '..'), { recursive: true, mode: 0o700 });
    await writeFile(definition, 'must remain');
    try {
      const result = await runCli(['uninstall-service', '--json'], {
        platform,
        env: { HOME: home, PATH: `${binDir}:${process.env.PATH}`, OURS_COWORK_STATE_DIR: join(home, 'state') },
      });
      assert.equal(result.code, 7, `${platform}: ${result.stdout} ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.equal(await readFile(definition, 'utf8'), 'must remain');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test('systemd ExecStart quotes a cowork CLI path containing spaces and special characters', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cowork-systemd-quote-'));
  const unusual = join(home, 'cowork path % $');
  const copiedCli = join(unusual, 'cli.js');
  const binDir = join(home, 'bin');
  const stateDir = join(home, 'state');
  await mkdir(unusual, { recursive: true, mode: 0o700 });
  await mkdir(binDir, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(copiedCli, await readFile(CLI));
  await chmod(copiedCli, 0o700);
  for (const name of ['systemctl', 'loginctl']) {
    await writeFile(join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(join(binDir, name), 0o700);
  }
  try {
    const result = await runCli(['install-service'], {
      cli: copiedCli,
      env: { HOME: home, PATH: `${binDir}:${process.env.PATH}`, OURS_COWORK_STATE_DIR: stateDir },
    });
    assert.equal(result.code, 0, result.stderr);
    const unitPath = join(home, '.config', 'systemd', 'user', 'ours-cowork.service');
    const unit = await readFile(unitPath, 'utf8');
    assert.match(unit, /^ExecStart="(?:[^"\\]|\\.)+" serve$/m);
    if (spawnSync('systemd-analyze', ['--version']).status === 0) {
      const verified = spawnSync('systemd-analyze', ['verify', unitPath], { encoding: 'utf8' });
      assert.equal(verified.status, 0, verified.stderr);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('service install rejects control characters before creating or replacing a unit', async () => {
  for (const control of ['\n', '\r']) {
    const home = await mkdtemp(join(tmpdir(), 'cowork-systemd-control-'));
    const binDir = join(home, 'bin');
    const unitPath = join(home, '.config', 'systemd', 'user', 'ours-cowork.service');
    await mkdir(binDir, { mode: 0o700 });
    for (const name of ['systemctl', 'loginctl']) {
      await writeFile(join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      await chmod(join(binDir, name), 0o700);
    }
    await mkdir(resolve(unitPath, '..'), { recursive: true, mode: 0o700 });
    await writeFile(unitPath, 'existing unit must remain');
    try {
      const result = await runCli(['install-service', '--json'], {
        env: {
          HOME: home,
          PATH: `${binDir}:${process.env.PATH}`,
          OURS_COWORK_STATE_DIR: join(home, `unsafe${control}state`),
        },
      });
      assert.equal(result.code, 4);
      assert.equal(result.stderr, '');
      assert.equal(await readFile(unitPath, 'utf8'), 'existing unit must remain');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
