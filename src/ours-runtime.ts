import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';

import type { OursClient, ResolvedDaemonConfig } from '@ours.network/sdk';

import { daemonMode, type CoworkConfig } from './config.ts';

const WATCH_RETRY_MIN_MS = 500;
const WATCH_RETRY_MAX_MS = 30_000;

interface SdkDaemonHandle {
  readonly port: number;
  close(): Promise<void>;
}

export interface OursRuntimeClientFactory {
  createClient(leaseToken?: string): OursClient;
  onIdentityNotify(listener: (identityName: string) => void): () => void;
  /**
   * Follow one hosted room identity's notifications, returning an unsubscribe.
   *
   * Only a host that cannot see the runtime's in-process notification callback
   * implements this. The embedded host omits it because `startDaemon` already
   * reports every identity, and `PacketRegistry` calls it optionally so both
   * hosts keep the same registration order.
   */
  trackIdentity?(identityName: string): () => void;
}

/** The full contract `CoworkDaemon` owns: a client factory with a lifecycle. */
export interface OursRuntimeHost extends OursRuntimeClientFactory {
  boot(): Promise<void>;
  close(): void;
  shutdown(): Promise<{ requiresProcessExit: boolean }>;
}

/** Pick the host the effective configuration asks for. Embedded is the default. */
export function createOursHost(
  config: CoworkConfig,
  log: (...parts: unknown[]) => void = () => {},
): OursRuntimeHost {
  return daemonMode(config) === 'external'
    ? new ExternalOursHost(config, log)
    : new EmbeddedOursHost(config, log);
}

/** One process-owned standard ours SDK daemon, isolated below cowork state. */
export class EmbeddedOursHost implements OursRuntimeHost {
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

/**
 * A client of an ALREADY-RUNNING ours daemon. This host starts no runtime: it
 * only ever imports the SDK's client entry, never `@ours.network/sdk/daemon`,
 * and it never touches the process-global `OURS_*` inputs the embedded host
 * owns. If the selected daemon cannot be identified, boot fails — there is no
 * path from here back to an embedded runtime.
 */
export class ExternalOursHost implements OursRuntimeHost {
  private readonly endpoint: string;
  private readonly daemonStateDir: string;
  private readonly log: (...parts: unknown[]) => void;
  private readonly listeners = new Set<(identityName: string) => void>();
  private readonly watchers = new Map<string, IdentityWatcher>();
  private readonly watchLeaseToken = `cowork-watch-${randomBytes(16).toString('hex')}`;
  private Client?: typeof OursClient;
  private resolved?: ResolvedDaemonConfig;
  private watchClient?: OursClient;
  private closed = false;

  constructor(config: CoworkConfig, log: (...parts: unknown[]) => void = () => {}) {
    const daemon = config.daemon;
    if (daemon?.mode !== 'external' || daemon.endpoint === undefined || daemon.stateDir === undefined) {
      throw new Error('external ours daemon mode requires both daemon.endpoint and daemon.stateDir');
    }
    this.endpoint = daemon.endpoint;
    this.daemonStateDir = daemon.stateDir;
    this.log = log;
  }

  async boot(): Promise<void> {
    if (this.resolved) return;
    if (this.closed) throw new Error('external ours daemon host cannot restart in the same process');
    const { OursClient, resolveDaemonConfig, assertDaemonStateDir } = await import('@ours.network/sdk');
    let resolved: ResolvedDaemonConfig;
    try {
      resolved = resolveDaemonConfig({ endpoint: this.endpoint, expectStateDir: this.daemonStateDir });
    } catch (error) {
      throw new Error(`cowork cannot select the external ours daemon at ${this.endpoint}`, { cause: error });
    }
    // Proves the endpoint is an ours daemon owning the expected state directory
    // BEFORE its API token is sent anywhere. An unreachable, mismatched, or
    // foreign endpoint fails here, and cowork stops.
    try {
      await assertDaemonStateDir(resolved);
    } catch (error) {
      throw new Error(
        `the external ours daemon at ${this.endpoint} is unavailable or does not own ${this.daemonStateDir}`,
        { cause: error },
      );
    }
    this.Client = OursClient;
    this.resolved = resolved;
    this.watchClient = this.createClient(this.watchLeaseToken);
  }

