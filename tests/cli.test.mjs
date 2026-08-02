import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CLI = join(ROOT, 'dist', 'cli.js');
const TOKEN_PATTERN = /\b[0-9a-f]{64}\b/;

async function runCli(args, options = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
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
    assert.match(unit, new RegExp(`^ExecStart=${CLI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} serve$`, 'm'));
    assert.doesNotMatch(unit, /ours-mcp|(?:^|[ /])\.ours(?:[ /]|$)/im);
    assert.doesNotMatch(unit, /management-token|Bearer/i);

    await writeFile(join(stateDir, 'keep-me'), 'retained');
    const uninstalled = await runCli(['uninstall-service'], { env });
    assert.equal(uninstalled.code, 0, uninstalled.stderr);
    assert.equal(await readFile(join(stateDir, 'keep-me'), 'utf8'), 'retained');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
