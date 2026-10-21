import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoworkDaemon } from '../src/daemon-runtime.ts';

test('actual runtime composes authenticated room routes without local daemon control', async t => {
  const instance = '11111111-2222-3333-4444-555555555555';
  let revoked = false;
  const authority = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/selection') return res.end(JSON.stringify({ schema: 1, instanceId: instance, capabilities: ['external-sessions-v1'] }));
    if (req.url === '/identities' && !revoked && req.headers['x-ours-api-token'] === 'fixture-issued') return res.end('{"identities":[]}');
    res.writeHead(401); res.end('{}');
  });
  await new Promise(resolve => authority.listen(0, '127.0.0.1', resolve));
  t.after(() => { authority.closeAllConnections(); authority.close(); });
  const env = { OURS_COWORK_HTTP_MANAGEMENT: '1', OURS_COWORK_PUBLIC_ORIGIN: 'https://gateway.example', OURS_DAEMON_URL: `http://127.0.0.1:${authority.address().port}`, OURS_DAEMON_ID: instance };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const dir = mkdtempSync(join(tmpdir(), 'cowork-http-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let accepted = 0, stopped = 0;
  const daemon = new CoworkDaemon({
    config: { version: 1, stateDir: dir, rest: { enabled: true, host: '127.0.0.1', port: 0 } },
    prepare: () => ({ socketPath: join(dir, 'management.sock') }),
    lock: () => ({ release() {} }),
    host: { async boot() {}, async close() {} },
    store: { async list() { return []; } },
    registry: { async unhostAll() {} },
    service: { async listRooms() { return []; }, async acceptExternalInvite() { accepted++; return { accepted: true }; }, beginShutdown() {}, async drain() {} },
    control: { session: 'ab'.repeat(16), async requestSupervisorShutdown() { stopped++; return true; } },
    writePid() {}, removePid() {},
  });
  t.after(() => daemon.shutdown());
  await daemon.boot();
  const base = `http://127.0.0.1:${daemon.transports.restAddress.port}`;
  async function call(method, { token = 'fixture-issued', path = '/management/rpc', headers = {}, params = {} } = {}) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ours-api-token': token, ...headers }, body: JSON.stringify({ version: 1, id: 'runtime', method, params }) });
    return { status: response.status, body: await response.json() };
  }
  assert.deepEqual((await call('room.list')).body.result, []);
  assert.equal((await call('room.accept', { params: { room_id: 'fixture', role: 'Developer', invite: 'fixture' } })).body.result.accepted, true);
  assert.equal(accepted, 1);
  for (const method of ['daemon.status', 'daemon.shutdown', 'unknown.method']) assert.equal((await call(method)).body.error.code, 'method_not_found');
  assert.equal(stopped, 0);
  assert.equal((await call('room.list', { token: 'invalid' })).status, 401);
  assert.equal((await call('room.list', { headers: { origin: base } })).status, 403);
  assert.equal((await call('room.list', { path: '/browser/rpc', headers: { origin: 'https://gateway.example', 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await call('room.list', { path: '/browser/rpc', headers: { origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await call('room.list', { path: '/browser/rpc', headers: { origin: base } })).status, 403, 'internal HTTP origin cannot replace configured external HTTPS origin');
  assert.equal((await call('room.accept', { path: '/browser/rpc' })).body.error.code, 'method_not_found');
  assert.equal((await fetch(base + '/browser/rpc', { method: 'OPTIONS' })).status, 404);
  revoked = true;
  assert.equal((await call('room.list')).status, 401);
  authority.closeAllConnections(); await new Promise(resolve => authority.close(resolve));
  assert.equal((await call('room.list')).status, 401);
});
