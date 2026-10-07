// SDK-backed daemon runtime. The SDK-free daemon-worker bootstrap imports this
// only after installing its IPC shutdown/disconnect handlers.

import * as nodeFs from 'node:fs';
import { flockSync } from 'fs-ext';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureRuntimeState,
  loadConfig,
  type CoworkConfig,
  type RuntimeState,
} from './config.ts';
export { loadConfig } from './config.ts';
import { createOursHost, type OursRuntimeClientFactory } from './ours-runtime.ts';
import { PacketRegistry } from './packets.ts';
import { RoomService } from './service.ts';
import { CoworkStore } from './storage.ts';
import { createPrivateServiceRoutes, createServiceRoutes, RpcDispatcher, TransportServer } from './transports.ts';
import { createStaticWebHandler, loadWebAssets } from './web.ts';

const FILE_MODE = 0o600;
const NO_FOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;

export interface DaemonLock {
  release(): void;
}

export class DaemonBootCancelledError extends Error {
  constructor() {
    super('cowork daemon boot cancelled by shutdown');
    this.name = 'DaemonBootCancelledError';
  }
}

export interface LockOptions {
  fs?: typeof nodeFs;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => ProcessIdentity | undefined;
}

export interface DaemonHostShutdownResult {
  requiresProcessExit: boolean;
}

export interface DaemonHost {
  boot(): Promise<void>;
  close(): void;
  shutdown?(): Promise<DaemonHostShutdownResult>;
}

export interface DaemonStore {
  list(): Promise<Array<{ room_id: string; state: string }>>;
}

export interface DaemonRegistry {
  unhostAll(): Promise<void>;
  unhost?(roomId: string): Promise<void>;
}

export interface DaemonService {
  recoverPacket(roomId: string): Promise<unknown>;
  resumeLifecycleRequest?(roomId: string): Promise<boolean>;
  reconcileRoom(roomId: string): Promise<unknown>;
  closeRoom(roomId: string): Promise<unknown>;
  resumePending(roomId: string): Promise<void>;
  notifyRoom?(roomId: string, event?: string): Promise<void>;
  beginShutdown(): void;
  drain(): Promise<void>;
}

export interface DaemonTransports {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type DaemonStage = 'post-lock' | 'during-host-init' | 'post-host' | 'pre-pid' | 'ready';

export interface DaemonShutdownResult { requiresProcessExit: boolean }

/** Packet notifications which may add durable room work. */
export function isIntakeNotification(event: string): boolean {
  return event === 'message_received' || event === 'file_received'
    || event === 'contact_accepted' || event === 'contact_added' || event === 'contact_removed';
}

export class DaemonShutdownError extends AggregateError {
  readonly requiresProcessExit: boolean;

