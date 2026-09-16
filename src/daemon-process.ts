// Executable-only process ownership for the public daemon bundle. Importable
// supervisor/runtime APIs never terminate the host process.

import { randomBytes } from 'node:crypto';

import { runSupervisor } from './daemon.ts';
import { OwnerCleanup, ownerSelection, type OwnerContext } from './owner-cleanup.ts';

const WORKER_HANDSHAKE_TIMEOUT_MS = 5_000;

interface WorkerInitMessage {
  type: 'init';
  capability: string;
  ownerContext?: OwnerContext;
}

interface WorkerShutdownMessage {
  type: 'shutdown';
  signal: 'SIGINT' | 'SIGTERM';
  capability: string;
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
  const supervisorPid = authorizeWorker();
  let shutdownRequested = false;
  let disconnected = false;
  let shutdownWork: Promise<void> | undefined;
  let daemon: import('./daemon-runtime.ts').CoworkDaemon | undefined;
  let capability: string | undefined;
  let ownerContext: OwnerContext | undefined;
  const owners = new Set<string>();
  const admissions = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const cancelAdmissions = (): void => {
    for (const pending of admissions.values()) pending.reject(new Error('owner admission cancelled by worker shutdown'));
    admissions.clear();
  };
  const registerOwner = async (ownerInstanceId: string): Promise<void> => {
    if (shutdownRequested || disconnected || !capability || !ownerContext) throw new Error('owner admission unavailable');
    const registered = new Promise<void>((resolve, reject) => { admissions.set(ownerInstanceId, { resolve, reject }); });
    try {
      // Attach cannot race ahead of the parent's in-memory registration ACK.
      void sendIpc({ type: 'owner_register', ownerInstanceId, capability }).then((sent) => {
        if (!sent) admissions.get(ownerInstanceId)?.reject(new Error('owner registration IPC unavailable'));
      });
      await withTimeout(registered, WORKER_HANDSHAKE_TIMEOUT_MS, 'owner registration timed out');
      if (shutdownRequested || disconnected || process.connected === false) throw new Error('owner admission cancelled');
      owners.add(ownerInstanceId);
    } finally { admissions.delete(ownerInstanceId); }
  };
  let resolveShutdown!: (code: number) => void;
  const shutdownComplete = new Promise<number>((resolve) => { resolveShutdown = resolve; });

  const acknowledge = async (): Promise<void> => {
    if (shutdownWork) return shutdownWork;
    shutdownRequested = true;
    cancelAdmissions();
    shutdownWork = (async () => {
      let requiresProcessExit = false;
      let error: unknown;
      try {
        if (daemon) ({ requiresProcessExit } = await daemon.shutdown());
      } catch (caught) {
        error = caught;
        requiresProcessExit = true;
      }
      if (capability && !disconnected) {
        await sendIpc({ type: 'shutdown_ack', requiresProcessExit, failed: error !== undefined, capability });
      }
      if (error !== undefined) console.error(error);
      const code = error === undefined ? 0 : 1;
      if (requiresProcessExit) {
        // The underlying native runtime exposes no broker stop. This private
        // worker owns the SDK process and is the sole boundary permitted to force exit.
        process.exit(code);
      }
      if (!disconnected) {
        try { process.disconnect?.(); } catch { disconnected = true; }
      }
      resolveShutdown(code);
    })();
    return shutdownWork;
  };

