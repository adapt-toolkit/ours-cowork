// Executable-only process ownership for the public daemon bundle. Importable
// supervisor/runtime APIs never terminate the host process.

import { runSupervisor } from './daemon.ts';

interface WorkerShutdownMessage {
  type: 'shutdown';
  signal: 'SIGINT' | 'SIGTERM';
}

export async function runDaemonProcess(): Promise<void> {
  try {
    const code = process.env.OURS_COWORK_DAEMON_WORKER === '1'
      ? await runWorker()
      : await runSupervisor();
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    if (process.env.OURS_COWORK_DAEMON_WORKER === '1') {
      // A failed worker boot may already own native SDK reconnect resources.
      process.exit(1);
    }
    process.exitCode = 1;
  }
}

async function runWorker(): Promise<number> {
  let shutdownRequested = false;
  let shutdownWork: Promise<void> | undefined;
  let daemon: import('./daemon-runtime.ts').CoworkDaemon | undefined;
  let resolveShutdown!: (code: number) => void;
  const shutdownComplete = new Promise<number>((resolve) => { resolveShutdown = resolve; });

  const acknowledge = async (): Promise<void> => {
    if (shutdownWork) return shutdownWork;
    shutdownRequested = true;
    shutdownWork = (async () => {
      let requiresProcessExit = false;
      let error: unknown;
      try {
        if (daemon) ({ requiresProcessExit } = await daemon.shutdown());
      } catch (caught) {
        error = caught;
        requiresProcessExit = true;
      }
      await sendIpc({ type: 'shutdown_ack', requiresProcessExit, failed: error !== undefined });
      if (error !== undefined) console.error(error);
      const code = error === undefined ? 0 : 1;
      if (requiresProcessExit) {
        // SDK 0.10.12 exposes no native broker stop. This private worker owns
        // the SDK process and is the sole boundary permitted to force exit.
        process.exit(code);
      }
      process.disconnect?.();
      resolveShutdown(code);
    })();
    return shutdownWork;
  };

  // Install IPC before the dynamic SDK runtime import. A supervisor shutdown
  // therefore wins at pre-lock and throughout native module initialization.
  process.on('message', (message: unknown) => {
    if (isWorkerShutdownMessage(message)) void acknowledge();
  });
  process.on('disconnect', () => { void acknowledge(); });

  await sendIpc({ type: 'stage', stage: 'pre-lock' });
  const runtime = await import('./daemon-runtime.ts');
  if (shutdownRequested) {
    await acknowledge();
    return shutdownComplete;
  }
  const supervisorPid = parseSupervisorPid(process.env.OURS_COWORK_SUPERVISOR_PID);
  daemon = new runtime.CoworkDaemon({
    config: runtime.loadConfig(),
    log: (...parts) => console.error(...parts),
    writePid: (stateDir) => runtime.writeDaemonPid(stateDir, undefined, supervisorPid),
    removePid: (stateDir) => runtime.removeDaemonPid(stateDir, undefined, supervisorPid),
    onStage: (stage) => { void sendIpc({ type: 'stage', stage }); },
  });
  try {
    await daemon.boot();
    return shutdownComplete;
  } catch (error) {
    if (error instanceof runtime.DaemonBootCancelledError) {
      await acknowledge();
      return shutdownComplete;
    }
    throw error;
  }
}

function sendIpc(message: unknown): Promise<void> {
  if (!process.send || process.connected === false) return Promise.resolve();
  return new Promise((resolve) => {
    process.send?.(message, () => resolve());
  });
}

function parseSupervisorPid(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error('missing cowork daemon supervisor PID');
  const pid = Number(value);
  if (!Number.isSafeInteger(pid)) throw new Error('invalid cowork daemon supervisor PID');
  return pid;
}

function isWorkerShutdownMessage(value: unknown): value is WorkerShutdownMessage {
  return isRecord(value) && value.type === 'shutdown'
    && (value.signal === 'SIGINT' || value.signal === 'SIGTERM');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
