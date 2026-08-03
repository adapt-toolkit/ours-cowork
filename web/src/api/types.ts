export type RoomState = 'provisioning' | 'active' | 'closing' | 'closed';
export type InviteMode = 'one_time' | 'public';
export type InviteState = 'live' | 'consumed' | 'revoked' | 'replacement_required' | 'receipt_pending';
export type RelayStatus = 'queued' | 'send_failed';

export interface MissionDto {
  goal: string;
  briefing: string;
}

export interface ParticipantDto {
  identity: string;
  display_name: string;
  role: string;
  invite_id: string;
  accepted_at: string;
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
  created_at: string;
}

export interface RoomDto {
  version: 1;
  room_id: string;
  identity_name: string;
  identity_cid: string;
  mission: MissionDto;
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
  category: 'briefing' | 'chat';
  text: string;
  recipient_identities: string[];
  source_msg_id?: number;
  source_wire_id?: string;
}

export interface RelayIntentRecordDto extends RecordCommonDto {
  kind: 'relay_intent';
  message_id: string;
  recipient_identity: string;
}

export interface RelayResultRecordDto extends RecordCommonDto {
  kind: 'relay_result';
  intent_record_id: string;
  message_id: string;
  recipient_identity: string;
  status: RelayStatus;
  wire_id?: string;
}

export interface CloseNoticeIntentRecordDto extends RecordCommonDto {
  kind: 'close_notice_intent';
  recipient_identity: string;
}

export interface CloseNoticeResultRecordDto extends RecordCommonDto {
  kind: 'close_notice_result';
  intent_record_id: string;
  recipient_identity: string;
  status: RelayStatus;
  notified: boolean;
  key_material_retained: true;
  uncertain_after_restart?: true;
}

export type OperationalRecordDto =
  | RelayIntentRecordDto
  | RelayResultRecordDto
  | CloseNoticeIntentRecordDto
  | CloseNoticeResultRecordDto;

export type CommunicationRecordDto = MessageRecordDto | OperationalRecordDto;

const ROOM_STATES = new Set<unknown>(['provisioning', 'active', 'closing', 'closed']);
const INVITE_MODES = new Set<unknown>(['one_time', 'public']);
const INVITE_STATES = new Set<unknown>(['live', 'consumed', 'revoked', 'replacement_required', 'receipt_pending']);
const RELAY_STATUSES = new Set<unknown>(['queued', 'send_failed']);

export function isRoomDto(value: unknown): value is RoomDto {
  if (!isRecord(value)
    || value.version !== 1
    || !isString(value.room_id)
    || !isString(value.identity_name)
    || typeof value.identity_cid !== 'string'
    || !isMission(value.mission)
    || !ROOM_STATES.has(value.state)
    || !optionalString(value.status)
    || !Array.isArray(value.invites)
    || !value.invites.every(isRoomInvite)
    || !Array.isArray(value.seats)
    || !value.seats.every(isParticipant)
    || !isString(value.created_at)
    || !optionalString(value.activated_at)
    || !optionalString(value.closed_at)) return false;
  return true;
}

export function isRoomListDto(value: unknown): value is RoomDto[] {
  return Array.isArray(value) && value.every(isRoomDto);
}

export function isParticipantListDto(value: unknown): value is ParticipantDto[] {
  return Array.isArray(value) && value.every(isParticipant);
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
      return isString(value.message_id)
        && isAuthor(value.author)
        && (value.category === 'briefing' || value.category === 'chat')
        && isString(value.text)
        && isStringArray(value.recipient_identities)
        && (value.source_msg_id === undefined || isNonNegativeSafeInteger(value.source_msg_id))
        && optionalString(value.source_wire_id);
    case 'relay_intent':
      return isString(value.message_id) && isString(value.recipient_identity);
    case 'relay_result':
      return isString(value.intent_record_id)
        && isString(value.message_id)
        && isString(value.recipient_identity)
        && RELAY_STATUSES.has(value.status)
        && optionalString(value.wire_id);
    case 'close_notice_intent':
      return isString(value.recipient_identity);
    case 'close_notice_result':
      return isString(value.intent_record_id)
        && isString(value.recipient_identity)
        && RELAY_STATUSES.has(value.status)
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

function isMission(value: unknown): value is MissionDto {
  return isRecord(value) && isString(value.goal) && isString(value.briefing);
}

function isParticipant(value: unknown): value is ParticipantDto {
  return isRecord(value)
    && isString(value.identity)
    && isString(value.display_name)
    && isString(value.role)
    && isString(value.invite_id)
    && isString(value.accepted_at);
}

function isRoomInvite(value: unknown): value is RoomInviteDto {
  return isRecord(value)
    && !('blob' in value)
    && isString(value.invite_id)
    && INVITE_MODES.has(value.mode)
    && isString(value.role)
    && isPositiveSafeInteger(value.min_accepts)
    && isStringArray(value.accepted_cids)
    && INVITE_STATES.has(value.state)
    && optionalString(value.recovery_of)
    && (value.recovery_confirmed === undefined || typeof value.recovery_confirmed === 'boolean')
    && isString(value.created_at);
}

function isAuthor(value: unknown): value is AuthorDto {
  return isRecord(value)
    && isString(value.identity)
    && isString(value.display_name)
    && isString(value.role);
}

function hasRecordCommon(value: unknown): value is Record<string, unknown> & RecordCommonDto {
  return isRecord(value)
    && value.version === 1
    && isString(value.room_id)
    && isPositiveSafeInteger(value.seq)
    && isString(value.record_id)
    && isString(value.at);
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
