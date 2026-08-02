import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createServiceRoutes,
  MAX_REQUEST_BYTES,
  RpcDispatcher,
  TransportServer,
} from '../src/transports.ts';

function request(port, { body = '', authorization, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/rpc', method: 'POST',
      headers: authorization ? { authorization } : {},
    }, (res) => {
      const data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(data).toString('utf8') }));
    });
    req.on('error', reject);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    else req.write(body);
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
    'room.close', 'room.create', 'room.delete', 'room.history', 'room.invite', 'room.list',
    'room.message', 'room.participants', 'room.recover', 'room.recover.confirm', 'room.revoke',
    'room.settings', 'room.show',
  ]);
  assert(Object.values(routes).every((route) => route.auth === true));
});

test('Unix and REST use the same dispatcher; socket is 0600 and REST is loopback-only', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-transport-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, 'management.sock');
  const token = 'ab'.repeat(32);
  const dispatcher = new RpcDispatcher({
    'room.echo': { auth: true, run: async (params) => params },
  });
  const server = new TransportServer({ socketPath, rest: { enabled: true, port: 0 }, token, dispatcher });
  await server.start();
  t.after(() => server.stop());
  assert.equal(lstatSync(socketPath).mode & 0o777, 0o600);
  assert.equal(server.restAddress.address, '127.0.0.1');

  const wire = JSON.stringify({ version: 1, id: 'same', method: 'room.echo', params: { value: 7 } });
  const unix = JSON.parse(await unixRequest(socketPath, `${wire}\n`));
  const rest = await request(server.restAddress.port, { body: wire, authorization: `Bearer ${token}` });
  assert.equal(rest.status, 200);
  assert.deepEqual(JSON.parse(rest.body), unix);
});

test('REST authorization is uniform, validates length before timingSafeEqual, and fails closed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const comparisons = [];
  const dispatcher = new RpcDispatcher({
    ping: { auth: true, run: async () => ({ pong: true }) },
  });
  const token = '01'.repeat(32);
  const server = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: true, port: 0 }, token, dispatcher,
    timingSafeEqual: (left, right) => { comparisons.push([left.length, right.length]); return left.equals(right); },
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.restAddress.port;
  const body = JSON.stringify({ version: 1, id: 1, method: 'ping', params: {} });
  const attempts = [undefined, 'Basic abc', 'Bearer xyz', `Bearer ${'02'.repeat(32)}`];
  const observed = [];
  for (const authorization of attempts) observed.push(await request(port, { body, authorization }));
  assert.deepEqual(observed.map(({ status, body: value }) => [status, value]), [
    [401, observed[0].body], [401, observed[0].body], [401, observed[0].body], [401, observed[0].body],
  ]);
  assert.deepEqual(comparisons, [[32, 32]]);
});

test('REST and Unix reject oversized streaming/chunked bodies before dispatch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const token = 'cd'.repeat(32);
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => { calls += 1; } } });
  const socketPath = join(dir, 'management.sock');
  const server = new TransportServer({ socketPath, rest: { enabled: true, port: 0 }, token, dispatcher });
  await server.start();
  t.after(() => server.stop());
  const chunks = [Buffer.alloc(MAX_REQUEST_BYTES, 0x20), Buffer.from('xx')];
  const rest = await request(server.restAddress.port, {
    authorization: `Bearer ${token}`, chunks,
  });
  assert.equal(rest.status, 413);
  const unix = JSON.parse(await unixRequest(socketPath, `${' '.repeat(MAX_REQUEST_BYTES + 1)}\n`));
  assert.equal(unix.error.code, 'request_too_large');
  assert.equal(calls, 0);
});

test('malformed JSON is a protocol error and a live Unix socket is never unlinked', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-stale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => null } });
  const first = new TransportServer({ socketPath: join(dir, 'management.sock'), rest: { enabled: false, port: 1 }, dispatcher });
  await first.start();
  t.after(() => first.stop());
  const malformed = JSON.parse(await unixRequest(join(dir, 'management.sock'), '{nope}\n'));
  assert.equal(malformed.error.code, 'invalid_json');
  const second = new TransportServer({ socketPath: join(dir, 'management.sock'), rest: { enabled: false, port: 1 }, dispatcher });
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

test('shutdown bounds an authenticated partial HTTP body and destroys the slow connection', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-slowloris-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = 'ef'.repeat(32);
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => null } });
  const server = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: true, port: 0 }, token, dispatcher,
  });
  await server.start();
  const socket = net.createConnection(server.restAddress.port, '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Length: 1000\r\n\r\n{`);
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

test('shutdown closes an idle authenticated HTTP keep-alive connection', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-keepalive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = 'a1'.repeat(32);
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => ({ pong: true }) } });
  const server = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: true, port: 0 }, token, dispatcher,
  });
  await server.start();
  const socket = net.createConnection(server.restAddress.port, '127.0.0.1');
  socket.setEncoding('utf8');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const body = JSON.stringify({ version: 1, id: 1, method: 'ping', params: {} });
  socket.write(`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
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

test('shutdown preserves a replacement Unix socket at the same path', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-socket-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'management.sock');
  const dispatcher = new RpcDispatcher({ ping: { auth: true, run: async () => null } });
  const transport = new TransportServer({ socketPath: path, rest: { enabled: false, port: 1 }, dispatcher });
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
