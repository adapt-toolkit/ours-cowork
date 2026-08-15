import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';

import type { OursClient } from '@ours.network/sdk';

import type { CoworkConfig } from './config.ts';

interface SdkDaemonHandle {
  readonly port: number;
  close(): Promise<void>;
}

export interface OursRuntimeClientFactory {
  createClient(leaseToken?: string): OursClient;
  onIdentityNotify(listener: (identityName: string) => void): () => void;
}

/** One process-owned standard ours SDK daemon, isolated below cowork state. */
export class EmbeddedOursHost implements OursRuntimeClientFactory {
  private readonly config: CoworkConfig;
  private readonly log: (...parts: unknown[]) => void;
  private readonly listeners = new Set<(identityName: string) => void>();
  private handle?: SdkDaemonHandle;
  private Client?: typeof OursClient;
  private apiToken?: string;
  private closed = false;

  constructor(config: CoworkConfig, log: (...parts: unknown[]) => void = () => {}) {
    this.config = config;
    this.log = log;
  }

  async boot(): Promise<void> {
    if (this.handle) return;
    if (this.closed) throw new Error('embedded ours SDK runtime cannot restart in the same process');
    const runtimeDir = configureOwnedSdkEnvironment(this.config);
    let handle: SdkDaemonHandle | undefined;
    try {
      const [{ OursClient }, { startDaemon }] = await Promise.all([
        import('@ours.network/sdk'),
        import('@ours.network/sdk/daemon'),
      ]);
      handle = await startDaemon({
        version: '@ours.network/cowork@vNext',
        handleSignals: false,
        onIdentityNotify: (identityName) => {
          for (const listener of this.listeners) {
            try { listener(identityName); } catch (error) {
              this.log(`cowork SDK notification listener failed for ${identityName}:`, error);
            }
          }
        },
      });
      const tokenPath = join(runtimeDir, 'daemon-token');
      const apiToken = fs.readFileSync(tokenPath, 'utf8').trim();
      if (!apiToken) throw new Error('embedded ours SDK runtime created an empty owner token');
      this.Client = OursClient;
      this.apiToken = apiToken;
      this.handle = handle;
    } catch (error) {
      await handle?.close();
      throw new Error('failed to start the embedded ours SDK runtime', { cause: error });
    }
  }

  createClient(leaseToken = `cowork-${randomBytes(16).toString('hex')}`): OursClient {
    if (!this.handle || !this.Client || !this.apiToken) {
      throw new Error('embedded ours SDK runtime is not booted');
    }
    return new this.Client({
      url: `http://127.0.0.1:${this.handle.port}`,
      leaseToken,
      apiToken: this.apiToken,
    });
  }

  onIdentityNotify(listener: (identityName: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    // CoworkDaemon uses shutdown() when available. This method only satisfies
    // its structural host contract without hiding asynchronous ownership.
  }

  async shutdown(): Promise<{ requiresProcessExit: boolean }> {
    if (this.closed) return { requiresProcessExit: true };
    this.closed = true;
    const handle = this.handle;
    this.handle = undefined;
    this.Client = undefined;
    this.apiToken = undefined;
    this.listeners.clear();
    await handle?.close();
    // SDK 1.3.1 closes its HTTP/session surface but the pinned native broker
    // wrapper can retain reconnect work. Cowork already isolates SDK ownership
    // in its private worker, so the worker remains the deterministic final
    // resource boundary after the public close completes.
    return { requiresProcessExit: true };
  }
}

export function sdkRuntimeStateDir(config: Pick<CoworkConfig, 'stateDir'>): string {
  return resolve(config.stateDir, 'ours-sdk');
}

/** Configure every process-global SDK input before its first value import. */
export function configureOwnedSdkEnvironment(config: CoworkConfig): string {
  const stateDir = sdkRuntimeStateDir(config);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  process.env.OURS_CONFIG = join(stateDir, 'config.json');
  process.env.OURS_STATE_DIR = stateDir;
  process.env.OURS_BROKER_URL = config.brokerUrl;
  process.env.OURS_PORT = '0';
  process.env.OURS_API_VISIBILITY = 'owner';
  process.env.OURS_TRANSPORT = 'http';
  process.env.OURS_AUTOSTART = 'false';
  process.env.OURS_GC_INTERVAL_MS = '3600000';
  delete process.env.OURS_API_TOKEN;
  return stateDir;
}
