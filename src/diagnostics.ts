import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import { PRIVATE_ROOM_RPC_METHODS, ROOM_RPC_METHODS } from './openapi.ts';

/**
 * Opt-in operation trace for telling apart which step of a room operation
 * failed or waited: an RPC or startup phase, the room mutex wait and hold, an
 * intake stage, and the concrete SDK call beneath it.
 *
 * Absent by default. Every hook is `trace?.…` or `traced(undefined, …)`, which
 * runs the original code. A trace adds no I/O, await, timer, retry or lock; it
 * returns the traced promise itself and never replaces its result or error.
 * Records hold only finite labels, local integer IDs, monotonic milliseconds
 * and allowlisted error names and codes, never arguments, results, bodies,
 * identities, room or wire IDs, paths, messages or stacks. When a cap is
 * reached the trace drops records and counts them; the evidence is then
 * incomplete, the operation is unaffected.
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
  outcome: 'ok' | 'error' | 'open';
  error_name: string | null;
  error_code: string | null;
  cause_code: string | null;
}

export interface TraceLimits { maxRecords: number; maxActive: number }

export interface TraceSnapshot {
  limits: TraceLimits;
  records: TraceRecord[];
  /** Spans not recorded because maxRecords was reached. */
  omitted: number;
  /** Spans not recorded because maxActive spans were open. */
  dropped_active: number;
  /** Recorded spans still open when the snapshot was taken. */
  open: number;
  complete: boolean;
}

export const DEFAULT_TRACE_LIMITS: TraceLimits = { maxRecords: 2048, maxActive: 256 };

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
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
      if (key !== 'name') return undefined;
      target = Object.getPrototypeOf(target);
    }
    return undefined;
  } catch { return undefined; }
}

export class OperationTrace {
  readonly limits: TraceLimits;
  private readonly now: () => number;
  private readonly origin: number;
  private readonly current = new AsyncLocalStorage<number>();
  private readonly records: TraceRecord[] = [];
  private readonly active = new Map<number, TraceRecord>();
  private nextId = 1;
  private omitted = 0;
  private droppedActive = 0;

  constructor(limits: Partial<TraceLimits> = {}, now: () => number = () => performance.now()) {
    this.limits = { ...DEFAULT_TRACE_LIMITS, ...limits };
    this.now = now;
    this.origin = now();
  }

  /** Open a span under the current one; 0 when a cap dropped it. Never throws. */
  start(kind: SpanKind, label: string, attempt = 1): number {
    try {
      if (this.records.length >= this.limits.maxRecords) { this.omitted += 1; return 0; }
      if (this.active.size >= this.limits.maxActive) { this.droppedActive += 1; return 0; }
      const record: TraceRecord = {
        id: this.nextId++,
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
      this.records.push(record);
      this.active.set(record.id, record);
      return record.id;
    } catch { return 0; }
  }

  /** Close a span; `failed` with the error it settled with. Never throws. */
  finish(id: number, failed = false, error?: unknown): void {
    try {
      const record = this.active.get(id);
      if (!record) return;
      this.active.delete(id);
      record.end_ms = this.elapsed();
      record.outcome = failed ? 'error' : 'ok';
      if (failed) {
        record.error_name = finite(ERROR_NAMES, own(error, 'name')) ?? 'none';
        record.error_code = finite(ERROR_CODES, own(error, 'code')) ?? 'none';
        record.cause_code = finite(ERROR_CODES, own(own(error, 'cause'), 'code')) ?? 'none';
      }
    } catch { /* the observer never affects the operation */ }
  }

  /** A completed zero-length span, for decisions such as a coalesced pump. */
  mark(kind: SpanKind, label: string): void {
    this.finish(this.start(kind, label));
  }

  /** Run `work` with span `id` as the parent of spans it starts. */
  within<T>(id: number, work: () => T): T {
    return id === 0 ? work() : this.current.run(id, work);
  }

  snapshot(): TraceSnapshot {
    const records = this.records.map((record) => ({ ...record }));
    const open = records.filter((record) => record.outcome === 'open').length;
    return {
      limits: { ...this.limits },
      records,
      omitted: this.omitted,
      dropped_active: this.droppedActive,
      open,
      complete: this.omitted === 0 && this.droppedActive === 0 && open === 0,
    };
  }

  private elapsed(): number {
    return Math.round((this.now() - this.origin) * 1000) / 1000;
  }
}

/**
 * Trace one step. Without a trace this is exactly `work()`. With one, the
 * same value or promise is returned; a promise's span is closed by a handler
 * that cannot reject, so tracing adds no unhandled rejection.
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
  if (id !== 0) {
    if (result instanceof Promise) {
      Promise.prototype.then.call(result, () => trace.finish(id), (error: unknown) => trace.finish(id, true, error));
    } else {
      trace.finish(id);
    }
  }
  return result;
}
