import type {
  AuthorDto,
  CommunicationRecordDto,
  FileRecordDto,
  MessageRecordDto,
  OperationalRecordDto,
  RoomDto,
  RoomState,
} from '../api/types';

export const PROJECTION_PAGE_SIZE = 500;

export interface FileRow {
  type: 'file';
  seq: number;
  recordId: string;
  fileId: string;
  at: string;
  author: AuthorDto;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  dataBase64: string;
}

export interface FileVersion extends FileRow {
  version: number;
}

export interface FileGroup {
  groupId: string;
  filename: string;
  latest: FileVersion;
  versions: FileVersion[];
}

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
  }
  | FileRow;

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
    .filter((record): record is MessageRecordDto | FileRecordDto => record.kind === 'message' || record.kind === 'file')
    .map((record): ChatRow => record.kind === 'file'
      ? projectFile(record)
      : record.category === 'briefing'
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

export function projectEvents(records: readonly CommunicationRecordDto[]): Exclude<OperationalRecordDto, FileRecordDto>[] {
  return mergeRecords([], records)
    .filter((record): record is Exclude<OperationalRecordDto, FileRecordDto> => record.kind !== 'message' && record.kind !== 'file');
}

export function projectFiles(records: readonly CommunicationRecordDto[], roomId: string): FileRow[] {
  return mergeRecords([], records.filter((record) => record.room_id === roomId))
    .filter((record): record is FileRecordDto => record.kind === 'file')
    .map(projectFile);
}

export function groupFiles(records: readonly CommunicationRecordDto[], roomId: string): FileGroup[] {
  const byName = new Map<string, FileRow[]>();
  for (const file of projectFiles(records, roomId)) {
    const versions = byName.get(file.filename) ?? [];
    versions.push(file);
    byName.set(file.filename, versions);
  }

  return [...byName.entries()].map(([filename, files]) => {
    const versions = files
      .sort((left, right) => left.seq - right.seq)
      .map((file, index): FileVersion => ({ ...file, version: index + 1 }))
      .reverse();
    return {
      groupId: versions[0]!.fileId,
      filename,
      latest: versions[0]!,
      versions,
    };
  }).sort((left, right) => right.latest.seq - left.latest.seq);
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

function projectFile(record: FileRecordDto): FileRow {
  return {
    type: 'file',
    seq: record.seq,
    recordId: record.record_id,
    fileId: record.file_id,
    at: record.at,
    author: record.author,
    filename: record.filename,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
    dataBase64: record.data_base64,
  };
}
