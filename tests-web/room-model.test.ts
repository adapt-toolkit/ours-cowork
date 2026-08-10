import { describe, expect, it } from 'vitest';

import {
  isHistoryDto,
  isParticipantListDto,
  isRoomDto,
  isRoomListDto,
  type CommunicationRecordDto,
  type FileRecordDto,
  type MessageRecordDto,
  type RoomDto,
  type RoomInviteDto,
} from '../web/src/api/types';
import { RoomSchema } from '../src/contracts';
import {
  mergeRecords,
  newestRows,
  projectChat,
  projectEvents,
  roomCapabilities,
  showEarlierCount,
  unmetInviteCount,
} from '../web/src/state/roomModel';

const AT = '2026-08-03T00:00:00.000Z';
const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x70';
const MESSAGE_ID = '01jz6y7n8p9q0r1s2t3v4w5x71';

function message(seq: number, overrides: Partial<MessageRecordDto> = {}): MessageRecordDto {
  return {
    version: 1,
    room_id: ROOM_ID,
    seq,
    record_id: `${ROOM_ID}:${seq}`,
    at: AT,
    kind: 'message',
    message_id: MESSAGE_ID,
    author: { identity: 'cid-alice', display_name: 'Alice', role: 'builder' },
    category: 'chat',
    text: `message ${seq}`,
    recipient_identities: ['cid-room'],
    ...overrides,
  };
}

function event(seq: number): CommunicationRecordDto {
  return {
    version: 1,
    room_id: ROOM_ID,
    seq,
    record_id: `${ROOM_ID}:${seq}`,
    at: AT,
    kind: 'relay_intent',
    message_id: MESSAGE_ID,
    recipient_identity: 'cid-alice',
  };
}

function file(seq: number, overrides: Partial<FileRecordDto> = {}): FileRecordDto {
  return {
    version: 1,
    room_id: ROOM_ID,
    seq,
    record_id: `${ROOM_ID}:${seq}`,
    at: AT,
    kind: 'file',
    file_id: MESSAGE_ID,
    author: { identity: 'cid-alice', display_name: 'Alice', role: 'builder' },
    filename: 'evidence.bin',
    mime: 'application/octet-stream',
    size: 4,
    sha256: '0'.repeat(64),
    data_base64: 'AAEC/w==',
    recipient_identities: ['cid-bob'],
    source_file_id: 7,
    source_wire_id: 'wire-file-7',
    ...overrides,
  };
}

function invite(overrides: Partial<RoomInviteDto> = {}): RoomInviteDto {
  return {
    invite_id: 'invite-1',
    mode: 'public',
    role: 'builder',
    min_accepts: 2,
    accepted_cids: [],
    state: 'live',
    created_at: AT,
    ...overrides,
  };
}

function room(overrides: Partial<RoomDto> = {}): RoomDto {
  return {
    version: 1,
    room_id: ROOM_ID,
    room_name: 'Operations',
    identity_name: 'cowork-room-operations',
    identity_cid: 'cid-room',
    mission: { goal: 'Ship it', briefing: 'Build carefully' },
    state: 'active',
    invites: [],
    seats: [],
    created_at: AT,
    ...overrides,
  };
}

