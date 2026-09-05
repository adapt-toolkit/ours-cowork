import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  AppendRecordSchema,
  AcceptExternalInviteInputSchema,
  CommunicationRecordSchema,
  CoworkIdentityNameError,
  CreateRoomInputSchema,
  FileMimeSchema,
  FileNameSchema,
  isPersistedRoomIdentityName,
  isStandardRoomIdentityName,
  LowerCrockfordUlidSchema,
  MessageTextSchema,
  MAX_FILE_BYTES,
  MAX_ROOM_IDENTITY_TITLE_CHARACTERS,
  PostMessageInputSchema,
  Rfc3339Schema,
  RoleSchema,
  RoomInviteSchema,
  RoomNameSchema,
  RoomSchema,
  RoomV1Schema,
  SeatSchema,
  UpdateRoomInputSchema,
  defaultRoomName,
  migrateRoomV1,
  roomIdentityName,
  sdkIdentityNameError,
} from '../src/contracts.ts';

const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const MESSAGE_ID = '01jz6y7n8p9q0r1s2t3v4w5x6z';
const AT = '2026-08-02T10:11:12.345Z';

function room(overrides = {}) {
  return {
    version: 2,
    room_id: ROOM_ID,
    room_name: 'Release room',
    identity_name: 'ours-cowork:Release room',
    identity_cid: 'cid-room',
    mission: { goal: 'Ship it', briefing: 'Work together.', briefing_version: 1 },
    role_briefings: {},
    rest_roles: [],
    role_command_grants: [],
    anonymous: false,
    quiet_membership: false,
    membership_epoch: 0,
    state: 'provisioning',
    invites: [],
    seats: [],
    created_at: AT,
    ...overrides,
  };
}

function roomAsV1(overrides = {}) {
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

  assert.equal(RoomSchema.parse(room({ mission: { goal: '🤖'.repeat(65_536), briefing: 'x', briefing_version: 1 } })).version, 2);
  assert.throws(() => RoomSchema.parse(room({ mission: { goal: 'x', briefing: `${'x'.repeat(262_144)}x`, briefing_version: 1 } })));
});

test('room names trim, NFC-normalize, count Unicode code points, and reject control/format characters', () => {
  assert.equal(RoomNameSchema.parse('  Cafe\u0301  '), 'Café');
  assert.equal(RoomNameSchema.parse('🤖'.repeat(64)), '🤖'.repeat(64));
  for (const invalid of [
    '',
    '   ',
    'a'.repeat(65),
    'line\nbreak',
    '\ntrimmed-looking',
    'zero\u200bwidth',
    '\ufeffleading-format',
    'direction\u202ereversed',
  ]) assert.throws(() => RoomNameSchema.parse(invalid), JSON.stringify(invalid));

  assert.deepEqual(CreateRoomInputSchema.parse({ name: '  Cafe\u0301  ', goal: 'Goal', briefing: 'Brief' }), {
    name: 'Café', goal: 'Goal', briefing: 'Brief',
  });
  assert.deepEqual(UpdateRoomInputSchema.parse({ name: '  Renamed  ' }), { name: 'Renamed' });
});

test('room identity names preserve normalized text within the 64-code-point SDK boundary', () => {
  assert.equal(MAX_ROOM_IDENTITY_TITLE_CHARACTERS, 52);
  assert.equal(roomIdentityName('  Cafe\u0301 launch  '), 'ours-cowork:Café launch');
  assert.equal(roomIdentityName('研发 🚀'), 'ours-cowork:研发 🚀');
  assert.equal(Array.from(roomIdentityName('a'.repeat(51))).length, 63);
  assert.equal(Array.from(roomIdentityName('a'.repeat(52))).length, 64);
  assert.equal(roomIdentityName('a'.repeat(53)), `ours-cowork:${'a'.repeat(52)}`);
  assert.equal(roomIdentityName('🤖'.repeat(64)), `ours-cowork:${'🤖'.repeat(52)}`);
  assert.equal(roomIdentityName('e\u0301'.repeat(64)), `ours-cowork:${'é'.repeat(52)}`);
  assert.equal(roomIdentityName(`${'a'.repeat(52)}/tail`), `ours-cowork:${'a'.repeat(52)}`);
  assert.throws(
    () => roomIdentityName(`${'a'.repeat(51)}/tail`),
    (error) => error instanceof CoworkIdentityNameError && error.code === 'NAME_INVALID',
  );
  assert.equal(isPersistedRoomIdentityName(ROOM_ID, 'ours-cowork:Café launch'), true);
  assert.equal(isStandardRoomIdentityName(ROOM_ID, 'ours-cowork:Café launch'), true);
  const installedDefectSentinel = `ours-cowork:${'a'.repeat(64)}`;
  assert.equal(isPersistedRoomIdentityName(ROOM_ID, installedDefectSentinel), true);
  assert.equal(isStandardRoomIdentityName(ROOM_ID, installedDefectSentinel), false);
  for (const invalid of [
    '',
    'ours-cowork:',
    'ours-cowork:  Release room',
    'ours-cowork:Cafe\u0301 launch',
    `ours-cowork:${'a'.repeat(65)}`,
    `ours-cowork:bad\u200bname`,
    `ours-cowork-${ROOM_ID}`,
    `cowork-room-${ROOM_ID}`,
  ]) assert.equal(isPersistedRoomIdentityName(ROOM_ID, invalid), false, invalid);
  assert.throws(() => roomIdentityName('  '));
});