  constructor(errors: Iterable<unknown>, requiresProcessExit: boolean) {
    super(errors, 'cowork daemon shutdown encountered errors');
    this.name = 'DaemonShutdownError';
    this.requiresProcessExit = requiresProcessExit;
  }
}

export interface CoworkDaemonOptions {
  config: CoworkConfig;
  prepare?: (config: CoworkConfig) => RuntimeState | Pick<RuntimeState, 'socketPath'>;
  lock?: (stateDir: string) => DaemonLock;
  host?: DaemonHost;
  store?: DaemonStore;
  registry?: DaemonRegistry;
  service?: DaemonService;
  transports?: DaemonTransports;
  writePid?: (stateDir: string) => void;
  removePid?: (stateDir: string) => void;
  log?: (...parts: unknown[]) => void;
  onStage?: (stage: DaemonStage) => void;
  control?: DaemonControl;
}

export interface DaemonControl {
  session: string;
  requestSupervisorShutdown(): Promise<boolean>;
}

export function createDaemonControlRoutes(control: DaemonControl) {
  if (!/^[0-9a-f]{32}$/.test(control.session)) throw new TypeError('invalid daemon control session');
  const requireExact = (params: Record<string, unknown>, keys: string[]): void => {
    if (Object.keys(params).length !== keys.length || keys.some((key) => !Object.hasOwn(params, key))) {
      throw new TypeError('invalid daemon control parameters');
    }
  };
  return {
    'daemon.status': {
      auth: true as const,
      run(params: Record<string, unknown>) {
        requireExact(params, []);
        return {
          version: 1,
          protocol: 'cowork-supervisor-control',
          running: true,
          session: control.session,
        };
      },
    },
    'daemon.shutdown': {
      auth: true as const,
      async run(params: Record<string, unknown>) {
        requireExact(params, ['session']);
        if (params.session !== control.session) throw new TypeError('daemon control session changed');
        if (!await control.requestSupervisorShutdown()) throw new Error('supervisor IPC rejected shutdown request');
        return { accepted: true, session: control.session };
      },
    },
  };
}

export class CoworkDaemon {
  private readonly options: CoworkDaemonOptions;
  private host?: DaemonHost;
  private store?: DaemonStore;
  private registry?: DaemonRegistry;
  private service?: DaemonService;
  private transports?: DaemonTransports;
  private lockHandle?: DaemonLock;
  private bootWork?: Promise<void>;
  private shutdownWork?: Promise<DaemonShutdownResult>;
  private hostBooted = false;
  private hostStartAttempted = false;
  private transportsStarted = false;
  private transportStartAttempted = false;
  private pidWritten = false;
  private ready = false;
  private stopping = false;
  private cleanupComplete = false;
  private cleanupWork?: Promise<DaemonShutdownResult>;
  private cancelled = false;
  private readonly queuedNotifications = new Set<string>();
  private readonly notificationWork = new Set<Promise<void>>();

  constructor(options: CoworkDaemonOptions) {
    this.options = options;
  }

  boot(): Promise<void> {
    if (this.shutdownWork) return Promise.reject(new Error('cowork daemon is already shutting down'));
    this.bootWork ??= this.bootUnlocked();
    return this.bootWork;
  }

