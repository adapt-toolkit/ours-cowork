import { isNormalizedRoomName } from '../roomName';

export type RoomState = 'provisioning' | 'active' | 'closing' | 'closed';
export type InviteMode = 'one_time' | 'public';
export type InviteState = 'live' | 'consumed' | 'revoked' | 'replacement_required' | 'receipt_pending';
export type RelayStatus = 'queued' | 'send_failed' | 'skipped_removed';

export interface MissionDto {
  goal: string;
  briefing: string;
  briefing_version?: number;
}

export interface ParticipantDto {
  identity: string;
  display_name: string;
  role: string;
  invite_id: string;
  accepted_at: string;
  participant_id?: string;
  state?: 'active' | 'removed';
  alias?: string;
  removed_at?: string;
  removed_epoch?: number;
  replaces_seat?: string;
  bounced_at?: string;
}

export interface RoomInviteDto {
  invite_id: string;
  mode: InviteMode;
  role: string;
  min_accepts: number;
  accepted_cids: string[];
  state: InviteState;
  recovery_of?: string;
  recovery_confirmed?: boolean;
  replaces_seat?: string;
  created_at: string;
}

export interface RoleBriefingDto {
  text: string;
  version: number;
  updated_at: string;
}

export interface RoomDto {
  version: 1 | 2;
  room_id: string;
  room_name: string;
  identity_name: string;
  identity_cid: string;
  mission: MissionDto;
  role_briefings?: Record<string, RoleBriefingDto>;
  anonymous?: boolean;
  quiet_membership?: boolean;
  membership_epoch?: number;
  state: RoomState;
  status?: string;
  invites: RoomInviteDto[];
  seats: ParticipantDto[];
  created_at: string;
  activated_at?: string;
  closed_at?: string;
}

export interface InviteReceiptDto {
  room_id: string;
  invite: RoomInviteDto;
  blob: string;
  reusable: boolean;
  recovery_of?: string;
}

export interface DeleteRoomReceiptDto {
  version: 1;
  room_id: string;
  deleted: true;
  scope: 'this_host';
}

export interface CreateInviteRequestDto {
  room_id: string;
  mode: InviteMode;
  role: string;
  min_accepts: number;
}

export interface AuthorDto {
  identity: string;
  display_name: string;
  role: string;
}

export interface AuthorAliasDto {
  participant_id: string;
  alias: string;
}

export interface MembershipNoticeDto {
  action: 'remove';
  alias?: string;
  role?: string;
  epoch: number;
}

interface RecordCommonDto {
  version: 1;
  room_id: string;
  seq: number;
  record_id: string;
  at: string;
}

export interface MessageRecordDto extends RecordCommonDto {
  kind: 'message';
  message_id: string;
  author: AuthorDto;
  author_alias?: AuthorAliasDto;
  category: 'briefing' | 'role_briefing' | 'chat' | 'membership';
  briefing_role?: string;
  briefing_version?: number;
  membership?: MembershipNoticeDto;
  text: string;
  recipient_identities: string[];
  source_msg_id?: number;
  source_wire_id?: string;
}

export interface RelayIntentRecordDto extends RecordCommonDto {
  kind: 'relay_intent';
  message_id?: string;
  file_id?: string;
  recipient_identity: string;
}

export interface RelayResultRecordDto extends RecordCommonDto {
  kind: 'relay_result';
  intent_record_id: string;
  message_id?: string;
  file_id?: string;
  recipient_identity: string;
  status: RelayStatus;
  wire_id?: string;
  metadata_wire_id?: string;
}

export interface FileRecordDto extends RecordCommonDto {
  kind: 'file';
  file_id: string;
  author: AuthorDto;
  author_alias?: AuthorAliasDto;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  data_base64: string;
  recipient_identities: string[];
  source_file_id: number;
  source_wire_id?: string;
}

