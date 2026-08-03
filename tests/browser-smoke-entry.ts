import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { createServiceRoutes, RpcDispatcher, TransportServer } from '../src/transports.ts';
import { createStaticWebHandler, loadWebAssets } from '../src/web.ts';

declare const __COWORK_BROWSER_TEST_ROOT__: string;

const ROOT = __COWORK_BROWSER_TEST_ROOT__;
const CREATED_AT = '2026-08-03T12:00:00.000Z';
const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x70';
const MESSAGE_ID = '01jz6y7n8p9q0r1s2t3v4w5x71';

function resolveChromeExecutable() {
  const configured = process.env.COWORK_CHROME_PATH;
  if (configured) {
    try {
      accessSync(configured, constants.X_OK);
      return configured;
    } catch { /* continue to PATH candidates */ }
  }
  for (const candidate of ['google-chrome', 'chromium']) {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (!directory) continue;
      const executable = join(directory, candidate);
      try { accessSync(executable, constants.X_OK); } catch { continue; }
      const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' });
      if (!probe.error && probe.status === 0) return executable;
    }
  }
  throw new Error('system Chrome is required for test:browser; set COWORK_CHROME_PATH or install google-chrome/chromium (no browser download is performed)');
}

function makeRoom() {
  return {
    version: 1,
    room_id: ROOM_ID,
    identity_name: 'Browser Room',
    identity_cid: 'browser-room-cid',
    mission: { goal: 'Browser release proof', briefing: 'Exercise the shipped console.' },
    state: 'provisioning',
    invites: [],
    seats: [],
    created_at: CREATED_AT,
  };
}

function fakeService() {
  const calls = [];
  const rooms = [];
  const records = [];
  return {
    calls,
    async createRoom(input) {
      calls.push(['room.create', input]);
      const room = makeRoom();
      rooms.push(room);
      return room;
    },
    async updateRoom(roomId, input) { calls.push(['room.settings', { roomId, input }]); return rooms[0]; },
    async createInvite(roomId, input) {
      calls.push(['room.invite', { roomId, input }]);
      const invite = {
        invite_id: 'invite-browser-1',
        mode: input.mode,
        role: input.role,
        min_accepts: input.min_accepts,
        accepted_cids: [],
        state: 'live',
        created_at: CREATED_AT,
      };
      rooms[0].invites = [{ ...invite, accepted_cids: ['browser-participant-cid'], state: 'consumed' }];
      rooms[0].seats = [{
        identity: 'browser-participant-cid',
        display_name: 'Browser Participant',
        role: input.role,
        invite_id: invite.invite_id,
        accepted_at: CREATED_AT,
      }];
      rooms[0].state = 'active';
      rooms[0].activated_at = CREATED_AT;
      return { room_id: roomId, invite, blob: 'one-time-browser-invite', reusable: false };
    },
    async revokeInvite() { throw new Error('unexpected revoke'); },
    async recoverInvites() { throw new Error('unexpected recovery'); },
    async confirmRecoveredInvite() { throw new Error('unexpected recovery confirmation'); },
    async listRooms() { calls.push(['room.list']); return structuredClone(rooms); },
    async showRoom(roomId) {
      calls.push(['room.show', roomId]);
      assert.equal(roomId, rooms[0]?.room_id);
      return structuredClone(rooms[0]);
    },
    async participants(roomId) { calls.push(['room.participants', roomId]); return structuredClone(rooms[0]?.seats ?? []); },
    async history(roomId, options) {
      calls.push(['room.history', { roomId, options }]);
      return records.filter((record) => record.seq > (options.after ?? 0)).slice(0, options.limit ?? 200);
    },
    async postMessage(roomId, input) {
      calls.push(['room.message', { roomId, input }]);
      const record = {
        version: 1,
        room_id: roomId,
        seq: records.length + 1,
        record_id: `${roomId}:${records.length + 1}`,
        at: CREATED_AT,
        kind: 'message',
        message_id: MESSAGE_ID,
        author: { identity: rooms[0].identity_cid, display_name: rooms[0].identity_name, role: 'room' },
        category: 'chat',
        text: input.text,
        recipient_identities: [],
      };
      records.push(record);
      return record;
    },
    async closeRoom() { throw new Error('unexpected close'); },
    async deleteRoom() { throw new Error('unexpected delete'); },
  };
}

