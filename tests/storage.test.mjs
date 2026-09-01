import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { CoworkStore } from '../src/storage.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const AT = '2026-08-02T10:11:12.345Z';

function room(overrides = {}) {
  return {
    version: 2, room_id: ROOM_ID, room_name: 'Release room',
    identity_name: `cowork-room-${ROOM_ID}`, identity_cid: 'cid-room',
    mission: { goal: 'Ship it', briefing: 'Work together.', briefing_version: 1 },
    role_briefings: {}, rest_roles: [], anonymous: false, quiet_membership: false,
    membership_epoch: 0, state: 'provisioning', invites: [], seats: [], created_at: AT,
    ...overrides,
  };
}

function message(index, overrides = {}) {
  return {
    version: 1, kind: 'message', room_id: ROOM_ID, at: AT,
    message_id: `01jz6y7n8p9q0r1s2t3v4w${String(index).padStart(4, '0')}`,
    author: { identity: 'cid-alice', display_name: 'Alice', role: 'researcher' },
    category: 'chat', text: `message ${index}`, recipient_identities: ['cid-bob'],
    ...overrides,
  };
}

function temporaryStore() {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-sqlite-'));
  return { stateDir, store: new CoworkStore(stateDir), cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

function roomV1(overrides = {}) {
  return {
    version: 1, room_id: ROOM_ID, identity_name: `cowork-room-${ROOM_ID}`,
    identity_cid: 'cid-room', mission: { goal: 'Ship it', briefing: 'Work together.' },
    state: 'provisioning', invites: [], seats: [], created_at: AT, ...overrides,
  };
}

test('room creation provisions only private SQLite storage and metadata', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room());
  const roomDir = join(stateDir, 'rooms', ROOM_ID);
  assert.deepEqual(readdirSync(roomDir).sort(), ['archive.sqlite3', 'blobs', 'room.json']);
  for (const path of [stateDir, join(stateDir, 'rooms'), roomDir, join(roomDir, 'blobs')]) {
    assert.equal(statSync(path).mode & 0o777, 0o700);
  }
  assert.equal(statSync(join(roomDir, 'archive.sqlite3')).mode & 0o777, 0o600);
  assert.deepEqual(await store.load(ROOM_ID), room());
  assert.deepEqual((await store.list()).map((value) => value.room_id), [ROOM_ID]);
});

test('concurrent appends assign durable monotonic sequence and record ids across restart', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room());
  const appended = await Promise.all(Array.from({ length: 24 }, (_, index) => store.append(ROOM_ID, message(index))));
  assert.deepEqual(appended.map((record) => record.seq).sort((a, b) => a - b), Array.from({ length: 24 }, (_, index) => index + 1));
  const restarted = new CoworkStore(stateDir);
  const last = await restarted.append(ROOM_ID, message(24));
  assert.equal(last.seq, 25);
  assert.equal(last.record_id, `${ROOM_ID}:25`);
});

test('append validates caller payload once and does not rehash validated file bytes', () => {
  const source = readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  const append = source.slice(source.indexOf('async append('), source.indexOf('async read('));
  assert.equal((append.match(/AppendRecordSchema\.parse/g) ?? []).length, 1);
  assert.equal(append.includes('CommunicationRecordSchema.parse'), false);
  const persistBlob = source.slice(source.indexOf('private persistBlob('), source.indexOf('private removeUnreferencedBlob('));
  assert.equal(persistBlob.includes('createHash('), false);
});

test('bounded reads decode only selected rows, never earlier archive payloads', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room());
  for (let index = 0; index < 100; index += 1) await store.append(ROOM_ID, message(index));
  const databasePath = join(stateDir, 'rooms', ROOM_ID, 'archive.sqlite3');
  const db = new Database(databasePath);
  db.prepare("UPDATE records SET payload_json = '{broken' WHERE seq = 1").run();
  db.close();
  const page = await store.read(ROOM_ID, { after: 95, limit: 3 });
  assert.deepEqual(page.map((record) => record.seq), [96, 97, 98]);
  await assert.rejects(store.read(ROOM_ID, { limit: 1 }), /malformed JSON.*sequence 1/);
});

