import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RoomService } from '../src/service.ts';
import { CoworkStore } from '../src/storage.ts';
import { createServiceRoutes, classifyServiceError } from '../src/command-routes.ts';
import { heartbeatText } from '../src/heartbeat.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const ROOM_CID = 'D'.repeat(64);
const ALICE = 'A'.repeat(64);
const BOB = 'B'.repeat(64);
const CARA = 'C'.repeat(64);
const OUTSIDER = 'E'.repeat(64);
const PIDS = {
  [ALICE]: '01jz6y7n8p9q0r1s2t3v4w5xa1',
  [BOB]: '01jz6y7n8p9q0r1s2t3v4w5xa2',
  [CARA]: '01jz6y7n8p9q0r1s2t3v4w5xa3',
};
const START = Date.parse('2026-10-14T12:00:00.000Z');
const MINUTE = 60_000;

/** Deterministic one-shot timers driven by an explicit clock; no real waiting. */
class FakeClock {
  now = START;
  timers = new Set();
  set = (callback, delayMs) => {
    const timer = { at: this.now + delayMs, callback };
    this.timers.add(timer);
    return timer;
  };
  clear = (timer) => { this.timers.delete(timer); };
  iso = () => new Date(this.now).toISOString();
  pendingDeadlines() { return [...this.timers].map((timer) => timer.at).sort((a, b) => a - b); }
}

class FakePacket {
  cid = ROOM_CID;
  inbox = [];
  fileInbox = [];
  sendCalls = [];
  contacts;
  beforeSend;
  sendFailure;
  constructor(contacts) { this.contacts = contacts; }
  listFailures = 0;
  async listUnreadMessages(limit) {
    if (this.listFailures > 0) { this.listFailures -= 1; throw new Error('temporary inbox read failure'); }
    return structuredClone(this.inbox.slice(0, limit));
  }
  async listUnreadFiles(limit) { return structuredClone(this.fileInbox.slice(0, limit)); }
  async acknowledgeMessage(expected, onUnexpected) {
    for (;;) {
      const item = this.inbox.shift();
      if (!item) return;
      if (item.msg_id === expected.msg_id) return;
      await onUnexpected(structuredClone(item));
    }
  }
  async acknowledgeFile(expected) {
    const index = this.fileInbox.findIndex((item) => item.file_id === expected.file_id);
    if (index >= 0) this.fileInbox.splice(index, 1);
  }
  async send(recipient, body) {
    this.sendCalls.push({ recipient, body: JSON.parse(body) });
    if (this.beforeSend) await this.beforeSend(recipient, JSON.parse(body));
    if (this.sendFailure) throw this.sendFailure;
    return { status: 'queued', wire_id: `wire-${this.sendCalls.length}` };
  }
  async sendFile() { return { status: 'queued', wire_id: 'wire-file' }; }
  mintInvite() { throw new Error('not used'); }
  revokeInvite() { throw new Error('not used'); }
  listInvites() { return []; }
  async refreshContacts() {}
  listContacts() { return this.contacts.map((cid) => ({ container_id: cid, name: cid.slice(0, 4) })); }
  async removeContact(cid) {
    this.contacts = this.contacts.filter((contact) => contact !== cid);
    return { status: 'queued', notified: false, key_material_retained: true };
  }
}

function seat(identity, overrides = {}) {
  return {
    identity, display_name: identity.slice(0, 4), role: 'builder', invite_id: 'invite-1',
    accepted_at: new Date(START).toISOString(), participant_id: PIDS[identity], state: 'active', ...overrides,
  };
}

function baseRoom({ heartbeat = {}, ...options } = {}) {
  const at = new Date(START).toISOString();
  const { status, ...overrides } = { status: 'in_progress', ...options };
  return {
    version: 2, room_id: ROOM_ID, room_name: 'Heartbeat room', identity_name: 'ours-cowork:Heartbeat room',
    identity_cid: ROOM_CID, mission: { goal: 'Ship', briefing: 'Brief.', briefing_version: 1 },
    role_briefings: {}, rest_roles: ['Reporter'], command_grants: [], role_command_grants: [],
    anonymous: false, quiet_membership: true, membership_epoch: 3, state: 'active',
    ...(status === undefined ? {} : { status }),
    ...(heartbeat === null ? {} : { heartbeat: {
      enabled: true, interval_minutes: 20, generation: 1, updated_at: at, anchor_at: at, observed_seq: 0, ...heartbeat,
    } }),
    invites: [], seats: [seat(ALICE), seat(BOB), seat(CARA)],
    created_at: at, activated_at: at, ...overrides,
  };
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
let messageSerial = 0;
function nextMessageId() {
  messageSerial += 1;
  let suffix = '';
  for (let value = messageSerial, i = 0; i < 6; i += 1, value = Math.floor(value / 32)) suffix = CROCKFORD[value % 32] + suffix;
  return `01jz6y7n8p9q0r1s2t3v${suffix}`;
}

async function fixture(t, { room = baseRoom(), records = [], stateDir } = {}) {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), 'cowork-heartbeat-'));
  if (!stateDir) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new CoworkStore(dir);
  if (room) {
    await store.create(room);
    for (const record of records) await store.append(ROOM_ID, record);
  }
  return build(t, dir, store);
}

