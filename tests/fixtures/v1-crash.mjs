// Actual built cowork/V1 lifecycle. Every process and identity belongs to this fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachOursClient } from '@ours.network/sdk';
import { command, sleep, startProcess, stopProcess, unusedPort, waitFor, waitForPort } from './v1-runtime.mjs';

const mode = process.argv[2] ?? 'worker';
assert(['worker', 'parent-loss', 'delayed'].includes(mode), 'Unknown finite crash fixture mode');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'dist/cli.js');
const OURS_CLI = join(ROOT, 'node_modules/@ours.network/daemon/dist/cli.js');
const state = mkdtempSync(join(tmpdir(), `cowork-v1-${mode}-`));
const coworkState = join(state, 'cowork');
const daemonState = join(state, 'ours'); mkdirSync(daemonState, {mode: 0o700});
const cleanEnv = {...process.env};
for (const key of Object.keys(cleanEnv)) if (key.startsWith('OURS_')) delete cleanEnv[key];
const brokerPort = await unusedPort();
const port = await unusedPort();
const endpoint = `http://127.0.0.1:${port}`;
const instanceId = randomUUID();
const credentialPath = join(daemonState, 'daemon-token');
const configPath = join(state, 'ours.json');
writeFileSync(configPath, JSON.stringify({brokerUrl: `ws://127.0.0.1:${brokerPort}`, port, stateDir: daemonState, apiVisibility: 'owner'}), {mode: 0o600});
const oursEnv = {...cleanEnv, HOME: state, OURS_CONFIG: configPath, OURS_DAEMON_ID: instanceId};
const coworkConfig = join(state, 'cowork.json');
writeFileSync(coworkConfig, JSON.stringify({version: 1, stateDir: coworkState, rest: {enabled: false, port: 3052}}), {mode: 0o600});
const coworkEnv = {...cleanEnv, HOME: state, OURS_COWORK_CONFIG: coworkConfig,
  OURS_DAEMON_URL: endpoint, OURS_DAEMON_ID: instanceId, OURS_DAEMON_CREDENTIAL_PATH: credentialPath};