  // Authenticate the live IPC parent and complete a per-spawn capability
  // handshake before the dynamic SDK runtime import.
  let resolveHandshake!: (state: 'ready' | 'shutdown') => void;
  const handshake = new Promise<'ready' | 'shutdown'>((resolve) => { resolveHandshake = resolve; });
  process.on('message', (message: unknown) => {
    if (isWorkerInitMessage(message)) {
      if (capability) return;
      capability = message.capability;
      ownerContext = message.ownerContext;
      if (ownerContext && ownerContext.process.pid !== process.pid) {
        shutdownRequested = true;
        resolveHandshake('shutdown');
        void acknowledge();
        return;
      }
      void sendIpc({ type: 'init_ack', capability }).then((sent) => {
        if (sent) resolveHandshake('ready');
        else {
          disconnected = true;
          shutdownRequested = true;
          resolveHandshake('shutdown');
          void acknowledge();
        }
      });
      return;
    }
    if (isRecord(message) && message.type === 'owner_registered' && message.capability === capability
      && typeof message.ownerInstanceId === 'string') {
      const pending = admissions.get(message.ownerInstanceId);
      if (message.accepted === true && !shutdownRequested && !disconnected) pending?.resolve();
      else pending?.reject(new Error('owner registration refused by supervisor'));
      return;
    }
    if (isWorkerShutdownMessage(message) && (!capability || capability === message.capability)) {
      capability = message.capability;
      shutdownRequested = true;
      resolveHandshake('shutdown');
      void acknowledge();
    }
  });
  process.on('disconnect', () => {
    disconnected = true;
    shutdownRequested = true;
    resolveHandshake('shutdown');
    void acknowledge();
  });

  const handshakeState = await withTimeout(handshake, WORKER_HANDSHAKE_TIMEOUT_MS, 'daemon worker handshake timed out');
  if (handshakeState === 'shutdown' || shutdownRequested || disconnected || !capability) {
    await acknowledge();
    return shutdownComplete;
  }
  const staged = await sendIpc({ type: 'stage', stage: 'pre-lock', capability });
  // Yield once so a shutdown queued behind the stage acknowledgement can win
  // before evaluating the dynamic import expression.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!staged || shutdownRequested || disconnected || process.connected === false) {
    await acknowledge();
    return shutdownComplete;
  }
  const runtime = await import('./daemon-runtime.ts');
  if (shutdownRequested) {
    await acknowledge();
    return shutdownComplete;
  }
  if (ownerSelection(process.env) && !ownerContext) throw new Error('V1 worker requires authenticated owner context');
  const cleanup = ownerContext ? new OwnerCleanup(ownerContext) : undefined;
  daemon = new runtime.CoworkDaemon({
    ...(ownerContext ? {
      registerOwner,
      beforeTerminalRelease: async () => {
        cleanup!.publish(owners, 'session-end', ownerContext!.process);
        await cleanup!.replay();
      },
    } : {}),
    config: runtime.loadConfig(),
    log: (...parts) => console.error(...parts),
    writePid: (stateDir) => runtime.writeDaemonPid(stateDir, undefined, supervisorPid),
    removePid: (stateDir) => runtime.removeDaemonPid(stateDir, undefined, supervisorPid),
    onStage: (stage) => { void sendIpc({ type: 'stage', stage, capability }); },
    control: {
      // Created only after the supervisor capability handshake completed.
      session: randomBytes(16).toString('hex'),
      async requestSupervisorShutdown() {
        if (!capability || disconnected || process.connected === false) return false;
        return sendIpc({ type: 'shutdown_request', capability });
      },
    },
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

function sendIpc(message: unknown): Promise<boolean> {
  const sender = process.send;
  if (!sender || process.connected === false) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      sender.call(process, message, (error) => resolve(error === null));
    } catch {
      resolve(false);
    }
  });
}

function authorizeWorker(): number {
  const supervisorPid = parseSupervisorPid(process.env.OURS_COWORK_SUPERVISOR_PID);
  if (!process.send || process.connected === false || process.ppid !== supervisorPid) {
    throw new Error('daemon worker requires live authorized supervisor IPC');
  }
  return supervisorPid;
}

function parseSupervisorPid(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error('missing cowork daemon supervisor PID');
  const pid = Number(value);
  if (!Number.isSafeInteger(pid)) throw new Error('invalid cowork daemon supervisor PID');
  return pid;
}

function isWorkerShutdownMessage(value: unknown): value is WorkerShutdownMessage {
  return isRecord(value) && value.type === 'shutdown'
    && (value.signal === 'SIGINT' || value.signal === 'SIGTERM')
    && isCapability(value.capability);
}

function isWorkerInitMessage(value: unknown): value is WorkerInitMessage {
  return isRecord(value) && value.type === 'init' && isCapability(value.capability);
}

function isCapability(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
