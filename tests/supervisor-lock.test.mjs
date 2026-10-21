import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acquireSupervisorLock, currentSupervisorGeneration, inspectProcess, SupervisorAlreadyRunningError, supervisorGenerationFinished,
} from '../src/supervisor-lock.ts';

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-supervisor-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const generationPath = (dir, generation) => join(dir, `supervisor.lock.${generation}`);
const record = (dir, generation) => JSON.parse(readFileSync(generationPath(dir, generation), 'utf8'));
/** A process table keyed by PID; absent means the PID does not exist. */
const table = (rows) => (pid) => rows[pid] === undefined ? undefined : { pid, ...rows[pid] };
const A = { boot_id: 'boot-a', start_id: '5' };
const B = { boot_id: 'boot-a', start_id: '9' };
const everyone = table({ 100: A, 200: B, 300: { boot_id: 'boot-a', start_id: '11' }, 400: { boot_id: 'boot-a', start_id: '13' } });

test('a live supervisor excludes every replacement until it releases', (t) => {
  const dir = stateDir(t);
  const first = acquireSupervisorLock(dir, { pid: 100, inspect: everyone });
  assert.equal(readFileSync(generationPath(dir, 1), 'utf8'), '{"pid":100,"boot_id":"boot-a","start_id":"5"}\n');
  assert.throws(() => acquireSupervisorLock(dir, { pid: 200, inspect: everyone }),
    (error) => error instanceof SupervisorAlreadyRunningError && /PID 100/.test(error.message));
  assert.deepEqual(readdirSync(dir), ['supervisor.lock.1'], 'a refused replacement leaves the holder intact');
  first.release();
  first.release();
  assert.deepEqual(record(dir, 1), { pid: 100, ...A, released: true }, 'release leaves a tombstone so numbering never restarts');
  const second = acquireSupervisorLock(dir, { pid: 200, inspect: everyone });
  assert.deepEqual(readdirSync(dir), ['supervisor.lock.2'], 'the superseded generation is removed by its successor');
  assert.throws(() => acquireSupervisorLock(dir, { pid: 300, inspect: everyone }), SupervisorAlreadyRunningError);
  second.release();
});

test('a stopped supervisor generation is finished only once it can no longer exclude a replacement', (t) => {
  const dir = stateDir(t);
  assert.equal(currentSupervisorGeneration(dir), undefined);
  const first = acquireSupervisorLock(dir, { pid: 100, inspect: everyone });
  const generation = currentSupervisorGeneration(dir);
  assert.equal(generation, 1);
  assert.equal(supervisorGenerationFinished(dir, generation, { inspect: everyone }), false, 'a live holder is not finished');
  assert.equal(supervisorGenerationFinished(dir, generation, { inspect: table({ 100: {} }) }), false,
    'a holder without incarnation evidence is not finished');
  assert.equal(supervisorGenerationFinished(dir, generation, { inspect: table({}) }), true, 'a dead holder is finished');
  assert.deepEqual(readdirSync(dir), ['supervisor.lock.1'], 'observation never changes the lock');
  first.release();
  assert.equal(supervisorGenerationFinished(dir, generation, { inspect: everyone }), true, 'a tombstone is finished');
  acquireSupervisorLock(dir, { pid: 200, inspect: everyone });
  assert.equal(supervisorGenerationFinished(dir, generation, { inspect: everyone }), true, 'a superseded generation is finished');
  assert.equal(supervisorGenerationFinished(dir, 2, { inspect: everyone }), false, 'its live successor is not');
});

