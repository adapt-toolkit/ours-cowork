import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LegacyCoworkStateError,
  PacketRegistry,
  SdkRoomPacket,
} from '../src/packets.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const IDENTITY = `ours-cowork-${ROOM_ID}`;
const CID = 'AB'.repeat(32);

class FakeClient {
  contacts = [];
  invites = [];
  messages = [];
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

  async listContacts() { return { contacts: structuredClone(this.contacts) }; }
  async listInvites() { return structuredClone(this.invites); }
  async listIncomingMessages() { return structuredClone(this.messages); }
  async listIncomingFiles() { return structuredClone(this.files); }

  async getFiles(input) {
    this.calls.push(['getFiles', structuredClone(input)]);
    return { files: [], text: '', mode: 'selected', requested: input.wire_ids };
  }

  async fetchFile(wireId) {
    this.calls.push(['fetchFile', wireId]);
    return Uint8Array.from(this.bytes.get(wireId) ?? []);
  }

  async deferFiles(input) {
    this.calls.push(['deferFiles', structuredClone(input)]);
    return { deferred: String(input.file_ids.length) };
  }

  async getMessages() {
    this.calls.push(['getMessages']);
    return { count: this.messages.length, messages: structuredClone(this.messages) };
  }

  async deferMessages(input) {
    this.calls.push(['deferMessages', structuredClone(input)]);
    return { deferred: String(input.msg_ids.length) };
  }

  async sendMessage(input) {
    this.calls.push(['sendMessage', structuredClone(input)]);
    return { kind: 'sent', wireId: 'wire-message-out' };
  }

  async sendFile(input) {
    this.calls.push(['sendFile', structuredClone(input)]);
    return {
      kind: 'sent', wireId: 'wire-file-out', filename: input.filename,
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
  client.invites = [{ invite_id: 'invite-1', mode: 'one_time', assigned: '', created: 'now' }];
  client.messages = [{
    msg_id: 7,
    sender_id: CID,
    sender_name: 'Peer',
    text: 'reply body',
    date: '2026-08-15T08:00:00+00:00',
    status: 'unread',
    wire_id: 'wire-message-in',
    reply_to: { wire_id: 'wire-parent', sentence: 2 },
  }];
  client.files = [{
    file_id: 9,
    wire_id: 'wire-file-in',
    from: { id: CID, name: 'Peer' },
    filename: 'proof.bin',
    mime: 'application/octet-stream',
    size: 4,
    size_source: 'received_payload',
    status: 'unread',
    date: '2026-08-15T08:00:01Z',
    sha256: null,
    reply_to: { wire_id: 'wire-parent-file' },
    kind: 'file',
  }];
  client.bytes.set('wire-file-in', Buffer.from([0, 1, 2, 255]));

  const packet = new SdkRoomPacket(IDENTITY, CID, client);
  await packet.refresh();

  assert.deepEqual(packet.listContacts(), client.contacts);
  assert.deepEqual(packet.listInvites(), [{ invite_id: 'invite-1', mode: 'one_time' }]);
  assert.deepEqual(packet.peekInbox(), [{
    msg_id: 7,
    sender_id: CID,
    sender_name: 'Peer',
    text: 'reply body',
    date: '2026-08-15T08:00:00.000Z',
    wire_id: 'wire-message-in',
    reply_to: { wire_id: 'wire-parent', sentence: 2 },
  }]);
  assert.deepEqual(packet.peekFileInbox(), [{
    file_id: 9,
    sender_id: CID,
    sender_name: 'Peer',
    filename: 'proof.bin',
    mime: 'application/octet-stream',
    data: Buffer.from([0, 1, 2, 255]),
    date: '2026-08-15T08:00:01.000Z',
    wire_id: 'wire-file-in',
    reply_to: { wire_id: 'wire-parent-file' },
  }]);
  assert.deepEqual(client.calls.slice(0, 3), [
    ['getFiles', { wire_ids: ['wire-file-in'] }],
    ['fetchFile', 'wire-file-in'],
    ['deferFiles', { file_ids: [9] }],
  ]);

  assert.deepEqual(await packet.send(CID, 'hello', { wire_id: 'wire-parent', sentence: 3 }), {
    status: 'queued', wire_id: 'wire-message-out',
  });
  assert.deepEqual(await packet.sendFile(
    CID, 'proof.bin', 'application/octet-stream', Buffer.from([4, 5]), { wire_id: 'wire-parent-file' },
  ), { status: 'queued', wire_id: 'wire-file-out' });
  assert.deepEqual(client.calls.find(([name]) => name === 'sendMessage'), ['sendMessage', {
    contact: CID, text: 'hello', reply_to_wire_id: 'wire-parent', reply_to_sentence: 3,
  }]);
  assert.deepEqual(client.calls.find(([name]) => name === 'sendFile'), ['sendFile', {
    contact: CID,
    data_base64: 'BAU=',
    filename: 'proof.bin',
    mime: 'application/octet-stream',
    reply_to_wire_id: 'wire-parent-file',
  }]);
});

test('SDK room packet consumes selected messages without stealing unrelated unread work', async () => {
  const client = blankClient();
  client.messages = [7, 8].map((msg_id) => ({
    msg_id,
    sender_id: CID,
    sender_name: 'Peer',
    text: `message ${msg_id}`,
    date: '2026-08-15T08:00:00Z',
    status: 'unread',
    wire_id: `wire-${msg_id}`,
    reply_to: null,
  }));
  const packet = new SdkRoomPacket(IDENTITY, CID, client);
  await packet.refresh();
  assert.deepEqual(await packet.consumeInbox([7]), { consumed: [7], deferred: [8] });
  assert(client.calls.some((call) => call[0] === 'deferMessages' && call[1].msg_ids[0] === 8));
});

test('packet registry creates, restores, releases, and removes standard SDK identities', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-sdk-registry-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let notify;
  let unsubscribed = false;
  const clients = [];
  const host = {
    createClient() { const client = blankClient(); clients.push(client); return client; },
    onIdentityNotify(listener) { notify = listener; return () => { unsubscribed = true; }; },
  };
  const events = [];
  const registry = new PacketRegistry(host, stateDir, { onNotify: (...parts) => events.push(parts) });
  const creating = clients.length;
  assert.equal(creating, 0);
  const createClient = blankClient();
  createClient.chooseFailure = Object.assign(new Error('missing'), { code: 'NO_SUCH_IDENTITY' });
  host.createClient = () => { clients.push(createClient); return createClient; };
  const packet = await registry.create(ROOM_ID, IDENTITY, 'room bio');
  assert.equal(packet.cid, CID);
  assert.deepEqual(createClient.calls.slice(0, 2), [
    ['chooseIdentity', { name: IDENTITY, force: false }],
    ['createIdentity', { name: IDENTITY, bio: 'room bio', exposeLocal: false, localAutoAccept: true }],
  ]);
  notify(IDENTITY);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [[ROOM_ID, 'message_received']]);
  await registry.destroy(ROOM_ID);
  assert(createClient.calls.some((call) => call[0] === 'removeIdentity' && call[1].name === IDENTITY));
  assert(createClient.calls.some((call) => call[0] === 'releaseLease'));