test('indexed unresolved and source queries avoid archive-wide validation', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room());
  const source = await store.append(ROOM_ID, message(1, { source_msg_id: 42 }));
  const intent = await store.append(ROOM_ID, {
    version: 1, kind: 'relay_intent', room_id: ROOM_ID, at: AT,
    message_id: source.message_id, recipient_identity: 'cid-bob',
  });
  assert.equal((await store.query(ROOM_ID, { kind: 'message', sourceMsgId: 42, limit: 1 }))[0].record_id, source.record_id);
  assert.deepEqual((await store.query(ROOM_ID, { kind: 'relay_intent', unresolvedResultKind: 'relay_result' })).map((row) => row.record_id), [intent.record_id]);
  await store.append(ROOM_ID, {
    version: 1, kind: 'relay_result', room_id: ROOM_ID, at: AT,
    intent_record_id: intent.record_id, message_id: source.message_id,
    recipient_identity: 'cid-bob', status: 'queued',
  });
  assert.deepEqual(await store.query(ROOM_ID, { kind: 'relay_intent', unresolvedResultKind: 'relay_result' }), []);
});

test('settled relay history leaves constant bounded work for the next message', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room());
  for (let index = 0; index < 100; index += 1) {
    const source = await store.append(ROOM_ID, message(index));
    await store.append(ROOM_ID, {
      version: 1, kind: 'relay_intent', room_id: ROOM_ID, at: AT,
      message_id: source.message_id, recipient_identity: 'cid-bob',
    });
  }
  const latest = await store.append(ROOM_ID, message(100));
  assert.deepEqual(
    (await store.recordsNeedingRelayIntents(ROOM_ID, { limit: 1 })).map((record) => record.seq),
    [latest.seq],
  );
  assert.deepEqual(await store.relayRecipientsNeedingIntent(ROOM_ID, latest.seq), ['cid-bob']);

  const db = new Database(join(stateDir, 'rooms', ROOM_ID, 'archive.sqlite3'), { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM relay_intent_work').get().count, 1);
  const plan = db.prepare(`EXPLAIN QUERY PLAN
    SELECT source.seq FROM relay_intent_work work INDEXED BY relay_work_source
    JOIN records source ON source.seq = work.record_seq
    WHERE work.record_seq > ? GROUP BY source.seq ORDER BY source.seq LIMIT ?`).all(0, 1);
  assert(plan.some((row) => String(row.detail).includes('relay_work_source')));
  db.close();
});

