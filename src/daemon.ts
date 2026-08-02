#!/usr/bin/env node

import { fork, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_STAGES = [
  'pre-lock', 'post-lock', 'during-host-init', 'post-host', 'pre-pid', 'ready',
] as const;
export type WorkerStage = typeof WORKER_STAGES[number];

export interface SupervisorChild extends EventEmitter {
  connected?: boolean;
  exitCode: number | null;
  send(message: unknown): unknown;
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
}

export class DaemonSupervisor {
  readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly child: SupervisorChild;
  private readonly signals: SupervisorSignals;
  private readonly shutdownTimeoutMs?: number;
  private readonly onStageCallback?: (stage: WorkerStage) => void;
  private resolveDone!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private started = false;
  private stopping = false;
  private acknowledged = false;
  private timer?: ReturnType<typeof setTimeout>;
  private currentStage?: WorkerStage;

  private readonly onSigint = (): void => this.requestShutdown('SIGINT');
  private readonly onSigterm = (): void => this.requestShutdown('SIGTERM');
  private readonly onMessage = (message: unknown): void => {
    if (!isRecord(message)) return;
    if (message.type === 'stage' && typeof message.stage === 'string'
      && (WORKER_STAGES as readonly string[]).includes(message.stage)) {
      this.currentStage = message.stage as WorkerStage;
      this.onStageCallback?.(this.currentStage);
      return;
    }
    if (message.type === 'shutdown_ack') {
      this.acknowledged = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (message.requiresProcessExit !== true) this.child.disconnect?.();
    }
  };
  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.cleanupListeners();
    this.resolveDone({ code, signal });
  };

  constructor(options: DaemonSupervisorOptions) {
    this.child = options.child;
    this.signals = options.signals ?? process;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.onStageCallback = options.onStage;
    this.done = new Promise((resolveDone) => { this.resolveDone = resolveDone; });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.signals.on('SIGINT', this.onSigint);
    this.signals.on('SIGTERM', this.onSigterm);
    this.child.on('message', this.onMessage);
    this.child.once('exit', this.onExit);
  }

  requestShutdown(signal: 'SIGINT' | 'SIGTERM'): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.child.connected !== false && this.child.exitCode === null) {
      this.child.send({ type: 'shutdown', signal });
    }
    if (this.shutdownTimeoutMs !== undefined) {
      this.timer = setTimeout(() => {
        if (this.acknowledged || this.child.exitCode !== null) return;
        this.child.kill('SIGKILL');
      }, this.shutdownTimeoutMs);
    }
  }

  get stage(): WorkerStage | undefined { return this.currentStage; }

  private cleanupListeners(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.signals.off('SIGINT', this.onSigint);
    this.signals.off('SIGTERM', this.onSigterm);
    this.child.off('message', this.onMessage);
  }
}

export async function runSupervisor(options: { onStage?: (stage: WorkerStage) => void } = {}): Promise<number> {
  const child = fork(fileURLToPath(import.meta.url), [], {
    env: {
      ...process.env,
      OURS_COWORK_DAEMON_WORKER: '1',
      OURS_COWORK_SUPERVISOR_PID: String(process.pid),
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    execArgv: workerExecArgv(process.execArgv),
    // A terminal-generated signal must reach only the SDK-free supervisor.
    // The worker is controlled exclusively over IPC and shuts down if that
    // channel disappears.
    detached: process.platform !== 'win32',
  }) as ChildProcess & SupervisorChild;
  const supervisor = new DaemonSupervisor({ child, onStage: options.onStage });
  supervisor.start();
  const result = await supervisor.done;
  if (result.signal !== null) return 1;
  return result.code ?? 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function workerExecArgv(values: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--eval' || argument === '-e' || argument === '--print' || argument === '-p') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--eval=') || argument.startsWith('--print=')
      || argument.startsWith('--input-type')) continue;
    kept.push(argument);
  }
  return kept;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void import('./daemon-process.ts').then(({ runDaemonProcess }) => runDaemonProcess()).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
