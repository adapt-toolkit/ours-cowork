import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const ROOM_TWO = '01jz6y7n8p9q0r1s2t3v4w5x79';
const MESSAGE_ID = '01jz6y7n8p9q0r1s2t3v4w5x71';
const SHA_A = '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd';
const SHA_B = 'df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c';

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

function makeRoom(roomId = ROOM_ID, roomName = 'Browser room') {
  return {
    version: 1,
    room_id: roomId,
    room_name: roomName,
    identity_name: `${roomName} identity`,
    identity_cid: `browser-room-cid-${roomId.at(-1)}`,
    mission: { goal: 'Browser release proof', briefing: 'Exercise the shipped console.' },
    state: 'provisioning',
    invites: [],
    seats: [],
    created_at: CREATED_AT,
  };
}

function fakeService() {
  const calls = [];
  const rooms = [{ ...makeRoom(ROOM_TWO, 'Second browser room'), state: 'active', activated_at: CREATED_AT }];
  const records = [fileRecord(rooms[0], 1, 'second-room.bin', 'QQ==', SHA_A)];
  return {
    calls,
    rooms,
    records,
    async createRoom(input) {
      calls.push(['room.create', input]);
      const room = makeRoom();
      rooms.push(room);
      records.push(
        messageRecord(room, 1, 'Before attachment'),
        fileRecord(room, 2, 'evidence.html', 'QQ==', SHA_A),
        {
          version: 1, room_id: room.room_id, seq: 3, record_id: `${room.room_id}:3`, at: CREATED_AT,
          kind: 'relay_intent', file_id: '01jz6y7n8p9q0r1s2t3v4w5x72', recipient_identity: 'browser-participant-cid',
        },
        messageRecord(room, 4, 'After attachment'),
        fileRecord(room, 5, 'evidence.html', 'QQ==', SHA_A),
        fileRecord(room, 6, 'evidence.html', 'Qg==', SHA_B),
        fileRecord(room, 7, 'Evidence.html', 'QQ==', SHA_A),
      );
      return room;
    },
    async updateRoom(roomId, input) { calls.push(['room.settings', { roomId, input }]); return rooms.find((room) => room.room_id === roomId); },
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
      const room = rooms.find((candidate) => candidate.room_id === roomId);
      assert(room);
      room.invites = [{ ...invite, accepted_cids: ['browser-participant-cid'], state: 'consumed' }];
      room.seats = [{
        identity: 'browser-participant-cid',
        display_name: 'Browser Participant',
        role: input.role,
        invite_id: invite.invite_id,
        accepted_at: CREATED_AT,
      }];
      room.state = 'active';
      room.activated_at = CREATED_AT;
      return { room_id: roomId, invite, blob: 'one-time-browser-invite', reusable: false };
    },
    async revokeInvite() { throw new Error('unexpected revoke'); },
    async recoverInvites() { throw new Error('unexpected recovery'); },
    async confirmRecoveredInvite() { throw new Error('unexpected recovery confirmation'); },
    async listRooms() { calls.push(['room.list']); return structuredClone(rooms); },
    async showRoom(roomId) {
      calls.push(['room.show', roomId]);
      const room = rooms.find((candidate) => candidate.room_id === roomId);
      assert(room);
      return structuredClone(room);
    },
    async participants(roomId) { calls.push(['room.participants', roomId]); return structuredClone(rooms.find((room) => room.room_id === roomId)?.seats ?? []); },
    async history(roomId, options) {
      calls.push(['room.history', { roomId, options }]);
      return records.filter((record) => record.room_id === roomId && record.seq > (options.after ?? 0)).slice(0, options.limit ?? 200);
    },
    async postMessage(roomId, input) {
      calls.push(['room.message', { roomId, input }]);
      const room = rooms.find((candidate) => candidate.room_id === roomId);
      assert(room);
      const seq = Math.max(0, ...records.filter((candidate) => candidate.room_id === roomId).map((candidate) => candidate.seq)) + 1;
      const record = messageRecord(room, seq, input.text, true);
      records.push(record);
      return record;
    },
    async closeRoom() { throw new Error('unexpected close'); },
    async deleteRoom() { throw new Error('unexpected delete'); },
  };
}

function messageRecord(room, seq, text, roomVoice = false) {
  return {
    version: 1, room_id: room.room_id, seq, record_id: `${room.room_id}:${seq}`, at: CREATED_AT,
    kind: 'message', message_id: MESSAGE_ID,
    author: roomVoice
      ? { identity: room.identity_cid, display_name: room.identity_name, role: 'room' }
      : { identity: 'browser-participant-cid', display_name: 'Browser Participant', role: 'reviewer' },
    category: 'chat', text, recipient_identities: [],
  };
}

