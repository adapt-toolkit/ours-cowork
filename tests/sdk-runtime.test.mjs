import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LegacyCoworkStateError,
  PacketRegistry,
  SdkRoomPacket,
} from '../src/packets.ts';
import { SharedOursHost } from '../src/ours-runtime.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const IDENTITY = `ours-cowork-${ROOM_ID}`;
const FRIENDLY_IDENTITY = `ours-cowork-release-room-${ROOM_ID}`;
const CID = 'AB'.repeat(32);
const MESSAGE_WIRE = 'core-message-wire-in';
const SECOND_MESSAGE_WIRE = 'core-message-wire-second';
const FILE_WIRE = '22'.repeat(32);
const PARENT_WIRE = 'core-message-wire-parent';
const PARENT_FILE_WIRE = '44'.repeat(32);
const MESSAGE_OUT_WIRE = '55'.repeat(32);
const FILE_OUT_WIRE = '66'.repeat(32);

class FakeClient {
  contacts = [];
  origins;
  invites = [];
  messages = [];
  messageHistory = new Map();
  files = [];
  bytes = new Map();
  calls = [];
  chooseResult = { name: IDENTITY, cid: CID, switchedFrom: null };
  chooseFailure;

  async chooseIdentity(input) {
    this.calls.push(['chooseIdentity', input]);
    if (this.chooseFailure) throw this.chooseFailure;
    return this.chooseResult;
  }

  async createIdentity(input) {
    this.calls.push(['createIdentity', input]);
    return { info: { cid: CID } };
  }

  async listContacts() {
    return {
      contacts: structuredClone(this.contacts),
      ...(this.origins === undefined ? {} : { origins: structuredClone(this.origins) }),
    };
  }
  async listInvites() { return structuredClone(this.invites); }
  async listIncomingMessages() { return structuredClone(this.messages); }
  async listIncomingFiles() { return structuredClone(this.files); }

  async getHistoryItem(input) {
    this.calls.push(['getHistoryItem', structuredClone(input)]);
    return structuredClone(this.messageHistory.get(input.wire_id) ?? null);
  }

  async getFiles(input) {
    this.calls.push(['getFiles', structuredClone(input)]);
    const selected = this.files.filter((file) => input.wire_ids.includes(file.wire_id) && file.status === 'unread');
    for (const file of selected) {
      file.status = 'read';
      file.inbox_state = 'read';
    }
    return {
      files: selected.map((file) => ({
        file_id: file.file_id,
        wire_id: file.wire_id,
        from: file.from,
        filename: file.filename,
        path: file.blob_path,
        mime: file.mime,
        size: file.size,
        sha256: file.sha256,
        status: 'processed',
        date: file.date,
        kind: file.kind,
        sender: file.from.name,
      })),
      text: '', mode: 'selected', requested: input.wire_ids,
      remaining: this.files.filter((file) => file.status === 'unread').length,
    };
  }

  async fetchFile(wireId) {
    this.calls.push(['fetchFile', wireId]);
    return Uint8Array.from(this.bytes.get(wireId) ?? []);
  }

  async getMessages(input = {}) {
    this.calls.push(['getMessages', structuredClone(input)]);
    const limit = input.limit ?? this.messages.length;
    const selected = this.messages
      .filter((message) => message.status === 'unread')
      .sort((left, right) => left.seq - right.seq)
      .slice(0, limit);
    const histories = selected.map((message) => {
      message.status = 'read';
      message.inbox_state = 'read';
      const history = this.messageHistory.get(message.wire_id);
      history.status = 'read';
      history.inbox_state = 'read';
      return structuredClone(history);
    });
    return {
      messages: histories,
      remaining: this.messages.filter((message) => message.status === 'unread').length,
    };
  }

  async sendMessage(input) {
    this.calls.push(['sendMessage', structuredClone(input)]);
    return {
      kind: 'sent', wireId: MESSAGE_OUT_WIRE, wire_id: MESSAGE_OUT_WIRE,
      sent: true, history_stored: false,
    };
  }

  async sendFile(input) {
    this.calls.push(['sendFile', structuredClone(input)]);
    return {
      kind: 'sent', wireId: FILE_OUT_WIRE, wire_id: FILE_OUT_WIRE,
      sent: true, history_stored: false, filename: input.filename,
      bytes: Buffer.from(input.data_base64, 'base64').length, mime: input.mime,
    };
  }