  createClient(leaseToken = `cowork-${randomBytes(16).toString('hex')}`): OursClient {
    if (!this.Client || !this.resolved) throw new Error('external ours daemon host is not booted');
    return new this.Client({
      url: this.resolved.baseUrl.value,
      leaseToken,
      ...(this.resolved.token === undefined ? {} : { apiToken: this.resolved.token.value }),
    });
  }

  onIdentityNotify(listener: (identityName: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  trackIdentity(identityName: string): () => void {
    if (!this.watchClient) throw new Error('external ours daemon host is not booted');
    const existing = this.watchers.get(identityName);
    if (existing) return () => this.untrack(identityName, existing);
    const controller = new AbortController();
    const watcher: IdentityWatcher = { controller, work: Promise.resolve() };
    watcher.work = this.follow(identityName, controller.signal);
    this.watchers.set(identityName, watcher);
    return () => this.untrack(identityName, watcher);
  }

  close(): void {
    // CoworkDaemon prefers shutdown(); this only satisfies the host contract
    // without pretending the asynchronous watcher teardown already happened.
  }

  async shutdown(): Promise<{ requiresProcessExit: boolean }> {
    if (this.closed) return { requiresProcessExit: false };
    this.closed = true;
    this.listeners.clear();
    const watchers = [...this.watchers.values()];
    this.watchers.clear();
    for (const watcher of watchers) watcher.controller.abort();
    await Promise.allSettled(watchers.map((watcher) => watcher.work));
    const client = this.watchClient;
    this.watchClient = undefined;
    this.Client = undefined;
    this.resolved = undefined;
    if (client) await client.releaseLease().catch(() => {});
    // Nothing native is owned here: the daemon is a separate process that keeps
    // running, so this worker can exit on its own terms.
    return { requiresProcessExit: false };
  }

  private untrack(identityName: string, watcher: IdentityWatcher): void {
    if (this.watchers.get(identityName) !== watcher) return;
    this.watchers.delete(identityName);
    watcher.controller.abort();
  }

  /**
   * Long-poll one identity forever, reconnecting with bounded backoff.
   *
   * A watch primes at the daemon's tip, so a reconnected watch never replays
   * what arrived while it was down. Losing those arrivals would be silent, so
   * every reconnect announces the identity once. The consumer's reaction to an
   * announcement is a full state refresh, which is exactly the recovery this
   * needs; it is idempotent and self-coalescing, so the extra announcement can
   * only cost one refresh.
   *
   * ORDER IS LOAD-BEARING. The resync is issued only AFTER the replacement
   * watch's request is already in flight, because that request is what fixes
   * the new tip. Announcing first would read the inbox at T0 and fix the tip at
   * T1 > T0, and anything arriving in between would be in neither — the very
   * gap this exists to close. This way every arrival lands in the refresh, on
   * the stream, or (harmlessly) in both.
   */
  private async follow(identityName: string, signal: AbortSignal): Promise<void> {
    let backoffMs = WATCH_RETRY_MIN_MS;
    let resyncPending = false;
    while (!signal.aborted) {
      const client = this.watchClient;
      if (!client) return;
      try {
        const stream = client.watchNotifications(identityName, { signal });
        // Starts the long poll; the tip is fixed by the daemon handling it.
        let step = stream.next();
        if (resyncPending) {
          resyncPending = false;
          this.announce(identityName);
        }
        for (let settled = await step; !settled.done; settled = await step) {
          backoffMs = WATCH_RETRY_MIN_MS;
          this.announce(identityName);
          step = stream.next();
        }
      } catch (error) {
        if (signal.aborted) return;
        // One resync per reconnection, not per failure: the backoff below is
        // what bounds how often a daemon that stays down is retried at all.
        resyncPending = true;
        this.log(`[${identityName}] external ours daemon notification watch failed:`, error);
      }
      if (signal.aborted) return;
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, WATCH_RETRY_MAX_MS);
    }
  }

  private announce(identityName: string): void {
    for (const listener of this.listeners) {
      try { listener(identityName); } catch (error) {
        this.log(`cowork SDK notification listener failed for ${identityName}:`, error);
      }
    }
  }
}

interface IdentityWatcher {
  readonly controller: AbortController;
  work: Promise<void>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolveSleep();
    }
  });
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
