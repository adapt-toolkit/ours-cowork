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
  HostedRoomPacket,
  adaptTimeToRfc3339,
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

function fakePacket(name = 'fake') {
  const submitted = [];
  const pw = {
    add_client_message(message) { submitted.push(message); },
    packet: {},
  };
  const terminal = [];
  const packet = new Packet(
    name,
    `${name}-cid`,
    pw,
    (error) => terminal.push(error),
    () => ({ Destroy() {} }),
  );
  wireHandlers(packet, { onSaveState: () => {}, onNotify: () => {} }, () => {});
  return { packet, pw, submitted, terminal };
}

function fakeReturnData(kind, payload = {}) {
  let destroyed = false;
  const leaf = (value) => ({
    Visualize: () => String(value),
    Detach() { return this; },
    Destroy() { destroyed = true; },
  });
  return {
    Attach(lifetime) { lifetime.Deposit(this); return this; },
    Reduce(key) {
      if (key === 'kind') return leaf(kind);
      if (key === 'payload') return leaf(payload);
      return leaf('');
    },
    Destroy() { destroyed = true; },
    get destroyed() { return destroyed; },
  };
}

async function settledWithin(promises, timeoutMs = 250) {
  return Promise.race([
    Promise.allSettled(promises),
    new Promise((_, reject) => setTimeout(() => reject(new Error('pending work did not settle')), timeoutMs)),
  ]);
}

