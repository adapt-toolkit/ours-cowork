import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import type { AdaptValue } from '@adapt-toolkit/sdk/backend';
import type { AdaptObjectLifetime as AdaptLifetime } from '@adapt-toolkit/sdk/common';
import type { AdaptPacketWrapper, AdaptWrapper } from '@adapt-toolkit/sdk/wrappers';

// Value imports stay dynamic so a bundled supervisor can install signal/IPC
// ownership and fork before the native SDK is loaded in its worker process.
const [commonSdk, executableSdk, wrapperSdk, wrappersSdk] = await Promise.all([
  import('@adapt-toolkit/sdk/common'),
  import('@adapt-toolkit/sdk/executables'),
  import('@adapt-toolkit/sdk/wrapper'),
  import('@adapt-toolkit/sdk/wrappers'),
]);
const { AdaptObjectLifetime } = commonSdk;
const { adapt_wrapper } = executableSdk;
const { object_to_adapt_value } = wrapperSdk;
const { PacketWrapperConfigurator } = wrappersSdk;

export type { AdaptValue };
export { AdaptObjectLifetime };

export type Logger = (...parts: unknown[]) => void;

export function withScope<T>(fn: (lifetime: AdaptLifetime) => T): T {
  const lifetime = new AdaptObjectLifetime();
  try {
    return fn(lifetime);
  } finally {
    lifetime.Finalize();
  }
}

export async function withScopeAsync<T>(fn: (lifetime: AdaptLifetime) => Promise<T>): Promise<T> {
  const lifetime = new AdaptObjectLifetime();
  try {
    return await fn(lifetime);
  } finally {
    lifetime.Finalize();
  }
}

export interface Unit {
  dir: string;
  hash: string;
  contents: Uint8Array;
}

export function locateUnit(): Unit {
  const here = dirname(fileURLToPath(import.meta.url));
  const override = process.env.OURS_COWORK_UNIT_DIR;
  const candidates = override
    ? [resolve(override)]
    : [join(here, 'mufl_code'), join(here, '..', 'mufl_code')];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const compiled = fs.readdirSync(dir).find((name) => name.endsWith('.muflo'));
    if (compiled) {
      return {
        dir,
        hash: compiled.slice(0, -'.muflo'.length),
        contents: new Uint8Array(fs.readFileSync(join(dir, compiled))),
      };
    }
  }
  throw new Error(`no compiled .muflo packet found (looked in: ${candidates.join(', ')})`);
}