function build(t, dir, store, clock = new FakeClock(), packet) {
  const fakePacket = packet ?? new FakePacket([ALICE, BOB, CARA]);
  const registry = {
    hosted: true,
    get(id) { return id === ROOM_ID && this.hosted ? fakePacket : undefined; },
    async destroy() { this.hosted = false; return []; },
  };
  const service = new RoomService(store, registry, {
    now: clock.iso, messageId: nextMessageId,
    heartbeatTimer: { set: clock.set, clear: clock.clear },
  });
  t.after(() => service.beginShutdown());
  const f = {
    dir, store, clock, packet: fakePacket, service, registry,
    async settle() {
      while (service.heartbeatWork.size > 0) await service.drain();
      await service.drain();
    },
    /** Advance the fake clock, firing due timers in deadline order. */
    async advance(ms) {
      const target = clock.now + ms;
      for (;;) {
        const due = [...clock.timers].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.now = due.at;
        clock.timers.delete(due);
        due.callback();
        await f.settle();
      }
      clock.now = target;
    },
    async start() { service.startHeartbeats([ROOM_ID]); await f.settle(); },
    /**
     * Model the gap between durable emission and its relay pass: the pass
     * right after the next heartbeat append fails on its inbox read, so the
     * heartbeat stays queued until a later resumePending.
     */
    holdRelayAfterEmission() {
      const append = store.append.bind(store);
      store.append = async (roomId, draft) => {
        const record = await append(roomId, draft);
        if (draft.kind === 'message' && draft.category === 'heartbeat') {
          fakePacket.listFailures += 1;
          store.append = append;
        }
        return record;
      };
    },
    async records(kind) { return (await store.read(ROOM_ID)).filter((record) => kind === undefined || record.kind === kind); },
    async heartbeats() { return (await f.records('message')).filter((record) => record.category === 'heartbeat'); },
    heartbeatSends() { return fakePacket.sendCalls.filter((call) => call.body.kind === 'room_heartbeat'); },
    async relayStatuses() {
      const heartbeatIds = new Set((await f.heartbeats()).map((record) => record.message_id));
      return (await f.records('relay_result'))
        .filter((record) => heartbeatIds.has(record.message_id))
        .map((record) => `${record.recipient_identity.slice(0, 1)}:${record.status}`).sort();
    },
    incoming(overrides = {}) {
      const msgId = 100 + fakePacket.inbox.length + fakePacket.sendCalls.length + messageSerial;
      fakePacket.inbox.push({
        msg_id: msgId, sender_id: ALICE, sender_name: 'Alice', text: 'Progress update',
        date: clock.iso(), wire_id: `wire-in-${msgId}`, reply_to: null, ...overrides,
      });
    },
  };
  return f;
}

// ---- Enable/disable, threshold and repetition -----------------------------------

test('a disabled in_progress room produces zero heartbeat messages, timers and wakes', async (t) => {
  const f = await fixture(t, { room: baseRoom({ heartbeat: { enabled: false } }) });
  await f.start();
  assert.deepEqual(f.clock.pendingDeadlines(), []);
  await f.advance(24 * 60 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
  assert.equal(f.packet.sendCalls.length, 0);
});

test('a room created before the feature loads as disabled and is never silently enabled', async (t) => {
  const f = await fixture(t, { room: baseRoom({ heartbeat: null }) });
  await f.start();
  await f.advance(3 * 60 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
  assert.equal((await f.store.load(ROOM_ID)).heartbeat, undefined);
});

test('only active in_progress rooms are monitored, not todo/done/unset status', async (t) => {
  for (const status of ['todo', 'done', 'review', 'In_Progress', undefined]) {
    const f = await fixture(t, { room: baseRoom({ status }) });
    await f.start();
    await f.advance(60 * MINUTE);
    assert.equal((await f.heartbeats()).length, 0, String(status));
  }
});

test('heartbeat fires exactly at the threshold to every active participant and never changes status', async (t) => {
  const f = await fixture(t);
  await f.start();
  assert.deepEqual(f.clock.pendingDeadlines(), [START + 20 * MINUTE]);
  await f.advance(20 * MINUTE - 1);
  assert.equal((await f.heartbeats()).length, 0);
  await f.advance(1);
  const [heartbeat] = await f.heartbeats();
  assert.equal(heartbeat.at, new Date(START + 20 * MINUTE).toISOString());
  assert.deepEqual(heartbeat.author, { identity: ROOM_CID, display_name: 'ours-cowork:Heartbeat room', role: 'room' });
  assert.deepEqual(heartbeat.heartbeat, { generation: 1, interval_minutes: 20, participant_ids: [PIDS[ALICE], PIDS[BOB], PIDS[CARA]] });
  assert.equal(heartbeat.text, heartbeatText(20));
  assert.match(heartbeat.text, /not evidence that the room is stuck/);
  assert.match(heartbeat.text, /set the room status to done with room\.settings/);
  assert.deepEqual(f.heartbeatSends().map((call) => call.recipient).sort(), [ALICE, BOB, CARA]);
  const body = f.heartbeatSends()[0].body;
  assert.equal(body.kind, 'room_heartbeat');
  assert.deepEqual(body.heartbeat, { interval_minutes: 20 });
  assert.equal(body.participant_ids, undefined);
  assert.deepEqual(await f.relayStatuses(), ['A:dispatch_claimed', 'B:dispatch_claimed', 'C:dispatch_claimed']);
  assert.equal((await f.store.load(ROOM_ID)).status, 'in_progress');
});

test('quiet rooms repeat at most once per interval; heartbeats never reset or extend the window', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.advance(70 * MINUTE);
  const heartbeats = await f.heartbeats();
  assert.deepEqual(heartbeats.map((record) => (Date.parse(record.at) - START) / MINUTE), [20, 40, 60]);
  assert.equal(f.heartbeatSends().length, 9);
  assert.deepEqual(f.clock.pendingDeadlines(), [START + 80 * MINUTE]);
});

// ---- Activity boundary -----------------------------------------------------------

test('participant discussion resets the window by host observation time, not the sender date', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.advance(15 * MINUTE);
  // An old sender date must not make the discussion look stale.
  f.incoming({ date: '2026-10-13T00:00:00.000Z' });
  await f.service.resumePending(ROOM_ID);
  const policy = (await f.store.load(ROOM_ID)).heartbeat;
  assert.equal(policy.activity_at, new Date(START + 15 * MINUTE).toISOString());
  await f.advance(19 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
  await f.advance(1 * MINUTE);
  assert.deepEqual((await f.heartbeats()).map((record) => (Date.parse(record.at) - START) / MINUTE), [35]);
});

test('a future sender date cannot postpone heartbeats', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.advance(5 * MINUTE);
  f.incoming({ date: '2027-01-01T00:00:00.000Z' });
  await f.service.resumePending(ROOM_ID);
  await f.advance(20 * MINUTE);
  assert.deepEqual((await f.heartbeats()).map((record) => (Date.parse(record.at) - START) / MINUTE), [25]);
});

