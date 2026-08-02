import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AdaptHost,
  AdaptObjectLifetime,
  Packet,
  unpackInvite,
  wireHandlers,
  withScope,
  withScopeAsync,
} from '../src/adapt.ts';
import {
  PacketPersistenceError,
  PacketRegistry,
  atomicWriteFileSync,
} from '../src/packets.ts';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(THIS_FILE), '..');
const DRIVER_SENTINEL = 'COWORK_PACKETS_DRIVER_SUCCESS';
const DRIVER_FAILURE_SENTINEL = 'COWORK_PACKETS_DRIVER_FAILURE';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForPort(port) {
  await waitFor(() => new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => { socket.destroy(); done(false); });
  }), `broker port ${port}`);
}

function renderRawInbox(packet) {
  return withScope((lifetime) => {
    const value = packet.readonlyTx('::actor::list_incoming_messages', lifetime);
    const messages = [];
    for (let index = 0; ; index += 1) {
      const message = value.Reduce(index);
      if (message.IsNil()) break;
      messages.push({
        msg_id: Number(message.Reduce('msg_id').Visualize()),
        text: message.Reduce('text').Visualize(),
        status: message.Reduce('status').Visualize(),
      });
    }
    return messages;
  });
}

async function runPacketDriver() {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-registry-'));
  const port = await unusedPort();
  const broker = spawn(process.execPath, [resolve(ROOT, 'node_modules/.bin/adapt-broker'),
    '--host', '127.0.0.1', '--port', String(port), '--test_mode'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const brokerOutput = [];
  broker.stderr.on('data', (chunk) => brokerOutput.push(chunk.toString()));
  const brokerExited = new Promise((done) => {
    broker.once('error', (error) => done({ error }));
    broker.once('exit', (code, signal) => done({ code, signal }));
  });
  let host;
  try {
    await waitForPort(port);
    host = new AdaptHost(`ws://127.0.0.1:${port}`, () => {});
    await host.boot();

    let failStateWrite = false;
    const persistence = new Proxy(fs, {
      get(target, property) {
        if (property === 'writeSync') {
          return (fd, bytes, offset, length, position) => {
            if (failStateWrite) {
              const error = new Error('injected disk full');
              error.code = 'ENOSPC';
              throw error;
            }
            return target.writeSync(fd, bytes, offset, length, position);
          };
        }
        return Reflect.get(target, property);
      },
    });
    const registry = new PacketRegistry(host, stateDir, { persistence });
    const [alpha, beta, gamma] = await Promise.all([
      registry.create('alpha'),
      registry.create('beta'),
      registry.create('gamma'),
    ]);
    if (process.argv.includes('--deliberate-driver-failure')) {
      assert.fail('deliberate packet registry driver assertion failure');
    }
    assert.equal(host.packetCount, 3, 'one wrapper must host all three room packets');
    assert.equal(registry.size, 3);

    // Two concurrent calls per packet, issued in an interleaved outer order,
    // must resolve with the signature belonging to that packet and input.
    const inputs = ['{"packet":"alpha"}', '{"packet":"beta"}', '{"packet":"gamma"}'];
    const baseline = await Promise.all([
      alpha.sign(inputs[0]), beta.sign(inputs[1]), gamma.sign(inputs[2]),
    ]);
    const paired = await Promise.all([
      gamma.sign(inputs[2]), alpha.sign(inputs[0]), beta.sign(inputs[1]),
      alpha.sign(inputs[0]), gamma.sign(inputs[2]), beta.sign(inputs[1]),
    ]);
    assert.deepEqual(paired, [baseline[2], baseline[0], baseline[1], baseline[0], baseline[2], baseline[1]]);

    const peer = await host.createPacket('peer', `peer-${Date.now()}`);
    wireHandlers(peer, { onSaveState: () => {}, onNotify: () => {} }, () => {});
    await withScopeAsync((lifetime) =>
      peer.mutatingTx('::a2a_messaging::set_my_name', { name: 'Peer' }, lifetime));
    const invite = await gamma.mintInvite('public');
    await withScopeAsync(async (lifetime) => {
      await peer.mutatingTx('::a2a_messaging::add_contact', {
        invite: peer.newBinary(unpackInvite(invite.blob), lifetime),
      }, lifetime);
    });
    await waitFor(
      () => gamma.listContacts().some((contact) => contact.container_id === peer.cid),
      'peer acceptance by gamma room',
    );

    failStateWrite = true;
    await assert.rejects(
      gamma.send(peer.cid, 'must-not-escape'),
      (error) => error instanceof PacketPersistenceError && error.cause?.code === 'ENOSPC',
    );
    await sleep(500);
    assert.equal(renderRawInbox(peer).some((message) => message.text === 'must-not-escape'), false,
      'SEND must stay buffered when state persistence fails');
    failStateWrite = false;

    await withScopeAsync((lifetime) =>
      peer.mutatingTx('::a2a_messaging::send_message', { contact: gamma.cid, text: 'first' }, lifetime));
    await waitFor(() => gamma.peekInbox().some((message) => message.text === 'first'), 'first unread message');
    const expected = gamma.peekInbox();
    assert.equal(expected.length, 1);
    await withScopeAsync((lifetime) =>
      peer.mutatingTx('::a2a_messaging::send_message', { contact: gamma.cid, text: 'raced' }, lifetime));
    await waitFor(() => gamma.peekInbox().length === 2, 'arrival between peek and consume');
    const consumed = await gamma.consumeInbox([expected[0].msg_id]);
    assert.deepEqual(consumed.consumed, [expected[0].msg_id]);
    assert.equal(consumed.deferred.length, 1);
    assert.deepEqual(gamma.peekInbox().map((message) => message.msg_id), consumed.deferred,
      'unexpected drained arrivals must be unread again before consume resolves');

    const alphaLive = join(stateDir, 'rooms', 'alpha', 'live');
    const betaLive = join(stateDir, 'rooms', 'beta', 'live');
    const gammaLive = join(stateDir, 'rooms', 'gamma', 'live');
    assert.deepEqual(await registry.destroy('beta'), []);
    assert.equal(fs.existsSync(betaLive), false);
    assert.equal(fs.existsSync(alphaLive), true);
    assert.equal(fs.existsSync(gammaLive), true);
    assert.equal(registry.get('gamma'), gamma, 'destroy must not unregister another room');

    const alphaCid = alpha.cid;
    const secret = fs.readFileSync(join(alphaLive, 'identity.key'));
    const state = fs.readFileSync(join(alphaLive, 'state_data.bin'));
    assert.deepEqual(await registry.destroy('alpha'), []);
    fs.mkdirSync(alphaLive, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(alphaLive, 'identity.key'), secret, { mode: 0o600 });
    fs.writeFileSync(join(alphaLive, 'state_data.bin'), state, { mode: 0o600 });
    const restored = await registry.restore('alpha');
    assert.equal(restored.cid, alphaCid, 'restored signing secret must reproduce the CID');

    await registry.destroy('alpha');
    await registry.destroy('gamma');
    host.removePacket(peer.cid);
    assert.equal(host.packetCount, 0);
  } catch (error) {
    throw new Error(`${error.stack ?? error}\nbroker output:\n${brokerOutput.join('').slice(-4000)}`);
  } finally {
    try { host?.close(); } catch { /* assertion path cleanup */ }
    broker.kill('SIGKILL');
    await brokerExited;
    rmSync(stateDir, { recursive: true, force: true });
  }
}

if (process.argv.includes('--packet-driver')) {
  try {
    await runPacketDriver();
    process.stdout.write(`${DRIVER_SENTINEL}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.stdout.write(`${DRIVER_FAILURE_SENTINEL}\n`);
  }
} else {

test('native scratch lifetimes finalize on sync and async exits', async () => {
  for (const run of [withScope, withScopeAsync]) {
    let destroyed = 0;
    await run(async (lifetime) => {
      lifetime.Deposit({ Destroy: () => { destroyed += 1; } });
      assert.equal(lifetime.size, 1);
    });
    assert.equal(destroyed, 1);
  }
  assert.equal(typeof AdaptObjectLifetime, 'function');
  assert.equal(typeof Packet, 'function');
  assert.equal(typeof AdaptHost, 'function');
});

test('atomic packet state follows the exact durable replacement sequence', () => {
  const root = mkdtempSync(join(tmpdir(), 'ours-cowork-packets-'));
  const target = join(root, 'state_data.bin');
  const calls = [];
  let nextFd = 10;
  const files = new Map();
  const fds = new Map();
  const ops = {
    openSync(path, flags, mode) {
      calls.push(['open', path, flags, mode]);
      const fd = nextFd++;
      fds.set(fd, { path, bytes: Buffer.alloc(0) });
      return fd;
    },
    fchmodSync(fd, mode) { calls.push(['fchmod', fd, mode]); },
    writeSync(fd, bytes, offset, length) {
      calls.push(['write', fd, length]);
      const rec = fds.get(fd);
      rec.bytes = Buffer.concat([rec.bytes, Buffer.from(bytes).subarray(offset, offset + length)]);
      return length;
    },
    fsyncSync(fd) { calls.push(['fsync', fd]); },
    closeSync(fd) { calls.push(['close', fd]); },
    renameSync(from, to) {
      calls.push(['rename', from, to]);
      const rec = [...fds.values()].find((entry) => entry.path === from);
      files.set(to, rec.bytes);
    },
    chmodSync(path, mode) { calls.push(['chmod', path, mode]); },
    rmSync(path) { calls.push(['rm', path]); },
  };

  atomicWriteFileSync(target, Buffer.from('durable'), ops);
  assert.deepEqual(calls.map(([kind]) => kind), [
    'open', 'fchmod', 'write', 'fsync', 'close', 'rename', 'chmod', 'open', 'fsync', 'close',
  ]);
  assert.equal(calls[0][3], 0o600);
  assert.equal(calls[1][2], 0o600);
  assert.equal(calls[6][2], 0o600);
  assert.deepEqual(files.get(target), Buffer.from('durable'));
  rmSync(root, { recursive: true, force: true });
});

test('packet persistence failures are typed and leave the prior live file untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'ours-cowork-packets-fail-'));
  const target = join(root, 'state_data.bin');
  const prior = Buffer.from('prior');
  fs.writeFileSync(target, prior, { mode: 0o600 });
  const calls = [];
  const ops = {
    openSync(path, flags, mode) {
      calls.push(['open', path, flags, mode]);
      return fs.openSync(path, flags, mode);
    },
    fchmodSync(fd, mode) { calls.push(['fchmod', fd, mode]); fs.fchmodSync(fd, mode); },
    writeSync() { const error = new Error('disk full'); error.code = 'ENOSPC'; throw error; },
    fsyncSync() { assert.fail('fsync must not follow a failed write'); },
    closeSync(fd) { calls.push(['close', fd]); fs.closeSync(fd); },
    renameSync() { assert.fail('rename must not follow a failed write'); },
    chmodSync() { assert.fail('chmod must not follow a failed write'); },
    rmSync(path) { calls.push(['rm', path]); fs.rmSync(path, { force: true }); },
  };
  assert.throws(
    () => atomicWriteFileSync(target, Buffer.from('new'), ops),
    (error) => error instanceof PacketPersistenceError && error.cause?.code === 'ENOSPC',
  );
  assert.deepEqual(fs.readFileSync(target), prior);
  assert.deepEqual(calls.map(([kind]) => kind), ['open', 'fchmod', 'close', 'rm']);
  rmSync(root, { recursive: true, force: true });
});

test('PacketRegistry public lifecycle surface is standalone', () => {
  assert.equal(typeof PacketRegistry, 'function');
  const source = readFileSync(new URL('../src/packets.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ours-mcp|@ours\.network\/mcp/);
  for (const entry of ['daemon.ts', 'cli.ts']) {
    const placeholder = readFileSync(new URL(`../src/${entry}`, import.meta.url), 'utf8');
    assert.match(placeholder, /Build-only placeholder/);
    assert.doesNotMatch(placeholder, /ours-mcp|@ours\.network\/mcp/);
  }
});

async function runDriverChild(t, { extraArgs = [], timeoutMs }) {
  const child = spawn(process.execPath, [THIS_FILE, '--packet-driver', ...extraArgs], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let settleOutcome;
  let killRequested = false;
  const outcomePromise = new Promise((done) => { settleOutcome = done; });
  const exitedPromise = new Promise((done) => {
    child.once('error', (error) => done({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  function capture(chunk) {
    output += chunk.toString();
    if (output.includes(DRIVER_FAILURE_SENTINEL)) settleOutcome({ kind: 'failure' });
    else if (output.includes(DRIVER_SENTINEL)) settleOutcome({ kind: 'success' });
  }
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  async function killAndReap() {
    if (!killRequested) {
      killRequested = true;
      child.kill('SIGKILL');
    }
    return exitedPromise;
  }
  t.after(async () => { await killAndReap(); });
  let watchdog;
  const timeoutPromise = new Promise((done) => {
    watchdog = setTimeout(() => done({ kind: 'timeout' }), timeoutMs);
  });
  const outcome = await Promise.race([
    outcomePromise,
    exitedPromise.then((result) => ({ kind: 'exit', result })),
    timeoutPromise,
  ]);
  clearTimeout(watchdog);
  const result = await killAndReap();
  return { outcome, result, output };
}

function diagnostics(run) {
  const exit = run.result.error?.message ?? run.result.signal ?? run.result.code;
  return `packet driver ${run.outcome.kind} (${exit})\n${run.output.slice(-12_000)}`;
}

test('one wrapper persists, restores, races, and targets room packets', { timeout: 100_000 }, async (t) => {
  const run = await runDriverChild(t, { timeoutMs: 90_000 });
  assert.equal(run.outcome.kind, 'success', diagnostics(run));
  assert.equal(run.result.signal, 'SIGKILL', diagnostics(run));
});

test('packet registry driver assertion failures report and terminate promptly', { timeout: 30_000 }, async (t) => {
  const startedAt = Date.now();
  const run = await runDriverChild(t, {
    extraArgs: ['--deliberate-driver-failure'],
    timeoutMs: 20_000,
  });
  assert.equal(run.outcome.kind, 'failure', diagnostics(run));
  assert.match(run.output, /deliberate packet registry driver assertion failure/, diagnostics(run));
  assert.ok(Date.now() - startedAt < 20_000, diagnostics(run));
});

}
