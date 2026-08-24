import { randomBytes } from 'node:crypto';

import type { AttachOursClientOptions, OursClient } from '@ours.network/sdk';

import type { CoworkConfig } from './config.ts';

const WATCH_RETRY_MIN_MS = 500;
const WATCH_RETRY_MAX_MS = 30_000;
const STATE_RESYNC_INTERVAL_MS = 2_000;

export interface OursRuntimeClientFactory {
  createClient(leaseToken?: string): Promise<OursClient>;
  /** Return only daemon identities whose names are in cowork's durable room set. */
  listIdentityNames(localNames: ReadonlySet<string>): Promise<Set<string>>;
  onIdentityNotify(listener: (identityName: string) => void): () => void;
  trackIdentity(identityName: string): () => void;
}

/** The full contract `CoworkDaemon` owns: a client factory with a lifecycle. */
export interface OursRuntimeHost extends OursRuntimeClientFactory {
  boot(): Promise<void>;
  close(): void;
  shutdown(): Promise<{ requiresProcessExit: boolean }>;
}

type AttachClient = (options?: AttachOursClientOptions) => Promise<OursClient>;

const attachSharedClient: AttachClient = async (options) => {
  const { attachOursClient } = await import('@ours.network/sdk');
  return attachOursClient(options);
};

/**
 * Cowork is always a client of the one shared ours daemon. The cowork config is
 * intentionally not a daemon selection surface: SDK 3 resolves the ordinary
 * ours configuration/environment and proves endpoint/state-root coherence.
 */
export function createOursHost(
  _config: CoworkConfig,
  log: (...parts: unknown[]) => void = () => {},
): OursRuntimeHost {
  return new SharedOursHost(log);
}

export class SharedOursHost implements OursRuntimeHost {
  private readonly log: (...parts: unknown[]) => void;
  private readonly attach: AttachClient;
  private readonly listeners = new Set<(identityName: string) => void>();
  private readonly watchers = new Map<string, IdentityWatcher>();
  private readonly watchLeaseToken = `cowork-watch-${randomBytes(16).toString('hex')}`;
  private watchClient?: OursClient;
  private resyncTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    log: (...parts: unknown[]) => void = () => {},
    attach: AttachClient = attachSharedClient,
  ) {
    this.log = log;
    this.attach = attach;
  }

  async boot(): Promise<void> {
    if (this.watchClient) return;
    if (this.closed) throw new Error('shared ours daemon host cannot restart in the same process');
    this.watchClient = await this.attach({ leaseToken: this.watchLeaseToken });
  }

  async createClient(leaseToken = `cowork-${randomBytes(16).toString('hex')}`): Promise<OursClient> {
    if (!this.watchClient) throw new Error('shared ours daemon host is not booted');
    return this.attach({ leaseToken });
  }

  async listIdentityNames(localNames: ReadonlySet<string>): Promise<Set<string>> {
    if (!this.watchClient) throw new Error('shared ours daemon host is not booted');
    const rows = await this.watchClient.identities();
    return new Set(rows.flatMap((row) => localNames.has(row.name) ? [row.name] : []));
  }

  onIdentityNotify(listener: (identityName: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  trackIdentity(identityName: string): () => void {
    if (!this.watchClient) throw new Error('shared ours daemon host is not booted');
    const existing = this.watchers.get(identityName);
    if (existing) return () => this.untrack(identityName, existing);
    const controller = new AbortController();
    const watcher: IdentityWatcher = { controller, work: Promise.resolve() };
    watcher.work = this.follow(identityName, controller.signal);
    this.watchers.set(identityName, watcher);
    // SDK 3's structured notification log covers inbox work but not every
    // contact-state transition (notably contact_accepted). Reconcile once now
    // and periodically while the long poll supplies the low-latency path.
    this.announce(identityName);
    this.ensureStateResync();
    return () => this.untrack(identityName, watcher);
  }

  close(): void {
    // CoworkDaemon calls shutdown(); this method only satisfies the structural
    // lifecycle contract without hiding asynchronous watcher teardown.
  }

  async shutdown(): Promise<{ requiresProcessExit: boolean }> {
    if (this.closed) return { requiresProcessExit: false };
    this.closed = true;
    this.listeners.clear();
    this.stopStateResync();
    const watchers = [...this.watchers.values()];
    this.watchers.clear();
    for (const watcher of watchers) watcher.controller.abort();
    await Promise.allSettled(watchers.map((watcher) => watcher.work));
    const client = this.watchClient;
    this.watchClient = undefined;
    if (client) await client.releaseLease();
    // The shared daemon remains owned by its operator/CLI and keeps running.
    return { requiresProcessExit: false };
  }

  private untrack(identityName: string, watcher: IdentityWatcher): void {
    if (this.watchers.get(identityName) !== watcher) return;
    this.watchers.delete(identityName);
    watcher.controller.abort();
    if (this.watchers.size === 0) this.stopStateResync();
  }

  private ensureStateResync(): void {
    if (this.resyncTimer) return;
    this.resyncTimer = setInterval(() => {
      for (const identityName of this.watchers.keys()) this.announce(identityName);
    }, STATE_RESYNC_INTERVAL_MS);
    this.resyncTimer.unref();
  }

  private stopStateResync(): void {
    if (!this.resyncTimer) return;
    clearInterval(this.resyncTimer);
    this.resyncTimer = undefined;
  }

  /**
   * Long-poll one identity forever, reconnecting with bounded backoff.
   *
   * A replacement stream primes at the daemon tip, so each reconnection also
   * requests a full state resync. The periodic resync above covers the small
   * request-prime race and daemon transitions that are not in the structured
   * notification log; reconciliation is idempotent and self-coalescing.
   */
  private async follow(identityName: string, signal: AbortSignal): Promise<void> {
    let backoffMs = WATCH_RETRY_MIN_MS;
    let resyncPending = false;
    while (!signal.aborted) {
      const client = this.watchClient;
      if (!client) return;
      try {
        const stream = client.watchNotifications(identityName, { signal });
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
        if (!signal.aborted) {
          resyncPending = true;
          this.log(`[${identityName}] shared ours daemon notification watch ended; reconnecting`);
        }
      } catch (error) {
        if (signal.aborted) return;
        resyncPending = true;
        this.log(`[${identityName}] shared ours daemon notification watch failed:`, error);
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
