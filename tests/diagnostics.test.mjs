import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createServiceRoutes } from '../src/command-routes.ts';
import { OperationTrace, traced } from '../src/diagnostics.ts';
import { PacketRegistry } from '../src/packets.ts';
import { RoomService } from '../src/service.ts';
import { CoworkStore } from '../src/storage.ts';
import { RpcDispatcher, TransportServer } from '../src/transports.ts';

// Real RoomService, IntakePump, CoworkStore, PacketRegistry/SdkRoomPacket and
// RpcDispatcher; only the SDK client and the OURS host are injected. Every
// failure here is a declared test cause, not a reproduction of a production one.

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const IDENTITY = 'ours-cowork:Room 01jz6y7n';
const CID = 'AB'.repeat(32);
const ALICE = 'C1'.repeat(32);
const BOB = 'C2'.repeat(32);
const CARA = 'C3'.repeat(32);
const AT = '2026-08-02T10:11:12.000Z';
const MESSAGE_WIRE = 'core-message-wire-in';

function room() {
  return {
    version: 2,
    room_id: ROOM_ID,
    room_name: 'Release room',
    identity_name: IDENTITY,
    identity_cid: CID,
    mission: { goal: 'Ship', briefing: 'Read the mission.', briefing_version: 1 },
    role_briefings: {},
    rest_roles: [],
    anonymous: false,
    quiet_membership: false,
    membership_epoch: 3,
    state: 'active',
    invites: [],
    seats: [
      { identity: ALICE, display_name: 'Alice', role: 'builder', invite_id: 'invite-a', accepted_at: AT, participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa1', state: 'active' },
      { identity: BOB, display_name: 'Bob', role: 'reviewer', invite_id: 'invite-b', accepted_at: AT, participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa2', state: 'active' },
      { identity: CARA, display_name: 'Cara', role: 'observer', invite_id: 'invite-c', accepted_at: AT, participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa3', state: 'active' },
    ],
    created_at: AT,
    activated_at: AT,
  };
}

/** The SDK surface a hosted room packet uses, with one unread message from Alice. */
class Client {
  calls = [];
  unread = true;
  contacts = [ALICE, BOB, CARA].map((cid, index) => ({ name: ['Alice', 'Bob', 'Cara'][index], container_id: cid }));
  listed = {
    seq: 1, msg_id: 7, from: { id: ALICE, name: 'Alice' },
    occurred_at_ms: Date.parse('2026-08-15T08:00:00Z'), date: '2026-08-15T08:00:00+00:00',
    encryption: 'e2e', inbox_state: 'unread', status: 'unread', wire_id: MESSAGE_WIRE, reply_to: null,
  };
  history(state) {
    return {
      ...this.listed, inbox_state: state, status: state,
      peer: { id: ALICE, name: 'Alice' }, direction: 'in', text: 'Participant update', body: 'Participant update',
      transport: 'double_ratchet', delivery_state: null, human_read_at_ms: null,
    };
  }
  async chooseIdentity() { this.calls.push('chooseIdentity'); return { name: IDENTITY, cid: CID, switchedFrom: null }; }
  async listContacts() { this.calls.push('listContacts'); return { contacts: structuredClone(this.contacts) }; }
  async listInvites() { this.calls.push('listInvites'); return []; }
  async listIncomingMessages() { this.calls.push('listIncomingMessages'); return this.unread ? [structuredClone(this.listed)] : []; }
  async getHistoryItem() { this.calls.push('getHistoryItem'); return this.history('unread'); }
  async getMessages() {
    this.calls.push('getMessages');
    if (!this.unread) return { messages: [], remaining: 0, commands_handled: 0, command_results: [] };
    this.unread = false;
    return { messages: [this.history('read')], remaining: 0, commands_handled: 0, command_results: [] };
  }
  async listIncomingFiles() { this.calls.push('listIncomingFiles'); return []; }
  async sendMessage(input) {
    this.calls.push(`sendMessage:${input.contact === BOB ? 'bob' : input.contact === CARA ? 'cara' : 'other'}`);
    return { kind: 'sent', wireId: '55'.repeat(32) };
  }
  async releaseLease() { return { released: [IDENTITY], failed: 0 }; }
  async close() {}
}

/**
 * An owned loopback server that closes every connection as soon as a request
 * arrives: the test-only paired termination. `fetch` against it rejects with
 * Node's own TypeError whose cause is undici's SocketError (UND_ERR_SOCKET).
 */
async function closingUpstream(t) {
  const events = [];
  const server = createServer((request) => {
    events.push('request_received');
    request.socket.destroy();
    events.push('server_destroyed_socket');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const { port } = server.address();
  return {
    events,
    async request() {
      events.push('client_request');
      try { return await fetch(`http://127.0.0.1:${port}/`); }
      catch (error) { events.push('client_rejected'); throw error; }
    },
  };
}

async function hosted(t, client, trace) {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = trace ? { trace } : {};
  const store = new CoworkStore(dir, options);
  await store.create(room());
  const host = {
    async createClient() { return client; },
    async listIdentityNames(names) { return new Set(names); },
    onIdentityNotify() { return () => {}; },
    trackIdentity() { return () => {}; },
  };
  const registry = new PacketRegistry(host, dir, options);
  await registry.restore(ROOM_ID, CID, IDENTITY);
  const service = new RoomService(store, registry, { now: () => '2026-08-15T09:00:00.000Z', ...options });
  return { store, registry, service };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function until(condition, what) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolveTick) => setImmediate(resolveTick));
  }
}

/** The labels from a span up to the top, e.g. sdk:get_history_item < intake_stage:list_messages < pump:pump_run. */
function chain(snapshot, record) {
  const byId = new Map(snapshot.records.map((entry) => [entry.id, entry]));
  const labels = [];
  for (let current = record; current; current = byId.get(current.parent)) labels.push(`${current.kind}:${current.label}`);
  return labels;
}

const only = (snapshot, kind, label) => {
  const found = snapshot.records.filter((record) => record.kind === kind && record.label === label);
  assert.equal(found.length, 1, `exactly one ${kind}:${label} span`);
  return found[0];
};

async function archiveKinds(store) {
  return (await store.read(ROOM_ID)).map((record) => record.kind);
}

/** Run one controlled failure of an intake SDK call, traced or not, and return what the caller and state saw. */
async function failingHistoryLookup(t, trace) {
  const upstream = await closingUpstream(t);
  const client = new Client();
  let thrown;
  client.getHistoryItem = async () => {
    client.calls.push('getHistoryItem');
    try { return await upstream.request(); } catch (error) { thrown = error; throw error; }
  };
  const { store, service } = await hosted(t, client, trace);
  const outcome = await service.resumePending(ROOM_ID).then(() => 'resolved', (error) => error);
  return { outcome, thrown, calls: client.calls.slice(), upstream: upstream.events, archive: await archiveKinds(store), unread: client.unread };
}

test('a failing intake SDK call is named with its stage, codes, and unchanged outcome and queue state', async (t) => {
  const trace = new OperationTrace();
  const traced = await failingHistoryLookup(t, trace);
  const plain = await failingHistoryLookup(t, undefined);

  // The caller sees the very error the SDK call raised, with or without a trace.
  assert.equal(traced.outcome, traced.thrown);
  assert.equal(plain.outcome, plain.thrown);
  assert.equal(traced.thrown.name, 'TypeError');
  assert.equal(traced.thrown.cause?.code, 'UND_ERR_SOCKET');
  // Identical SDK call sequence and durable state: nothing archived, the
  // message is still unread, and it was never acknowledged.
  assert.deepEqual(traced.calls, plain.calls);
  assert.equal(traced.calls.includes('getMessages'), false);
  assert.deepEqual(traced.archive, plain.archive);
  assert.equal(traced.archive.includes('message'), false);
  assert.equal(traced.unread, true);
  // The owned upstream saw the request before it closed the socket.
  assert.deepEqual(traced.upstream, ['client_request', 'request_received', 'server_destroyed_socket', 'client_rejected']);

  const snapshot = trace.snapshot();
  assert.equal(snapshot.complete, true);
  const failed = only(snapshot, 'sdk', 'get_history_item');
  assert.deepEqual(chain(snapshot, failed), ['sdk:get_history_item', 'intake_stage:list_messages', 'pump:pump_run']);
  assert.deepEqual(
    { outcome: failed.outcome, attempt: failed.attempt, error_name: failed.error_name, error_code: failed.error_code, cause_code: failed.cause_code },
    { outcome: 'error', attempt: 1, error_name: 'TypeError', error_code: 'none', cause_code: 'UND_ERR_SOCKET' },
  );
  // The listings before it (one for typed commands, one for text) succeeded; no later stage ran.
  const listings = snapshot.records.filter((record) => record.kind === 'sdk' && record.label === 'list_incoming_messages');
  assert.deepEqual(listings.map((record) => [chain(snapshot, record)[1], record.outcome]),
    [['intake_stage:drain_commands', 'ok'], ['intake_stage:list_messages', 'ok']]);
  assert.equal(snapshot.records.some((record) => record.label === 'persist_message' || record.label === 'relay'), false);
  assert.equal(only(snapshot, 'pump', 'pump_run').outcome, 'error');
});

test('management history waiting on a room mutex held across an SDK contacts refresh is told apart', async (t) => {
  const trace = new OperationTrace();
  const client = new Client();
  const gate = deferred();
  const { service } = await hosted(t, client, trace);
  // Hold only the refresh started after the room is hosted.
  const listContacts = client.listContacts.bind(client);
  client.listContacts = async () => { client.calls.push('listContacts:held'); await gate.promise; return listContacts(); };
  const dispatcher = new RpcDispatcher(createServiceRoutes(service), { trace });

  const reconciling = service.reconcileRoom(ROOM_ID);
  await until(() => client.calls.includes('listContacts:held'), 'the held contacts refresh');
  const history = dispatcher.dispatch({ version: 1, id: 1, method: 'room.history', params: { room_id: ROOM_ID, view: 'operator-metadata' } });
  await until(() => trace.snapshot().records.some((record) => record.kind === 'rpc'), 'the history route to start');

  const waiting = trace.snapshot();
  const rpc = only(waiting, 'rpc', 'room.history');
  const wait = waiting.records.find((record) => record.kind === 'mutex_wait' && record.parent === rpc.id);
  assert.equal(rpc.outcome, 'open');
  assert.equal(wait?.outcome, 'open', 'history is waiting for the room mutex, not working');
  // The last contacts listing is the held refresh; the first ran while restoring.
  const refresh = waiting.records.findLast((record) => record.kind === 'sdk' && record.label === 'list_contacts');
  assert.deepEqual(chain(waiting, refresh), ['sdk:list_contacts', 'mutex_hold:room']);
  assert.equal(refresh.outcome, 'open');

  gate.resolve();
  await reconciling;
  const response = await history;
  assert.equal('result' in response, true);
  const settled = trace.snapshot();
  assert.equal(settled.complete, true);
  const waited = settled.records.find((record) => record.id === wait.id);
  const refreshed = settled.records.find((record) => record.id === refresh.id);
  assert(waited.end_ms >= refreshed.end_ms, 'the wait ended only after the held SDK refresh settled');
  const holds = settled.records.filter((record) => record.kind === 'mutex_hold' && record.parent === rpc.id);
  assert.equal(holds.length, 1, 'history then held the mutex itself');
});

test('relay keeps the first failing recipient and its continued sibling as separate SDK spans', async (t) => {
  const trace = new OperationTrace();
  const upstream = await closingUpstream(t);
  const client = new Client();
  let thrown;
  const sendMessage = client.sendMessage.bind(client);
  client.sendMessage = async (input) => {
    if (input.contact !== BOB) return sendMessage(input);
    client.calls.push('sendMessage:bob');
    try { return await upstream.request(); } catch (error) { thrown = error; throw error; }
  };
  const { store, service } = await hosted(t, client, trace);
  const outcome = await service.resumePending(ROOM_ID).then(() => 'resolved', (error) => error);
  assert.equal(outcome, thrown, 'the pump surfaces the first delivery error after continuing');
  assert.deepEqual(client.calls.filter((call) => call.startsWith('sendMessage')), ['sendMessage:bob', 'sendMessage:cara']);
  // The message was archived and acknowledged before the relay.
  assert.equal(client.unread, false);
  assert((await archiveKinds(store)).includes('message'));

  const snapshot = trace.snapshot();
  const relay = only(snapshot, 'intake_stage', 'relay');
  const sends = snapshot.records.filter((record) => record.kind === 'sdk' && record.label === 'send_message');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends.map((record) => [record.outcome, record.cause_code]), [['error', 'UND_ERR_SOCKET'], ['ok', null]]);
  for (const send of sends) assert(chain(snapshot, send).includes('intake_stage:relay'));
  assert.equal(relay.outcome, 'error');
  assert.deepEqual(
    ['persist_message', 'ack_message'].map((label) => only(snapshot, 'intake_stage', label).outcome),
    ['ok', 'ok'],
  );
});

async function coalescing(t, trace) {
  const client = new Client();
  client.unread = false;
  const gate = deferred();
  let first = true;
  const list = client.listIncomingMessages.bind(client);
  client.listIncomingMessages = async () => {
    if (first) { first = false; client.calls.push('listIncomingMessages:held'); await gate.promise; }
    return list();
  };
  const { service } = await hosted(t, client, trace);
  const order = [];
  const running = service.resumePending(ROOM_ID).then(() => order.push('first resume settled'));
  await until(() => client.calls.includes('listIncomingMessages:held'), 'the running pump');
  const coalesced = service.resumePending(ROOM_ID).then(() => order.push('coalesced resume settled'));
  const joined = service.drainPending(ROOM_ID).then(() => order.push('joined drain settled'));
  await coalesced;
  order.push('gate released');
  gate.resolve();
  await Promise.all([running, joined]);
  return order;
}

test('a coalesced resume returns before the pump completes; a joined drain waits for it, traced or not', async (t) => {
  const trace = new OperationTrace();
  const tracedOrder = await coalescing(t, trace);
  const plainOrder = await coalescing(t, undefined);
  assert.deepEqual(tracedOrder, plainOrder);
  assert.deepEqual(tracedOrder.slice(0, 2), ['coalesced resume settled', 'gate released']);
  const snapshot = trace.snapshot();
  assert.equal(only(snapshot, 'pump', 'resume_coalesced').outcome, 'ok');
  const run = only(snapshot, 'pump', 'pump_run');
  const joined = only(snapshot, 'pump', 'pump_joined');
  assert(joined.end_ms >= run.end_ms, 'the joined drain settled only with the running pump');
});

test('a management reply skipped for a closed Unix socket is recorded while the route still completes', async (t) => {
  const trace = new OperationTrace();
  const client = new Client();
  const gate = deferred();
  const { service } = await hosted(t, client, trace);
  // Hold only the refresh started after the room is hosted.
  const listContacts = client.listContacts.bind(client);
  client.listContacts = async () => { client.calls.push('listContacts:held'); await gate.promise; return listContacts(); };
  const dir = mkdtempSync(join(tmpdir(), 'cowork-diagnostics-sock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dispatcher = new RpcDispatcher(createServiceRoutes(service), { trace });
  const transport = new TransportServer({
    socketPath: join(dir, 'management.sock'), rest: { enabled: false, port: 0 },
    unixDispatcher: dispatcher, restDispatcher: dispatcher, trace,
  });
  await transport.start();
  t.after(() => transport.stop());

  const reconciling = service.reconcileRoom(ROOM_ID);
  await until(() => client.calls.includes('listContacts:held'), 'the held contacts refresh');
  const socket = connect(join(dir, 'management.sock'));
  await new Promise((resolveConnect) => socket.once('connect', resolveConnect));
  socket.write(`${JSON.stringify({ version: 1, id: 2, method: 'room.history', params: { room_id: ROOM_ID, view: 'operator-metadata' } })}\n`);
  await until(() => trace.snapshot().records.some((record) => record.kind === 'rpc'), 'the history route to start');
  // The caller gives up, as a timed-out CLI would; that does not cancel the route.
  socket.destroy();
  // The transport's own socket set (private in TypeScript only) shows the server saw the close.
  await until(() => transport.sockets.size === 0, 'the server to observe the disconnect');
  assert.equal(only(trace.snapshot(), 'rpc', 'room.history').outcome, 'open');
  gate.resolve();
  await reconciling;
  await until(() => trace.snapshot().open === 0, 'every span to settle');

  const snapshot = trace.snapshot();
  const request = only(snapshot, 'rpc_request', 'unix');
  const rpc = only(snapshot, 'rpc', 'room.history');
  assert.equal(rpc.parent, request.id);
  assert.equal(rpc.outcome, 'ok', 'the route completed after its caller disconnected');
  const response = snapshot.records.find((record) => record.kind === 'rpc_response');
  assert.equal(response.label, 'socket_destroyed');
  assert.equal(response.parent, request.id);
});

test('trace records are finite and capped, and a full or failing observer never changes the operation', async () => {
  const capped = new OperationTrace({ maxRecords: 2, maxActive: 1 });
  const error = Object.assign(new Error('secret body text /private/path'), {
    code: 'SOME_UNLISTED_CODE', cause: Object.assign(new Error('inner'), { code: 'ECONNRESET' }),
  });
  const outer = traced(capped, 'sdk', 'not-a-listed-operation', () => traced(capped, 'sdk', 'get_messages', async () => { throw error; }));
  await assert.rejects(outer, (thrown) => thrown === error);
  await traced(capped, 'sdk', 'list_contacts', async () => 'ok');
  const snapshot = capped.snapshot();
  assert.deepEqual(snapshot.records.map((record) => [record.label, record.error_name, record.error_code, record.cause_code]), [
    ['other', 'Error', 'other', 'ECONNRESET'],
    ['list_contacts', null, null, null],
  ]);
  assert.equal(snapshot.dropped_active, 1);
  assert.equal(snapshot.omitted, 0);
  assert.equal(snapshot.complete, false);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('/private'), false);

  const full = new OperationTrace({ maxRecords: 1 });
  assert.equal(await traced(full, 'sdk', 'get_messages', async () => 1), 1);
  assert.equal(await traced(full, 'sdk', 'get_messages', async () => 2), 2);
  assert.equal(full.snapshot().omitted, 1);

  let ticks = 0;
  const broken = new OperationTrace({}, () => { if (ticks++ > 0) throw new Error('clock failure'); return 0; });
  const value = {};
  assert.equal(await traced(broken, 'sdk', 'get_messages', async () => value), value);
  await assert.rejects(traced(broken, 'sdk', 'get_messages', async () => { throw error; }), (thrown) => thrown === error);

  const getter = { get name() { throw new Error('observer must not run getters'); } };
  const odd = new OperationTrace();
  await assert.rejects(traced(odd, 'sdk', 'get_messages', async () => { throw getter; }), (thrown) => thrown === getter);
  assert.equal(odd.snapshot().records[0].error_name, 'none');
});
