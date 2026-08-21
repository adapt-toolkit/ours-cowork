import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig, loadConfig } from '../src/config.ts';
import { createOursHost, SharedOursHost } from '../src/ours-runtime.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const IDENTITY = `ours-cowork-${ROOM_ID}`;
const CID = 'AB'.repeat(32);
const SDK_ENVIRONMENT = [
  'OURS_CONFIG', 'OURS_STATE_DIR', 'OURS_PORT', 'OURS_API_TOKEN', 'OURS_INSTANCE',
  'OURS_BROKER_URL', 'OURS_API_VISIBILITY',
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

async function startFakeDaemon(t, options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-shared-daemon-'));
  const reportedStateDir = options.reportedStateDir ?? stateDir;
  const token = 'shared-daemon-token';
  writeFileSync(join(stateDir, 'daemon-token'), `${token}\n`, { mode: 0o600 });
  const requests = [];
  const polls = [];
  const waiting = new Set();
  const events = [];
  const identityRows = options.identityRows ?? [
    { name: IDENTITY },
    { name: 'Human@laptop' },
    { name: 'another-app' },
  ];

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
      send(200, { stateDir: reportedStateDir, version: '2.0.1', compat: 1 });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/identities') {
      if (!authorized()) return;
      send(200, { identities: identityRows });
      return;
    }
    const notifications = /^\/identities\/([^/]+)\/notifications$/.exec(url.pathname);
    if (request.method === 'GET' && notifications) {
      if (!authorized()) return;
      const raw = url.searchParams.get('since');
      polls.push(raw);
      const since = raw === null || raw === 'tip' ? events.length : Number(raw);
      const held = { since, send: (body) => send(200, body), response };
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
    rmSync(stateDir, { recursive: true, force: true });
  });
  return {
    port,
    token,
    stateDir,
    requests,
    polls,
    emit(event) { events.push(event); flush(); },
    dropWatchers() {
      for (const held of [...waiting]) {
        waiting.delete(held);
        held.response.destroy();
      }
    },
    get watching() { return waiting.size; },
  };
}

function selectDaemon(daemon) {
  process.env.OURS_PORT = String(daemon.port);
  process.env.OURS_STATE_DIR = daemon.stateDir;
}

test('cowork configuration is app-local and removed daemon/broker keys fail with migration guidance', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-config-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cleanPath = join(dir, 'clean.json');
  writeFileSync(cleanPath, JSON.stringify({
    version: 1,
    stateDir: join(dir, 'cowork'),
    rest: { enabled: true, port: 3052 },
  }), { mode: 0o600 });
  assert.deepEqual(loadConfig({ OURS_COWORK_CONFIG: cleanPath }), {
    version: 1,
    stateDir: join(dir, 'cowork'),
    rest: { enabled: true, port: 3052 },
  });

  for (const removed of [
    { brokerUrl: 'wss://broker1.ours.network' },
    { daemon: { mode: 'embedded' } },
  ]) {
    const path = join(dir, `removed-${Object.keys(removed)[0]}.json`);
    writeFileSync(path, JSON.stringify({
      version: 1,
      stateDir: join(dir, 'cowork'),
      rest: { enabled: true, port: 3052 },
      ...removed,
    }), { mode: 0o600 });
    assert.throws(
      () => loadConfig({ OURS_COWORK_CONFIG: path }),
      /removed.*shared ours daemon.*@ours\.network\/cli/i,
    );
  }
  for (const name of [
    'OURS_COWORK_BROKER_URL',
    'OURS_COWORK_DAEMON_MODE',
    'OURS_COWORK_DAEMON_ENDPOINT',
    'OURS_COWORK_DAEMON_STATE_DIR',
  ]) {
    assert.throws(
      () => loadConfig({ [name]: 'obsolete' }),
      new RegExp(`${name}.*removed.*OURS_CONFIG`, 'i'),
    );
  }
  assert.equal('brokerUrl' in defaultConfig('/home/demo'), false);
  assert.equal('daemon' in defaultConfig('/home/demo'), false);
});

test('the host factory has exactly one shared-daemon mode', () => {
  assert(createOursHost(defaultConfig('/home/demo')) instanceof SharedOursHost);
});

test('shared boot proves the state root before credentials and filters global identities locally', async (t) => {
  pinSdkEnvironment(t);
  const daemon = await startFakeDaemon(t);
  selectDaemon(daemon);
  const host = new SharedOursHost();

  await host.boot();
  assert.deepEqual(
    await host.listIdentityNames(new Set([IDENTITY, 'not-present'])),
    new Set([IDENTITY]),
  );
  assert.deepEqual(daemon.requests[0], { method: 'GET', path: '/state-dir', token: null });
  assert(daemon.requests.some((entry) => entry.path === '/identities' && entry.token === daemon.token));
  assert.deepEqual(await host.shutdown(), { requiresProcessExit: false });
});

test('a mismatched shared daemon fails before cowork offers its credential', async (t) => {
  pinSdkEnvironment(t);
  const daemon = await startFakeDaemon(t, { reportedStateDir: join(tmpdir(), 'wrong-ours-state') });
  selectDaemon(daemon);
  const host = new SharedOursHost();

  await assert.rejects(host.boot(), /owns state directory|selection expects/);
  assert.deepEqual(daemon.requests.map((entry) => entry.token), [null]);
  await assert.rejects(host.createClient(), /not booted/);
});

test('shared notification watch forwards events and releases without stopping the daemon', async (t) => {
  pinSdkEnvironment(t);
  const daemon = await startFakeDaemon(t);
  selectDaemon(daemon);
  const host = new SharedOursHost();
  await host.boot();
  const seen = [];
  host.onIdentityNotify((name) => seen.push(name));
  const untrack = host.trackIdentity(IDENTITY);
  await waitFor(() => daemon.watching === 1, 'notification watch');
  await waitFor(() => seen.length >= 1, 'initial state resync');
  const afterInitial = seen.length;
  await waitFor(() => seen.length > afterInitial, 'periodic state resync for unlogged contact transitions');
  const beforeEvent = seen.length;

  daemon.emit({
    event: 'message_received', sender_id: CID, sender_name: 'Peer', from: 'Peer',
    msg_id: '1', wire_id: 'wire-1', date: '2026-08-21T00:00:00Z',
  });
  await waitFor(() => seen.length > beforeEvent, 'notification callback');
  assert(seen.every((name) => name === IDENTITY));

  untrack();
  await waitFor(() => daemon.watching === 0, 'watch release');
  assert.deepEqual(await host.shutdown(), { requiresProcessExit: false });
  assert(daemon.requests.some((entry) => entry.path === '/api/v1/releaseLease'));
});

async function waitFor(check, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((tick) => setTimeout(tick, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}