test('only positive evidence of death supersedes a recorded supervisor', (t) => {
  for (const [label, rows, replaced] of [
    ['PID gone', { 200: B }, true],
    ['PID reused after reboot', { 100: { boot_id: 'boot-b', start_id: '5' }, 200: { boot_id: 'boot-b', start_id: '9' } }, true],
    ['PID reused in the same boot', { 100: { boot_id: 'boot-a', start_id: '77' }, 200: B }, true],
    ['same incarnation', { 100: A, 200: B }, false],
    ['PID present without incarnation evidence', { 100: {}, 200: {} }, false],
  ]) {
    const dir = stateDir(t);
    acquireSupervisorLock(dir, { pid: 100, inspect: table({ 100: A }) });
    const attempt = () => acquireSupervisorLock(dir, { pid: 200, inspect: table(rows) });
    if (replaced) { attempt(); assert.equal(record(dir, 2).pid, 200, label); assert.deepEqual(readdirSync(dir), ['supervisor.lock.2'], label); }
    else { assert.throws(attempt, SupervisorAlreadyRunningError, label); assert.deepEqual(readdirSync(dir), ['supervisor.lock.1'], label); }
  }

  // Inspection that fails is uncertainty, never proof.
  const dir = stateDir(t);
  acquireSupervisorLock(dir, { pid: 100, inspect: table({ 100: A }) });
  assert.throws(() => acquireSupervisorLock(dir, { pid: 200, inspect: (pid) => {
    if (pid === 100) throw new Error('procfs unavailable');
    return { pid };
  } }), SupervisorAlreadyRunningError);
});

test('a superseded holder cannot disturb its successor, and unsafe lock files fail closed', (t) => {
  const dir = stateDir(t);
  const stale = acquireSupervisorLock(dir, { pid: 100, inspect: table({ 100: A }) });
  acquireSupervisorLock(dir, { pid: 200, inspect: table({ 200: B }) });
  stale.release();
  assert.deepEqual(readdirSync(dir), ['supervisor.lock.2']);
  assert.deepEqual(record(dir, 2), { pid: 200, ...B });

  for (const corrupt of [
    (path) => writeFileSync(path, 'not json\n', { mode: 0o600 }),
    (path) => writeFileSync(path, '{"pid":0}\n', { mode: 0o600 }),
    (path) => writeFileSync(path, '{"pid":100,"released":"yes"}\n', { mode: 0o600 }),
    (path) => chmodSync(path, 0o644),
    (path) => { rmSync(path); writeFileSync(path + '.target', '{"pid":1}\n', { mode: 0o600 }); symlinkSync(path + '.target', path); },
  ]) {
    const unsafe = stateDir(t);
    acquireSupervisorLock(unsafe, { pid: 100, inspect: table({ 100: {} }) });
    corrupt(generationPath(unsafe, 1));
    assert.throws(() => acquireSupervisorLock(unsafe, { pid: 200, inspect: table({ 200: {} }) }),
      (error) => !(error instanceof SupervisorAlreadyRunningError));
    assert.equal(nodeFs.lstatSync(generationPath(unsafe, 1)) !== undefined, true, 'an untrusted lock is never removed');
    assert.equal(existsSync(generationPath(unsafe, 2)), false, 'and never superseded');
  }
});

test('the real process table recognises this process and a missing PID', (t) => {
  const dir = stateDir(t);
  const lock = acquireSupervisorLock(dir);
  assert.equal(record(dir, 1).pid, process.pid);
  assert.throws(() => acquireSupervisorLock(dir), SupervisorAlreadyRunningError);
  lock.release();
  writeFileSync(generationPath(dir, 7), '{"pid":4194303,"boot_id":"gone","start_id":"1"}\n', { mode: 0o600 });
  acquireSupervisorLock(dir).release();
  assert.deepEqual(readdirSync(dir), ['supervisor.lock.8']);
});