export interface MembershipIntentRecordDto extends RecordCommonDto {
  kind: 'membership_intent';
  action: 'remove';
  participant_id: string;
  recipient_identity: string;
  role: string;
  alias?: string;
  epoch: number;
  notify: boolean;
}

export interface MembershipResultRecordDto extends RecordCommonDto {
  kind: 'membership_result';
  intent_record_id: string;
  participant_id: string;
  status: Exclude<RelayStatus, 'skipped_removed'>;
  notified: boolean;
  key_material_retained: true;
  uncertain_after_restart?: true;
}

export interface CloseNoticeIntentRecordDto extends RecordCommonDto {
  kind: 'close_notice_intent';
  recipient_identity: string;
}

export interface CloseNoticeResultRecordDto extends RecordCommonDto {
  kind: 'close_notice_result';
  intent_record_id: string;
  recipient_identity: string;
  status: Exclude<RelayStatus, 'skipped_removed'>;
  notified: boolean;
  key_material_retained: true;
  uncertain_after_restart?: true;
}

export type OperationalRecordDto =
  | FileRecordDto
  | RelayIntentRecordDto
  | RelayResultRecordDto
  | MembershipIntentRecordDto
  | MembershipResultRecordDto
  | CloseNoticeIntentRecordDto
  | CloseNoticeResultRecordDto;

export type CommunicationRecordDto = MessageRecordDto | OperationalRecordDto;

const ROOM_STATES = new Set<unknown>(['provisioning', 'active', 'closing', 'closed']);
const INVITE_MODES = new Set<unknown>(['one_time', 'public']);
const INVITE_STATES = new Set<unknown>(['live', 'consumed', 'revoked', 'replacement_required', 'receipt_pending']);
const RELAY_STATUSES = new Set<unknown>(['queued', 'send_failed', 'skipped_removed']);
const DELIVERY_STATUSES = new Set<unknown>(['queued', 'send_failed']);
const LOWER_CROCKFORD_ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const MAX_TEXT_BYTES = 262_144;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_NAME_BYTES = 255;
const MAX_MIME_BYTES = 255;
const MAX_ROLE_BYTES = 256;
const RECORD_COMMON_KEYS = ['version', 'room_id', 'seq', 'record_id', 'at', 'kind'] as const;
const ROOM_V1_KEYS = ['version', 'room_id', 'room_name', 'identity_name', 'identity_cid', 'mission', 'state', 'invites', 'seats', 'created_at'] as const;
const ROOM_V2_KEYS = [...ROOM_V1_KEYS, 'role_briefings', 'anonymous', 'quiet_membership', 'membership_epoch'] as const;

