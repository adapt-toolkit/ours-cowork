import { describe, expect, it } from 'vitest';

import {
  isHistoryDto,
  isParticipantListDto,
  isRoomDto,
  isRoomListDto,
  type CommunicationRecordDto,
  type MessageRecordDto,
  type RoomDto,
  type RoomInviteDto,
} from '../web/src/api/types';
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
    expect(isHistoryDto([message(1), event(2)])).toBe(true);
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
    ]) expect(isHistoryDto([invalid])).toBe(false);

    expect(isHistoryDto([{
      version: 1, room_id: ROOM_ID, seq: 2, record_id: `${ROOM_ID}:2`, at: AT,
      kind: 'close_notice_result', intent_record_id: 'intent-2', recipient_identity: 'cid-a',
      status: 'queued', notified: false, key_material_retained: true, uncertain_after_restart: true,
    }])).toBe(true);
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
    const records = [event(2), message(1), event(3)];

    expect(projectChat(records).map((row) => row.seq)).toEqual([1]);
    expect(projectEvents(records).map((row) => row.seq)).toEqual([2, 3]);
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