test('operator, registered-role and upload posts are discussion; whitespace and room notices are not', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.advance(10 * MINUTE);
  await f.service.postAsRole(ROOM_ID, { role: 'Reporter', text: 'Status from the role.' });
  await f.advance(15 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
  await f.service.postMessage(ROOM_ID, { text: 'Operator note.' });
  await f.advance(15 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
  await f.service.sendFile(ROOM_ID, {
    upload_id: '6f1c1b1e-9a0c-4a59-9a8f-0f2b5e6d7c8a', role: 'Reporter', filename: 'log.txt',
    mime: 'text/plain', data_base64: Buffer.from('log').toString('base64'),
  });
  const uploadedAt = f.clock.now;
  // Whitespace-only native text is not discussion.
  f.incoming({ text: '   \n ' });
  await f.service.resumePending(ROOM_ID);
  await f.advance(20 * MINUTE);
  const [first] = await f.heartbeats();
  assert.equal(Date.parse(first.at), uploadedAt + 20 * MINUTE);
});

test('discussion already in the SDK inbox at the deadline is archived before the emission decision', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.advance(20 * MINUTE - 1);
  // Arrived but no notification has been processed yet.
  f.incoming({ text: 'Last-moment update' });
  await f.advance(1);
  assert.equal((await f.heartbeats()).length, 0);
  assert.equal((await f.records('message')).filter((record) => record.text === 'Last-moment update').length, 1);
  // Its host observation time is when the tick archived it.
  assert.deepEqual(f.clock.pendingDeadlines(), [START + 40 * MINUTE]);
});

test('discussion archived between emission and the relay pass cancels every pending send', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.holdRelayAfterEmission();
  await f.advance(20 * MINUTE);
  assert.equal((await f.heartbeats()).length, 1);
  // The relay pass archives inbox discussion before it reaches the pending sends.
  f.incoming({ text: 'Back at work' });
  await f.service.resumePending(ROOM_ID);
  assert.equal(f.heartbeatSends().length, 0);
  assert.deepEqual(await f.relayStatuses(), ['A:skipped_cancelled', 'B:skipped_cancelled', 'C:skipped_cancelled']);
});

test('a partially dispatched heartbeat is cancelled for the rest after discussion and a crash', async (t) => {
  const f = await fixture(t);
  await f.start();
  const append = f.store.append.bind(f.store);
  let claims = 0;
  f.store.append = async (roomId, draft) => {
    if (draft.kind === 'relay_result' && draft.status === 'dispatch_claimed' && ++claims === 2) {
      throw new Error('storage crash after the first dispatch');
    }
    return append(roomId, draft);
  };
  await f.advance(20 * MINUTE);
  f.store.append = append;
  assert.equal(f.heartbeatSends().length, 1);
  await f.service.postMessage(ROOM_ID, { text: 'Operator: status please' });
  await f.service.resumePending(ROOM_ID);
  assert.equal(f.heartbeatSends().length, 1);
  const statuses = await f.relayStatuses();
  assert.equal(statuses.filter((status) => status.endsWith('dispatch_claimed')).length, 1);
  assert.equal(statuses.filter((status) => status.endsWith('skipped_cancelled')).length, 2);
});

// ---- Policy and status transitions -----------------------------------------------