  private async bootUnlocked(): Promise<void> {
    const config = this.options.config;
    const runtime = (this.options.prepare ?? ensureRuntimeState)(config);
    this.lockHandle = (this.options.lock ?? ((stateDir) => acquireDaemonLock(stateDir)))(config.stateDir);
    this.options.onStage?.('post-lock');
    this.checkpoint();
    try {
      this.host = this.options.host ?? createOursHost(config, this.options.log);
      this.store = this.options.store ?? new CoworkStore(config.stateDir);

      // The closure deliberately queues notifications until every recovery
      // phase is complete. Restored identities may receive traffic as soon as
      // they are exposed, but unread external history remains durable.
      let serviceRef: DaemonService | undefined = this.options.service;
      this.registry = this.options.registry ?? new PacketRegistry(
        this.host as unknown as OursRuntimeClientFactory,
        config.stateDir,
        {
          log: this.options.log,
          onNotify: (roomId, event) => {
            if (isIntakeNotification(event)) {
              this.handleNotification(roomId, event, serviceRef);
            }
          },
        },
      );
      this.service = this.options.service ?? new RoomService(
        this.store as CoworkStore,
        this.registry as PacketRegistry,
        { consumerCommands: config.consumer_commands },
      );
      serviceRef = this.service;

      this.hostStartAttempted = true;
      this.options.onStage?.('during-host-init');
      await this.host.boot();
      this.hostBooted = true;
      this.options.onStage?.('post-host');
      this.checkpoint();

      const rooms = await this.store.list();
      this.checkpoint();
      const recoverable = rooms.filter((room) => room.state !== 'closed');
      const healthy = new Set(recoverable.map((room) => room.room_id));
      const recoverPhase = async (roomId: string, phase: string, work: () => Promise<unknown>): Promise<void> => {
        if (!healthy.has(roomId)) return;
        try {
          await work();
          this.checkpoint();
        } catch (error) {
          healthy.delete(roomId);
          const unhost = this.registry?.unhost;
          if (unhost) {
            await unhost.call(this.registry, roomId).catch((unhostError) => {
              this.options.log?.(JSON.stringify({
                event: 'startup_room_unhost_failed', room_id: roomId,
                error: unhostError instanceof Error ? unhostError.message : String(unhostError),
              }));
            });
          }
          this.options.log?.(JSON.stringify({
            event: 'startup_room_recovery_failed',
            room_id: roomId,
            phase,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      };
      // All packet CIDs are restored (or the exact packet-pending sentinel is
      // completed) before any metadata reconciliation can create intents.
      for (const room of recoverable) {
        await recoverPhase(room.room_id, 'restore', () => this.service!.recoverPacket(room.room_id));
      }
      // Pending close/delete requests survive a crash after acknowledgement.
      // Closed rooms need no identity restoration to finish deleting their data.
      for (const room of rooms) {
        if (room.state !== 'closed' && !healthy.has(room.room_id)) continue;
        if (await this.service!.resumeLifecycleRequest?.(room.room_id)) healthy.delete(room.room_id);
      }
      for (const room of recoverable.filter((candidate) => candidate.state !== 'closing')) {
        await recoverPhase(room.room_id, 'reconcile', () => this.service!.reconcileRoom(room.room_id));
      }
      // Closing is forward-only and precedes every inbox/send recovery.
      for (const room of recoverable.filter((candidate) => candidate.state === 'closing')) {
        await recoverPhase(room.room_id, 'close', () => this.service!.closeRoom(room.room_id));
      }
      // resumePending itself performs inbox snapshot -> complete all
      // intents -> atomic consume -> pending sends, in that exact order.
      for (const room of recoverable.filter((candidate) => candidate.state !== 'closing')) {
        await recoverPhase(room.room_id, 'fanout', () => this.service!.resumePending(room.room_id));
      }

      const realService = this.service as RoomService;
      const serviceRoutes = createServiceRoutes(realService);
      const unixRoutes = this.options.control
        ? { ...serviceRoutes, ...createPrivateServiceRoutes(realService), ...createDaemonControlRoutes(this.options.control) }
        : { ...serviceRoutes, ...createPrivateServiceRoutes(realService) };
      const unixDispatcher = new RpcDispatcher(unixRoutes);
      const restDispatcher = new RpcDispatcher(serviceRoutes);
      const staticHandler = createStaticWebHandler(loadWebAssets(
        fileURLToPath(new URL('./web/', import.meta.url)),
      ));
      this.transports = this.options.transports ?? new TransportServer({
        socketPath: runtime.socketPath,
        rest: config.rest,
        unixDispatcher,
        restDispatcher,
        staticHandler,
        log: this.options.log,
      });
      this.transportStartAttempted = true;
      await this.transports.start();
      this.transportsStarted = true;
      this.checkpoint();

      this.ready = true;
      await this.flushQueuedNotifications();
      this.checkpoint();
      this.options.onStage?.('pre-pid');
      (this.options.writePid ?? writeDaemonPid)(config.stateDir);
      this.pidWritten = true;
      this.options.onStage?.('ready');
    } catch (error) {
      this.cancelled = true;
      let cleanupError: unknown;
      try { await this.cleanupOwned(); } catch (cleanup) { cleanupError = cleanup; }
      if (cleanupError !== undefined) {
        throw new AggregateError([error, cleanupError], 'cowork daemon boot and cleanup failed', { cause: error });
      }
      throw error;
    }
  }

  shutdown(): Promise<DaemonShutdownResult> {
    this.cancelled = true;
    this.shutdownWork ??= this.shutdownCoordinated();
    return this.shutdownWork;
  }

  private async shutdownCoordinated(): Promise<DaemonShutdownResult> {
    if (this.bootWork) await Promise.allSettled([this.bootWork]);
    return this.cleanupOwned();
  }

  private cleanupOwned(): Promise<DaemonShutdownResult> {
    this.cleanupWork ??= this.cleanupUnlocked();
    return this.cleanupWork;
  }

  private async cleanupUnlocked(): Promise<DaemonShutdownResult> {
    this.stopping = true;
    this.ready = false;
    const errors: unknown[] = [];
    let requiresProcessExit = false;
    try { this.service?.beginShutdown(); } catch (error) { errors.push(error); }
    if (this.transportStartAttempted || this.transportsStarted || this.transports) {
      try { await this.transports?.stop(); } catch (error) { errors.push(error); }
      this.transportsStarted = false;
      this.transportStartAttempted = false;
    }
    try {
      await Promise.allSettled([...this.notificationWork]);
      await this.service?.drain();
    } catch (error) { errors.push(error); }
    try {
      if (this.lockHandle || this.pidWritten || this.hostStartAttempted) {
        (this.options.removePid ?? removeDaemonPid)(this.options.config.stateDir);
      }
      this.pidWritten = false;
    } catch (error) { errors.push(error); }
    try { await this.registry?.unhostAll(); } catch (error) { errors.push(error); }
    if (this.hostStartAttempted || this.hostBooted) {
      try {
        if (this.host?.shutdown) {
          const result = await this.host.shutdown();
          requiresProcessExit ||= result?.requiresProcessExit === true;
        }
        else this.host?.close();
      } catch (error) {
        requiresProcessExit ||= requiresExitFrom(error);
        errors.push(error);
      }
    }
    this.hostBooted = false;
    this.hostStartAttempted = false;
    try { this.lockHandle?.release(); } catch (error) { errors.push(error); }
    this.lockHandle = undefined;
    this.cleanupComplete = true;
    if (errors.length > 0) throw new DaemonShutdownError(errors, requiresProcessExit);
    return { requiresProcessExit };
  }

  private checkpoint(): void {
    if (this.cancelled) throw new DaemonBootCancelledError();
  }

  private handleNotification(roomId: string, event = 'message_received', service = this.service): void {
    if (this.stopping) return;
    if (!this.ready || !service?.notifyRoom) {
      this.queuedNotifications.add(roomId);
      return;
    }
    const work = service.notifyRoom(roomId, event);
    this.notificationWork.add(work);
    void work.then(
      () => this.notificationWork.delete(work),
      (error) => {
        this.notificationWork.delete(work);
        this.options.log?.(`room notification failed for ${roomId}:`, error);
      },
    );
  }

  private async flushQueuedNotifications(): Promise<void> {
    while (this.queuedNotifications.size > 0 && !this.stopping) {
      const rooms = [...this.queuedNotifications];
      this.queuedNotifications.clear();
      for (const roomId of rooms) this.handleNotification(roomId);
      await Promise.allSettled([...this.notificationWork]);
    }
  }

}

export interface ProcessIdentity {
  version: 1;
  bootId: string;
  pidNamespace: string;
  startTime: string;
}

interface ProcessOwner {
  pid: number;
  identity?: ProcessIdentity;
}

/** Acquire an exclusive owner file, replacing it only after proving its owner stale. */
export function acquireDaemonLock(stateDir: string, options: LockOptions = {}): DaemonLock {
  const fs = options.fs ?? nodeFs;
  // This inode is permanent. Unlinking it would let contenders lock different
  // inodes and would destroy the OS lifetime guarantee during stale recovery.
  const path = join(stateDir, 'daemon.owner');
  const fd = fs.openSync(path, nodeFs.constants.O_CREAT | nodeFs.constants.O_RDWR | NO_FOLLOW, FILE_MODE);
  try {
    const opened = fs.fstatSync(fd);
    validateOwnerFile(opened, 'daemon lifetime lock');
    const current = fs.lstatSync(path);
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('daemon lifetime lock changed while opening');
    try { flockSync(fd, 'exnb'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN' || (error as NodeJS.ErrnoException).code === 'EWOULDBLOCK') {
        throw new Error('cowork daemon is already running (state ownership is locked)');
      }
      throw error; // Unsupported filesystems/platforms fail closed.
    }
    fsyncDirectory(fs, stateDir);
    const bookkeeping = acquireBookkeepingLock(stateDir, options);
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        try { bookkeeping.release(); } finally { fs.closeSync(fd); }
      },
    };
  } catch (error) {
    fs.closeSync(fd); // Closing the descriptor releases flock even after errors.
    throw error;
  }
}

function acquireBookkeepingLock(stateDir: string, options: LockOptions): DaemonLock {
  const fs = options.fs ?? nodeFs;
  const pid = options.pid ?? process.pid;
  const alive = options.isProcessAlive ?? isProcessAlive;
  const identity = options.processIdentity ?? readProcessIdentity;
  const ownerRecord = { pid, identity: identity(pid) };
  const path = join(stateDir, 'daemon.lock');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd: number | undefined;
    let created = false;
    try {
      fd = fs.openSync(path, nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW, FILE_MODE);
      created = true;
      fs.fchmodSync(fd, FILE_MODE);
      writeAll(fs, fd, encodeOwner(ownerRecord));
      fs.fsyncSync(fd);
      const owned = fs.fstatSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fsyncDirectory(fs, stateDir);
      const pidPath = join(stateDir, 'daemon.pid');
      if (lstatIfPresent(fs, pidPath)) {
        const pidOwner = readSecureOwner(fs, pidPath, 'daemon PID');
        if (isOwnerAlive(pidOwner, alive, identity)) {
          fs.unlinkSync(path);
          fsyncDirectory(fs, stateDir);
          throw new Error(`cowork daemon is already running with PID ${pidOwner.pid}`);
        }
      }
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          const current = lstatIfPresent(fs, path);
          if (!current || current.dev !== owned.dev || current.ino !== owned.ino) return;
          const content = readSecureOwner(fs, path, 'daemon lock');
          if (!sameOwner(content, ownerRecord)) return;
          fs.unlinkSync(path);
          fsyncDirectory(fs, stateDir);
        },
      };
    } catch (error) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* original failure wins */ }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (created) {
          try { fs.unlinkSync(path); fsyncDirectory(fs, stateDir); } catch { /* original failure wins */ }
        }
        throw error;
      }
      const observed = fs.lstatSync(path);
      const owner = readSecureOwner(fs, path, 'daemon lock');
      if (isOwnerAlive(owner, alive, identity)) throw new Error(`cowork daemon is already running with PID ${owner.pid}`);
      const current = fs.lstatSync(path);
      if (current.dev !== observed.dev || current.ino !== observed.ino) continue;
      fs.unlinkSync(path);
      fsyncDirectory(fs, stateDir);
    }
  }
  throw new Error('daemon lock changed repeatedly while acquiring it');
}