export function isRoomDto(value: unknown): value is RoomDto {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) return false;
  const v2 = value.version === 2;
  if (!hasExactKeys(value, v2 ? ROOM_V2_KEYS : ROOM_V1_KEYS, ['status', 'activated_at', 'closed_at'])
    || !isLowerCrockfordUlid(value.room_id)
    || !isNormalizedRoomName(value.room_name)
    || !isString(value.identity_name)
    || typeof value.identity_cid !== 'string'
    || !isMission(value.mission, v2)
    || !ROOM_STATES.has(value.state)
    || !optionalString(value.status)
    || !Array.isArray(value.invites)
    || !value.invites.every(isRoomInvite)
    || !Array.isArray(value.seats)
    || !value.seats.every((seat) => isParticipant(seat, v2))
    || !isStrictRfc3339(value.created_at)
    || !optionalStrictRfc3339(value.activated_at)
    || !optionalStrictRfc3339(value.closed_at)) return false;

  if (v2 && (!isRoleBriefingMap(value.role_briefings)
    || typeof value.anonymous !== 'boolean'
    || typeof value.quiet_membership !== 'boolean'
    || !isNonNegativeSafeInteger(value.membership_epoch))) return false;

  const inviteIds = new Set(value.invites.map((invite) => invite.invite_id));
  if (inviteIds.size !== value.invites.length
    || new Set(value.seats.map((seat) => seat.identity)).size !== value.seats.length) return false;

  if (v2) {
    const seats = value.seats as ParticipantDto[];
    if (new Set(seats.map((seat) => seat.participant_id)).size !== seats.length) return false;
    const activeAliases = new Set<string>();
    for (const seat of seats) {
      if (value.anonymous ? seat.alias === undefined : seat.alias !== undefined) return false;
      if (seat.state === 'removed') {
        if (seat.removed_at === undefined || seat.removed_epoch === undefined
          || seat.removed_epoch > Number(value.membership_epoch)) return false;
      } else if (seat.removed_at !== undefined || seat.removed_epoch !== undefined || seat.bounced_at !== undefined) {
        return false;
      }
      if (seat.state === 'active' && seat.alias !== undefined) {
        if (activeAliases.has(seat.alias)) return false;
        activeAliases.add(seat.alias);
      }
    }
    const byParticipant = new Map(seats.map((seat) => [seat.participant_id, seat]));
    for (const seat of seats) {
      if (seat.replaces_seat === undefined) continue;
      const predecessor = byParticipant.get(seat.replaces_seat);
      if (!predecessor || predecessor === seat || predecessor.state !== 'removed'
        || predecessor.role !== seat.role
        || (value.anonymous && predecessor.alias !== seat.alias)) return false;
    }
  }

  const exactPacketPending = value.state === 'provisioning'
    && value.status === 'packet_pending'
    && value.identity_name === `cowork-room-${value.room_id}`
    && value.invites.length === 0
    && value.seats.length === 0
    && value.activated_at === undefined
    && value.closed_at === undefined;
  if ((value.identity_cid === '' && !exactPacketPending)
    || (value.identity_cid !== '' && value.status === 'packet_pending')) return false;

  const pendingByRecovery = new Set<string>();
  for (const invite of value.invites) {
    if (invite.recovery_of === undefined) continue;
    const source = value.invites.find((candidate) => candidate.invite_id === invite.recovery_of);
    const validSourceState = invite.state === 'receipt_pending'
      ? source?.state === 'replacement_required'
      : invite.state === 'live' || invite.state === 'consumed' || invite.state === 'replacement_required'
        ? source?.state === 'revoked'
        : invite.state === 'revoked'
          ? invite.recovery_confirmed === true
            ? source?.state === 'revoked'
            : source?.state === 'replacement_required' || source?.state === 'revoked'
          : false;
    if (!source
      || source.invite_id === invite.invite_id
      || !validSourceState
      || source.mode !== invite.mode
      || source.role !== invite.role
      || source.min_accepts !== invite.min_accepts) return false;
    if (invite.state === 'receipt_pending') {
      if (pendingByRecovery.has(invite.recovery_of)) return false;
      pendingByRecovery.add(invite.recovery_of);
    }
  }
  for (const invite of value.invites) {
    const lineage = new Set([invite.invite_id]);
    let cursor = invite;
    while (cursor.recovery_of !== undefined) {
      if (lineage.has(cursor.recovery_of)) return false;
      lineage.add(cursor.recovery_of);
      const source = value.invites.find((candidate) => candidate.invite_id === cursor.recovery_of);
      if (!source) return false;
      cursor = source;
    }
  }
  return true;
}

export function isRoomListDto(value: unknown): value is RoomDto[] {
  return Array.isArray(value) && value.every(isRoomDto);
}

export function isParticipantListDto(value: unknown): value is ParticipantDto[] {
  return Array.isArray(value)
    && value.every((participant) => isParticipant(participant))
    && new Set(value.map((participant) => participant.identity)).size === value.length;
}

export function isInviteReceiptDto(value: unknown): value is InviteReceiptDto {
  return isRecord(value) && isString(value.room_id) && isRoomInvite(value.invite)
    && isString(value.blob) && typeof value.reusable === 'boolean'
    && optionalString(value.recovery_of);
}

