// SDK-backed daemon runtime. The SDK-free daemon-worker bootstrap imports this
// only after installing its IPC shutdown/disconnect handlers.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdaptHost } from './adapt.ts';
import {
  ensureRuntimeState,
  loadConfig,
  type CoworkConfig,
  type RuntimeState,
} from './config.ts';
export { loadConfig } from './config.ts';
import { PacketRegistry } from './packets.ts';
import { RoomService } from './service.ts';
import { CoworkStore } from './storage.ts';
import { createServiceRoutes, RpcDispatcher, TransportServer } from './transports.ts';
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
}

export interface DaemonService {
  recoverPacket(roomId: string): Promise<unknown>;
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
      this.host = this.options.host ?? new AdaptHost(config.brokerUrl, this.options.log);
      this.store = this.options.store ?? new CoworkStore(config.stateDir);

      // The closure deliberately queues notifications until every recovery
      // phase is complete. Restored packets may receive traffic as soon as
      // they are exposed, but packet inbox state itself remains durable.
      let serviceRef: DaemonService | undefined = this.options.service;
      this.registry = this.options.registry ?? new PacketRegistry(
        this.host as AdaptHost,
        config.stateDir,
        {
          log: this.options.log,
          onNotify: (roomId, event) => {
            if (event === 'message_received' || event === 'contact_accepted') {
              this.handleNotification(roomId, event, serviceRef);
            }
          },
        },
      );
      this.service = this.options.service ?? new RoomService(
        this.store as CoworkStore,
        this.registry as PacketRegistry,
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
      // All packet CIDs are restored (or the exact packet-pending sentinel is
      // completed) before any metadata reconciliation can create intents.
      for (const room of recoverable) {
        await this.service.recoverPacket(room.room_id);
        this.checkpoint();
      }
      for (const room of recoverable.filter((candidate) => candidate.state !== 'closing')) {
        await this.service.reconcileRoom(room.room_id);
        this.checkpoint();
      }
      // Closing is forward-only and precedes every inbox/send recovery.
      for (const room of recoverable.filter((candidate) => candidate.state === 'closing')) {
        await this.service.closeRoom(room.room_id);
        this.checkpoint();
      }
      // Task 6 resumePending itself performs inbox snapshot -> complete all
      // intents -> atomic consume -> pending sends, in that exact order.
      for (const room of recoverable.filter((candidate) => candidate.state !== 'closing')) {
        await this.service.resumePending(room.room_id);
        this.checkpoint();
      }

      const realService = this.service as RoomService;
      const serviceRoutes = createServiceRoutes(realService);
      const unixRoutes = this.options.control
        ? { ...serviceRoutes, ...createDaemonControlRoutes(this.options.control) }
        : serviceRoutes;
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

/** Acquire an exclusive owner file, replacing it only after proving its PID stale. */
export function acquireDaemonLock(stateDir: string, options: LockOptions = {}): DaemonLock {
  const fs = options.fs ?? nodeFs;
  const pid = options.pid ?? process.pid;
  const alive = options.isProcessAlive ?? isProcessAlive;
  const path = join(stateDir, 'daemon.lock');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd: number | undefined;
    let created = false;
    try {
      fd = fs.openSync(path, nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW, FILE_MODE);
      created = true;
      fs.fchmodSync(fd, FILE_MODE);
      writeAll(fs, fd, Buffer.from(`${pid}\n`, 'ascii'));
      fs.fsyncSync(fd);
      const owned = fs.fstatSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fsyncDirectory(fs, stateDir);
      const pidPath = join(stateDir, 'daemon.pid');
      if (lstatIfPresent(fs, pidPath)) {
        const pidOwner = readSecurePid(fs, pidPath, 'daemon PID');
        if (alive(pidOwner)) {
          fs.unlinkSync(path);
          fsyncDirectory(fs, stateDir);
          throw new Error(`cowork daemon is already running with PID ${pidOwner}`);
        }
      }
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          const current = lstatIfPresent(fs, path);
          if (!current || current.dev !== owned.dev || current.ino !== owned.ino) return;
          const content = readSecurePid(fs, path, 'daemon lock');
          if (content !== pid) return;
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
      const owner = readSecurePid(fs, path, 'daemon lock');
      if (alive(owner)) throw new Error(`cowork daemon is already running with PID ${owner}`);
      const current = fs.lstatSync(path);
      if (current.dev !== observed.dev || current.ino !== observed.ino) continue;
      fs.unlinkSync(path);
      fsyncDirectory(fs, stateDir);
    }
  }
  throw new Error('daemon lock changed repeatedly while acquiring it');
}

export function writeDaemonPid(stateDir: string, fs: typeof nodeFs = nodeFs, pid = process.pid): void {
  const path = join(stateDir, 'daemon.pid');
  const existing = lstatIfPresent(fs, path);
  if (existing) {
    const owner = readSecurePid(fs, path, 'daemon PID');
    if (isProcessAlive(owner) && owner !== pid) throw new Error(`cowork daemon PID file belongs to live PID ${owner}`);
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
    writeAll(fs, fd, Buffer.from(`${pid}\n`, 'ascii'));
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
  const owner = readSecurePid(fs, path, 'daemon PID');
  if (owner !== pid) return;
  const current = fs.lstatSync(path);
  if (current.dev !== observed.dev || current.ino !== observed.ino) return;
  fs.unlinkSync(path);
  fsyncDirectory(fs, stateDir);
}

function readSecurePid(fs: typeof nodeFs, path: string, label: string): number {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE) {
    throw new Error(`${label} must be a 0600 single-link regular file`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
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
  if (!/^[1-9][0-9]*\n$/.test(text)) throw new Error(`${label} contains an invalid PID`);
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid)) throw new Error(`${label} contains an invalid PID`);
  return pid;
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