function fileRecord(room, seq, filename, dataBase64, sha256) {
  return {
    version: 1, room_id: room.room_id, seq, record_id: `${room.room_id}:${seq}`, at: CREATED_AT,
    kind: 'file', file_id: `01jz6y7n8p9q0r1s2t3v4w5x7${seq}`,
    author: { identity: 'browser-participant-cid', display_name: 'Browser Participant', role: 'reviewer' },
    filename, mime: 'text/html', size: 1, sha256, data_base64: dataBase64,
    recipient_identities: [], source_file_id: seq,
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
  const requests = [];
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console.error: ${message.text()}`);
  });
  page.on('request', (request) => requests.push(request.url()));
  const origin = `http://127.0.0.1:${transport.restAddress.port}`;
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Create room' }).click();
  await page.getByLabel('Name').fill('Browser room');
  await page.getByLabel('Goal').fill('Browser release proof');
  await page.getByLabel('Briefing').fill('Exercise the shipped console.');
  await page.getByRole('button', { name: 'Create mission room', exact: true }).click();

  await assertProjection(page, async () => {
    await page.getByRole('heading', { name: 'Browser room' }).waitFor();
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

  await assertProjection(page, async () => {
    const timelineRows = await page.getByRole('list', { name: 'Room communication' }).getByRole('listitem').allTextContents();
    assert.match(timelineRows[0], /Before attachment/);
    assert.match(timelineRows[1], /evidence\.html/);
    assert.match(timelineRows[2], /After attachment/);
    assert.equal(timelineRows.some((text) => text.includes('relay_intent')), false);
  }, runtimeErrors);

  await page.getByRole('tab', { name: 'Communication' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected'), 'true');
  const evidenceVersionsToggle = page.getByRole('button', { name: 'Expand versions for evidence.html', exact: true });
  assert.equal(await evidenceVersionsToggle.count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Expand versions for Evidence.html', exact: true }).count(), 1);
  await evidenceVersionsToggle.click();
  const versions = page.getByRole('list', { name: 'Versions of evidence.html', exact: true });
  assert.deepEqual(await versions.locator('.file-version__details strong').allTextContents(), ['Version 3', 'Version 2', 'Version 1']);
  await page.getByText('Evidence.html', { exact: true }).waitFor();
  assert.equal(await page.locator('section.workspace-content').textContent().then((text) => text.includes('QQ==') || text.includes('routing-')), false);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    versions.getByRole('button', { name: 'Download evidence.html', exact: true }).first().click(),
  ]);
  assert.equal(download.suggestedFilename(), 'evidence.html');
  const downloadedPath = await download.path();
  assert(downloadedPath);
  assert.deepEqual(readFileSync(downloadedPath), Buffer.from('B'));

  await page.getByText('Second browser room', { exact: true }).click();
  await page.waitForURL(new RegExp(`#\/rooms\/${ROOM_TWO}$`));
  await page.getByText('second-room.bin', { exact: true }).waitFor();
  assert.equal(await page.getByText('evidence.html', { exact: true }).count(), 0);
  await page.getByText('Browser room', { exact: true }).click();
  await page.waitForURL(new RegExp(`#\/rooms\/${ROOM_ID}$`));
  await page.getByText('evidence.html', { exact: true }).first().waitFor();
  await page.getByRole('tab', { name: 'Communication' }).click();

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
    { name: 'Browser room', goal: 'Browser release proof', briefing: 'Exercise the shipped console.' },
  ]);
  assert.deepEqual(service.calls.find(([method]) => method === 'room.invite'), [
    'room.invite',
    { roomId: ROOM_ID, input: { mode: 'one_time', role: 'reviewer', min_accepts: 1 } },
  ]);
  assert.deepEqual(service.calls.find(([method]) => method === 'room.message'), [
    'room.message',
    { roomId: ROOM_ID, input: { text: 'Hello from the production bundle' } },
  ]);
  assert.deepEqual(await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cache: 'caches' in window ? 'unused' : 'unavailable',
  })), { local: 0, session: 0, cache: 'unused' });
  assert(requests.length > 0);
  assert(requests.every((url) => url.startsWith(origin)), `unexpected remote request: ${requests.find((url) => !url.startsWith(origin))}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Files' }).click();
  await evidenceVersionsToggle.click();
  const mobileDownload = versions.getByRole('button', { name: 'Download evidence.html', exact: true }).first();
  assert((await mobileDownload.boundingBox()).height >= 44);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(runtimeErrors, []);
});

async function assertProjection(page, action, runtimeErrors) {
  await action();
  assert.deepEqual(runtimeErrors, []);
  await page.waitForTimeout(25);
  assert.deepEqual(runtimeErrors, []);
}
