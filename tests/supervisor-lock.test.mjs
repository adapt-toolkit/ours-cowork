import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireSupervisorLock, inspectProcess, SupervisorAlreadyRunningError } from '../src/supervisor-lock.ts';

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-supervisor-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const lockPath = (dir) => join(dir, 'supervisor.lock');
/** A process table keyed by PID; absent means the PID does not exist. */
const table = (rows) => (pid) => rows[pid] === undefined ? undefined : { pid, ...rows[pid] };

test('a live supervisor excludes every replacement until it releases', (t) => {
  const dir = stateDir(t);
  const inspect = table({ 100: { boot_id: 'boot-a', start_id: '5' }, 200: { boot_id: 'boot-a', start_id: '9' } });
  const first = acquireSupervisorLock(dir, { pid: 100, inspect });
  assert.equal(readFileSync(lockPath(dir), 'utf8'), '{"pid":100,"boot_id":"boot-a","start_id":"5"}\n');
  assert.throws(() => acquireSupervisorLock(dir, { pid: 200, inspect }),
    (error) => error instanceof SupervisorAlreadyRunningError && /PID 100/.test(error.message));
  assert.equal(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid, 100, 'a refused replacement leaves the holder intact');
  first.release();
  first.release();
  assert.equal(existsSync(lockPath(dir)), false);
  acquireSupervisorLock(dir, { pid: 200, inspect }).release();
});

test('only positive evidence of death replaces a recorded supervisor', (t) => {
  const holder = { boot_id: 'boot-a', start_id: '5' };
  for (const [label, rows, replaced] of [
    ['PID gone', { 200: { boot_id: 'boot-a', start_id: '9' } }, true],
    ['PID reused after reboot', { 100: { boot_id: 'boot-b', start_id: '5' }, 200: { boot_id: 'boot-b', start_id: '9' } }, true],
    ['PID reused in the same boot', { 100: { boot_id: 'boot-a', start_id: '77' }, 200: { boot_id: 'boot-a', start_id: '9' } }, true],
    ['same incarnation', { 100: holder, 200: { boot_id: 'boot-a', start_id: '9' } }, false],
    ['PID present without incarnation evidence', { 100: {}, 200: {} }, false],
  ]) {
    const dir = stateDir(t);
    acquireSupervisorLock(dir, { pid: 100, inspect: table({ 100: holder }) });
    const attempt = () => acquireSupervisorLock(dir, { pid: 200, inspect: table(rows) });
    if (replaced) assert.equal(JSON.parse((attempt(), readFileSync(lockPath(dir), 'utf8'))).pid, 200, label);
    else assert.throws(attempt, SupervisorAlreadyRunningError, label);
  }

  // Inspection that fails is uncertainty, never proof.
  const dir = stateDir(t);
  acquireSupervisorLock(dir, { pid: 100, inspect: table({ 100: holder }) });
  assert.throws(() => acquireSupervisorLock(dir, { pid: 200, inspect: (pid) => {
    if (pid === 100) throw new Error('procfs unavailable');
    return { pid };
  } }), SupervisorAlreadyRunningError);
});

test('a stale release cannot remove a successor, and unsafe lock files fail closed', (t) => {
  const dir = stateDir(t);
  const stale = acquireSupervisorLock(dir, { pid: 100, inspect: table({ 100: { boot_id: 'boot-a', start_id: '5' } }) });
  const successor = table({ 200: { boot_id: 'boot-a', start_id: '9' } });
  acquireSupervisorLock(dir, { pid: 200, inspect: successor });
  stale.release();
  assert.equal(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid, 200);

  for (const corrupt of [
    (path) => writeFileSync(path, 'not json\n', { mode: 0o600 }),
    (path) => writeFileSync(path, '{"pid":0}\n', { mode: 0o600 }),
    (path) => chmodSync(path, 0o644),
    (path) => { rmSync(path); writeFileSync(path + '.target', '{"pid":1}\n', { mode: 0o600 }); symlinkSync(path + '.target', path); },
  ]) {
    const unsafe = stateDir(t);
    acquireSupervisorLock(unsafe, { pid: 100, inspect: table({ 100: {} }) });
    corrupt(lockPath(unsafe));
    assert.throws(() => acquireSupervisorLock(unsafe, { pid: 200, inspect: table({ 200: {} }) }),
      (error) => !(error instanceof SupervisorAlreadyRunningError));
    assert.equal(existsSync(lockPath(unsafe)), true, 'an untrusted lock is never removed');
  }
});

