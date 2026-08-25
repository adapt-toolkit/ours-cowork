import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test, { after } from 'node:test';

import {
  NATIVE_RPC_TIMEOUT_MS,
  browserOpenCommand,
  openWebConsole,
  rpcCall,
  rpcTimeoutForMethod,
  waitForHttpReadiness,
} from '../src/cli.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CLI = join(ROOT, 'dist', 'cli.js');
const TOKEN_PATTERN = /\b[0-9a-f]{64}\b/;
const CLEAN_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'ours-cowork-cli-tests-'));
const CLEAN_COWORK_CONFIG = join(CLEAN_CONFIG_DIR, 'config.json');
await writeFile(CLEAN_COWORK_CONFIG, JSON.stringify({
  version: 1,
  stateDir: join(CLEAN_CONFIG_DIR, 'state'),
  rest: { enabled: false, port: 3052 },
}), { mode: 0o600 });
after(() => rm(CLEAN_CONFIG_DIR, { recursive: true, force: true }));

async function runCli(args, options = {}) {
  const cli = options.cli ?? CLI;
  const nodeArgs = options.platform === undefined
    ? [cli, ...args]
    : ['--input-type=module', '--eval', `
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(options.platform)} });
      process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
      await import(${JSON.stringify(new URL(`file://${cli}`).href)});
    `];
  const env = { ...process.env };
  for (const key of ['OURS_CONFIG', 'OURS_PORT', 'OURS_STATE_DIR']) delete env[key];
  env.OURS_COWORK_CONFIG = CLEAN_COWORK_CONFIG;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn(process.execPath, nodeArgs, {
    cwd: ROOT,
    env,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (options.input !== undefined) child.stdin.end(options.input);
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

test('npm-style symlinked binary executes the CLI entrypoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cowork-cli-symlink-'));
  const link = join(directory, 'ours-cowork');
  try {
    await symlink(CLI, link);
    const help = await runCli(['--help'], { cli: link });
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /Usage:[\s\S]*ours-cowork/);

    const status = await runCli(['status'], {
      cli: link,
      env: { OURS_COWORK_STATE_DIR: join(directory, 'absent') },
    });
    assert.equal(status.code, 6);
    assert.match(status.stderr, /stopped/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
    ['web', 'extra'],
    ['room', 'say', 'room1', '--text', 'no role'],
    ['room', 'say', 'room1', '--role', 'Reviewer'],
    ['room', 'rest-role', 'room1'],
  ]) {
    const result = await runCli(args, { env: { OURS_COWORK_STATE_DIR: join(tmpdir(), 'absent-cowork-cli') } });
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage|unknown|requires/i);
  }
});

test('web uses the safe daemon start path, waits on GET readiness, and opens once', async () => {
  for (const lifecycle of [
    { started: true, alreadyRunning: false },
    { started: false, alreadyRunning: true },
  ]) {
    const calls = [];
    const config = {
      version: 1,
      stateDir: '/tmp/cowork-web-test',
      rest: { enabled: true, port: 4312 },
    };
    const result = await openWebConsole(config, false, {
      ensureDaemon: async (observed) => { calls.push(['daemon', observed]); return lifecycle; },
      waitForHttpReady: async (url) => { calls.push(['ready', url]); return true; },
      openBrowser: (url) => { calls.push(['open', url]); },
    });
    assert.deepEqual(result, { url: 'http://127.0.0.1:4312/', opened: true });
    assert.deepEqual(calls, [
      ['daemon', config],
      ['ready', 'http://127.0.0.1:4312/'],
      ['open', 'http://127.0.0.1:4312/'],
    ]);
  }
});

test('web disabled, readiness timeout, and JSON mode preserve exact side-effect boundaries', async () => {
  const disabled = {
    version: 1,
    stateDir: '/tmp/cowork-web-test',
    rest: { enabled: false, port: 3052 },
  };
  let lifecycleCalls = 0;
  await assert.rejects(
    openWebConsole(disabled, false, {
      ensureDaemon: async () => { lifecycleCalls += 1; return { started: true, alreadyRunning: false }; },
      waitForHttpReady: async () => true,
      openBrowser: () => assert.fail('disabled web command opened a browser'),
    }),
    (error) => error?.exitCode === 1
      && error?.message === 'web console is disabled (rest.enabled=false); enable it in cowork configuration and restart the daemon',
  );
  assert.equal(lifecycleCalls, 0);

  const enabled = { ...disabled, rest: { enabled: true, port: 3052 } };
  await assert.rejects(
    openWebConsole(enabled, false, {
      ensureDaemon: async () => ({ started: false, alreadyRunning: true }),
      waitForHttpReady: async () => false,
      openBrowser: () => assert.fail('unready web command opened a browser'),
    }),
    (error) => error?.exitCode === 7 && /web console did not become ready at http:\/\/127\.0\.0\.1:3052\//.test(error?.message),
  );

  let opened = 0;
  const result = await openWebConsole(enabled, true, {
    ensureDaemon: async () => ({ started: false, alreadyRunning: true }),
    waitForHttpReady: async () => true,
    openBrowser: () => { opened += 1; },
  });
  assert.deepEqual(result, { url: 'http://127.0.0.1:3052/', opened: false });
  assert.equal(opened, 0);
});

test('web readiness enforces an absolute deadline after headers, incomplete close, and response trickle', { timeout: 10_000 }, async () => {
  for (const behavior of ['incomplete-close', 'trickle']) {
    const server = createHttpServer((_request, response) => {
      if (behavior === 'incomplete-close') {
        response.writeHead(200, { 'content-length': '8' });
        response.flushHeaders();
        response.write('x');
        setImmediate(() => response.destroy());
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.flushHeaders();
      const interval = setInterval(() => response.write('x'), 20);
      response.once('close', () => clearInterval(interval));
    });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const started = Date.now();
        const outcome = await Promise.race([
          waitForHttpReadiness(`http://127.0.0.1:${address.port}/`, 120),
          new Promise((resolveHung) => setTimeout(() => resolveHung('hung'), 600)),
        ]);
        assert.equal(outcome, false, `${behavior} readiness attempt ${attempt} did not settle false`);
        assert(Date.now() - started < 500, `${behavior} attempt ${attempt} exceeded its absolute readiness deadline`);
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }
});