export function writeDaemonPid(stateDir: string, fs: typeof nodeFs = nodeFs, pid = process.pid): void {
  const ownerRecord = { pid, identity: readProcessIdentity(pid) };
  const path = join(stateDir, 'daemon.pid');
  const existing = lstatIfPresent(fs, path);
  if (existing) {
    const owner = readSecureOwner(fs, path, 'daemon PID');
    if (isOwnerAlive(owner) && !sameOwner(owner, ownerRecord)) throw new Error(`cowork daemon PID file belongs to live PID ${owner.pid}`);
    const current = fs.lstatSync(path);
    if (current.dev !== existing.dev || current.ino !== existing.ino) throw new Error('daemon PID file changed during stale-owner check');
    fs.unlinkSync(path);
  }
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW, FILE_MODE);
    created = true;
    fs.fchmodSync(fd, FILE_MODE);
    writeAll(fs, fd, encodeOwner(ownerRecord));
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* original failure wins */ }
      fd = undefined;
    }
    if (created) try { fs.unlinkSync(path); } catch { /* original failure wins */ }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fsyncDirectory(fs, stateDir);
}

export function removeDaemonPid(stateDir: string, fs: typeof nodeFs = nodeFs, pid = process.pid): void {
  const path = join(stateDir, 'daemon.pid');
  const observed = lstatIfPresent(fs, path);
  if (!observed) return;
  const owner = readSecureOwner(fs, path, 'daemon PID');
  if (!sameOwner(owner, { pid, identity: readProcessIdentity(pid) })) return;
  const current = fs.lstatSync(path);
  if (current.dev !== observed.dev || current.ino !== observed.ino) return;
  fs.unlinkSync(path);
  fsyncDirectory(fs, stateDir);
}

