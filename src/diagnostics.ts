import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';

import { PRIVATE_ROOM_RPC_METHODS, ROOM_RPC_METHODS } from './openapi.ts';

/**
 * Opt-in operation trace for telling apart which step of a room operation
 * failed or waited: an RPC or startup phase, the room mutex wait and hold, an
 * intake stage, and the concrete SDK call beneath it.
 *
 * Absent by default. Every hook is `trace?.…` or `traced(undefined, …)`, which
 * runs the original code. A trace adds no I/O, await, timer, retry or lock.
 * The traced step runs exactly once and the caller receives its own value,
 * promise or thrown error; observation runs separately, never throws, and
 * follows only plain native promises of this realm to settlement. Anything
 * else is left untouched and recorded as unobserved.
 *
 * Records hold only finite labels, local integer IDs, monotonic milliseconds
 * and allowlisted error names and codes, never arguments, results, bodies,
 * identities, room or wire IDs, paths, messages or stacks. Limits are
 * validated once and capped at hard maxima. A cap, an internal failure, a bad
 * clock reading or an unobserved step makes the snapshot incomplete; the
 * operation itself is unaffected.
 */

export type SpanKind =
  | 'phase' | 'rpc_request' | 'rpc' | 'rpc_response' | 'mutex_wait' | 'mutex_hold' | 'pump' | 'intake_stage' | 'sdk';

const LABELS: Readonly<Record<SpanKind, ReadonlySet<string>>> = {
  phase: new Set(['restore', 'reconcile', 'close', 'fanout', 'fanout_retry']),
  // Management method names come from the fixed route tables; any other is 'other'.
  rpc: new Set([...ROOM_RPC_METHODS, ...PRIVATE_ROOM_RPC_METHODS].map((entry) => entry.method)
    .concat(['daemon.status', 'daemon.shutdown'])),
  rpc_request: new Set(['unix']),
  rpc_response: new Set(['write_issued', 'socket_destroyed']),
  mutex_wait: new Set(['room']),
  mutex_hold: new Set(['room']),
  // pump_run: this call runs the pump; pump_joined: it awaits a running pump;
  // pump_reentrant: called from inside that pump, returns without waiting;
  // resume_coalesced: resumePending marked a running pump dirty and returned.
  pump: new Set(['pump_run', 'pump_joined', 'pump_reentrant', 'resume_coalesced']),
  intake_stage: new Set([
    'drain_commands', 'list_messages', 'list_files', 'persist_message', 'ack_message', 'persist_file', 'relay',
  ]),
  sdk: new Set([
    'choose_identity', 'list_contacts', 'list_invites', 'generate_invite', 'add_contact', 'revoke_invite',
    'register_commands', 'list_incoming_messages', 'get_messages', 'get_history_item', 'list_incoming_files',
    'fetch_file', 'get_files', 'send_message', 'send_file', 'remove_contact',
  ]),
};

const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'AbortError', 'TimeoutError', 'SocketError',
  'OursError', 'DaemonSelectionError', 'DaemonUnavailableError', 'ZodError', 'RoomServiceError', 'CoworkStorageError',
  'RoomIdentityMismatchError', 'ContactAlreadyAbsentError', 'SqliteError',
]);

const ERROR_CODES = new Set([
  // fetch/undici and socket errors
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED', 'UND_ERR_ABORTED', 'UND_ERR_INFO', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOENT',
  'EACCES', 'ABORT_ERR',
  // OursError codes of the pinned SDK
  'BINDING_REASSIGNED', 'BOUND_ELSEWHERE', 'BOUND_IDENTITY_GONE', 'CONNECTOR_TOO_OLD', 'DELETE_PARTIAL', 'DUPLICATE_ID',
  'FILE_TOO_LARGE', 'FILE_UNREADABLE', 'IDENTITY_QUARANTINED', 'INVALID_OBSERVATION', 'INVALID_SELECTION',
  'MALFORMED_ID', 'NAME_TAKEN', 'NOT_BOUND', 'NOT_BOUND_NO_NAME', 'NO_LEASE_HEADERS', 'NO_LEASE_TOKEN', 'NO_ROOT',
  'NO_SUCH_IDENTITY', 'SEND_ARGS', 'UNKNOWN_OR_STALE_ID',
  // storage
  'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR', 'SQLITE_CORRUPT', 'SQLITE_FULL',
]);

export interface TraceRecord {
  id: number;
  /** Enclosing span when this one started, 0 at top level. */
  parent: number;
  kind: SpanKind;
  label: string;
  /** 1 for a first SDK call, 2 for its repeat after a lease rebind. */
  attempt: number;
  start_ms: number;
  end_ms: number | null;
  /** `unobserved`: the step returned something other than a plain native promise; its settlement is unknown. */
  outcome: 'ok' | 'error' | 'open' | 'unobserved';
  error_name: string | null;
  error_code: string | null;
  cause_code: string | null;
}