export function isInviteReceiptListDto(value: unknown): value is InviteReceiptDto[] {
  return Array.isArray(value) && value.every(isInviteReceiptDto);
}

export function validateCreatedInviteReceipt(value: unknown, request: CreateInviteRequestDto): InviteReceiptDto {
  if (!isInviteReceiptDto(value)
    || value.room_id !== request.room_id
    || value.invite.mode !== request.mode
    || value.invite.role !== request.role
    || value.invite.min_accepts !== request.min_accepts
    || value.invite.accepted_cids.length !== 0
    || value.invite.state !== 'live'
    || value.invite.recovery_of !== undefined
    || value.invite.recovery_confirmed !== undefined
    || value.recovery_of !== undefined
    || value.reusable !== (request.mode === 'public')) {
    throw new Error('daemon returned an invalid invite receipt for this create request');
  }
  return value;
}

export function validateRecoveryInviteReceipts(value: unknown, room: RoomDto): InviteReceiptDto[] {
  if (!isInviteReceiptListDto(value)) invalidRecoveryReceipt();
  const inviteIds = new Set<string>();
  const sources = new Set<string>();
  for (const receipt of value) {
    const source = room.invites.find((invite) => invite.invite_id === receipt.recovery_of);
    if (receipt.room_id !== room.room_id
      || receipt.recovery_of === undefined
      || receipt.invite.recovery_of !== receipt.recovery_of
      || receipt.invite.state !== 'receipt_pending'
      || receipt.invite.recovery_confirmed !== false
      || receipt.invite.accepted_cids.length !== 0
      || receipt.reusable !== (receipt.invite.mode === 'public')
      || !source
      || source.state !== 'replacement_required'
      || source.mode !== receipt.invite.mode
      || source.role !== receipt.invite.role
      || source.min_accepts !== receipt.invite.min_accepts
      || source.invite_id === receipt.invite.invite_id
      || room.invites.some((invite) => invite.invite_id === receipt.invite.invite_id)
      || inviteIds.has(receipt.invite.invite_id)
      || sources.has(receipt.recovery_of)) invalidRecoveryReceipt();
    inviteIds.add(receipt.invite.invite_id);
    sources.add(receipt.recovery_of);
  }
  return value;
}

export function validateConfirmedRecoveryInvite(value: unknown, receipt: InviteReceiptDto): RoomInviteDto {
  const replayStates = new Set<InviteState>(['live', 'consumed', 'replacement_required', 'revoked']);
  if (!isRoomInvite(value)
    || receipt.recovery_of === undefined
    || value.invite_id !== receipt.invite.invite_id
    || value.recovery_of !== receipt.recovery_of
    || value.recovery_confirmed !== true
    || !replayStates.has(value.state)
    || value.mode !== receipt.invite.mode
    || value.role !== receipt.invite.role
    || value.min_accepts !== receipt.invite.min_accepts) {
    throw new Error('daemon returned an invalid recovery confirmation for the displayed old/new pointer');
  }
  return value;
}

function invalidRecoveryReceipt(): never {
  throw new Error('daemon returned an invalid recovery receipt for this room state');
}

