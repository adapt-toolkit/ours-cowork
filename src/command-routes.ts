import { z } from 'zod';
import { ContainerIdSchema, RuntimeCommandNameSchema } from './contracts.ts';
import type { AuthenticatedRouteTable } from './transports.ts';

export interface RoomServiceApi {
  provisionConsumerCredential(input: unknown): Promise<unknown>;
  consumerDefinitions(roomId: string): Promise<unknown>;
  registerConsumerCommand(roomId: string, input: unknown): Promise<unknown>;
  deleteConsumerCommand(roomId: string, input: unknown): Promise<unknown>;
  reloadConsumerCommands(roomId: string): Promise<unknown>;
  createRoom(input: unknown): Promise<unknown>;
  updateRoom(roomId: string, input: unknown): Promise<unknown>;
  setRoleBriefing(roomId: string, input: unknown): Promise<unknown>;
  deleteRoleBriefing(roomId: string, input: unknown): Promise<unknown>;
  createInvite(roomId: string, input: unknown): Promise<unknown>;
  acceptExternalInvite(roomId: string, input: unknown): Promise<unknown>;
  revokeInvite(roomId: string, inviteId: string): Promise<unknown>;
  recoverInvites(roomId: string): Promise<unknown>;
  confirmRecoveredInvite(roomId: string, recoveryOf: string, inviteId: string): Promise<unknown>;
  rebindIdentity(roomId: string): Promise<unknown>;
  removeParticipant(roomId: string, input: unknown): Promise<unknown>;
  listRooms(): Promise<unknown>;
  showRoom(roomId: string): Promise<unknown>;
  participants(roomId: string): Promise<unknown>;
  runtimeCommandGrants(roomId: string): Promise<unknown>;
  runtimeRoleCommandGrants(roomId: string): Promise<unknown>;
  setRuntimeRoleCommands(roomId: string, input: unknown): Promise<unknown>;
  grantRuntimeCommand(roomId: string, input: unknown): Promise<unknown>;
  revokeRuntimeCommand(roomId: string, input: unknown): Promise<unknown>;
  history(roomId: string, options: unknown): Promise<unknown>;
  postMessage(roomId: string, input: unknown): Promise<unknown>;
  postAsRole(roomId: string, input: unknown): Promise<unknown>;
  addRestRole(roomId: string, input: unknown): Promise<unknown>;
  removeRestRole(roomId: string, input: unknown): Promise<unknown>;
  closeRoom(roomId: string): Promise<unknown>;
  deleteRoom(roomId: string, input: unknown): Promise<unknown>;
}

const RoomIdParams = z.object({ room_id: z.string() }).strict();
const InviteRevokeParams = z.object({ room_id: z.string(), invite_id: z.string() }).strict();
const RecoverConfirmParams = z.object({
  room_id: z.string(), recovery_of: z.string(), invite_id: z.string(),
}).strict();
const HistoryParams = z.object({
  room_id: z.string(),
  after: z.number().optional(),
  limit: z.number().optional(),
  view: z.enum(['operator', 'participant']).optional(),
}).strict();
const RoleBriefingSetParams = z.object({
  room_id: z.string(), role: z.string(), text: z.string(),
}).strict();
const RoleBriefingDeleteParams = z.object({
  room_id: z.string(), role: z.string(),
}).strict();
const RestRoleParams = z.object({
  room_id: z.string(), role: z.string(),
}).strict();
const RuntimeCommandGrantParams = z.object({
  room_id: z.string(), caller_cid: ContainerIdSchema, command: RuntimeCommandNameSchema,
}).strict();
const RuntimeRoleCommandGrantParams = z.object({
  room_id: z.string(), role: z.string(), commands: z.array(RuntimeCommandNameSchema),
}).strict();
const ParticipantRemoveParams = z.object({
  room_id: z.string(), participant: z.string(), notify: z.boolean().optional(),
}).strict();
const ExternalInviteAcceptParams = z.object({
  room_id: z.string(),
  role: z.string(),
  invite: z.string(),
  expected_cid: z.string().optional(),
}).strict();

