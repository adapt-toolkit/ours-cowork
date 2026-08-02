import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppendRecordSchema,
  CommunicationRecordSchema,
  CreateRoomInputSchema,
  LowerCrockfordUlidSchema,
  MessageTextSchema,
  PostMessageInputSchema,
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
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, extra: true }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...records.at(-1), key_material_retained: false }));

  const { seq: _seq, record_id: _recordId, ...appendMessage } = message;
  assert.equal(AppendRecordSchema.parse(appendMessage).kind, 'message');
});