export function isCommunicationRecordDto(value: unknown): value is CommunicationRecordDto {
  if (!hasRecordCommon(value)) return false;
  switch (value.kind) {
    case 'message':
      return hasExactKeys(
        value,
        [...RECORD_COMMON_KEYS, 'message_id', 'author', 'category', 'text', 'recipient_identities'],
        ['author_alias', 'briefing_role', 'briefing_version', 'membership', 'source_msg_id', 'source_wire_id'],
      )
        && isLowerCrockfordUlid(value.message_id)
        && isAuthor(value.author)
        && (value.author_alias === undefined || isAuthorAlias(value.author_alias))
        && isMessageCategory(value)
        && isUtf8Bounded(value.text, MAX_TEXT_BYTES)
        && isUniqueStringArray(value.recipient_identities)
        && (value.source_msg_id === undefined || isNonNegativeSafeInteger(value.source_msg_id))
        && optionalString(value.source_wire_id);
    case 'relay_intent':
      return hasExactKeys(value, [...RECORD_COMMON_KEYS, 'recipient_identity'], ['message_id', 'file_id'])
        && hasExactlyOneRelaySubject(value)
        && isString(value.recipient_identity);
    case 'relay_result':
      return hasExactKeys(value, [...RECORD_COMMON_KEYS, 'intent_record_id', 'recipient_identity', 'status'], ['message_id', 'file_id', 'wire_id', 'metadata_wire_id'])
        && isString(value.intent_record_id)
        && hasExactlyOneRelaySubject(value)
        && isString(value.recipient_identity)
        && RELAY_STATUSES.has(value.status)
        && optionalString(value.wire_id)
        && optionalString(value.metadata_wire_id);
    case 'file': {
      const decodedSize = canonicalBase64DecodedSize(value.data_base64);
      return hasExactKeys(value, [...RECORD_COMMON_KEYS, 'file_id', 'author', 'filename', 'mime', 'size', 'sha256', 'data_base64', 'recipient_identities', 'source_file_id'], ['author_alias', 'source_wire_id'])
        && isLowerCrockfordUlid(value.file_id)
        && isAuthor(value.author)
        && (value.author_alias === undefined || isAuthorAlias(value.author_alias))
        && isFileName(value.filename)
        && isUtf8Within(value.mime, MAX_MIME_BYTES)
        && isNonNegativeSafeInteger(value.size)
        && value.size <= MAX_FILE_BYTES
        && typeof value.sha256 === 'string'
        && /^[0-9a-f]{64}$/.test(value.sha256)
        && decodedSize === value.size
        && isUniqueStringArray(value.recipient_identities)
        && isNonNegativeSafeInteger(value.source_file_id)
        && optionalString(value.source_wire_id);
    }
    case 'membership_intent':
      return hasExactKeys(
        value,
        [...RECORD_COMMON_KEYS, 'action', 'participant_id', 'recipient_identity', 'role', 'epoch', 'notify'],
        ['alias'],
      )
        && value.action === 'remove'
        && isLowerCrockfordUlid(value.participant_id)
        && isString(value.recipient_identity)
        && isUtf8Bounded(value.role, MAX_ROLE_BYTES)
        && optionalString(value.alias)
        && isPositiveSafeInteger(value.epoch)
        && typeof value.notify === 'boolean';
    case 'membership_result':
      return hasExactKeys(
        value,
        [...RECORD_COMMON_KEYS, 'intent_record_id', 'participant_id', 'status', 'notified', 'key_material_retained'],
        ['uncertain_after_restart'],
      )
        && isString(value.intent_record_id)
        && isLowerCrockfordUlid(value.participant_id)
        && DELIVERY_STATUSES.has(value.status)
        && typeof value.notified === 'boolean'
        && value.key_material_retained === true
        && (value.uncertain_after_restart === undefined || value.uncertain_after_restart === true);
    case 'close_notice_intent':
      return hasExactKeys(value, [...RECORD_COMMON_KEYS, 'recipient_identity'])
        && isString(value.recipient_identity);
    case 'close_notice_result':
      return hasExactKeys(value, [...RECORD_COMMON_KEYS, 'intent_record_id', 'recipient_identity', 'status', 'notified', 'key_material_retained'], ['uncertain_after_restart'])
        && isString(value.intent_record_id)
        && isString(value.recipient_identity)
        && DELIVERY_STATUSES.has(value.status)
        && typeof value.notified === 'boolean'
        && value.key_material_retained === true
        && (value.uncertain_after_restart === undefined || value.uncertain_after_restart === true);
    default:
      return false;
  }
}