type Pending = {
  resolve: (value: AdaptValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  payload?: AdaptValue;
  callbackError?: Error;
  settled?: boolean;
  expired?: boolean;
  lateTimer?: ReturnType<typeof setTimeout>;
};

const LATE_RESULT_DRAIN_MS = 50;

export type PacketEnvelopeFactory = (name: string, targ: unknown) => AdaptValue;

export type NotifyHandler = (event: string, payload: AdaptValue) => void;

export class Packet {
  readonly pending: Pending[] = [];
  private lock: Promise<void> = Promise.resolve();
  private expiredDrain?: Promise<void>;
  private releaseExpiredDrain?: () => void;
  private closedError?: Error;
  private terminalNotified = false;
  private readonly onTerminal: (error: Error) => void;
  private readonly terminalListeners = new Set<(error: Error) => void>();
  private readonly makeEnvelope: PacketEnvelopeFactory;
  readonly name: string;
  readonly cid: string;
  readonly pw: AdaptPacketWrapper;

  constructor(
    name: string,
    cid: string,
    pw: AdaptPacketWrapper,
    onTerminal: (error: Error) => void = () => {},
    makeEnvelope: PacketEnvelopeFactory = (transactionName, targ) =>
      object_to_adapt_value({ name: transactionName, targ } as never) as AdaptValue,
  ) {
    this.name = name;
    this.cid = cid;
    this.pw = pw;
    this.onTerminal = onTerminal;
    this.makeEnvelope = makeEnvelope;
  }

  get isClosed(): boolean {
    return this.closedError !== undefined;
  }

  onTerminalClose(listener: (error: Error) => void): () => void {
    if (this.closedError) {
      listener(this.closedError);
      return () => {};
    }
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  private assertOpen(): void {
    if (this.closedError) throw this.closedError;
  }

  readonlyTx(name: string, lifetime?: AdaptLifetime): AdaptValue {
    this.assertOpen();
    const envelope = this.makeEnvelope(name, undefined);
    try {
      const result = this.pw.packet.ExecuteTransaction(envelope);
      return lifetime ? result.Attach(lifetime) : result;
    } finally {
      envelope.Destroy();
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      this.assertOpen();
      if (this.expiredDrain) await this.expiredDrain;
      this.assertOpen();
      return await fn();
    } finally {
      release();
    }
  }

  private enqueue(envelope: AdaptValue, timeoutMs: number): Promise<AdaptValue> {
    return new Promise<AdaptValue>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        const pending = this.pending.find((candidate) => candidate.timer === timer);
        if (!pending || pending.settled) return;
        pending.settled = true;
        pending.expired = true;
        pending.reject(new Error(`timed out waiting for transaction result on packet "${this.name}"`));
        this.expiredDrain = new Promise<void>((resolveDrain) => { this.releaseExpiredDrain = resolveDrain; });
        pending.lateTimer = setTimeout(() => this.releaseExpired(pending), LATE_RESULT_DRAIN_MS);
      }, timeoutMs);
      const pending: Pending = { resolve: resolveResult, reject: rejectResult, timer };
      this.pending.push(pending);
      try {
        this.pw.add_client_message(envelope);
      } catch (error) {
        clearTimeout(timer);
        const index = this.pending.indexOf(pending);
        if (index >= 0) this.pending.splice(index, 1);
        rejectResult(asError(error));
      }
    });
  }

  mutatingTx(
    name: string,
    targ: unknown,
    lifetime?: AdaptLifetime,
    timeoutMs = 25_000,
  ): Promise<AdaptValue> {
    let envelope: AdaptValue;
    try {
      this.assertOpen();
      envelope = this.makeEnvelope(name, targ);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return this.withLock(() => this.enqueue(envelope, timeoutMs)).then(
      (payload) => {
        envelope.Destroy();
        return lifetime ? payload.Attach(lifetime) : payload;
      },
      (error) => {
        envelope.Destroy();
        throw error;
      },
    );
  }

  newBinary(bytes: Buffer, lifetime?: AdaptLifetime): AdaptValue {
    this.assertOpen();
    const value = this.pw.packet.NewBinaryFromBuffer(bytes);
    return lifetime ? value.Attach(lifetime) : value;
  }

  close(error: Error = new Error(`packet "${this.name}" is closed`)): void {
    if (this.closedError) return;
    this.closedError = error;
    const pending = this.pending.splice(0);
    for (const call of pending) {
      clearTimeout(call.timer);
      if (call.lateTimer) clearTimeout(call.lateTimer);
      call.payload?.Destroy();
      if (!call.settled) {
        call.settled = true;
        call.reject(error);
      }
    }
    this.releaseExpiredDrain?.();
    this.releaseExpiredDrain = undefined;
    this.expiredDrain = undefined;
    if (!this.terminalNotified) {
      this.terminalNotified = true;
      for (const listener of this.terminalListeners) listener(error);
      this.terminalListeners.clear();
      this.onTerminal(error);
    }
  }

  releaseExpired(pending: Pending): void {
    const index = this.pending.indexOf(pending);
    if (index >= 0) this.pending.splice(index, 1);
    if (pending.lateTimer) clearTimeout(pending.lateTimer);
    pending.payload?.Destroy();
    this.releaseExpiredDrain?.();
    this.releaseExpiredDrain = undefined;
    this.expiredDrain = undefined;
  }
}