test('interval change restarts the window and cancels queued heartbeats of the old generation', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.holdRelayAfterEmission();
  await f.advance(20 * MINUTE);
  await f.service.setHeartbeat(ROOM_ID, { interval_minutes: 5 });
  await f.settle();
  await f.service.resumePending(ROOM_ID);
  const policy = (await f.store.load(ROOM_ID)).heartbeat;
  assert.equal(policy.generation, 2);
  assert.equal(policy.interval_minutes, 5);
  assert.equal(f.heartbeatSends().length, 0);
  assert.deepEqual(await f.relayStatuses(), ['A:skipped_cancelled', 'B:skipped_cancelled', 'C:skipped_cancelled']);
  await f.advance(5 * MINUTE);
  const heartbeats = await f.heartbeats();
  assert.equal(heartbeats.length, 2);
  assert.equal(heartbeats[1].heartbeat.generation, 2);
  assert.equal(heartbeats[1].text, heartbeatText(5));
  assert.equal(Date.parse(heartbeats[1].at), START + 25 * MINUTE);
});

test('disable then re-enable never revives an old pending heartbeat', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.holdRelayAfterEmission();
  await f.advance(20 * MINUTE);
  await f.service.setHeartbeat(ROOM_ID, { enabled: false });
  await f.service.setHeartbeat(ROOM_ID, { enabled: true });
  await f.settle();
  await f.service.resumePending(ROOM_ID);
  assert.equal(f.heartbeatSends().length, 0);
  assert.deepEqual(await f.relayStatuses(), ['A:skipped_cancelled', 'B:skipped_cancelled', 'C:skipped_cancelled']);
});

test('done stops monitoring, reopening starts a fresh window, and an old pending heartbeat is not revived', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.advance(10 * MINUTE);
  await f.service.updateRoom(ROOM_ID, { status: 'done' });
  await f.settle();
  assert.deepEqual(f.clock.pendingDeadlines(), []);
  await f.advance(60 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
  await f.service.updateRoom(ROOM_ID, { status: 'in_progress' });
  await f.settle();
  const reopenedAt = f.clock.now;
  assert.equal((await f.store.load(ROOM_ID)).heartbeat.generation, 3);
  await f.advance(20 * MINUTE);
  const [first] = await f.heartbeats();
  assert.equal(Date.parse(first.at), reopenedAt + 20 * MINUTE);
});

test('status change to done between emission and send cancels every pending send', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.holdRelayAfterEmission();
  await f.advance(20 * MINUTE);
  await f.service.updateRoom(ROOM_ID, { status: 'done' });
  await f.service.updateRoom(ROOM_ID, { status: 'in_progress' });
  await f.settle();
  await f.service.resumePending(ROOM_ID);
  assert.equal((await f.heartbeats()).length, 1);
  assert.equal(f.heartbeatSends().length, 0);
  assert.deepEqual(await f.relayStatuses(), ['A:skipped_cancelled', 'B:skipped_cancelled', 'C:skipped_cancelled']);
});

test('disable cancels the timer and produces zero further heartbeat messages or wakes', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.advance(20 * MINUTE);
  assert.equal((await f.heartbeats()).length, 1);
  const sends = f.packet.sendCalls.length;
  await f.service.setHeartbeat(ROOM_ID, { enabled: false });
  await f.settle();
  assert.deepEqual(f.clock.pendingDeadlines(), []);
  await f.advance(12 * 60 * MINUTE);
  assert.equal((await f.heartbeats()).length, 1);
  assert.equal(f.packet.sendCalls.length, sends);
  // Re-enabling is a new generation measured from the change.
  await f.service.setHeartbeat(ROOM_ID, { enabled: true });
  await f.settle();
  assert.deepEqual(f.clock.pendingDeadlines(), [f.clock.now + 20 * MINUTE]);
});

test('close and delete cancel pending heartbeat timers', async (t) => {
  const f = await fixture(t);
  f.packet.contacts = [];
  await f.start();
  assert.equal(f.clock.pendingDeadlines().length, 1);
  await f.service.closeRoom(ROOM_ID);
  await f.settle();
  assert.deepEqual(f.clock.pendingDeadlines(), []);
  await f.advance(60 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
  await f.service.deleteRoom(ROOM_ID, { confirm: true });
  await f.advance(60 * MINUTE);
  assert.deepEqual(f.clock.pendingDeadlines(), []);
});

test('a pending close request stops emission before lifecycle completion', async (t) => {
  const f = await fixture(t, { room: baseRoom({ lifecycle_request: {
    request_id: 'req-1', command: 'room.close', caller_cid: ALICE, accepted_at: new Date(START).toISOString(), state: 'pending',
  } }) });
  f.service.resumeLifecycleRequest = async () => false;
  await f.start();
  await f.advance(60 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
});

// ---- Membership --------------------------------------------------------------------

test('a removed then re-admitted CID never receives a heartbeat addressed to its old seat', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.packet.beforeSend = async () => { throw new Error('held'); };
  const append = f.store.append.bind(f.store);
  let reseated = false;
  f.store.append = async (roomId, draft) => {
    const record = await append(roomId, draft);
    if (!reseated && draft.kind === 'relay_intent') {
      reseated = true;
      // Before any send: Alice is removed and re-admitted under a new participant ID.
      const room = await f.store.load(ROOM_ID);
      room.seats = room.seats.map((candidate) => candidate.identity === ALICE
        ? { ...candidate, state: 'removed', removed_at: f.clock.iso(), removed_epoch: 4 } : candidate);
      room.seats.push(seat(ALICE, { participant_id: '01jz6y7n8p9q0r1s2t3v4w5xa9', invite_id: 'invite-2' }));
      room.membership_epoch = 5;
      await f.store.save(room);
    }
    return record;
  };
  f.packet.beforeSend = undefined;
  await f.advance(20 * MINUTE);
  const statuses = await f.relayStatuses();
  assert(statuses.includes('A:skipped_removed'), statuses.join());
  assert.equal(f.heartbeatSends().filter((call) => call.recipient === ALICE).length, 0);
  assert.equal(f.heartbeatSends().length, 2);
});

test('a participant joining after emission is not addressed by that heartbeat', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.advance(20 * MINUTE);
  const [heartbeat] = await f.heartbeats();
  assert.deepEqual(heartbeat.recipient_identities.sort(), [ALICE, BOB, CARA]);
  assert.equal(heartbeat.recipient_identities.includes(OUTSIDER), false);
});

