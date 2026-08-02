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

if (process.argv.includes('--packet-driver')) {
let driverPassed = false;
test('minimal cowork actor speaks the real ours packet protocol', { timeout: 180_000 }, async (t) => {
  const unitFile = readdirSync(UNIT_DIR).find((name) => name.endsWith('.muflo'));
  assert.ok(unitFile, 'compiled cowork actor missing; run scripts/compile-mufl.sh');

  const [{ adapt_wrapper }, { PacketWrapperConfigurator }, { object_to_adapt_value }] = await Promise.all([
    import('@adapt-toolkit/sdk/executables'),
    import('@adapt-toolkit/sdk/wrappers'),
    import('@adapt-toolkit/sdk/wrapper'),
  ]);

  const port = await unusedPort();
  const brokerBin = resolve(ROOT, 'node_modules/.bin/adapt-broker');
  const brokerErrors = [];
  const broker = spawn(process.execPath, [brokerBin, '--host', '127.0.0.1', '--port', String(port), '--test_mode'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  broker.stderr.on('data', (chunk) => brokerErrors.push(chunk.toString()));
  t.after(() => {
    broker.kill('SIGKILL');
    setTimeout(() => process.exit(driverPassed ? 0 : 1), 100);
  });
  try {
    await waitForPort(port);
  } catch (error) {
    throw new Error(`${error.message}\n${brokerErrors.join('').slice(-2000)}`);
  }

  const wrapper = await adapt_wrapper.start([
    '--broker_address', `ws://127.0.0.1:${port}`,
    '--test_mode',
    '--logger_config', '--level', 'WARNING', '--stdout', 'stderr', '--logger_config_end',
  ]);
  wrapper.start();

  const unitHash = unitFile.slice(0, -'.muflo'.length);
  const unit = new Uint8Array(readFileSync(resolve(UNIT_DIR, unitFile)));
  const packets = [];

  function wire(packet) {
    packet.pw.on_return_data = (data) => {
      const kind = data.Reduce('kind').Visualize();
      if (kind === 'save_state' || kind === 'notify_agent') return;
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

  async function createPacket(name, seed, signingSecret) {
    const config = new PacketWrapperConfigurator();
    const args = ['--unit_hash', unitHash, '--seed_phrase', seed, '--unit_dir_path', UNIT_DIR];
    if (signingSecret) args.push('--init_trn_argument', JSON.stringify(signingSecret));
    config.process_arguments(args);
    const packet = { name, cid: '', pw: null, pending: [], rejects: [] };
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} packet creation timed out`)), 30_000);
      wrapper.packet_manager.create_packet(config, (pw) => {
        clearTimeout(timer);
        packet.pw = pw;
        packet.cid = pw.packet.GetContainerID().Visualize();
        wire(packet);
        done();
      }, unit);
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

  t.after(() => {
    for (const packet of packets) {
      try { wrapper.remove_packet(packet.cid); } catch { /* already removed */ }
    }
  });

  await sleep(1_000);

  const oneTimeRoom = await createPacket('one-time-room', `cowork-one-${Date.now()}`);
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

  const revoked = await mutate(room, '::a2a_messaging::revoke_invite', { invite_id: publicInvite.inviteId });
  assert.equal(bool(revoked.Reduce('revoked')), true);
  const revokedAgain = await mutate(room, '::a2a_messaging::revoke_invite', { invite_id: publicInvite.inviteId });
  assert.equal(bool(revokedAgain.Reduce('revoked')), false);

  await mutate(room, '::a2a_messaging::send_message', { contact: bob.cid, text: 'room-to-bob' });
  await waitFor(() => inbox(bob).some((message) => message.text === 'room-to-bob'), 'room-to-peer message');
  await mutate(bob, '::a2a_messaging::send_message', { contact: room.cid, text: 'bob-to-room' });
  await waitFor(() => inbox(room).some((message) => message.text === 'bob-to-room'), 'peer-to-room message');

  let roomInbox = inbox(room);
  assert.equal(roomInbox.length, 1);
  assert.equal(roomInbox[0].status, 'unread');
  const messageId = roomInbox[0].msg_id;
  let drained = await mutate(room, '::actor::get_messages', {});
  assert.deepEqual(renderMessages(drained.Reduce('messages')).map((message) => message.msg_id), [messageId]);
  drained = await mutate(room, '::actor::get_messages', {});
  assert.deepEqual(renderMessages(drained.Reduce('messages')), []);
  let deferred = await mutate(room, '::actor::defer_messages', { msg_ids: [messageId] });
  assert.equal(Number(deferred.Reduce('deferred').Visualize()), 1);
  drained = await mutate(room, '::actor::get_messages', {});
  assert.deepEqual(renderMessages(drained.Reduce('messages')).map((message) => message.msg_id), [messageId]);
  await mutate(room, '::actor::gc', {});
  assert.equal(inbox(room)[0].status, 'ready_to_delete');
  deferred = await mutate(room, '::actor::defer_messages', { msg_ids: [messageId] });
  assert.equal(Number(deferred.Reduce('deferred').Visualize()), 1);
  await mutate(room, '::actor::get_messages', {});
  await mutate(room, '::actor::gc', {});
  await mutate(room, '::actor::gc', {});
  assert.deepEqual(inbox(room), []);

  const fileBytes = binary(charlie, Buffer.from('not accepted'));
  await assert.rejects(
    mutate(charlie, '::a2a_messaging::send_file', {
      contact: room.cid,
      filename: 'blocked.txt',
      mime: 'text/plain',
      data: fileBytes,
    }),
    /Room packets do not accept files/,
  );

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

  const canonicalJson = '{"at":"2026-08-02T00:00:00.000Z","kind":"room_msg","version":1}';
  const firstSignature = await mutate(room, '::actor::sign_app_envelope', { canonical_json: canonicalJson });
  const firstSignatureBytes = Buffer.from(firstSignature.Reduce('signature').Serialize());
  const secondSignature = await mutate(room, '::actor::sign_app_envelope', { canonical_json: canonicalJson });
  const secondSignatureBytes = Buffer.from(secondSignature.Reduce('signature').Serialize());
  assert.deepEqual(secondSignatureBytes, firstSignatureBytes);

  const exportedState = readonly(room, '::actor::export_state');
  const stateBytes = Buffer.from(exportedState.Serialize());
  const signingSecret = Buffer.from(readonly(room, '::actor::export_signing_secret').Serialize()).toString('hex');
  const originalCid = room.cid;
  wrapper.remove_packet(originalCid);
  const restored = await createPacket('restored-public-room', `cowork-restored-${Date.now()}`, signingSecret);
  assert.equal(restored.cid, originalCid);
  const parsedState = restored.pw.packet.ParseValue(new Uint8Array(stateBytes));
  await mutate(restored, '::actor::import_state', parsedState);
  assert.match(contacts(restored), new RegExp(charlie.cid));
  driverPassed = true;
});
} else {
  test('minimal cowork actor speaks the real ours packet protocol', { timeout: 180_000 }, async () => {
    const child = spawn(process.execPath, [THIS_FILE, '--packet-driver'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    const result = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => done({ code, signal }));
    });
    assert.equal(result.code, 0, `packet driver failed (${result.signal ?? result.code})\n${output.join('').slice(-12_000)}`);
  });
}
