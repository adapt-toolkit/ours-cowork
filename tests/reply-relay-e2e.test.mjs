import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, connect } from 'node:net';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(THIS_FILE), '..');
const COWORK_CLI = join(ROOT, 'dist', 'cli.js');
const OURS_CLI = process.env.COWORK_OURS_CLI_PATH
  ?? join(ROOT, 'node_modules', '@ours.network', 'cli', 'dist', 'cli.js');
const BROKER = join(ROOT, 'node_modules', '.bin', 'adapt-broker');
const MESSENGER_ROOT = process.env.COWORK_REPLY_MESSENGER_ROOT;
const MESSENGER_ENTRY = process.env.COWORK_REPLY_MESSENGER_ENTRY ?? 'dist';
const EVIDENCE_DIR = process.env.COWORK_REPLY_EVIDENCE_DIR;
const SUCCESS = 'COWORK_REPLY_RELAY_E2E_SUCCESS';
const FAILURE = 'COWORK_REPLY_RELAY_E2E_FAILURE';
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function isolatedEnvironment(configPath) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'OURS_CONFIG' || key.startsWith('OURS_')) delete env[key];
  }
  return { ...env, OURS_CONFIG: configPath };
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitFor(check, description, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForPort(port, description = `port ${port}`) {
  return waitFor(() => new Promise((resolveReady) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolveReady(true); });
    socket.once('error', () => { socket.destroy(); resolveReady(false); });
  }), description);
}

function roomBody(message) {
  if (message.direction !== 'in') return undefined;
  try {
    const parsed = JSON.parse(message.text);
    return parsed?.kind === 'room_msg' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sendWire(result) {
  const wire = result.wireId ?? result.wire_id;
  assert.equal(result.sent, true, `SDK send was not accepted: ${JSON.stringify(result)}`);
  assert.equal(result.history_stored, true, 'SDK retained the outgoing message in durable history');
  assert.equal(typeof wire, 'string');
  assert(wire.length > 0);
  return wire;
}

async function stopChild(child, description) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const result = await Promise.race([
    new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal }))),
    sleep(8_000).then(() => ({ timeout: true })),
  ]);
  if (result.timeout) {
    child.kill('SIGKILL');
    await new Promise((resolveExit) => child.once('exit', resolveExit));
    throw new Error(`${description} did not stop after SIGTERM`);
  }
  assert.equal(result.code, 0, `${description} exited via ${result.signal ?? result.code}`);
}