test('a room with no active participants arms no timer', async (t) => {
  const f = await fixture(t, { room: baseRoom({ seats: [] }) });
  await f.start();
  assert.deepEqual(f.clock.pendingDeadlines(), []);
});

// ---- Restart, recovery and clock -----------------------------------------------

test('restart after long downtime emits at most one heartbeat and does not send stale queued ones', async (t) => {
  const f = await fixture(t);
  await f.start();
  // Crash with the first heartbeat appended but its relays not yet attempted.
  f.packet.beforeSend = async () => { throw new Error('crash before send'); };
  const originalSend = f.packet.send.bind(f.packet);
  f.packet.send = async () => { throw new Error('daemon stopped'); };
  await f.advance(20 * MINUTE);
  f.packet.send = originalSend;
  f.packet.beforeSend = undefined;
  // The claim happened before the throw: those intents are terminal, never retried.
  assert.deepEqual(await f.relayStatuses(), ['A:dispatch_claimed', 'B:dispatch_claimed', 'C:dispatch_claimed']);
  f.service.beginShutdown();

  // Add an unsent old-generation-1 heartbeat (as if a crash happened right after emission).
  const room = await f.store.load(ROOM_ID);
  const stale = await f.store.append(ROOM_ID, {
    version: 1, kind: 'message', room_id: ROOM_ID, at: new Date(START + 40 * MINUTE).toISOString(),
    message_id: nextMessageId(), author: { identity: ROOM_CID, display_name: room.identity_name, role: 'room' },
    category: 'heartbeat', text: heartbeatText(20),
    heartbeat: { generation: 1, interval_minutes: 20, participant_ids: Object.values(PIDS) },
    recipient_identities: [ALICE, BOB, CARA],
  });
  for (const recipient of [ALICE, BOB, CARA]) {
    await f.store.append(ROOM_ID, { version: 1, kind: 'relay_intent', room_id: ROOM_ID, at: stale.at, message_id: stale.message_id, recipient_identity: recipient });
  }

  // Five hours of downtime, then a new process.
  const clock = new FakeClock();
  clock.now = START + 40 * MINUTE + 5 * 60 * MINUTE;
  const restarted = build(t, f.dir, new CoworkStore(f.dir), clock, new FakePacket([ALICE, BOB, CARA]));
  await restarted.service.resumePending(ROOM_ID);
  assert.equal(restarted.heartbeatSends().length, 0, 'stale queued heartbeat must not be delivered');
  await restarted.start();
  // The overdue deadline is due immediately, once.
  assert.deepEqual(clock.pendingDeadlines(), [clock.now]);
  await restarted.advance(0);
  const fresh = (await restarted.heartbeats()).filter((record) => Date.parse(record.at) >= clock.now);
  assert.equal(fresh.length, 1);
  assert.equal(restarted.heartbeatSends().length, 3);
  assert.deepEqual(clock.pendingDeadlines(), [clock.now + 20 * MINUTE]);
  await restarted.advance(20 * MINUTE - 1);
  assert.equal(restarted.heartbeatSends().length, 3);
});

test('discussion archived before its observation was recorded counts from first observation after restart', async (t) => {
  const f = await fixture(t);
  // The crash window: a chat record exists beyond observed_seq, with an old sender date.
  await f.store.append(ROOM_ID, {
    version: 1, kind: 'message', room_id: ROOM_ID, at: '2026-10-01T00:00:00.000Z', message_id: nextMessageId(),
    author: { identity: ALICE, display_name: 'Alice', role: 'builder' }, category: 'chat', text: 'Unrecorded update',
    recipient_identities: [BOB, CARA], source_msg_id: 5, source_wire_id: 'wire-5',
  });
  f.clock.now = START + 3 * 60 * MINUTE;
  await f.start();
  assert.equal((await f.heartbeats()).length, 0);
  assert.deepEqual(f.clock.pendingDeadlines(), [f.clock.now + 20 * MINUTE]);
});