test('otherwise unnamed current rooms receive the deterministic display fallback', () => {
  const unnamed = room();
  delete unnamed.room_name;
  assert.equal(RoomSchema.parse(unnamed).room_name, defaultRoomName(ROOM_ID));
  assert.equal(defaultRoomName(ROOM_ID), 'Room 01jz6y7n');
});

test('each additive v2 default is injected independently of the others', () => {
  // The regression this guards: room_name and rest_roles were added at different
  // times, so a single guarded early-return would default whichever field it was
  // written for and silently skip the other on every room that already has it.
  const named = room();
  delete named.rest_roles;
  assert.deepEqual(RoomSchema.parse(named).rest_roles, []);
  assert.equal(RoomSchema.parse(named).room_name, 'Release room');

  const unnamed = room();
  delete unnamed.room_name;
  delete unnamed.rest_roles;
  const both = RoomSchema.parse(unnamed);
  assert.deepEqual(both.rest_roles, []);
  assert.equal(both.room_name, defaultRoomName(ROOM_ID));

  // an explicit value is never overwritten by the default
  assert.deepEqual(RoomSchema.parse(room({ rest_roles: ['Reviewer'] })).rest_roles, ['Reviewer']);
  assert.throws(() => RoomSchema.parse(room({ rest_roles: ['room'] })), /reserved/i);
  assert.throws(() => RoomSchema.parse(room({ rest_roles: ['Reviewer', 'Reviewer'] })), /unique/i);
  assert.throws(() => RoomSchema.parse(room({ rest_roles: ['x'.repeat(257)] })));
  assert.throws(() => RoomSchema.parse(room({ rest_roles: 'Reviewer' })));
});

test('file policy is opaque binary with path-free names, bounded MIME metadata, and a 2 MiB ceiling', () => {
  assert.equal(MAX_FILE_BYTES, 2_097_152);
  assert.equal(FileNameSchema.parse('evidence.tar.gz'), 'evidence.tar.gz');
  for (const invalid of ['', '.', '..', '../secret', 'a/b', 'a\\b', 'x'.repeat(256)]) {
    assert.throws(() => FileNameSchema.parse(invalid), invalid);
  }
  assert.equal(FileMimeSchema.parse(''), '');
  assert.equal(FileMimeSchema.parse('application/x-custom; profile=test'), 'application/x-custom; profile=test');
  assert.throws(() => FileMimeSchema.parse('x'.repeat(256)));
});

