import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppendRecordSchema,
  CommunicationRecordSchema,
  CreateRoomInputSchema,
  LowerCrockfordUlidSchema,
  MessageTextSchema,
  PostMessageInputSchema,
  Rfc3339Schema,
  RoleSchema,
  RoomInviteSchema,
  RoomSchema,
} from '../src/contracts.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const MESSAGE_ID = '01jz6y7n8p9q0r1s2t3v4w5x6z';
const AT = '2026-08-02T10:11:12.345Z';

function room(overrides = {}) {
  return {
    version: 1,
    room_id: ROOM_ID,
    identity_name: `cowork-room-${ROOM_ID}`,
    identity_cid: 'cid-room',
    mission: { goal: 'Ship it', briefing: 'Work together.' },
    state: 'provisioning',
    invites: [],
    seats: [],
    created_at: AT,
    ...overrides,
  };
}

test('IDs are exactly 26 lowercase Crockford ULID characters', () => {
  assert.equal(LowerCrockfordUlidSchema.parse(ROOM_ID), ROOM_ID);
  for (const invalid of [
    ROOM_ID.slice(1),
    `${ROOM_ID}0`,
    ROOM_ID.toUpperCase(),
    `8${ROOM_ID.slice(1)}`,
    `i${ROOM_ID.slice(1)}`,
    `l${ROOM_ID.slice(1)}`,
    `o${ROOM_ID.slice(1)}`,
    `u${ROOM_ID.slice(1)}`,
  ]) {
    assert.throws(() => LowerCrockfordUlidSchema.parse(invalid));
  }
});

test('RFC3339 timestamps require valid calendar/time and colonized bounded offsets', () => {
  for (const valid of [
    '2026-08-02T10:11:12Z',
    '2024-02-29T23:59:59.123456+02:30',
    '2026-01-01T00:00:00-23:59',
  ]) assert.equal(Rfc3339Schema.parse(valid), valid);

  for (const invalid of [
    '2026-08-02T10:11:12+0200',
    '2026-08-02T10:11:12+24:00',
    '2026-08-02T10:11:12+23:60',
    '2026-08-02T10:11:12+99:99',
    '2026-02-29T10:11:12Z',
    '2026-13-01T10:11:12Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z',
  ]) assert.throws(() => Rfc3339Schema.parse(invalid), invalid);
});

test('text bounds count exact UTF-8 bytes, not JavaScript code units', () => {
  assert.equal(RoleSchema.parse('a'), 'a');
  assert.equal(RoleSchema.parse('é'.repeat(128)).length, 128);
  assert.throws(() => RoleSchema.parse(''));
  assert.throws(() => RoleSchema.parse(`${'é'.repeat(128)}a`));

  assert.equal(Buffer.byteLength(MessageTextSchema.parse('🤖'.repeat(65_536))), 262_144);
  assert.throws(() => MessageTextSchema.parse(''));
  assert.throws(() => MessageTextSchema.parse(`${'🤖'.repeat(65_536)}a`));

  assert.equal(RoomSchema.parse(room({ mission: { goal: '🤖'.repeat(65_536), briefing: 'x' } })).version, 1);
  assert.throws(() => RoomSchema.parse(room({ mission: { goal: 'x', briefing: `${'x'.repeat(262_144)}x` } })));
});

