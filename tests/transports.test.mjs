import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createPrivateServiceRoutes,
  createServiceRoutes,
  MAX_REQUEST_BYTES,
  RpcDispatcher,
  TransportServer,
} from '../src/transports.ts';

function request(port, {
  body = '', chunks, headers = { 'content-type': 'application/json' }, method = 'POST', path = '/rpc', host,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method, headers: { ...headers, ...(host === undefined ? {} : { host }) },
    }, (res) => {
      const data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(data).toString('utf8');
        let json;
        try { json = JSON.parse(responseBody); } catch {}
        resolve({ status: res.statusCode, statusCode: res.statusCode, headers: res.headers, body: responseBody, json });
      });
    });
    req.on('error', reject);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    else if (method !== 'GET') req.write(body);
    req.end();
  });
}

function unixRequest(path, value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(value));
    socket.on('data', (chunk) => { data += chunk; if (data.includes('\n')) socket.end(); });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

function dispatchers(dispatcher) {
  return { unixDispatcher: dispatcher, restDispatcher: dispatcher };
}

function nullDispatchers() {
  return dispatchers(new RpcDispatcher({ ping: { auth: true, run: async () => null } }));
}

test('dispatcher strictly validates the versioned envelope and shares one route table', async () => {
  const calls = [];
  const dispatcher = new RpcDispatcher({
    'room.echo': { auth: true, run: async (params) => { calls.push(params); return params; } },
  });
  const valid = await dispatcher.dispatch({ version: 1, id: 'x', method: 'room.echo', params: { ok: true } });
  assert.deepEqual(valid, { version: 1, id: 'x', result: { ok: true } });
  for (const malformed of [
    null,
    { version: 2, id: 'x', method: 'room.echo', params: {} },
    { version: 1, method: 'room.echo', params: {} },
    { version: 1, id: 'x', method: '', params: {} },
    { version: 1, id: 'x', method: 'room.echo', params: null },
    { version: 1, id: 'x', method: 'room.echo', params: {}, extra: true },
  ]) {
    const response = await dispatcher.dispatch(malformed);
    assert.equal(response.error.code, 'invalid_request');
  }
  const missing = await dispatcher.dispatch({ version: 1, id: 1, method: 'missing', params: {} });
  assert.equal(missing.error.code, 'method_not_found');
  assert.equal(calls.length, 1);
  for (const method of ['toString', 'constructor', '__proto__']) {
    const response = await dispatcher.dispatch({ version: 1, id: method, method, params: {} });
    assert.equal(response.error.code, 'method_not_found');
    assert.equal(response.error.message, 'method not found');
  }
});

test('the exhaustive service route table marks every route auth:true', () => {
  const service = new Proxy({}, { get: () => async () => null });
  const routes = createServiceRoutes(service);
  assert.deepEqual(Object.keys(routes).sort(), [
    'room.briefing.role.delete', 'room.briefing.role.set',
    'room.close', 'room.create', 'room.delete', 'room.history', 'room.invite', 'room.list',
    'room.message', 'room.participant.remove', 'room.participant.replace', 'room.participants',
    'room.recover', 'room.recover.confirm', 'room.revoke',
    'room.role.rest.add', 'room.role.rest.remove', 'room.say',
    'room.settings', 'room.show',
  ]);
  assert(Object.values(routes).every((route) => route.auth === true));
  const privateRoutes = createPrivateServiceRoutes(service);
  assert.deepEqual(Object.keys(privateRoutes), ['room.accept']);
  assert(Object.values(privateRoutes).every((route) => route.auth === true));
});

test('external invite acceptance has strict params and is excluded from the ordinary route table', async () => {
  const calls = [];
  const service = new Proxy({}, {
    get: (_target, method) => async (...args) => { calls.push([method, ...args]); return { state: 'pending' }; },
  });
  const ordinary = new RpcDispatcher(createServiceRoutes(service));
  const privateDispatcher = new RpcDispatcher(createPrivateServiceRoutes(service));
  const envelope = {
    version: 1, id: 'accept', method: 'room.accept',
    params: { room_id: 'r1', role: 'reviewer', invite: 'secret', expected_cid: 'AB'.repeat(32) },
  };
  assert.equal((await ordinary.dispatch(envelope)).error.code, 'method_not_found');
  assert.deepEqual(await privateDispatcher.dispatch(envelope), {
    version: 1, id: 'accept', result: { state: 'pending' },
  });
  assert.deepEqual(calls, [[
    'acceptExternalInvite', 'r1',
    { role: 'reviewer', invite: 'secret', expected_cid: 'AB'.repeat(32) },
  ]]);
  assert.equal((await privateDispatcher.dispatch({
    ...envelope, params: { ...envelope.params, extra: true },
  })).error.code, 'invalid_params');
});