export function isHistoryDto(value: unknown): value is CommunicationRecordDto[] {
  return Array.isArray(value) && value.every(isCommunicationRecordDto);
}

export function isDeleteRoomReceiptDto(value: unknown): value is DeleteRoomReceiptDto {
  return isRecord(value)
    && Object.keys(value).length === 4
    && value.version === 1
    && isString(value.room_id)
    && value.deleted === true
    && value.scope === 'this_host';
}

function isMission(value: unknown, v2 = false): value is MissionDto {
  return isRecord(value)
    && hasExactKeys(value, v2 ? ['goal', 'briefing', 'briefing_version'] : ['goal', 'briefing'])
    && isUtf8Bounded(value.goal, MAX_TEXT_BYTES)
    && isUtf8Bounded(value.briefing, MAX_TEXT_BYTES)
    && (!v2 || isPositiveSafeInteger(value.briefing_version));
}

function isParticipant(value: unknown, requireV2?: boolean): value is ParticipantDto {
  if (!isRecord(value)) return false;
  const v2 = requireV2 ?? Object.hasOwn(value, 'participant_id');
  if (!hasExactKeys(
    value,
    v2
      ? ['identity', 'display_name', 'role', 'invite_id', 'accepted_at', 'participant_id', 'state']
      : ['identity', 'display_name', 'role', 'invite_id', 'accepted_at'],
    v2 ? ['alias', 'removed_at', 'removed_epoch', 'replaces_seat', 'bounced_at'] : [],
  )) return false;
  return isString(value.identity)
    && isString(value.display_name)
    && isUtf8Bounded(value.role, MAX_ROLE_BYTES)
    && isString(value.invite_id)
    && isStrictRfc3339(value.accepted_at)
    && (!v2 || (isLowerCrockfordUlid(value.participant_id)
      && (value.state === 'active' || value.state === 'removed')
      && optionalString(value.alias)
      && optionalStrictRfc3339(value.removed_at)
      && (value.removed_epoch === undefined || isNonNegativeSafeInteger(value.removed_epoch))
      && (value.replaces_seat === undefined || isLowerCrockfordUlid(value.replaces_seat))
      && optionalStrictRfc3339(value.bounced_at)));
}

function isRoleBriefingMap(value: unknown): value is Record<string, RoleBriefingDto> {
  return isRecord(value) && Object.entries(value).every(([role, briefing]) =>
    isUtf8Bounded(role, MAX_ROLE_BYTES)
    && isRecord(briefing)
    && hasExactKeys(briefing, ['text', 'version', 'updated_at'])
    && isUtf8Bounded(briefing.text, MAX_TEXT_BYTES)
    && isPositiveSafeInteger(briefing.version)
    && isStrictRfc3339(briefing.updated_at));
}

function isRoomInvite(value: unknown): value is RoomInviteDto {
  if (!isRecord(value)
    || !hasExactKeys(value, ['invite_id', 'mode', 'role', 'min_accepts', 'accepted_cids', 'state', 'created_at'], ['recovery_of', 'recovery_confirmed', 'replaces_seat'])
    || !isString(value.invite_id)
    || !INVITE_MODES.has(value.mode)
    || !isUtf8Bounded(value.role, MAX_ROLE_BYTES)
    || !isPositiveSafeInteger(value.min_accepts)
    || !isUniqueStringArray(value.accepted_cids)
    || !INVITE_STATES.has(value.state)
    || !optionalString(value.recovery_of)
    || (value.recovery_confirmed !== undefined && typeof value.recovery_confirmed !== 'boolean')
    || (value.replaces_seat !== undefined && !isLowerCrockfordUlid(value.replaces_seat))
    || !isStrictRfc3339(value.created_at)) return false;
  const invite = value as unknown as RoomInviteDto;
  if (invite.mode === 'one_time' && invite.min_accepts !== 1) return false;
  if (invite.recovery_of === undefined && invite.recovery_confirmed !== undefined) return false;
  if (invite.recovery_of !== undefined && invite.recovery_confirmed === undefined) return false;
  if (invite.state === 'receipt_pending'
    && (invite.recovery_of === undefined || invite.recovery_confirmed !== false || invite.accepted_cids.length > 0)) return false;
  if (invite.recovery_of !== undefined
    && (invite.state === 'live' || invite.state === 'consumed' || invite.state === 'replacement_required')
    && invite.recovery_confirmed !== true) return false;
  return true;
}