test('room and invite schemas are strict, versioned, and enforce invite thresholds', () => {
  assert.equal(RoomSchema.parse(room()).state, 'provisioning');
  for (const state of ['active', 'closing', 'closed']) {
    assert.equal(RoomSchema.parse(room({ state })).state, state);
  }
  for (const invalid of [
    room({ version: 2 }),
    room({ state: 'paused' }),
    { ...room(), extra: true },
  ]) assert.throws(() => RoomSchema.parse(invalid));

  assert.equal(RoomInviteSchema.parse({
    invite_id: 'invite-1', mode: 'public', role: 'reviewer', min_accepts: 2,
    accepted_cids: [], state: 'live', created_at: AT,
  }).min_accepts, 2);
  assert.throws(() => RoomInviteSchema.parse({
    invite_id: 'invite-1', mode: 'public', role: 'reviewer', min_accepts: 0,
    accepted_cids: [], state: 'live', created_at: AT,
  }));
  assert.throws(() => RoomInviteSchema.parse({
    invite_id: 'invite-1', mode: 'one_time', role: 'reviewer', min_accepts: 2,
    accepted_cids: [], state: 'live', created_at: AT,
  }));
  assert.throws(() => RoomInviteSchema.parse({
    invite_id: 'invite-1', mode: 'private', role: 'reviewer', min_accepts: 1,
    accepted_cids: [], state: 'live', created_at: AT,
  }));

  const pending = {
    invite_id: 'invite-2', mode: 'public', role: 'reviewer', min_accepts: 2,
    accepted_cids: [], state: 'receipt_pending', recovery_of: 'invite-1', recovery_confirmed: false, created_at: AT,
  };
  assert.equal(RoomInviteSchema.parse(pending).recovery_of, 'invite-1');
  assert.throws(() => RoomInviteSchema.parse({ ...pending, recovery_of: undefined }));
  assert.throws(() => RoomInviteSchema.parse({ ...pending, recovery_confirmed: undefined }));
  assert.throws(() => RoomInviteSchema.parse({ ...pending, state: 'live' }));
  assert.equal(RoomInviteSchema.parse({ ...pending, state: 'live', recovery_confirmed: true }).recovery_of, 'invite-1');
  assert.equal(RoomInviteSchema.parse({ ...pending, state: 'consumed', recovery_confirmed: true }).recovery_of, 'invite-1');
  assert.equal(RoomInviteSchema.parse({ ...pending, state: 'revoked' }).recovery_of, 'invite-1');
  assert.throws(() => RoomInviteSchema.parse({ ...pending, state: 'revoked', recovery_confirmed: undefined }));
  assert.equal(RoomInviteSchema.parse({ ...pending, state: 'revoked', recovery_confirmed: true }).recovery_confirmed, true);
  assert.throws(() => RoomInviteSchema.parse({
    invite_id: 'ordinary', mode: 'public', role: 'x', min_accepts: 1,
    accepted_cids: [], state: 'live', recovery_confirmed: false, created_at: AT,
  }));

  const source = { ...pending, invite_id: 'invite-1', state: 'replacement_required' };
  delete source.recovery_of;
  delete source.recovery_confirmed;
  assert.equal(RoomSchema.parse(room({ invites: [source, pending] })).invites[1].state, 'receipt_pending');
  assert.throws(() => RoomSchema.parse(room({ invites: [source, { ...pending, role: 'different' }] })));
  assert.throws(() => RoomSchema.parse(room({ invites: [pending] })));

  const confirmedSource = { ...source, state: 'revoked' };
  const confirmed = { ...pending, state: 'live', recovery_confirmed: true };
  assert.equal(RoomSchema.parse(room({ invites: [confirmedSource, confirmed] })).invites[1].recovery_of, 'invite-1');
  assert.throws(() => RoomSchema.parse(room({ invites: [source, confirmed] })));

  const confirmedRevoked = { ...pending, state: 'revoked', recovery_confirmed: true };
  assert.equal(RoomSchema.parse(room({ invites: [confirmedSource, confirmedRevoked] })).invites[1].state, 'revoked');
  assert.throws(
    () => RoomSchema.parse(room({ invites: [source, confirmedRevoked] })),
    /recovery lineage/i,
  );
  const discarded = { ...pending, state: 'revoked', recovery_confirmed: false };
  assert.equal(RoomSchema.parse(room({ invites: [source, discarded] })).invites[1].recovery_confirmed, false);
  assert.equal(RoomSchema.parse(room({ invites: [confirmedSource, discarded] })).invites[1].recovery_confirmed, false);
});

