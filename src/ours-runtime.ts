import { randomBytes } from 'node:crypto';

import type { AttachOursClientOptions, NotificationEvent, OursClient } from '@ours.network/sdk';

import type { CoworkConfig } from './config.ts';

const WATCH_RETRY_MIN_MS = 500;
const WATCH_RETRY_MAX_MS = 30_000;

export interface OursRuntimeClientFactory {
  createClient(leaseToken?: string): Promise<OursClient>;
  /** Return only daemon identities whose names are in cowork's durable room set. */
  listIdentityNames(localNames: ReadonlySet<string>): Promise<Set<string>>;
  onIdentityNotify(listener: (identityName: string, event?: NotificationEvent) => void | Promise<void>): () => void;
  onResourceHealth?(listener: (identityName: string, healthy: boolean, pending?: boolean) => void): () => void;
  trackIdentity(identityName: string): () => void;
}

/** The full contract `CoworkDaemon` owns: a client factory with a lifecycle. */
export interface OursRuntimeHost extends OursRuntimeClientFactory {
  boot(): Promise<void>;
  close(): void;
  quiesce(): Promise<void>;
  shutdown(): Promise<{ requiresProcessExit: boolean }>;
}

type AttachClient = (options?: AttachOursClientOptions) => Promise<OursClient>;

const attachSharedClient: AttachClient = async (options) => {
  const { attachOursClient } = await import('@ours.network/sdk');
  return attachOursClient(options);
};

/**
 * Cowork is always a client of the one shared ours daemon. The cowork config is
 * intentionally not a daemon selection surface. V1 selection adapts explicit
 * daemon environment inputs to the official SDK; legacy selection stays there too.
 */
export function createOursHost(
  config: CoworkConfig,
  log: (...parts: unknown[]) => void = () => {},
  registerOwner?: (owner: string) => Promise<void>,
): OursRuntimeHost {
  return new SharedOursHost(log, attachSharedClient, process.env, registerOwner, config.consumer_commands !== undefined);
}

export class SharedOursHost implements OursRuntimeHost {
  private readonly log: (...parts: unknown[]) => void;
  private readonly attach: AttachClient;
  private readonly listeners = new Set<(identityName: string, event?: NotificationEvent) => void | Promise<void>>();
  private readonly watchers = new Map<string, IdentityWatcher>();
  private readonly watchWork = new Set<Promise<void>>();
  private readonly environment: NodeJS.ProcessEnv;
  private selection?: AttachOursClientOptions;
  private readonly watchLeaseToken = `cowork-watch-${randomBytes(16).toString('hex')}`;
  private watchClient?: OursClient;
  private readonly healthListeners = new Set<(identityName: string, healthy: boolean, pending?: boolean) => void>();
  private closed = false;

  constructor(
    log: (...parts: unknown[]) => void = () => {},
    attach: AttachClient = attachSharedClient,
    environment: NodeJS.ProcessEnv = process.env,
    private readonly registerOwner?: (owner: string) => Promise<void>,
    private readonly requireDynamicCatalogs = false,
  ) {
    this.log = log;
    this.attach = attach;
    this.environment = { ...environment };
  }

  async boot(): Promise<void> {
    if (this.watchClient) return;
    if (this.closed) throw new Error('shared ours daemon host cannot restart in the same process');
    this.selection = sharedSelection(this.environment);
    await this.registerOwner?.(this.watchLeaseToken);
    const client = await this.attach({ ...this.selection, leaseToken: this.watchLeaseToken });
    try {
      if (this.requireDynamicCatalogs) {
        const { version } = await client.version();
        const parts = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
        const [major, minor, patch] = parts ? parts.slice(1, 4).map(Number) : [0, 0, 0];
        if (!(major! > 3 || (major === 3 && (minor! > 7 || (minor === 7 && (patch! > 2 || (patch === 2 && !parts?.[4]))))))) {
          throw new Error('consumer commands require shared daemon SDK 3.7.2 or newer (ours CLI 2.7.2)');
        }
      }
      this.watchClient = client;
    } catch (error) {
      try { await client.releaseLease(); } finally { await client.close(); }
      throw error;
    }
  }