if (process.argv.includes('--reply-relay-driver')) {
  test('ordinary SDK clients preserve scoped replies across Cowork restart without excluded arrivals', async (t) => {
    const scratch = mkdtempSync(join(tmpdir(), 'cowork-reply-relay-'));
    const oursStateDir = join(scratch, 'shared-ours');
    const coworkStateDir = join(scratch, 'cowork');
    const cleanupErrors = [];
    const processLogs = { broker: '', messenger: '' };
    let broker;
    let brokerExit;
    let oursEnv;
    let coworkEnv;
    let completed = false;
    let failure;
    const peers = [];
    const evidence = {
      schema: 1,
      result: 'incomplete',
      isolation: {
        scratch,
        broker_host: '127.0.0.1',
        daemon_host: '127.0.0.1',
        messenger_host: '127.0.0.1',
        explicit_ours_config: true,
        ambient_ours_variables_cleared: true,
        messenger_force: false,
      },
      versions: {
        node: process.version,
        cowork: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
        sdk: JSON.parse(readFileSync(join(ROOT, 'node_modules', '@ours.network', 'sdk', 'package.json'), 'utf8')).version,
        ours_cli: JSON.parse(readFileSync(join(ROOT, 'node_modules', '@ours.network', 'cli', 'package.json'), 'utf8')).version,
        broker: JSON.parse(readFileSync(join(ROOT, 'node_modules', '@adapt-toolkit', 'broker', 'package.json'), 'utf8')).version,
      },
      command: `${process.execPath} --test tests/reply-relay-e2e.test.mjs`,
      messenger: { enabled: Boolean(MESSENGER_ROOT), checks: [] },
    };
    const stage = (name) => process.stdout.write(`COWORK_REPLY_RELAY_STAGE ${name}\n`);

    async function runJson(cli, args, env, timeoutMs = 35_000) {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      let timer;
      const result = await Promise.race([
        new Promise((resolveExit) => {
          child.once('error', (error) => resolveExit({ error }));
          child.once('exit', (code, signal) => resolveExit({ code, signal }));
        }),
        new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout({ timeout: true }), timeoutMs); }),
      ]);
      clearTimeout(timer);
      if (result.timeout) {
        child.kill('SIGKILL');
        await new Promise((resolveExit) => child.once('exit', resolveExit));
        throw new Error(`CLI timed out: ${args.join(' ')}`);
      }
      if (result.error) throw result.error;
      if (result.code !== 0) {
        throw new Error(`CLI failed (${args.join(' ')}): exit=${result.code} signal=${result.signal}\n${stdout}\n${stderr}`);
      }
      try { return JSON.parse(stdout); }
      catch { throw new Error(`CLI returned invalid JSON (${args.join(' ')}):\n${stdout}\n${stderr}`); }
    }

    async function runOurs(args, timeoutMs = 35_000) {
      return runJson(OURS_CLI, [...args, '--config', oursEnv.OURS_CONFIG, '--json'], oursEnv, timeoutMs);
    }

    async function runCowork(args, timeoutMs = 35_000) {
      const body = await runJson(COWORK_CLI, ['--json', ...args], coworkEnv, timeoutMs);
      if (body.ok !== true) throw new Error(`Cowork CLI rejected ${args.join(' ')}: ${JSON.stringify(body)}`);
      return body.result;
    }

    async function history(peer) {
      return (await peer.client.listHistory({ peer_cid: peer.roomCid, limit: 200 })).items;
    }

    async function findRoomMessage(peer, text, authorCid) {
      return waitFor(async () => {
        const rows = await history(peer);
        return rows.find((message) => {
          const body = roomBody(message);
          return body?.text === text && body.author?.identity === authorCid;
        });
      }, `${peer.name} history row for ${JSON.stringify(text)}`);
    }

    async function findOutgoing(peer, wireId) {
      return waitFor(async () => (await history(peer)).find((message) =>
        message.direction === 'out' && message.wire_id === wireId),
      `${peer.name} outgoing history ${wireId}`);
    }

    async function waitDelivered(peer, wireId) {
      return waitFor(async () => {
        const row = await findOutgoing(peer, wireId);
        return row.delivery_state === 'delivered' || row.delivery_state === 'read' ? row : undefined;
      }, `${peer.name} durable delivery settlement ${wireId}`);
    }

    async function createPeer(attachOursClient, label, suffix) {
      const name = `Reply ${label} ${suffix}`;
      const client = await attachOursClient({ env: oursEnv, leaseToken: `cowork-reply-${label}-${suffix}` });
      const created = await client.createIdentity({
        name, bio: `isolated Cowork reply participant ${label}`,
        exposeLocal: false, localAutoAccept: true,
      });
      const peer = { label, name, cid: created.info.cid, client, leased: true, roomCid: undefined };
      peers.push(peer);
      return peer;
    }

    async function release(peer) {
      if (!peer.leased) return;
      await peer.client.releaseLease();
      peer.leased = false;
    }

    async function messengerCheck(peer, checks, screenshotName) {
      assert(MESSENGER_ROOT);
      assert(['dist', 'source'].includes(MESSENGER_ENTRY),
        'COWORK_REPLY_MESSENGER_ENTRY must be dist or source');
      const messengerCli = join(MESSENGER_ROOT, MESSENGER_ENTRY === 'source' ? 'src/cli.ts' : 'dist/cli.js');
      assert(existsSync(messengerCli), `Messenger CLI is missing: ${messengerCli}`);
      await release(peer);
      const port = await unusedPort();
      const messengerEnv = isolatedEnvironment(oursEnv.OURS_CONFIG);
      Object.assign(messengerEnv, {
        OURS_MESSENGER_IDENTITY: peer.name,
        OURS_MESSENGER_FORCE: 'false',
        OURS_MESSENGER_HOST: '127.0.0.1',
        OURS_MESSENGER_PORT: String(port),
        OURS_MESSENGER_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
        OURS_MESSENGER_STATE_DIR: join(scratch, `messenger-${peer.label}`),
      });
      const messengerArgs = MESSENGER_ENTRY === 'source'
        ? ['--import', 'tsx', messengerCli, 'serve']
        : [messengerCli, 'serve'];
      const child = spawn(process.execPath, messengerArgs, {
        cwd: MESSENGER_ROOT, env: messengerEnv, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8').on('data', (chunk) => { processLogs.messenger += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { processLogs.messenger += chunk; });
      try {
        await waitForPort(port, `Messenger ${peer.label} listener`);
        const health = await waitFor(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/api/healthz`);
          return response.ok ? response.json() : undefined;
        }, `Messenger ${peer.label} readiness`);
        assert.equal(health.identityCid, peer.cid);
        const buildResponse = await fetch(`http://127.0.0.1:${port}/api/build-info`);
        assert.equal(buildResponse.ok, true);
        const build = await buildResponse.json();
        evidence.versions.messenger = build;

        const messengerRequire = createRequire(join(MESSENGER_ROOT, 'package.json'));
        const { chromium } = messengerRequire('@playwright/test');
        const launchOptions = { headless: true };
        if (process.env.COWORK_REPLY_CHROMIUM_PATH) {
          launchOptions.executablePath = process.env.COWORK_REPLY_CHROMIUM_PATH;
        }
        const browser = await chromium.launch(launchOptions);
        evidence.versions.browser = { engine: 'chromium', version: browser.version() };
        try {
          const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 900 } });
          const page = await context.newPage();
          await page.goto(`http://127.0.0.1:${port}/chats/${encodeURIComponent(peer.roomCid)}`, {
            waitUntil: 'domcontentloaded',
          });
          for (const check of checks) {
            const row = page.locator(`#chat-message-${encodeURIComponent(check.wireId)}`);
            await row.waitFor({ timeout: 15_000 });
            const quoteText = await row.locator('.quote-text').textContent();
            const quoteAuthor = await row.locator('.quote-author').textContent();
            assert.equal(quoteText, check.text, `${peer.label} Messenger quote text for ${check.label}`);
            assert.equal(quoteText === 'Original message', false, `${peer.label} resolved the native parent`);
            assert.equal(quoteAuthor, check.author, `${peer.label} Messenger quote author for ${check.label}`);
            evidence.messenger.checks.push({
              identity: peer.label, message_wire_id: check.wireId, label: check.label,
              expected: { text: check.text, author: check.author },
              observed: { text: quoteText, author: quoteAuthor },
            });
          }
          if (EVIDENCE_DIR) {
            await page.screenshot({ path: join(EVIDENCE_DIR, screenshotName), fullPage: true });
          }
          await context.close();
        } finally {
          await browser.close();
        }
      } finally {
        await stopChild(child, `Messenger ${peer.label}`);
      }
    }

    t.after(async () => {
      for (const peer of peers) {
        if (!peer.leased) continue;
        try { await peer.client.releaseLease(); }
        catch (error) { cleanupErrors.push(new Error(`release ${peer.label} lease: ${error.message}`)); }
        peer.leased = false;
      }
      if (coworkEnv) {
        try { await runCowork(['stop'], 20_000); }
        catch (error) { cleanupErrors.push(new Error(`stop Cowork daemon: ${error.message}`)); }
      }
      if (oursEnv) {
        try { await runOurs(['daemon', 'stop'], 20_000); }
        catch (error) { cleanupErrors.push(new Error(`stop ours daemon: ${error.message}`)); }
      }
      if (broker) {
        if (broker.exitCode === null && broker.signalCode === null) broker.kill('SIGTERM');
        const stopped = broker.exitCode !== null || broker.signalCode !== null
          ? true
          : await Promise.race([brokerExit.then(() => true), sleep(5_000).then(() => false)]);
        if (!stopped) {
          broker.kill('SIGKILL');
          await brokerExit;
          cleanupErrors.push(new Error('broker required SIGKILL'));
        }
      }
      const coworkLogPath = join(coworkStateDir, 'daemon.log');
      if (existsSync(coworkLogPath) && EVIDENCE_DIR) {
        writeFileSync(join(EVIDENCE_DIR, 'cowork-daemon.log'), readFileSync(coworkLogPath));
      }
      evidence.result = completed && cleanupErrors.length === 0 ? 'passed' : 'failed';
      if (failure) evidence.failure = failure.stack ?? String(failure);
      if (cleanupErrors.length > 0) evidence.cleanup_errors = cleanupErrors.map((error) => error.stack ?? error.message);
      if (EVIDENCE_DIR) {
        writeFileSync(join(EVIDENCE_DIR, 'acceptance.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
        writeFileSync(join(EVIDENCE_DIR, 'messenger.log'), processLogs.messenger, { mode: 0o600 });
      }
      rmSync(scratch, { recursive: true, force: true });
      process.stdout.write(completed && cleanupErrors.length === 0
        ? `${SUCCESS}\n`
        : `${FAILURE} ${JSON.stringify({
          failure: failure?.stack ?? 'driver incomplete',
          cleanup: cleanupErrors.map((error) => error.stack ?? error.message),
          broker: processLogs.broker.slice(-4_000),
          messenger: processLogs.messenger.slice(-4_000),
        })}\n`);
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'reply-relay cleanup failed');
    });

    try {
      assert(existsSync(COWORK_CLI), 'run npm run build before the reply-relay E2E test');
      assert(existsSync(OURS_CLI), 'install the ordinary ours CLI before the reply-relay E2E test');
      assert(existsSync(BROKER), 'install the local test broker before the reply-relay E2E test');
      if (EVIDENCE_DIR) {
        mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
        chmodSync(EVIDENCE_DIR, 0o700);
      }
      const brokerPort = await unusedPort();
      broker = spawn(process.execPath, [BROKER, '--host', '127.0.0.1', '--port', String(brokerPort), '--test_mode'], {
        cwd: ROOT, env: isolatedEnvironment('/dev/null'), stdio: ['ignore', 'ignore', 'pipe'],
      });
      brokerExit = new Promise((resolveExit) => {
        broker.once('error', (error) => resolveExit({ error }));
        broker.once('exit', (code, signal) => resolveExit({ code, signal }));
      });
      broker.stderr.setEncoding('utf8').on('data', (chunk) => { processLogs.broker += chunk; });
      await waitForPort(brokerPort, 'isolated broker');
      stage('broker-ready');

      const oursPort = await unusedPort();
      const oursConfigPath = join(scratch, 'ours.json');
      writeFileSync(oursConfigPath, JSON.stringify({
        brokerUrl: `ws://127.0.0.1:${brokerPort}`,
        port: oursPort,
        stateDir: oursStateDir,
        apiVisibility: 'owner',
      }), { mode: 0o600 });
      oursEnv = isolatedEnvironment(oursConfigPath);
      evidence.isolation.ours_config = {
        path: oursConfigPath, broker_url: `ws://127.0.0.1:${brokerPort}`,
        port: oursPort, state_dir: oursStateDir, api_visibility: 'owner',
      };
      await runOurs(['daemon', 'start']);
      await waitForPort(oursPort, 'isolated ours daemon');
      stage('ours-daemon-ready');

      const restPort = await unusedPort();
      const coworkConfigPath = join(scratch, 'cowork.json');
      writeFileSync(coworkConfigPath, JSON.stringify({
        version: 1,
        stateDir: coworkStateDir,
        rest: { enabled: true, port: restPort },
      }), { mode: 0o600 });
      coworkEnv = {
        ...isolatedEnvironment(oursConfigPath),
        OURS_COWORK_CONFIG: coworkConfigPath,
      };
      evidence.isolation.cowork_config = {
        path: coworkConfigPath, state_dir: coworkStateDir, rest_port: restPort,
      };
      await runCowork(['start']);
      await waitFor(async () => (await runCowork(['status'])).running === true, 'Cowork daemon readiness');
      stage('cowork-ready');

      const { attachOursClient } = await import('@ours.network/sdk');
      const suffix = `${process.pid}-${Date.now().toString(36)}`;
      const [a, b, c] = await Promise.all([
        createPeer(attachOursClient, 'A', suffix),
        createPeer(attachOursClient, 'B', suffix),
        createPeer(attachOursClient, 'C', suffix),
      ]);
      evidence.versions.ours_daemon = await a.client.version();
      stage('identities-ready');

      const created = await runCowork([
        'room', 'create', '--name', `Reply relay ${suffix}`,
        '--goal', 'Verify per-recipient reply threading',
        '--briefing', 'Use ordinary SDK clients and retain native parent histories',
      ]);
      const roomId = created.room_id;
      const roomCid = created.identity_cid;
      for (const peer of peers) peer.roomCid = roomCid;
      const invitation = await runCowork([
        'room', 'invite', roomId, '--mode', 'public', '--role', 'reviewer', '--min-accepts', '3',
      ]);
      await Promise.all(peers.map((peer) => peer.client.addContact({ invite: invitation.blob })));
      await waitFor(async () => {
        const room = await runCowork(['room', 'show', roomId]);
        return room.state === 'active'
          && peers.every((peer) => room.seats.some((seat) => seat.identity === peer.cid && seat.state === 'active'))
          ? room : undefined;
      }, 'three active Cowork seats');
      await Promise.all(peers.map((peer) => waitFor(async () => {
        const rows = await history(peer);
        return rows.some((message) => {
          try { return JSON.parse(message.text).kind === 'room_briefing'; }
          catch { return false; }
        }) ? true : undefined;
      }, `${peer.name} room briefing`)));
      stage('room-active');

      const parentText = `Parent P ${suffix}`;
      const answerText = `B answer ${suffix}`;
      const nestedText = `C nested reply ${suffix}`;
      const wA = sendWire(await a.client.sendMessage({ contact: roomCid, text: parentText }));
      const [parentB, parentC] = await Promise.all([
        findRoomMessage(b, parentText, a.cid),
        findRoomMessage(c, parentText, a.cid),
      ]);
      const wAB = parentB.wire_id;
      const wAC = parentC.wire_id;
      assert.deepEqual(parentB.reply_to, null);
      assert.deepEqual(parentC.reply_to, null);
      stage('parent-relayed');

      const wB = sendWire(await b.client.sendMessage({
        contact: roomCid, text: answerText, reply_to_wire_id: wAB,
      }));
      const bOutgoing = await findOutgoing(b, wB);
      assert.deepEqual(bOutgoing.reply_to, { wire_id: wAB }, 'B outgoing native reply omits sentence');
      const [answerA, answerC] = await Promise.all([
        findRoomMessage(a, answerText, b.cid),
        findRoomMessage(c, answerText, b.cid),
      ]);
      const wBA = answerA.wire_id;
      const wBC = answerC.wire_id;
      assert.deepEqual(answerA.reply_to, { wire_id: wA });
      assert.deepEqual(answerC.reply_to, { wire_id: wAC });
      await waitDelivered(b, wB);
      await sleep(1_500);
      assert.equal((await history(b)).some((message) => {
        const body = roomBody(message);
        return body?.text === answerText && body.author?.identity === b.cid;
      }), false, 'B receives no inbound echo of its own answer');
      stage('answer-relayed');

      const wC = sendWire(await c.client.sendMessage({
        contact: roomCid, text: nestedText, reply_to_wire_id: wBC,
      }));
      const cOutgoing = await findOutgoing(c, wC);
      assert.deepEqual(cOutgoing.reply_to, { wire_id: wBC });
      const [nestedA, nestedB] = await Promise.all([
        findRoomMessage(a, nestedText, c.cid),
        findRoomMessage(b, nestedText, c.cid),
      ]);
      const wCA = nestedA.wire_id;
      const wCB = nestedB.wire_id;
      assert.deepEqual(nestedA.reply_to, { wire_id: wBA }, 'A nested reference targets A copy of B answer');
      assert.deepEqual(nestedB.reply_to, { wire_id: wB }, 'B nested reference targets B original answer');
      assert.notEqual(nestedA.reply_to.wire_id, wA, 'nested reply does not flatten to thread root at A');
      assert.notEqual(nestedB.reply_to.wire_id, wAB, 'nested reply does not flatten to thread root at B');
      await waitDelivered(c, wC);

      const allWires = [wA, wAB, wAC, wB, wBA, wBC, wC, wCA, wCB];
      assert.equal(new Set(allWires).size, allWires.length, 'every source and recipient copy has a distinct wire id');
      const archive = await waitFor(async () => {
        const rows = await runCowork(['room', 'history', roomId, '--after', '0', '--limit', '1000']);
        return rows.filter((row) => row.kind === 'message'
          && [parentText, answerText, nestedText].includes(row.text)).length === 3 ? rows : undefined;
      }, 'three archived source messages');
      const archived = Object.fromEntries(archive
        .filter((row) => row.kind === 'message' && [parentText, answerText, nestedText].includes(row.text))
        .map((row) => [row.text, row]));
      assert.equal(archived[parentText].source_wire_id, wA);
      assert.equal(archived[answerText].source_wire_id, wB);
      assert.deepEqual(archived[answerText].source_reply_to, { wire_id: wAB });
      assert.equal(archived[nestedText].source_wire_id, wC);
      assert.deepEqual(archived[nestedText].source_reply_to, { wire_id: wBC });
      evidence.sdk = {
        room_id: roomId,
        room_cid: roomCid,
        expected_bodies: { parent: parentText, answer: answerText, nested: nestedText },
        observed_bodies: {
          B_parent: roomBody(parentB).text,
          C_parent: roomBody(parentC).text,
          A_answer: roomBody(answerA).text,
          C_answer: roomBody(answerC).text,
          A_nested: roomBody(nestedA).text,
          B_nested: roomBody(nestedB).text,
        },
        expected_reply_to: {
          B_answer_outgoing: { wire_id: wAB },
          A_answer_received: { wire_id: wA },
          C_answer_received: { wire_id: wAC },
          C_nested_outgoing: { wire_id: wBC },
          A_nested_received: { wire_id: wBA },
          B_nested_received: { wire_id: wB },
        },
        observed_reply_to: {
          B_answer_outgoing: bOutgoing.reply_to,
          A_answer_received: answerA.reply_to,
          C_answer_received: answerC.reply_to,
          C_nested_outgoing: cOutgoing.reply_to,
          A_nested_received: nestedA.reply_to,
          B_nested_received: nestedB.reply_to,
        },
        references: {
          parent: { A_source: wA, B_copy: wAB, C_copy: wAC },
          answer: {
            B_source: wB, A_copy: wBA, C_copy: wBC,
            B_outgoing_reply_to: bOutgoing.reply_to,
            A_received_reply_to: answerA.reply_to,
            C_received_reply_to: answerC.reply_to,
          },
          nested: {
            C_source: wC, A_copy: wCA, B_copy: wCB,
            C_outgoing_reply_to: cOutgoing.reply_to,
            A_received_reply_to: nestedA.reply_to,
            B_received_reply_to: nestedB.reply_to,
          },
        },
        no_B_answer_echo: true,
        archive_source_replies: {
          answer: archived[answerText].source_reply_to,
          nested: archived[nestedText].source_reply_to,
        },
      };
      stage('sdk-chain-verified');

      // A broadcast fallback, duplicate creation, or forgotten durable recipient wire
      // must fail through real SDK histories, unread metadata, and arrival events.
      const arrivals = [];
      const abortNotifications = new AbortController();
      let notificationFailure;
      const notificationTask = (async () => {
        for await (const event of c.client.watchNotifications(c.name, {
          since: 0, kinds: ['inbound'], signal: abortNotifications.signal,
        })) arrivals.push(event);
      })().catch((error) => { notificationFailure = error; });
      t.after(async () => { abortNotifications.abort(); await notificationTask; });
      async function observedArrival(wire) {
        await waitFor(() => {
          if (notificationFailure) throw notificationFailure;
          return arrivals.some((event) => event.wire_id === wire);
        }, `C notification for ${wire}`);
        assert.equal(notificationFailure, undefined);
      }
      await observedArrival(wBC);
      const beforeHistory = await history(c);
      const beforeArrivals = arrivals.length;
      const unreadC = async () => {
        const row = (await c.client.unread()).identities.find((item) => item.name === c.name);
        assert(row, 'C retains unread ordinary room messages');
        return row;
      };
      const beforeUnread = await unreadC();
      const beforeWires = new Set(beforeHistory.map((row) => row.wire_id));
      const barriers = [];
      async function assertExcluded() {
        const rows = await history(c);
        assert.deepEqual(rows.filter((row) => !beforeWires.has(row.wire_id)).map((row) => row.wire_id).sort(),
          barriers.map((row) => row.wire_id).sort(), 'only ordinary barriers enter C history');
        const unread = await unreadC();
        assert.equal(unread.count, beforeUnread.count + barriers.length, 'only ordinary barriers increase unread');
        assert.equal(unread.files, beforeUnread.files);
        assert.deepEqual(unread.unread_files, beforeUnread.unread_files);
        assert.deepEqual(unread.recent, [...beforeUnread.recent, ...barriers.map((row) => ({
          from: beforeUnread.recent.at(-1).from, msg_id: row.msg_id, date: row.date,
        }))].slice(-10), 'no scoped message metadata enters unread recent');
        assert.equal(notificationFailure, undefined);
        const events = arrivals.slice(beforeArrivals);
        assert.deepEqual(events.map((event) => event.wire_id).sort(), barriers.map((row) => row.wire_id).sort(),
          'C receives exactly the ordinary barrier notifications, with no scoped wire/file metadata');
        for (const event of events) {
          assert.equal(event.event, 'message_received');
          assert.equal(event.sender_id, roomCid);
          assert.deepEqual(Object.keys(event).sort(),
            ['event', 'sender_id', 'sender_name', 'from', 'msg_id', 'wire_id', 'date'].sort(),
            'arrival notifications remain content-free');
        }
      }
      async function ordinaryBarrier(label) {
        const text = `ordinary barrier ${label} ${suffix}`;
        sendWire(await a.client.sendMessage({ contact: roomCid, text }));
        const row = await findRoomMessage(c, text, a.cid);
        assert.equal(roomBody(row).thread, undefined, 'no reply target means no implicit thread');
        assert.equal(row.reply_to, null);
        barriers.push(row);
        await observedArrival(row.wire_id);
        await assertExcluded();
      }
      async function startThread(arguments_) {
        const requestWire = sendWire(await a.client.sendCommand({
          contact: roomCid, command: 'start_thread', arguments: arguments_,
        }));
        const row = await waitFor(async () => (await history(a)).find((item) =>
          item.direction === 'in' && item.message_kind === 'command_result'
          && item.reply_to?.wire_id === requestWire), `start_thread result for ${requestWire}`);
        const outcome = JSON.parse(row.text);
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(outcome.result.ok, true, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'accepted');
        return { request_wire: requestWire, result_wire: row.wire_id, thread_id: outcome.result.thread_id };
      }
      await runCowork(['room', 'command-grant', roomId, a.cid, 'start_thread']);
      const current = await runCowork(['room', 'show', roomId]);
      const selected = current.seats.filter((seat) => [a.cid, b.cid].includes(seat.identity))
        .map((seat) => seat.participant_id);
      assert.equal(selected.length, 2);
      const command = await waitFor(async () => (await a.client.listContactCommands({ contact: roomCid }))
        .find((item) => item.name === 'start_thread'), 'generic start_thread catalog');
      assert(command.input_schema);
      const args = { topic: `Scoped ${suffix}`, participant_ids: selected, idempotency_key: `e2e-${suffix}` };
      const firstCommand = await startThread(args);
      const [rootA, rootB] = await Promise.all([
        findRoomMessage(a, `Thread: ${args.topic}`, a.cid), findRoomMessage(b, `Thread: ${args.topic}`, a.cid),
      ]);
      const tid = roomBody(rootA).thread.thread_id;
      assert.equal(firstCommand.thread_id, tid);
      assert.equal(roomBody(rootB).thread.thread_id, tid);
      assert.notEqual(rootA.wire_id, rootB.wire_id);
      const text1 = `Scoped B ${suffix}`;
      const bSource = sendWire(await b.client.sendMessage({ contact: roomCid, text: text1, reply_to_wire_id: rootB.wire_id }));
      const bAtA = await findRoomMessage(a, text1, b.cid);
      assert.deepEqual(bAtA.reply_to, { wire_id: rootA.wire_id });
      assert.equal(roomBody(bAtA).thread.thread_id, tid);
      const text2 = `Scoped A nested ${suffix}`;
      sendWire(await a.client.sendMessage({ contact: roomCid, text: text2, reply_to_wire_id: bAtA.wire_id }));
      const aAtB = await findRoomMessage(b, text2, a.cid);
      assert.deepEqual(aAtB.reply_to, { wire_id: bSource });
      assert.equal(roomBody(aAtB).thread.thread_id, tid);
      const fileName = `scoped-${suffix}.txt`;
      const fileWire = sendWire(await b.client.sendFile({ contact: roomCid, filename: fileName,
        mime: 'text/plain', data_base64: Buffer.from('private thread attachment').toString('base64'),
        reply_to_wire_id: rootB.wire_id }));
      await findRoomMessage(b, 'thread_files_unsupported', roomCid);
      const retryArgs = { ...args, participant_ids: [...selected].reverse() };
      const retryCommand = await startThread(retryArgs);
      assert.equal(retryCommand.thread_id, tid);
      assert.notEqual(retryCommand.request_wire, firstCommand.request_wire);
      await assertExcluded();
      await ordinaryBarrier('before restart');
      const adminHistory = () => runCowork(['room', 'history', roomId, '--after', '0', '--limit', '1000']);
      const adminBefore = await adminHistory();
      assert.equal(adminBefore.filter((row) => row.kind === 'message' && row.thread_root?.thread_id === tid).length, 1);
      assert(adminBefore.some((row) => row.kind === 'message' && row.text === text2));
      assert(adminBefore.some((row) => row.kind === 'intake_rejection' && row.source_wire_id === fileWire
        && row.error === 'thread_files_unsupported'));
      stage('scoped-sdk-verified');

      await runCowork(['stop']);
      await assert.rejects(runCowork(['status']), /daemon_unavailable.*ours-cowork is stopped/);
      await runCowork(['start']);
      await waitFor(async () => (await runCowork(['status'])).running === true, 'restarted isolated Cowork readiness');
      await waitFor(async () => {
        const room = await runCowork(['room', 'show', roomId]);
        return room.state === 'active' && room.identity_cid === roomCid
          && peers.every((peer) => room.seats.some((seat) => seat.identity === peer.cid && seat.state === 'active'));
      }, 'restored room and seats');
      const restartCommand = await startThread(retryArgs);
      assert.equal(restartCommand.thread_id, tid);
      assert.notEqual(restartCommand.request_wire, retryCommand.request_wire);
      const restartText = `Scoped B after restart ${suffix}`;
      sendWire(await b.client.sendMessage({ contact: roomCid, text: restartText, reply_to_wire_id: rootB.wire_id }));
      const restartedAtA = await findRoomMessage(a, restartText, b.cid);
      assert.deepEqual(restartedAtA.reply_to, { wire_id: rootA.wire_id });
      assert.equal(roomBody(restartedAtA).thread.thread_id, tid);
      await assertExcluded();
      await ordinaryBarrier('after restart');
      const adminAfter = await adminHistory();
      assert.equal(adminAfter.filter((row) => row.kind === 'message' && row.thread_root?.thread_id === tid).length, 1);
      assert(adminAfter.some((row) => row.kind === 'message' && row.text === restartText));
      for (const peer of [a, b]) {
        assert.equal((await history(peer)).filter((row) => roomBody(row)?.text === `Thread: ${args.topic}`).length, 1,
          `${peer.label} receives one root across retries and restart`);
      }
      const secrets = [tid, args.topic, text1, text2, restartText, fileName, fileWire];
      assert.equal((await history(c)).some((row) => secrets.some((secret) => JSON.stringify(row).includes(secret))), false);
      evidence.scoped = { thread_id: tid, root_wires: { A: rootA.wire_id, B: rootB.wire_id },
        commands: [firstCommand, retryCommand, restartCommand],
        nested_reply_to: aAtB.reply_to, restarted_reply_to: restartedAtA.reply_to,
        excluded_unread_before: beforeUnread, excluded_unread_after: await unreadC(),
        excluded_arrivals: arrivals.slice(beforeArrivals), file_refusal_wire: fileWire,
        root_count: 1, restarted_test_owned_cowork: true };
      abortNotifications.abort();
      await notificationTask;
      assert.equal(notificationFailure, undefined);
      stage('scoped-restart-verified');

      if (MESSENGER_ROOT) {
        evidence.command = [
          `COWORK_REPLY_MESSENGER_ROOT=${MESSENGER_ROOT}`,
          `COWORK_REPLY_MESSENGER_ENTRY=${MESSENGER_ENTRY}`,
          ...(EVIDENCE_DIR ? [`COWORK_REPLY_EVIDENCE_DIR=${EVIDENCE_DIR}`] : []),
          ...(process.env.COWORK_REPLY_CHROMIUM_PATH
            ? [`COWORK_REPLY_CHROMIUM_PATH=${process.env.COWORK_REPLY_CHROMIUM_PATH}`] : []),
          `${process.execPath} --test tests/reply-relay-e2e.test.mjs`,
        ].join(' ');
        evidence.messenger.root = MESSENGER_ROOT;
        evidence.messenger.force = false;
        evidence.messenger.entry = MESSENGER_ENTRY;
        evidence.messenger.launch_command = MESSENGER_ENTRY === 'source'
          ? `${process.execPath} --import tsx ${join(MESSENGER_ROOT, 'src', 'cli.ts')} serve`
          : `${process.execPath} ${join(MESSENGER_ROOT, 'dist', 'cli.js')} serve`;
        evidence.messenger.web_assets = join(MESSENGER_ROOT, 'dist', 'web');
        evidence.messenger.checkout = {
          head: execFileSync('git', ['-C', MESSENGER_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          dirty: execFileSync('git', ['-C', MESSENGER_ROOT, 'status', '--porcelain=v1'], { encoding: 'utf8' }).trim() !== '',
        };
        evidence.versions.messenger_package = JSON.parse(
          readFileSync(join(MESSENGER_ROOT, 'package.json'), 'utf8'),
        ).version;
        evidence.versions.messenger_sdk = JSON.parse(
          readFileSync(join(MESSENGER_ROOT, 'node_modules', '@ours.network', 'sdk', 'package.json'), 'utf8'),
        ).version;
        await messengerCheck(a, [
          { wireId: wBA, text: parentText, author: 'You', label: 'first answer' },
          { wireId: wCA, text: answerText, author: b.name, label: 'nested reply' },
        ], 'messenger-A.png');
        stage('messenger-A-verified');
        await messengerCheck(c, [
          { wireId: wBC, text: parentText, author: a.name, label: 'first answer' },
        ], 'messenger-C.png');
        stage('messenger-C-verified');
        await messengerCheck(b, [
          { wireId: wCB, text: answerText, author: 'You', label: 'nested reply' },
        ], 'messenger-B.png');
        stage('messenger-B-verified');
      }
      completed = true;
    } catch (error) {
      failure = error;
      throw error;
    }
  });
} else {
  test('real generic SDK clients preserve ordinary and scoped reply threading across restart', async (t) => {
    const driverEnv = { ...process.env };
    delete driverEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [THIS_FILE, '--reply-relay-driver'], {
      cwd: ROOT, env: driverEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let stages = 0;
    let watchdog;
    let settleTimeout;
    const timeout = new Promise((resolveTimeout) => { settleTimeout = resolveTimeout; });
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => settleTimeout('timeout'), 150_000);
    };
    const capture = (chunk) => {
      output += chunk.toString();
      const observedStages = output.split('COWORK_REPLY_RELAY_STAGE').length - 1;
      if (observedStages > stages) {
        stages = observedStages;
        armWatchdog();
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const exited = new Promise((resolveExit) => {
      child.once('error', (error) => resolveExit({ error, code: null, signal: null }));
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    let killed = false;
    async function killAndReap() {
      if (!killed && child.exitCode === null && child.signalCode === null) {
        killed = true;
        child.kill('SIGKILL');
      }
      return exited;
    }
    t.after(killAndReap);
    let settleOutcome;
    const terminal = new Promise((resolveOutcome) => { settleOutcome = resolveOutcome; });
    const inspect = () => {
      if (output.includes(SUCCESS)) settleOutcome('success');
      else if (output.includes(FAILURE)) settleOutcome('failure');
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    armWatchdog();
    const outcome = await Promise.race([terminal, exited.then(() => 'exit'), timeout]);
    clearTimeout(watchdog);
    const result = await killAndReap();
    assert.equal(outcome, 'success',
      `reply-relay driver ${outcome}; exit=${result.error?.message ?? result.signal ?? result.code}\n${output.slice(-20_000)}`);
  });
}
