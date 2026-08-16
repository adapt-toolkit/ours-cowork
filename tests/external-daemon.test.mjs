import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { CoworkConfigSchema, daemonMode, defaultConfig, loadConfig } from '../src/config.ts';
import { createOursHost, EmbeddedOursHost, ExternalOursHost } from '../src/ours-runtime.ts';
import { PacketRegistry } from '../src/packets.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const IDENTITY = `ours-cowork-${ROOM_ID}`;
const CID = 'AB'.repeat(32);
// Every OURS_* input the SDK's own resolver reads. A cowork worker inherits the
// operator's shell, so these tests pin them instead of trusting the runner.
const SDK_ENVIRONMENT = [
  'OURS_CONFIG', 'OURS_STATE_DIR', 'OURS_PORT', 'OURS_API_TOKEN', 'OURS_INSTANCE',
  'OURS_BROKER_URL', 'OURS_API_VISIBILITY', 'OURS_TRANSPORT', 'OURS_AUTOSTART',
];

function pinSdkEnvironment(t) {
  const saved = SDK_ENVIRONMENT.map((name) => [name, process.env[name]]);
  for (const name of SDK_ENVIRONMENT) delete process.env[name];
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/**
 * A stand-in for an already-running ours daemon: only the routes SDK 1.3.1's
 * client actually uses, with the same token header and the same long-poll
 * notification contract.
 */
async function startFakeDaemon(t, options = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'cowork-fake-daemon-'));
  const reportedStateDir = options.reportedStateDir ?? stateDir;
  const token = options.token ?? 'fake-daemon-token';
  if (options.writeToken !== false) {
    writeFileSync(join(stateDir, 'daemon-token'), `${token}\n`, { mode: 0o600 });
  }
  const requests = [];
  const waiting = new Set();
  const events = [];

  function flush() {
    for (const held of [...waiting]) {
      if (events.length <= held.since) continue;
      waiting.delete(held);
      held.send({ cursor: events.length, events: events.slice(held.since) });
    }
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const offered = request.headers['x-ours-api-token'];
    requests.push({ method: request.method, path: url.pathname, token: offered ?? null });
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const authorized = () => {
      if (offered === token) return true;
      send(401, { error: 'unauthorized' });
      return false;
    };
    if (request.method === 'GET' && url.pathname === '/state-dir') {
      send(200, { stateDir: reportedStateDir, version: '1.3.1', compat: 1 });
      return;
    }
    if (request.method === 'GET' && (url.pathname === '/version' || url.pathname === '/info')) {
      send(200, {
        name: 'ours', version: '1.3.1', compat: 1, protocol: 1,
        pid: process.pid, stateDir: reportedStateDir,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/identities') {
      if (!authorized()) return;
      send(200, { identities: [{ name: IDENTITY }] });
      return;
    }
    const notifications = /^\/identities\/([^/]+)\/notifications$/.exec(url.pathname);
    if (request.method === 'GET' && notifications) {
      if (!authorized()) return;
      const raw = url.searchParams.get('since');
      const since = raw === null || raw === 'tip' ? events.length : Number(raw);
      const held = { since, send: (body) => send(200, body) };
      waiting.add(held);
      request.once('aborted', () => waiting.delete(held));
      response.once('close', () => waiting.delete(held));
      flush();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/releaseLease') {
      if (!authorized()) return;
      send(200, { released: [] });
      return;
    }
    send(404, { error: `no route for ${url.pathname}` });
  });

  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const { port } = server.address();
  t.after(async () => {
    for (const held of [...waiting]) held.send({ cursor: events.length, events: [] });
    waiting.clear();
    await new Promise((closed) => server.close(closed));
    if (options.stateDir === undefined) rmSync(stateDir, { recursive: true, force: true });
  });
  return {
    port,
    token,
    stateDir,
    requests,
    endpoint: `http://127.0.0.1:${port}`,
    emit(event) { events.push(event); flush(); },
    get watching() { return waiting.size; },
  };
}