test('shipped web console creates, selects, invites, and sends through the real HTTP transport', { timeout: 60_000 }, async (t) => {
  const chrome = resolveChromeExecutable();
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-browser-smoke-'));
  const service = fakeService();
  const restDispatcher = new RpcDispatcher(createServiceRoutes(service));
  const transport = new TransportServer({
    socketPath: join(stateDir, 'management.sock'),
    rest: { enabled: true, port: 0 },
    unixDispatcher: new RpcDispatcher({}),
    restDispatcher,
    staticHandler: createStaticWebHandler(loadWebAssets(join(ROOT, 'dist', 'web'))),
  });
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await transport.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });
  await transport.start();
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });

  const page = await browser.newPage();
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console.error: ${message.text()}`);
  });
  await page.goto(`http://127.0.0.1:${transport.restAddress.port}/`);
  await page.getByRole('button', { name: 'Create room' }).click();
  await page.getByLabel('Goal').fill('Browser release proof');
  await page.getByLabel('Briefing').fill('Exercise the shipped console.');
  await page.getByRole('button', { name: 'Create mission room', exact: true }).click();

  await assertProjection(page, async () => {
    await page.getByRole('heading', { name: 'Browser release proof' }).waitFor();
    await page.waitForURL(new RegExp(`#\\/rooms\\/${ROOM_ID}$`));
    await page.getByRole('tabpanel', { name: 'Invites' }).waitFor();
  }, runtimeErrors);
  assert(service.calls.some(([method]) => method === 'room.show'), 'created room was not selected through its hash route');

  await page.getByLabel('Role').fill('reviewer');
  await page.getByRole('button', { name: 'Create invite' }).click();
  await assertProjection(page, async () => {
    await page.getByText('one-time-browser-invite').waitFor();
    await page.getByText('not stored by cowork', { exact: false }).waitFor();
  }, runtimeErrors);
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByLabel('Message the room').fill('Hello from the production bundle');
  await page.getByRole('button', { name: 'Send message' }).click();
  await assertProjection(page, async () => {
    await page.locator('section.workspace-content[aria-label="communication panel"]')
      .getByRole('list', { name: 'Room communication' })
      .getByText('Hello from the production bundle', { exact: true })
      .waitFor();
  }, runtimeErrors);

  assert.equal(service.calls.filter(([method]) => method === 'room.create').length, 1);
  assert.equal(service.calls.filter(([method]) => method === 'room.invite').length, 1);
  assert.equal(service.calls.filter(([method]) => method === 'room.message').length, 1);
  assert.deepEqual(service.calls.find(([method]) => method === 'room.create'), [
    'room.create',
    { goal: 'Browser release proof', briefing: 'Exercise the shipped console.' },
  ]);
  assert.deepEqual(service.calls.find(([method]) => method === 'room.invite'), [
    'room.invite',
    { roomId: ROOM_ID, input: { mode: 'one_time', role: 'reviewer', min_accepts: 1 } },
  ]);
  assert.deepEqual(service.calls.find(([method]) => method === 'room.message'), [
    'room.message',
    { roomId: ROOM_ID, input: { text: 'Hello from the production bundle' } },
  ]);
  assert.deepEqual(runtimeErrors, []);
});

async function assertProjection(page, action, runtimeErrors) {
  await action();
  assert.deepEqual(runtimeErrors, []);
  await page.waitForTimeout(25);
  assert.deepEqual(runtimeErrors, []);
}