  async createClient(leaseToken = `cowork-${randomBytes(16).toString('hex')}`): Promise<OursClient> {
    if (!this.watchClient) throw new Error('shared ours daemon host is not booted');
    await this.registerOwner?.(leaseToken);
    return this.attach({ ...this.selection, leaseToken });
  }

  async listIdentityNames(localNames: ReadonlySet<string>): Promise<Set<string>> {
    if (!this.watchClient) throw new Error('shared ours daemon host is not booted');
    const rows = await this.watchClient.identities();
    return new Set(rows.flatMap((row) => localNames.has(row.name) ? [row.name] : []));
  }

  onIdentityNotify(listener: (identityName: string, event?: NotificationEvent) => void | Promise<void>): () => void {
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
    this.watchWork.add(watcher.work);
    void watcher.work.then(
      () => this.watchWork.delete(watcher.work),
      () => this.watchWork.delete(watcher.work),
    );
    this.watchers.set(identityName, watcher);
    return () => this.untrack(identityName, watcher);
  }

  close(): void {
    // CoworkDaemon calls shutdown(); this method only satisfies the structural
    // lifecycle contract without hiding asynchronous watcher teardown.
  }

  async quiesce(): Promise<void> {
    this.listeners.clear();
    this.healthListeners.clear();
    const watchers = [...this.watchers.values()];
    this.watchers.clear();
    for (const watcher of watchers) watcher.controller.abort();
    // untrack aborts a watcher before shutdown; retain its work until it settles.
    await Promise.allSettled([...this.watchWork]);
  }

  async shutdown(): Promise<{ requiresProcessExit: boolean }> {
    if (this.closed) return { requiresProcessExit: false };
    this.closed = true;
    await this.quiesce();
    const client = this.watchClient;
    this.watchClient = undefined;
    if (client) {
      try {
        const result = await client.releaseLease();
        if (result.failed > 0) throw new Error('shared watcher lease cleanup incomplete');
      } finally { await client.close(); }
    }
    // The shared daemon remains owned by its operator/CLI and keeps running.
    return { requiresProcessExit: false };
  }

  private untrack(identityName: string, watcher: IdentityWatcher): void {
    if (this.watchers.get(identityName) !== watcher) return;
    this.watchers.delete(identityName);
    watcher.controller.abort();
    this.health(identityName, true);
  }

  onResourceHealth(listener: (identityName: string, healthy: boolean, pending?: boolean) => void): () => void {
    this.healthListeners.add(listener); return () => this.healthListeners.delete(listener);
  }
  private health(identityName: string, healthy: boolean, pending = false): void {
    for (const listener of this.healthListeners) { try { listener(identityName, healthy, pending); } catch {} }
  }

