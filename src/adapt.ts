import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import type { AdaptValue } from '@adapt-toolkit/sdk/backend';
import { AdaptObjectLifetime } from '@adapt-toolkit/sdk/common';
import { adapt_wrapper } from '@adapt-toolkit/sdk/executables';
import { object_to_adapt_value } from '@adapt-toolkit/sdk/wrapper';
import type { AdaptPacketWrapper, AdaptWrapper } from '@adapt-toolkit/sdk/wrappers';
import { PacketWrapperConfigurator } from '@adapt-toolkit/sdk/wrappers';

export type { AdaptValue };
export { AdaptObjectLifetime };

export type Logger = (...parts: unknown[]) => void;

export function withScope<T>(fn: (lifetime: AdaptObjectLifetime) => T): T {
  const lifetime = new AdaptObjectLifetime();
  try {
    return fn(lifetime);
  } finally {
    lifetime.Finalize();
  }
}

export async function withScopeAsync<T>(fn: (lifetime: AdaptObjectLifetime) => Promise<T>): Promise<T> {
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
};

export type NotifyHandler = (event: string, payload: AdaptValue) => void;

export class Packet {
  readonly pending: Pending[] = [];
  private lock: Promise<void> = Promise.resolve();
  readonly name: string;
  readonly cid: string;
  readonly pw: AdaptPacketWrapper;

  constructor(
    name: string,
    cid: string,
    pw: AdaptPacketWrapper,
  ) {
    this.name = name;
    this.cid = cid;
    this.pw = pw;
  }

  readonlyTx(name: string, lifetime?: AdaptObjectLifetime): AdaptValue {
    const envelope = object_to_adapt_value({ name, targ: undefined } as never) as AdaptValue;
    try {
      const result = this.pw.packet.ExecuteTransaction(envelope);
      return lifetime ? result.Attach(lifetime) : result;
    } finally {
      envelope.Destroy();
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private enqueue(envelope: AdaptValue, timeoutMs: number): Promise<AdaptValue> {
    return new Promise<AdaptValue>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((pending) => pending.timer === timer);
        if (index >= 0) {
          const [pending] = this.pending.splice(index, 1);
          pending.payload?.Destroy();
        }
        rejectResult(new Error(`timed out waiting for transaction result on packet "${this.name}"`));
      }, timeoutMs);
      const pending = { resolve: resolveResult, reject: rejectResult, timer };
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
    lifetime?: AdaptObjectLifetime,
    timeoutMs = 25_000,
  ): Promise<AdaptValue> {
    const envelope = object_to_adapt_value({ name, targ } as never) as AdaptValue;
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

  newBinary(bytes: Buffer, lifetime?: AdaptObjectLifetime): AdaptValue {
    const value = this.pw.packet.NewBinaryFromBuffer(bytes);
    return lifetime ? value.Attach(lifetime) : value;
  }
}

export function wireHandlers(
  packet: Packet,
  hooks: { onSaveState: () => void; onNotify: NotifyHandler },
  log: Logger,
): void {
  const settleAfterActionLoop = (pending: Pending): void => {
    queueMicrotask(() => {
      if (packet.pending[0] !== pending || !pending.payload) return;
      packet.pending.shift();
      clearTimeout(pending.timer);
      pending.resolve(pending.payload);
    });
  };

  packet.pw.on_return_data = (data: AdaptValue) => {
    const lifetime = new AdaptObjectLifetime();
    data.Attach(lifetime);
    try {
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
    const pending = packet.pending.shift();
    if (!pending) {
      log(`[${packet.name}] inbound transaction rejected:`, message);
      return;
    }
    clearTimeout(pending.timer);
    pending.payload?.Destroy();
    pending.reject(pending.callbackError ?? new Error(message));
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface AdaptHostOptions {
  unit?: Unit;
}

export class AdaptHost {
  private wrapper?: AdaptWrapper;
  private readonly packets = new Map<string, Packet>();
  private readonly brokerUrl: string;
  private readonly log: Logger;
  readonly unit: Unit;

  constructor(
    brokerUrl: string,
    log: Logger = () => {},
    options: AdaptHostOptions = {},
  ) {
    this.brokerUrl = brokerUrl;
    this.log = log;
    this.unit = options.unit ?? locateUnit();
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

  createPacket(name: string, seed: string, signingSecret?: string): Promise<Packet> {
    const wrapper = this.wrapper;
    if (!wrapper) return Promise.reject(new Error('AdaptHost.boot() must complete before creating packets'));
    const config = new PacketWrapperConfigurator();
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
          const packet = new Packet(name, cid, pw);
          this.packets.set(cid, packet);
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

  removePacket(cid: string): void {
    const wrapper = this.wrapper;
    if (!wrapper) throw new Error('AdaptHost is not booted');
    wrapper.remove_packet(cid);
    this.packets.delete(cid);
  }

  close(): void {
    if (!this.wrapper) return;
    const errors: Error[] = [];
    for (const cid of [...this.packets.keys()]) {
      try {
        this.removePacket(cid);
      } catch (error) {
        errors.push(asError(error));
      }
    }
    if (errors.length) throw new AggregateError(errors, 'failed to remove all hosted packets');
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