test('a holder killed between publishing and removing its temporary name is recoverable', (t) => {
  const alias = (dir) => join(dir, `.supervisor.lock-${'ab'.repeat(16)}.tmp`);

  // Durable crash image: the published generation still has its temporary link.
  const dead = stateDir(t);
  acquireSupervisorLock(dead, { pid: 100, inspect: table({ 100: A }) });
  linkSync(generationPath(dead, 1), alias(dead));
  assert.equal(statSync(generationPath(dead, 1)).nlink, 2);
  acquireSupervisorLock(dead, { pid: 200, inspect: table({ 200: { boot_id: 'boot-b', start_id: '9' } }) });
  assert.deepEqual(readdirSync(dead), ['supervisor.lock.2']);
  assert.equal(statSync(generationPath(dead, 2)).nlink, 1);

  // The same image with the holder still alive keeps excluding replacements.
  const live = stateDir(t);
  acquireSupervisorLock(live, { pid: 100, inspect: table({ 100: A }) });
  linkSync(generationPath(live, 1), alias(live));
  assert.throws(() => acquireSupervisorLock(live, { pid: 200, inspect: table({ 100: A, 200: {} }) }), SupervisorAlreadyRunningError);
  assert.equal(record(live, 1).pid, 100);

  // A second link under any other name is not ours to remove: fail closed.
  const foreign = stateDir(t);
  acquireSupervisorLock(foreign, { pid: 100, inspect: table({ 100: A }) });
  linkSync(generationPath(foreign, 1), join(foreign, 'kept-alias'));
  assert.throws(() => acquireSupervisorLock(foreign, { pid: 200, inspect: table({ 200: {} }) }), /single-link/);
  assert.equal(existsSync(join(foreign, 'kept-alias')), true);

  // An unrelated temporary file is never touched.
  const other = stateDir(t);
  acquireSupervisorLock(other, { pid: 100, inspect: table({ 100: A }) });
  linkSync(generationPath(other, 1), alias(other));
  const unrelated = join(other, `.supervisor.lock-${'cd'.repeat(16)}.tmp`);
  writeFileSync(unrelated, 'another launch', { mode: 0o600 });
  acquireSupervisorLock(other, { pid: 200, inspect: table({ 200: {} }) });
  assert.equal(readFileSync(unrelated, 'utf8'), 'another launch');
});

test('publication is a single link before it is made durable', (t) => {
  const dir = stateDir(t);
  const fs = { ...nodeFs, fsyncSync(fd) {
    if (existsSync(generationPath(dir, 1))) assert.equal(statSync(generationPath(dir, 1)).nlink, 1);
    return nodeFs.fsyncSync(fd);
  } };
  acquireSupervisorLock(dir, { pid: 100, inspect: table({ 100: {} }), fs });
  assert.deepEqual(readdirSync(dir), ['supervisor.lock.1']);
});

/** Run `intruder` once, immediately before the contender's nth call of `method`. */
function interleave(method, nth, intruder) {
  let calls = 0;
  return { ...nodeFs, [method](...args) {
    if (++calls === nth) intruder();
    return nodeFs[method](...args);
  } };
}

test('two contenders reclaiming the same dead supervisor cannot both acquire', (t) => {
  // B supersedes the stale generation after A judged it dead but before A publishes.
  for (const method of ['linkSync', 'openSync']) {
    const dir = stateDir(t);
    acquireSupervisorLock(dir, { pid: 100, inspect: table({ 100: A }) });
    const alive = table({ 200: B, 300: { boot_id: 'boot-a', start_id: '11' } });
    let contenderB;
    const fs = interleave(method, 1, () => { contenderB = acquireSupervisorLock(dir, { pid: 300, inspect: alive }); });
    assert.throws(() => acquireSupervisorLock(dir, { pid: 200, inspect: alive, fs }),
      (error) => error instanceof SupervisorAlreadyRunningError && /PID 300/.test(error.message), method);
    assert.deepEqual(readdirSync(dir), ['supervisor.lock.2'], method);
    assert.equal(record(dir, 2).pid, 300, 'the live winner is untouched');
    contenderB.release();
  }
});

test('a contender acting on a stale listing backs off from a recreated generation', (t) => {
  // After A lists [1 dead]: Q supersedes with 2, removes 1 and releases; R then
  // holds 3 and removes 2. A's exclusive link of generation 2 now succeeds.
  const dir = stateDir(t);
  acquireSupervisorLock(dir, { pid: 100, inspect: table({ 100: A }) });
  const alive = table({ 200: B, 300: { boot_id: 'boot-a', start_id: '11' }, 400: { boot_id: 'boot-a', start_id: '13' } });
  let holderR;
  const fs = interleave('linkSync', 1, () => {
    acquireSupervisorLock(dir, { pid: 300, inspect: alive }).release();
    holderR = acquireSupervisorLock(dir, { pid: 400, inspect: alive });
    assert.equal(existsSync(generationPath(dir, 2)), false, 'generation 2 was superseded and removed');
  });
  assert.throws(() => acquireSupervisorLock(dir, { pid: 200, inspect: alive, fs }),
    (error) => error instanceof SupervisorAlreadyRunningError && /PID 400/.test(error.message));
  assert.deepEqual(readdirSync(dir), ['supervisor.lock.3'], 'the recreated lower generation is withdrawn');
  assert.equal(record(dir, 3).pid, 400);
  holderR.release();
});