  /** Subscribe before canonical admission/intake drain. Cursor belongs to this
   * watcher, not a recreated notification generator, including empty pages. */
  private async follow(identityName: string, signal: AbortSignal): Promise<void> {
    let backoffMs = WATCH_RETRY_MIN_MS;
    let cursor: number | undefined;
    while (!signal.aborted) {
      const client = this.watchClient;
      if (!client) return;
      const attempt = new AbortController();
      const lifetime = AbortSignal.any([signal, attempt.signal]);
      this.health(identityName, false);
      let notificationWork: Promise<void> | undefined;
      let rejectWork!: (error: unknown) => void;
      const workFailure = new Promise<never>((_, reject) => { rejectWork = reject; });
      void workFailure.catch(() => {});
      let observation: Promise<void> | undefined;
      let canonicalWork: Promise<void> | undefined;
      let canonicalDirty = false;
      let intakePending = false;
      const publish = () => {
        if (!lifetime.aborted) this.health(identityName, true, canonicalDirty || canonicalWork !== undefined || intakePending);
      };
      const drain = async () => {
        while (!lifetime.aborted) {
          const page = await client.readNotificationPage(identityName, { since: cursor, signal: lifetime });
          // Commit the explicit page position only after every callback succeeds.
          if (page.events.length) {
            intakePending = true; publish();
            for (const event of page.events) await this.announce(identityName, event as NotificationEvent);
            if (lifetime.aborted) return;
            intakePending = false; publish();
          }
          cursor = page.cursor;
          // Canonical reconciliation alone does not prove the drain recovered:
          // a poison page/callback must retain the consecutive-failure backoff.
          backoffMs = WATCH_RETRY_MIN_MS;
        }
      };
      // Consume source coverage independently of slow admission/intake. Commits
      // coalesce into one pending pass rather than retaining frames or callbacks.
      const scheduleCanonical = () => {
        canonicalDirty = true;
        publish();
        if (canonicalWork || lifetime.aborted) return;
        canonicalWork = (async () => {
          while (canonicalDirty && !lifetime.aborted) {
            canonicalDirty = false;
            // Capture tip before recovery; retain the admitted cursor on retries.
            if (cursor === undefined) {
              const tip = await client.readNotificationPage(identityName, { since: 'tip', signal: lifetime });
              if (lifetime.aborted) return;
              cursor = tip.cursor;
            }
            await this.announce(identityName);
            if (lifetime.aborted) return;
            if (!notificationWork) { notificationWork = drain(); void notificationWork.catch(rejectWork); }
          }
          if (lifetime.aborted) return;
          // Only successful canonical intake clears pending certification.
        })();
        void canonicalWork.then(() => {
          canonicalWork = undefined;
          publish();
          if (canonicalDirty && !lifetime.aborted) scheduleCanonical();
        }, rejectWork);
      };
      try {
        const observe = async () => {
          for await (const frame of client.resourceEvents(identityName, { signal: lifetime })) {
            if (frame.kind === 'resync') throw Error('resource continuity lost');
            if (frame.kind === 'ready' || frame.kind === 'committed') scheduleCanonical();
          }
          if (!lifetime.aborted) throw Error('resource observation ended');
        };
        observation = observe();
        await Promise.race([observation, workFailure]);
      } catch (error) {
        if (!signal.aborted) this.log(`[${identityName}] shared resource observation failed:`, error);
      } finally {
        if (!signal.aborted) this.health(identityName, false); attempt.abort();
        await Promise.allSettled([...(notificationWork ? [notificationWork] : []), ...(observation ? [observation] : []), ...(canonicalWork ? [canonicalWork] : [])]);
      }
      if (signal.aborted) return;
      await sleep(backoffMs, signal); backoffMs = Math.min(backoffMs * 2, WATCH_RETRY_MAX_MS);
    }
  }

  private async announce(identityName: string, event?: NotificationEvent): Promise<void> {
    for (const listener of this.listeners) {
      try { await listener(identityName, event); } catch (error) {
        this.log(`cowork SDK notification listener failed for ${identityName}:`, error);
        throw error;
      }
    }
  }
}

function sharedSelection(env: NodeJS.ProcessEnv): AttachOursClientOptions {
  const endpoint = env.OURS_DAEMON_URL;
  const expectedInstanceId = env.OURS_DAEMON_ID;
  const credentialPath = env.OURS_DAEMON_CREDENTIAL_PATH;
  if ([endpoint, expectedInstanceId, credentialPath].some(value => value !== undefined)) {
    if (!endpoint || !expectedInstanceId || !credentialPath) {
      throw new Error('V1 selection requires OURS_DAEMON_URL, OURS_DAEMON_ID and OURS_DAEMON_CREDENTIAL_PATH');
    }
    return { endpoint, expectedInstanceId, credentialPath, sessionMode: 'external', env };
  }
  return { env };
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
