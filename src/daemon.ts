#!/usr/bin/env node

import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  private readonly onSigint = (): void => this.requestShutdown('SIGINT');
  private readonly onSigterm = (): void => this.requestShutdown('SIGTERM');
  private readonly onMessage = (message: unknown): void => {
    if (!isRecord(message) || message.capability !== this.capability) return;
    if (message.type === 'init_ack') {
      this.initialized = true;
      return;
    }
    if (!this.initialized) return;
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
    this.finish({ code, signal, ...(this.primaryError ? { error: this.primaryError } : {}) });
  };
  private readonly onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.finish({ code, signal, ...(this.primaryError ? { error: this.primaryError } : {}) });
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
    this.finish({ code: this.child.exitCode, signal: null, error: this.primaryError });
  };

  constructor(options: DaemonSupervisorOptions) {
    this.child = options.child;
    this.signals = options.signals ?? process;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS;
    this.onStageCallback = options.onStage;
    this.capability = options.capability ?? randomBytes(32).toString('hex');
    if (!/^[0-9a-f]{64}$/.test(this.capability)) throw new Error('invalid daemon worker capability');
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
    this.send({ type: 'init', capability: this.capability });
  }

  requestShutdown(signal: 'SIGINT' | 'SIGTERM'): void {
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
    if (this.timer || this.settled || this.child.exitCode !== null) return;
    this.timer = setTimeout(() => {
      if (this.settled || this.child.exitCode !== null) return;
      try { this.child.kill('SIGKILL'); } catch { /* exit/error handlers decide completion */ }
    }, this.shutdownTimeoutMs);
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
  const supervisor = new DaemonSupervisor({ child, onStage: options.onStage });
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