function externalConfig(stateDir, endpoint, daemonStateDir) {
  return {
    version: 1,
    brokerUrl: 'ws://127.0.0.1:1',
    stateDir,
    rest: { enabled: false, port: 3052 },
    daemon: { mode: 'external', endpoint, stateDir: daemonStateDir },
  };
}

test('an unconfigured deployment keeps the exact embedded effective config', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-daemon-default-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    version: 1, brokerUrl: 'ws://file', stateDir: join(dir, 'state'), rest: { enabled: true, port: 3052 },
  }), { mode: 0o600 });

  const config = loadConfig({ OURS_COWORK_CONFIG: path });

  assert.deepEqual(config, {
    version: 1, brokerUrl: 'ws://file', stateDir: join(dir, 'state'), rest: { enabled: true, port: 3052 },
  });
  assert.equal('daemon' in config, false);
  assert.equal(daemonMode(config), 'embedded');
  assert.equal('daemon' in defaultConfig('/home/demo'), false);
  assert.equal(daemonMode(defaultConfig('/home/demo')), 'embedded');
});

test('the external selection needs both fields, normalizes them, and rejects unusable endpoints', () => {
  const parsed = CoworkConfigSchema.parse({
    ...defaultConfig('/home/demo'),
    daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050/', stateDir: '/home/demo/.ours/../.ours' },
  });
  assert.deepEqual(parsed.daemon, {
    mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: '/home/demo/.ours',
  });
  // The common daemon's own default address resolves without any network I/O.
  assert.equal(daemonMode(parsed), 'external');

  const dedicated = CoworkConfigSchema.parse({
    ...defaultConfig('/home/demo'),
    daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3071', stateDir: '/srv/rooms/.ours' },
  });
  assert.deepEqual(dedicated.daemon, {
    mode: 'external', endpoint: 'http://127.0.0.1:3071', stateDir: '/srv/rooms/.ours',
  });

  for (const daemon of [
    { mode: 'external' },
    { mode: 'external', endpoint: 'http://127.0.0.1:3050' },
    { mode: 'external', stateDir: '/home/demo/.ours' },
    { mode: 'embedded', endpoint: 'http://127.0.0.1:3050' },
    { mode: 'embedded', stateDir: '/home/demo/.ours' },
    { mode: 'elsewhere', endpoint: 'http://127.0.0.1:3050', stateDir: '/home/demo/.ours' },
    { mode: 'external', endpoint: 'ws://127.0.0.1:3050', stateDir: '/home/demo/.ours' },
    { mode: 'external', endpoint: 'http://127.0.0.1:3050/rooms', stateDir: '/home/demo/.ours' },
    { mode: 'external', endpoint: 'http://127.0.0.1:3050?a=1', stateDir: '/home/demo/.ours' },
    { mode: 'external', endpoint: 'http://user:pass@127.0.0.1:3050', stateDir: '/home/demo/.ours' },
    { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: '/home/demo/.ours', extra: true },
  ]) {
    assert.throws(
      () => CoworkConfigSchema.parse({ ...defaultConfig('/home/demo'), daemon }),
      JSON.stringify(daemon),
    );
  }
  assert.equal(CoworkConfigSchema.parse({ ...defaultConfig('/home/demo'), daemon: { mode: 'embedded' } }).daemon.mode, 'embedded');
});

