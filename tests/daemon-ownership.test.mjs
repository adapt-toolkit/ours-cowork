import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as realFs from 'node:fs';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { acquireDaemonLock, writeDaemonPid, removeDaemonPid } from '../src/daemon-runtime.ts';

// Fixtures remain inside the task checkout, including independently spawned contenders.
function fixture(t) {
  const dir = mkdtempSync(join(import.meta.dirname, 'ownership-fixture-'));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const linux = { skip: process.platform !== 'linux' };
function record(pid, identity) { return `${pid}\n${JSON.stringify(identity)}\n`; }
function currentIdentity(dir) {
  writeDaemonPid(dir);
  return JSON.parse(readFileSync(join(dir, 'daemon.pid'), 'utf8').split('\n')[1]);
}

test('Linux rejects a genuine owner and writes both worker and supervisor identities', linux, (t) => {
  const dir = fixture(t);
  const lock = acquireDaemonLock(dir);
  t.after(() => lock.release());
  writeDaemonPid(dir, undefined, process.ppid);
  assert.equal(Number(readFileSync(join(dir, 'daemon.pid'), 'utf8').split('\n')[0]), process.ppid);
  assert.throws(() => acquireDaemonLock(dir), /already running/);
  lock.release();
  assert.throws(() => acquireDaemonLock(dir), /already running/); // live supervisor alone
  assert.equal(existsSync(join(dir, 'daemon.lock')), false);
  removeDaemonPid(dir, undefined, process.ppid);
  assert.equal(existsSync(join(dir, 'daemon.pid')), false);
});

for (const [field, staleValue] of [
  ['bootId', '00000000-0000-0000-0000-000000000000'],
  ['pidNamespace', 'pid:[0]'],
  ['startTime', '0'],
]) {
  test(`Linux recovers reused live PID with stale ${field} in both files`, linux, (t) => {
    const dir = fixture(t);
    const identity = { ...currentIdentity(dir), [field]: staleValue };
    for (const file of ['daemon.lock', 'daemon.pid']) {
      writeFileSync(join(dir, file), record(process.pid, identity), { mode: 0o600 });
    }
    // The PID is this still-running process, so a kill(pid, 0) check alone fails.
    process.kill(process.pid, 0);
    const lock = acquireDaemonLock(dir);
    t.after(() => lock.release());
    writeDaemonPid(dir);
    assert.notEqual(JSON.parse(readFileSync(join(dir, 'daemon.pid'), 'utf8').split('\n')[1])[field], staleValue);
    removeDaemonPid(dir);
    assert.equal(existsSync(join(dir, 'daemon.pid')), false);
    lock.release();
    assert.equal(existsSync(join(dir, 'daemon.lock')), false);
  });
}

test('legacy live PID remains protected and dead legacy PID can be recovered', (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'daemon.lock'), `${process.pid}\n`, { mode: 0o600 });
  assert.throws(() => acquireDaemonLock(dir), /already running/);
  writeFileSync(join(dir, 'daemon.lock'), '2147483647\n', { mode: 0o600 });
  const lock = acquireDaemonLock(dir);
  t.after(() => lock.release());
  lock.release();
  writeFileSync(join(dir, 'daemon.pid'), `${process.pid}\n`, { mode: 0o600 });
  assert.throws(() => acquireDaemonLock(dir), /already running/);
  assert.equal(existsSync(join(dir, 'daemon.lock')), false);
});

test('unreadable process identity, partial records and insecure files fail closed', linux, (t) => {
  const dir = fixture(t);
  const identity = currentIdentity(dir);
  const pidPath = join(dir, 'daemon.pid');
  rmSync(pidPath);
  const path = join(dir, 'daemon.lock');
  writeFileSync(path, record(process.pid, identity), { mode: 0o600 });
  assert.throws(() => acquireDaemonLock(dir, {
    processIdentity(pid) {
      if (pid === 123) return identity;
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }, pid: 123,
  }), /already running/);
  for (const text of ['', `${process.pid}\n{`, `${process.pid}\n{}\n`]) {
    writeFileSync(path, text);
    assert.throws(() => acquireDaemonLock(dir), /invalid ownership|invalid process identity/);
  }
  writeFileSync(path, record(process.pid, identity));
  chmodSync(path, 0o644);
  assert.throws(() => acquireDaemonLock(dir), /0600/);
});

test('release and PID cleanup preserve replaced records even at the same numeric PID', linux, (t) => {
  const dir = fixture(t);
  const lock = acquireDaemonLock(dir);
  t.after(() => lock.release());
  const identity = { ...currentIdentity(dir), startTime: '0' };
  const pidPath = join(dir, 'daemon.pid');
  writeFileSync(pidPath, record(process.pid, identity));
  removeDaemonPid(dir);
  assert.equal(existsSync(pidPath), true);
  const replacement = join(dir, 'replacement');
  writeFileSync(replacement, record(process.pid, identity), { mode: 0o600 });
  renameSync(replacement, join(dir, 'daemon.lock'));
  lock.release();
  assert.equal(existsSync(join(dir, 'daemon.lock')), true);
});