const bindings = () => JSON.parse(readFileSync(join(daemonState, 'bindings.json'), 'utf8'));
const owner = name => bindings().externalLeases.find(row => row.identity === name)?.token;
const defaults = name => ({name, bio: 'Local lifecycle fixture', exposeLocal: false, localAutoAccept: true});
let broker, daemon, controller, observer, sibling, coworkStarted = false, room, rootCid, siblingCid;
const pass = label => console.log(`PASS ${mode}: ${label}`);
async function cli(args) {
  const body = JSON.parse(await command([CLI, '--json', ...args], coworkEnv, ROOT, 180000));
  assert.equal(body.ok, true); return body.result;
}
async function startDaemon() {
  daemon = startProcess([OURS_CLI, 'daemon', 'serve'], oursEnv, ROOT);
  await waitFor(async () => {
    const response = await fetch(endpoint + '/selection', {signal: AbortSignal.timeout(1000)});
    return response.ok && (await response.json()).instanceId === instanceId && existsSync(credentialPath);
  }, 'actual V1 daemon selection', 180000);
  if (observer) await waitFor(async () => (await observer.version({startup: true})).startup.phase === 'ready', 'actual V1 restored identities', 180000);
}
async function startController() {
  const child = spawn(process.execPath, [join(ROOT, 'tests/fixtures/v1-supervisor.mjs')], {
    cwd: ROOT, env: coworkEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const current = {child, events: [], outcome: undefined};
  current.exited = new Promise(resolveExit => {
    child.once('error', error => { current.outcome = {error}; resolveExit(current.outcome); });
    child.once('exit', (code, signal) => { current.outcome = {code, signal}; resolveExit(current.outcome); });
  });
  child.stdout.resume(); child.stderr.resume();
  child.on('message', message => current.events.push(message));
  controller = current;
  await waitFor(() => {
    assert(!current.outcome, 'Existing supervisor fixture exited before ready');
    return current.events.some(event => event.stage === 'ready');
  }, 'actual existing supervisor/worker ready', 180000);
  coworkStarted = true;
  return current;
}
async function killWorker(current) {
  current.child.send({command: 'kill-exact-worker'});
  await waitFor(() => current.events.some(event => event.workerExit?.signal === 'SIGKILL'), 'exact forked worker SIGKILL observed', 15000);
  coworkStarted = false;
}
async function completedController(current) {
  await waitFor(() => current.outcome, 'existing supervisor finishes terminal delivery', 45000);
  assert.equal(current.outcome.code, 0, 'Controller must report successful exact-worker lifecycle');
  assert.equal(current.events.find(event => event.supervisorResult)?.supervisorResult.signal, 'SIGKILL');
}
async function checkRecovery(previousOwner, start = true) {
  if (start) { await cli(['start']); coworkStarted = true; }
  await cli(['room', 'invite', room.room_id, '--mode', 'public', '--role', 'reviewer', '--min-accepts', '1']);
  const rows = await observer.listIdentities();
  assert.equal(rows.find(row => row.name === room.identity_name)?.cid, room.identity_cid);
  assert.equal(rows.find(row => row.name === 'CrashFixtureRoot')?.cid, rootCid);
  assert.equal((await sibling.currentIdentity()).cid, siblingCid);
  assert(bindings().retired.includes(previousOwner), 'Predecessor must be retired');
  assert(owner(room.identity_name), 'Restored room must have an owner');
  assert.notEqual(owner(room.identity_name), previousOwner, 'New worker must have a fresh owner');
  pass('ordinary room operation succeeds with permanent CID, fresh owner and untouched sibling/root');
}
// Only fixture-owned cowork terminal records are read. No product receives this path.
function terminalRecord(previousOwner) {
  const directory = join(coworkState, 'owner-terminal');
  if (!existsSync(directory)) return undefined;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    const bytes = readFileSync(path);
    const record = JSON.parse(bytes);
    if (record.observation?.ownerInstanceId === previousOwner) return {path, bytes, record};
  }
}
async function savedEvent(previousOwner, current) {
  const saved = await waitFor(() => terminalRecord(previousOwner), 'durable original terminal event before delivery', 15000);
  assert.equal(saved.record.observation.reason, 'process-exit');
  assert.equal(saved.record.observation.process.pid, current.events.find(event => event.workerPid)?.workerPid);
  assert.equal(saved.record.selection.endpoint, endpoint);
  assert.equal(saved.record.selection.expectedInstanceId, instanceId);
  assert.equal(saved.record.selection.credentialPath, credentialPath);
  assert.equal(owner(room.identity_name), previousOwner, 'Offline daemon state must still protect predecessor before delivery');
  return saved;
}
const watchdog = setTimeout(() => {
  controller?.child.kill('SIGKILL'); daemon?.child.kill('SIGKILL'); broker?.child.kill('SIGKILL');
  console.error(`FAIL ${mode}: bounded fixture watchdog`); process.exit(124);
}, mode === 'delayed' ? 900000 : 480000);
try {
  broker = startProcess([join(ROOT, 'node_modules/.bin/adapt-broker'), '--host', '127.0.0.1', '--port', String(brokerPort), '--test_mode'], cleanEnv, ROOT);
  await waitForPort(brokerPort);
  await startDaemon();
  const attach = () => attachOursClient({endpoint, expectedInstanceId: instanceId, credentialPath, sessionMode: 'external', leaseToken: randomUUID(), env: {}});
  observer = await attach();
  await observer.createRootIdentity({...defaults('CrashFixtureRoot'), skipIfRootExists: false});
  rootCid = (await observer.currentIdentity()).cid;
  sibling = await attach(); await sibling.createTemporaryIdentity(defaults('LiveCrashSibling'));
  siblingCid = (await sibling.currentIdentity()).cid;
  const first = await startController();
  room = await cli(['room', 'create', '--name', 'Crash continuity room', '--goal', 'Exact existing lifecycle', '--briefing', 'Local only']);
  const originalOwner = owner(room.identity_name); assert(originalOwner);
  pass('actual built worker hosts room under its external owner');
  if (mode === 'worker') {
    await killWorker(first);
    await completedController(first);
    pass('existing supervisor observes its exact child and completes terminal delivery');
    await checkRecovery(originalOwner);
  } else if (mode === 'parent-loss') {
    // The fixture owns this exact parent handle; the worker is still alive when IPC disappears.
    first.child.kill('SIGKILL');
    assert.equal((await first.exited).signal, 'SIGKILL');
    coworkStarted = false;
    await waitFor(() => bindings().retired.includes(originalOwner) && !owner(room.identity_name), 'surviving worker SessionEnd cleanup after parent IPC loss', 45000);
    await waitFor(() => !existsSync(join(coworkState, 'daemon.lock')), 'surviving worker awaited shutdown releases cowork lock');
    pass('original live worker handles parent IPC loss and retires its exact owner');
    await checkRecovery(originalOwner);
  } else {
    await stopProcess(daemon, 'SIGKILL');
    await killWorker(first);
    const saved = await savedEvent(originalOwner, first);
    await sleep(1500); // Observe a real offline retry interval while the original supervisor survives.
    assert(!first.outcome, 'Original supervisor must survive pending delivery');
    assert.deepEqual(readFileSync(saved.path), saved.bytes, 'Offline retry must retain identical event');
    pass('offline exact-worker terminal event is saved unchanged while its original supervisor survives');
    await startDaemon();
    await completedController(first);
    assert(!terminalRecord(originalOwner), 'Complete delivery must acknowledge/remove original record');
    await checkRecovery(originalOwner);
    pass('same surviving supervisor completes cleanup after daemon return without a cowork restart');

    await cli(['stop']); coworkStarted = false;
    await waitFor(() => !existsSync(join(coworkState, 'daemon.lock')), 'intermediate normal cowork stop');
    await waitFor(() => !existsSync(join(coworkState, 'owner-terminal')) || readdirSync(join(coworkState, 'owner-terminal')).every(name => !name.endsWith('.json')), 'intermediate terminal deliveries acknowledged');
    const second = await startController();
    const secondOwner = owner(room.identity_name); assert(secondOwner);
    assert.notEqual(secondOwner, originalOwner);
    await stopProcess(daemon, 'SIGKILL');
    await killWorker(second);
    const retained = await savedEvent(secondOwner, second);
    second.child.kill('SIGKILL');
    assert.equal((await second.exited).signal, 'SIGKILL');
    assert.deepEqual(readFileSync(retained.path), retained.bytes, 'Terminal event must survive reporting-process loss');
    await startDaemon();
    assert.deepEqual(readFileSync(retained.path), retained.bytes, 'Daemon return must not rewrite a saved event');
    assert.equal(owner(room.identity_name), secondOwner, 'No surviving reporter exists before ordinary launch replay');
    const eventHash = createHash('sha256').update(retained.bytes).digest('hex');
    await checkRecovery(secondOwner);
    assert(!terminalRecord(secondOwner), 'Ordinary startup must acknowledge/remove replayed event');
    pass(`ordinary startup replays retained terminal event (sha256 ${eventHash}) before fresh room admission`);
  }
  console.log(`COWORK_V1_CRASH_PASS ${mode} (actual local broker; Linux Docker only)`);
} catch (error) {
  console.error(error.stack); process.exitCode = 1;
} finally {
  if (coworkStarted) { try { await cli(['stop']); } catch (error) { console.error('Cowork cleanup:', error.message); process.exitCode = 1; } }
  for (const client of [sibling, observer].filter(Boolean)) {
    try { await client.releaseLease(); await client.close(); } catch (error) { console.error('Fixture owner cleanup:', error.message); process.exitCode = 1; }
  }
  for (const ownedProcess of [controller, daemon, broker]) {
    try { await stopProcess(ownedProcess, ownedProcess === broker ? 'SIGKILL' : 'SIGTERM'); }
    catch (error) { console.error('Fixture process cleanup:', error.message); process.exitCode = 1; }
  }
  rmSync(state, {recursive: true, force: true}); clearTimeout(watchdog);
}