test('room membership and briefing verbs are reachable over authenticated RPC with strict params', async () => {
  const calls = [];
  const service = new Proxy({}, {
    get: (_target, method) => async (...args) => { calls.push([method, ...args]); return { ok: true }; },
  });
  const dispatcher = new RpcDispatcher(createServiceRoutes(service));
  const send = (method, params) => dispatcher.dispatch({ version: 1, id: 'x', method, params });

  assert.deepEqual(
    await send('room.briefing.role.set', { room_id: 'r1', role: 'reviewer', text: 'Review.' }),
    { version: 1, id: 'x', result: { ok: true } },
  );
  assert.deepEqual(calls.at(-1), ['setRoleBriefing', 'r1', { role: 'reviewer', text: 'Review.' }]);

  await send('room.briefing.role.delete', { room_id: 'r1', role: 'reviewer' });
  assert.deepEqual(calls.at(-1), ['deleteRoleBriefing', 'r1', { role: 'reviewer' }]);

  await send('room.participant.remove', { room_id: 'r1', participant: 'cid-a', notify: false });
  assert.deepEqual(calls.at(-1), ['removeParticipant', 'r1', { participant: 'cid-a', notify: false }]);

  await send('room.participant.replace', { room_id: 'r1', participant: 'cid-a', mode: 'public', min_accepts: 2 });
  assert.deepEqual(calls.at(-1), ['replaceParticipant', 'r1', { participant: 'cid-a', mode: 'public', min_accepts: 2 }]);

  // configurability rides existing verbs: create flags, settings toggle, history view
  await send('room.create', { name: 'Launch room', goal: 'g', briefing: 'b', anonymous: true, quiet_membership: true });
  assert.deepEqual(calls.at(-1), ['createRoom', { name: 'Launch room', goal: 'g', briefing: 'b', anonymous: true, quiet_membership: true }]);

  await send('room.settings', { room_id: 'r1', name: 'Renamed room', quiet_membership: true });
  assert.deepEqual(calls.at(-1), ['updateRoom', 'r1', { name: 'Renamed room', quiet_membership: true }]);

  await send('room.history', { room_id: 'r1', view: 'participant' });
  assert.deepEqual(calls.at(-1), ['history', 'r1', { view: 'participant' }]);

  // an invite without a role reaches the service role-less (default Participant)
  await send('room.invite', { room_id: 'r1', mode: 'one_time', min_accepts: 1 });
  assert.deepEqual(calls.at(-1), ['createInvite', 'r1', { mode: 'one_time', min_accepts: 1 }]);

  // strictness: unknown keys never reach the service
  for (const [method, params] of [
    ['room.briefing.role.set', { room_id: 'r1', role: 'x', text: 't', extra: true }],
    ['room.participant.remove', { room_id: 'r1', participant: 'cid-a', alias: 'spoof' }],
    ['room.participant.replace', { room_id: 'r1', participant: 'cid-a', replaces_seat: 'spoof' }],
  ]) {
    const before = calls.length;
    const response = await send(method, params);
    assert.equal(response.error.code, 'invalid_params', method);
    assert.equal(calls.length, before);
  }
});