export interface TraceLimits { readonly maxRecords: number; readonly maxActive: number }

export interface TraceSnapshot {
  /** The limits actually enforced. */
  limits: TraceLimits;
  records: TraceRecord[];
  /** Spans not recorded because maxRecords was reached. */
  omitted: number;
  /** Spans not recorded because maxActive spans were open. */
  dropped_active: number;
  /** Recorded spans still open when the snapshot was taken. */
  open: number;
  /** Recorded spans whose settlement the trace could not observe. */
  unobserved: number;
  /** Internal trace failures, e.g. a throwing clock; each may have lost or damaged a record. */
  observer_failures: number;
  /** Clock readings that were not finite or ran backwards; the previous reading was used instead. */
  invalid_times: number;
  /** True only when every started span was recorded, settled and observed without a failure. */
  complete: boolean;
}

/** Hard maxima. A trace may be configured lower, never higher. */
export const DEFAULT_TRACE_LIMITS: TraceLimits = Object.freeze({ maxRecords: 2048, maxActive: 256 });

/**
 * One validated limit: absent means the hard maximum, an integer above it is
 * clamped to it, and anything else (fractional, below 1, NaN, infinite or not
 * a number) is rejected when the trace is created.
 */
function validLimit(value: unknown, name: keyof TraceLimits): number {
  const hard = DEFAULT_TRACE_LIMITS[name];
  if (value === undefined) return hard;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`trace ${name} must be an integer of at least 1`);
  }
  return Math.min(value, hard);
}

/** A finite label for a value from a fixed set, never the value itself. */
function finite(allowed: ReadonlySet<string>, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && allowed.has(value) ? value : 'other';
}