describe('room DTO guards', () => {
  it('accepts the exact RoomSchema v2 shape returned by the shipped daemon', () => {
    const daemonRoom = RoomSchema.parse({
      version: 2,
      room_id: ROOM_ID,
      identity_name: `cowork-room-${ROOM_ID}`,
      identity_cid: 'cid-room',
      mission: { goal: 'Ship it', briefing: 'Build carefully', briefing_version: 1 },
      role_briefings: { reviewer: { text: 'Review carefully', version: 2, updated_at: AT } },
      anonymous: false,
      quiet_membership: false,
      membership_epoch: 0,
      state: 'active',
      invites: [],
      seats: [{
        identity: 'cid-alice', display_name: 'Alice', role: 'builder', invite_id: 'invite-1',
        accepted_at: AT, participant_id: '01jz6y7n8p9q0r1s2t3v4w5x72', state: 'active',
      }],
      created_at: AT,
      activated_at: AT,
    });

    expect(daemonRoom.version).toBe(2);
    expect(isRoomDto(daemonRoom)).toBe(true);
    expect(isRoomListDto([daemonRoom])).toBe(true);
    expect(isParticipantListDto(daemonRoom.seats)).toBe(true);
    expect(isRoomDto({ ...daemonRoom, role_briefings: undefined })).toBe(false);
  });

  it('validates only browser-facing room, participant, and history shapes', () => {
    const validRoom = room({
      seats: [{
        identity: 'cid-alice', display_name: 'Alice', role: 'builder',
        invite_id: 'invite-1', accepted_at: AT,
      }],
      invites: [invite()],
    });

    expect(isRoomDto(validRoom)).toBe(true);
    expect(isRoomListDto([validRoom])).toBe(true);
    expect(isParticipantListDto(validRoom.seats)).toBe(true);
    expect(isParticipantListDto([validRoom.seats[0]!, { ...validRoom.seats[0]!, display_name: 'Duplicate' }])).toBe(false);
    expect(isHistoryDto([message(1), event(2), file(3)])).toBe(true);
    expect(isRoomDto({ ...validRoom, mission: { goal: 42, briefing: 'no' } })).toBe(false);
    expect(isHistoryDto([{ ...message(1), seq: '1' }])).toBe(false);
  });

  it('strictly mirrors archive record keys, identifiers, timestamps, record IDs, and union fields', () => {
    const valid = message(1);
    expect(isHistoryDto([valid])).toBe(true);
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, room_id: 'room-1', record_id: 'room-1:1' },
      { ...valid, message_id: 'message-1' },
      { ...valid, at: '2026-08-03' },
      { ...valid, record_id: `${ROOM_ID}:2` },
      { ...valid, author: { ...valid.author, extra: true } },
      { ...valid, recipient_identities: ['cid-a', 'cid-a'] },
      { ...valid, source_msg_id: -1 },
      { ...valid, source_wire_id: '' },
      { ...event(2), notified: true },
      {
        version: 1, room_id: ROOM_ID, seq: 2, record_id: `${ROOM_ID}:2`, at: AT,
        kind: 'close_notice_result', intent_record_id: 'intent-2', recipient_identity: 'cid-a',
        status: 'skipped_removed', notified: false, key_material_retained: true,
      },
    ]) expect(isHistoryDto([invalid])).toBe(false);

    expect(isHistoryDto([{
      version: 1, room_id: ROOM_ID, seq: 2, record_id: `${ROOM_ID}:2`, at: AT,
      kind: 'close_notice_result', intent_record_id: 'intent-2', recipient_identity: 'cid-a',
      status: 'queued', notified: false, key_material_retained: true, uncertain_after_restart: true,
    }])).toBe(true);

    const validFile = file(3, {
      author_alias: { participant_id: '01jz6y7n8p9q0r1s2t3v4w5x72', alias: 'builder #1' },
    });
    expect(isHistoryDto([
      validFile,
      { ...event(4), message_id: undefined, file_id: MESSAGE_ID },
      {
        version: 1, room_id: ROOM_ID, seq: 5, record_id: `${ROOM_ID}:5`, at: AT,
        kind: 'relay_result', intent_record_id: `${ROOM_ID}:4`, file_id: MESSAGE_ID,
        recipient_identity: 'cid-bob', status: 'skipped_removed', metadata_wire_id: 'wire-meta',
      },
    ])).toBe(true);
    for (const invalid of [
      { ...validFile, filename: '../secret' },
      { ...validFile, size: 3 },
      { ...validFile, data_base64: 'AAEC/w=' },
      { ...validFile, sha256: 'A'.repeat(64) },
      { ...validFile, author_alias: { participant_id: 'not-a-participant', alias: 'builder #1' } },
      { ...event(4), file_id: MESSAGE_ID },
      { ...event(4), message_id: undefined },
    ]) expect(isHistoryDto([invalid])).toBe(false);
  });

  it('rejects adversarial room descriptors that violate native shape and durable invariants', () => {
    const source = invite({ invite_id: 'invite-source', state: 'replacement_required' });
    const pending = invite({
      invite_id: 'invite-new', state: 'receipt_pending', recovery_of: source.invite_id,
      recovery_confirmed: false, accepted_cids: [],
    });
    const valid = room({
      invites: [source, pending],
      seats: [{ identity: 'cid-alice', display_name: 'Alice', role: 'builder', invite_id: source.invite_id, accepted_at: AT }],
    });
    expect(isRoomDto(valid)).toBe(true);
    expect(isRoomDto(room({ room_name: 'Café launch 🤖' }))).toBe(true);

    const invalid = [
      { ...valid, extra: true },
      { ...valid, room_name: undefined },
      { ...valid, room_name: '  Operations  ' },
      { ...valid, room_name: 'Cafe\u0301' },
      { ...valid, room_name: 'hidden\u200bname' },
      { ...valid, room_name: 'a'.repeat(65) },
      { ...valid, room_id: 'room-1' },
      { ...valid, created_at: '2026-02-29T00:00:00Z' },
      { ...valid, activated_at: 'not-a-time' },
      { ...valid, closed_at: '' },
      { ...valid, status: '' },
      { ...valid, mission: { ...valid.mission, extra: true } },
      { ...valid, mission: { ...valid.mission, goal: '' } },
      { ...valid, mission: { ...valid.mission, briefing: '🤖'.repeat(65_537) } },
      { ...valid, seats: [{ ...valid.seats[0]!, extra: true }] },
      { ...valid, seats: [{ ...valid.seats[0]!, accepted_at: '2026-08-03' }] },
      { ...valid, seats: [{ ...valid.seats[0]!, role: '' }] },
      { ...valid, seats: [valid.seats[0]!, { ...valid.seats[0]!, display_name: 'Duplicate' }] },
      { ...valid, invites: [{ ...source, blob: 'must never be durable' }, pending] },
      { ...valid, invites: [{ ...source, extra: true }, pending] },
      { ...valid, invites: [{ ...source, role: '' }, pending] },
      { ...valid, invites: [{ ...source, accepted_cids: ['cid-a', 'cid-a'] }, pending] },
      { ...valid, invites: [{ ...source, mode: 'one_time', min_accepts: 2 }, pending] },
      { ...valid, invites: [source, { ...pending, recovery_confirmed: undefined }] },
      { ...valid, invites: [source, { ...pending, accepted_cids: ['cid-a'] }] },
      { ...valid, invites: [{ ...source, state: 'live' }, pending] },
      { ...valid, invites: [source, { ...pending, role: 'different' }] },
      { ...valid, invites: [source, pending, { ...pending, invite_id: 'invite-another' }] },
      { ...valid, invites: [source, { ...pending, recovery_of: pending.invite_id }] },
      { ...valid, invites: [source, { ...source }] },
      { ...valid, invites: [
        { ...source, invite_id: 'cycle-a', state: 'revoked', recovery_of: 'cycle-b', recovery_confirmed: true },
        { ...source, invite_id: 'cycle-b', state: 'revoked', recovery_of: 'cycle-a', recovery_confirmed: true },
      ] },
      room({ identity_cid: '', status: 'packet_pending', identity_name: 'wrong' }),
      room({ identity_cid: '', status: 'packet_pending', invites: [invite()] }),
      room({ status: 'packet_pending' }),
    ];
    for (const descriptor of invalid) expect(isRoomDto(descriptor)).toBe(false);

    expect(isRoomDto(room({
      identity_cid: '', identity_name: `cowork-room-${ROOM_ID}`, status: 'packet_pending', state: 'provisioning',
    }))).toBe(true);
  });
});

