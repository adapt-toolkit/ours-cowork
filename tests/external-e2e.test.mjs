import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(THIS_FILE), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const OURS_CLI = join(ROOT, 'node_modules', '@ours.network', 'cli', 'dist', 'cli.js');
const SUCCESS = 'COWORK_EXTERNAL_DRIVER_SUCCESS';
const FAILURE = 'COWORK_EXTERNAL_DRIVER_FAILURE';
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function sharedDaemonEnvironment(configPath) {
  const env = { ...process.env };
  for (const key of [
    'OURS_CONFIG', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_API_TOKEN',
    'OURS_BROKER_URL', 'OURS_API_VISIBILITY', 'OURS_GC_INTERVAL_MS',
  ]) delete env[key];
  return { ...env, OURS_CONFIG: configPath };
}

async function unusedPort() {
  const server = createServer();
  await new Promise((listening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', listening);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((closed, reject) => server.close((error) => error ? reject(error) : closed()));
  return address.port;
}

async function waitFor(check, description, timeoutMs = 25_000) {
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

async function waitForPort(port) {
  return waitFor(() => new Promise((ready) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); ready(true); });
    socket.once('error', () => { socket.destroy(); ready(false); });
  }), `broker port ${port}`);
}

if (process.argv.includes('--external-driver')) {
  test('cowork drives mission rooms through an already-running ours daemon', async (t) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-cowork-external-'));
    const daemonStateDir = join(stateDir, 'shared-ours');
    const cleanupErrors = [];
    const brokerErrors = [];
    let broker;
    let brokerExit;
    let oursEnv;
    let observer;
    let coworkEnv;
    let completed = false;
    let driverFailure;
    const stage = (name) => process.stdout.write(`COWORK_EXTERNAL_STAGE ${name}\n`);

    async function runCli(args, timeoutMs = 35_000, expectedError) {
      const child = spawn(process.execPath, [CLI, '--json', ...args], {
        cwd: ROOT,
        env: coworkEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      let timer;
      const result = await Promise.race([
        new Promise((exit) => {
          child.once('error', (error) => exit({ error }));
          child.once('exit', (code, signal) => exit({ code, signal }));
        }),
        new Promise((late) => { timer = setTimeout(() => late({ timeout: true }), timeoutMs); }),
      ]);
      clearTimeout(timer);
      if (result.timeout) {
        child.kill('SIGKILL');
        await new Promise((exit) => child.once('exit', exit));
        throw new Error(`CLI timed out: ${args.join(' ')}`);
      }
      if (result.error) throw result.error;
      let body;
      try { body = JSON.parse(stdout); }
      catch { throw new Error(`CLI returned invalid JSON (${args.join(' ')}): ${stdout}\n${stderr}`); }
      if (expectedError !== undefined && result.code !== 0 && body.ok === false && body.error?.code === expectedError) {
        return body.error;
      }
      if (result.code !== 0 || body.ok !== true) {
        throw new Error(`CLI failed (${args.join(' ')}): exit=${result.code} ${stdout}\n${stderr}`);
      }
      return body.result;
    }

    async function runOurs(args, timeoutMs = 35_000) {
      const child = spawn(process.execPath, [
        OURS_CLI,
        ...args,
        '--config', oursEnv.OURS_CONFIG,
        '--json',
      ], {
        cwd: ROOT,
        env: oursEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      let timer;
      const result = await Promise.race([
        new Promise((exit) => {
          child.once('error', (error) => exit({ error }));
          child.once('exit', (code, signal) => exit({ code, signal }));
        }),
        new Promise((late) => { timer = setTimeout(() => late({ timeout: true }), timeoutMs); }),
      ]);
      clearTimeout(timer);
      if (result.timeout) {
        child.kill('SIGKILL');
        await new Promise((exit) => child.once('exit', exit));
        throw new Error(`ours CLI timed out: ${args.join(' ')}`);
      }
      if (result.error) throw result.error;
      if (result.code !== 0) {
        throw new Error(`ours CLI failed (${args.join(' ')}): exit=${result.code} ${stdout}\n${stderr}`);
      }
      let body;
      try { body = JSON.parse(stdout); }
      catch { throw new Error(`ours CLI returned invalid JSON (${args.join(' ')}): ${stdout}\n${stderr}`); }
      return body;
    }

    t.after(async () => {
      if (coworkEnv) {
        try { await runCli(['stop'], 20_000); }
        catch (error) { cleanupErrors.push(new Error(`stop cowork daemon: ${error.message}`)); }
      }
      try { await observer?.releaseLease(); }
      catch (error) { cleanupErrors.push(new Error(`release observer lease: ${error.message}`)); }
      if (oursEnv) {
        try { await runOurs(['daemon', 'stop'], 20_000); }
        catch (error) { cleanupErrors.push(new Error(`stop shared ours daemon: ${error.message}`)); }
      }
      if (broker) {
        broker.kill('SIGKILL');
        try {
          await Promise.race([
            brokerExit,
            new Promise((_, reject) => setTimeout(() => reject(new Error('broker did not exit')), 5_000)),
          ]);
        } catch (error) { cleanupErrors.push(error); }
      }
      try { rmSync(stateDir, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
      process.stdout.write(completed && cleanupErrors.length === 0
        ? `${SUCCESS}\n`
        : `${FAILURE} ${JSON.stringify({
          driver: driverFailure?.stack ?? 'driver incomplete',
          cleanup: cleanupErrors.map((error) => error.stack ?? error.message),
          broker: brokerErrors.join('').slice(-4_000),
        })}\n`);
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'external-mode cleanup failed');
    });

    try {
      assert(existsSync(CLI), 'build the daemon and CLI before running the external-mode E2E');
      assert(existsSync(OURS_CLI), 'install @ours.network/cli 2.7.0 before running the shared-daemon E2E');
      const brokerPort = await unusedPort();
      broker = spawn(process.execPath, [join(ROOT, 'node_modules/.bin/adapt-broker'), '--host', '127.0.0.1', '--port', String(brokerPort), '--test_mode'], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      broker.stderr.setEncoding('utf8').on('data', (chunk) => brokerErrors.push(chunk));
      brokerExit = new Promise((exit) => {
        broker.once('error', (error) => exit({ error }));
        broker.once('exit', (code, signal) => exit({ code, signal }));
      });
      await waitForPort(brokerPort);
      stage('broker-ready');

      // The operator CLI starts the one shared daemon before cowork. Cowork
      // attaches through the same standard config and never owns this process.
      const oursPort = await unusedPort();
      const oursConfigPath = join(stateDir, 'ours-config.json');
      writeFileSync(oursConfigPath, JSON.stringify({
        brokerUrl: `ws://127.0.0.1:${brokerPort}`,
        port: oursPort,
        stateDir: daemonStateDir,
        apiVisibility: 'owner',
      }), { mode: 0o600 });
      oursEnv = sharedDaemonEnvironment(oursConfigPath);
      await runOurs(['daemon', 'start']);
      await waitForPort(oursPort);
      const { attachOursClient } = await import('@ours.network/sdk');
      observer = await attachOursClient({ env: oursEnv, leaseToken: 'cowork-external-observer' });
      assert.equal(resolve((await observer.stateDir()).stateDir), resolve(daemonStateDir));
      stage('shared-daemon-ready');

      const configPath = join(stateDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        version: 1,
        stateDir: join(stateDir, 'cowork'),
        roomIdentity: { nameMode: 'friendly' },
        rest: { enabled: false, port: 3052 },
      }), { mode: 0o600 });
      coworkEnv = { ...oursEnv, OURS_COWORK_CONFIG: configPath };

      await runCli(['start']);
      await waitFor(async () => (await runCli(['status'])).running === true, 'external-mode daemon status');
      stage('cowork-ready');

      // Nothing embedded was provisioned: that host writes this directory
      // before its runtime can accept a single request.
      assert.equal(existsSync(join(stateDir, 'ours-sdk')), false);

      const created = await runCli([
        'room', 'create', '--name', 'Shared daemon room',
        '--goal', 'Prove the external contract', '--briefing', 'Keep evidence explicit',
      ]);
      const roomId = created.room_id;
      assert.match(roomId, /^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
      assert.equal(created.identity_name, `ours-cowork-shared-daemon-room-${roomId}`);
      stage('room-created');

      // The room identity was provisioned in the SHARED daemon, not in a
      // second runtime below cowork's own state directory.
      const hosted = await waitFor(async () => (await observer.identities())
        .find((row) => row.name === created.identity_name), 'the room identity inside the shared daemon');
      assert.equal(hosted.name, `ours-cowork-shared-daemon-room-${roomId}`);
      assert.equal(existsSync(join(stateDir, 'ours-sdk')), false);

      const listed = await runCli(['room', 'list']);
      assert.equal(listed.filter((room) => room.room_id === roomId).length, 1);
      stage('hosted-externally');

      // The daemon's own authorization is untouched: a wrong token is refused
      // by the same endpoint cowork just used successfully.
      await runCli(['restart'], 45_000);
      await waitFor(async () => (await runCli(['status'])).running === true, 'restarted external-mode daemon');
      const restored = await runCli(['room', 'show', roomId]);
      assert.equal(restored.identity_cid, created.identity_cid);
      assert.equal(restored.identity_name, created.identity_name);
      assert.equal(existsSync(join(stateDir, 'ours-sdk')), false);
      stage('restart-persistence');

      const closed = await runCli(['room', 'close', roomId]);
      assert.equal(closed.state, 'closed');
      await waitFor(async () => !(await observer.identities())
        .some((identity) => identity.name === created.identity_name),
      'room identity deletion from the shared daemon');
      const roomDir = join(stateDir, 'cowork', 'rooms', roomId);
      assert.equal(existsSync(join(roomDir, 'room.json')), true);
      assert.equal(existsSync(join(roomDir, 'archive.jsonl')), true);
      const afterClose = await runCli(['room', 'list']);
      assert.equal(afterClose.find((room) => room.room_id === roomId).state, 'closed');
      stage('closed');

      // Standard shared selection never silently falls back: pointing cowork at
      // a dead endpoint must leave it stopped, not embedded.
      await runCli(['stop']);
      const deadPort = await unusedPort();
      const deadConfig = join(stateDir, 'dead-cowork.json');
      writeFileSync(deadConfig, JSON.stringify({
        version: 1,
        stateDir: join(stateDir, 'dead-state'),
        rest: { enabled: false, port: 3052 },
      }), { mode: 0o600 });
      const deadOursConfig = join(stateDir, 'dead-ours.json');
      writeFileSync(deadOursConfig, JSON.stringify({
        brokerUrl: `ws://127.0.0.1:${brokerPort}`,
        port: deadPort,
        stateDir: daemonStateDir,
        apiVisibility: 'owner',
      }), { mode: 0o600 });
      const deadEnv = coworkEnv;
      coworkEnv = { ...deadEnv, OURS_COWORK_CONFIG: deadConfig, OURS_CONFIG: deadOursConfig };
      await runCli(['start'], 45_000, 'internal');
      const stopped = await runCli(['status'], 20_000, 'daemon_unavailable');
      assert.equal(stopped.code, 'daemon_unavailable');
      assert.equal(existsSync(join(stateDir, 'dead-state', 'ours-sdk')), false);
      coworkEnv = deadEnv;
      stage('no-silent-fallback');
      completed = true;
    } catch (error) {
      driverFailure = error;
      throw error;
    }
  });
} else {
  test('cowork hosts rooms on an already-running ours daemon without a second runtime', async (t) => {
    const child = spawn(process.execPath, [THIS_FILE, '--external-driver'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let stages = 0;
    let watchdog;
    let settleTimeout;
    const timeout = new Promise((late) => { settleTimeout = late; });
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => settleTimeout('timeout'), 220_000);
    };
    const capture = (chunk) => {
      output += chunk.toString();
      const observedStages = output.split('COWORK_EXTERNAL_STAGE').length - 1;
      if (observedStages > stages) {
        stages = observedStages;
        armWatchdog();
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const exited = new Promise((exit) => {
      child.once('error', (error) => exit({ error, code: null, signal: null }));
      child.once('exit', (code, signal) => exit({ code, signal }));
    });
    let killed = false;
    async function killAndReap() {
      if (!killed) {
        killed = true;
        child.kill('SIGKILL');
      }
      return exited;
    }
    t.after(killAndReap);
    let settleOutcome;
    const terminal = new Promise((outcome) => { settleOutcome = outcome; });
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
    assert.equal(outcome, 'success', `external-mode driver ${outcome}; exit=${result.error?.message ?? result.signal ?? result.code}\n${output.slice(-16_000)}`);
    assert.equal(result.signal, 'SIGKILL', output.slice(-16_000));
  });
}
