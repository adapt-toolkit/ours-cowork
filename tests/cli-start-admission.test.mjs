import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { acquireSupervisorLock } from '../src/supervisor-lock.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CLI = join(ROOT, 'dist', 'cli.js');

/** A state directory whose newest supervisor generation is held by this live test process. */
async function heldState(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'cowork-cli-admission-'));
  await chmod(stateDir, 0o700);
  const configPath = join(stateDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, stateDir, rest: { enabled: false, port: 3052 } }), { mode: 0o600 });
  const lock = acquireSupervisorLock(stateDir);
  const servers = [];
  t.after(async () => {
    lock.release();
    for (const server of servers) await new Promise((closed) => server.close(closed));
    await rm(stateDir, { recursive: true, force: true });
  });
  /** Answer every control request on the management socket with `value`. */
  const listen = (value) => new Promise((ready, reject) => {
    const server = createServer((socket) => {
      let bytes = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        bytes += chunk;
        const line = bytes.split('\n')[0];
        if (line === bytes) return;
        const request = JSON.parse(line);
        socket.end(`${JSON.stringify({ version: 1, id: request.id, ...value })}\n`);
      });
    });
    servers.push(server);
    server.once('error', reject);
    server.listen(join(stateDir, 'management.sock'), ready);
  });
  return { stateDir, configPath, listen };
}

function start(configPath) {
  const env = { ...process.env, OURS_COWORK_CONFIG: configPath };
  for (const key of ['OURS_CONFIG', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_COWORK_STATE_DIR']) delete env[key];
  const started = Date.now();
  const child = spawn(process.execPath, [CLI, 'start', '--json'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.resume();
  return new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code) => done({ code, stdout, elapsed: Date.now() - started }));
  });
}

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

test('start waits on a held supervisor lock and reports a successor that becomes ready as already running', async (t) => {
  const { stateDir, configPath, listen } = await heldState(t);
  const result = start(configPath);
  await sleep(1_000);
  await listen({ result: { version: 1, protocol: 'cowork-supervisor-control', running: true, session: 'ab'.repeat(16) } });
  const { code, stdout } = await result;
  assert.equal(code, 0, stdout);
  assert.deepEqual(JSON.parse(stdout).result, { started: false, alreadyRunning: true });
  assert.equal(existsSync(join(stateDir, 'daemon.log')), false, 'no replacement was spawned against the held lock');
});

test('start waiting on a held supervisor lock fails closed when a foreign endpoint takes the socket', async (t) => {
  const { stateDir, configPath, listen } = await heldState(t);
  const result = start(configPath);
  await sleep(1_000);
  await listen({ error: { code: 'method_not_found', message: 'no control capability' } });
  const { code, stdout } = await result;
  assert.equal(code, 4, stdout);
  assert.match(JSON.parse(stdout).error.message, /occupied by an endpoint without cowork supervisor control/);
  assert.equal(existsSync(join(stateDir, 'daemon.log')), false, 'no replacement was spawned');
});

test('start never spawns after its single budget expires behind a held supervisor lock', { timeout: 60_000 }, async (t) => {
  const { stateDir, configPath } = await heldState(t);
  const { code, stdout, elapsed } = await start(configPath);
  assert.equal(code, 4, stdout);
  assert.equal(JSON.parse(stdout).error.message, 'another cowork supervisor still holds the supervisor lock');
  assert(elapsed >= 29_000 && elapsed < 40_000, `start waited ${elapsed}ms instead of one start budget`);
  assert.equal(existsSync(join(stateDir, 'daemon.log')), false, 'no late spawn after the budget expired');
});