describe('history model', () => {
  it('orders and deduplicates by numeric sequence, with incoming records authoritative', () => {
    const merged = mergeRecords(
      [message(10), message(2), message(1)],
      [message(2, { text: 'replacement' }), event(3)],
    );

    expect(merged.map((record) => record.seq)).toEqual([1, 2, 3, 10]);
    expect((merged[1] as MessageRecordDto).text).toBe('replacement');
  });

  it('projects participant and room chat while rendering briefings separately', () => {
    const rows = projectChat([
      message(3, {
        author: { identity: 'cid-room', display_name: 'Room', role: 'room' },
        text: 'Room update',
      }),
      message(1, { category: 'briefing', text: 'Mission briefing' }),
      message(2, { text: 'Participant update' }),
      event(4),
    ]);

    expect(rows).toEqual([
      expect.objectContaining({ type: 'briefing', seq: 1, text: 'Mission briefing' }),
      expect.objectContaining({ type: 'message', seq: 2, speaker: 'participant', text: 'Participant update' }),
      expect.objectContaining({ type: 'message', seq: 3, speaker: 'room', text: 'Room update' }),
    ]);
  });

  it('keeps operational records out of chat and in the events projection', () => {
    const records = [event(2), message(1), file(3), event(4)];

    expect(projectChat(records).map((row) => row.seq)).toEqual([1]);
    expect(projectEvents(records).map((row) => row.seq)).toEqual([2, 3, 4]);
  });

  it('mounts the newest 500 rows and expands earlier rows in 500-row increments', () => {
    const rows = Array.from({ length: 1_200 }, (_, index) => event(index + 1));

    expect(newestRows(rows).map((row) => row.seq)).toEqual(
      Array.from({ length: 500 }, (_, index) => index + 701),
    );
    expect(showEarlierCount(500, rows.length)).toBe(1_000);
    expect(showEarlierCount(1_000, rows.length)).toBe(1_200);
    expect(newestRows(rows, 1_000)[0]?.seq).toBe(201);
  });
});