test('the real process table recognises this process and a missing PID', (t) => {
  const dir = stateDir(t);
  const lock = acquireSupervisorLock(dir);
  assert.equal(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid, process.pid);
  assert.throws(() => acquireSupervisorLock(dir), SupervisorAlreadyRunningError);
  lock.release();
  writeFileSync(lockPath(dir), '{"pid":4194303,"boot_id":"gone","start_id":"1"}\n', { mode: 0o600 });
  acquireSupervisorLock(dir).release();
});

test('a holder killed between publishing and removing its temporary name is recoverable', (t) => {
  const holder = { boot_id: 'boot-a', start_id: '5' };
  const alias = (dir) => join(dir, `.supervisor.lock-${'ab'.repeat(16)}.tmp`);

  // Durable crash image: the published lock still has its temporary link.
  const dead = stateDir(t);
  acquireSupervisorLock(dead, { pid: 100, inspect: table({ 100: holder }) });
  linkSync(lockPath(dead), alias(dead));
  assert.equal(statSync(lockPath(dead)).nlink, 2);
  acquireSupervisorLock(dead, { pid: 200, inspect: table({ 200: { boot_id: 'boot-b', start_id: '9' } }) });
  assert.equal(JSON.parse(readFileSync(lockPath(dead), 'utf8')).pid, 200);
  assert.equal(statSync(lockPath(dead)).nlink, 1);
  assert.deepEqual(readdirSync(dead), ['supervisor.lock']);

  // The same image with the holder still alive keeps excluding replacements.
  const live = stateDir(t);
  acquireSupervisorLock(live, { pid: 100, inspect: table({ 100: holder }) });
  linkSync(lockPath(live), alias(live));
  assert.throws(() => acquireSupervisorLock(live, { pid: 200, inspect: table({ 100: holder, 200: {} }) }), SupervisorAlreadyRunningError);
  assert.equal(JSON.parse(readFileSync(lockPath(live), 'utf8')).pid, 100);

  // A second link under any other name is not ours to remove: fail closed.
  const foreign = stateDir(t);
  acquireSupervisorLock(foreign, { pid: 100, inspect: table({ 100: holder }) });
  linkSync(lockPath(foreign), join(foreign, 'kept-alias'));
  assert.throws(() => acquireSupervisorLock(foreign, { pid: 200, inspect: table({ 200: {} }) }), /single-link/);
  assert.equal(existsSync(join(foreign, 'kept-alias')), true);

  // An unrelated temporary file is never touched.
  const other = stateDir(t);
  acquireSupervisorLock(other, { pid: 100, inspect: table({ 100: holder }) });
  linkSync(lockPath(other), alias(other));
  const unrelated = join(other, `.supervisor.lock-${'cd'.repeat(16)}.tmp`);
  writeFileSync(unrelated, 'another launch', { mode: 0o600 });
  acquireSupervisorLock(other, { pid: 200, inspect: table({ 200: {} }) });
  assert.equal(readFileSync(unrelated, 'utf8'), 'another launch');
});

test('publication leaves a single link even if the process dies right after the directory sync', (t) => {
  const dir = stateDir(t);
  const fs = { ...nodeFs, fsyncSync(fd) {
    const lock = nodeFs.existsSync(lockPath(dir)) ? nodeFs.statSync(lockPath(dir)) : undefined;
    if (lock) assert.equal(lock.nlink, 1, 'the temporary name is gone before the lock is made durable');
    return nodeFs.fsyncSync(fd);
  } };
  acquireSupervisorLock(dir, { pid: 100, inspect: table({ 100: {} }), fs });
  assert.deepEqual(readdirSync(dir), ['supervisor.lock']);
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