/** A data property of an error or its prototypes; a getter is application code the observer must not run. */
function own(value: unknown, key: 'name' | 'code' | 'cause'): unknown {
  try {
    let target: unknown = value;
    for (let depth = 0; depth < 8; depth += 1) {
      if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return undefined;
      if (types.isProxy(target)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
      if (key !== 'name') return undefined;
      target = Object.getPrototypeOf(target);
    }
    return undefined;
  } catch { return undefined; }
}

// Captured once, so later changes to the global Promise cannot redirect observation.
const nativeThen = Promise.prototype.then;
const nativePrototype = Promise.prototype;

/**
 * The supported boundary: a promise of this realm whose prototype is exactly
 * Promise.prototype, with no own `constructor` or `then`, and not a proxy.
 * Checked through internal slots and descriptors only, so no application
 * getter or trap runs. Subclasses, promises of another realm, proxies and
 * other thenables are left untouched and reported as unobserved.
 */
function isPlainNativePromise(value: unknown): value is Promise<unknown> {
  return types.isPromise(value)
    && !types.isProxy(value)
    && Object.getPrototypeOf(value) === nativePrototype
    && !Object.hasOwn(value, 'constructor')
    && !Object.hasOwn(value, 'then');
}

/** Whether a value may be a thenable, decided without running a getter or trap. */
function mayBeThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try {
    let target: unknown = value;
    for (let depth = 0; depth < 32 && target !== null; depth += 1) {
      // Any proxy on the chain, the value itself or an ancestor, would run its traps.
      if (types.isProxy(target)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(target, 'then');
      if (descriptor) return 'get' in descriptor || typeof descriptor.value === 'function';
      target = Object.getPrototypeOf(target);
    }
    return target !== null;
  } catch { return true; }
}

export class OperationTrace {
  private readonly enforced: TraceLimits;
  private readonly now: () => number;
  private readonly origin: number;
  private readonly current = new AsyncLocalStorage<number>();
  private readonly records: TraceRecord[] = [];
  private readonly active = new Map<number, TraceRecord>();
  private nextId = 1;
  private omitted = 0;
  private droppedActive = 0;
  private unobservedCount = 0;
  private observerFailures = 0;
  private invalidTimes = 0;
  private last = 0;

  constructor(limits: { maxRecords?: number; maxActive?: number } = {}, now: () => number = () => performance.now()) {
    // Each field is read exactly once; later changes to the argument have no effect.
    const maxRecords = limits.maxRecords;
    const maxActive = limits.maxActive;
    this.enforced = Object.freeze({
      maxRecords: validLimit(maxRecords, 'maxRecords'),
      maxActive: validLimit(maxActive, 'maxActive'),
    });
    this.now = now;
    let origin = 0;
    try {
      const reading = now();
      if (Number.isFinite(reading)) origin = reading; else this.invalidTimes += 1;
    } catch { this.observerFailures += 1; }
    this.origin = origin;
  }

  /** The limits this trace enforces, frozen. */
  get limits(): TraceLimits { return this.enforced; }

  /** Open a span under the current one; 0 when a cap or a failure dropped it. Never throws. */
  start(kind: SpanKind, label: string, attempt = 1): number {
    try {
      if (this.records.length >= this.enforced.maxRecords) { this.omitted += 1; return 0; }
      if (this.active.size >= this.enforced.maxActive) { this.droppedActive += 1; return 0; }
      const record: TraceRecord = {
        id: this.nextId,
        parent: this.current.getStore() ?? 0,
        kind,
        label: finite(LABELS[kind], label) ?? 'other',
        attempt: Number.isSafeInteger(attempt) && attempt > 0 && attempt < 100 ? attempt : 0,
        start_ms: this.elapsed(),
        end_ms: null,
        outcome: 'open',
        error_name: null,
        error_code: null,
        cause_code: null,
      };
      this.nextId += 1;
      this.records.push(record);
      this.active.set(record.id, record);
      return record.id;
    } catch {
      this.observerFailures += 1;
      return 0;
    }
  }

  /** Close a span; `failed` with the error it settled with. Never throws. */
  finish(id: number, failed = false, error?: unknown): void {
    try {
      const record = this.active.get(id);
      if (!record) return;
      const end = this.elapsed();
      if (failed) {
        record.error_name = finite(ERROR_NAMES, own(error, 'name')) ?? 'none';
        record.error_code = finite(ERROR_CODES, own(error, 'code')) ?? 'none';
        record.cause_code = finite(ERROR_CODES, own(own(error, 'cause'), 'code')) ?? 'none';
      }
      record.end_ms = end;
      record.outcome = failed ? 'error' : 'ok';
      this.active.delete(id);
    } catch {
      this.observerFailures += 1;
    }
  }

  /** A completed zero-length span, for decisions such as a coalesced pump. */
  mark(kind: SpanKind, label: string): void {
    this.finish(this.start(kind, label));
  }

  /** Run `work` with span `id` as the parent of spans it starts. */
  within<T>(id: number, work: () => T): T {
    return id === 0 ? work() : this.current.run(id, work);
  }

  /**
   * Close span `id` when `result` settles, without touching anything but a
   * plain native promise. Never throws and never changes `result`.
   */
  observe(id: number, result: unknown): void {
    if (id === 0) return;
    try {
      if (isPlainNativePromise(result)) {
        // Handlers cannot throw, so the derived promise always fulfils.
        Reflect.apply(nativeThen, result, [() => this.finish(id), (error: unknown) => this.finish(id, true, error)]);
      } else if (mayBeThenable(result)) {
        this.unobserved(id);
      } else {
        this.finish(id);
      }
    } catch {
      this.observerFailures += 1;
      this.unobserved(id);
    }
  }

  snapshot(): TraceSnapshot {
    const records = this.records.map((record) => ({ ...record }));
    const open = records.filter((record) => record.outcome === 'open').length;
    return {
      limits: this.enforced,
      records,
      omitted: this.omitted,
      dropped_active: this.droppedActive,
      open,
      unobserved: this.unobservedCount,
      observer_failures: this.observerFailures,
      invalid_times: this.invalidTimes,
      complete: this.omitted === 0 && this.droppedActive === 0 && open === 0 && this.unobservedCount === 0
        && this.observerFailures === 0 && this.invalidTimes === 0,
    };
  }

  private unobserved(id: number): void {
    try {
      const record = this.active.get(id);
      if (!record) return;
      record.outcome = 'unobserved';
      this.active.delete(id);
      this.unobservedCount += 1;
    } catch { this.observerFailures += 1; }
  }

  /** Milliseconds since creation, finite and never decreasing; a bad reading is counted and replaced. */
  private elapsed(): number {
    let reading: number;
    try { reading = this.now(); } catch { this.observerFailures += 1; return this.last; }
    const value = Math.round((reading - this.origin) * 1000) / 1000;
    if (!Number.isFinite(value) || value < this.last) { this.invalidTimes += 1; return this.last; }
    this.last = value;
    return value;
  }
}

/**
 * Trace one step. Without a trace this is exactly `work()`. With one, `work`
 * runs exactly once and its own value, promise or thrown error is what the
 * caller gets; observation is separate and cannot throw. Only a plain native
 * promise is followed to settlement; see `isPlainNativePromise`.
 */
export function traced<T>(
  trace: OperationTrace | undefined,
  kind: SpanKind,
  label: string,
  work: () => T,
  attempt = 1,
): T {
  if (!trace) return work();
  const id = trace.start(kind, label, attempt);
  let result: T;
  try {
    result = trace.within(id, work);
  } catch (error) {
    trace.finish(id, true, error);
    throw error;
  }
  trace.observe(id, result);
  return result;
}
