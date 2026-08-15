import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(THIS_FILE), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const SUCCESS = 'COWORK_E2E_DRIVER_SUCCESS';
const FAILURE = 'COWORK_E2E_DRIVER_FAILURE';
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitFor(check, description, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForPort(port) {
  return waitFor(() => new Promise((resolveReady) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolveReady(true); });
    socket.once('error', () => { socket.destroy(); resolveReady(false); });
  }), `broker port ${port}`);
}

function roomEnvelopes(messages) {
  return messages.flatMap((message) => {
    try { return [{ ...JSON.parse(message.text), source: message }]; }
    catch { return []; }
  });
}

if (process.argv.includes('--e2e-driver')) {
  test('standard SDK cowork mission-room driver', async (t) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-e2e-'));
    const peerStateDir = join(stateDir, 'peer-sdk');
    const cleanupErrors = [];
    const brokerErrors = [];
    let broker;
    let brokerExit;
    let peerHost;
    let coworkEnv;
    let completed = false;
    let driverFailure;
    const stage = (name) => process.stdout.write(`COWORK_E2E_STAGE ${name}\n`);

    async function runCli(args, timeoutMs = 35_000, expectedError) {
      const child = spawn(process.execPath, [CLI, '--json', ...args], {
        cwd: ROOT,
        env: coworkEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      let timer;
      const result = await Promise.race([
        new Promise((resolveExit) => {
          child.once('error', (error) => resolveExit({ error }));
          child.once('exit', (code, signal) => resolveExit({ code, signal }));
        }),
        new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout({ timeout: true }), timeoutMs); }),
      ]);
      clearTimeout(timer);
      if (result.timeout) {
        child.kill('SIGKILL');
        await new Promise((resolveExit) => child.once('exit', resolveExit));
        throw new Error(`CLI timed out: ${args.join(' ')}`);
      }
      if (result.error) throw result.error;
      let body;
      try { body = JSON.parse(stdout); }
      catch { throw new Error(`CLI returned invalid JSON (${args.join(' ')}): ${stdout}\n${stderr}`); }
      if (expectedError !== undefined && result.code !== 0 && body.ok === false && body.error?.code === expectedError) {
        return body.error;
      }
      if (result.code !== 0 || body.ok !== true) {
        throw new Error(`CLI failed (${args.join(' ')}): exit=${result.code} ${stdout}\n${stderr}`);
      }
      return body.result;
    }

    async function contacts(peer) {
      return (await peer.client.listContacts()).contacts;
    }

    async function messages(peer) {
      return peer.client.listIncomingMessages();
    }

    async function joinInvite(peer, invite) {
      return peer.client.addContact({ invite });
    }

    async function send(peer, roomCid, text, reply) {
      return peer.client.sendMessage({
        contact: roomCid,
        text,
        ...(reply === undefined ? {} : {
          reply_to_wire_id: reply.wire_id,
          ...(reply.sentence === undefined ? {} : { reply_to_sentence: reply.sentence }),
        }),
      });
    }

    async function createPeer(OursClient, name, token) {
      const client = new OursClient({
        url: `http://127.0.0.1:${peerHost.port}`,
        leaseToken: `cowork-e2e-${name.toLowerCase()}`,
        apiToken: token,
      });
      const created = await client.createIdentity({
        name,
        bio: `cowork E2E participant ${name}`,
        exposeLocal: false,
        localAutoAccept: true,
      });
      return { name, cid: created.info.cid, client };
    }

    t.after(async () => {
      if (coworkEnv) {
        try { await runCli(['stop'], 20_000); }
        catch (error) { cleanupErrors.push(new Error(`stop cowork daemon: ${error.message}`)); }
      }
      try { await peerHost?.close(); }
      catch (error) { cleanupErrors.push(new Error(`stop peer SDK: ${error.message}`)); }
      if (broker) {
        broker.kill('SIGKILL');
        try {
          await Promise.race([
            brokerExit,
            new Promise((_, reject) => setTimeout(() => reject(new Error('broker did not exit')), 5_000)),
          ]);
        } catch (error) { cleanupErrors.push(error); }
      }
      try { rmSync(stateDir, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
      process.stdout.write(completed && cleanupErrors.length === 0
        ? `${SUCCESS}\n`
        : `${FAILURE} ${JSON.stringify({
          driver: driverFailure?.stack ?? 'driver incomplete',
          cleanup: cleanupErrors.map((error) => error.stack ?? error.message),
          broker: brokerErrors.join('').slice(-4_000),
        })}\n`);
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'E2E cleanup failed');
    });

    try {
      assert(existsSync(CLI), 'build the daemon and CLI before running E2E');
      const port = await unusedPort();
      const configPath = join(stateDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        version: 1,
        brokerUrl: `ws://127.0.0.1:${port}`,
        stateDir,
        rest: { enabled: false, port: 3052 },
      }), { mode: 0o600 });
      coworkEnv = { ...process.env, OURS_COWORK_CONFIG: configPath };

      broker = spawn(process.execPath, [join(ROOT, 'node_modules/.bin/adapt-broker'), '--host', '127.0.0.1', '--port', String(port), '--test_mode'], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      broker.stderr.setEncoding('utf8').on('data', (chunk) => brokerErrors.push(chunk));
      brokerExit = new Promise((resolveExit) => {
        broker.once('error', (error) => resolveExit({ error }));
        broker.once('exit', (code, signal) => resolveExit({ code, signal }));
      });
      await waitForPort(port);
      stage('broker-ready');

      process.env.OURS_CONFIG = join(peerStateDir, 'config.json');
      process.env.OURS_STATE_DIR = peerStateDir;
      process.env.OURS_BROKER_URL = `ws://127.0.0.1:${port}`;
      process.env.OURS_PORT = '0';
      process.env.OURS_API_VISIBILITY = 'owner';
      process.env.OURS_TRANSPORT = 'http';
      process.env.OURS_AUTOSTART = 'false';
      process.env.OURS_GC_INTERVAL_MS = '3600000';
      delete process.env.OURS_API_TOKEN;
      const [{ OursClient }, { startDaemon }] = await Promise.all([
        import('@ours.network/sdk'),
        import('@ours.network/sdk/daemon'),
      ]);
      peerHost = await startDaemon({ version: '@ours.network/cowork-e2e', handleSignals: false });
      const token = readFileSync(join(peerStateDir, 'daemon-token'), 'utf8').trim();
      const [alice, bob, charlie] = await Promise.all([
        createPeer(OursClient, 'Alice', token),
        createPeer(OursClient, 'Bob', token),
        createPeer(OursClient, 'Charlie', token),
      ]);
      stage('participants-ready');

      await runCli(['start']);
      await waitFor(async () => (await runCli(['status'])).running === true, 'authenticated daemon status');
      stage('daemon-ready');

      const created = await runCli([
        'room', 'create', '--name', '  Cafe\u0301 launch 🤖  ',
        '--goal', 'Ship the release', '--briefing', 'Keep evidence and blockers explicit',
      ]);
      const roomId = created.room_id;
      const roomCid = created.identity_cid;
      assert.match(roomId, /^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
      assert.equal(created.room_name, 'Café launch 🤖');
      assert.equal(created.identity_name, `ours-cowork-${roomId}`);
      stage('room-created');

      const invitation = await runCli([
        'room', 'invite', roomId, '--mode', 'public', '--role', 'reviewer', '--min-accepts', '2',
      ]);
      await Promise.all([joinInvite(alice, invitation.blob), joinInvite(bob, invitation.blob)]);
      await waitFor(() => Promise.all([contacts(alice), contacts(bob)]).then(([a, b]) =>
        a.some((contact) => contact.container_id === roomCid)
          && b.some((contact) => contact.container_id === roomCid)), 'SDK invite redemptions');
      let room = await waitFor(async () => {
        const candidate = await runCli(['room', 'show', roomId]);
        return candidate.state === 'active' ? candidate : undefined;
      }, 'room activation');
      assert.deepEqual(new Set(room.seats.map((seat) => seat.identity)), new Set([alice.cid, bob.cid]));
      assert(room.seats.every((seat) => seat.role === 'reviewer'));
      stage('activated');

      const aliceBriefing = await waitFor(async () => (await messages(alice)).find((message) => {
        try { return JSON.parse(message.text).kind === 'room_briefing'; }
        catch { return false; }
      }), 'Alice SDK briefing');
      await waitFor(async () => (await messages(bob)).some((message) => {
        try { return JSON.parse(message.text).kind === 'room_briefing'; }
        catch { return false; }
      }), 'Bob SDK briefing');

      await send(alice, roomCid, 'participant relay from Alice');
      await waitFor(async () => roomEnvelopes(await messages(bob)).some((message) =>
        message.text === 'participant relay from Alice'
          && message.author.identity === alice.cid), 'participant SDK message relay');

      await send(alice, roomCid, 'reply through the room', { wire_id: aliceBriefing.wire_id, sentence: 1 });
      const replyRecord = await waitFor(async () => {
        const history = await runCli(['room', 'history', roomId, '--after', '0', '--limit', '1000']);
        return history.find((record) => record.kind === 'message' && record.text === 'reply through the room');
      }, 'archived SDK reply reference');
      assert.deepEqual(replyRecord.source_reply_to, { wire_id: aliceBriefing.wire_id, sentence: 1 });
      stage('messages-and-replies');

      const bytes = Buffer.from([0, 1, 2, 255, 0, 7]);
      await alice.client.sendFile({
        contact: roomCid,
        data_base64: bytes.toString('base64'),
        filename: 'alice-evidence.bin',
        mime: 'application/octet-stream',
        reply_to_wire_id: aliceBriefing.wire_id,
      });
      const fileMeta = await waitFor(async () => (await bob.client.listIncomingFiles())
        .find((file) => file.filename === 'alice-evidence.bin'), 'SDK file relay');
      await bob.client.getFiles({ wire_ids: [fileMeta.wire_id] });
      assert.deepEqual(Buffer.from(await bob.client.fetchFile(fileMeta.wire_id)), bytes);
      const archivedFile = await waitFor(async () => {
        const history = await runCli(['room', 'history', roomId, '--after', '0', '--limit', '1000']);
        return history.find((record) => record.kind === 'file' && record.filename === 'alice-evidence.bin');
      }, 'archived SDK file');
      assert.equal(archivedFile.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(archivedFile.source_reply_to, { wire_id: aliceBriefing.wire_id });
      stage('files');

      await runCli(['restart'], 45_000);
      room = await runCli(['room', 'show', roomId]);
      assert.equal(room.identity_cid, roomCid);
      assert.equal(room.identity_name, created.identity_name);
      const oldInvite = room.invites.find((invite) => invite.invite_id === invitation.invite.invite_id);
      assert.equal(oldInvite.state, 'replacement_required');
      const [replacement] = await runCli(['room', 'recover', roomId]);
      await joinInvite(charlie, replacement.blob);
      await waitFor(async () => (await contacts(charlie)).some((contact) => contact.container_id === roomCid),
        'Charlie recovered invite redemption');
      assert.equal((await runCli(['room', 'participants', roomId])).some((seat) => seat.identity === charlie.cid), false);
      await runCli([
        'room', 'recover', roomId, '--confirm', invitation.invite.invite_id, replacement.invite.invite_id,
      ]);
      await waitFor(async () => (await runCli(['room', 'participants', roomId]))
        .some((seat) => seat.identity === charlie.cid), 'confirmed recovered invite admission');
      stage('restart-and-recovery');

      const closed = await runCli(['room', 'close', roomId]);
      assert.equal(closed.state, 'closed');
      await waitFor(() => Promise.all([contacts(alice), contacts(bob), contacts(charlie)]).then((rows) =>
        rows.every((contactsList) => !contactsList.some((contact) => contact.container_id === roomCid))),
      'bilateral SDK contact removal');
      const roomDir = join(stateDir, 'rooms', roomId);
      assert.equal(existsSync(join(roomDir, 'room.json')), true);
      assert.equal(existsSync(join(roomDir, 'archive.jsonl')), true);
      const deleted = await runCli(['room', 'delete', roomId, '--yes']);
      assert.deepEqual(deleted, { version: 1, room_id: roomId, deleted: true, scope: 'this_host' });
      assert.equal(existsSync(roomDir), false);
      stage('closed-and-deleted');
      completed = true;
    } catch (error) {
      driverFailure = error;
      throw error;
    }
  });
} else {
  test('standalone daemon completes the real standard-SDK three-participant flow', async (t) => {
    const child = spawn(process.execPath, [THIS_FILE, '--e2e-driver'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let stages = 0;
    let watchdog;
    let settleTimeout;
    const timeout = new Promise((resolveTimeout) => { settleTimeout = resolveTimeout; });
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => settleTimeout('timeout'), 220_000);
    };
    const capture = (chunk) => {
      output += chunk.toString();
      const observedStages = output.split('COWORK_E2E_STAGE').length - 1;
      if (observedStages > stages) {
        stages = observedStages;
        armWatchdog();
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const exited = new Promise((resolveExit) => {
      child.once('error', (error) => resolveExit({ error, code: null, signal: null }));
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    let killed = false;
    async function killAndReap() {
      if (!killed) {
        killed = true;
        child.kill('SIGKILL');
      }
      return exited;
    }
    t.after(killAndReap);
    let settleOutcome;
    const terminal = new Promise((resolveOutcome) => { settleOutcome = resolveOutcome; });
    const inspect = () => {
      if (output.includes(SUCCESS)) settleOutcome('success');
      else if (output.includes(FAILURE)) settleOutcome('failure');
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    armWatchdog();
    const outcome = await Promise.race([terminal, exited.then(() => 'exit'), timeout]);
    clearTimeout(watchdog);
    const result = await killAndReap();
    assert.equal(outcome, 'success', `E2E driver ${outcome}; exit=${result.error?.message ?? result.signal ?? result.code}\n${output.slice(-16_000)}`);
    assert.equal(result.signal, 'SIGKILL', output.slice(-16_000));
  });
}
