#!/usr/bin/env node

import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRuntimeState, loadConfig } from './config.ts';
import { OwnerCleanup, ownerSelection, type OwnerCleanupOptions, type OwnerContext } from './owner-cleanup.ts';

export const WORKER_STAGES = [
  'pre-lock', 'post-lock', 'during-host-init', 'post-host', 'pre-pid', 'ready',
] as const;
export type WorkerStage = typeof WORKER_STAGES[number];
export const DAEMON_SHUTDOWN_TIMEOUT_MS = 10_000;

interface SupervisorResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface SupervisorChild extends EventEmitter {
  connected?: boolean;
  pid?: number;
  exitCode: number | null;
  send(message: unknown, callback?: (error: Error | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
  disconnect?(): void;
}

export interface SupervisorSignals {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface DaemonSupervisorOptions {
  child: SupervisorChild;
  signals?: SupervisorSignals;
  shutdownTimeoutMs?: number;
  onStage?: (stage: WorkerStage) => void;
  capability?: string;
  ownerCleanup?: OwnerCleanupOptions;
  log?: (...parts: unknown[]) => void;
}

export class DaemonSupervisor {
  readonly done: Promise<SupervisorResult>;
  private readonly child: SupervisorChild;
  private readonly signals: SupervisorSignals;
  private readonly shutdownTimeoutMs: number;
  private readonly onStageCallback?: (stage: WorkerStage) => void;
  private readonly capability: string;
  private resolveDone!: (result: SupervisorResult) => void;
  private started = false;
  private stopping = false;
  private initialized = false;
  private settled = false;
  private primaryError?: Error;
  private timer?: ReturnType<typeof setTimeout>;
  private shutdownRequestTimer?: ReturnType<typeof setTimeout>;
  private currentStage?: WorkerStage;
  private readonly owners = new Set<string>();
  private readonly ownerCleanup?: OwnerCleanup;
  private readonly log: (...parts: unknown[]) => void;
  private readonly ownerContext?: OwnerContext;
  private terminalWork?: Promise<void>;
  private deliveryStopped = false;


  private readonly onSigint = (): void => this.requestShutdown('SIGINT');
  private readonly onSigterm = (): void => this.requestShutdown('SIGTERM');
  private readonly onMessage = (message: unknown): void => {
    if (!isRecord(message) || message.capability !== this.capability) return;
    if (message.type === 'init_ack') {
      this.initialized = true;
      return;
    }
    if (!this.initialized) return;
    if (message.type === 'owner_register') {
      if (!this.ownerContext || typeof message.ownerInstanceId !== 'string'
        || message.ownerInstanceId.length === 0 || message.ownerInstanceId.length > 256) return;
      const accepted = !this.stopping && !this.terminalWork && this.child.connected !== false;
      if (accepted) this.owners.add(message.ownerInstanceId);
      this.send({ type: 'owner_registered', ownerInstanceId: message.ownerInstanceId,
        accepted, capability: this.capability });
      return;
    }
    if (message.type === 'shutdown_request') {
      // Let the worker finish the management RPC response after its IPC send
      // is accepted, then enter the exact signal-driven bounded path.
      this.shutdownRequestTimer ??= setTimeout(() => {
        this.shutdownRequestTimer = undefined;
        this.requestShutdown('SIGTERM');
      }, 25);
      return;
    }
    if (message.type === 'stage' && typeof message.stage === 'string'
      && (WORKER_STAGES as readonly string[]).includes(message.stage)) {
      this.currentStage = message.stage as WorkerStage;
      this.onStageCallback?.(this.currentStage);
      return;
    }
    if (message.type === 'shutdown_ack') {
      if (message.requiresProcessExit !== true) {
        try { this.child.disconnect?.(); } catch { /* exit watchdog remains armed */ }
      }
    }
  };
  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.finishTerminal({ code, signal, ...(this.primaryError ? { error: this.primaryError } : {}) });
  };
  private readonly onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.finishTerminal({ code, signal, ...(this.primaryError ? { error: this.primaryError } : {}) });
  };
  private readonly onDisconnect = (): void => {
    if (this.settled) return;
    this.stopping = true;
    this.armWatchdog();
  };
  private readonly onError = (error: Error): void => {
    if (this.settled) return;
    this.stopping = true;
    this.primaryError ??= error;
    // An error is not proof of death. With owner context retain the exact child
    // until its exit/close; the existing watchdog remains the bounded stop path.
    if (this.ownerCleanup) this.armWatchdog();
    else this.finish({ code: this.child.exitCode, signal: null, error: this.primaryError });
  };

  constructor(options: DaemonSupervisorOptions) {
    this.child = options.child;
    this.log = options.log ?? console.error;
    this.signals = options.signals ?? process;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS;
    this.onStageCallback = options.onStage;
    this.capability = options.capability ?? randomBytes(32).toString('hex');
    if (!/^[0-9a-f]{64}$/.test(this.capability)) throw new Error('invalid daemon worker capability');
    if (options.ownerCleanup) {
      if (!Number.isSafeInteger(this.child.pid) || this.child.pid! < 1) throw new Error('owner cleanup requires the actual worker PID');
      this.ownerCleanup = new OwnerCleanup(options.ownerCleanup);
      this.ownerContext = {
        stateDir: options.ownerCleanup.stateDir, selection: { ...options.ownerCleanup.selection },
        process: { pid: this.child.pid!, bootId: `cowork-supervisor:${randomBytes(16).toString('hex')}`,
          startId: `cowork-worker:${randomBytes(16).toString('hex')}`, domain: 'cowork:authenticated-ipc' },
      };
    }
    this.done = new Promise((resolveDone) => { this.resolveDone = resolveDone; });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.signals.on('SIGINT', this.onSigint);
    this.signals.on('SIGTERM', this.onSigterm);
    this.child.on('message', this.onMessage);
    this.child.once('exit', this.onExit);
    this.child.once('close', this.onClose);
    this.child.on('disconnect', this.onDisconnect);
    this.child.on('error', this.onError);
    this.send({ type: 'init', capability: this.capability, ...(this.ownerContext ? { ownerContext: this.ownerContext } : {}) });
  }

  requestShutdown(signal: 'SIGINT' | 'SIGTERM'): void {
    if (this.terminalWork) { this.deliveryStopped = true; return; }
    if (this.stopping) return;
    this.stopping = true;
    if (this.child.connected !== false && this.child.exitCode === null) {
      this.send({ type: 'shutdown', signal, capability: this.capability });
    }
    this.armWatchdog();
  }

  get stage(): WorkerStage | undefined { return this.currentStage; }

  private cleanupListeners(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.shutdownRequestTimer) clearTimeout(this.shutdownRequestTimer);
    this.timer = undefined;
    this.shutdownRequestTimer = undefined;
    this.signals.off('SIGINT', this.onSigint);
    this.signals.off('SIGTERM', this.onSigterm);
    this.child.off('message', this.onMessage);
    this.child.off('exit', this.onExit);
    this.child.off('close', this.onClose);
    this.child.off('disconnect', this.onDisconnect);
    this.child.off('error', this.onError);
  }

