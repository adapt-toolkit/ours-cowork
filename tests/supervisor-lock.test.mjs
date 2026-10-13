import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireSupervisorLock, SupervisorAlreadyRunningError } from '../src/supervisor-lock.ts';

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