test('daemon environment overrides select, merge, and fail closed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-daemon-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const base = { version: 1, brokerUrl: 'ws://file', stateDir: join(dir, 'state'), rest: { enabled: true, port: 3052 } };
  writeFileSync(path, JSON.stringify(base), { mode: 0o600 });

  assert.deepEqual(loadConfig({
    OURS_COWORK_CONFIG: path,
    OURS_COWORK_DAEMON_ENDPOINT: 'http://127.0.0.1:3071/',
    OURS_COWORK_DAEMON_STATE_DIR: join(dir, 'dedicated'),
  }).daemon, { mode: 'external', endpoint: 'http://127.0.0.1:3071', stateDir: join(dir, 'dedicated') });

  writeFileSync(path, JSON.stringify({
    ...base,
    daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3050', stateDir: join(dir, 'common') },
  }), { mode: 0o600 });
  assert.deepEqual(loadConfig({
    OURS_COWORK_CONFIG: path, OURS_COWORK_DAEMON_ENDPOINT: 'http://127.0.0.1:3071',
  }).daemon, { mode: 'external', endpoint: 'http://127.0.0.1:3071', stateDir: join(dir, 'common') });
  assert.deepEqual(loadConfig({ OURS_COWORK_CONFIG: path, OURS_COWORK_DAEMON_MODE: 'embedded' }).daemon, { mode: 'embedded' });

  assert.throws(
    () => loadConfig({ OURS_COWORK_CONFIG: path, OURS_COWORK_DAEMON_MODE: 'sidecar' }),
    /OURS_COWORK_DAEMON_MODE/,
  );
  assert.throws(
    () => loadConfig({
      OURS_COWORK_CONFIG: path,
      OURS_COWORK_DAEMON_MODE: 'embedded',
      OURS_COWORK_DAEMON_ENDPOINT: 'http://127.0.0.1:3071',
    }),
    /require daemon mode "external"/,
  );
  writeFileSync(path, JSON.stringify(base), { mode: 0o600 });
  assert.throws(
    () => loadConfig({ OURS_COWORK_CONFIG: path, OURS_COWORK_DAEMON_ENDPOINT: 'http://127.0.0.1:3071' }),
    (error) => /invalid effective cowork config/.test(error.message)
      && /daemon\.stateDir is required/.test(String(error.cause)),
  );
});

test('the host factory follows the configured mode and refuses an incomplete external selection', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-host-factory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const embedded = { ...defaultConfig('/home/demo'), stateDir: dir };

  assert(createOursHost(embedded) instanceof EmbeddedOursHost);
  assert(createOursHost({ ...embedded, daemon: { mode: 'embedded' } }) instanceof EmbeddedOursHost);
  assert(createOursHost(externalConfig(dir, 'http://127.0.0.1:3071', join(dir, 'ours'))) instanceof ExternalOursHost);
  assert.throws(
    () => new ExternalOursHost({ ...embedded, daemon: { mode: 'external', endpoint: 'http://127.0.0.1:3071' } }),
    /daemon\.endpoint and daemon\.stateDir/,
  );
});

test('external boot proves the daemon, then reaches it with that daemon own token', async (t) => {
  pinSdkEnvironment(t);
  const coworkStateDir = mkdtempSync(join(tmpdir(), 'cowork-external-boot-'));
  t.after(() => rmSync(coworkStateDir, { recursive: true, force: true }));
  const daemon = await startFakeDaemon(t);
  const host = new ExternalOursHost(
    CoworkConfigSchema.parse(externalConfig(coworkStateDir, daemon.endpoint, daemon.stateDir)),
  );

  await host.boot();
  const identities = await host.createClient('external-boot-contract').identities();

  assert.deepEqual(identities, [{ name: IDENTITY }]);
  assert.deepEqual(daemon.requests[0], { method: 'GET', path: '/state-dir', token: null });
  assert(daemon.requests.some((entry) => entry.path === '/identities' && entry.token === daemon.token));
  assert.deepEqual(await host.shutdown(), { requiresProcessExit: false });
});

test('a dedicated daemon on its own port and state directory is addressed independently', async (t) => {
  pinSdkEnvironment(t);
  const coworkStateDir = mkdtempSync(join(tmpdir(), 'cowork-external-dedicated-'));
  t.after(() => rmSync(coworkStateDir, { recursive: true, force: true }));
  const common = await startFakeDaemon(t, { token: 'common-daemon-token' });
  const dedicated = await startFakeDaemon(t, { token: 'dedicated-daemon-token' });
  assert.notEqual(common.port, dedicated.port);
  assert.notEqual(common.stateDir, dedicated.stateDir);

  for (const target of [common, dedicated]) {
    const host = new ExternalOursHost(
      CoworkConfigSchema.parse(externalConfig(coworkStateDir, target.endpoint, target.stateDir)),
    );
    await host.boot();
    assert.deepEqual(await host.createClient('dedicated-contract').identities(), [{ name: IDENTITY }]);
    await host.shutdown();
  }

  // Each selection read only its own daemon's token file.
  assert.deepEqual(
    [...new Set(common.requests.map((entry) => entry.token).filter(Boolean))], [common.token],
  );
  assert.deepEqual(
    [...new Set(dedicated.requests.map((entry) => entry.token).filter(Boolean))], [dedicated.token],
  );
});