test('room and invite schemas are strict, versioned, and enforce invite thresholds', () => {
  assert.equal(RoomSchema.parse(room()).state, 'provisioning');
  for (const state of ['active', 'closing', 'closed']) {
    assert.equal(RoomSchema.parse(room({ state })).state, state);
  }
  for (const invalid of [
    room({ version: 1 }),
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
  assert.equal(RoomSchema.parse({
    ...pending,
    identity_name: roomIdentityName(pending.room_name),
  }).identity_cid, '');
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

test('pending external seats require digest/request metadata and never duplicate authority by CID', () => {
  const pending = seatV2({
    accepted_at: undefined,
    requested_at: AT,
    invite_sha256: 'a'.repeat(64),
    state: 'pending',
  });
  assert.equal(RoomSchema.parse(roomV2({ seats: [pending] })).seats[0].state, 'pending');
  assert.throws(() => RoomSchema.parse(roomV2({ seats: [{ ...pending, requested_at: undefined }] })));
  assert.throws(() => RoomSchema.parse(roomV2({ seats: [{ ...pending, accepted_at: AT }] })));
  assert.throws(() => RoomSchema.parse(roomV2({ seats: [pending, seatV2({ participant_id: PID_2 })] })), /one pending or active/i);
  const cancelled = { ...pending, state: 'removed', removed_at: AT, removed_epoch: 0 };
  assert.equal(RoomSchema.parse(roomV2({ seats: [cancelled] })).seats[0].accepted_at, undefined);
  assert.throws(() => RoomSchema.parse(roomV2({ seats: [{
    ...cancelled, requested_at: undefined, invite_sha256: undefined,
  }] })), /accepted_at/i);
  assert.deepEqual(AcceptExternalInviteInputSchema.parse({
    role: 'reviewer', invite: 'abc', expected_cid: 'ab'.repeat(32),
  }), { role: 'reviewer', invite: 'abc', expected_cid: 'AB'.repeat(32) });
  assert.throws(() => AcceptExternalInviteInputSchema.parse({ role: 'reviewer', invite: 'abc', expected_cid: 'nope' }));
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
    source_reply_to: { wire_id: 'wire-parent', sentence: 2 },
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
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, source_reply_to: { wire_id: 'wire-parent', sentence: 0 } }));
  const { recipient_identities: _recipients, ...missingRecipients } = message;
  assert.throws(() => CommunicationRecordSchema.parse(missingRecipients));
  assert.throws(() => CommunicationRecordSchema.parse({ ...message, extra: true }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...records.at(-1), key_material_retained: false }));

  const { seq: _seq, record_id: _recordId, ...appendMessage } = message;
  assert.equal(AppendRecordSchema.parse(appendMessage).kind, 'message');
});

test('file archive records bind canonical bytes, size, digest, and one relay subject', () => {
  const bytes = Buffer.from([0, 1, 2, 255]);
  const file = {
    version: 1,
    kind: 'file',
    room_id: ROOM_ID,
    seq: 1,
    record_id: `${ROOM_ID}:1`,
    at: AT,
    file_id: MESSAGE_ID,
    author: { identity: 'cid-alice', display_name: 'Alice', role: 'researcher' },
    filename: 'evidence.bin',
    mime: 'application/octet-stream',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data_base64: bytes.toString('base64'),
    recipient_identities: ['cid-bob'],
    source_file_id: 7,
    source_wire_id: 'wire-file-7',
    source_reply_to: { wire_id: 'wire-parent-file' },
  };
  assert.equal(CommunicationRecordSchema.parse(file).kind, 'file');
  assert.throws(() => CommunicationRecordSchema.parse({ ...file, size: bytes.length + 1 }), /size/i);
  assert.throws(() => CommunicationRecordSchema.parse({ ...file, sha256: '0'.repeat(64) }), /sha256/i);
  assert.throws(() => CommunicationRecordSchema.parse({ ...file, data_base64: `${file.data_base64}=` }), /base64/i);

  const intent = {
    version: 1, kind: 'relay_intent', room_id: ROOM_ID, seq: 2,
    record_id: `${ROOM_ID}:2`, at: AT, file_id: MESSAGE_ID, recipient_identity: 'cid-bob',
  };
  assert.equal(CommunicationRecordSchema.parse(intent).file_id, MESSAGE_ID);
  assert.throws(() => CommunicationRecordSchema.parse({ ...intent, message_id: MESSAGE_ID }), /exactly one/i);
  const { file_id: _fileId, ...missing } = intent;
  assert.throws(() => CommunicationRecordSchema.parse(missing), /exactly one/i);
});

// ---- Room metadata, anonymity, and membership contracts v2 -----------------

const PID_1 = '01jz6y7n8p9q0r1s2t3v4w5x70';
const PID_2 = '01jz6y7n8p9q0r1s2t3v4w5x71';
const PID_3 = '01jz6y7n8p9q0r1s2t3v4w5x72';

