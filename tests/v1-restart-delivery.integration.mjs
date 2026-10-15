// Actual built cowork CLI + V1 daemon + local ADAPT test broker.
// Asserts recipient inbox delivery (not only the cowork archive) in both
// directions across each restart shape, with no invite/rebind mutation between
// the restart and the first post-restart message.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachOursClient } from '@ours.network/sdk';
import { command, sleep, startProcess, stopProcess, unusedPort, waitFor, waitForPort } from './fixtures/v1-runtime.mjs';

const SCENARIOS = ['cowork-graceful', 'daemon-kill', 'worker-kill', 'worker-kill-supervisor-delayed',
  'boot-window-supervisor-delayed', 'cowork-kill', 'system-kill', 'system-kill-cowork-first',
  'system-term', 'system-term-daemon-first', 'foreign-owner'];
const selected = process.argv.slice(2).length ? process.argv.slice(2) : SCENARIOS;
for (const name of selected) assert(SCENARIOS.includes(name), `Unknown restart scenario ${name}`);
const DELIVERY_TIMEOUT_MS = Number(process.env.COWORK_RESTART_DELIVERY_TIMEOUT_MS ?? 30000);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, process.env.COWORK_V1_DIST ?? 'dist', 'cli.js');
const OURS_CLI = join(ROOT, 'node_modules/@ours.network/daemon/dist/cli.js');
const state = mkdtempSync(join(tmpdir(), 'cowork-v1-restart-delivery-'));
const daemonState = join(state, 'ours');
const coworkState = join(state, 'cowork');
mkdirSync(daemonState, {mode: 0o700});
const cleanEnv = {...process.env};
for (const key of Object.keys(cleanEnv)) if (key.startsWith('OURS_')) delete cleanEnv[key];
const brokerPort = await unusedPort();
const daemonPort = await unusedPort();
const endpoint = `http://127.0.0.1:${daemonPort}`;
const daemonId = randomUUID();
const credentialPath = join(daemonState, 'daemon-token');
const configPath = join(state, 'ours.json');
writeFileSync(configPath, JSON.stringify({
  brokerUrl: `ws://127.0.0.1:${brokerPort}`, port: daemonPort,
  stateDir: daemonState, apiVisibility: 'owner', apiTokenDeliveryFiles: [],
}), {mode: 0o600});
const oursEnv = {...cleanEnv, HOME: state, OURS_CONFIG: configPath, OURS_DAEMON_ID: daemonId};
const coworkConfig = join(state, 'cowork.json');
writeFileSync(coworkConfig, JSON.stringify({version: 1, stateDir: coworkState, rest: {enabled: false, port: 3052}}), {mode: 0o600});
const coworkEnv = {...cleanEnv, HOME: state, OURS_COWORK_CONFIG: coworkConfig,
  OURS_DAEMON_URL: endpoint, OURS_DAEMON_ID: daemonId, OURS_DAEMON_CREDENTIAL_PATH: credentialPath};
const selection = {endpoint, expectedInstanceId: daemonId, credentialPath, sessionMode: 'external', env: {}};
const defaults = name => ({name, bio: 'Local restart delivery fixture', exposeLocal: false, localAutoAccept: true});
const bindings = () => JSON.parse(readFileSync(join(daemonState, 'bindings.json'), 'utf8'));
const lease = name => bindings().externalLeases.find(row => row.identity === name)?.token;
const failures = [];
const clients = [];
let broker, daemon, observer, ownerSeat, agentSeat, room, coworkStarted = false;
const note = line => console.log(line);