test('role-authorship verbs are reachable over REST with strict params and no new status codes', async () => {
  const calls = [];
  const service = new Proxy({}, {
    get: (_target, method) => async (...args) => { calls.push([method, ...args]); return { ok: true }; },
  });
  const dispatcher = new RpcDispatcher(createServiceRoutes(service));
  const send = (method, params) => dispatcher.dispatch({ version: 1, id: 'x', method, params });

  await send('room.say', { room_id: 'r1', role: 'Reviewer', text: 'Reviewed.' });
  assert.deepEqual(calls.at(-1), ['postAsRole', 'r1', { role: 'Reviewer', text: 'Reviewed.' }]);

  await send('room.role.rest.add', { room_id: 'r1', role: 'Reviewer' });
  assert.deepEqual(calls.at(-1), ['addRestRole', 'r1', { role: 'Reviewer' }]);

  await send('room.role.rest.remove', { room_id: 'r1', role: 'Reviewer' });
  assert.deepEqual(calls.at(-1), ['removeRestRole', 'r1', { role: 'Reviewer' }]);

  // No author-like field of any spelling reaches the service: role is the only
  // caller-controlled authorship input the transport will carry.
  for (const [method, params] of [
    ['room.say', { room_id: 'r1', role: 'Reviewer', text: 't', identity: 'cid-forged' }],
    ['room.say', { room_id: 'r1', role: 'Reviewer', text: 't', display_name: 'Alice' }],
    ['room.say', { room_id: 'r1', role: 'Reviewer', text: 't', author_alias: 'builder #1' }],
    ['room.role.rest.add', { room_id: 'r1', role: 'Reviewer', expires_at: 'never' }],
    ['room.role.rest.remove', { room_id: 'r1', role: 'Reviewer', tombstone: true }],
  ]) {
    const before = calls.length;
    const response = await send(method, params);
    assert.equal(response.error.code, 'invalid_params', JSON.stringify(params));
    assert.equal(calls.length, before);
  }
});

test('REST is unauthenticated, loopback-only, emits no CORS, and excludes daemon control routes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-transport-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, 'management.sock');
  const roomRoutes = {
    'room.echo': { auth: true, run: async (params) => params },
  };
  const controlRoutes = {
    'daemon.status': { auth: true, run: async () => ({ running: true }) },
    'daemon.shutdown': { auth: true, run: async () => ({ accepted: true }) },
  };
  const privateRoutes = {
    'room.accept': { auth: true, run: async () => ({ state: 'pending' }) },
  };
  const server = new TransportServer({
    socketPath,
    rest: { enabled: true, port: 0 },
    unixDispatcher: new RpcDispatcher({ ...roomRoutes, ...privateRoutes, ...controlRoutes }),
    restDispatcher: new RpcDispatcher(roomRoutes),
  });
  await server.start();
  t.after(() => server.stop());
  assert.equal(lstatSync(socketPath).mode & 0o777, 0o600);
  assert.equal(server.restAddress.address, '127.0.0.1');

  const envelope = { version: 1, id: 'same', method: 'room.echo', params: { value: 7 } };
  const wire = JSON.stringify(envelope);
  const unix = JSON.parse(await unixRequest(socketPath, `${wire}\n`));
  const rest = await request(server.restAddress.port, { body: wire });
  assert.equal(rest.statusCode, 200);
  assert.deepEqual(rest.json.result, envelope.params);
  assert.deepEqual(rest.json, unix);
  assert.equal(rest.headers['access-control-allow-origin'], undefined);

  for (const method of ['daemon.status', 'daemon.shutdown', 'room.accept']) {
    const controlEnvelope = { version: 1, id: method, method, params: {} };
    const overHttp = await request(server.restAddress.port, { body: JSON.stringify(controlEnvelope) });
    assert.equal(overHttp.statusCode, 404);
    assert.equal(overHttp.json.error.code, 'method_not_found');
    const overUnix = JSON.parse(await unixRequest(socketPath, `${JSON.stringify(controlEnvelope)}\n`));
    assert.deepEqual(overUnix.result, method === 'daemon.status'
      ? { running: true }
      : method === 'room.accept' ? { state: 'pending' } : { accepted: true });
  }
});

