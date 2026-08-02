import type {
  AuthorDto,
  CommunicationRecordDto,
  MessageRecordDto,
  OperationalRecordDto,
  RoomDto,
  RoomState,
} from '../api/types';

export const PROJECTION_PAGE_SIZE = 500;

export type ChatRow =
  | {
    type: 'briefing';
    seq: number;
    recordId: string;
    at: string;
    author: AuthorDto;
    text: string;
  }
  | {
    type: 'message';
    speaker: 'room' | 'participant';
    seq: number;
    recordId: string;
    at: string;
    author: AuthorDto;
    text: string;
  };

export interface RoomCapabilities {
  canEditSettings: boolean;
  canCreateInvite: boolean;
  canRevokeInvite: boolean;
  canRecoverInvite: boolean;
  canMessage: boolean;
  canClose: boolean;
  canDelete: boolean;
}

export function mergeRecords(
  current: readonly CommunicationRecordDto[],
  incoming: readonly CommunicationRecordDto[],
): CommunicationRecordDto[] {
  const bySequence = new Map<number, CommunicationRecordDto>();
  for (const record of current) bySequence.set(record.seq, record);
  for (const record of incoming) bySequence.set(record.seq, record);
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

export function projectChat(records: readonly CommunicationRecordDto[]): ChatRow[] {
  return mergeRecords([], records)
    .filter((record): record is MessageRecordDto => record.kind === 'message')
    .map((record): ChatRow => record.category === 'briefing'
      ? {
          type: 'briefing',
          seq: record.seq,
          recordId: record.record_id,
          at: record.at,
          author: record.author,
          text: record.text,
        }
      : {
          type: 'message',
          speaker: record.author.role === 'room' ? 'room' : 'participant',
          seq: record.seq,
          recordId: record.record_id,
          at: record.at,
          author: record.author,
          text: record.text,
        });
}

export function projectEvents(records: readonly CommunicationRecordDto[]): OperationalRecordDto[] {
  return mergeRecords([], records)
    .filter((record): record is OperationalRecordDto => record.kind !== 'message');
}

export function roomCapabilities(state: RoomState, connected = true): RoomCapabilities {
  if (!connected) return allCapabilities(false);
  switch (state) {
    case 'provisioning':
      return mutableCapabilities(false);
    case 'active':
      return mutableCapabilities(true);
    case 'closing':
      return allCapabilities(false);
    case 'closed':
      return { ...allCapabilities(false), canDelete: true };
  }
}

export function unmetInviteCount(room: Pick<RoomDto, 'invites'>): number {
  return room.invites.reduce((count, invite) => invite.state === 'revoked'
    ? count
    : count + Math.max(0, invite.min_accepts - invite.accepted_cids.length), 0);
}

export function newestRows<T>(rows: readonly T[], visibleCount = PROJECTION_PAGE_SIZE): T[] {
  const count = Math.max(0, Math.floor(visibleCount));
  return rows.slice(Math.max(0, rows.length - count));
}

export function showEarlierCount(
  visibleCount: number,
  totalCount: number,
  increment = PROJECTION_PAGE_SIZE,
): number {
  return Math.min(Math.max(0, totalCount), Math.max(0, visibleCount) + Math.max(0, increment));
}

function allCapabilities(value: boolean): RoomCapabilities {
  return {
    canEditSettings: value,
    canCreateInvite: value,
    canRevokeInvite: value,
    canRecoverInvite: value,
    canMessage: value,
    canClose: value,
    canDelete: value,
  };
}

function mutableCapabilities(canMessage: boolean): RoomCapabilities {
  return {
    canEditSettings: true,
    canCreateInvite: true,
    canRevokeInvite: true,
    canRecoverInvite: true,
    canMessage,
    canClose: true,
    canDelete: false,
  };
}