async function cli(args) {
  const body = JSON.parse(await command([CLI, '--json', ...args], coworkEnv, ROOT, 120000));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.result;
}
async function startDaemon() {
  daemon = startProcess([OURS_CLI, 'daemon', 'serve'], oursEnv, ROOT);
  await waitFor(async () => {
    assert.equal(daemon.child.exitCode, null, 'V1 daemon exited before readiness');
    const response = await fetch(endpoint + '/selection', {signal: AbortSignal.timeout(1000)});
    return response.ok && (await response.json()).instanceId === daemonId && existsSync(credentialPath);
  }, 'identified V1 daemon', 60000);
  if (observer) await waitFor(async () => (await observer.version({startup: true})).startup.phase === 'ready', 'restarted daemon ready', 60000);
}
async function seat(name) {
  const client = await attachOursClient({...selection, leaseToken: randomUUID()});
  clients.push(client);
  const created = await client.createIdentity(defaults(name));
  return {name, client, cid: created.info.cid};
}
// Each seat keeps its own lease; a daemon restart may leave it NOT_BOUND.
async function bound(member, work) {
  try { return await work(); } catch (error) {
    if (error?.code !== 'NOT_BOUND' && error?.code !== 'BINDING_REASSIGNED') throw error;
    await member.client.chooseIdentity({name: member.name, force: false});
    return work();
  }
}
async function receives(member, text, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pulled = await bound(member, () => member.client.getMessages({limit: 50}));
    for (const message of pulled.messages) {
      if (message.from.id !== room.identity_cid) continue;
      let envelope; try { envelope = JSON.parse(message.text); } catch { continue; }
      if (envelope.kind === 'room_msg' && envelope.text === text) return true;
    }
    await sleep(250);
  }
  return false;
}
let archiveCursor = 0;
async function archived(text) {
  for (;;) {
    const rows = await cli(['room', 'history', room.room_id, '--after', String(archiveCursor), '--limit', '10']);
    if (rows.some(row => row.kind === 'message' && row.text === text)) return true;
    if (rows.length === 0) return false;
    archiveCursor = Math.max(archiveCursor, ...rows.map(row => row.seq));
  }
}
// Recipient receipt is the acceptance fact; the archive is reported separately.
async function roundTrip(label, timeout = DELIVERY_TIMEOUT_MS) {
  const result = {};
  for (const [direction, from, to] of [['owner->agent', ownerSeat, agentSeat], ['agent->owner', agentSeat, ownerSeat]]) {
    const text = `${label} ${direction} ${randomUUID()}`;
    await bound(from, () => from.client.sendMessage({contact: room.identity_cid, text}));
    const delivered = await receives(to, text, timeout);
    result[direction] = {delivered, archived: await archived(text)};
  }
  return result;
}
// Operator console path: `room message` must reach every seat's inbox.
async function operatorFanout(label, timeout = DELIVERY_TIMEOUT_MS) {
  const text = `${label} operator ${randomUUID()}`;
  try { await cli(['room', 'message', room.room_id, '--text', text]); }
  catch (error) { return {accepted: false, error: /"message":"([^"]{0,160})/.exec(error.message)?.[1] ?? 'refused'}; }
  const [owner, agent] = await Promise.all([receives(ownerSeat, text, timeout), receives(agentSeat, text, timeout)]);
  return {accepted: true, owner, agent};
}
async function membership() {
  const shown = await cli(['room', 'show', room.room_id]);
  const seats = (await cli(['room', 'participants', room.room_id]))
    .map(row => `${row.identity}:${row.participant_id}:${row.state}:${row.role}`).sort();
  assert(seats.length >= 2 && seats.every(seat => /^[0-9A-F]{64}:/.test(seat)), 'seat snapshot must carry real identities');
  // Each seat's own daemon contact book must still hold the immutable room CID.
  const seat_contacts_room = await Promise.all([ownerSeat, agentSeat].map(async member =>
    (await bound(member, () => member.client.listContacts())).contacts.some(contact => contact.container_id === room.identity_cid)));
  return JSON.stringify({state: shown.state, room_cid: shown.identity_cid, epoch: shown.membership_epoch, seats, seat_contacts_room});
}
const delivered = result => Object.values(result).every(row => row.delivered);
function coworkPids() {
  const supervisor = Number(readFileSync(join(coworkState, 'daemon.pid'), 'utf8').trim());
  const workers = execFileSync('pgrep', ['-P', String(supervisor)], {encoding: 'utf8'}).trim().split('\n').map(Number);
  return [supervisor, ...workers];
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function killCowork() {
  const pids = coworkPids();
  // Supervisor first: no terminal owner record can be published for the worker.
  for (const pid of pids) process.kill(pid, 'SIGKILL');
  await waitFor(() => pids.every(pid => !alive(pid)), 'cowork supervisor and worker killed');
  coworkStarted = false;
}
// A service manager escalates to SIGKILL after its stop timeout.
async function termCowork(pids, graceMs = 15000) {
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGTERM');
  const ended = await waitFor(() => pids.every(pid => !alive(pid)), 'cowork ended by SIGTERM', graceMs).then(() => true, () => false);
  if (!ended) {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await waitFor(() => pids.every(pid => !alive(pid)), 'cowork stop-timeout SIGKILL');
  }
  coworkStarted = false;
  return ended ? 'exited' : 'escalated-to-sigkill';
}
function daemonLogTail() {
  const path = join(coworkState, 'daemon.log');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(line =>
    /startup_room|identity_rebind|failed|refus|BOUND|REASSIGNED/i.test(line)).slice(-8) : [];
}
function hostState() {
  const row = bindings().externalLeases.find(entry => entry.identity === room.identity_name);
  return {room_owner_present: Boolean(row?.token)};
}

async function delayedSupervisor(bootWindow) {
    const [supervisor, ...workers] = coworkPids();
    process.kill(supervisor, 'SIGSTOP');
    if (bootWindow) rmSync(join(coworkState, 'daemon.pid'));
    try {
      for (const pid of workers) process.kill(pid, 'SIGKILL');
      await waitFor(() => workers.every(pid => !alive(pid) || /^\S+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))), 'worker killed under a stopped supervisor');
      const ownerHeld = lease(room.identity_name);
      const logged = readFileSync(join(coworkState, 'daemon.log'), 'utf8').length;
      await assert.rejects(cli(['start']), 'a replacement must be refused while the predecessor supervisor lives');
      const refusal = /cowork (supervisor|daemon) is already running with PID [0-9]+/.exec(readFileSync(join(coworkState, 'daemon.log'), 'utf8').slice(logged));
      note(`  replacement refused by: ${refusal?.[0].replace(/[0-9]+$/, '<pid>') ?? 'unidentified guard'}`);
      // The supervisor-lifetime lock must refuse before any worker is forked.
      if (!process.env.COWORK_RESTART_LEGACY_GUARD) assert.equal(refusal?.[1], 'supervisor');
      assert.equal(lease(room.identity_name), ownerHeld, 'refused replacement must not touch the predecessor owner');
      assert(!existsSync(join(coworkState, 'owner-terminal')) || !readdirSync(join(coworkState, 'owner-terminal')).some(name => name.endsWith('.json')),
        'the stopped supervisor has not yet published a terminal event');
    } finally { process.kill(supervisor, 'SIGCONT'); }
    await waitFor(() => !alive(supervisor), 'resumed supervisor finished terminal delivery', 45000);
    coworkStarted = false;
    await cli(['start']); coworkStarted = true;
  }
