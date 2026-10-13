import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';

const FILE_MODE = 0o600;
const NO_FOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;
const LOCK_NAME = 'supervisor.lock';
const TEMPORARY_NAME = /^\.supervisor\.lock-[0-9a-f]{32}\.tmp$/;
const GENERATION_NAME = /^supervisor\.lock\.([1-9][0-9]{0,14})$/;

export interface SupervisorLock {
  release(): void;
}

/** OS evidence that distinguishes one process from a later holder of its PID. */
export interface SupervisorIncarnation {
  pid: number;
  boot_id?: string;
  start_id?: string;
}

export interface SupervisorLockOptions {
  fs?: typeof nodeFs;
  pid?: number;
  inspect?: (pid: number) => SupervisorIncarnation | undefined;
}

export class SupervisorAlreadyRunningError extends Error {
  constructor(pid: number) {
    super(`cowork supervisor is already running with PID ${pid}`);
    this.name = 'SupervisorAlreadyRunningError';
  }
}

/**
 * Exclusive for the whole life of one supervisor: from before it replays
 * terminal owner events until its own terminal delivery has finished.
 *
 * A supervisor may still retire the room owners it holds after its worker is
 * gone. No replacement may be admitted during that interval, including the boot
 * window in which rooms are already attached but `daemon.pid` does not exist.
 *
 * The lock is a chain of generations, `supervisor.lock.<n>`. A generation is
 * only ever created by an exclusive hard link and never unlinked or reused by a
 * contender: a dead or released generation is superseded by creating the next
 * one, which exactly one contender can do. Release leaves a tombstone so the
 * numbering never restarts.
 */
export function acquireSupervisorLock(stateDir: string, options: SupervisorLockOptions = {}): SupervisorLock {
  const fs = options.fs ?? nodeFs;
  const inspect = options.inspect ?? inspectProcess;
  const self = inspect(options.pid ?? process.pid) ?? { pid: options.pid ?? process.pid };
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const top = generations(fs, stateDir).at(-1);
    if (top !== undefined) {
      const path = generationPath(stateDir, top);
      let holder: ReturnType<typeof readHolder>;
      try {
        dropPublishedAliases(fs, stateDir, fs.lstatSync(path));
        holder = readHolder(fs, path);
      } catch (error) {
        // Superseded and removed since the listing; look again.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (holder.released !== true && holderAlive(holder, inspect)) throw new SupervisorAlreadyRunningError(holder.pid);
    }
    const generation = (top ?? 0) + 1;
    const path = generationPath(stateDir, generation);
    if (!publish(fs, stateDir, path, self)) continue;
    // A stale listing can recreate a generation that a later one already
    // superseded and removed. Whoever sees a higher generation has lost.
    const present = generations(fs, stateDir);
    if (present.at(-1) !== generation) {
      unlinkIfPresent(fs, path);
      continue;
    }
    for (const superseded of present) {
      if (superseded < generation) unlinkIfPresent(fs, generationPath(stateDir, superseded));
    }
    fsyncDirectory(fs, stateDir);
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        if (!lstatIfPresent(fs, path)) return;
        const holder = readHolder(fs, path);
        if (holder.released === true || holder.pid !== self.pid
          || holder.boot_id !== self.boot_id || holder.start_id !== self.start_id) return;
        // Atomically replace this generation with its tombstone.
        const temporary = temporaryPath(stateDir);
        writeRecord(fs, temporary, { ...self, released: true });
        fs.renameSync(temporary, path);
        fsyncDirectory(fs, stateDir);
      },
    };
  }
  throw new Error('supervisor lock changed repeatedly while acquiring it');
}

/** Exclusively create one complete generation record; false when it already exists. */
function publish(fs: typeof nodeFs, stateDir: string, path: string, record: SupervisorIncarnation): boolean {
  const temporary = temporaryPath(stateDir);
  writeRecord(fs, temporary, record);
  try {
    fs.linkSync(temporary, path);
  } catch (error) {
    unlinkIfPresent(fs, temporary);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  // A contender validating this generation may already have removed the alias.
  unlinkIfPresent(fs, temporary);
  fsyncDirectory(fs, stateDir);
  return true;
}

function writeRecord(fs: typeof nodeFs, path: string, record: SupervisorIncarnation & { released?: true }): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW, FILE_MODE);
    fs.writeFileSync(fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* original failure wins */ } fd = undefined; }
    unlinkIfPresent(fs, path);
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Existing generation numbers in ascending order. */
function generations(fs: typeof nodeFs, stateDir: string): number[] {
  return fs.readdirSync(stateDir).flatMap((name) => {
    const match = GENERATION_NAME.exec(name);
    const generation = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(generation) ? [generation] : [];
  }).sort((left, right) => left - right);
}