  async generateInvite(input) {
    this.calls.push(['generateInvite', structuredClone(input)]);
    return { blob: 'invite-blob', inviteId: 'invite-1', mode: input.mode };
  }

  async revokeInvite(input) {
    this.calls.push(['revokeInvite', structuredClone(input)]);
    return { revoked: true, wasPublic: false };
  }

  async addContact(input) {
    this.calls.push(['addContact', structuredClone(input)]);
    return { cid: CID, display: 'Peer' };
  }

  async removeContact(input) {
    this.calls.push(['removeContact', structuredClone(input)]);
    return { name: 'Peer', cid: input.contact, notified: true };
  }

  async removeIdentity(input) { this.calls.push(['removeIdentity', structuredClone(input)]); }
  async releaseLease() { this.calls.push(['releaseLease']); return { released: [IDENTITY] }; }
}

function blankClient() { return new FakeClient(); }

test('SDK room packet maps message/file/reply state and uses only typed public operations', async () => {
  const client = blankClient();
  client.contacts = [{ name: 'Peer', container_id: CID }];
  client.origins = {
    [CID]: 'invite-1',
  };
  client.invites = [{ invite_id: 'invite-1', mode: 'one_time', assigned: '', created: 'now' }];
  client.messages = [{
    seq: 1,
    msg_id: 7,
    from: { id: CID, name: 'Peer' },
    occurred_at_ms: Date.parse('2026-08-15T08:00:00Z'),
    date: '2026-08-15T08:00:00+00:00',
    encryption: 'e2e',
    inbox_state: 'unread',
    status: 'unread',
    wire_id: MESSAGE_WIRE,
    reply_to: { wire_id: PARENT_WIRE, sentence: 2 },
  }];
  client.messageHistory.set(MESSAGE_WIRE, {
    ...client.messages[0],
    peer: { id: CID, name: 'Peer' }, direction: 'in', text: 'reply body', body: 'reply body',
    transport: 'double_ratchet', delivery_state: null, human_read_at_ms: null,
  });
  const bytes = Buffer.from([0, 1, 2, 255]);
  client.files = [{
    seq: 2,
    file_id: 9,
    wire_id: FILE_WIRE,
    from: { id: CID, name: 'Peer' },
    peer: { id: CID, name: 'Peer' },
    direction: 'in',
    filename: 'proof.bin',
    mime: 'application/octet-stream',
    size: 4,
    byte_length: 4,
    occurred_at_ms: Date.parse('2026-08-15T08:00:01Z'),
    encryption: 'e2e',
    inbox_state: 'unread',
    status: 'unread',
    delivery_state: null,
    human_read_at_ms: null,
    date: '2026-08-15T08:00:01Z',
    sha256: '3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56',
    reply_to: { wire_id: PARENT_FILE_WIRE },
    blob_path: '/identity/blobs/proof.bin',
    kind: 'file',
  }];
  client.bytes.set(FILE_WIRE, bytes);

  const packet = new SdkRoomPacket(IDENTITY, CID, client);
  await packet.refresh();

  assert.equal(packet.supportsInviteProvenance, true);
  assert.deepEqual(packet.listContacts(), [{
    ...client.contacts[0],
    accepted_via_invite_id: client.origins[CID],
  }]);
  assert.deepEqual(packet.listInvites(), [{ invite_id: 'invite-1', mode: 'one_time' }]);
  assert.deepEqual(await packet.listUnreadMessages(32), [{
    msg_id: 7,
    sender_id: CID,
    sender_name: 'Peer',
    text: 'reply body',
    date: '2026-08-15T08:00:00.000Z',
    wire_id: MESSAGE_WIRE,
    reply_to: { wire_id: PARENT_WIRE, sentence: 2 },
  }]);
  const unreadFiles = await packet.listUnreadFiles(32);
  assert.deepEqual(unreadFiles, [{
    file_id: 9,
    sender_id: CID,
    sender_name: 'Peer',
    filename: 'proof.bin',
    mime: 'application/octet-stream',
    data: Buffer.from([0, 1, 2, 255]),
    date: '2026-08-15T08:00:01.000Z',
    wire_id: FILE_WIRE,
    reply_to: { wire_id: PARENT_FILE_WIRE },
  }]);
  assert.deepEqual(client.calls.slice(0, 2), [
    ['getHistoryItem', { wire_id: MESSAGE_WIRE }],
    ['fetchFile', FILE_WIRE],
  ]);
  await packet.acknowledgeFile(unreadFiles[0]);
  assert.deepEqual(client.calls[2], ['getFiles', { wire_ids: [FILE_WIRE] }]);

  assert.deepEqual(await packet.send(CID, 'hello', { wire_id: PARENT_WIRE, sentence: 3 }), {
    status: 'queued', wire_id: MESSAGE_OUT_WIRE,
  });
  assert.deepEqual(await packet.sendFile(
    CID, 'proof.bin', 'application/octet-stream', Buffer.from([4, 5]), { wire_id: PARENT_FILE_WIRE },
  ), { status: 'queued', wire_id: FILE_OUT_WIRE });
  assert.deepEqual(client.calls.find(([name]) => name === 'sendMessage'), ['sendMessage', {
    contact: CID, text: 'hello', reply_to_wire_id: PARENT_WIRE, reply_to_sentence: 3,
  }]);
  assert.deepEqual(client.calls.find(([name]) => name === 'sendFile'), ['sendFile', {
    contact: CID,
    data_base64: 'BAU=',
    filename: 'proof.bin',
    mime: 'application/octet-stream',
    reply_to_wire_id: PARENT_FILE_WIRE,
  }]);
});