function validateOwnerFile(stat: nodeFs.Stats, label: string): void {
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE) {
    throw new Error(`${label} must be a 0600 single-link regular file`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

function readSecureOwner(fs: typeof nodeFs, path: string, label: string): ProcessOwner {
  const stat = fs.lstatSync(path);
  validateOwnerFile(stat, label);
  let fd: number | undefined;
  let text: string;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(path);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino
      || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`${label} changed while opening`);
    }
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const lines = text.split('\n');
  if (!/^[1-9][0-9]*$/.test(lines[0]) || lines.at(-1) !== '' || (lines.length !== 2 && lines.length !== 3)) {
    throw new Error(`${label} contains an invalid ownership record`);
  }
  const pid = Number(lines[0]);
  if (!Number.isSafeInteger(pid)) throw new Error(`${label} contains an invalid PID`);
  if (lines.length === 2) return { pid }; // Legacy ownership is deliberately conservative.
  let identity: unknown;
  try { identity = JSON.parse(lines[1]); } catch { throw new Error(`${label} contains an invalid process identity`); }
  if (!validIdentity(identity)) throw new Error(`${label} contains an invalid process identity`);
  return { pid, identity };
}

function validIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as ProcessIdentity;
  return Object.keys(value).length === 4 && identity.version === 1
    && typeof identity.bootId === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(identity.bootId)
    && typeof identity.pidNamespace === 'string' && /^pid:\[[0-9]+\]$/.test(identity.pidNamespace)
    && typeof identity.startTime === 'string' && /^[0-9]+$/.test(identity.startTime);
}

