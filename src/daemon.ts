#!/usr/bin/env node

import * as nodeFs from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdaptHost } from './adapt.ts';
import {
  ensureRuntimeState,
  loadConfig,
  type CoworkConfig,
  type RuntimeState,
} from './config.ts';
import { PacketRegistry } from './packets.ts';
import { RoomService } from './service.ts';
import { CoworkStore } from './storage.ts';
import { createServiceRoutes, RpcDispatcher, TransportServer } from './transports.ts';

const FILE_MODE = 0o600;
const NO_FOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;

export interface DaemonLock {
  release(): void;
}

export interface LockOptions {
  fs?: typeof nodeFs;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface DaemonHost {
  boot(): Promise<void>;
  close(): void;
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
  notifyRoom?(roomId: string): Promise<void>;
  beginShutdown(): void;
  drain(): Promise<void>;
}

export interface DaemonTransports {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SignalTarget {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
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
  signals?: SignalTarget;
  log?: (...parts: unknown[]) => void;
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
  private shutdownWork?: Promise<void>;
  private hostBooted = false;
  private transportsStarted = false;
  private pidWritten = false;
  private ready = false;
  private stopping = false;
  private cleanupComplete = false;
  private readonly queuedNotifications = new Set<string>();
  private readonly notificationWork = new Set<Promise<void>>();

  private readonly onSignal = (): void => {
    void this.shutdown().catch((error) => this.options.log?.('daemon signal shutdown failed:', error));
  };

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
            if (event === 'message_received') this.handleNotification(roomId, serviceRef);
          },
        },
      );
      this.service = this.options.service ?? new RoomService(
        this.store as CoworkStore,
        this.registry as PacketRegistry,
      );
      serviceRef = this.service;

      await this.host.boot();
      this.hostBooted = true;

      const rooms = await this.store.list();
      const recoverable = rooms.filter((room) => room.state !== 'closed');
      // All packet CIDs are restored (or the exact packet-pending sentinel is
      // completed) before any metadata reconciliation can create intents.
      for (const room of recoverable) await this.service.recoverPacket(room.room_id);
      for (const room of recoverable.filter((candidate) => candidate.state !== 'closing')) {
        await this.service.reconcileRoom(room.room_id);
      }
      // Closing is forward-only and precedes every inbox/send recovery.
      for (const room of recoverable.filter((candidate) => candidate.state === 'closing')) {
        await this.service.closeRoom(room.room_id);
      }
      // Task 6 resumePending itself performs inbox snapshot -> complete all
      // intents -> atomic consume -> pending sends, in that exact order.
      for (const room of recoverable.filter((candidate) => candidate.state !== 'closing')) {
        await this.service.resumePending(room.room_id);
      }

      const realService = this.service as RoomService;
      const dispatcher = new RpcDispatcher(createServiceRoutes(realService));
      this.transports = this.options.transports ?? new TransportServer({
        socketPath: runtime.socketPath,
        rest: config.rest,
        token: (runtime as Partial<RuntimeState>).token,
        dispatcher,
        log: this.options.log,
      });
      await this.transports.start();
      this.transportsStarted = true;

      (this.options.writePid ?? writeDaemonPid)(config.stateDir);
      this.pidWritten = true;
      this.ready = true;
      this.installSignals();
      await this.flushQueuedNotifications();
    } catch (error) {
      await this.rollbackBoot();
      throw error;
    }
  }

  shutdown(): Promise<void> {
    this.shutdownWork ??= this.shutdownUnlocked();
    return this.shutdownWork;
  }

  private async shutdownUnlocked(): Promise<void> {
    if (this.cleanupComplete) return;
    this.stopping = true;
    this.ready = false;
    this.removeSignals();
    const errors: unknown[] = [];
    try { this.service?.beginShutdown(); } catch (error) { errors.push(error); }
    if (this.transportsStarted || this.transports) {
      try { await this.transports?.stop(); } catch (error) { errors.push(error); }
      this.transportsStarted = false;
    }
    try {
      await Promise.allSettled([...this.notificationWork]);
      await this.service?.drain();
    } catch (error) { errors.push(error); }
    try {
      if (this.pidWritten || this.hostBooted) (this.options.removePid ?? removeDaemonPid)(this.options.config.stateDir);
      this.pidWritten = false;
    } catch (error) { errors.push(error); }
    try { await this.registry?.unhostAll(); } catch (error) { errors.push(error); }
    try { if (this.hostBooted) this.host?.close(); } catch (error) { errors.push(error); }
    this.hostBooted = false;
    try { this.lockHandle?.release(); } catch (error) { errors.push(error); }
    this.lockHandle = undefined;
    this.cleanupComplete = true;
    if (errors.length > 0) throw new AggregateError(errors, 'cowork daemon shutdown encountered errors');
  }

  private async rollbackBoot(): Promise<void> {
    this.stopping = true;
    const errors: unknown[] = [];
    if (this.transportsStarted) {
      try { await this.transports?.stop(); } catch (error) { errors.push(error); }
      this.transportsStarted = false;
    }
    try { (this.options.removePid ?? removeDaemonPid)(this.options.config.stateDir); } catch (error) { errors.push(error); }
    this.pidWritten = false;
    try { await this.registry?.unhostAll(); } catch (error) { errors.push(error); }
    try { if (this.hostBooted) this.host?.close(); } catch (error) { errors.push(error); }
    this.hostBooted = false;
    try { this.lockHandle?.release(); } catch (error) { errors.push(error); }
    this.lockHandle = undefined;
    this.cleanupComplete = true;
    if (errors.length > 0) this.options.log?.('partial boot rollback errors:', new AggregateError(errors));
  }

  private handleNotification(roomId: string, service = this.service): void {
    if (this.stopping) return;
    if (!this.ready || !service?.notifyRoom) {
      this.queuedNotifications.add(roomId);
      return;
    }
    const work = service.notifyRoom(roomId);
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

  private installSignals(): void {
    const signals = this.options.signals ?? process;
    signals.on('SIGINT', this.onSignal);
    signals.on('SIGTERM', this.onSignal);
  }

  private removeSignals(): void {
    const signals = this.options.signals ?? process;
    signals.off('SIGINT', this.onSignal);
    signals.off('SIGTERM', this.onSignal);
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

export async function runDaemon(): Promise<void> {
  const daemon = new CoworkDaemon({ config: loadConfig(), log: (...parts) => console.error(...parts) });
  await daemon.boot();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runDaemon().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