describe('room lifecycle model', () => {
  it('defines exact capabilities for all four states and disables mutations when disconnected', () => {
    expect(roomCapabilities('provisioning')).toEqual({
      canEditSettings: true, canCreateInvite: true, canRevokeInvite: true,
      canRecoverInvite: true, canMessage: false, canClose: true, canDelete: false,
    });
    expect(roomCapabilities('active')).toEqual({
      canEditSettings: true, canCreateInvite: true, canRevokeInvite: true,
      canRecoverInvite: true, canMessage: true, canClose: true, canDelete: false,
    });
    expect(roomCapabilities('closing')).toEqual({
      canEditSettings: false, canCreateInvite: false, canRevokeInvite: false,
      canRecoverInvite: false, canMessage: false, canClose: false, canDelete: false,
    });
    expect(roomCapabilities('closed')).toEqual({
      canEditSettings: false, canCreateInvite: false, canRevokeInvite: false,
      canRecoverInvite: false, canMessage: false, canClose: false, canDelete: true,
    });
    expect(Object.values(roomCapabilities('active', false)).every((value) => value === false)).toBe(true);
  });

  it('sums unmet non-revoked invite requirements without going negative', () => {
    const target = room({
      invites: [
        invite({ invite_id: 'a', min_accepts: 3, accepted_cids: ['cid-a'] }),
        invite({ invite_id: 'b', min_accepts: 1, accepted_cids: ['cid-b', 'cid-c'] }),
        invite({ invite_id: 'c', min_accepts: 4, accepted_cids: [], state: 'revoked' }),
        invite({ invite_id: 'd', min_accepts: 2, accepted_cids: [], state: 'replacement_required' }),
      ],
    });

    expect(unmetInviteCount(target)).toBe(4);
  });
});