test('a backward clock delays by at most one interval and is never read as discussion', async (t) => {
  const f = await fixture(t, { room: baseRoom({ heartbeat: {
    enabled: true, interval_minutes: 20,
    anchor_at: new Date(START + 2 * 60 * MINUTE).toISOString(),
    updated_at: new Date(START + 2 * 60 * MINUTE).toISOString(),
  } }) });
  await f.start();
  assert.deepEqual(f.clock.pendingDeadlines(), [START + 20 * MINUTE]);
  await f.advance(20 * MINUTE);
  assert.equal((await f.heartbeats()).length, 1);
  // Later heartbeats keep advancing the basis: one per interval, no tight loop.
  await f.advance(40 * MINUTE);
  assert.deepEqual((await f.heartbeats()).map((record) => (Date.parse(record.at) - START) / MINUTE), [20, 40, 60]);
  const policy = (await f.store.load(ROOM_ID)).heartbeat;
  assert.equal(policy.activity_at, undefined);
});

// ---- Dispatch idempotency ---------------------------------------------------------

test('accepted-before-throw sends are claimed once and never retried', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.packet.sendFailure = new Error('transport accepted, then threw');
  await f.advance(20 * MINUTE);
  f.packet.sendFailure = undefined;
  for (let i = 0; i < 3; i += 1) await f.service.resumePending(ROOM_ID);
  assert.equal(f.heartbeatSends().length, 3);
  assert.deepEqual(await f.relayStatuses(), ['A:dispatch_claimed', 'B:dispatch_claimed', 'C:dispatch_claimed']);
});

test('concurrent starts and duplicate timers emit one heartbeat per deadline', async (t) => {
  const f = await fixture(t);
  f.service.startHeartbeats([ROOM_ID, ROOM_ID]);
  f.service.startHeartbeats([ROOM_ID]);
  await f.settle();
  assert.equal(f.clock.pendingDeadlines().length, 1);
  // Two workers fire at the same deadline.
  f.clock.now = START + 20 * MINUTE;
  const [timer] = f.clock.timers;
  f.clock.timers.delete(timer);
  timer.callback();
  timer.callback();
  f.service.startHeartbeats([ROOM_ID]);
  await f.settle();
  assert.equal((await f.heartbeats()).length, 1);
  assert.equal(f.heartbeatSends().length, 3);
});

// ---- Authorization and validation -----------------------------------------------

const context = Object.freeze({ sender_cid: ALICE, sender_name: 'Alice', request_wire_id: 'request' });

async function runtimeFixture(t) {
  const f = await fixture(t);
  const commands = {};
  f.packet.registerRuntimeCommands = async (handlers) => { Object.assign(commands, handlers); };
  await f.service.recoverPacket(ROOM_ID);
  return { ...f, call: (input, ctx = context) => commands.sharedCommand('room.heartbeat.set', input, ctx) };
}

test('room.heartbeat.set requires an active seat with an explicit or role grant', async (t) => {
  const f = await runtimeFixture(t);
  assert.deepEqual(await f.call({ interval_minutes: 30 }), { ok: false, error: 'unauthorized' });
  assert.deepEqual(await f.call({ interval_minutes: 30 }, { ...context, sender_cid: OUTSIDER }), { ok: false, error: 'unauthorized' });
  // A grant for a broader unrelated command does not authorize it.
  await f.service.grantRuntimeCommand(ROOM_ID, { caller_cid: ALICE, command: 'room.settings' });
  assert.deepEqual(await f.call({ interval_minutes: 30 }), { ok: false, error: 'unauthorized' });
  await f.service.grantRuntimeCommand(ROOM_ID, { caller_cid: ALICE, command: 'room.heartbeat.set' });
  const accepted = await f.call({ interval_minutes: 30 });
  assert.equal(accepted.ok, true);
  assert.equal((await f.store.load(ROOM_ID)).heartbeat.interval_minutes, 30);
  // Cross-room targeting is refused before any effect.
  assert.deepEqual(await f.call({ room_id: '01jz6y7n8p9q0r1s2t3v4w5x6z', enabled: false }), { ok: false, error: 'invalid_request' });
  assert.equal((await f.store.load(ROOM_ID)).heartbeat.enabled, true);
  // Bob inherits it only through an exact role policy.
  await f.service.setRuntimeRoleCommands(ROOM_ID, { role: 'builder', commands: ['room.heartbeat.set'] });
  assert.equal((await f.call({ enabled: false }, { ...context, sender_cid: BOB })).ok, true);
  assert.equal((await f.store.load(ROOM_ID)).heartbeat.enabled, false);
  // A removed seat loses it.
  await f.service.removeParticipant(ROOM_ID, { participant: ALICE, notify: false });
  assert.deepEqual(await f.call({ enabled: true }), { ok: false, error: 'unauthorized' });
});

test('heartbeat settings reject non-finite, fractional and out-of-range intervals', async (t) => {
  const f = await fixture(t);
  const routes = createServiceRoutes(f.service);
  for (const interval_minutes of [0, -5, 1441, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '20']) {
    await assert.rejects(async () => routes['room.heartbeat.set'].run({ room_id: ROOM_ID, interval_minutes }),
      (error) => classifyServiceError(error) === 'invalid_params', String(interval_minutes));
  }
  await assert.rejects(async () => routes['room.heartbeat.set'].run({ room_id: ROOM_ID }), (error) => classifyServiceError(error) === 'invalid_params');
  await assert.rejects(async () => routes['room.heartbeat.set'].run({ room_id: ROOM_ID, enabled: true, extra: 1 }), (error) => classifyServiceError(error) === 'invalid_params');
  for (const interval_minutes of [1, 1440]) {
    const room = await routes['room.heartbeat.set'].run({ room_id: ROOM_ID, interval_minutes });
    assert.equal(room.heartbeat.interval_minutes, interval_minutes);
  }
});