function generationPath(stateDir: string, generation: number): string {
  return join(stateDir, `${LOCK_NAME}.${generation}`);
}

function temporaryPath(stateDir: string): string {
  return join(stateDir, `.${LOCK_NAME}-${randomBytes(16).toString('hex')}.tmp`);
}

function unlinkIfPresent(fs: typeof nodeFs, path: string): void {
  try { fs.unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Dead only on positive evidence: the PID is gone, or the recorded process
 * belonged to an earlier boot or started at a different time than the current
 * holder of that PID. Anything uncertain keeps the lock.
 */
function holderAlive(holder: SupervisorIncarnation, inspect: (pid: number) => SupervisorIncarnation | undefined): boolean {
  let current: SupervisorIncarnation | undefined;
  try { current = inspect(holder.pid); } catch { return true; }
  if (current === undefined) return false;
  if (holder.boot_id === undefined || holder.start_id === undefined
    || current.boot_id === undefined || current.start_id === undefined) return true;
  return holder.boot_id === current.boot_id && holder.start_id === current.start_id;
}

/**
 * A holder that died between publishing the lock and removing its temporary
 * name leaves the lock with a second link. Remove exactly those aliases of the
 * observed lock file so the holder record can be validated as a single link.
 */
function dropPublishedAliases(fs: typeof nodeFs, stateDir: string, lock: nodeFs.Stats): void {
  if (lock.nlink < 2) return;
  for (const name of fs.readdirSync(stateDir)) {
    if (!TEMPORARY_NAME.test(name)) continue;
    const alias = join(stateDir, name);
    const stat = lstatIfPresent(fs, alias);
    if (!stat || !stat.isFile() || stat.dev !== lock.dev || stat.ino !== lock.ino) continue;
    unlinkIfPresent(fs, alias);
  }
  fsyncDirectory(fs, stateDir);
}

export interface ProcessProbe {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: 0) => unknown;
  readFile?: (path: string) => string;
}

/**
 * Undefined only when the PID provably does not exist (or is an unreaped
 * corpse). Missing or unreadable incarnation metadata is uncertainty: the
 * process is reported present without boot/start identity.
 */
export function inspectProcess(pid: number, probe: ProcessProbe = {}): SupervisorIncarnation | undefined {
  const kill = probe.kill ?? ((target, signal) => process.kill(target, signal));
  const readFile = probe.readFile ?? ((path) => nodeFs.readFileSync(path, 'utf8'));
  const exists = (): boolean => {
    try { kill(pid, 0); return true; } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  if (!exists()) return undefined;
  if ((probe.platform ?? process.platform) !== 'linux') return { pid };
  let stat: string;
  try { stat = readFile(`/proc/${pid}/stat`); } catch {
    // Without procfs evidence only the signal probe may declare the PID gone.
    return exists() ? { pid } : undefined;
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
  const start_id = fields[19];
  if (!/^[0-9]+$/.test(start_id ?? '')) return { pid };
  let boot_id: string;
  try { boot_id = readFile('/proc/sys/kernel/random/boot_id').trim(); } catch { return { pid }; }
  if (boot_id.length === 0) return { pid };
  return { pid, boot_id, start_id };
}

function readHolder(fs: typeof nodeFs, path: string): SupervisorIncarnation & { released?: boolean } {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE || stat.size > 1024
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('supervisor lock must be a private 0600 single-link regular file');
  }
  let value: SupervisorIncarnation & { released?: boolean };
  const fd = fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
  try { value = JSON.parse(fs.readFileSync(fd, 'utf8')) as SupervisorIncarnation & { released?: boolean }; }
  catch { throw new Error('supervisor lock contains an invalid holder'); }
  finally { fs.closeSync(fd); }
  if (value === null || typeof value !== 'object' || !Number.isSafeInteger(value.pid) || value.pid < 1
    || (value.boot_id !== undefined && typeof value.boot_id !== 'string')
    || (value.start_id !== undefined && typeof value.start_id !== 'string')
    || (value.released !== undefined && value.released !== true)) {
    throw new Error('supervisor lock contains an invalid holder');
  }
  return value;
}

function fsyncDirectory(fs: typeof nodeFs, path: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
    fs.fsyncSync(fd);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function lstatIfPresent(fs: typeof nodeFs, path: string): nodeFs.Stats | undefined {
  try { return fs.lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