export function wireHandlers(
  packet: Packet,
  hooks: { onSaveState: () => void; onNotify: NotifyHandler },
  log: Logger,
): void {
  const settleAfterActionLoop = (pending: Pending): void => {
    queueMicrotask(() => {
      if (packet.pending[0] !== pending || !pending.payload || pending.callbackError) return;
      packet.pending.shift();
      clearTimeout(pending.timer);
      pending.settled = true;
      pending.resolve(pending.payload);
    });
  };

  packet.pw.on_return_data = (data: AdaptValue) => {
    const lifetime = new AdaptObjectLifetime();
    data.Attach(lifetime);
    try {
      if (packet.isClosed) return;
      const kind = data.Reduce('kind').Visualize();
      if (kind === 'save_state') {
        try {
          hooks.onSaveState();
        } catch (error) {
          const pending = packet.pending[0];
          if (pending) pending.callbackError = asError(error);
          throw error;
        }
        return;
      }
      if (kind === 'notify_agent') {
        const payload = data.Reduce('payload');
        hooks.onNotify(payload.Reduce('event').Visualize(), payload);
        return;
      }
      const pending = packet.pending[0];
      if (!pending) return;
      if (pending.expired) {
        packet.releaseExpired(pending);
        return;
      }
      if (pending.payload) pending.payload.Destroy();
      pending.payload = data.Reduce('payload').Detach();
      // Result-data commonly precedes save_state. The SDK invokes every RET hook
      // in one synchronous action loop, so the microtask runs only after a later
      // save hook has either returned or failed through on_transaction_failure.
      settleAfterActionLoop(pending);
    } finally {
      lifetime.Finalize();
    }
  };

  packet.pw.on_transaction_failure = (message: string) => {
    // SDK 0.10.12 provides neither origin nor a client-call correlation key.
    // This may describe unrelated inbound traffic while a local call is
    // pending, so consuming the local FIFO here would mispair later results.
    // The pending call remains protected by its bounded timeout/tombstone.
    log(`[${packet.name}] transaction rejected (origin uncorrelated):`, message);
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface AdaptHostOptions {
  unit?: Unit;
  /** SDK 0.10.12 has no public wrapper stop; embedders may supply one when available. */
  shutdownWrapper?: (wrapper: AdaptWrapper) => void | Promise<void>;
}

export interface AdaptHostShutdownResult {
  requiresProcessExit: boolean;
}

export class AdaptHostShutdownError extends AggregateError {
  readonly requiresProcessExit: boolean;

  constructor(errors: Iterable<unknown>, requiresProcessExit: boolean) {
    super(errors, 'AdaptHost shutdown encountered errors');
    this.name = 'AdaptHostShutdownError';
    this.requiresProcessExit = requiresProcessExit;
  }
}

export interface CreatePacketOptions {
  deferredExposure?: boolean;
}

export class AdaptHost {
  private wrapper?: AdaptWrapper;
  private readonly packets = new Map<string, Packet>();
  private readonly exposedPackets = new Set<string>();
  private readonly brokerUrl: string;
  private readonly log: Logger;
  readonly unit: Unit;
  private readonly shutdownWrapper?: (wrapper: AdaptWrapper) => void | Promise<void>;

  constructor(
    brokerUrl: string,
    log: Logger = () => {},
    options: AdaptHostOptions = {},
  ) {
    this.brokerUrl = brokerUrl;
    this.log = log;
    this.unit = options.unit ?? locateUnit();
    this.shutdownWrapper = options.shutdownWrapper;
  }

  get packetCount(): number {
    return this.packets.size;
  }

  async boot(): Promise<void> {
    if (this.wrapper) return;
    this.wrapper = await adapt_wrapper.start([
      '--broker_address', this.brokerUrl,
      '--test_mode',
      '--logger_config', '--level', 'WARNING', '--stdout', 'stderr', '--logger_config_end',
    ]);
    this.wrapper.on_packet_created_cb = (cid: string) => {
      this.log(`wrapper: packet ready ${cid.slice(0, 12)}…`);
    };
    this.wrapper.start();
  }

  createPacket(
    name: string,
    seed: string,
    signingSecret?: string,
    options: CreatePacketOptions = {},
  ): Promise<Packet> {
    const wrapper = this.wrapper;
    if (!wrapper) return Promise.reject(new Error('AdaptHost.boot() must complete before creating packets'));
    const config = new PacketWrapperConfigurator();
    config.deferred_exposure = options.deferredExposure ?? false;
    const args = [
      '--unit_hash', this.unit.hash,
      '--seed_phrase', seed,
      '--unit_dir_path', this.unit.dir,
    ];
    if (signingSecret) args.push('--init_trn_argument', JSON.stringify(signingSecret));
    config.process_arguments(args);

    return new Promise<Packet>((resolveCreate, rejectCreate) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        rejectCreate(new Error(`packet creation for "${name}" timed out`));
      }, 30_000);
      try {
        wrapper.packet_manager.create_packet(config, (pw: AdaptPacketWrapper) => {
          if (settled) {
            pw.dispose();
            return;
          }
          settled = true;
          clearTimeout(timer);
          const cid = withScope((lifetime) => pw.packet.GetContainerID().Attach(lifetime).Visualize());
          let packet!: Packet;
          packet = new Packet(name, cid, pw, (error) => {
            // Never dispose a wrapper while its SDK callback stack is active.
            // Closing is synchronous (so queued/future calls are already barred);
            // native removal follows at the next microtask boundary.
            queueMicrotask(() => {
              if (this.packets.get(cid) !== packet) return;
              try {
                this.removePacket(cid, error);
              } catch (removeError) {
                this.log(`[${name}] terminal packet removal failed:`, removeError);
              }
            });
          });
          this.packets.set(cid, packet);
          if (!config.deferred_exposure) this.exposedPackets.add(cid);
          resolveCreate(packet);
        }, this.unit.contents);
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectCreate(asError(error));
      }
    });
  }

  exposePacket(cid: string): void {
    const wrapper = this.wrapper;
    const packet = this.packets.get(cid);
    if (!wrapper || !packet) throw new Error(`cannot expose unknown packet ${cid}`);
    if (packet.isClosed) throw new Error(`cannot expose closed packet ${cid}`);
    wrapper.expose_packet(cid);
    this.exposedPackets.add(cid);
  }

  isPacketExposed(cid: string): boolean {
    return this.exposedPackets.has(cid);
  }

  removePacket(cid: string, error = new Error(`packet ${cid} removed from host`)): void {
    const wrapper = this.wrapper;
    if (!wrapper) throw new Error('AdaptHost is not booted');
    const packet = this.packets.get(cid);
    if (!packet) return;
    packet.close(error);
    wrapper.remove_packet(cid);
    this.packets.delete(cid);
    this.exposedPackets.delete(cid);
  }

  close(): void {
    if (!this.wrapper) return;
    const errors: Error[] = [];
    for (const cid of [...this.packets.keys()]) {
      try {
        this.removePacket(cid, new Error('AdaptHost closed'));
      } catch (error) {
        errors.push(asError(error));
      }
    }
    this.wrapper = undefined;
    if (errors.length) throw new AggregateError(errors, 'failed to remove all hosted packets');
  }

  /**
   * Release every public SDK resource. SDK 0.10.12 exposes packet disposal but
   * not its private broker client's stop(), so a real native wrapper reports
   * that the owning process must exit after graceful daemon cleanup.
   */
  async shutdown(): Promise<AdaptHostShutdownResult> {
    const wrapper = this.wrapper;
    if (!wrapper) return { requiresProcessExit: false };
    const errors: unknown[] = [];
    // Until a public stop boundary completes, process exit remains the only
    // reliable way to terminate SDK reconnect and heartbeat resources.
    let requiresProcessExit = true;
    try { this.close(); } catch (error) { errors.push(error); }
    try {
      if (this.shutdownWrapper) {
        await this.shutdownWrapper(wrapper);
        requiresProcessExit = false;
      } else {
        const futureWrapper = wrapper as AdaptWrapper & {
          stop?: () => void | Promise<void>;
          shutdown?: () => void | Promise<void>;
          dispose?: () => void | Promise<void>;
        };
        const publicStop = futureWrapper.shutdown ?? futureWrapper.stop ?? futureWrapper.dispose;
        if (typeof publicStop === 'function') {
          await publicStop.call(wrapper);
          requiresProcessExit = false;
        }
      }
    } catch (error) { errors.push(error); }
    // Ownership is relinquished even when packet removal or wrapper shutdown
    // fails. A second caller must never operate on a half-closed native wrapper.
    this.wrapper = undefined;
    if (errors.length > 0) throw new AdaptHostShutdownError(errors, requiresProcessExit);
    return { requiresProcessExit };
  }
}

export function packInvite(raw: Buffer): string {
  return brotliCompressSync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  }).toString('base64url');
}

export function unpackInvite(encoded: string): Buffer {
  const compressed = Buffer.from(encoded.replace(/\s+/g, ''), 'base64url');
  if (compressed.length === 0) throw new Error('the invite blob is empty or invalid base64url');
  return Buffer.from(brotliDecompressSync(compressed));
}