function seatV2(overrides = {}) {
  return {
    identity: 'cid-alice',
    display_name: 'Alice',
    role: 'reviewer',
    invite_id: 'invite-1',
    accepted_at: AT,
    participant_id: PID_1,
    state: 'active',
    ...overrides,
  };
}

function roomV2(overrides = {}) {
  return {
    version: 2,
    room_id: ROOM_ID,
    room_name: 'Release room',
    identity_name: `cowork-room-${ROOM_ID}`,
    identity_cid: 'cid-room',
    mission: { goal: 'Ship it', briefing: 'Work together.', briefing_version: 1 },
    role_briefings: {},
    rest_roles: [],
    role_command_grants: [],
    anonymous: false,
    quiet_membership: false,
    membership_epoch: 0,
    state: 'provisioning',
    invites: [],
    seats: [],
    created_at: AT,
    ...overrides,
  };
}

test('runtime-command grants default empty and bind unique commands to active CIDs', () => {
  assert.deepEqual(RoomSchema.parse(roomV2()).command_grants, []);
  assert.deepEqual(RoomSchema.parse(roomV2()).role_command_grants, []);
  const cid = 'A'.repeat(64);
  const granted = roomV2({
    seats: [seatV2({ identity: cid })],
    command_grants: [{ caller_cid: cid.toLowerCase(), command: 'list-members' }],
  });
  assert.deepEqual(RoomSchema.parse(granted).command_grants, [
    { caller_cid: cid, command: 'list-members' },
  ]);
  assert.throws(() => RoomSchema.parse({
    ...granted,
    command_grants: [granted.command_grants[0], granted.command_grants[0]],
  }), /unique/i);
  assert.throws(() => RoomSchema.parse({
    ...granted,
    seats: [seatV2({ identity: cid, state: 'removed', removed_at: AT, removed_epoch: 0 })],
  }), /active room identity/i);
});

test('runtime role-command policy is exact, unique, and backwards-compatible', () => {
  const configured = RoomSchema.parse(roomV2({
    role_command_grants: [{ role: 'Configurable owner', commands: ['list-members', 'remove-member'] }],
  }));
  assert.deepEqual(configured.role_command_grants, [
    { role: 'Configurable owner', commands: ['list-members', 'remove-member'] },
  ]);
  assert.throws(() => RoomSchema.parse(roomV2({
    role_command_grants: [
      { role: 'same', commands: ['list-members'] },
      { role: 'same', commands: ['remove-member'] },
    ],
  })), /unique by role/i);
  assert.throws(() => RoomSchema.parse(roomV2({
    role_command_grants: [{ role: 'role', commands: ['list-members', 'list-members'] }],
  })), /commands must be unique/i);
  assert.throws(() => RoomSchema.parse(roomV2({
    role_command_grants: [{ role: '', commands: ['list-members'] }],
  })), /role/i);
  assert.throws(() => RoomSchema.parse(roomV2({
    role_command_grants: [{ role: 'role', commands: ['filesystem-admin'] }],
  })), /invalid_enum_value|invalid enum/i);
});

test('room schema v2 round-trips briefing versions, anonymity, and membership fields', () => {
  const value = roomV2({
    anonymous: true,
    quiet_membership: true,
    membership_epoch: 2,
    command_grants: [],
    role_briefings: {
      reviewer: { text: 'Review the diffs.', version: 3, updated_at: AT },
      Participant: { text: 'Welcome.', version: 1, updated_at: AT },
    },
    seats: [
      seatV2({ alias: 'reviewer #1' }),
      seatV2({
        identity: 'cid-bob', display_name: 'Bob', participant_id: PID_2,
        alias: 'reviewer #2', state: 'removed', removed_at: AT, removed_epoch: 1,
      }),
      seatV2({
        identity: 'cid-carol', display_name: 'Carol', participant_id: PID_3,
        alias: 'reviewer #3',
      }),
    ],
  });
  assert.deepEqual(RoomSchema.parse(value), value);
  assert.equal(RoomSchema.parse(roomV2()).membership_epoch, 0);
});

