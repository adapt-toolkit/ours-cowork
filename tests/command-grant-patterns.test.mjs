import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeCommandGrantInputSchema, RuntimeCommandNameSchema, RuntimeRoleCommandGrantInputSchema } from '../src/contracts.ts';

test('grant schemas accept exact names and bounded terminal namespace patterns, never regex or internal stars', () => {
  for (const command of ['room.show', 'list-members', '*', 'room.*', 'room.command.*', 'consumer.*', 'consumer.orders.*', 'future.*']) {
    assert.equal(RuntimeCommandGrantInputSchema.safeParse({ caller_cid: 'A'.repeat(64), command }).success, true, command);
    assert.equal(RuntimeRoleCommandGrantInputSchema.safeParse({ role: 'builder', commands: [command] }).success, true, command);
  }
  for (const command of ['', 'room*', '*.show', 'room.*.show', '**', 'room.**', 'room..*', 'Room.*', 'room.?', '^room.*$', 'room.[a-z]*', ' room.*', 'room.*\n', `${'a'.repeat(128)}.*`]) {
    assert.equal(RuntimeCommandGrantInputSchema.safeParse({ caller_cid: 'A'.repeat(64), command }).success, false, command);
  }
  for (const command of ['*', 'room.*', 'consumer.*']) {
    assert.equal(RuntimeCommandNameSchema.safeParse(command).success, false, 'invocations must remain concrete');
  }
  assert.equal(RuntimeRoleCommandGrantInputSchema.safeParse({ role: 'builder', commands: ['*', '*'] }).success, false);
});

test('namespace matching respects dots, descendants, exact names and case', async () => {
  const { commandGrantMatches } = await import('../src/command-names.ts');
  for (const [pattern, command, expected] of [
    ['room.*', 'room.show', true], ['room.*', 'room.command.grant', true],
    ['room.*', 'roomish.show', false], ['room.*', 'room', false], ['room.*', 'room.', false],
    ['room.command.*', 'room.command.grant', true], ['room.command.*', 'room.commands.grant', false],
    ['room.*', 'Room.show', false], ['room.*', 'consumer.orders', false],
    ['room.*', 'list-members', false], ['room.*', 'start_thread', false],
    ['room.show', 'room.show', true], ['room.show', 'room.show.more', false],
    ['*', 'start_thread', true], ['*', 'list-members', true], ['*', 'consumer.orders', true],
    ['consumer.orders.*', 'consumer.orders.get', true], ['consumer.orders.*', 'consumer.orders', false],
  ]) assert.equal(commandGrantMatches(pattern, command), expected, `${pattern} / ${command}`);
});

test('RPC and documented grant selectors accept the same wildcard syntax', async () => {
  const { default: Ajv } = await import('ajv');
  const { ROOM_RPC_METHODS } = await import('../src/openapi.ts');
  const { createServiceRoutes } = await import('../src/command-routes.ts');
  const routes = createServiceRoutes({
    grantRuntimeCommand: async (_id, input) => RuntimeCommandGrantInputSchema.parse(input),
    revokeRuntimeCommand: async (_id, input) => RuntimeCommandGrantInputSchema.parse(input),
    setRuntimeRoleCommands: async (_id, input) => RuntimeRoleCommandGrantInputSchema.parse(input),
  });
  const ajv = new Ajv();
  for (const method of ['room.command.grant', 'room.command.revoke', 'room.command.role.set']) {
    const doc = ROOM_RPC_METHODS.find(entry => entry.method === method);
    const role = method === 'room.command.role.set';
    const validate = ajv.compile(role ? doc.params.properties.commands.items : doc.params.properties.command);
    for (const [command, valid] of [['*', true], ['room.*', true], ['room.command.*', true], ['consumer.*', true], ['room.show', true], ['room*', false], ['room.*.show', false], ['room..*', false], [' room.*', false]]) {
      assert.equal(validate(command), valid, `${method} documents ${command}`);
      const params = { room_id: 'r1', ...(role ? { role: 'builder', commands: [command] } : { caller_cid: 'A'.repeat(64), command }) };
      if (valid) {
        const result = await routes[method].run(params);
        assert.deepEqual(role ? result.commands : result.command, role ? [command] : command);
      } else await assert.rejects(async () => routes[method].run(params));
    }
  }
});