test('SDK room packet promotes an older raced message through intake before acknowledging the expected row', async () => {
  const client = blankClient();
  client.messages = [7, 8].map((msg_id, index) => ({
    seq: index + 1,
    msg_id,
    from: { id: CID, name: 'Peer' },
    occurred_at_ms: Date.parse('2026-08-15T08:00:00Z') + index,
    date: '2026-08-15T08:00:00Z',
    encryption: 'e2e',
    inbox_state: msg_id === 7 ? 'pending_introduction' : 'unread',
    status: msg_id === 7 ? 'pending_introduction' : 'unread',
    wire_id: msg_id === 7 ? MESSAGE_WIRE : SECOND_MESSAGE_WIRE,
    reply_to: null,
  }));
  client.messages[0].status = 'pending_introduction';
  for (const message of client.messages) client.messageHistory.set(message.wire_id, {
    ...message, peer: message.from, direction: 'in', text: `message ${message.msg_id}`,
    body: `message ${message.msg_id}`, transport: 'double_ratchet', delivery_state: null,
    human_read_at_ms: null,
  });
  const packet = new SdkRoomPacket(IDENTITY, CID, client);
  const [expected] = await packet.listUnreadMessages(32);
  assert.equal(expected.msg_id, 8);
  client.messages[0].status = 'unread';
  client.messages[0].inbox_state = 'unread';
  client.messageHistory.get(MESSAGE_WIRE).status = 'unread';
  client.messageHistory.get(MESSAGE_WIRE).inbox_state = 'unread';
  const promoted = [];
  await packet.acknowledgeMessage(expected, async (item) => { promoted.push(item); });
  assert.deepEqual(promoted.map((item) => item.msg_id), [7]);
  assert.deepEqual(
    client.calls.filter(([name]) => name === 'getMessages'),
    [['getMessages', { limit: 1 }], ['getMessages', { limit: 1 }]],
  );
  assert.equal(client.messages.every((message) => message.status === 'read'), true);
});

test('SDK room packet treats an empty message acknowledgement as an already-read expected row', async () => {
  const client = blankClient();
  const packet = new SdkRoomPacket(IDENTITY, CID, client);
  await packet.acknowledgeMessage({
    msg_id: 9, sender_id: CID, sender_name: 'Peer', text: 'durable',
    date: '2026-08-15T08:00:00.000Z', wire_id: MESSAGE_WIRE, reply_to: null,
  }, async () => assert.fail('an empty response has no promoted row'));
  assert.deepEqual(client.calls, [['getMessages', { limit: 1 }]]);
});