test('room schema v2 rejects v1 payloads and invalid membership/anonymity combos', () => {
  // version literal is 2; v1 rooms only enter through explicit migration
  assert.throws(() => RoomSchema.parse(roomAsV1()));
  assert.throws(() => RoomSchema.parse(roomV2({ version: 1 })));
  // core v2 top-level fields are required
  for (const missing of ['anonymous', 'quiet_membership', 'membership_epoch', 'role_briefings']) {
    const { [missing]: _dropped, ...rest } = roomV2();
    assert.throws(() => RoomSchema.parse(rest), missing);
  }
  const { briefing_version: _bv, ...missionV1 } = roomV2().mission;
  assert.throws(() => RoomSchema.parse(roomV2({ mission: missionV1 })));
  // alias required iff anonymous
  assert.throws(() => RoomSchema.parse(roomV2({ anonymous: true, seats: [seatV2()] })));
  assert.throws(() => RoomSchema.parse(roomV2({ seats: [seatV2({ alias: 'reviewer #1' })] })));
  // removed seats need removal metadata; active seats must not carry it
  assert.throws(() => RoomSchema.parse(roomV2({ membership_epoch: 1, seats: [seatV2({ state: 'removed' })] })));
  assert.throws(() => RoomSchema.parse(roomV2({ membership_epoch: 1, seats: [seatV2({ state: 'removed', removed_at: AT })] })));
  assert.throws(() => RoomSchema.parse(roomV2({ seats: [seatV2({ removed_at: AT })] })));
  assert.throws(() => RoomSchema.parse(roomV2({ seats: [seatV2({ removed_epoch: 0 })] })));
  // removal epochs stay within the room's membership epoch
  assert.throws(() => RoomSchema.parse(roomV2({
    membership_epoch: 1,
    seats: [seatV2({ state: 'removed', removed_at: AT, removed_epoch: 2 })],
  })));
  // participant ids are unique; active aliases are unique
  assert.throws(() => RoomSchema.parse(roomV2({
    seats: [seatV2(), seatV2({ identity: 'cid-bob', display_name: 'Bob' })],
  })));
  assert.throws(() => RoomSchema.parse(roomV2({
    anonymous: true,
    seats: [
      seatV2({ alias: 'reviewer #1' }),
      seatV2({ identity: 'cid-bob', display_name: 'Bob', participant_id: PID_2, alias: 'reviewer #1' }),
    ],
  })));
  // role briefing keys obey role bounds
  assert.throws(() => RoomSchema.parse(roomV2({
    role_briefings: { ['x'.repeat(257)]: { text: 't', version: 1, updated_at: AT } },
  })));
});

test('legacy participant replacement lineage is accepted only to be discarded', () => {
  const invite = {
    invite_id: 'invite-1', mode: 'one_time', role: 'reviewer', min_accepts: 1,
    accepted_cids: [], state: 'live', created_at: AT, replaces_seat: PID_1,
  };
  assert.equal(Object.hasOwn(RoomInviteSchema.parse(invite), 'replaces_seat'), false);
  assert.throws(() => RoomInviteSchema.parse({ ...invite, replaces_seat: '' }));
  assert.equal(Object.hasOwn(SeatSchema.parse(seatV2({ replaces_seat: PID_1 })), 'replaces_seat'), false);
});

test('create input accepts per-room anonymity and quiet membership configuration', () => {
  assert.deepEqual(
    CreateRoomInputSchema.parse({ goal: 'g', briefing: 'b' }),
    { goal: 'g', briefing: 'b' },
  );
  const value = CreateRoomInputSchema.parse({ goal: 'g', briefing: 'b', anonymous: true, quiet_membership: true });
  assert.equal(value.anonymous, true);
  assert.equal(value.quiet_membership, true);
  assert.throws(() => CreateRoomInputSchema.parse({ goal: 'g', briefing: 'b', anonymous: 'yes' }));
});

test('migrateRoomV1 maps v1 rooms onto additive v2 defaults', () => {
  const seated = roomAsV1({
    state: 'active',
    activated_at: AT,
    invites: [{
      invite_id: 'invite-1', mode: 'public', role: 'reviewer', min_accepts: 1,
      accepted_cids: ['cid-alice'], state: 'live', created_at: AT,
    }],
    seats: [{
      identity: 'cid-alice', display_name: 'Alice', role: 'reviewer',
      invite_id: 'invite-1', accepted_at: AT,
    }],
  });
  const ulids = [PID_1, PID_2];
  const migrated = migrateRoomV1(RoomV1Schema.parse(seated), () => ulids.shift());
  assert.equal(migrated.version, 2);
  assert.equal(migrated.anonymous, false);
  assert.equal(migrated.quiet_membership, false);
  assert.equal(migrated.membership_epoch, 0);
  assert.deepEqual(migrated.role_briefings, {});
  assert.deepEqual(migrated.rest_roles, []);
  assert.equal(migrated.mission.briefing_version, 1);
  assert.equal(migrated.mission.goal, 'Ship it');
  assert.equal(migrated.seats[0].participant_id, PID_1);
  assert.equal(migrated.seats[0].state, 'active');
  assert.equal(migrated.seats[0].alias, undefined);
  assert.deepEqual(RoomSchema.parse(migrated), migrated);
});