test('REST preserves correlated service errors over their actual non-2xx statuses', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-rest-errors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const invalidState = new Error('room is closed');
  invalidState.name = 'RoomServiceError';
  const service = {
    createRoom: async () => null,
    updateRoom: async () => null,
    createInvite: async () => null,
    revokeInvite: async () => null,
    recoverInvites: async () => null,
    confirmRecoveredInvite: async () => null,
    listRooms: async () => [],
    showRoom: async () => null,
    participants: async () => [],
    history: async () => [],
    postMessage: async () => { throw invalidState; },
    closeRoom: async () => null,
    deleteRoom: async () => null,
  };
  const dispatcher = new RpcDispatcher(createServiceRoutes(service));
  const server = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: true, port: 0 }, ...dispatchers(dispatcher),
  });
  await server.start();
  t.after(() => server.stop());

  for (const [id, method, params, status, code, message] of [
    ['params', 'room.message', { room_id: 'room', unexpected: true }, 400, 'invalid_params', 'Unrecognized key'],
    ['state', 'room.message', { room_id: 'room', text: 'hello' }, 400, 'invalid_state', 'room is closed'],
    ['method', 'room.missing', {}, 404, 'method_not_found', 'method not found'],
  ]) {
    const response = await request(server.restAddress.port, {
      body: JSON.stringify({ version: 1, id, method, params }),
    });
    assert.equal(response.statusCode, status);
    assert.equal(response.json.version, 1);
    assert.equal(response.json.id, id);
    assert.equal(response.json.error.code, code);
    assert.match(response.json.error.message, new RegExp(message, 'i'));
  }
});

test('REST RPC requires POST, JSON, a local Host, its same origin, and non-cross-site fetch metadata', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-origin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => { calls += 1; return { pong: true }; } } });
  const server = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: true, port: 0 },
    unixDispatcher: dispatcher, restDispatcher: dispatcher,
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.restAddress.port;
  const body = JSON.stringify({ version: 1, id: 1, method: 'ping', params: {} });
  const authority = `127.0.0.1:${port}`;

  const accepted = await request(port, {
    body,
    headers: { 'content-type': 'application/json; charset=utf-8', origin: `http://${authority}`, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json.result, { pong: true });
  assert.equal(accepted.headers['access-control-allow-origin'], undefined);

  const localhostAuthority = `localhost:${port}`;
  const acceptedLocalhost = await request(port, {
    body,
    host: localhostAuthority,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      origin: `http://${localhostAuthority}`,
      'sec-fetch-site': 'same-origin',
    },
  });
  assert.equal(acceptedLocalhost.statusCode, 200);
  assert.deepEqual(acceptedLocalhost.json.result, { pong: true });
  assert.equal(acceptedLocalhost.headers['access-control-allow-origin'], undefined);

  for (const options of [
    { method: 'GET' },
    { headers: { 'content-type': 'text/plain' } },
    { host: `localhost:${port}`, headers: { 'content-type': 'application/json', origin: `http://${authority}` } },
    { headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` } },
    { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } },
  ]) {
    const rejected = await request(port, { body, ...options });
    assert.notEqual(rejected.statusCode, 200);
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(calls, 2);
});

test('REST and Unix reject oversized streaming/chunked bodies before dispatch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => { calls += 1; } } });
  const socketPath = join(dir, 'management.sock');
  const server = new TransportServer({ socketPath, rest: { enabled: true, port: 0 }, ...dispatchers(dispatcher) });
  await server.start();
  t.after(() => server.stop());
  const chunks = [Buffer.alloc(MAX_REQUEST_BYTES, 0x20), Buffer.from('xx')];
  const rest = await request(server.restAddress.port, { chunks });
  assert.equal(rest.status, 413);
  const unix = JSON.parse(await unixRequest(socketPath, `${' '.repeat(MAX_REQUEST_BYTES + 1)}\n`));
  assert.equal(unix.error.code, 'request_too_large');
  assert.equal(calls, 0);
});

test('malformed JSON is a protocol error and a live Unix socket is never unlinked', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-stale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => null } });
  const first = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: false, port: 1 }, ...dispatchers(dispatcher),
  });
  await first.start();
  t.after(() => first.stop());
  const malformed = JSON.parse(await unixRequest(join(dir, 'management.sock'), '{nope}\n'));
  assert.equal(malformed.error.code, 'invalid_json');
  const second = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: false, port: 1 }, ...dispatchers(dispatcher),
  });
  await assert.rejects(second.start(), /already in use|live/i);
  assert(lstatSync(join(dir, 'management.sock')).isSocket());
});

test('stop rejects new dispatcher work, awaits in-flight work, and is idempotent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dispatcher = new RpcDispatcher({ slow: { auth: true, run: () => gate } });
  const pending = dispatcher.dispatch({ version: 1, id: 1, method: 'slow', params: {} });
  dispatcher.beginShutdown();
  const rejected = await dispatcher.dispatch({ version: 1, id: 2, method: 'slow', params: {} });
  assert.equal(rejected.error.code, 'shutting_down');
  let drained = false;
  const drain = dispatcher.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release('done');
  assert.deepEqual(await pending, { version: 1, id: 1, result: 'done' });
  await drain;
  assert.equal(drained, true);
});

test('shutdown bounds a partial HTTP body and destroys the slow connection', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-slowloris-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => null } });
  const server = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: true, port: 0 }, ...dispatchers(dispatcher),
  });
  await server.start();
  const socket = net.createConnection(server.restAddress.port, '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:${server.restAddress.port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
  const outcome = await Promise.race([
    server.stop().then(() => 'stopped'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1_500)),
  ]);
  assert.equal(outcome, 'stopped');
  await Promise.race([
    new Promise((resolve) => socket.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('slow HTTP socket remained open')), 500)),
  ]);
});

test('shutdown closes an idle HTTP keep-alive connection', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-keepalive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => ({ pong: true }) } });
  const server = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: true, port: 0 }, ...dispatchers(dispatcher),
  });
  await server.start();
  const socket = net.createConnection(server.restAddress.port, '127.0.0.1');
  socket.setEncoding('utf8');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const body = JSON.stringify({ version: 1, id: 1, method: 'ping', params: {} });
  socket.write(`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:${server.restAddress.port}\r\nConnection: keep-alive\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('keep-alive response timed out')), 1_000);
    socket.on('data', (chunk) => {
      if (!chunk.includes('200 OK')) return;
      clearTimeout(timer);
      resolve();
    });
  });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  await server.stop();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('idle keep-alive remained open')), 500)),
  ]);
});