  private send(message: unknown): void {
    if (this.child.connected === false || this.child.exitCode !== null) {
      this.armWatchdog();
      return;
    }
    try {
      this.child.send(message, (error) => {
        if (error) {
          this.stopping = true;
          this.armWatchdog();
        }
      });
    } catch {
      this.stopping = true;
      this.armWatchdog();
    }
  }

  private armWatchdog(): void {
    if (this.timer || this.settled || this.terminalWork || this.child.exitCode !== null) return;
    this.timer = setTimeout(() => {
      if (this.settled || this.child.exitCode !== null) return;
      try { this.child.kill('SIGKILL'); } catch { /* exit/error handlers decide completion */ }
    }, this.shutdownTimeoutMs);
  }

  private finishTerminal(result: SupervisorResult): void {
    if (this.settled || this.terminalWork) return;
    if (!this.ownerCleanup || !this.ownerContext) { this.finish(result); return; }
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Publish synchronously while the exact child and all owner IDs are held.
    try { this.ownerCleanup.publish(this.owners, 'process-exit', this.ownerContext.process); }
    catch (error) {
      this.finish({ ...result, error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    this.terminalWork = (async () => {
      while (!this.deliveryStopped) {
        try { await this.ownerCleanup!.replay(); this.finish(result); return; }
        catch (error) {
          this.log('cowork terminal owner cleanup retained; retrying:', error instanceof Error ? error.message : String(error));
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      this.finish({ ...result, error: new Error('terminal owner cleanup remains pending') });
    })();
  }

  private finish(result: SupervisorResult): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanupListeners();
    this.resolveDone(result);
  }
}

export async function runSupervisor(options: {
  onStage?: (stage: WorkerStage) => void;
  quiet?: boolean;
} = {}): Promise<number> {
  const workerEnv = { ...process.env };
  delete workerEnv.NODE_OPTIONS;
  workerEnv.OURS_COWORK_DAEMON_WORKER = '1';
  workerEnv.OURS_COWORK_SUPERVISOR_PID = String(process.pid);
  const selection = ownerSelection(workerEnv);
  const config = loadConfig(workerEnv);
  // Replay saved targets even if the new launch selects another daemon or legacy mode.
  ensureRuntimeState(config);
  const replay = new OwnerCleanup({ stateDir: config.stateDir,
    selection: selection ?? { endpoint: '', expectedInstanceId: '', credentialPath: '' } });
  let cancelled = false;
  const cancelStartup = (): void => { cancelled = true; };
  process.on('SIGINT', cancelStartup);
  process.on('SIGTERM', cancelStartup);
  try {
    await replay.replay();
    // Deliver a signal queued by the caller before replacing startup listeners.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  finally { process.off('SIGINT', cancelStartup); process.off('SIGTERM', cancelStartup); }
  if (cancelled) return 0;
  const child = fork(fileURLToPath(import.meta.url), [], {
    env: workerEnv,
    stdio: options.quiet
      ? ['ignore', 'ignore', 'ignore', 'ipc']
      : ['inherit', 'inherit', 'inherit', 'ipc'],
    execArgv: [],
    // A terminal-generated signal must reach only the SDK-free supervisor.
    // The worker is controlled exclusively over IPC and shuts down if that
    // channel disappears.
    detached: process.platform !== 'win32',
  }) as ChildProcess & SupervisorChild;
  const supervisor = new DaemonSupervisor({ child, onStage: options.onStage, log: options.quiet ? () => {} : console.error,
    ...(selection ? { ownerCleanup: { stateDir: config.stateDir, selection } } : {}) });
  supervisor.start();
  const result = await supervisor.done;
  if (result.error) return 1;
  if (result.signal !== null) return 1;
  return result.code ?? 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void import('./daemon-process.ts').then(({ runDaemonProcess }) => runDaemonProcess()).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