test('message records gain role_briefing and membership categories with pinned payloads', () => {
  const common = {
    version: 1, room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: AT,
    kind: 'message', message_id: MESSAGE_ID,
    author: { identity: 'cid-room', display_name: 'room-name', role: 'room' },
    recipient_identities: ['cid-alice'],
  };
  // pre-evolution records parse unchanged
  assert.equal(CommunicationRecordSchema.parse({ ...common, category: 'briefing', text: 'b' }).category, 'briefing');
  assert.equal(CommunicationRecordSchema.parse({ ...common, category: 'chat', text: 'c' }).category, 'chat');
  // versioned common briefing
  const versionedBriefing = { ...common, category: 'briefing', text: 'b', briefing_version: 2 };
  assert.equal(CommunicationRecordSchema.parse(versionedBriefing).briefing_version, 2);
  // per-role briefing requires role + version
  const roleBriefing = { ...common, category: 'role_briefing', text: 'r', briefing_role: 'reviewer', briefing_version: 3 };
  assert.deepEqual(CommunicationRecordSchema.parse(roleBriefing), roleBriefing);
  assert.throws(() => CommunicationRecordSchema.parse({ ...common, category: 'role_briefing', text: 'r' }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...common, category: 'role_briefing', text: 'r', briefing_role: 'reviewer' }));
  // membership notices carry action/alias/epoch, never identities
  const membership = {
    ...common, category: 'membership', text: 'reviewer #2 left the room',
    membership: { action: 'remove', alias: 'reviewer #2', role: 'reviewer', epoch: 3 },
  };
  assert.deepEqual(CommunicationRecordSchema.parse(membership), membership);
  assert.throws(() => CommunicationRecordSchema.parse({ ...common, category: 'membership', text: 'x' }));
  // chat records must not carry briefing or membership payloads
  assert.throws(() => CommunicationRecordSchema.parse({ ...common, category: 'chat', text: 'c', briefing_version: 1 }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...common, category: 'chat', text: 'c', briefing_role: 'reviewer' }));
  assert.throws(() => CommunicationRecordSchema.parse({
    ...common, category: 'chat', text: 'c',
    membership: { action: 'remove', alias: 'a', role: 'r', epoch: 1 },
  }));
});

test('legacy membership journals remain readable but cannot be appended', () => {
  const intent = {
    version: 1, room_id: ROOM_ID, seq: 5, record_id: `${ROOM_ID}:5`, at: AT,
    kind: 'membership_intent', action: 'remove', participant_id: PID_1,
    recipient_identity: 'cid-alice', role: 'reviewer', epoch: 1, notify: true,
    alias: 'reviewer #1',
  };
  assert.deepEqual(CommunicationRecordSchema.parse(intent).participant_id, PID_1);
  const result = {
    version: 1, room_id: ROOM_ID, seq: 6, record_id: `${ROOM_ID}:6`, at: AT,
    kind: 'membership_result', intent_record_id: `${ROOM_ID}:5`, participant_id: PID_1,
    status: 'queued', notified: true, key_material_retained: true,
  };
  assert.deepEqual(CommunicationRecordSchema.parse(result).status, 'queued');
  assert.throws(() => CommunicationRecordSchema.parse({ ...result, key_material_retained: false }));
  assert.throws(() => CommunicationRecordSchema.parse({ ...intent, action: 'promote' }));
  const { seq: _s, record_id: _r, ...appendIntent } = intent;
  const { seq: _rs, record_id: _rr, ...appendResult } = result;
  assert.throws(() => AppendRecordSchema.parse(appendIntent));
  assert.throws(() => AppendRecordSchema.parse(appendResult));
});