test('recipient fan-out work is read in fixed batches', async (t) => {
  const { store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const recipients = Array.from({ length: 130 }, (_, index) => `cid-${String(index).padStart(3, '0')}`);
  const source = await store.append(ROOM_ID, message(1, { recipient_identities: recipients }));
  const first = await store.relayRecipientsNeedingIntent(ROOM_ID, source.seq);
  assert.equal(first.length, 64);
  for (const recipient of first) {
    await store.append(ROOM_ID, {
      version: 1, kind: 'relay_intent', room_id: ROOM_ID, at: AT,
      message_id: source.message_id, recipient_identity: recipient,
    });
  }
  assert.equal((await store.relayRecipientsNeedingIntent(ROOM_ID, source.seq)).length, 64);
});

test('briefing coverage uses recipient-first indexed projections with legacy version-one semantics', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room());
  await store.append(ROOM_ID, message(1, {
    category: 'briefing', briefing_version: undefined,
    recipient_identities: ['cid-bob', 'cid-carol'],
  }));
  const deliveries = await store.briefingDeliveryTimes(ROOM_ID, {
    category: 'briefing', briefingVersion: 1,
  }, ['cid-bob', 'cid-missing']);
  assert.deepEqual([...deliveries], [['cid-bob', AT]]);
  const db = new Database(join(stateDir, 'rooms', ROOM_ID, 'archive.sqlite3'), { readonly: true });
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT records.at FROM record_recipients recipients
    INDEXED BY recipients_briefing_delivery JOIN records ON records.seq = recipients.record_seq
    WHERE recipients.recipient_identity = ? AND recipients.category = ?
      AND recipients.briefing_role IS ? AND recipients.briefing_version = ?
    ORDER BY recipients.record_seq LIMIT 1`).all('cid-bob', 'briefing', null, 1);
  assert(plan.some((row) => String(row.detail).includes('recipients_briefing_delivery')));
  db.close();
});

test('file bytes live in immutable external blobs while selected projections retain base64', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room());
  const bytes = Buffer.from('immutable file bytes');
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const file = await store.append(ROOM_ID, {
    version: 1, kind: 'file', room_id: ROOM_ID, at: AT,
    file_id: '01jz6y7n8p9q0r1s2t3v4w5999',
    author: { identity: 'cid-alice', display_name: 'Alice', role: 'researcher' },
    filename: 'proof.txt', mime: 'text/plain', size: bytes.length, sha256: digest,
    data_base64: bytes.toString('base64'), recipient_identities: ['cid-bob'], source_file_id: 7,
  });
  const blob = join(stateDir, 'rooms', ROOM_ID, 'blobs', digest);
  assert.equal(readFileSync(blob).toString(), bytes.toString());
  assert.equal((await store.query(ROOM_ID, { kind: 'file', fileId: file.file_id }))[0].data_base64, bytes.toString('base64'));
  const db = new Database(join(stateDir, 'rooms', ROOM_ID, 'archive.sqlite3'), { readonly: true });
  assert.equal(db.prepare('SELECT payload_json FROM records WHERE seq=?').get(file.seq).payload_json.includes('data_base64'), false);
  db.close();
});

test('blob references are canonical and digest-bound before any filesystem read', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room());
  const bytes = Buffer.from('safe blob');
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const file = await store.append(ROOM_ID, {
    version: 1, kind: 'file', room_id: ROOM_ID, at: AT,
    file_id: '01jz6y7n8p9q0r1s2t3v4w5997',
    author: { identity: 'cid-a', display_name: 'A', role: 'r' },
    filename: 'a.txt', mime: 'text/plain', size: bytes.length, sha256: digest,
    data_base64: bytes.toString('base64'), recipient_identities: [], source_file_id: 9,
  });
  const outside = join(stateDir, 'outside-owner-file'); writeFileSync(outside, 'do not read', { mode: 0o600 });
  const path = join(stateDir, 'rooms', ROOM_ID, 'archive.sqlite3'); const db = new Database(path);
  db.prepare('UPDATE records SET blob_path = ? WHERE seq = ?').run('../../outside-owner-file', file.seq); db.close();
  await assert.rejects(store.query(ROOM_ID, { kind: 'file', fileId: file.file_id, limit: 1 }), /invalid blob reference/);
});

test('delete is closed-only, fail-closed on residue, and removes SQLite plus blobs', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room());
  await assert.rejects(store.delete(ROOM_ID), /must be closed/);
  await store.save(room({ state: 'closed', closed_at: AT }));
  await store.delete(ROOM_ID);
  assert.equal(existsSync(join(stateDir, 'rooms', ROOM_ID)), false);
  await store.delete(ROOM_ID);
});

test('discardPendingProvisioning removes only the exact empty fresh sentinel', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  const identityName = 'ours-cowork:Release room';
  await store.create(room({ identity_name: identityName, identity_cid: '', status: 'packet_pending' }));
  await assert.rejects(store.discardPendingProvisioning(ROOM_ID, 'ours-cowork:Different'), /exact empty provisioning sentinel/);
  assert.equal(existsSync(join(stateDir, 'rooms', ROOM_ID)), true);
  await store.discardPendingProvisioning(ROOM_ID, identityName);
  assert.equal(existsSync(join(stateDir, 'rooms', ROOM_ID)), false);
});

test('discardPendingProvisioning preserves every metadata guard mismatch', async (t) => {
  const identityName = 'ours-cowork:Release room';
  const mismatches = [
    ['state', (value) => { value.state = 'active'; }],
    ['missing status', (value) => { delete value.status; }],
    ['nonempty CID', (value) => { value.identity_cid = 'cid-room'; }],
    ['invites', (value) => { value.invites = [{
      invite_id: 'invite-1', mode: 'public', role: 'reviewer', min_accepts: 1,
      accepted_cids: [], state: 'live', created_at: AT,
    }]; }],
    ['seats', (value) => { value.seats = [{
      identity: 'cid-member', display_name: 'Member', role: 'reviewer',
      invite_id: 'invite-1', state: 'active', accepted_at: AT,
    }]; }],
  ];
  for (const [label, mutate] of mismatches) {
    const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
    await store.create(room({ identity_name: identityName, identity_cid: '', status: 'packet_pending' }));
    const roomDir = join(stateDir, 'rooms', ROOM_ID);
    const metadataPath = join(roomDir, 'room.json');
    const descriptor = JSON.parse(readFileSync(metadataPath, 'utf8'));
    mutate(descriptor);
    writeFileSync(metadataPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
    const before = readFileSync(metadataPath, 'utf8');
    await assert.rejects(store.discardPendingProvisioning(ROOM_ID, identityName));
    assert.equal(existsSync(roomDir), true, `${label} mismatch must preserve the room`);
    assert.equal(readFileSync(metadataPath, 'utf8'), before, `${label} mismatch must preserve metadata`);
  }
});

test('discardPendingProvisioning fails closed on archive, blob, or unexpected residue', async (t) => {
  for (const residue of ['archive', 'blob', 'unexpected']) {
    const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
    const identityName = 'ours-cowork:Release room';
    await store.create(room({ identity_name: identityName, identity_cid: '', status: 'packet_pending' }));
    const roomDir = join(stateDir, 'rooms', ROOM_ID);
    if (residue === 'archive') await store.append(ROOM_ID, message(1));
    if (residue === 'blob') writeFileSync(join(roomDir, 'blobs', 'residue'), 'x');
    if (residue === 'unexpected') writeFileSync(join(roomDir, 'unexpected'), 'x');
    await assert.rejects(store.discardPendingProvisioning(ROOM_ID, identityName), /archive records|file blobs|unexpected.*residue/i);
    assert.equal(existsSync(roomDir), true, `${residue} mismatch must preserve the room`);
  }
});

test('delete rejects SQLite residue when metadata is missing outside its valid removal order', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room({ state: 'closed', closed_at: AT }));
  unlinkSync(join(stateDir, 'rooms', ROOM_ID, 'room.json'));
  await assert.rejects(store.delete(ROOM_ID), /archive residue without deletion metadata/);
});

test('SQLite durability policy is WAL with FULL synchronous commits', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  await store.create(room());
  await store.append(ROOM_ID, message(1));
  assert.deepEqual(await store.durability(ROOM_ID), { journalMode: 'wal', synchronous: 2 });
});

test('relay and close recovery paths use unresolved indexes instead of archive scans', () => {
  const intake = readFileSync(new URL('../src/intake.ts', import.meta.url), 'utf8');
  const service = readFileSync(new URL('../src/service.ts', import.meta.url), 'utf8');
  const relay = intake.slice(intake.indexOf('private async relayPendingUnlocked'), intake.indexOf('private findSourceMessage'));
  const close = service.slice(service.indexOf('private async closeUnlocked'), service.indexOf('private async appendUncertainCloseResult'));
  assert.equal(relay.includes('this.store.read('), false);
  assert.equal(close.includes('this.store.read('), false);
  assert.match(relay, /unresolvedResultKind:\s*'relay_result'/);
  assert.match(close, /unresolvedResultKind:\s*'close_notice_result'/);
});

test('metadata replacement fsyncs temp before rename and directory after it', async (t) => {
  const events = []; const paths = new Map();
  const ops = new Proxy(fs, { get(target, property) {
    if (property === 'openSync') return (path, ...args) => { const fd = target.openSync(path, ...args); paths.set(fd, String(path)); return fd; };
    if (property === 'closeSync') return (fd) => { paths.delete(fd); return target.closeSync(fd); };
    if (property === 'fsyncSync') return (fd) => { events.push(['fsync', paths.get(fd)]); return target.fsyncSync(fd); };
    if (property === 'renameSync') return (from, to) => { events.push(['rename', String(from), String(to)]); return target.renameSync(from, to); };
    return Reflect.get(target, property);
  }});
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup);
  const injected = new CoworkStore(stateDir, { fs: ops });
  await injected.create(room()); events.length = 0;
  await injected.save(room({ state: 'active', activated_at: AT }));
  const rename = events.findIndex((event) => event[0] === 'rename' && event[2].endsWith('room.json'));
  assert(rename > 0);
  assert(events.slice(0, rename).some((event) => event[0] === 'fsync' && event[1].includes('room.json.tmp-')));
  assert(events.slice(rename + 1).some((event) => event[0] === 'fsync' && event[1] === join(stateDir, 'rooms', ROOM_ID)));
});

test('metadata rename failure preserves the prior complete snapshot and permits retry', async (t) => {
  let fail = false;
  const ops = new Proxy(fs, { get(target, property) {
    if (property === 'renameSync') return (from, to) => {
      if (fail && String(to).endsWith('room.json')) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      return target.renameSync(from, to);
    };
    return Reflect.get(target, property);
  }});
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-sqlite-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const store = new CoworkStore(stateDir, { fs: ops }); await store.create(room());
  fail = true;
  await assert.rejects(store.save(room({ state: 'active', activated_at: AT })), /injected rename failure/);
  assert.equal((await new CoworkStore(stateDir).load(ROOM_ID)).state, 'provisioning');
  fail = false; await store.save(room({ state: 'active', activated_at: AT }));
  assert.equal((await store.load(ROOM_ID)).state, 'active');
});

test('room directory creation failure cleans its reservation and permits retry', async (t) => {
  let fail = true;
  const ops = new Proxy(fs, { get(target, property) {
    if (property === 'chmodSync') return (path, mode) => {
      if (fail && String(path).endsWith(ROOM_ID)) { fail = false; throw Object.assign(new Error('injected chmod failure'), { code: 'EIO' }); }
      return target.chmodSync(path, mode);
    };
    return Reflect.get(target, property);
  }});
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-sqlite-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const store = new CoworkStore(stateDir, { fs: ops });
  await assert.rejects(store.create(room()), /injected chmod failure/);
  assert.equal(existsSync(join(stateDir, 'rooms', ROOM_ID)), false);
  await store.create(room());
});

test('room mutex is reentrant, excludes competitors, and propagates unawaited child failures', async (t) => {
  const { store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const order = []; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = store.mutex(ROOM_ID, async () => {
    order.push('root');
    await store.mutex(ROOM_ID, async () => { order.push('nested'); await gate; });
    order.push('root-done');
  });
  const second = store.mutex(ROOM_ID, () => { order.push('competitor'); });
  await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(order, ['root', 'nested']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(order, ['root', 'nested', 'root-done', 'competitor']);
  await assert.rejects(store.mutex(ROOM_ID, () => { void store.mutex(ROOM_ID, async () => { throw new Error('child failure'); }); }), /child failure/);
  await store.mutex(ROOM_ID, () => undefined);
});

test('database, metadata, and blob symlinks and hardlinks fail closed', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const roomDir = join(stateDir, 'rooms', ROOM_ID); const outside = join(stateDir, 'outside');
  writeFileSync(outside, 'outside', { mode: 0o600 });
  const metadata = join(roomDir, 'room.json'); const savedMetadata = readFileSync(metadata);
  unlinkSync(metadata); linkSync(outside, metadata);
  await assert.rejects(store.load(ROOM_ID), /safe regular file|hardlink|link count/i);
  unlinkSync(metadata); writeFileSync(metadata, savedMetadata, { mode: 0o600 });
  const database = join(roomDir, 'archive.sqlite3'); unlinkSync(database); symlinkSync(outside, database);
  await assert.rejects(store.read(ROOM_ID), /symbolic link|safe regular file/i);
});

test('open/path inode substitution is detected for metadata reads', async (t) => {
  let swap = false; const paths = new Map();
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-sqlite-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ops = new Proxy(fs, { get(target, property) {
    if (property === 'openSync') return (path, ...args) => {
      const fd = target.openSync(path, ...args); paths.set(fd, String(path));
      if (swap && String(path).endsWith('room.json')) {
        const replacement = `${path}.replacement`; writeFileSync(replacement, readFileSync(path), { mode: 0o600 }); target.renameSync(replacement, path);
      }
      return fd;
    };
    return Reflect.get(target, property);
  }});
  const store = new CoworkStore(stateDir, { fs: ops }); await store.create(room()); swap = true;
  await assert.rejects(store.load(ROOM_ID), /inode changed during open|hardlink|link count/i);
});

test('failed record transaction removes only its newly-created unreferenced blob', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-sqlite-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let fail = true; const store = new CoworkStore(stateDir, { beforeRecordCommit: () => { if (fail) throw new Error('injected pre-commit failure'); } });
  await store.create(room()); const bytes = Buffer.from('orphan candidate'); const { createHash } = await import('node:crypto'); const digest = createHash('sha256').update(bytes).digest('hex');
  const input = { version: 1, kind: 'file', room_id: ROOM_ID, at: AT, file_id: '01jz6y7n8p9q0r1s2t3v4w5998', author: { identity: 'cid-a', display_name: 'A', role: 'r' }, filename: 'a.txt', mime: 'text/plain', size: bytes.length, sha256: digest, data_base64: bytes.toString('base64'), recipient_identities: [], source_file_id: 8 };
  await assert.rejects(store.append(ROOM_ID, input), /injected pre-commit failure/);
  assert.equal(existsSync(join(stateDir, 'rooms', ROOM_ID, 'blobs', digest)), false);
  fail = false; await new CoworkStore(stateDir).append(ROOM_ID, input);
  assert.equal(existsSync(join(stateDir, 'rooms', ROOM_ID, 'blobs', digest)), true);
});

test('restart deterministically removes a crash-left unreferenced immutable blob', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const orphan = join(stateDir, 'rooms', ROOM_ID, 'blobs', 'a'.repeat(64));
  writeFileSync(orphan, 'crash-left bytes', { mode: 0o600 });
  await new CoworkStore(stateDir).read(ROOM_ID, { limit: 1 });
  assert.equal(existsSync(orphan), false);
});

test('restart removes only recognized crash-left blob temporaries and rejects arbitrary residue', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const blobs = join(stateDir, 'rooms', ROOM_ID, 'blobs');
  const temporary = join(blobs, '.tmp-123-0123456789abcdef'); writeFileSync(temporary, 'partial', { mode: 0o600 });
  await new CoworkStore(stateDir).read(ROOM_ID, { limit: 1 });
  assert.equal(existsSync(temporary), false);
  writeFileSync(join(blobs, '.tmp-not-recognized'), 'unknown', { mode: 0o600 });
  await assert.rejects(new CoworkStore(stateDir).read(ROOM_ID, { limit: 1 }), /unexpected room blob residue/);
});

test('later opens reject unknown schema versions without executing repair DDL', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const path = join(stateDir, 'rooms', ROOM_ID, 'archive.sqlite3'); const db = new Database(path); db.pragma('user_version = 99'); db.close();
  await assert.rejects(store.read(ROOM_ID), /unsupported room archive schema version 99/);
});

test('SQLite main, WAL, SHM, metadata, and blob files are forced private', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const path = join(stateDir, 'rooms', ROOM_ID, 'archive.sqlite3');
  const holder = new Database(path); holder.pragma('journal_mode = WAL'); holder.exec("BEGIN IMMEDIATE; INSERT INTO records(seq,record_id,kind,at,payload_json) VALUES(999,'x','x','x','x');");
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) chmodSync(candidate, 0o666);
  await store.durability(ROOM_ID);
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) assert.equal(statSync(candidate).mode & 0o777, 0o600);
  holder.exec('ROLLBACK'); holder.close();
});

test('SQLite WAL and SHM sidecars fail closed before database open when unsafe', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const path = join(stateDir, 'rooms', ROOM_ID, 'archive.sqlite3'); const outside = join(stateDir, 'outside-sidecar');
  writeFileSync(outside, 'outside', { mode: 0o600 });
  symlinkSync(outside, `${path}-wal`);
  await assert.rejects(store.read(ROOM_ID, { limit: 1 }), /SQLite file.*symbolic link/i);
  unlinkSync(`${path}-wal`); linkSync(outside, `${path}-shm`);
  await assert.rejects(store.read(ROOM_ID, { limit: 1 }), /SQLite file.*safe regular file|link count/i);
});

test('delete rejects unexpected residue and resumes after archive removal', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room({ state: 'closed', closed_at: AT }));
  const roomDir = join(stateDir, 'rooms', ROOM_ID); writeFileSync(join(roomDir, 'unexpected'), 'x');
  await assert.rejects(store.delete(ROOM_ID), /unexpected residue/); unlinkSync(join(roomDir, 'unexpected'));
  unlinkSync(join(roomDir, 'archive.sqlite3')); rmSync(join(roomDir, 'blobs'), { recursive: true, force: true });
  await store.delete(ROOM_ID); assert.equal(existsSync(roomDir), false);
});

test('v1 metadata migration preserves exact backup bytes and is stable across restart', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const v1 = roomV1({ state: 'active', activated_at: AT, invites: [{ invite_id: 'invite-1', mode: 'public', role: 'reviewer', min_accepts: 1, accepted_cids: ['cid-alice'], state: 'live', created_at: AT }], seats: [{ identity: 'cid-alice', display_name: 'Alice', role: 'reviewer', invite_id: 'invite-1', accepted_at: AT }] });
  const roomDir = join(stateDir, 'rooms', ROOM_ID); const original = `${JSON.stringify(v1)}\n`;
  writeFileSync(join(roomDir, 'room.json'), original, { mode: 0o600 });
  const migrated = await store.load(ROOM_ID);
  assert.equal(migrated.version, 2); assert.equal(migrated.room_name, 'Room 01jz6y7n');
  assert.match(migrated.seats[0].participant_id, /^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  assert.equal(readFileSync(join(roomDir, 'room.json.v1.bak'), 'utf8'), original);
  assert.deepEqual(await new CoworkStore(stateDir).load(ROOM_ID), migrated);
});

test('partial v1 backup is replaced while an intact prior backup is retained', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const roomDir = join(stateDir, 'rooms', ROOM_ID); const original = `${JSON.stringify(roomV1())}\n`; const backup = join(roomDir, 'room.json.v1.bak');
  writeFileSync(join(roomDir, 'room.json'), original, { mode: 0o600 }); writeFileSync(backup, original.slice(0, 40), { mode: 0o600 });
  await store.load(ROOM_ID); assert.equal(readFileSync(backup, 'utf8'), original);
  const intact = `${JSON.stringify(roomV1({ mission: { goal: 'Older', briefing: 'Older.' } }))}\n`;
  writeFileSync(join(roomDir, 'room.json'), original, { mode: 0o600 }); writeFileSync(backup, intact, { mode: 0o600 });
  await store.load(ROOM_ID); assert.equal(readFileSync(backup, 'utf8'), intact);
});

test('restoring a v1 backup re-migrates with fresh participant ids', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const roomDir = join(stateDir, 'rooms', ROOM_ID); const v1 = roomV1({ state: 'active', activated_at: AT, invites: [{ invite_id: 'i', mode: 'public', role: 'r', min_accepts: 1, accepted_cids: ['cid-a'], state: 'live', created_at: AT }], seats: [{ identity: 'cid-a', display_name: 'A', role: 'r', invite_id: 'i', accepted_at: AT }] });
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(v1)}\n`, { mode: 0o600 }); const first = await store.load(ROOM_ID);
  fs.copyFileSync(join(roomDir, 'room.json.v1.bak'), join(roomDir, 'room.json')); unlinkSync(join(roomDir, 'room.json.v1.bak'));
  const second = await store.load(ROOM_ID); assert.notEqual(second.seats[0].participant_id, first.seats[0].participant_id);
});

test('legacy v2 metadata canonicalizes names and defaults persisted fields', async (t) => {
  const { stateDir, store, cleanup } = temporaryStore(); t.after(cleanup); await store.create(room());
  const roomDir = join(stateDir, 'rooms', ROOM_ID); const legacy = room({ room_name: '  Cafe\u0301 launch  ' }); delete legacy.rest_roles;
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const loaded = await store.load(ROOM_ID); assert.equal(loaded.room_name, 'Café launch'); assert.deepEqual(loaded.rest_roles, []);
  const persisted = JSON.parse(readFileSync(join(roomDir, 'room.json'), 'utf8')); assert.equal(persisted.room_name, 'Café launch'); assert.deepEqual(persisted.rest_roles, []);
});