if (!process.argv.includes('--packet-driver')) {
test('native ADAPT time rendering is normalized to strict RFC3339', () => {
  assert.equal(adaptTimeToRfc3339('2026-08-02 12:34:56.123456789 (UTC+0)'), '2026-08-02T12:34:56.123Z');
  assert.equal(adaptTimeToRfc3339('2026-08-02 14:34:56 (UTC+2)'), '2026-08-02T12:34:56.000Z');
  assert.equal(adaptTimeToRfc3339('2026-01-01T00:30:00+02:00'), '2025-12-31T22:30:00.000Z');
  assert.equal(adaptTimeToRfc3339('2024-02-29T23:59:59.1Z'), '2024-02-29T23:59:59.100Z');
  assert.equal(adaptTimeToRfc3339('2024-02-29 23:59:59.12 (UTC-2)'), '2024-03-01T01:59:59.120Z');
  assert.equal(adaptTimeToRfc3339('2026-08-02T12:34:56.123Z'), '2026-08-02T12:34:56.123Z');
  for (const invalid of [
    'not a time',
    '2023-02-29T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-02-30 00:00:00 (UTC+0)',
    '2026-13-01T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T23:60:00Z',
    '2026-01-01T23:59:60Z',
    '2026-01-01T00:00:00+99:99',
    '2026-01-01T00:00:00-00:00',
    '2026-01-01T00:00:00.1234Z',
    '2026-01-01 00:00:00Z',
    '2026-01-01t00:00:00z',
    '2026-01-01 00:00:00.1234567890 (UTC+0)',
    '2026-01-01 00:00:00 (UTC+02)',
    '2026-01-01 00:00:00 (UTC-0)',
    '2026-01-01 00:00:00 (UTC+24)',
  ]) assert.throws(() => adaptTimeToRfc3339(invalid), /unexpected ADAPT time/, invalid);
});

test('hosted sends propagate every rejected mutation and map only explicit refusal to send_failed', async () => {
  for (const failure of [
    new Error('timed out'),
    new Error('ambiguous transaction failure'),
    new Error('packet is closed'),
    new PacketPersistenceError('disk full'),
  ]) {
    const native = {
      name: 'fake-room', cid: 'cid-fake', pw: {},
      mutatingTx: async () => { throw failure; },
    };
    const hosted = new HostedRoomPacket(native, () => {}, () => {});
    await assert.rejects(hosted.send('cid-peer', 'body'), (error) => error === failure);
  }

  const nil = { IsNil: () => true, Visualize: () => '' };
  const refusal = {
    name: 'fake-room', cid: 'cid-fake', pw: {},
    mutatingTx: async () => ({
      Reduce: (key) => key === 'downgrade_refused' ? { IsNil: () => false } : nil,
    }),
  };
  const hosted = new HostedRoomPacket(refusal, () => {}, () => {});
  assert.deepEqual(await hosted.send('cid-peer', 'body'), { status: 'send_failed' });
});

test('hosted inbox consume uses one atomic expected-ID mutation', async () => {
  const calls = [];
  const list = (numbers) => ({
    IsNil: () => false,
    Reduce: (index) => index < numbers.length
      ? { IsNil: () => false, Visualize: () => String(numbers[index]) }
      : { IsNil: () => true },
  });
  const native = {
    name: 'fake-room', cid: 'cid-fake', pw: {},
    mutatingTx: async (name, target) => {
      calls.push({ name, target });
      return { Reduce: (key) => key === 'consumed' ? list([2]) : list([3, 4]) };
    },
  };
  const hosted = new HostedRoomPacket(native, () => {}, () => {});
  assert.deepEqual(await hosted.consumeInbox([2]), { consumed: [2], deferred: [3, 4] });
  assert.deepEqual(calls, [{ name: '::actor::consume_messages', target: { expected_ids: [2] } }]);
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
    if (process.argv.includes('--deliberate-driver-failure')) {
      assert.fail('deliberate packet registry driver assertion failure');
    }

    for (const stage of ['mkdir', 'identity', 'state', 'identity_applied']) {
      const roomId = `crash-${stage.replace('_', '-')}`;
      fs.mkdirSync(join(stateDir, 'rooms', roomId), { recursive: true, mode: 0o700 });
      const interruptions = stage === 'mkdir' ? 3 : 1;
      for (let attempt = 0; attempt < interruptions; attempt += 1) {
        let injected = false;
        const interrupted = new PacketRegistry(host, stateDir, {
          provisioningCheckpoint(observed) {
            if (!injected && observed === stage) {
              injected = true;
              throw new Error(`crash at ${stage}`);
            }
          },
        });
        await assert.rejects(interrupted.create(roomId, `Exact ${stage}`, `Exact bio ${stage}`), new RegExp(stage));
        const debris = fs.readdirSync(join(stateDir, 'rooms', roomId));
        assert(debris.filter((name) => name.startsWith('live.staging-')).length <= 1);
        assert(debris.filter((name) => name.startsWith('provisioning-residue')).length <= 1);
      }
      const resumed = new PacketRegistry(host, stateDir);
      const packet = await resumed.create(roomId, `Exact ${stage}`, `Exact bio ${stage}`);
      assert(packet.cid, `${stage} restart must establish one packet CID`);
      assert.equal(resumed.size, 1);
      await resumed.destroy(roomId);
    }

    const partialId = 'partial-probe';
    const partialLive = join(stateDir, 'rooms', partialId, 'live');
    fs.mkdirSync(partialLive, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(partialLive, 'unknown-user-byte'), 'preserve me');
    const partialRegistry = new PacketRegistry(host, stateDir);
    await partialRegistry.create(partialId, 'Exact partial', 'Exact partial bio');
    assert.equal(fs.readFileSync(join(stateDir, 'rooms', partialId, 'provisioning-residue', 'unknown-user-byte'), 'utf8'), 'preserve me');
    assert.equal(fs.readdirSync(join(stateDir, 'rooms', partialId)).filter((name) => name.startsWith('provisioning-residue')).length, 1);
    await partialRegistry.destroy(partialId);

    let failStateWrite = false;
    let holdRestore = false;
    let signalRestoreEntered;
    let releaseRestore;
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
    const registry = new PacketRegistry(host, stateDir, {
      persistence,
      beforeExpose: async (packet) => {
        if (!holdRestore) return;
        signalRestoreEntered(packet);
        await new Promise((done) => { releaseRestore = done; });
      },
    });
    const [alpha, beta, gamma] = await Promise.all([
      registry.create('alpha'),
      registry.create('beta'),
      registry.create('gamma'),
    ]);
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

    const fixtureDir = join(ROOT, 'tests', 'fixtures');
    const fixtureFile = fs.readdirSync(fixtureDir).find((name) => name.endsWith('.muflo'));
    assert(fixtureFile, 'compile the permissive fixture before packet tests');
    const { PacketWrapperConfigurator } = await import('@adapt-toolkit/sdk/wrappers');
    const attackerConfig = new PacketWrapperConfigurator();
    attackerConfig.process_arguments([
      '--unit_hash', fixtureFile.slice(0, -'.muflo'.length),
      '--seed_phrase', `attacker-${Date.now()}`,
      '--unit_dir_path', fixtureDir,
    ]);
    const attacker = await new Promise((resolveCreated) => {
      host.wrapper.packet_manager.create_packet(attackerConfig, (pw) => {
        const cid = pw.packet.GetContainerID().Visualize();
        const packet = new Packet('attacker', cid, pw);
        host.packets.set(cid, packet);
        host.exposedPackets.add(cid);
        resolveCreated(packet);
      }, new Uint8Array(fs.readFileSync(join(fixtureDir, fixtureFile))));
    });
    wireHandlers(attacker, { onSaveState: () => {}, onNotify: () => {} }, () => {});
    await withScopeAsync((lifetime) =>
      attacker.mutatingTx('::a2a_messaging::set_my_name', { name: 'Attacker' }, lifetime));
    const attackerInvite = await gamma.mintInvite('public');
    await withScopeAsync(async (lifetime) => {
      await attacker.mutatingTx('::a2a_messaging::add_contact', {
        invite: attacker.newBinary(unpackInvite(attackerInvite.blob), lifetime),
      }, lifetime);
    });
    await waitFor(
      () => gamma.listContacts().some((contact) => contact.container_id === attacker.cid),
      'attacker acceptance by gamma room',
    );

    await assert.rejects(
      gamma.packet.mutatingTx(
        '::a2a_messaging::send_file',
        {
          contact: attacker.cid,
          filename: 'blocked.txt',
          mime: 'text/plain',
          data: gamma.packet.newBinary(Buffer.from('blocked')),
        },
        undefined,
        250,
      ),
      /timed out waiting for transaction result/,
    );
    await attacker.mutatingTx('::a2a_messaging::send_file', {
      contact: gamma.cid,
      filename: 'inbound-blocked.txt',
      mime: 'text/plain',
      data: attacker.newBinary(Buffer.from('inbound blocked')),
    });
    await attacker.mutatingTx('::actor::call_external_sign', {
      target: gamma.cid,
      canonical_json: '{"version":1}',
    });
    await sleep(300);
    assert.equal(registry.get('gamma'), gamma, 'refused inbound transactions keep the registry entry');
    assert.equal(host.packetCount, 5, 'refused inbound transactions keep the native room packet');

    const alphaInvite = await alpha.mintInvite('public');
    await withScopeAsync(async (lifetime) => {
      await peer.mutatingTx('::a2a_messaging::add_contact', {
        invite: peer.newBinary(unpackInvite(alphaInvite.blob), lifetime),
      }, lifetime);
    });
    await waitFor(
      () => alpha.listContacts().some((contact) => contact.container_id === peer.cid),
      'peer acceptance by alpha room',
    );

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
      'unexpected arrivals remain unread in the same atomic consume transaction');

    failStateWrite = true;
    await assert.rejects(
      gamma.packet.mutatingTx(
        '::a2a_messaging::send_message',
        { contact: peer.cid, text: 'must-not-escape' },
        undefined,
        250,
      ),
      /timed out waiting for transaction result/,
    );
    await sleep(500);
    assert.equal(renderRawInbox(peer).some((message) => message.text === 'must-not-escape'), false,
      'SEND must stay buffered when state persistence fails');
    failStateWrite = false;

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
    const beforeMismatchCount = host.packetCount;
    await assert.rejects(
      registry.restore('alpha', 'cid-that-must-not-match'),
      /CID mismatch.*expected.*cid-that-must-not-match/i,
    );
    assert.equal(registry.get('alpha'), undefined, 'CID mismatch must not enter the registry');
    assert.equal(host.packetCount, beforeMismatchCount, 'CID mismatch must remove the quarantined native packet');
    assert.equal(host.isPacketExposed(alphaCid), false, 'CID mismatch must never expose the restored CID');
    holdRestore = true;
    const restoreEntered = new Promise((done) => { signalRestoreEntered = done; });
    const restorePromise = registry.restore('alpha', alphaCid);
    const quarantined = await restoreEntered;
    assert.equal(quarantined.cid, alphaCid);
    assert.equal(host.isPacketExposed(alphaCid), false,
      'restored CID must remain quarantined through import and handler wiring');
    await withScopeAsync((lifetime) =>
      peer.mutatingTx('::a2a_messaging::send_message', {
        contact: alphaCid,
        text: 'queued-before-exposure',
      }, lifetime));
    await sleep(300);
    assert.equal(quarantined.peekInbox().some((message) => message.text === 'queued-before-exposure'), false,
      'early traffic must not execute locally while the restored packet is quarantined');
    releaseRestore();
    const restored = await restorePromise;
    holdRestore = false;
    assert.equal(restored.cid, alphaCid, 'restored signing secret must reproduce the CID');
    assert.equal(host.isPacketExposed(alphaCid), true);
    assert.equal(restored.peekInbox().some((message) => message.text === 'queued-before-exposure'), false,
      'offline broker traffic must not have executed against pre-import packet state');
    await withScopeAsync((lifetime) =>
      peer.mutatingTx('::a2a_messaging::send_message', {
        contact: alphaCid,
        text: 'sent-after-exposure',
      }, lifetime));
    await waitFor(
      () => restored.peekInbox().some((message) => message.text === 'sent-after-exposure'),
      'traffic after imported state is exposed',
    );

    const removable = await host.createPacket('pending-removal', `pending-${Date.now()}`);
    wireHandlers(removable, { onSaveState: () => {}, onNotify: () => {} }, () => {});
    let removalSubmissions = 0;
    removable.pw.add_client_message = () => { removalSubmissions += 1; };
    const activeRemoval = removable.mutatingTx('active-removal', {});
    const queuedRemoval = removable.mutatingTx('queued-removal', {});
    await new Promise((done) => setImmediate(done));
    host.removePacket(removable.cid, new Error('removed with pending work'));
    const removalOutcomes = await settledWithin([activeRemoval, queuedRemoval]);
    assert.deepEqual(removalOutcomes.map((outcome) => outcome.status), ['rejected', 'rejected']);
    assert.equal(removalSubmissions, 1, 'native remove must close before queued work can submit');

    await registry.destroy('alpha');
    await registry.destroy('gamma');
    host.removePacket(peer.cid);
    host.removePacket(attacker.cid);
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

test('unknown live state uses one fixed quarantine and never suffixes or overwrites an existing residue', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ours-cowork-residue-bound-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roomId = 'bounded-room';
  const roomDir = join(root, 'rooms', roomId);
  fs.mkdirSync(join(roomDir, 'live'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(roomDir, 'provisioning-residue'), { mode: 0o700 });
  fs.writeFileSync(join(roomDir, 'live', 'unknown-live'), 'live');
  fs.writeFileSync(join(roomDir, 'provisioning-residue', 'unknown-residue'), 'residue');
  const registry = new PacketRegistry({ createPacket: () => assert.fail('must fail before native create') }, root);
  await assert.rejects(registry.create(roomId), /unknown live state.*existing provisioning residue/i);
  assert.equal(fs.readFileSync(join(roomDir, 'live', 'unknown-live'), 'utf8'), 'live');
  assert.equal(fs.readFileSync(join(roomDir, 'provisioning-residue', 'unknown-residue'), 'utf8'), 'residue');
  assert.deepEqual(fs.readdirSync(roomDir).sort(), ['live', 'provisioning-residue']);
  assert.doesNotMatch(readFileSync(new URL('../src/packets.ts', import.meta.url), 'utf8'), /provisioning-residue-\$\{/);
});

test('PacketRegistry public lifecycle surface is standalone', () => {
  assert.equal(typeof PacketRegistry, 'function');
  const externalDaemonPattern = new RegExp(`${['ours', 'mcp'].join('-')}|@ours\\.network\\/${'mcp'}`);
  const source = readFileSync(new URL('../src/packets.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, externalDaemonPattern);
  const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
  assert.match(daemon, /class DaemonSupervisor/);
  assert.match(daemon, /runSupervisor/);
  const runtime = readFileSync(new URL('../src/daemon-runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /class CoworkDaemon/);
  assert.doesNotMatch(daemon, externalDaemonPattern);
  assert.doesNotMatch(runtime, externalDaemonPattern);
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.match(cli, /function roomRequest/);
  assert.match(cli, /management\.sock/);
  assert.doesNotMatch(cli, /from ['"]\.\/(?:adapt|packets|service|transports|daemon-runtime)/);
  assert.doesNotMatch(cli, externalDaemonPattern);
});

test('daemon unhosting removes runtime packets without purging restart state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cowork-unhost-'));
  const roomId = '01jz6y7n8p9q0r1s2t3v4w5x6y';
  const liveDir = join(root, 'rooms', roomId, 'live');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(join(liveDir, 'identity.key'), 'secret');
  fs.writeFileSync(join(liveDir, 'state_data.bin'), 'state');
  const removed = [];
  const host = { removePacket(cid) { removed.push(cid); } };
  const registry = new PacketRegistry(host, root);
  registry.packets.set(roomId, { cid: 'cid-room', name: `cowork-room-${roomId}` });
  await registry.unhostAll();
  assert.deepEqual(removed, ['cid-room']);
  assert.equal(registry.size, 0);
  assert.equal(fs.readFileSync(join(liveDir, 'identity.key'), 'utf8'), 'secret');
  assert.equal(fs.readFileSync(join(liveDir, 'state_data.bin'), 'utf8'), 'state');
  rmSync(root, { recursive: true, force: true });
});

test('AdaptHost shutdown uses an explicit wrapper stop adapter and otherwise requires process exit', async () => {
  const unit = { dir: '/unused', hash: 'fake', contents: new Uint8Array() };
  const calls = [];
  const adapted = new AdaptHost('ws://broker', () => {}, {
    unit,
    shutdownWrapper: async (wrapper) => calls.push(wrapper),
  });
  const wrapper = { packet_manager: {} };
  adapted.wrapper = wrapper;
  assert.deepEqual(await adapted.shutdown(), { requiresProcessExit: false });
  assert.deepEqual(calls, [wrapper]);
  assert.equal(adapted.wrapper, undefined);

  const nativeBoundary = new AdaptHost('ws://broker', () => {}, { unit });
  nativeBoundary.wrapper = { packet_manager: {} };
  assert.deepEqual(await nativeBoundary.shutdown(), { requiresProcessExit: true });
  assert.equal(nativeBoundary.wrapper, undefined);
});

test('AdaptHost shutdown always attempts wrapper stop and aggregates packet and wrapper failures', async () => {
  const packetFailure = new Error('packet removal failed');
  const wrapperFailure = new Error('wrapper stop failed');
  const host = new AdaptHost('ws://broker', () => {}, {
    unit: { dir: '/unused', hash: 'fake', contents: new Uint8Array() },
    shutdownWrapper: async () => { throw wrapperFailure; },
  });
  host.wrapper = { remove_packet() { throw packetFailure; }, packet_manager: {} };
  host.packets.set('cid', { close() {} });
  await assert.rejects(host.shutdown(), (error) => error instanceof AggregateError
    && error.errors.some((nested) => nested instanceof AggregateError && nested.errors.includes(packetFailure))
    && error.errors.includes(wrapperFailure)
    && error.requiresProcessExit === true);
  assert.equal(host.wrapper, undefined);
});

test('unrelated transaction failure cannot consume an overlapping local result or release its queued call', async () => {
  const { packet, pw, submitted, terminal } = fakePacket('ambiguous');
  const first = packet.mutatingTx('local-first', {});
  const second = packet.mutatingTx('local-second', {});
  await new Promise((done) => setImmediate(done));
  assert.equal(submitted.length, 1);
  pw.on_transaction_failure('unrelated inbound refusal');
  assert.equal(submitted.length, 1);
  pw.on_return_data(fakeReturnData('return_data', { call: 'late-first' }));
  assert.equal((await first).Visualize(), '[object Object]');
  await new Promise((done) => setImmediate(done));
  assert.equal(submitted.length, 2);
  pw.on_return_data(fakeReturnData('return_data', { call: 'second' }));
  assert.equal((await second).Visualize(), '[object Object]');
  assert.equal(terminal.length, 0);

  pw.on_transaction_failure('inbound rejection with no local call');
  const future = packet.mutatingTx('future', {});
  await new Promise((done) => setImmediate(done));
  pw.on_return_data(fakeReturnData('return_data', { call: 'future' }));
  await future;
  assert.equal(terminal.length, 0);
});

test('failed local callback times out through a tombstone, swallows its late result, and lets the next call proceed', async () => {
  const { packet, pw, submitted, terminal } = fakePacket('failed-local');
  const first = packet.mutatingTx('local-first', {}, undefined, 10);
  const second = packet.mutatingTx('local-second', {}, undefined, 100);
  await new Promise((done) => setImmediate(done));
  pw.on_transaction_failure('genuine local failure');
  await assert.rejects(first, /timed out/);
  assert.equal(submitted.length, 1, 'expired call must hold the submission barrier');
  pw.on_return_data(fakeReturnData('return_data', { call: 'late-first' }));
  await new Promise((done) => setImmediate(done));
  assert.equal(submitted.length, 2, 'late result consumes only the expired tombstone');
  pw.on_return_data(fakeReturnData('return_data', { call: 'second' }));
  await second;
  assert.equal(terminal.length, 0);
});

test('expired tombstone releases after a bounded drain and teardown never rejects an expired call twice', async () => {
  const { packet, pw, submitted, terminal } = fakePacket('bounded-expiry');
  let firstRejects = 0;
  const first = packet.mutatingTx('first', {}, undefined, 10).catch((error) => {
    firstRejects += 1;
    throw error;
  });
  const second = packet.mutatingTx('second', {}, undefined, 200);
  await assert.rejects(first, /timed out/);
  await sleep(80);
  assert.equal(submitted.length, 2, 'bounded tombstone drain must release the next submission');
  packet.close(new Error('explicit teardown'));
  await assert.rejects(second, /explicit teardown/);
  assert.equal(firstRejects, 1);
  assert.equal(terminal.length, 1);
  pw.on_return_data(fakeReturnData('return_data', { call: 'late-after-close' }));
  assert.equal(firstRejects, 1);
});

test('Packet.close rejects active and queued work before another envelope is submitted', async () => {
  const { packet, submitted } = fakePacket('close');
  const first = packet.mutatingTx('active', {});
  const second = packet.mutatingTx('queued', {});
  await new Promise((done) => setImmediate(done));
  packet.close(new Error('explicit packet teardown'));
  const outcomes = await settledWithin([first, second]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected']);
  assert.equal(submitted.length, 1);
  await assert.rejects(packet.mutatingTx('future', {}), /explicit packet teardown/);
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