export function createServiceRoutes(service: RoomServiceApi): AuthenticatedRouteTable {
  return {
    'consumer.handler.credential.set': { auth: true, run: (params) => service.provisionConsumerCredential(params) },
    'room.command.definition.list': { auth: true, run: (params) => service.consumerDefinitions(RoomIdParams.parse(params).room_id) },
    'room.command.definition.put': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({ room_id: z.string(), expected_revision: z.unknown(), definition: z.unknown() }).strict().parse(params);
      return service.registerConsumerCommand(room_id, input);
    } },
    'room.command.definition.delete': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({ room_id: z.string(), expected_revision: z.unknown(), name: z.unknown() }).strict().parse(params);
      return service.deleteConsumerCommand(room_id, input);
    } },
    'room.command.definition.reload': { auth: true, run: (params) => service.reloadConsumerCommands(RoomIdParams.parse(params).room_id) },
    'room.create': { auth: true, run: (params) => service.createRoom(params) },
    'room.settings': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({
        room_id: z.string(),
        name: z.unknown().optional(),
        goal: z.unknown().optional(),
        briefing: z.unknown().optional(),
        status: z.unknown().optional(),
        quiet_membership: z.unknown().optional(),
      }).strict().parse(params);
      return service.updateRoom(room_id, input);
    } },
    'room.briefing.role.set': { auth: true, run: (params) => {
      const { room_id, ...input } = RoleBriefingSetParams.parse(params);
      return service.setRoleBriefing(room_id, input);
    } },
    'room.briefing.role.delete': { auth: true, run: (params) => {
      const { room_id, ...input } = RoleBriefingDeleteParams.parse(params);
      return service.deleteRoleBriefing(room_id, input);
    } },
    'room.invite': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({
        room_id: z.string(), mode: z.unknown(), role: z.unknown().optional(), min_accepts: z.unknown(),
      }).strict().parse(params);
      return service.createInvite(room_id, input);
    } },
    'room.participant.remove': { auth: true, run: (params) => {
      const { room_id, ...input } = ParticipantRemoveParams.parse(params);
      return service.removeParticipant(room_id, input);
    } },
    'room.revoke': { auth: true, run: (params) => {
      const value = InviteRevokeParams.parse(params);
      return service.revokeInvite(value.room_id, value.invite_id);
    } },
    'room.recover': { auth: true, run: (params) => service.recoverInvites(RoomIdParams.parse(params).room_id) },
    'room.recover.confirm': { auth: true, run: (params) => {
      const value = RecoverConfirmParams.parse(params);
      return service.confirmRecoveredInvite(value.room_id, value.recovery_of, value.invite_id);
    } },
    'room.rebind': { auth: true, run: (params) => service.rebindIdentity(RoomIdParams.parse(params).room_id) },
    'room.list': { auth: true, run: (params) => {
      z.object({}).strict().parse(params);
      return service.listRooms();
    } },
    'room.show': { auth: true, run: (params) => service.showRoom(RoomIdParams.parse(params).room_id) },
    'room.participants': { auth: true, run: (params) => service.participants(RoomIdParams.parse(params).room_id) },
    'room.command.grants': { auth: true, run: (params) =>
      service.runtimeCommandGrants(RoomIdParams.parse(params).room_id) },
    'room.command.role.grants': { auth: true, run: (params) =>
      service.runtimeRoleCommandGrants(RoomIdParams.parse(params).room_id) },
    'room.command.role.set': { auth: true, run: (params) => {
      const { room_id, ...input } = RuntimeRoleCommandGrantParams.parse(params);
      return service.setRuntimeRoleCommands(room_id, input);
    } },
    'room.command.grant': { auth: true, run: (params) => {
      const { room_id, ...input } = RuntimeCommandGrantParams.parse(params);
      return service.grantRuntimeCommand(room_id, input);
    } },
    'room.command.revoke': { auth: true, run: (params) => {
      const { room_id, ...input } = RuntimeCommandGrantParams.parse(params);
      return service.revokeRuntimeCommand(room_id, input);
    } },
    'room.history': { auth: true, run: (params) => {
      const { room_id, ...options } = HistoryParams.parse(params);
      return service.history(room_id, options);
    } },
    'room.message': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({ room_id: z.string(), text: z.unknown() }).strict().parse(params);
      return service.postMessage(room_id, input);
    } },
    // Role authorship: served over REST, which is the point of the feature. No
    // secret is ingested in either direction, so the Unix-only rule does not apply.
    'room.say': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({
        room_id: z.string(), role: z.unknown(), text: z.unknown(),
      }).strict().parse(params);
      return service.postAsRole(room_id, input);
    } },
    'room.role.rest.add': { auth: true, run: (params) => {
      const { room_id, ...input } = RestRoleParams.parse(params);
      return service.addRestRole(room_id, input);
    } },
    'room.role.rest.remove': { auth: true, run: (params) => {
      const { room_id, ...input } = RestRoleParams.parse(params);
      return service.removeRestRole(room_id, input);
    } },
    'room.close': { auth: true, run: (params) => service.closeRoom(RoomIdParams.parse(params).room_id) },
    'room.delete': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({ room_id: z.string(), confirm: z.unknown() }).strict().parse(params);
      return service.deleteRoom(room_id, input);
    } },
  } satisfies AuthenticatedRouteTable;
}

/** Secret-bearing mutation routes are deliberately available only to the Unix dispatcher. */
export function createPrivateServiceRoutes(service: RoomServiceApi): AuthenticatedRouteTable {
  return {
    'room.accept': { auth: true, run: (params) => {
      const { room_id, ...input } = ExternalInviteAcceptParams.parse(params);
      return service.acceptExternalInvite(room_id, input);
    } },
  } satisfies AuthenticatedRouteTable;
}

export function classifyServiceError(error: unknown): string {
  if (error instanceof z.ZodError) return 'invalid_params';
  const name = error instanceof Error ? error.name : '';
  if (name === 'CoworkStorageError' && /does not exist|missing/i.test(String(error))) return 'not_found';
  if (name === 'RoomServiceError') return 'invalid_state';
  return 'internal';
}
