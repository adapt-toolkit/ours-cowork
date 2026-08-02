import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('shutdown lets an already-dispatched HTTP operation finish without a response cutoff', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-http-dispatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = 'b2'.repeat(32);
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
    socketPath: join(dir, 'management.sock'), rest: { enabled: true, port: 0 }, token, dispatcher,
  });
  await server.start();
  const body = JSON.stringify({ version: 1, id: 1, method: 'slow', params: {} });
  const response = request(server.restAddress.port, { body, authorization: `Bearer ${token}` });
  await started;
  const stopping = server.stop();
  const result = await response;
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body).result, { complete: true });
  await stopping;
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

for (const kind of ['regular file', 'symlink']) {
  test(`shutdown preserves a replacement ${kind} at the Unix path`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cowork-socket-replacement-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'management.sock');
    const transport = new TransportServer({
      socketPath: path, rest: { enabled: false, port: 1 },
      dispatcher: new RpcDispatcher({ ping: { auth: true, run: async () => null } }),
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
    dispatcher: new RpcDispatcher({ ping: { auth: true, run: async () => null } }),
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
      dispatcher: new RpcDispatcher({ ping: { auth: true, run: async () => null } }),
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
    dispatcher: new RpcDispatcher({ ping: { auth: true, run: async () => null } }),
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
    dispatcher: new RpcDispatcher({ ping: { auth: true, run: async () => null } }),
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
    dispatcher: new RpcDispatcher({ ping: { auth: true, run: async () => null } }),
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
    dispatcher: new RpcDispatcher({ ping: { auth: true, run: async () => null } }),
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
    dispatcher: new RpcDispatcher({ ping: { auth: true, run: async () => null } }),
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
    dispatcher: new RpcDispatcher({ ping: { auth: true, run: async () => null } }),
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
      dispatcher: new RpcDispatcher({ ping: { auth: true, run: async () => null } }),
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