test('shutdown lets an already-dispatched HTTP operation finish without a response cutoff', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-http-dispatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const dispatcher = new RpcDispatcher({
    slow: { auth: true, run: async () => {
      markStarted();
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      return { complete: true };
    } },
  });
  const server = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: true, port: 0 }, ...dispatchers(dispatcher),
  });
  await server.start();
  const body = JSON.stringify({ version: 1, id: 1, method: 'slow', params: {} });
  const response = request(server.restAddress.port, { body });
  await started;
  const stopping = server.stop();
  const result = await response;
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body).result, { complete: true });
  await stopping;
});

test('shutdown drains an in-flight static response before closing its connection', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-http-static-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let release;
  let markStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => null } });
  const server = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: true, port: 0 }, ...dispatchers(dispatcher),
    staticHandler: async (_incoming, response) => {
      markStarted();
      await gate;
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('complete');
      return true;
    },
  });
  await server.start();
  const pending = request(server.restAddress.port, { method: 'GET', path: '/' });
  await started;
  let stopped = false;
  const stopping = server.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  const response = await pending;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'complete');
  await stopping;
});

test('shutdown preserves a replacement Unix socket at the same path', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-socket-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'management.sock');
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => null } });
  const transport = new TransportServer({
    socketPath: path, rest: { enabled: false, port: 1 }, ...dispatchers(dispatcher),
  });
  await transport.start();
  const moved = `${path}.old`;
  const { renameSync } = await import('node:fs');
  renameSync(path, moved);
  const replacement = net.createServer();
  await new Promise((resolve, reject) => {
    replacement.once('error', reject);
    replacement.listen(path, resolve);
  });
  await transport.stop();
  assert(lstatSync(path).isSocket());
  await new Promise((resolve) => replacement.close(resolve));
});

for (const kind of ['regular file', 'symlink']) {
  test(`shutdown preserves a replacement ${kind} at the Unix path`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cowork-socket-replacement-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'management.sock');
    const transport = new TransportServer({
      socketPath: path, rest: { enabled: false, port: 1 },
      ...nullDispatchers(),
    });
    await transport.start();
    realFs.renameSync(path, `${path}.old`);
    if (kind === 'regular file') writeFileSync(path, 'replacement');
    else symlinkSync('replacement-target', path);
    await transport.stop();
    const stat = lstatSync(path);
    if (kind === 'regular file') assert.equal(readFileSync(path, 'utf8'), 'replacement');
    else assert(stat.isSymbolicLink());
  });
}