test('SDK room packet preserves queued deferred sends and accepted introduced wire IDs', async () => {
  const client = blankClient();
  const packet = new SdkRoomPacket(IDENTITY, CID, client);
  client.sendMessage = async () => ({ kind: 'deferred', wireId: MESSAGE_OUT_WIRE, queued: 1 });
  assert.deepEqual(await packet.send(CID, 'queued'), {
    status: 'queued', wire_id: MESSAGE_OUT_WIRE,
  });
  client.sendMessage = async () => ({
    kind: 'introduced', text: 'introduced', wireId: MESSAGE_OUT_WIRE,
    wire_id: MESSAGE_OUT_WIRE, sent: true, history_stored: false,
  });
  assert.deepEqual(await packet.send(CID, 'introduced'), {
    status: 'queued', wire_id: MESSAGE_OUT_WIRE,
  });
});

test('successful contact removal evicts only its target without a fallible post-mutation refresh', async () => {
  const client = blankClient();
  const otherCid = 'CD'.repeat(32);
  client.contacts = [
    { name: 'Peer', container_id: CID },
    { name: 'Other', container_id: otherCid },
  ];
  const packet = new SdkRoomPacket(IDENTITY, CID, client);
  await packet.refresh();
  client.listContacts = async () => { throw new Error('post-mutation refresh failed'); };

  assert.deepEqual(await packet.removeContact(CID), {
    status: 'queued', notified: true, key_material_retained: true,
  });
  assert.deepEqual(packet.listContacts(), [{ name: 'Other', container_id: otherCid }]);
  assert.deepEqual(client.calls.find(([name]) => name === 'removeContact'), [
    'removeContact', { contact: CID },
  ]);
});

test('contact-only refresh succeeds without listing invites', async () => {
  const client = blankClient();
  client.contacts = [{ name: 'Peer', container_id: CID }];
  client.listInvites = async () => { throw new Error('invite listing unavailable'); };
  const packet = new SdkRoomPacket(IDENTITY, CID, client);
  await packet.refreshContacts();
  assert.deepEqual(packet.listContacts(), client.contacts);
});

test('packet registry creates, restores, releases, and removes standard SDK identities', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-sdk-registry-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let notify;
  let unsubscribed = false;
  const clients = [];
  let available = new Set();
  const host = {
    async createClient() { const client = blankClient(); clients.push(client); return client; },
    async listIdentityNames(localNames) {
      return new Set([...available].filter((name) => localNames.has(name)));
    },
    onIdentityNotify(listener) { notify = listener; return () => { unsubscribed = true; }; },
    trackIdentity() { return () => {}; },
  };
  const events = [];
  const registry = new PacketRegistry(host, stateDir, { onNotify: (...parts) => events.push(parts) });
  const creating = clients.length;
  assert.equal(creating, 0);
  const createClient = blankClient();
  host.createClient = async () => { clients.push(createClient); return createClient; };
  const packet = await registry.create(ROOM_ID, IDENTITY, 'room bio');
  assert.equal(packet.cid, CID);
  assert.deepEqual(createClient.calls.slice(0, 1), [
    ['createIdentity', { name: IDENTITY, bio: 'room bio', exposeLocal: false, localAutoAccept: true }],
  ]);
  notify(IDENTITY);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [[ROOM_ID, 'message_received']]);
  await registry.destroy(ROOM_ID);
  assert(createClient.calls.some((call) => call[0] === 'removeIdentity' && call[1].name === IDENTITY));
  assert(createClient.calls.some((call) => call[0] === 'releaseLease'));

  const restoring = blankClient();
  available = new Set([IDENTITY]);
  host.createClient = async () => restoring;
  await registry.restore(ROOM_ID, CID, IDENTITY);
  await registry.unhostAll();
  assert(restoring.calls.some((call) => call[0] === 'releaseLease'));
  assert.equal(unsubscribed, true);
});

test('packet registry refuses pre-1.0 actor state with recreate and re-invite guidance', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-sdk-legacy-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const host = {
    createClient() { assert.fail('legacy state must fail before an SDK lease is created'); },
    listIdentityNames() { assert.fail('legacy state must fail before daemon identity discovery'); },
    onIdentityNotify() { return () => {}; },
    trackIdentity() { return () => {}; },
  };
  const registry = new PacketRegistry(host, stateDir);
  await assert.rejects(
    registry.restore(ROOM_ID, CID, `cowork-room-${ROOM_ID}`),
    (error) => error instanceof LegacyCoworkStateError && /recreate.*re-invite/i.test(error.message),
  );

  const live = join(stateDir, 'rooms', ROOM_ID, 'live');
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, 'state_data.bin'), 'legacy');
  await assert.rejects(
    registry.restore(ROOM_ID, CID, IDENTITY),
    (error) => error instanceof LegacyCoworkStateError && /pre-1\.0 custom packet/i.test(error.message),
  );
});