test('an unchanged policy is idempotent and keeps its generation and window', async (t) => {
  const f = await fixture(t);
  const before = (await f.store.load(ROOM_ID)).heartbeat;
  f.clock.now += 5 * MINUTE;
  await f.service.setHeartbeat(ROOM_ID, { enabled: true, interval_minutes: 20 });
  assert.deepEqual((await f.store.load(ROOM_ID)).heartbeat, before);
});

test('heartbeat policy persists across a store reopen', async (t) => {
  const f = await fixture(t);
  await f.service.setHeartbeat(ROOM_ID, { interval_minutes: 45 });
  const reopened = new CoworkStore(f.dir);
  const policy = (await reopened.load(ROOM_ID)).heartbeat;
  assert.equal(policy.enabled, true);
  assert.equal(policy.interval_minutes, 45);
  assert.equal(policy.generation, 2);
});

// ---- Room creation defaults and activation ----------------------------------------

async function creationFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-heartbeat-create-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new CoworkStore(dir);
  const clock = new FakeClock();
  const packets = new Map();
  const registry = {
    get: (id) => packets.get(id),
    async preflightCreate() {},
    async create(id) {
      const packet = new FakePacket([]);
      packet.mintInvite = async (mode) => ({ blob: 'invite-blob', invite_id: `invite-${id}`, reusable: mode === 'public' });
      packet.listInvites = () => [{ invite_id: `invite-${id}`, mode: 'public' }];
      packets.set(id, packet);
      return packet;
    },
    async destroy(id) { packets.delete(id); return []; },
  };
  let roomSerial = 0;
  const service = new RoomService(store, registry, {
    now: clock.iso, messageId: nextMessageId,
    roomId: () => `01jz6y7n8p9q0r1s2t3v4w5y${'0123456789abcdefghjkmnpqrstvwxyz'[roomSerial++]}0`,
    heartbeatTimer: { set: clock.set, clear: clock.clear },
  });
  t.after(() => service.beginShutdown());
  return { store, clock, service, packets };
}

test('new rooms persist an explicit opt-in policy defaulting to disabled with a 20-minute interval', async (t) => {
  const f = await creationFixture(t);
  const plain = await f.service.createRoom({ goal: 'Ship', briefing: 'Brief.' });
  assert.deepEqual(plain.heartbeat, {
    enabled: false, interval_minutes: 20, generation: 1,
    updated_at: f.clock.iso(), anchor_at: f.clock.iso(), observed_seq: 0,
  });
  const opted = await f.service.createRoom({ goal: 'Ship', briefing: 'Brief.', name: 'Opted', heartbeat: { enabled: true } });
  assert.equal(opted.heartbeat.enabled, true);
  assert.equal(opted.heartbeat.interval_minutes, 20);
  const custom = await f.service.createRoom({ goal: 'Ship', briefing: 'Brief.', name: 'Custom', heartbeat: { enabled: true, interval_minutes: 90 } });
  assert.equal(custom.heartbeat.interval_minutes, 90);
  await assert.rejects(f.service.createRoom({ goal: 'Ship', briefing: 'Brief.', name: 'Bad', heartbeat: { enabled: true, interval_minutes: 0 } }));
  await assert.rejects(f.service.createRoom({ goal: 'Ship', briefing: 'Brief.', name: 'Bad2', heartbeat: { interval_minutes: 20 } }));
});

test('activation of an in_progress room starts a new generation measured from activation', async (t) => {
  const f = await creationFixture(t);
  const created = await f.service.createRoom({ goal: 'Ship', briefing: 'Brief.', heartbeat: { enabled: true } });
  await f.service.updateRoom(created.room_id, { status: 'in_progress' });
  assert.equal((await f.store.load(created.room_id)).heartbeat.generation, 1, 'provisioning rooms are not monitored');
  const { invite } = await f.service.createInvite(created.room_id, { mode: 'public', role: 'builder', min_accepts: 1 });
  f.clock.now += 7 * MINUTE;
  const packet = f.packets.get(created.room_id);
  packet.contacts = [ALICE];
  packet.listContacts = () => [{ container_id: ALICE, name: 'Alice', accepted_via_invite_id: invite.invite_id }];
  packet.supportsInviteProvenance = true;
  const active = await f.service.reconcileRoom(created.room_id);
  assert.equal(active.state, 'active');
  assert.equal(active.heartbeat.generation, 2);
  assert.equal(active.heartbeat.anchor_at, f.clock.iso());
});

// ---- Durable contracts --------------------------------------------------------------

