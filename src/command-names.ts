/** Fixed built-ins only; consumer registration is not implemented. */
export const SHARED_ROOM_COMMANDS = [
  'room.settings',
  'room.briefing.role.set',
  'room.briefing.role.delete',
  'room.invite',
  'room.accept',
  'room.rebind',
  'room.close',
  'room.delete',
  'room.participant.remove',
  'room.revoke',
  'room.recover',
  'room.recover.confirm',
  'room.show',
  'room.participants',
  'room.command.grants',
  'room.command.role.grants',
  'room.command.role.set',
  'room.command.grant',
  'room.command.revoke',
  'room.history',
  'room.message',
  'room.say',
  'room.role.rest.add',
  'room.role.rest.remove',
] as const;

export const RUNTIME_COMMAND_NAMES = [
  'list-members', 'remove-member', ...SHARED_ROOM_COMMANDS,
] as const;