test('web browser opener selects the platform-native command without a shell', () => {
  const url = 'http://127.0.0.1:3052/';
  assert.deepEqual(browserOpenCommand(url, 'linux'), { command: 'xdg-open', args: [url] });
  assert.deepEqual(browserOpenCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserOpenCommand(url, 'win32'), { command: 'cmd.exe', args: ['/c', 'start', '', url] });
  assert.throws(() => browserOpenCommand(url, 'freebsd'), /unsupported/);
});

test('web CLI exits 1 with the exact disabled message', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'cowork-cli-web-disabled-'));
  await chmod(stateDir, 0o700);
  const configPath = join(stateDir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    stateDir,
    rest: { enabled: false, port: 3052 },
  }), { mode: 0o600 });
  try {
    const result = await runCli(['web'], { env: { OURS_COWORK_CONFIG: configPath } });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ours-cowork: web console is disabled (rest.enabled=false); enable it in cowork configuration and restart the daemon\n');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('room commands send exactly one JSONL request over management.sock', async () => {
  const cases = [
    { args: ['room', 'create', '--goal', 'Ship', '--briefing', 'Stay focused'], method: 'room.create', params: { goal: 'Ship', briefing: 'Stay focused' } },
    { args: ['room', 'create', '--name', 'Launch room', '--goal', 'Ship', '--briefing', 'Stay focused'], method: 'room.create', params: { name: 'Launch room', goal: 'Ship', briefing: 'Stay focused' } },
    { args: ['room', 'settings', 'room1', '--goal', 'G', '--status', 'ready'], method: 'room.settings', params: { room_id: 'room1', goal: 'G', status: 'ready' } },
    { args: ['room', 'settings', 'room1', '--name', 'Renamed room'], method: 'room.settings', params: { room_id: 'room1', name: 'Renamed room' } },
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
    // Room membership and briefing verbs
    { args: ['room', 'create', '--goal', 'Ship', '--briefing', 'B', '--anonymous', '--quiet-membership'], method: 'room.create', params: { goal: 'Ship', briefing: 'B', anonymous: true, quiet_membership: true } },
    { args: ['room', 'settings', 'room1', '--quiet-membership', 'false'], method: 'room.settings', params: { room_id: 'room1', quiet_membership: false } },
    { args: ['room', 'invite', 'room1'], method: 'room.invite', params: { room_id: 'room1', mode: 'one_time', min_accepts: 1 } },
    { args: ['room', 'role-briefing', 'room1', '--role', 'reviewer', '--text', 'Review the diffs'], method: 'room.briefing.role.set', params: { room_id: 'room1', role: 'reviewer', text: 'Review the diffs' } },
    { args: ['room', 'role-briefing', 'room1', '--role', 'reviewer', '--delete'], method: 'room.briefing.role.delete', params: { room_id: 'room1', role: 'reviewer' } },
    { args: ['room', 'remove', 'room1', 'cid-participant'], method: 'room.participant.remove', params: { room_id: 'room1', participant: 'cid-participant' } },
    { args: ['room', 'remove', 'room1', 'cid-participant', '--silent'], method: 'room.participant.remove', params: { room_id: 'room1', participant: 'cid-participant', notify: false } },
    { args: ['room', 'replace', 'room1', 'cid-participant'], method: 'room.participant.replace', params: { room_id: 'room1', participant: 'cid-participant' } },
    { args: ['room', 'replace', 'room1', 'cid-participant', '--mode', 'public', '--min-accepts', '2'], method: 'room.participant.replace', params: { room_id: 'room1', participant: 'cid-participant', mode: 'public', min_accepts: 2 } },
    { args: ['room', 'history', 'room1', '--view', 'participant'], method: 'room.history', params: { room_id: 'room1', view: 'participant', after: 0 } },
    // REST role authorship
    { args: ['room', 'say', 'room1', '--role', 'Reviewer', '--text', 'Reviewed'], method: 'room.say', params: { room_id: 'room1', role: 'Reviewer', text: 'Reviewed' } },
    { args: ['room', 'rest-role', 'room1', '--role', 'Reviewer'], method: 'room.role.rest.add', params: { room_id: 'room1', role: 'Reviewer' } },
    { args: ['room', 'rest-role', 'room1', '--role', 'Reviewer', '--remove'], method: 'room.role.rest.remove', params: { room_id: 'room1', role: 'Reviewer' } },
  ];
  for (const expected of cases) {
    await withRpc((request) => ({ result: request.method === 'room.history' ? [] : { ok: true } }), async (rpc) => {
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

test('room accept reads secrets only from secure files or bounded stdin and redacts output', async () => {
  const secret = 'invite-material-that-must-not-be-echoed';
  await withRpc({ result: {
    room_id: 'room1', participant_id: 'p1', state: 'pending', role: 'reviewer',
    identity: 'AB'.repeat(32), invite_id: 'i1', inviter_name: 'Peer', pending_name: '', requested_at: 'now',
  } }, async (rpc) => {
    const file = join(rpc.env.OURS_COWORK_STATE_DIR, 'invite.txt');
    await writeFile(file, secret, { mode: 0o600 });
    const fromFile = await runCli([
      '--json', 'room', 'accept', 'room1', '--role', 'reviewer', '--invite-file', file,
      '--expected-cid', 'ab'.repeat(32), '--replaces', '01jz6y7n8p9q0r1s2t3v4w5x70',
    ], { env: rpc.env });
    assert.equal(fromFile.code, 0, fromFile.stderr);
    assert.equal(`${fromFile.stdout}${fromFile.stderr}`.includes(secret), false);
    assert.deepEqual(rpc.requests[0].params, {
      room_id: 'room1', role: 'reviewer', invite: secret,
      expected_cid: 'ab'.repeat(32), replaces_seat: '01jz6y7n8p9q0r1s2t3v4w5x70',
    });

    const fromStdin = await runCli([
      'room', 'accept', 'room1', '--role', 'builder', '--invite-stdin',
    ], { env: rpc.env, input: secret });
    assert.equal(fromStdin.code, 0, fromStdin.stderr);
    assert.equal(`${fromStdin.stdout}${fromStdin.stderr}`.includes(secret), false);
    assert.equal(rpc.requests[1].params.invite, secret);
    assert.equal(rpc.requests[1].method, 'room.accept');
  });
});

test('room accept rejects argv secrets, source ambiguity, insecure files, and oversized stdin before RPC', async () => {
  await withRpc({ result: {} }, async (rpc) => {
    const insecure = join(rpc.env.OURS_COWORK_STATE_DIR, 'insecure-invite.txt');
    await writeFile(insecure, 'private material', { mode: 0o644 });
    for (const [args, options] of [
      [['room', 'accept', 'room1', '--role', 'r', '--invite', 'secret'], {}],
      [['room', 'accept', 'room1', '--role', 'r'], {}],
      [['room', 'accept', 'room1', '--role', 'r', '--invite-file', insecure], {}],
      [['room', 'accept', 'room1', '--role', 'r', '--invite-file', insecure, '--invite-stdin'], { input: 'x' }],
      [['room', 'accept', 'room1', '--role', 'r', '--invite-stdin'], { input: 'x'.repeat((48 * 1024) + 1) }],
    ]) {
      const result = await runCli(args, { env: rpc.env, ...options });
      assert.notEqual(result.code, 0, args.join(' '));
      assert.equal(`${result.stdout}${result.stderr}`.includes('private material'), false);
    }
    assert.equal(rpc.connections, 0);
  });
});

test('management RPC accepts one maximum file history page after base64 expansion', async () => {
  const data_base64 = Buffer.alloc(2 * 1024 * 1024, 0xa5).toString('base64');
  await withRawRpc((socket) => {
    socket.once('data', (bytes) => {
      const request = JSON.parse(bytes.toString('utf8'));
      socket.end(`${JSON.stringify({ version: 1, id: request.id, result: [{ seq: 1, data_base64 }] })}\n`);
    });
  }, async (env) => {
    const result = await rpcCall(join(env.OURS_COWORK_STATE_DIR, 'management.sock'), 'room.history', {});
    assert.equal(result[0].data_base64.length, data_base64.length);
  });
});

test('room history follows byte-short pages until the requested record limit', async () => {
  const records = [{ seq: 1, value: 'first' }, { seq: 2, value: 'second' }];
  await withRpc((request) => {
    if (request.method !== 'room.history') return { result: {} };
    const next = records.find((record) => record.seq > request.params.after);
    return { result: next ? [next] : [] };
  }, async (rpc) => {
    const result = await runCli(['room', 'history', 'room1', '--limit', '2'], { env: rpc.env });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), records);
    assert.deepEqual(rpc.requests.map((request) => request.params), [
      { room_id: 'room1', limit: 2, after: 0 },
      { room_id: 'room1', limit: 1, after: 1 },
    ]);
  });
});

test('native mutations wait for one slow response while reads stay short and timeout is an honest unknown outcome', { timeout: 20_000 }, async () => {
  assert.equal(NATIVE_RPC_TIMEOUT_MS, 120_000);
  for (const method of ['room.create', 'room.invite', 'room.accept', 'room.revoke', 'room.message', 'room.close', 'room.recover', 'room.recover.confirm']) {
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
  const sharedStateDir = join(stateDir, 'shared-ours');
  await mkdir(sharedStateDir, { mode: 0o700 });
  const token = 'ab'.repeat(32);
  await writeFile(join(sharedStateDir, 'daemon-token'), `${token}\n`, { mode: 0o600 });
  const shared = createHttpServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && request.url === '/state-dir') {
      send(200, { stateDir: sharedStateDir, version: '2.0.1', compat: 1 });
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/releaseLease'
      && request.headers['x-ours-api-token'] === token) {
      send(200, { released: [] });
      return;
    }
    send(404, { error: 'not found' });
  });
  await new Promise((ready, reject) => {
    shared.once('error', reject);
    shared.listen(0, '127.0.0.1', ready);
  });
  const address = shared.address();
  assert(address && typeof address === 'object');
  const configPath = join(stateDir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    stateDir,
    rest: { enabled: false, port: 3052 },
  }), { mode: 0o600 });
  const env = {
    OURS_COWORK_CONFIG: configPath,
    OURS_PORT: String(address.port),
    OURS_STATE_DIR: sharedStateDir,
  };
  t.after(async () => {
    const pidPath = join(stateDir, 'daemon.pid');
    try {
      const pid = Number((await readFile(pidPath, 'utf8')).trim());
      if (Number.isSafeInteger(pid)) process.kill(pid, 'SIGKILL');
    } catch { /* daemon stopped or never started */ }
    await new Promise((closed) => shared.close(closed));
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
  assert.match(result.stdout, /complete cowork state directory/i);
  assert.match(result.stdout, /uninstall.*retain/i);
  assert.match(result.stdout, /closed.*--yes/i);

  const docNames = [
    '01-prerequisites.md', '02-installation.md', '03-configuration.md',
    '04-daemon-lifecycle.md', '05-room-workflow.md', '06-invites.md',
    '07-messaging-history.md', '08-backup-restore.md',
    '09-service-management.md', '10-limitations.md', '11-web-console.md',
  ];
  const docs = await Promise.all(docNames.map((name) => readFile(join(ROOT, 'docs', name), 'utf8')));
  assert.equal(docs.length, 11);
  assert.doesNotMatch(docs.join('\n'), TOKEN_PATTERN);
  assert.doesNotMatch(docs.join('\n'), /management-token/i);

  const web = await runCli(['docs', 'web'], {
    env: { OURS_COWORK_STATE_DIR: join(tmpdir(), 'does-not-exist') },
  });
  assert.equal(web.code, 0, web.stderr);
  assert.match(web.stdout, /ours-cowork web/);
  assert.match(web.stdout, /http:\/\/127\.0\.0\.1:3052\//);
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
    // systemd's default start rate limit would turn "the thing I need is not up
    // yet" into a permanently failed unit that stops retrying entirely.
    assert.match(unit, /^\[Unit\][\s\S]*^StartLimitIntervalSec=0$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^RestartSec=5$/m);
    assert(unit.indexOf('StartLimitIntervalSec=0') < unit.indexOf('[Service]'),
      'StartLimitIntervalSec belongs to the [Unit] section');

    await writeFile(join(stateDir, 'keep-me'), 'retained');
    const uninstalled = await runCli(['uninstall-service'], { env });
    assert.equal(uninstalled.code, 0, uninstalled.stderr);
    assert.equal(await readFile(join(stateDir, 'keep-me'), 'utf8'), 'retained');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a service definition carries the standard shared-daemon selection and never a credential', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cowork-service-shared-'));
  const stateDir = join(home, 'state');
  const daemonStateDir = join(home, 'shared-ours');
  const binDir = join(home, 'bin');
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(daemonStateDir, { mode: 0o700 });
  await mkdir(binDir, { mode: 0o700 });
  for (const name of ['systemctl', 'loginctl']) {
    const path = join(binDir, name);
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(path, 0o700);
  }
  // A real daemon token beside the selected state directory must stay there.
  await writeFile(join(daemonStateDir, 'daemon-token'), `${'a1'.repeat(32)}\n`, { mode: 0o600 });
  const env = {
    HOME: home,
    PATH: `${binDir}:${process.env.PATH}`,
    OURS_COWORK_STATE_DIR: stateDir,
    OURS_PORT: '3071',
    OURS_STATE_DIR: daemonStateDir,
  };
  try {
    const installed = await runCli(['install-service'], { env });
    assert.equal(installed.code, 0, installed.stderr);
    const unit = await readFile(join(home, '.config', 'systemd', 'user', 'ours-cowork.service'), 'utf8');
    assert.match(unit, /^Environment="OURS_PORT=3071"$/m);
    assert.match(unit, new RegExp(`^Environment="OURS_STATE_DIR=${daemonStateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
    assert.doesNotMatch(unit, TOKEN_PATTERN);
    assert.doesNotMatch(unit, /management-token|Bearer|api[_-]?token/i);
    // The shared daemon may well come up after this unit; retrying forever at
    // a bounded interval is the difference between eventual success and a unit
    // that gave up during boot and never tried again.
    assert.match(unit, /^StartLimitIntervalSec=0$/m);
    assert.match(unit, /^RestartSec=5$/m);
    // The default emits no explicit shared-daemon selection at all.
    const standard = await runCli(['install-service'], {
      env: {
        ...env,
        OURS_PORT: undefined,
        OURS_STATE_DIR: undefined,
        OURS_CONFIG: undefined,
      },
    });
    assert.equal(standard.code, 0, standard.stderr);
    const plain = await readFile(join(home, '.config', 'systemd', 'user', 'ours-cowork.service'), 'utf8');
    assert.doesNotMatch(plain, /Environment="OURS_(?:CONFIG|PORT|STATE_DIR)=/);
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