function isAuthor(value: unknown): value is AuthorDto {
  return isRecord(value)
    && hasExactKeys(value, ['identity', 'display_name', 'role'])
    && isString(value.identity)
    && isString(value.display_name)
    && isUtf8Bounded(value.role, MAX_ROLE_BYTES);
}

function isAuthorAlias(value: unknown): value is AuthorAliasDto {
  return isRecord(value)
    && hasExactKeys(value, ['participant_id', 'alias'])
    && isLowerCrockfordUlid(value.participant_id)
    && isString(value.alias);
}

function isMembershipNotice(value: unknown): value is MembershipNoticeDto {
  return isRecord(value)
    && hasExactKeys(value, ['action', 'epoch'], ['alias', 'role'])
    && value.action === 'remove'
    && optionalString(value.alias)
    && (value.role === undefined || isUtf8Bounded(value.role, MAX_ROLE_BYTES))
    && isNonNegativeSafeInteger(value.epoch);
}

function isMessageCategory(value: Record<string, unknown>): boolean {
  switch (value.category) {
    case 'briefing':
      return value.briefing_role === undefined
        && (value.briefing_version === undefined || isPositiveSafeInteger(value.briefing_version))
        && value.membership === undefined;
    case 'role_briefing':
      return isUtf8Bounded(value.briefing_role, MAX_ROLE_BYTES)
        && isPositiveSafeInteger(value.briefing_version)
        && value.membership === undefined;
    case 'chat':
      return value.briefing_role === undefined
        && value.briefing_version === undefined
        && value.membership === undefined;
    case 'membership':
      return value.briefing_role === undefined
        && value.briefing_version === undefined
        && isMembershipNotice(value.membership);
    default:
      return false;
  }
}

function hasExactlyOneRelaySubject(value: Record<string, unknown>): boolean {
  const message = value.message_id === undefined ? false : isLowerCrockfordUlid(value.message_id);
  const file = value.file_id === undefined ? false : isLowerCrockfordUlid(value.file_id);
  return message !== file;
}

function isFileName(value: unknown): value is string {
  return isUtf8Bounded(value, MAX_FILE_NAME_BYTES)
    && value !== '.'
    && value !== '..'
    && !/[\x00/\\]/.test(value);
}

function isUtf8Within(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function canonicalBase64DecodedSize(value: unknown): number | undefined {
  if (typeof value !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function hasRecordCommon(value: unknown): value is Record<string, unknown> & RecordCommonDto {
  return isRecord(value)
    && value.version === 1
    && isLowerCrockfordUlid(value.room_id)
    && isPositiveSafeInteger(value.seq)
    && value.record_id === `${value.room_id}:${value.seq}`
    && isStrictRfc3339(value.at)
    && typeof value.kind === 'string';
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isLowerCrockfordUlid(value: unknown): value is string {
  return typeof value === 'string' && LOWER_CROCKFORD_ULID.test(value);
}

function isUtf8Bounded(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string'
    && new TextEncoder().encode(value).byteLength >= 1
    && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function isUniqueStringArray(value: unknown): value is string[] {
  return isStringArray(value) && new Set(value).size === value.length;
}

function isStrictRfc3339(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

function optionalStrictRfc3339(value: unknown): value is string | undefined {
  return value === undefined || isStrictRfc3339(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