const restarts = {
  async 'cowork-graceful'() {
    await cli(['stop']); coworkStarted = false;
    await waitFor(() => !existsSync(join(coworkState, 'daemon.lock')), 'graceful cowork stop');
    await cli(['start']); coworkStarted = true;
  },
  async 'daemon-kill'() {
    await stopProcess(daemon, 'SIGKILL');
    await startDaemon();
  },
  // The surviving supervisor reports process-exit, terminally retiring the owner.
  async 'worker-kill'() {
    const [supervisor, ...workers] = coworkPids();
    for (const pid of workers) process.kill(pid, 'SIGKILL');
    await waitFor(() => !alive(supervisor), 'supervisor finished terminal delivery', 45000);
    coworkStarted = false;
    await cli(['start']); coworkStarted = true;
  },
  // The worker is dead but its supervisor has not yet reported that: no
  // replacement host may be admitted until the predecessor's terminal delivery.
  async 'worker-kill-supervisor-delayed'() { await delayedSupervisor(false); },
  // Same loss inside the boot window: rooms are attached but daemon.pid, the
  // worker lock's only supervisor evidence, has not been written yet.
  async 'boot-window-supervisor-delayed'() { await delayedSupervisor(true); },
  async 'cowork-kill'() {

    await killCowork();
    await cli(['start']); coworkStarted = true;
  },
  // Host power loss / reboot: nothing survives to report a terminal owner event.
  async 'system-kill'() {
    await killCowork();
    await stopProcess(daemon, 'SIGKILL');
    await startDaemon();
    await cli(['start']); coworkStarted = true;
  },
  async 'system-kill-cowork-first'() {
    await stopProcess(daemon, 'SIGKILL');
    await killCowork();
    await startDaemon();
    await cli(['start']); coworkStarted = true;
  },
  // Orderly host shutdown: the service manager signals the whole control group.
  async 'system-term'() {
    const pids = coworkPids();
    daemon.child.kill('SIGTERM');
    note(`  system-term cowork stop: ${await termCowork(pids)}`);
    await daemon.exited;
    await startDaemon();
    await cli(['start']); coworkStarted = true;
  },
  async 'system-term-daemon-first'() {
    await stopProcess(daemon, 'SIGTERM');
    note(`  system-term-daemon-first cowork stop: ${await termCowork(coworkPids())}`);
    await startDaemon();
    await cli(['start']); coworkStarted = true;
  },
};

// A genuinely live competing owner must keep the room identity: cowork may
// neither take it over nor lose its durable room once the competitor leaves.
async function foreignOwner() {
  await cli(['stop']); coworkStarted = false;
  await waitFor(() => !existsSync(join(coworkState, 'daemon.lock')), 'graceful cowork stop');
  const foreign = await attachOursClient({...selection, leaseToken: randomUUID()}); clients.push(foreign);
  assert.equal((await foreign.chooseIdentity({name: room.identity_name, force: false})).cid, room.identity_cid);
  const foreignLease = lease(room.identity_name);
  await cli(['start']); coworkStarted = true;
  const refused = await roundTrip('foreign-owner held', 4000);
  assert(!delivered(refused) && !refused['owner->agent'].delivered && !refused['agent->owner'].delivered,
    'cowork must not host a room whose identity a live competitor owns');
  assert.equal(lease(room.identity_name), foreignLease, 'live competing owner must keep its exact lease');
  assert.equal((await foreign.currentIdentity()).cid, room.identity_cid);
  await assert.rejects(cli(['room', 'rebind', room.room_id]), /invalid_state/);
  assert.equal(lease(room.identity_name), foreignLease, 'operator rebind must not displace a live competitor');
  assert.equal((await foreign.releaseLease()).failed, 0);
  await cli(['room', 'rebind', room.room_id]);
  const recovered = await roundTrip('foreign-owner released');
  assert(delivered(recovered), `room must recover after the competitor releases: ${JSON.stringify(recovered)}`);
  note(`PASS foreign-owner: ${JSON.stringify({refused, competitor_lease_kept: true, recovered})}`);
}

