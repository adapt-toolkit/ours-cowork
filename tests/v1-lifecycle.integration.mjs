// Actual built cowork CLI + V1 CLI/SDK + local ADAPT test broker.
// Local fixture transport is not production broker/platform acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachOursClient } from '@ours.network/sdk';
import { command, sleep, startProcess, stopProcess, unusedPort, waitFor, waitForPort } from './fixtures/v1-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, process.env.COWORK_V1_DIST ?? 'dist', 'cli.js');
const OURS_CLI = join(ROOT, 'node_modules/@ours.network/daemon/dist/cli.js');
const state = mkdtempSync(join(tmpdir(), 'cowork-v1-integration-'));
const daemonState = join(state, 'ours');
mkdirSync(daemonState, {mode: 0o700});
const cleanEnv = {...process.env};
for (const key of Object.keys(cleanEnv)) if (key.startsWith('OURS_')) delete cleanEnv[key];
const peers = [];
let broker, daemon, observer, coworkEnv;
let coworkStarted = false;
const cleanup = [];
const stage = label => console.log(`PASS ${label}`);
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
const selection = {endpoint, expectedInstanceId: daemonId, credentialPath, sessionMode: 'external', env: {}};
async function attach() { return attachOursClient({...selection, leaseToken: randomUUID()}); }
const defaults = name => ({name, bio: 'Local cowork V1 fixture', exposeLocal: false, localAutoAccept: true});
const bindings = () => JSON.parse(readFileSync(join(daemonState, 'bindings.json'), 'utf8'));
const owner = name => bindings().externalLeases.find(lease => lease.identity === name)?.token;
async function cli(args) {
  const body = JSON.parse(await command([CLI, '--json', ...args], coworkEnv, ROOT));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.result;
}
async function startDaemon() {
  daemon = startProcess([OURS_CLI, 'daemon', 'serve'], oursEnv, ROOT);
  await waitFor(async () => {
    assert.equal(daemon.child.exitCode, null, "Real V1 daemon exited before readiness");
    const response = await fetch(endpoint + '/selection', {signal: AbortSignal.timeout(1000)});
    return response.ok && (await response.json()).instanceId === daemonId && existsSync(credentialPath);
  }, 'real identified V1 daemon', 60000);
}
async function identityRows() { return observer.listIdentities(); }
async function makePeer(name) {
  const client = await attach();
  peers.push(client);
  const created = await client.createIdentity(defaults(name));
  return {client, cid: created.info.cid};
}
async function exchange(peer, room, text) {
  await peer.client.sendMessage({contact: room.identity_cid, text});
  await waitFor(async () => (await cli(['room', 'history', room.room_id, '--after', '0', '--limit', '1000']))
    .some(row => row.kind === 'message' && row.text === text), 'actual local participant message archive', 45000);
}
const watchdog = setTimeout(() => {
  daemon?.child.kill('SIGKILL'); broker?.child.kill('SIGKILL');
  console.error('FAIL cowork V1 integration watchdog'); process.exit(124);
}, 300000);
try {
  broker = startProcess([join(ROOT, 'node_modules/.bin/adapt-broker'), '--host', '127.0.0.1', '--port', String(brokerPort), '--test_mode'], cleanEnv, ROOT);
  await waitForPort(brokerPort);
  await startDaemon();
  observer = await attach();
  await observer.createRootIdentity({...defaults('CoworkV1Root'), skipIfRootExists: false});
  const rootCid = (await observer.currentIdentity()).cid;
  const sibling = await attach(); peers.push(sibling);
  await sibling.createTemporaryIdentity(defaults('UntouchedSibling'));
  const siblingCid = (await sibling.currentIdentity()).cid;
  const peer = await makePeer('CoworkParticipant');
  stage('real V1 daemon and independent fixture owners ready');

  const coworkConfig = join(state, 'cowork.json');
  writeFileSync(coworkConfig, JSON.stringify({version: 1, stateDir: join(state, 'cowork'), rest: {enabled: false, port: 3052}}), {mode: 0o600});
  coworkEnv = {...cleanEnv, HOME: state, OURS_COWORK_CONFIG: coworkConfig,
    OURS_DAEMON_URL: endpoint, OURS_DAEMON_ID: daemonId, OURS_DAEMON_CREDENTIAL_PATH: credentialPath};
  // Deliberately no OURS_CONFIG/STATE_DIR: V1 must use API identity, not private path selection.
  await cli(['start']); coworkStarted = true;
  const rooms = [];
  for (const name of ['First V1 room', 'Second V1 room']) rooms.push(await cli([
    'room', 'create', '--name', name, '--goal', 'Verify V1 lifecycle', '--briefing', 'Local fixture only',
  ]));
  const owners = rooms.map(room => owner(room.identity_name));
  assert(owners.every(Boolean)); assert.notEqual(owners[0], owners[1]);
  assert.deepEqual(rooms.map(room => (bindings().externalLeases.find(x => x.identity === room.identity_name)).sessionMode), ['external', 'external']);
  stage('built cowork CLI hosts two rooms with distinct external owner IDs');

  const invitation = await cli(['room', 'invite', rooms[0].room_id, '--mode', 'public', '--role', 'reviewer', '--min-accepts', '1']);
  await peer.client.addContact({invite: invitation.blob});
  await waitFor(async () => (await cli(['room', 'show', rooms[0].room_id])).state === 'active', 'actual local room activation', 45000);
  await exchange(peer, rooms[0], 'before daemon restart');
  stage('real local broker invitation and participant message reach cowork archive');

  const beforeBoot = (await observer.version({startup: true})).startup.bootId;
  await stopProcess(daemon, 'SIGKILL');
  await startDaemon();
  await waitFor(async () => (await observer.version({startup: true})).startup.phase === 'ready', 'restarted daemon ready', 60000);
  assert.notEqual((await observer.version({startup: true})).startup.bootId, beforeBoot);
  assert.deepEqual(rooms.map(room => owner(room.identity_name)), owners);
  for (const room of rooms) {
    assert.equal((await cli(['room', 'show', room.room_id])).identity_cid, room.identity_cid);
    await cli(['room', 'invite', room.room_id, '--mode', 'public', '--role', 'reviewer', '--min-accepts', '1']);
  }
  await sleep(1500); // Existing local broker reconnection, not a mutation retry.
  await exchange(peer, rooms[0], 'after daemon restart');
  assert.deepEqual(rooms.map(room => owner(room.identity_name)), owners);
  assert.equal((await sibling.currentIdentity()).cid, siblingCid);
  stage('actual daemon restart retains live cowork owner IDs/CIDs and message behavior');

  const oldToken = readFileSync(credentialPath, 'utf8').trim();
  await command([OURS_CLI, 'config', 'token-update', '--config', configPath, '--json'], oursEnv, ROOT);
  assert(readFileSync(credentialPath, "utf8").trim() !== oldToken, "Current token was replaced");
  assert.equal((await fetch(endpoint + '/version', {headers: {'x-ours-api-token': oldToken}})).status, 401);
  await cli(['room', 'invite', rooms[1].room_id, '--mode', 'public', '--role', 'reviewer', '--min-accepts', '1']);
  assert.deepEqual(rooms.map(room => owner(room.identity_name)), owners);
  stage('official common-token update preserves live cowork current-file access and owner IDs');

  await cli(['stop']); coworkStarted = false;
  await waitFor(() => !existsSync(join(state, 'cowork', 'daemon.lock')), 'cowork completed graceful shutdown');
  assert(owners.every(token => bindings().retired.includes(token)));
  assert(rooms.every(room => !owner(room.identity_name)));
  assert.equal((await sibling.currentIdentity()).cid, siblingCid);
  assert((await identityRows()).some(row => row.name === 'CoworkV1Root' && row.cid === rootCid));
  assert(rooms.every(room => (bindings().externalLeases ?? []).every(lease => lease.identity !== room.identity_name)));
  stage('awaited cowork stop retires exact room owners and preserves permanent/sibling identities');

  const coworkState = join(state, 'cowork');
  const residueNames = readdirSync(coworkState).filter(name =>
    /^management\.sock\.(?:safe-residue-private-alias|replacement)-[1-9][0-9]*-[a-f0-9]{12}$/.test(name));
  assert(residueNames.length > 0, 'normal shutdown leaves private socket residues');
  const unsafeResidue = join(coworkState, 'management.sock.replacement-1-0123456789ab');
  const retainedFile = join(coworkState, 'backup-retained.txt');
  const retainedLink = join(coworkState, 'backup-retained-link');
  writeFileSync(retainedFile, 'retained', {mode: 0o600});
  symlinkSync(retainedFile, retainedLink);
  symlinkSync(retainedFile, unsafeResidue);
  await assert.rejects(cli(['prepare-backup']), /invalid_state/);
  assert(lstatSync(unsafeResidue).isSymbolicLink());
  assert(residueNames.every(name => lstatSync(join(coworkState, name)).isSocket()));
  assert.equal(existsSync(join(coworkState, 'daemon.lock')), false);
  rmSync(unsafeResidue);
  writeFileSync(unsafeResidue, 'protected replacement', {mode: 0o600});
  await assert.rejects(cli(['prepare-backup']), /invalid_state/);
  assert.equal(readFileSync(unsafeResidue, 'utf8'), 'protected replacement');
  assert(residueNames.every(name => lstatSync(join(coworkState, name)).isSocket()));
  rmSync(unsafeResidue);
  const prepared = await cli(['prepare-backup']);
  assert.equal(prepared.removed, residueNames.length);
  assert(residueNames.every(name => !existsSync(join(coworkState, name))));
  assert.equal((await cli(['prepare-backup'])).removed, 0);
  assert.equal(readFileSync(retainedFile, 'utf8'), 'retained');
  assert(lstatSync(retainedLink).isSymbolicLink());
  assert.equal(existsSync(join(coworkState, 'daemon.lock')), false);
  assert.equal(existsSync(join(coworkState, 'daemon.pid')), false);
  const emptyState = join(state, 'empty-cowork');
  mkdirSync(emptyState, {mode: 0o700});
  const noMatch = JSON.parse(await command([CLI, '--json', 'prepare-backup'],
    {...coworkEnv, OURS_COWORK_STATE_DIR: emptyState}, ROOT));
  assert.equal(noMatch.ok, true);
  assert.equal(noMatch.result.removed, 0);
  assert.deepEqual(readdirSync(emptyState), []);
  stage('offline backup preparation removes only inert residues and preserves unsafe entries');


  // This existing packet constructor gets a genuinely unbound fresh public client.
  // A retired owner is tested only as an unrecoverable refusal afterward.
  const packetOutput = await command(['--import', 'tsx', join(ROOT, 'tests/fixtures/v1-packet.mjs'), rooms[0].identity_name, rooms[0].identity_cid], coworkEnv, ROOT);
  process.stdout.write(packetOutput);

  await cli(['start']); coworkStarted = true;
  for (let i = 0; i < rooms.length; i++) {
    const room = await cli(['room', 'show', rooms[i].room_id]);
    assert.equal(room.identity_cid, rooms[i].identity_cid);
    assert(owner(room.identity_name)); assert.notEqual(owner(room.identity_name), owners[i]);
  }
  assert.notEqual(owner(rooms[0].identity_name), owner(rooms[1].identity_name));
  const liveLock = readFileSync(join(coworkState, 'daemon.lock'), 'utf8');
  await assert.rejects(cli(['prepare-backup']), /invalid_state/);
  assert.equal(readFileSync(join(coworkState, 'daemon.lock'), 'utf8'), liveLock);
  assert.equal((await cli(['status'])).running, true);
  stage('new cowork worker restores exact durable rooms with fresh distinct owners');
  console.log('COWORK_V1_INTEGRATION_PASS (local broker only; no abrupt cowork crash cleanup claim)');
} catch (error) {
  console.error(error.stack);
  const log = join(state, 'cowork', 'daemon.log');
  if (existsSync(log)) console.error(readFileSync(log, 'utf8').slice(-14000));
  process.exitCode = 1;
} finally {
  if (coworkStarted) { try { await cli(['stop']); } catch (error) { cleanup.push(error); } }
  for (const client of [...peers, observer].filter(Boolean)) {
    try { await client.releaseLease(); await client.close(); } catch (error) { cleanup.push(error); }
  }
  try { await stopProcess(daemon); } catch (error) { cleanup.push(error); }
  try { await stopProcess(broker, 'SIGKILL'); } catch (error) { cleanup.push(error); }
  if (cleanup.length) { console.error('Cleanup failures:', cleanup.map(e => e.message)); process.exitCode = 1; }
  rmSync(state, {recursive: true, force: true});
  clearTimeout(watchdog);
}