test('concurrent processes reclaiming one dead supervisor yield exactly one holder', async (t) => {
  const dir = stateDir(t);
  writeFileSync(generationPath(dir, 1), '{"pid":4194303,"boot_id":"gone","start_id":"1"}\n', { mode: 0o600 });
  const contender = fileURLToPath(new URL('./fixtures/supervisor-lock-contender.mjs', import.meta.url));
  for (let round = 0; round < 5; round += 1) {
    const go = join(dir, `go-${round}`);
    const children = Array.from({ length: 8 }, () => fork(contender, [dir, go], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
    const outcomes = children.map((child) => new Promise((resolve) => child.once('message', resolve)));
    await Promise.all(children.map((child) => new Promise((resolve) => child.once('spawn', resolve))));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(go, '');
    const results = await Promise.all(outcomes);
    assert.equal(results.filter((result) => result === 'acquired').length, 1, `round ${round}: ${results.join(',')}`);
    assert(results.every((result) => result === 'acquired' || result === 'refused'), results.join(','));
    // Every contender exits, so the next round reclaims a dead holder again.
    await Promise.all(children.map((child) => new Promise((resolve) => { child.once('exit', resolve); child.send('exit'); })));
    assert.equal(readdirSync(dir).filter((name) => name.startsWith('supervisor.lock.')).length, 1);
    rmSync(go);
  }
});

test('process inspection treats missing incarnation metadata as unknown, never as absent', () => {
  const STAT = '4242 (node) S 1 4242 4242 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 11 0 987654 1 1';
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const alive = () => true;
  const gone = () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };
  const files = (map) => (path) => map[path] === undefined ? enoent() : map[path];
  const base = { platform: 'linux', kill: alive };

  assert.deepEqual(inspectProcess(4242, { ...base, readFile: files({ '/proc/4242/stat': STAT, '/proc/sys/kernel/random/boot_id': 'boot-a\n' }) }),
    { pid: 4242, boot_id: 'boot-a', start_id: '987654' });
  // boot_id unavailable while the PID and its stat are present: alive, unknown incarnation.
  assert.deepEqual(inspectProcess(4242, { ...base, readFile: files({ '/proc/4242/stat': STAT }) }), { pid: 4242 });
  assert.deepEqual(inspectProcess(4242, { ...base, readFile: files({ '/proc/4242/stat': STAT, '/proc/sys/kernel/random/boot_id': '\n' }) }), { pid: 4242 });
  // procfs unavailable entirely while the signal probe still finds the PID.
  assert.deepEqual(inspectProcess(4242, { ...base, readFile: enoent }), { pid: 4242 });
  assert.deepEqual(inspectProcess(4242, { ...base, readFile: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } }), { pid: 4242 });
  assert.deepEqual(inspectProcess(4242, { ...base, readFile: files({ '/proc/4242/stat': '4242 (node) S 1' }) }), { pid: 4242 });
  assert.deepEqual(inspectProcess(4242, { ...base, kill: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }, readFile: enoent }), { pid: 4242 });
  assert.deepEqual(inspectProcess(4242, { platform: 'darwin', kill: alive, readFile: () => assert.fail('no procfs off Linux') }), { pid: 4242 });
  // Positive evidence only.
  assert.equal(inspectProcess(4242, { ...base, kill: gone, readFile: files({ '/proc/4242/stat': STAT }) }), undefined);
  assert.equal(inspectProcess(4242, { ...base, readFile: files({ '/proc/4242/stat': STAT.replace(') S ', ') Z ') }) }), undefined);
  let probes = 0;
  assert.equal(inspectProcess(4242, { platform: 'linux', kill: () => { if (++probes > 1) gone(); }, readFile: enoent }), undefined,
    'a PID that vanished between the probe and procfs is gone');
});