test('shutdown never overwrites a Unix path reoccupied while a replacement is protected', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-socket-reoccupied-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'management.sock');
  let injected = false;
  const fs = new Proxy(realFs, {
    get(target, property) {
      if (property === 'renameSync') return (source, destination) => {
        target.renameSync(source, destination);
        if (!injected && source === path && destination.includes('.replacement-')) {
          injected = true;
          target.writeFileSync(path, 'later occupant');
        }
      };
      return target[property];
    },
  });
  const transport = new TransportServer({
    socketPath: path, rest: { enabled: false, port: 1 }, fs,
    ...nullDispatchers(),
  });
  await transport.start();
  realFs.renameSync(path, `${path}.old`);
  writeFileSync(path, 'first replacement');
  await assert.rejects(transport.stop(), /preserv|residue|reoccupied/i);
  assert.equal(readFileSync(path, 'utf8'), 'later occupant');
  const protectedName = readdirSync(dir).find((name) => name.includes('.replacement-'));
  assert(protectedName);
  assert.equal(readFileSync(join(dir, protectedName), 'utf8'), 'first replacement');
});

test('Unix listener binds privately before publishing the management path', () => {
  const source = readFileSync(new URL('../src/transports.ts', import.meta.url), 'utf8');
  assert.match(source, /privateSocketPath/);
  assert.match(source, /listen\(unix,\s*private/);
  assert.match(source, /linkSync\([^,]*private[^,]*,\s*this\.options\.socketPath\)/s);
  assert.doesNotMatch(source, /renameSync\([^,]*private[^,]*,\s*this\.options\.socketPath\)/s);
});

for (const kind of ['regular file', 'symlink', 'socket']) {
  test(`publication atomically preserves a last-instant ${kind} occupant`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cowork-socket-publish-race-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'management.sock');
    const prepared = join(dir, 'prepared-occupant');
    let replacementServer;
    if (kind === 'regular file') writeFileSync(prepared, 'last-instant occupant');
    else if (kind === 'symlink') symlinkSync('occupant-target', prepared);
    else {
      replacementServer = net.createServer();
      await new Promise((resolve, reject) => {
        replacementServer.once('error', reject);
        replacementServer.listen(prepared, resolve);
      });
      t.after(async () => { await new Promise((resolve) => replacementServer.close(resolve)); });
    }
    let injected = false;
    const fs = new Proxy(realFs, {
      get(target, property) {
        if (property === 'linkSync') return (source, destination) => {
          if (!injected && destination === path) {
            injected = true;
            target.renameSync(prepared, path);
          }
          return target.linkSync(source, destination);
        };
        return target[property];
      },
    });
    const transport = new TransportServer({
      socketPath: path, rest: { enabled: false, port: 1 }, fs,
      ...nullDispatchers(),
    });
    t.after(() => transport.stop());
    await assert.rejects(transport.start(), /exist|occupied|publish/i);
    assert.equal(injected, true);
    const stat = lstatSync(path);
    if (kind === 'regular file') assert.equal(readFileSync(path, 'utf8'), 'last-instant occupant');
    else if (kind === 'symlink') assert(stat.isSymbolicLink());
    else assert(stat.isSocket());
  });
}

test('startup removes only inode-verified owned stale private sockets within its cleanup bound', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-private-stale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'management.sock');
  const seed = join(dir, 'seed.sock');
  const stale = `${path}.private-${process.pid}-stale`;
  const preservedFile = `${path}.private-${process.pid}-regular`;
  const preservedLink = `${path}.private-${process.pid}-symlink`;
  const staleServer = net.createServer();
  await new Promise((resolve, reject) => {
    staleServer.once('error', reject);
    staleServer.listen(seed, resolve);
  });
  realFs.renameSync(seed, stale);
  await new Promise((resolve) => staleServer.close(resolve));
  writeFileSync(preservedFile, 'preserve');
  symlinkSync('preserve-target', preservedLink);
  const transport = new TransportServer({
    socketPath: path, rest: { enabled: false, port: 1 },
    ...nullDispatchers(),
  });
  t.after(() => transport.stop());
  await transport.start();
  assert.equal(realFs.existsSync(stale), false);
  assert.equal(readFileSync(preservedFile, 'utf8'), 'preserve');
  assert(lstatSync(preservedLink).isSymbolicLink());
  await transport.stop();
});

