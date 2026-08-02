import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(THIS_FILE), '..');
const UNIT_DIR = resolve(ROOT, 'mufl_code');
const FIXTURE_UNIT_DIR = resolve(ROOT, 'tests/fixtures');
const SUCCESS_SENTINEL = 'COWORK_PACKET_DRIVER_SUCCESS';
const FAILURE_SENTINEL = 'COWORK_PACKET_DRIVER_FAILURE';
const READY_SENTINEL = 'COWORK_PACKET_DRIVER_READY';
const PROGRESS_SENTINEL = 'COWORK_PACKET_DRIVER_PROGRESS';
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

async function waitForPort(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((done) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => { socket.destroy(); done(false); });
    });
    if (ready) return;
    await sleep(100);
  }
  throw new Error(`local broker did not listen on port ${port}`);
}

async function waitFor(check, description, timeoutMs = 15_000) {
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

function bool(value) {
  return /true/i.test(value.Visualize());
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
      wire_id: message.Reduce('wire_id').Visualize(),
    });
  }
  return messages;
}

function renderIntArray(value) {
  const output = [];
  for (let index = 0; ; index += 1) {
    const item = value.Reduce(index);
    if (item.IsNil()) break;
    output.push(Number(item.Visualize()));
  }
  return output;
}

if (process.argv.includes('--packet-driver')) {
test('minimal cowork actor speaks the real ours packet protocol', async (t) => {
  const progress = (stage) => process.stdout.write(`${PROGRESS_SENTINEL} ${stage}\n`);
  const packets = [];
  const cleanupErrors = [];
  let broker;
  let brokerExited;
  let wrapper;
  let driverFailure;
  let driverCompleted = false;

  t.after(async () => {
    for (const packet of packets) {
      if (packet.deliberatelyRemoved) continue;
      try {
        wrapper.remove_packet(packet.cid);
      } catch (error) {
        cleanupErrors.push(new Error(`failed to remove ${packet.name} (${packet.cid}): ${error.message}`));
      }
    }

    if (broker) {
      broker.kill('SIGKILL');
      const brokerTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('local broker did not exit after SIGKILL')), 5_000).unref();
      });
      try {
        await Promise.race([brokerExited, brokerTimeout]);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (driverCompleted && cleanupErrors.length === 0) {
      process.stdout.write(`${SUCCESS_SENTINEL}\n`);
    } else {
      process.stdout.write(`${FAILURE_SENTINEL} ${JSON.stringify({
        driver: driverFailure?.stack ?? 'driver did not complete',
        cleanup: cleanupErrors.map((error) => error.stack ?? error.message),
      })}\n`);
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'packet driver cleanup failed');
    }
  });

  try {
  const unitFile = readdirSync(UNIT_DIR).find((name) => name.endsWith('.muflo'));
  assert.ok(unitFile, 'compiled cowork actor missing; run scripts/compile-mufl.sh');
  const fixtureUnitFile = readdirSync(FIXTURE_UNIT_DIR).find((name) => name.endsWith('.muflo'));
  assert.ok(fixtureUnitFile, 'compiled permissive fixture missing; run scripts/compile-mufl.sh');

  const [{ adapt_wrapper }, { PacketWrapperConfigurator }, { object_to_adapt_value }] = await Promise.all([
    import('@adapt-toolkit/sdk/executables'),
    import('@adapt-toolkit/sdk/wrappers'),
    import('@adapt-toolkit/sdk/wrapper'),
  ]);

  const port = await unusedPort();
  const brokerBin = resolve(ROOT, 'node_modules/.bin/adapt-broker');
  const brokerErrors = [];
  broker = spawn(process.execPath, [brokerBin, '--host', '127.0.0.1', '--port', String(port), '--test_mode'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  brokerExited = new Promise((done) => {
    broker.once('error', (error) => done({ error }));
    broker.once('exit', (code, signal) => done({ code, signal }));
  });
  broker.stderr.on('data', (chunk) => brokerErrors.push(chunk.toString()));
  try {
    await waitForPort(port);
  } catch (error) {
    throw new Error(`${error.message}\n${brokerErrors.join('').slice(-2000)}`);
  }

  wrapper = await adapt_wrapper.start([
    '--broker_address', `ws://127.0.0.1:${port}`,
    '--test_mode',
    '--logger_config', '--level', 'WARNING', '--stdout', 'stderr', '--logger_config_end',
  ]);
  wrapper.start();
  progress('wrapper-ready');

  const coworkUnit = {
    hash: unitFile.slice(0, -'.muflo'.length),
    dir: UNIT_DIR,
    bytes: new Uint8Array(readFileSync(resolve(UNIT_DIR, unitFile))),
  };
  const permissiveUnit = {
    hash: fixtureUnitFile.slice(0, -'.muflo'.length),
    dir: FIXTURE_UNIT_DIR,
    bytes: new Uint8Array(readFileSync(resolve(FIXTURE_UNIT_DIR, fixtureUnitFile))),
  };
  function wire(packet) {
    packet.pw.on_return_data = (data) => {
      const kind = data.Reduce('kind').Visualize();
      if (kind === 'save_state') return;
      if (kind === 'notify_agent') {
        packet.events.push(data.Reduce('payload').Reduce('event').Visualize());
        return;
      }
      const pending = packet.pending.shift();
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.resolve(data.Reduce('payload'));
    };
    packet.pw.on_transaction_failure = (message) => {
      const pending = packet.pending.shift();
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
      } else {
        packet.rejects.push(String(message));
      }
    };
  }

  async function createPacket(name, seed, signingSecret, packetUnit = coworkUnit) {
    const config = new PacketWrapperConfigurator();
    const args = ['--unit_hash', packetUnit.hash, '--seed_phrase', seed, '--unit_dir_path', packetUnit.dir];
    if (signingSecret) args.push('--init_trn_argument', JSON.stringify(signingSecret));
    config.process_arguments(args);
    const packet = { name, cid: '', pw: null, pending: [], rejects: [], events: [] };
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} packet creation timed out`)), 30_000);
      wrapper.packet_manager.create_packet(config, (pw) => {
        clearTimeout(timer);
        packet.pw = pw;
        packet.cid = pw.packet.GetContainerID().Visualize();
        wire(packet);
        done();
      }, packetUnit.bytes);
    });
    packets.push(packet);
    return packet;
  }

  function mutate(packet, name, targ) {
    return new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`${packet.name}.${name} timed out`)), 25_000);
      packet.pending.push({ resolve: done, reject, timer });
      packet.pw.add_client_message(object_to_adapt_value({ name, targ }));
    });
  }

  function readonly(packet, name, targ) {
    return packet.pw.packet.ExecuteTransaction(object_to_adapt_value({ name, targ }));
  }

  function binary(packet, bytes) {
    return packet.pw.packet.NewBinaryFromBuffer(Buffer.from(bytes));
  }

  function contacts(packet) {
    return readonly(packet, '::a2a_messaging::list_contacts').Visualize();
  }

  function inbox(packet) {
    return renderMessages(readonly(packet, '::actor::list_incoming_messages'));
  }

  async function namePacket(packet, name) {
    await mutate(packet, '::a2a_messaging::set_my_name', { name });
  }

  async function mint(packet, mode) {
    const result = await mutate(packet, '::a2a_messaging::generate_invite', { mode });
    return {
      blob: Buffer.from(result.Reduce('invite').GetBinary()),
      inviteId: result.Reduce('invite_id').Visualize(),
      mode: result.Reduce('mode').Visualize(),
      reusable: bool(result.Reduce('reusable')),
    };
  }

  async function join(packet, invite) {
    await mutate(packet, '::a2a_messaging::add_contact', { invite: binary(packet, invite.blob) });
  }

  await sleep(1_000);

  const oneTimeRoom = await createPacket('one-time-room', `cowork-one-${Date.now()}`);
  if (process.argv.includes('--deliberate-driver-failure')) {
    await new Promise((done) => process.stdout.write(`${READY_SENTINEL}\n`, done));
    assert.fail('deliberate packet driver assertion failure');
  }
  const alice = await createPacket('alice', `cowork-alice-${Date.now()}`);
  const replay = await createPacket('replay', `cowork-replay-${Date.now()}`);
  await Promise.all([namePacket(oneTimeRoom, 'One-time room'), namePacket(alice, 'Alice'), namePacket(replay, 'Replay')]);

  const oneTime = await mint(oneTimeRoom, 'one_time');
  assert.equal(oneTime.mode, 'one_time');
  assert.equal(oneTime.reusable, false);
  await join(alice, oneTime);
  await waitFor(() => contacts(oneTimeRoom).includes(alice.cid) && contacts(alice).includes(oneTimeRoom.cid), 'one-time invite acceptance');
  const oneTimeOrigins = readonly(oneTimeRoom, '::a2a_messaging::list_contact_origins').Visualize();
  assert.match(oneTimeOrigins, new RegExp(alice.cid));
  assert.match(oneTimeOrigins, new RegExp(oneTime.inviteId));
  assert.match(oneTimeOrigins, /invite_one_time/);

  await join(replay, oneTime);
  await waitFor(() => oneTimeRoom.rejects.some((message) => /already-redeemed|Unknown or already/i.test(message)), 'one-time reuse rejection');
  assert.equal(contacts(replay).includes(oneTimeRoom.cid), false);
  progress('one-time-invite');

  const room = await createPacket('public-room', `cowork-public-${Date.now()}`);
  const bob = await createPacket('bob', `cowork-bob-${Date.now()}`);
  const charlie = await createPacket('charlie', `cowork-charlie-${Date.now()}`);
  await Promise.all([namePacket(room, 'Public room'), namePacket(bob, 'Bob'), namePacket(charlie, 'Charlie')]);

  const publicInvite = await mint(room, 'public');
  assert.equal(publicInvite.mode, 'public');
  assert.equal(publicInvite.reusable, true);
  await Promise.all([join(bob, publicInvite), join(charlie, publicInvite)]);
  await waitFor(
    () => contacts(room).includes(bob.cid) && contacts(room).includes(charlie.cid)
      && contacts(bob).includes(room.cid) && contacts(charlie).includes(room.cid),
    'two peers reusing one public invite',
  );
  const publicOrigins = readonly(room, '::a2a_messaging::list_contact_origins').Visualize();
  assert.match(publicOrigins, new RegExp(bob.cid));
  assert.match(publicOrigins, new RegExp(charlie.cid));
  assert.equal((publicOrigins.match(new RegExp(publicInvite.inviteId, 'g')) ?? []).length, 2);
  assert.equal((publicOrigins.match(/invite_public/g) ?? []).length, 2);
  progress('public-invite');

  const revoked = await mutate(room, '::a2a_messaging::revoke_invite', { invite_id: publicInvite.inviteId });
  assert.equal(bool(revoked.Reduce('revoked')), true);
  const revokedAgain = await mutate(room, '::a2a_messaging::revoke_invite', { invite_id: publicInvite.inviteId });
  assert.equal(bool(revokedAgain.Reduce('revoked')), false);

  await mutate(room, '::a2a_messaging::send_message', { contact: bob.cid, text: 'room-to-bob' });
  await waitFor(() => inbox(bob).some((message) => message.text === 'room-to-bob'), 'room-to-peer message');
  await mutate(bob, '::a2a_messaging::send_message', { contact: room.cid, text: 'bob-to-room' });
  await waitFor(() => inbox(room).some((message) => message.text === 'bob-to-room'), 'peer-to-room message');
  await mutate(charlie, '::a2a_messaging::send_message', { contact: room.cid, text: 'atomic-unexpected' });
  await waitFor(() => inbox(room).some((message) => message.text === 'atomic-unexpected'), 'atomic unexpected arrival');

  let roomInbox = inbox(room);
  assert.equal(roomInbox.length, 2);
  assert(roomInbox.every((message) => message.status === 'unread'));
  const messageId = roomInbox.find((message) => message.text === 'bob-to-room').msg_id;
  const unexpectedId = roomInbox.find((message) => message.text === 'atomic-unexpected').msg_id;
  let drained = await mutate(room, '::actor::consume_messages', { expected_ids: [messageId] });
  assert.deepEqual(renderIntArray(drained.Reduce('consumed')), [messageId]);
  assert.deepEqual(renderIntArray(drained.Reduce('deferred')), [unexpectedId]);
  assert.deepEqual(inbox(room).filter((message) => message.status === 'unread').map((message) => message.msg_id),
    [unexpectedId], 'unexpected arrival stays unread in the same transaction with no defer crash window');
  drained = await mutate(room, '::actor::consume_messages', { expected_ids: [messageId] });
  assert.deepEqual(renderIntArray(drained.Reduce('consumed')), []);
  let deferred = await mutate(room, '::actor::defer_messages', { msg_ids: [messageId] });
  assert.equal(Number(deferred.Reduce('deferred').Visualize()), 1);
  drained = await mutate(room, '::actor::consume_messages', { expected_ids: [messageId] });
  assert.deepEqual(renderIntArray(drained.Reduce('consumed')), [messageId]);
  await mutate(room, '::actor::consume_messages', { expected_ids: [unexpectedId] });
  await mutate(room, '::actor::gc', {});
  assert.equal(inbox(room)[0].status, 'ready_to_delete');
  deferred = await mutate(room, '::actor::defer_messages', { msg_ids: [messageId] });
  assert.equal(Number(deferred.Reduce('deferred').Visualize()), 1);
  await mutate(room, '::actor::consume_messages', { expected_ids: [messageId] });
  await mutate(room, '::actor::gc', {});
  await mutate(room, '::actor::gc', {});
  assert.deepEqual(inbox(room), []);
  progress('inbox-lifecycle');

  const permissive = await createPacket(
    'permissive-peer',
    `cowork-permissive-${Date.now()}`,
    undefined,
    permissiveUnit,
  );
  await namePacket(permissive, 'Permissive peer');
  const fixtureInvite = await mint(room, 'one_time');
  await join(permissive, fixtureInvite);
  await waitFor(
    () => contacts(room).includes(permissive.cid) && contacts(permissive).includes(room.cid),
    'permissive fixture contact acceptance',
  );

  // The fixture is an actual notification service. Registering exercises the
  // cowork actor's client-confirm hook and leaves core-owned client state that
  // must survive the room export/import below.
  await mutate(permissive, '::a2a_notifications::set_vapid_public_key', { key: 'COWORK_TEST_VAPID' });
  await mutate(room, '::a2a_notifications::notify_register', { service: permissive.cid, bindings: null });
  await waitFor(
    () => room.events.includes('notification_registered')
      && readonly(room, '::actor::export_state').Reduce('notifications').Visualize().includes('COWORK_TEST_VAPID'),
    'notification registration hook and persisted client state',
  );
  progress('notifications');

  // Outgoing and incoming file rejection are distinct paths. The permissive
  // fixture accepts files, so the first assertion can only come from cowork's
  // sender hook. The reverse send succeeds locally and then reaches cowork's
  // receiver hook, whose exact abort is observed as an inbound packet failure.
  const outgoingFileBytes = binary(room, Buffer.from('outgoing blocked'));
  await assert.rejects(
    mutate(room, '::a2a_messaging::send_file', {
      contact: permissive.cid,
      filename: 'outgoing-blocked.txt',
      mime: 'text/plain',
      data: outgoingFileBytes,
    }),
    /Room packets do not accept files/,
  );
  const inboundRejectCount = room.rejects.length;
  await mutate(permissive, '::a2a_messaging::send_file', {
    contact: room.cid,
    filename: 'inbound-blocked.txt',
    mime: 'text/plain',
    data: binary(permissive, Buffer.from('inbound blocked')),
  });
  await waitFor(
    () => room.rejects.slice(inboundRejectCount).some((message) => message.includes('Room packets do not accept files')),
    'cowork inbound file hook rejection',
  );

  // A real encrypted peer call arrives with external origin and must not reach
  // the generic host-only signing surface.
  const canonicalJson = '{"at":"2026-08-02T00:00:00.000Z","kind":"room_msg","version":1}';
  const signRejectCount = room.rejects.length;
  await mutate(permissive, '::actor::call_external_sign', { target: room.cid, canonical_json: canonicalJson });
  await waitFor(
    () => room.rejects.length > signRejectCount,
    'external-origin sign_app_envelope rejection',
  );
  assert.match(room.rejects.at(-1), /origin/i);
  progress('refusals');

  const removal = await mutate(room, '::a2a_messaging::remove_contact', { contact: bob.cid });
  assert.equal(bool(removal.Reduce('notified')), true);
  assert.equal(bool(removal.Reduce('key_material_retained')), true);
  try {
    await waitFor(
      () => !contacts(room).includes(bob.cid) && !contacts(bob).includes(room.cid),
      'bilateral contact removal',
    );
  } catch (error) {
    error.message += `\nroom contacts: ${contacts(room)}\nbob contacts: ${contacts(bob)}\nbob rejects: ${bob.rejects.join(' | ')}`;
    throw error;
  }

  const firstSignature = await mutate(room, '::actor::sign_app_envelope', { canonical_json: canonicalJson });
  const firstSignatureBytes = Buffer.from(firstSignature.Reduce('signature').Serialize());
  const secondSignature = await mutate(room, '::actor::sign_app_envelope', { canonical_json: canonicalJson });
  const secondSignatureBytes = Buffer.from(secondSignature.Reduce('signature').Serialize());
  assert.deepEqual(secondSignatureBytes, firstSignatureBytes);
  progress('contact-removal');

  // Export with a mixed lifecycle inbox. Import must preserve both statuses,
  // then allocate the next arrival from the exported monotonic sequence.
  await mutate(charlie, '::a2a_messaging::send_message', { contact: room.cid, text: 'processed-before-export' });
  await waitFor(() => inbox(room).some((message) => message.text === 'processed-before-export'), 'processed export fixture');
  const processedId = inbox(room).find((message) => message.text === 'processed-before-export').msg_id;
  drained = await mutate(room, '::actor::consume_messages', { expected_ids: [processedId] });
  assert.deepEqual(renderIntArray(drained.Reduce('consumed')), [processedId]);
  await mutate(permissive, '::a2a_messaging::send_message', { contact: room.cid, text: 'unread-before-export' });
  await waitFor(() => inbox(room).some((message) => message.text === 'unread-before-export'), 'unread export fixture');
  const beforeExportInbox = inbox(room);
  assert.deepEqual(
    Object.fromEntries(beforeExportInbox.map((message) => [message.text, message.status])),
    { 'processed-before-export': 'processed', 'unread-before-export': 'unread' },
  );
  const maxExportedMessageId = Math.max(...beforeExportInbox.map((message) => message.msg_id));
  progress('export-fixture');

  const exportedState = readonly(room, '::actor::export_state');
  assert.match(exportedState.Reduce('notifications').Visualize(), /COWORK_TEST_VAPID/);
  const stateBytes = Buffer.from(exportedState.Serialize());
  const signingSecret = Buffer.from(readonly(room, '::actor::export_signing_secret').Serialize()).toString('hex');
  const originalCid = room.cid;
  wrapper.remove_packet(originalCid);
  room.deliberatelyRemoved = true;
  const restored = await createPacket('restored-public-room', `cowork-restored-${Date.now()}`, signingSecret);
  assert.equal(restored.cid, originalCid);
  const parsedState = restored.pw.packet.ParseValue(new Uint8Array(stateBytes));
  await mutate(restored, '::actor::import_state', parsedState);
  assert.match(contacts(restored), new RegExp(charlie.cid));
  assert.deepEqual(
    Object.fromEntries(inbox(restored).map((message) => [message.text, message.status])),
    { 'processed-before-export': 'processed', 'unread-before-export': 'unread' },
  );
  assert.match(readonly(restored, '::actor::export_state').Reduce('notifications').Visualize(), /COWORK_TEST_VAPID/);
  await mutate(charlie, '::a2a_messaging::send_message', { contact: restored.cid, text: 'after-import-sequence' });
  await waitFor(() => inbox(restored).some((message) => message.text === 'after-import-sequence'), 'post-import message sequence');
  const afterImport = inbox(restored).find((message) => message.text === 'after-import-sequence');
  assert.equal(afterImport.msg_id, maxExportedMessageId + 1);
  progress('restored');
  driverCompleted = true;
  } catch (error) {
    driverFailure = error;
    throw error;
  }
});
} else {
  async function runPacketDriver(t, { extraArgs = [], timeoutMs, afterReadyTimeoutMs }) {
    const child = spawn(process.execPath, [THIS_FILE, '--packet-driver', ...extraArgs], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settleOutcome;
    let settleReady;
    let settleTimeout;
    let killRequested = false;
    let progressCount = 0;
    let readyAt;
    let outcomeAt;
    const outcomePromise = new Promise((done) => { settleOutcome = done; });
    const readyPromise = new Promise((done) => { settleReady = done; });
    const timeoutPromise = new Promise((done) => { settleTimeout = done; });
    const exitedPromise = new Promise((done) => {
      child.once('error', (error) => done({ code: null, signal: null, error }));
      child.once('exit', (code, signal) => done({ code, signal }));
    });

    let watchdog;
    const armWatchdog = (ms) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => settleTimeout({ kind: 'timeout' }), ms);
    };
    function capture(chunk) {
      output += chunk.toString();
      const observedProgress = output.split(PROGRESS_SENTINEL).length - 1;
      if (observedProgress > progressCount) {
        progressCount = observedProgress;
        if (afterReadyTimeoutMs === undefined) armWatchdog(timeoutMs);
      }
      if (readyAt === undefined && output.includes(READY_SENTINEL)) {
        readyAt = Date.now();
        settleReady({ kind: 'ready' });
      }
      if (output.includes(FAILURE_SENTINEL)) {
        outcomeAt ??= Date.now();
        settleOutcome({ kind: 'failure' });
      } else if (output.includes(SUCCESS_SENTINEL)) {
        outcomeAt ??= Date.now();
        settleOutcome({ kind: 'success' });
      }
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

    // This is intentionally redundant with the normal-path reap below: every
    // assertion/exception path owned by node:test still kills and awaits the
    // native wrapper child.
    t.after(async () => { await killAndReap(); });

    const terminal = [
      outcomePromise,
      exitedPromise.then((result) => ({ kind: 'exit', result })),
    ];
    armWatchdog(timeoutMs);
    let outcome;
    if (afterReadyTimeoutMs === undefined) {
      outcome = await Promise.race([...terminal, timeoutPromise]);
    } else {
      const startup = await Promise.race([readyPromise, ...terminal, timeoutPromise]);
      if (startup.kind === 'ready') {
        armWatchdog(afterReadyTimeoutMs);
        outcome = await Promise.race([...terminal, timeoutPromise]);
      } else {
        outcome = startup;
      }
    }
    clearTimeout(watchdog);
    const result = await killAndReap();
    return {
      outcome,
      result,
      output,
      afterReadyElapsedMs: readyAt === undefined || outcomeAt === undefined ? undefined : outcomeAt - readyAt,
    };
  }

  function diagnostics(run) {
    const exit = run.result.error?.message ?? run.result.signal ?? run.result.code;
    return `packet driver ${run.outcome.kind} (${exit})\n${run.output.slice(-12_000)}`;
  }

  test('minimal cowork actor speaks the real ours packet protocol', async (t) => {
    const run = await runPacketDriver(t, { timeoutMs: 120_000 });
    assert.equal(
      run.outcome.kind,
      'success',
      diagnostics(run),
    );
    assert.equal(
      run.result.signal,
      'SIGKILL',
      diagnostics(run),
    );
  });

  test('packet driver assertion failures report and terminate promptly', async (t) => {
    const run = await runPacketDriver(t, {
      extraArgs: ['--deliberate-driver-failure'],
      timeoutMs: 120_000,
      afterReadyTimeoutMs: 20_000,
    });
    assert.equal(run.outcome.kind, 'failure', diagnostics(run));
    assert.match(run.output, /deliberate packet driver assertion failure/, diagnostics(run));
    assert.ok(run.afterReadyElapsedMs < 20_000, diagnostics(run));
  });
}