const watchdog = setTimeout(() => {
  daemon?.child.kill('SIGKILL'); broker?.child.kill('SIGKILL');
  console.error('FAIL cowork restart delivery watchdog'); process.exit(124);
}, 1500000);
try {
  broker = startProcess([join(ROOT, 'node_modules/.bin/adapt-broker'), '--host', '127.0.0.1', '--port', String(brokerPort), '--test_mode'], cleanEnv, ROOT);
  await waitForPort(brokerPort);
  await startDaemon();
  observer = await attachOursClient({...selection, leaseToken: randomUUID()}); clients.push(observer);
  await observer.createRootIdentity({...defaults('RestartDeliveryRoot'), skipIfRootExists: false});
  ownerSeat = await seat('RestartOwnerSeat');
  agentSeat = await seat('RestartAgentSeat');
  await cli(['start']); coworkStarted = true;
  room = await cli(['room', 'create', '--name', 'Restart delivery room', '--goal', 'Verify restart delivery', '--briefing', 'Local fixture only']);
  const invitation = await cli(['room', 'invite', room.room_id, '--mode', 'public', '--role', 'reviewer', '--min-accepts', '2']);
  await ownerSeat.client.addContact({invite: invitation.blob});
  await agentSeat.client.addContact({invite: invitation.blob});
  await waitFor(async () => (await cli(['room', 'show', room.room_id])).state === 'active', 'room activation', 45000);
  await waitFor(async () => (await cli(['room', 'participants', room.room_id])).length >= 2, 'both seats admitted', 45000);

  for (const scenario of selected) {
    if (scenario === 'foreign-owner') { await foreignOwner(); continue; }
    const before = await roundTrip(`${scenario} before`);
    assert(delivered(before), `${scenario}: baseline delivery must work before restart: ${JSON.stringify(before)}`);
    const leaseBefore = lease(room.identity_name);
    const membersBefore = await membership();
    await restarts[scenario]();
    const visible = (await cli(['room', 'list'])).some(row => row.room_id === room.room_id);
    const membership_unchanged = (await membership()) === membersBefore;
    const after = await roundTrip(`${scenario} after`);
    const operator = await operatorFanout(`${scenario} after`, after['owner->agent'].delivered ? DELIVERY_TIMEOUT_MS : 5000);
    const ok = delivered(after) && operator.accepted && operator.owner && operator.agent && membership_unchanged;
    note(`${ok ? 'PASS' : 'FAIL'} ${scenario}: ${JSON.stringify({before, after, operator, visible, membership_unchanged,
      membership: JSON.parse(membersBefore), room_owner_changed: lease(room.identity_name) !== leaseBefore, ...hostState()})}`);
    if (!ok) {
      for (const line of daemonLogTail()) note(`  cowork log: ${line}`);
      failures.push(scenario);
      // Operator recovery proves the durable state survived; it is not the fix.
      const rebound = await cli(['room', 'rebind', room.room_id]).then(() => 'rebound', error => `refused: ${error.message.slice(0, 300)}`);
      const recovered = rebound === 'rebound' ? await roundTrip(`${scenario} after-rebind`) : undefined;
      note(`  manual room rebind: ${rebound}${recovered ? ' ' + JSON.stringify(recovered) : ''}`);
      if (!recovered || !delivered(recovered)) break;
    }
  }
  if (failures.length) throw new Error(`post-restart room delivery failed: ${failures.join(', ')}`);
  console.log('COWORK_V1_RESTART_DELIVERY_PASS (local broker only)');
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  if (coworkStarted) { try { await cli(['stop']); } catch (error) { console.error('Cowork cleanup:', error.message); try { await killCowork(); } catch { /* already gone */ } } }
  for (const client of clients) { try { await client.releaseLease(); await client.close(); } catch { /* fixture owner */ } }
  try { await stopProcess(daemon); } catch { /* bounded above */ }
  try { await stopProcess(broker, 'SIGKILL'); } catch { /* fixture broker */ }
  if (!process.env.COWORK_RESTART_KEEP_STATE) rmSync(state, {recursive: true, force: true});
  else console.log(`state retained at ${state}`);
  clearTimeout(watchdog);
}