test('publication retains its exact owned socket at a non-scannable residue without unlinking quarantine', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-private-residue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'management.sock');
  const forbiddenUnlinks = [];
  const fs = new Proxy(realFs, {
    get(target, property) {
      if (property === 'unlinkSync') return (candidate) => {
        if (typeof candidate === 'string' && (candidate.includes('.private-alias-')
          || candidate.includes('.safe-residue-private-alias-')
          || candidate.includes('.replacement-'))) forbiddenUnlinks.push(candidate);
        return target.unlinkSync(candidate);
      };
      return target[property];
    },
  });
  const transport = new TransportServer({
    socketPath: path, rest: { enabled: false, port: 1 }, fs,
    ...nullDispatchers(),
  });
  await transport.start();
  t.after(() => transport.stop());
  const published = lstatSync(path);
  await transport.stop();
  assert.deepEqual(forbiddenUnlinks, []);
  const residueName = readdirSync(dir).find((name) => name.includes('.safe-residue-private-alias-'));
  assert(residueName);
  assert.equal(residueName.startsWith('management.sock.private-'), false);
  const residue = lstatSync(join(dir, residueName));
  assert(residue.isSocket());
  assert.deepEqual([residue.dev, residue.ino], [published.dev, published.ino]);
});

test('stale cleanup retains the exact inert socket residue without unlinking quarantine', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-stale-residue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'management.sock');
  const seed = join(dir, 'seed.sock');
  const stale = `${path}.private-${process.pid}-stale-residue`;
  const staleServer = net.createServer();
  await new Promise((resolve, reject) => {
    staleServer.once('error', reject);
    staleServer.listen(seed, resolve);
  });
  realFs.renameSync(seed, stale);
  await new Promise((resolve) => staleServer.close(resolve));
  const original = lstatSync(stale);
  const forbiddenUnlinks = [];
  const fs = new Proxy(realFs, {
    get(target, property) {
      if (property === 'unlinkSync') return (candidate) => {
        if (typeof candidate === 'string' && (candidate.includes('.stale-private-')
          || candidate.includes('.safe-residue-stale-private-'))) forbiddenUnlinks.push(candidate);
        return target.unlinkSync(candidate);
      };
      return target[property];
    },
  });
  const transport = new TransportServer({
    socketPath: path, rest: { enabled: false, port: 1 }, fs,
    ...nullDispatchers(),
  });
  await transport.start();
  t.after(() => transport.stop());
  assert.deepEqual(forbiddenUnlinks, []);
  assert.equal(realFs.existsSync(stale), false);
  const residueName = readdirSync(dir).find((name) => name.includes('.safe-residue-stale-private-'));
  assert(residueName);
  assert.equal(residueName.startsWith('management.sock.private-'), false);
  const residue = lstatSync(join(dir, residueName));
  assert(residue.isSocket());
  assert.deepEqual([residue.dev, residue.ino], [original.dev, original.ino]);
});

test('publication preserves a private-alias replacement swapped at the final destructive operation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-private-alias-swap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'management.sock');
  const prepared = join(dir, 'prepared-private-replacement');
  writeFileSync(prepared, 'private alias replacement');
  let privatePath;
  let privateStats = 0;
  let injected = false;
  const fs = new Proxy(realFs, {
    get(target, property) {
      if (property === 'lstatSync') return (candidate, ...args) => {
        const stat = target.lstatSync(candidate, ...args);
        if (typeof candidate === 'string' && candidate.includes('.private-') && stat.isSocket()) {
          privatePath = candidate;
          privateStats += 1;
        }
        return stat;
      };
      if (property === 'unlinkSync') return (candidate) => {
        if (!injected && candidate === privatePath && privateStats >= 2) {
          injected = true;
          target.renameSync(candidate, `${candidate}.owned`);
          target.renameSync(prepared, candidate);
        }
        return target.unlinkSync(candidate);
      };
      if (property === 'renameSync') return (source, destination) => {
        if (!injected && source === privatePath && privateStats >= 2) {
          injected = true;
          target.renameSync(source, `${source}.owned`);
          target.renameSync(prepared, source);
        }
        return target.renameSync(source, destination);
      };
      return target[property];
    },
  });
  const transport = new TransportServer({
    socketPath: path, rest: { enabled: false, port: 1 }, fs,
    ...nullDispatchers(),
  });
  t.after(() => transport.stop());
  await assert.rejects(transport.start(), /private|publish|changed|replacement|residue/i);
  assert.equal(injected, true);
  assert.equal(readFileSync(privatePath, 'utf8'), 'private alias replacement');
});

