import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(THIS_FILE), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const UNIT_DIR = join(ROOT, 'mufl_code');
const SUCCESS = 'COWORK_E2E_DRIVER_SUCCESS';
const FAILURE = 'COWORK_E2E_DRIVER_FAILURE';
const NATIVE_CLI_TIMEOUT_MS = 125_000;
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

async function waitFor(check, description, timeoutMs = 20_000) {
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

function renderMessages(value) {
  const messages = [];
  for (let index = 0; ; index += 1) {
    const message = value.Reduce(index);
    if (message.IsNil()) break;
    messages.push({
      msg_id: Number(message.Reduce('msg_id').Visualize()),
      sender_id: message.Reduce('sender_id').Visualize(),
      sender_name: message.Reduce('sender_name').Visualize(),
      text: message.Reduce('text').Visualize(),
      status: message.Reduce('status').Visualize(),
    });
  }
  return messages;
}

function renderFiles(value) {
  const files = [];
  for (let index = 0; ; index += 1) {
    const file = value.Reduce(index);
    if (file.IsNil()) break;
    files.push({
      file_id: Number(file.Reduce('file_id').Visualize()),
      sender_id: file.Reduce('sender_id').Visualize(),
      sender_name: file.Reduce('sender_name').Visualize(),
      filename: file.Reduce('filename').Visualize(),
      mime: file.Reduce('mime').Visualize(),
      data: Buffer.from(file.Reduce('data').GetBinary()),
      status: file.Reduce('status').Visualize(),
    });
  }
  return files;
}

function roomEnvelopes(peer) {
  return peer.inbox().flatMap((message) => {
    try { return [{ ...JSON.parse(message.text), sender_id: message.sender_id }]; }
    catch { return []; }
  });
}

if (process.argv.includes('--e2e-driver')) {
  test('standalone cowork mission-room driver', async (t) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-e2e-'));
    const packets = [];
    const cleanupErrors = [];
    const brokerErrors = [];
    let broker;
    let brokerExit;
    let wrapper;
    let env;
    let completed = false;
    let driverFailure;
    const stage = (name) => process.stdout.write(`COWORK_E2E_STAGE ${name}\n`);

    const nativeCommands = new Set(['create', 'invite', 'revoke', 'message', 'close', 'recover']);
    const cliTimeout = (args) => args[0] === 'room' && nativeCommands.has(args[1])
      ? NATIVE_CLI_TIMEOUT_MS
      : 35_000;

    async function runCli(args, timeoutMs = cliTimeout(args), expectedError) {
      const child = spawn(process.execPath, [CLI, '--json', ...args], {
        cwd: ROOT,
        env,
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
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout({ timeout: true }), timeoutMs);
        }),
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

    function readonly(peer, name) {
      return peer.pw.packet.ExecuteTransaction(peer.objectToValue({ name, targ: undefined }));
    }

    function mutate(peer, name, targ) {
      return new Promise((resolveResult, rejectResult) => {
        const timer = setTimeout(() => rejectResult(new Error(`${peer.name}.${name} timed out`)), 25_000);
        peer.pending.push({ resolve: resolveResult, reject: rejectResult, timer });
        peer.pw.add_client_message(peer.objectToValue({ name, targ }));
      });
    }

    async function createPeer(name, seed, unit, PacketWrapperConfigurator, objectToValue) {
      const config = new PacketWrapperConfigurator();
      config.process_arguments(['--unit_hash', unit.hash, '--seed_phrase', seed, '--unit_dir_path', unit.dir]);
      const peer = { name, cid: '', pw: undefined, pending: [], rejects: [], objectToValue };
      await new Promise((resolveCreated, rejectCreated) => {
        const timer = setTimeout(() => rejectCreated(new Error(`${name} creation timed out`)), 30_000);
        wrapper.packet_manager.create_packet(config, (pw) => {
          clearTimeout(timer);
          peer.pw = pw;
          peer.cid = pw.packet.GetContainerID().Visualize();
          pw.on_return_data = (data) => {
            const kind = data.Reduce('kind').Visualize();
            if (kind === 'save_state' || kind === 'notify_agent') return;
            const pending = peer.pending.shift();
            if (!pending) return;
            clearTimeout(pending.timer);
            pending.resolve(data.Reduce('payload'));
          };
          pw.on_transaction_failure = (message) => {
            const pending = peer.pending.shift();
            if (pending) {
              clearTimeout(pending.timer);
              pending.reject(new Error(String(message)));
            } else peer.rejects.push(String(message));
          };
          resolveCreated();
        }, unit.bytes);
      });
      peer.inbox = () => renderMessages(readonly(peer, '::actor::list_incoming_messages'));
      peer.fileInbox = () => renderFiles(readonly(peer, '::actor::list_incoming_files'));
      peer.contacts = () => readonly(peer, '::a2a_messaging::list_contacts').Visualize();
      packets.push(peer);
      await mutate(peer, '::a2a_messaging::set_my_name', { name });
      return peer;
    }

    async function joinInvite(peer, encoded) {
      const raw = brotliDecompressSync(Buffer.from(encoded, 'base64url'));
      const invite = peer.pw.packet.NewBinaryFromBuffer(raw);
      await mutate(peer, '::a2a_messaging::add_contact', { invite });
    }

    async function send(peer, roomCid, text) {
      await mutate(peer, '::a2a_messaging::send_message', { contact: roomCid, text });
    }

    async function sendFile(peer, roomCid, filename, mime, data) {
      await mutate(peer, '::a2a_messaging::send_file', {
        contact: roomCid,
        filename,
        mime,
        data: peer.pw.packet.NewBinaryFromBuffer(Buffer.from(data)),
      });
    }

    async function getFiles(peer) {
      return renderFiles((await mutate(peer, '::actor::get_files', {})).Reduce('files'));
    }

    t.after(async () => {
      for (const packet of packets) {
        try { wrapper?.remove_packet(packet.cid); }
        catch (error) { cleanupErrors.push(new Error(`remove ${packet.name}: ${error.message}`)); }
      }
      if (env) {
        try { await runCli(['stop'], 20_000); }
        catch (error) { cleanupErrors.push(new Error(`stop daemon: ${error.message}`)); }
      }
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
      const unitFile = readdirSync(UNIT_DIR).find((name) => name.endsWith('.muflo'));
      assert(unitFile, 'compile the cowork packet before running E2E');
      const port = await unusedPort();
      const configPath = join(stateDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        version: 1,
        brokerUrl: `ws://127.0.0.1:${port}`,
        stateDir,
        rest: { enabled: false, port: 3052 },
      }), { mode: 0o600 });
      env = {
        ...process.env,
        OURS_COWORK_CONFIG: configPath,
      };

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

      const [{ adapt_wrapper }, { PacketWrapperConfigurator }, { object_to_adapt_value }] = await Promise.all([
        import('@adapt-toolkit/sdk/executables'),
        import('@adapt-toolkit/sdk/wrappers'),
        import('@adapt-toolkit/sdk/wrapper'),
      ]);
      wrapper = await adapt_wrapper.start([
        '--broker_address', `ws://127.0.0.1:${port}`,
        '--test_mode',
        '--logger_config', '--level', 'WARNING', '--stdout', 'stderr', '--logger_config_end',
      ]);
      wrapper.start();
      const unit = {
        dir: UNIT_DIR,
        hash: unitFile.slice(0, -'.muflo'.length),
        bytes: new Uint8Array(readFileSync(join(UNIT_DIR, unitFile))),
      };
      const [alice, bob, charlie] = await Promise.all([
        createPeer('Alice', `e2e-alice-${Date.now()}`, unit, PacketWrapperConfigurator, object_to_adapt_value),
        createPeer('Bob', `e2e-bob-${Date.now()}`, unit, PacketWrapperConfigurator, object_to_adapt_value),
        createPeer('Charlie', `e2e-charlie-${Date.now()}`, unit, PacketWrapperConfigurator, object_to_adapt_value),
      ]);
      stage('participants-ready');

      await runCli(['start']);
      await waitFor(async () => (await runCli(['status'])).running === true, 'authenticated daemon status');
      stage('daemon-ready');

      // Prove invite behavior with effects, not receipt metadata. Separate room
      // CIDs ensure a refused one-time attempt cannot leave a peer handshake
      // that interferes with the independent public-reuse proof.
      const oneTimeProof = await runCli(['room', 'create', '--goal', 'Prove one-time semantics', '--briefing', 'One-time proof briefing']);
      const proofOneTime = await runCli(['room', 'invite', oneTimeProof.room_id, '--mode', 'one_time', '--role', 'single', '--min-accepts', '1']);
      await joinInvite(alice, proofOneTime.blob);
      await waitFor(() => alice.contacts().includes(oneTimeProof.identity_cid), 'first one-time redemption');
      await joinInvite(bob, proofOneTime.blob);

      const publicProof = await runCli(['room', 'create', '--goal', 'Prove public semantics', '--briefing', 'Public proof briefing']);
      const proofPublic = await runCli(['room', 'invite', publicProof.room_id, '--mode', 'public', '--role', 'shared', '--min-accepts', '2']);
      await Promise.all([joinInvite(bob, proofPublic.blob), joinInvite(charlie, proofPublic.blob)]);
      await waitFor(() => bob.contacts().includes(publicProof.identity_cid)
        && charlie.contacts().includes(publicProof.identity_cid), 'two public invite redemptions');
      await waitFor(async () => (await runCli(['room', 'show', publicProof.room_id])).state === 'active',
        'public acceptance notification activation');
      await waitFor(() => !bob.contacts().includes(oneTimeProof.identity_cid), 'second one-time redemption refusal');
      await runCli(['restart']);
      const oneTimeRoom = await runCli(['room', 'show', oneTimeProof.room_id]);
      const publicRoom = await runCli(['room', 'show', publicProof.room_id]);
      assert.equal(oneTimeRoom.state, 'active');
      assert.equal(publicRoom.state, 'active');
      assert.deepEqual(oneTimeRoom.seats.map((seat) => [seat.identity, seat.role, seat.invite_id]), [
        [alice.cid, 'single', proofOneTime.invite.invite_id],
      ]);
      assert.deepEqual(
        publicRoom.seats.map((seat) => [seat.identity, seat.role, seat.invite_id]).sort(([left], [right]) => left.localeCompare(right)),
        [
          [bob.cid, 'shared', proofPublic.invite.invite_id],
          [charlie.cid, 'shared', proofPublic.invite.invite_id],
        ].sort(([left], [right]) => left.localeCompare(right)),
      );
      assert.deepEqual(
        oneTimeRoom.invites.find((invite) => invite.invite_id === proofOneTime.invite.invite_id).accepted_cids,
        [alice.cid],
        'the second one-time redemption is refused and never admitted',
      );
      assert.equal(bob.contacts().includes(oneTimeProof.identity_cid), false);
      assert.deepEqual(
        new Set(publicRoom.invites.find((invite) => invite.invite_id === proofPublic.invite.invite_id).accepted_cids),
        new Set([bob.cid, charlie.cid]),
        'one public blob admits two distinct exact origins',
      );
      await runCli(['room', 'close', oneTimeProof.room_id]);
      await runCli(['room', 'close', publicProof.room_id]);
      await runCli(['room', 'delete', oneTimeProof.room_id, '--yes']);
      await runCli(['room', 'delete', publicProof.room_id, '--yes']);
      stage('invite-redemption-semantics');

      const created = await runCli(['room', 'create', '--goal', 'Ship the release', '--briefing', 'Keep evidence and blockers explicit']);
      const roomId = created.room_id;
      const roomCid = created.identity_cid;
      stage('room-created');
      assert.match(roomId, /^[0-7][0-9a-hjkmnp-tv-z]{25}$/);

      const oneTime = await runCli(['room', 'invite', roomId, '--mode', 'one_time', '--role', 'lead', '--min-accepts', '1']);
      const publicInvite = await runCli(['room', 'invite', roomId, '--mode', 'public', '--role', 'reviewer', '--min-accepts', '1']);
      assert.equal(oneTime.invite.mode, 'one_time');
      assert.equal(oneTime.reusable, false);
      assert.equal(publicInvite.invite.mode, 'public');
      assert.equal(publicInvite.reusable, true);

      await joinInvite(alice, oneTime.blob);
      await waitFor(() => alice.contacts().includes(roomCid), 'Alice one-time contact');
      let room = await waitFor(async () => {
        const candidate = await runCli(['room', 'show', roomId]);
        return candidate.seats.some((seat) => seat.identity === alice.cid) ? candidate : undefined;
      }, 'Alice acceptance notification admission');
      assert.equal(room.state, 'provisioning', 'public min_accepts keeps the room provisioning');
      assert.deepEqual(room.seats.map(({ identity, role, invite_id }) => ({ identity, role, invite_id })), [{
        identity: alice.cid, role: 'lead', invite_id: oneTime.invite.invite_id,
      }]);
      stage('one-time-admitted');

      await joinInvite(bob, publicInvite.blob);
      await waitFor(() => bob.contacts().includes(roomCid), 'Bob public contact');
      await send(bob, roomCid, 'immediate message after acceptance');
      room = await waitFor(async () => {
        const candidate = await runCli(['room', 'show', roomId]);
        return candidate.state === 'active' ? candidate : undefined;
      }, 'room activation at exact minimum');
      assert.equal(room.invites.find((invite) => invite.invite_id === publicInvite.invite.invite_id).min_accepts, 1);
      assert.deepEqual(room.seats.map((seat) => [seat.identity, seat.role, seat.invite_id]), [
        [alice.cid, 'lead', oneTime.invite.invite_id],
        [bob.cid, 'reviewer', publicInvite.invite.invite_id],
      ]);
      await waitFor(() => roomEnvelopes(alice).some((message) => message.kind === 'room_briefing' && message.text === created.mission.briefing), 'Alice initial briefing');
      await waitFor(() => roomEnvelopes(bob).some((message) => message.kind === 'room_briefing' && message.text === created.mission.briefing), 'Bob initial briefing');
      await waitFor(() => roomEnvelopes(alice).some((message) => message.text === 'immediate message after acceptance'
        && message.author.identity === bob.cid), 'immediate accepted participant message relay');
      stage('activated-and-briefed');

      await send(alice, roomCid, 'participant relay from Alice');
      await waitFor(() => roomEnvelopes(bob).some((message) => message.text === 'participant relay from Alice'
        && message.author.identity === alice.cid && message.author.role === 'lead'), 'participant relay with exact attribution');
      assert.equal(roomEnvelopes(alice).some((message) => message.text === 'participant relay from Alice'), false);
      stage('participant-relayed');

      const aliceBytes = Buffer.from([0, 1, 2, 255, 0, 7]);
      await sendFile(alice, roomCid, 'alice-evidence.bin', 'application/octet-stream', aliceBytes);
      await waitFor(
        () => bob.fileInbox().some((file) => file.filename === 'alice-evidence.bin'),
        'Alice file relayed through room to Bob inbox',
      );
      let received = await getFiles(bob);
      assert.equal(received.length, 1);
      assert.equal(received[0].sender_id, roomCid);
      assert.equal(received[0].mime, 'application/octet-stream');
      assert.deepEqual(received[0].data, aliceBytes);
      assert.equal(received[0].status, 'processed');
      await waitFor(() => roomEnvelopes(bob).some((message) => message.kind === 'room_file'
        && message.filename === 'alice-evidence.bin'
        && message.author.identity === alice.cid), 'Alice signed file metadata at Bob');

      const bobBytes = Buffer.from('Bob evidence with NUL\0and UTF-8 ✓');
      await sendFile(bob, roomCid, 'bob-evidence.txt', 'text/plain; charset=utf-8', bobBytes);
      await waitFor(
        () => alice.fileInbox().some((file) => file.filename === 'bob-evidence.txt'),
        'Bob file relayed through room to Alice inbox',
      );
      received = await getFiles(alice);
      assert.equal(received.length, 1);
      assert.equal(received[0].sender_id, roomCid);
      assert.equal(received[0].mime, 'text/plain; charset=utf-8');
      assert.deepEqual(received[0].data, bobBytes);
      assert.equal(received[0].status, 'processed');
      await waitFor(() => roomEnvelopes(alice).some((message) => message.kind === 'room_file'
        && message.filename === 'bob-evidence.txt'
        && message.author.identity === bob.cid), 'Bob signed file metadata at Alice');
      stage('files-relayed-both-directions');

      const operatorRecord = await runCli(['room', 'message', roomId, '--text', 'operator voice']);
      assert.equal(operatorRecord.author.identity, roomCid);
      assert.equal(operatorRecord.author.role, 'room');
      await waitFor(() => [alice, bob].every((peer) => roomEnvelopes(peer).some((message) =>
        message.text === 'operator voice' && message.author.identity === roomCid)), 'operator voice fan-out');
      stage('operator-relayed');

      const firstPage = await runCli(['room', 'history', roomId, '--after', '0', '--limit', '2']);
      assert.equal(firstPage.length, 2);
      assert(firstPage.every((record) => Number.isSafeInteger(record.seq)));
      const secondPage = await runCli(['room', 'history', roomId, '--after', String(firstPage.at(-1).seq), '--limit', '2']);
      assert(secondPage.length > 0);
      assert(secondPage.every((record) => record.seq > firstPage.at(-1).seq));
      stage('history-paged');

      await runCli(['restart']);
      room = await runCli(['room', 'show', roomId]);
      assert.equal(room.identity_cid, roomCid, 'room CID is stable across daemon restart');
      const oldPublic = room.invites.find((invite) => invite.invite_id === publicInvite.invite.invite_id);
      assert.equal(oldPublic.state, 'replacement_required');
      const replacements = await runCli(['room', 'recover', roomId]);
      assert.equal(replacements.length, 1);
      const replacement = replacements[0];
      assert.equal(replacement.recovery_of, publicInvite.invite.invite_id);
      assert.notEqual(replacement.invite.invite_id, publicInvite.invite.invite_id);
      assert.equal(replacement.invite.state, 'receipt_pending');
      stage('restarted-and-replaced');

      await joinInvite(charlie, replacement.blob);
      await waitFor(() => charlie.contacts().includes(roomCid), 'Charlie replacement contact');
      assert.equal((await runCli(['room', 'participants', roomId])).some((seat) => seat.identity === charlie.cid), false);
      await send(charlie, roomCid, 'refused non-seat message');
      await runCli(['room', 'message', roomId, '--text', 'non-seat processing barrier']);
      const afterRefusal = await runCli(['room', 'history', roomId, '--after', '0', '--limit', '1000']);
      assert.equal(afterRefusal.some((record) => record.kind === 'message' && record.text === 'refused non-seat message'), false);
      assert.equal([alice, bob].some((peer) => roomEnvelopes(peer).some((message) => message.text === 'refused non-seat message')), false);
      stage('non-seat-refused');

      await runCli(['room', 'recover', roomId, '--confirm', publicInvite.invite.invite_id, replacement.invite.invite_id]);
      const seats = await runCli(['room', 'participants', roomId]);
      const charlieSeat = seats.find((seat) => seat.identity === charlie.cid);
      assert.deepEqual(
        { role: charlieSeat.role, invite_id: charlieSeat.invite_id },
        { role: 'reviewer', invite_id: replacement.invite.invite_id },
      );
      await waitFor(() => roomEnvelopes(charlie).some((message) => message.kind === 'room_briefing'
        && message.text === created.mission.briefing), 'late participant briefing');
      const historyAfterLateJoin = await runCli(['room', 'history', roomId, '--after', '0', '--limit', '1000']);
      const briefingMessages = historyAfterLateJoin.filter((record) => record.kind === 'message' && record.category === 'briefing');
      assert.deepEqual(briefingMessages.map((record) => record.recipient_identities), [[alice.cid, bob.cid], [charlie.cid]]);
      stage('late-seat-briefed');

      await send(charlie, roomCid, 'late participant relay');
      await waitFor(() => [alice, bob].every((peer) => roomEnvelopes(peer).some((message) =>
        message.text === 'late participant relay' && message.author.identity === charlie.cid)), 'late participant relay');
      stage('late-seat-relayed');

      const closed = await runCli(['room', 'close', roomId]);
      assert.equal(closed.state, 'closed');
      await waitFor(() => [alice, bob, charlie].every((peer) => !peer.contacts().includes(roomCid)), 'bilateral contact removal');
      const roomDir = join(stateDir, 'rooms', roomId);
      assert.equal(existsSync(join(roomDir, 'live')), false, 'closed room has empty live residue');
      assert.equal(existsSync(join(roomDir, 'room.json')), true, 'closed metadata is retained');
      assert.equal(existsSync(join(roomDir, 'archive.jsonl')), true, 'closed archive is retained');
      assert(readFileSync(join(roomDir, 'archive.jsonl'), 'utf8').trim().length > 0);
      assert((await runCli(['room', 'history', roomId, '--after', '0', '--limit', '1000'])).length > 0);
      stage('closed-and-retained');

      const deleted = await runCli(['room', 'delete', roomId, '--yes']);
      assert.deepEqual(deleted, { version: 1, room_id: roomId, deleted: true, scope: 'this_host' });
      assert.equal(existsSync(roomDir), false, 'confirmed delete removes retained host state');
      stage('deleted');
      completed = true;
    } catch (error) {
      driverFailure = error;
      throw error;
    }
  });
} else {
  test('standalone daemon completes the real three-participant mission-room flow', async (t) => {
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
    const outcome = await Promise.race([
      terminal,
      exited.then(() => 'exit'),
      timeout,
    ]);
    clearTimeout(watchdog);
    const result = await killAndReap();
    assert.equal(outcome, 'success', `E2E driver ${outcome}; exit=${result.error?.message ?? result.signal ?? result.code}\n${output.slice(-16_000)}`);
    assert.equal(result.signal, 'SIGKILL', output.slice(-16_000));
  });
}