test('only the exact packet-pending room sentinel may have an empty identity CID', () => {
  const pending = room({
    identity_cid: '',
    status: 'packet_pending',
  });
  assert.equal(RoomSchema.parse(pending).identity_cid, '');
  assert.throws(() => RoomSchema.parse({ ...pending, status: undefined }));
  assert.throws(() => RoomSchema.parse({ ...pending, state: 'active', activated_at: AT }));
  assert.throws(() => RoomSchema.parse({ ...pending, identity_name: 'another-name' }));
  assert.throws(() => RoomSchema.parse({ ...pending, invites: [{
    invite_id: 'invite-1', mode: 'one_time', role: 'x', min_accepts: 1,
    accepted_cids: [], state: 'live', created_at: AT,
  }] }));
  assert.throws(() => RoomSchema.parse({ ...pending, seats: [{
    identity: 'cid', display_name: 'Alice', role: 'x', invite_id: 'invite-1', accepted_at: AT,
  }] }));
  assert.throws(() => RoomSchema.parse({ ...pending, activated_at: AT }));
  assert.throws(() => RoomSchema.parse({ ...pending, closed_at: AT }));
});

test('operator request schemas strictly reject caller-supplied authorship', () => {
  const create = { goal: 'Goal', briefing: 'Briefing' };
  assert.deepEqual(CreateRoomInputSchema.parse(create), create);
  const post = { text: 'Hello' };
  assert.deepEqual(PostMessageInputSchema.parse(post), post);

  for (const authorField of ['author', 'author_id', 'author_cid', 'sender', 'sender_id', 'identity']) {
    assert.throws(() => CreateRoomInputSchema.parse({ ...create, [authorField]: 'forged' }));
    assert.throws(() => PostMessageInputSchema.parse({ ...post, [authorField]: 'forged' }));
  }
});

test('communication records form a strict discriminated version-1 union', () => {
  const message = {
    version: 1,
    kind: 'message',
    room_id: ROOM_ID,
    seq: 1,
    record_id: `${ROOM_ID}:1`,
    at: AT,
    message_id: MESSAGE_ID,
    author: { identity: 'cid-alice', display_name: 'Alice', role: 'researcher' },
    category: 'chat',
    text: 'hello',
    recipient_identities: ['cid-bob'],
    source_msg_id: 7,
    source_wire_id: 'wire-7',
  };
  assert.deepEqual(CommunicationRecordSchema.parse(message), message);

  const records = [
    { kind: 'relay_intent', message_id: MESSAGE_ID, recipient_identity: 'cid-bob' },
    { kind: 'relay_result', intent_record_id: `${ROOM_ID}:2`, message_id: MESSAGE_ID, recipient_identity: 'cid-bob', status: 'queued', wire_id: 'wire-out' },
    { kind: 'close_notice_intent', recipient_identity: 'cid-bob' },
    { kind: 'close_notice_result', intent_record_id: `${ROOM_ID}:4`, recipient_identity: 'cid-bob', status: 'send_failed', notified: false, key_material_retained: true, uncertain_after_restart: true },
  ].map((body, index) => ({
    version: 1, room_id: ROOM_ID, seq: index + 2,
    record_id: `${ROOM_ID}:${index + 2}`, at: AT, ...body,
  }));
  for (const record of records) assert.equal(CommunicationRecordSchema.parse(record).kind, record.kind);

  assert.throws(() => CommunicationRecordSchema.parse({ ...message, version: 2 }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, kind: 'delivery_result' }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, record_id: `${ROOM_ID}:2` }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, category: 'system' }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, recipient_identities: ['cid-bob', 'cid-bob'] }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, recipient_identities: ['', 'cid-bob'] }));
  const { recipient_identities: _recipients, ...missingRecipients } = message;
  assert.throws(() => CommunicationRecordSchema.parse(missingRecipients));
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, extra: true }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...records.at(-1), key_material_retained: false }));

  const { seq: _seq, record_id: _recordId, ...appendMessage } = message;
  assert.equal(AppendRecordSchema.parse(appendMessage).kind, 'message');
});