test('an unavailable or mismatched daemon fails boot without offering a credential', async (t) => {
  pinSdkEnvironment(t);
  const coworkStateDir = mkdtempSync(join(tmpdir(), 'cowork-external-refuse-'));
  t.after(() => rmSync(coworkStateDir, { recursive: true, force: true }));

  const impostor = await startFakeDaemon(t, { reportedStateDir: join(tmpdir(), 'someone-elses-ours') });
  const mismatched = new ExternalOursHost(
    CoworkConfigSchema.parse(externalConfig(coworkStateDir, impostor.endpoint, impostor.stateDir)),
  );
  await assert.rejects(mismatched.boot(), (error) =>
    /is unavailable or does not own/.test(error.message) && /INCOHERENT_SELECTION/.test(String(error.cause?.code)));
  assert.deepEqual(impostor.requests.map((entry) => entry.token), [null]);
  assert.throws(() => mismatched.createClient(), /not booted/);

  const offline = await startFakeDaemon(t, { token: 'unused-token' });
  const closedEndpoint = offline.endpoint;
  const closedStateDir = offline.stateDir;
  await new Promise((closed) => { const probe = createServer(); probe.close(closed); });
  const unavailable = new ExternalOursHost(
    CoworkConfigSchema.parse(externalConfig(coworkStateDir, 'http://127.0.0.1:1', closedStateDir)),
  );
  await assert.rejects(unavailable.boot(), (error) =>
    error.message.includes('http://127.0.0.1:1') && /unavailable or does not own/.test(error.message));
  assert.notEqual(closedEndpoint, 'http://127.0.0.1:1');
});

test('a tracked identity long-polls the external daemon and stops when it is untracked', async (t) => {
  pinSdkEnvironment(t);
  const coworkStateDir = mkdtempSync(join(tmpdir(), 'cowork-external-watch-'));
  t.after(() => rmSync(coworkStateDir, { recursive: true, force: true }));
  const daemon = await startFakeDaemon(t);
  const host = new ExternalOursHost(
    CoworkConfigSchema.parse(externalConfig(coworkStateDir, daemon.endpoint, daemon.stateDir)),
  );
  await host.boot();
  t.after(() => host.shutdown());

  const seen = [];
  host.onIdentityNotify((name) => seen.push(name));
  const untrack = host.trackIdentity(IDENTITY);
  await waitFor(() => daemon.watching === 1, 'the notification long poll to be held open');

  daemon.emit({ event: 'message_received', sender_id: CID, sender_name: 'Peer', from: 'Peer', msg_id: '1', wire_id: 'w1', date: '2026-08-16T00:00:00Z' });
  await waitFor(() => seen.length === 1, 'the identity notification to reach the listener');
  assert.deepEqual(seen, [IDENTITY]);

  untrack();
  await waitFor(() => daemon.watching === 0, 'the notification long poll to be released');
  daemon.emit({ event: 'message_received', sender_id: CID, sender_name: 'Peer', from: 'Peer', msg_id: '2', wire_id: 'w2', date: '2026-08-16T00:00:01Z' });
  await new Promise((tick) => setTimeout(tick, 200));
  assert.deepEqual(seen, [IDENTITY]);
});