test('metadata and archive contracts bind heartbeat fields to their category', async () => {
  const { RoomSchema, MessageRecordSchema, CommunicationRecordSchema } = await import('../src/contracts.ts');
  assert.equal(RoomSchema.parse(baseRoom({ heartbeat: null })).heartbeat, undefined);
  assert.throws(() => RoomSchema.parse(baseRoom({ heartbeat: { interval_minutes: 0 } })));
  assert.throws(() => RoomSchema.parse(baseRoom({ heartbeat: { generation: 0 } })));
  assert.throws(() => RoomSchema.parse(baseRoom({ heartbeat: { surprise: true } })));
  const message = {
    version: 1, room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: new Date(START).toISOString(),
    kind: 'message', message_id: '01jz6y7n8p9q0r1s2t3v4w5x6z',
    author: { identity: ROOM_CID, display_name: 'room', role: 'room' }, category: 'heartbeat', text: heartbeatText(20),
    heartbeat: { generation: 1, interval_minutes: 20, participant_ids: [PIDS[ALICE]] }, recipient_identities: [ALICE],
  };
  MessageRecordSchema.parse(message);
  CommunicationRecordSchema.parse(message);
  const { heartbeat: _snapshot, ...missing } = message;
  assert.throws(() => CommunicationRecordSchema.parse(missing), /heartbeat messages require heartbeat/);
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, category: 'chat' }), /heartbeat is forbidden on chat messages/);
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, briefing_version: 1 }));
});

test('a moderator interval change made under the command lock re-arms the timer independently', async (t) => {
  const f = await runtimeFixture(t);
  await f.start();
  assert.deepEqual(f.clock.pendingDeadlines(), [START + 20 * MINUTE]);
  await f.service.grantRuntimeCommand(ROOM_ID, { caller_cid: ALICE, command: 'room.heartbeat.set' });
  f.clock.now += 3 * MINUTE;
  assert.equal((await f.call({ interval_minutes: 5 })).ok, true);
  await f.settle();
  assert.deepEqual(f.clock.pendingDeadlines(), [START + 8 * MINUTE]);
  await f.advance(5 * MINUTE);
  assert.equal((await f.heartbeats()).length, 1);
  assert.equal((await f.call({ enabled: false })).ok, true);
  await f.settle();
  assert.deepEqual(f.clock.pendingDeadlines(), []);
});

// ---- Critic C7–C9 regressions ---------------------------------------------------

test('C7: real discussion behind more than a page of blank chats cancels a pending heartbeat', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.holdRelayAfterEmission();
  await f.advance(20 * MINUTE);
  assert.equal((await f.heartbeats()).length, 1);
  await f.service.postMessage(ROOM_ID, { text: 'Actual progress after emission' });
  for (let n = 0; n < 65; n += 1) await f.service.postMessage(ROOM_ID, { text: ' ' });
  await f.service.resumePending(ROOM_ID);
  assert.equal(f.heartbeatSends().length, 0);
});

test('C7: unrecorded discussion behind more than a page of blank chats is found by the paged scan', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.holdRelayAfterEmission();
  await f.advance(20 * MINUTE);
  const chat = (text, n) => ({
    version: 1, kind: 'message', room_id: ROOM_ID, at: f.clock.iso(), message_id: nextMessageId(),
    author: { identity: ALICE, display_name: 'Alice', role: 'builder' }, category: 'chat', text,
    recipient_identities: [], source_msg_id: 500 + n, source_wire_id: `wire-raw-${n}`,
  });
  // Appended directly: the crash window where the observation was never recorded.
  await f.store.append(ROOM_ID, chat('Unrecorded real discussion', 0));
  for (let n = 1; n <= 130; n += 1) await f.store.append(ROOM_ID, chat('\t ', n));
  await f.service.resumePending(ROOM_ID);
  assert.equal(f.heartbeatSends().length, 0);
  assert.deepEqual(await f.relayStatuses(), ['A:skipped_cancelled', 'B:skipped_cancelled', 'C:skipped_cancelled']);
});

test('C8: a failed inbox read at expiry never emits; the retry archives the discussion and resets the window', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.incoming({ text: 'Actual participant progress before expiry' });
  f.packet.listFailures = 1;
  await f.advance(20 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
  // Fail closed, then retry after a bounded delay rather than spinning.
  assert.deepEqual(f.clock.pendingDeadlines(), [START + 21 * MINUTE]);
  await f.advance(1 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
  assert.equal((await f.records('message')).filter((record) => record.text === 'Actual participant progress before expiry').length, 1);
  assert.deepEqual(f.clock.pendingDeadlines(), [START + 41 * MINUTE]);
  await f.advance(20 * MINUTE);
  assert.equal((await f.heartbeats()).length, 1);
});

test('C8: a persistently failing inbox retries once per minute and never emits', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.packet.listFailures = Number.POSITIVE_INFINITY;
  await f.advance(60 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
  assert.deepEqual(f.clock.pendingDeadlines(), [START + 61 * MINUTE]);
});

test('C8: an unhosted packet cannot prove membership or inbox state, so nothing is emitted', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.registry.hosted = false;
  await f.advance(45 * MINUTE);
  assert.equal((await f.heartbeats()).length, 0);
});

test('C9: a missed contact removal is reconciled before the recipient snapshot', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.packet.contacts = [ALICE, CARA];
  await f.advance(20 * MINUTE);
  assert.equal(f.heartbeatSends().filter((call) => call.recipient === BOB).length, 0);
  const [heartbeat] = await f.heartbeats();
  assert.deepEqual(heartbeat.recipient_identities.sort(), [ALICE, CARA]);
  const bob = (await f.store.load(ROOM_ID)).seats.find((candidate) => candidate.identity === BOB);
  assert.equal(bob.state, 'removed');
  assert.equal(bob.removal_reason, 'contact_absent');
});