function contender(dir) {
  const source = `
    const { acquireDaemonLock } = await import('./src/daemon-runtime.ts');
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
      try {
        const lock = acquireDaemonLock(${JSON.stringify(dir)});
        process.stdout.write('owned\\n');
        process.stdin.once('data', () => { lock.release(); process.exit(0); });
      } catch (error) {
        process.stdout.write('refused:' + error.message + '\\n');
        process.exit(0);
      }
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: join(import.meta.dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { errors += bytes; });
  return { child, output: () => output, errors: () => errors };
}
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert(Date.now() < deadline, 'ownership contender timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('simultaneous processes retain exactly one owner while replacing a stale identity', linux, async (t) => {
  for (let round = 0; round < 4; round++) {
    const dir = fixture(t);
    const identity = { ...currentIdentity(dir), startTime: '0' };
    rmSync(join(dir, 'daemon.pid'));
    writeFileSync(join(dir, 'daemon.lock'), record(process.pid, identity), { mode: 0o600 });
    const attempts = Array.from({ length: 6 }, () => contender(dir));
    t.after(() => { for (const { child } of attempts) child.kill('SIGKILL'); });
    await until(() => attempts.every((attempt) => attempt.output().includes('ready')));
    for (const { child } of attempts) child.stdin.write('start\n');
    await until(() => attempts.every((attempt) => /owned|refused/.test(attempt.output())));
    assert.equal(attempts.filter((attempt) => attempt.output().includes('owned')).length, 1,
      attempts.map((attempt) => attempt.output() + attempt.errors()).join('\n'));
    for (const attempt of attempts) if (attempt.output().includes('owned')) attempt.child.stdin.write('release\n');
    await until(() => attempts.every(({ child }) => child.exitCode !== null));
  }
});


test('OS lifetime ownership releases on abrupt process death without deleting its inode', linux, async (t) => {
  const dir = fixture(t);
  const owner = contender(dir);
  t.after(() => owner.child.kill('SIGKILL'));
  await until(() => owner.output().includes('ready'));
  owner.child.stdin.write('start\n');
  await until(() => owner.output().includes('owned'));
  assert.throws(() => acquireDaemonLock(dir), /already running/);
  const ownerFile = join(dir, 'daemon.owner');
  const { lstatSync } = await import('node:fs');
  const inode = lstatSync(ownerFile).ino;
  owner.child.kill('SIGKILL');
  await until(() => owner.child.signalCode === 'SIGKILL');
  const recovered = acquireDaemonLock(dir);
  recovered.release();
  assert.equal(lstatSync(ownerFile).ino, inode);
  assert.equal(lstatSync(ownerFile).mode & 0o777, 0o600);
  assert.equal(existsSync(join(dir, 'daemon.lock')), false);
});

test('identity key order cannot turn a genuine live owner into a stale record', linux, (t) => {
  const dir = fixture(t);
  const identity = currentIdentity(dir);
  rmSync(join(dir, 'daemon.pid'));
  const reordered = { startTime: identity.startTime, pidNamespace: identity.pidNamespace, bootId: identity.bootId, version: 1 };
  writeFileSync(join(dir, 'daemon.lock'), record(process.pid, reordered), { mode: 0o600 });
  assert.throws(() => acquireDaemonLock(dir), /already running/);
});


test('lifetime guard rejects insecure, linked and foreign-owned files without leaking ownership', (t) => {
  const dir = fixture(t);
  const path = join(dir, 'daemon.owner');
  writeFileSync(path, '', { mode: 0o644 });
  assert.throws(() => acquireDaemonLock(dir), /0600/);
  chmodSync(path, 0o600);
  if (typeof process.getuid === 'function') {
    const fs = new Proxy(realFs, {
      get(target, key) {
        if (key === 'fstatSync') return (...args) => {
          const stat = target.fstatSync(...args);
          stat.uid = process.getuid() + 1;
          return stat;
        };
        return target[key];
      },
    });
    assert.throws(() => acquireDaemonLock(dir, { fs }), /current user/);
  }
  linkSync(path, join(dir, 'extra-link'));
  assert.throws(() => acquireDaemonLock(dir), /single-link/);
  rmSync(join(dir, 'extra-link'));
  renameSync(path, join(dir, 'target'));
  symlinkSync('target', path);
  assert.throws(() => acquireDaemonLock(dir), /ELOOP|symbolic link/);
  rmSync(path);
  renameSync(join(dir, 'target'), path);
  const lock = acquireDaemonLock(dir);
  lock.release(); // Every failed acquisition above released its descriptor.
});

test('lifetime guard prevents the deterministic check/unlink stale-owner race', linux, (t) => {
  const dir = fixture(t);
  const identity = { ...currentIdentity(dir), startTime: '0' };
  rmSync(join(dir, 'daemon.pid'));
  const path = join(dir, 'daemon.lock');
  writeFileSync(path, record(process.pid, identity), { mode: 0o600 });
  let interleaved = false;
  const fs = new Proxy(realFs, {
    get(target, key) {
      if (key === 'unlinkSync') return (file) => {
        if (!interleaved && file === path) {
          interleaved = true;
          // Exact unsafe baseline schedule: B enters after A's final inode
          // check but before A unlinks. The OS guard now refuses B.
          assert.throws(() => acquireDaemonLock(dir), /ownership is locked/);
        }
        return target.unlinkSync(file);
      };
      return target[key];
    },
  });
  const owner = acquireDaemonLock(dir, { fs });
  assert.equal(interleaved, true);
  owner.release();
});