test('the packet registry tracks every hosted identity and releases each watch', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-external-registry-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const tracked = [];
  const untracked = [];
  const client = {
    async chooseIdentity() { return { name: IDENTITY, cid: CID, switchedFrom: null }; },
    async listContacts() { return { contacts: [] }; },
    async listInvites() { return []; },
    async listIncomingMessages() { return []; },
    async listIncomingFiles() { return []; },
    async removeIdentity() {},
    async releaseLease() { return { released: [IDENTITY] }; },
  };
  const host = {
    createClient() { return client; },
    onIdentityNotify() { return () => {}; },
    trackIdentity(name) {
      tracked.push(name);
      return () => untracked.push(name);
    },
  };
  const registry = new PacketRegistry(host, stateDir);

  await registry.restore(ROOM_ID, CID, IDENTITY);
  assert.deepEqual(tracked, [IDENTITY]);
  assert.deepEqual(untracked, []);
  await registry.destroy(ROOM_ID);
  assert.deepEqual(untracked, [IDENTITY]);

  await registry.restore(ROOM_ID, CID, IDENTITY);
  await registry.unhostAll();
  assert.deepEqual(tracked, [IDENTITY, IDENTITY]);
  assert.deepEqual(untracked, [IDENTITY, IDENTITY]);
});

test('an external host starts no runtime: no listener, no owned state, no SDK environment', async (t) => {
  pinSdkEnvironment(t);
  const coworkStateDir = mkdtempSync(join(tmpdir(), 'cowork-external-inert-'));
  t.after(() => rmSync(coworkStateDir, { recursive: true, force: true }));
  const daemon = await startFakeDaemon(t);
  const moduleUrl = new URL('../src/ours-runtime.ts', import.meta.url).href;
  const script = `
    const { createOursHost, sdkRuntimeStateDir } = await import(${JSON.stringify(moduleUrl)});
    const { existsSync } = await import('node:fs');
    const config = {
      version: 1,
      brokerUrl: 'ws://127.0.0.1:1',
      stateDir: ${JSON.stringify(coworkStateDir)},
      rest: { enabled: false, port: 3052 },
      daemon: {
        mode: 'external',
        endpoint: ${JSON.stringify(daemon.endpoint)},
        stateDir: ${JSON.stringify(daemon.stateDir)},
      },
    };
    const host = createOursHost(config);
    await host.boot();
    const identities = await host.createClient('inert-contract').identities();
    const listeners = process.getActiveResourcesInfo().filter((name) => /SERVER/i.test(name));
    const environment = ${JSON.stringify(SDK_ENVIRONMENT)}.filter((name) => process.env[name] !== undefined);
    const owned = existsSync(sdkRuntimeStateDir(config));
    const stopped = await host.shutdown();
    console.log('COWORK_EXTERNAL_RESULT ' + JSON.stringify({ identities, listeners, environment, owned, stopped }));
    process.exit(0);
  `;
  const environment = { ...process.env };
  for (const name of SDK_ENVIRONMENT) delete environment[name];
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  let timer;
  const exited = await Promise.race([
    new Promise((done) => child.once('exit', (code, signal) => done({ code, signal }))),
    new Promise((done) => { timer = setTimeout(() => done('timeout'), 20_000); }),
  ]);
  clearTimeout(timer);
  if (exited === 'timeout') child.kill('SIGKILL');
  assert.notEqual(exited, 'timeout', stderr);
  assert.deepEqual(exited, { code: 0, signal: null }, stderr);
  const marker = stdout.split('\n').find((line) => line.startsWith('COWORK_EXTERNAL_RESULT '));
  assert(marker, `${stdout}\n${stderr}`);
  const result = JSON.parse(marker.slice('COWORK_EXTERNAL_RESULT '.length));

  assert.deepEqual(result.identities, [{ name: IDENTITY }]);
  // The embedded host would have bound a port and written every one of these.
  assert.deepEqual(result.listeners, []);
  assert.deepEqual(result.environment, []);
  assert.equal(result.owned, false);
  assert.deepEqual(result.stopped, { requiresProcessExit: false });
  assert.equal(resolve(coworkStateDir), coworkStateDir);
});

async function waitFor(check, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((tick) => setTimeout(tick, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}