  const restoring = blankClient();
  host.createClient = () => restoring;
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
    onIdentityNotify() { return () => {}; },
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

test('embedded host boots the standard SDK with private owned state and closes its public surface', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-sdk-boot-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/ours-runtime.ts', import.meta.url).href;
  const script = `
    const { EmbeddedOursHost, sdkRuntimeStateDir } = await import(${JSON.stringify(moduleUrl)});
    const config = {
      version: 1,
      brokerUrl: 'ws://127.0.0.1:1',
      stateDir: ${JSON.stringify(stateDir)},
      rest: { enabled: false, port: 3052 },
    };
    const before = { sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') };
    const host = new EmbeddedOursHost(config);
    await host.boot();
    const info = await host.createClient('boot-contract').version();
    const stopped = await host.shutdown();
    const after = { sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') };
    console.log('COWORK_SDK_RESULT ' + JSON.stringify({ info, stopped, before, after, owned: sdkRuntimeStateDir(config) }));
    process.exit(0);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let timeout;
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => { timeout = setTimeout(() => resolve('timeout'), 15_000); }),
  ]);
  clearTimeout(timeout);
  if (exited === 'timeout') child.kill('SIGKILL');
  assert.notEqual(exited, 'timeout', stderr);
  assert.deepEqual(exited, { code: 0, signal: null }, stderr);
  const marker = stdout.split('\n').find((line) => line.startsWith('COWORK_SDK_RESULT '));
  assert(marker, stdout);
  const result = JSON.parse(marker.slice('COWORK_SDK_RESULT '.length));
  assert.equal(result.info.version, '1.5.2');
  assert.deepEqual(result.stopped, { requiresProcessExit: true });
  assert.deepEqual(result.after, result.before);
  assert.equal(result.owned, join(stateDir, 'ours-sdk'));
});