test('stale-prefix cleanup preserves a live same-UID private socket', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-live-private-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'management.sock');
  const livePath = `${path}.private-${process.pid}-live`;
  const live = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    live.once('error', reject);
    live.listen(livePath, resolve);
  });
  t.after(async () => { await new Promise((resolve) => live.close(resolve)); });
  const transport = new TransportServer({
    socketPath: path, rest: { enabled: false, port: 1 },
    ...nullDispatchers(),
  });
  await transport.start();
  t.after(() => transport.stop());
  assert(lstatSync(livePath).isSocket());
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(livePath);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  });
});

test('stale-prefix cleanup preserves a replacement swapped at its final destructive operation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-stale-private-swap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'management.sock');
  const seed = join(dir, 'seed.sock');
  const stale = `${path}.private-${process.pid}-swap`;
  const prepared = join(dir, 'prepared-stale-replacement');
  const staleServer = net.createServer();
  await new Promise((resolve, reject) => {
    staleServer.once('error', reject);
    staleServer.listen(seed, resolve);
  });
  realFs.renameSync(seed, stale);
  await new Promise((resolve) => staleServer.close(resolve));
  writeFileSync(prepared, 'stale path replacement');
  let observations = 0;
  let injected = false;
  const fs = new Proxy(realFs, {
    get(target, property) {
      if (property === 'lstatSync') return (candidate, ...args) => {
        const stat = target.lstatSync(candidate, ...args);
        if (candidate === stale && stat.isSocket()) observations += 1;
        return stat;
      };
      if (property === 'unlinkSync') return (candidate) => {
        if (!injected && candidate === stale && observations >= 2) {
          injected = true;
          target.renameSync(candidate, `${candidate}.owned`);
          target.renameSync(prepared, candidate);
        }
        return target.unlinkSync(candidate);
      };
      if (property === 'renameSync') return (source, destination) => {
        if (!injected && source === stale && observations >= 1) {
          injected = true;
          target.renameSync(source, `${source}.owned`);
          target.renameSync(prepared, source);
        }
        return target.renameSync(source, destination);
      };
      return target[property];
    },
  });
  const transport = new TransportServer({
    socketPath: path, rest: { enabled: false, port: 1 }, fs,
    ...nullDispatchers(),
  });
  t.after(() => transport.stop());
  await assert.rejects(transport.start(), /stale|changed|replacement|residue/i);
  assert.equal(injected, true);
  assert.equal(readFileSync(stale, 'utf8'), 'stale path replacement');
});

for (const kind of ['regular file', 'symlink', 'socket']) {
  test(`shutdown preserves a final-after-inspection ${kind} replacement`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cowork-socket-inspection-race-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'management.sock');
    const prepared = join(dir, 'prepared-replacement');
    let armed = false;
    let injected = false;
    const fs = new Proxy(realFs, {
      get(target, property) {
        if (property === 'renameSync') return (source, destination) => {
          if (armed && !injected && source === path && destination.includes('.replacement-')) {
            injected = true;
            target.renameSync(path, `${path}.owned`);
            target.renameSync(prepared, path);
          }
          return target.renameSync(source, destination);
        };
        return target[property];
      },
    });
    const transport = new TransportServer({
      socketPath: path, rest: { enabled: false, port: 1 }, fs,
      ...nullDispatchers(),
    });
    await transport.start();
    let replacementServer;
    if (kind === 'regular file') writeFileSync(prepared, 'inspection-race replacement');
    else if (kind === 'symlink') symlinkSync('replacement-target', prepared);
    else {
      replacementServer = net.createServer();
      await new Promise((resolve, reject) => {
        replacementServer.once('error', reject);
        replacementServer.listen(prepared, resolve);
      });
    }
    armed = true;
    await transport.stop();
    const stat = lstatSync(path);
    if (kind === 'regular file') assert.equal(readFileSync(path, 'utf8'), 'inspection-race replacement');
    else if (kind === 'symlink') assert(stat.isSymbolicLink());
    else {
      assert(stat.isSocket());
      await new Promise((resolve) => replacementServer.close(resolve));
    }
  });
}