function encodeOwner(owner: ProcessOwner): Buffer {
  return Buffer.from(`${owner.pid}\n${owner.identity ? `${JSON.stringify(owner.identity)}\n` : ''}`, 'utf8');
}

function sameOwner(left: ProcessOwner, right: ProcessOwner): boolean {
  return left.pid === right.pid && ((!left.identity && !right.identity)
    || (!!left.identity && !!right.identity && left.identity.version === right.identity.version
      && left.identity.bootId === right.identity.bootId && left.identity.pidNamespace === right.identity.pidNamespace
      && left.identity.startTime === right.identity.startTime));
}

function isOwnerAlive(owner: ProcessOwner, alive = isProcessAlive, identity = readProcessIdentity): boolean {
  if (!alive(owner.pid)) return false;
  if (!owner.identity) return true;
  try {
    const current = identity(owner.pid);
    // Unknown/unavailable identity is not proof of death.
    return current === undefined || sameOwner(owner, { pid: owner.pid, identity: current });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return alive(owner.pid);
    return true;
  }
}

/** Linux identity survives PID reuse and changes across host/container lifetimes. */
function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (process.platform !== 'linux') return undefined;
  const bootId = nodeFs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const startTime = (): string => {
    const stat = nodeFs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) may itself contain spaces and closing parentheses.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  };
  const before = startTime();
  const pidNamespace = nodeFs.readlinkSync(`/proc/${pid}/ns/pid`);
  const after = startTime();
  const identity = { version: 1 as const, bootId, pidNamespace, startTime: after };
  if (before !== after || !validIdentity(identity)) throw new Error(`cannot establish process identity for PID ${pid}`);
  return identity;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeAll(fs: typeof nodeFs, fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) throw new Error('write made no progress');
    offset += written;
  }
}

function fsyncDirectory(fs: typeof nodeFs, path: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function lstatIfPresent(fs: typeof nodeFs, path: string): nodeFs.Stats | undefined {
  try { return fs.lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function requiresExitFrom(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'requiresProcessExit' in error
    && (error as { requiresProcessExit?: unknown }).requiresProcessExit === true;
}