test('fresh provisioning rejects a colliding name without creating a lease or adopting by name', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-sdk-collision-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const host = {
    async listIdentityNames(localNames) {
      assert.deepEqual(localNames, new Set([FRIENDLY_IDENTITY]));
      return new Set([FRIENDLY_IDENTITY]);
    },
    async createClient() { assert.fail('a collision must fail before creating a client lease'); },
    onIdentityNotify() { return () => {}; },
    trackIdentity() { return () => {}; },
  };
  const registry = new PacketRegistry(host, stateDir);
  await assert.rejects(
    registry.create(ROOM_ID, FRIENDLY_IDENTITY),
    /unproven.*refusing to adopt/i,
  );
});

test('restore accepts persisted friendly names only with an exact durable CID', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-sdk-friendly-restore-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const client = blankClient();
  client.chooseResult = { name: FRIENDLY_IDENTITY, cid: CID, switchedFrom: null };
  const host = {
    async listIdentityNames() { return new Set([FRIENDLY_IDENTITY]); },
    async createClient() { return client; },
    onIdentityNotify() { return () => {}; },
    trackIdentity() { return () => {}; },
  };
  const registry = new PacketRegistry(host, stateDir);
  await assert.rejects(
    registry.restore(ROOM_ID, undefined, FRIENDLY_IDENTITY),
    /without a durably recorded expected CID/i,
  );
  const packet = await registry.restore(ROOM_ID, CID, FRIENDLY_IDENTITY);
  assert.equal(packet.name, FRIENDLY_IDENTITY);
  assert.equal(packet.cid, CID);
  assert.deepEqual(client.calls.find(([name]) => name === 'chooseIdentity'), [
    'chooseIdentity', { name: FRIENDLY_IDENTITY, force: false },
  ]);
});

test('established room restore fails clearly when its locally recorded name is absent globally', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-sdk-missing-established-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const host = {
    async listIdentityNames(localNames) {
      assert.deepEqual(localNames, new Set([IDENTITY]));
      return new Set();
    },
    async createClient() { assert.fail('missing established identity must not be created'); },
    onIdentityNotify() { return () => {}; },
    trackIdentity() { return () => {}; },
  };
  const registry = new PacketRegistry(host, stateDir);
  await assert.rejects(
    registry.restore(ROOM_ID, CID, IDENTITY),
    /shared ours daemon does not contain the established room identity/,
  );
});

test('shared host attaches through SDK 3, filters daemon-global names, and releases only its leases', async () => {
  const calls = [];
  const watcher = {
    async identities() {
      return [{ name: IDENTITY }, { name: 'unrelated-human' }, { name: 'other-app-room' }];
    },
    async releaseLease() { calls.push(['releaseLease', 'watch']); return { released: [] }; },
    async *watchNotifications() { /* no events */ },
  };
  const room = blankClient();
  const attach = async ({ leaseToken }) => {
    calls.push(['attach', leaseToken]);
    return leaseToken === 'room-lease' ? room : watcher;
  };
  const host = new SharedOursHost(() => {}, attach);

  await host.boot();
  assert.deepEqual(
    await host.listIdentityNames(new Set([IDENTITY, 'local-but-absent'])),
    new Set([IDENTITY]),
  );
  assert.equal(await host.createClient('room-lease'), room);
  assert.deepEqual(await host.shutdown(), { requiresProcessExit: false });
  assert.deepEqual(calls, [
    ['attach', calls[0][1]],
    ['attach', 'room-lease'],
    ['releaseLease', 'watch'],
  ]);
});

test('shared host exposes attach failure and never falls back to another runtime', async () => {
  const unavailable = new Error('shared daemon unavailable');
  const host = new SharedOursHost(() => {}, async () => { throw unavailable; });
  await assert.rejects(host.boot(), (error) => error === unavailable);
  await assert.rejects(host.createClient(), /not booted/);
});
