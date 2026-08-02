const READ_TIMEOUT_MS = 10_000;
const NATIVE_MUTATION_TIMEOUT_MS = 120_000;

const NATIVE_MUTATION_METHODS = new Set([
  'room.create',
  'room.invite',
  'room.revoke',
  'room.message',
  'room.close',
  'room.recover',
  'room.recover.confirm',
]);

const READ_METHODS = new Set([
  'room.list',
  'room.show',
  'room.participants',
  'room.history',
]);

let nextRequestId = 0;

export class RpcError extends Error {
  readonly code: string;
  readonly outcomeUnknown: boolean;

  constructor(code: string, message: string, outcomeUnknown: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RpcError';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export interface RpcCallOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function rpcTimeoutForMethod(method: string): number {
  return NATIVE_MUTATION_METHODS.has(method) ? NATIVE_MUTATION_TIMEOUT_MS : READ_TIMEOUT_MS;
}

export async function rpcCall<T>(
  method: string,
  params: Record<string, unknown>,
  options: RpcCallOptions = {},
): Promise<T> {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const requestId = `web-${Date.now().toString(36)}-${(++nextRequestId).toString(36)}`;
  const outcomeUnknown = !READ_METHODS.has(method);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? rpcTimeoutForMethod(method));

  try {
    const response = await fetchRequest('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ version: 1, id: requestId, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new RpcError('http_error', `RPC request failed with HTTP ${response.status}`, outcomeUnknown);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new RpcError('invalid_response', 'daemon returned invalid JSON', outcomeUnknown, { cause: error });
    }
    if (!isRpcResponse(payload, requestId)) {
      throw new RpcError('invalid_response', 'daemon returned an invalid or uncorrelated RPC response', outcomeUnknown);
    }
    if ('error' in payload) {
      throw new RpcError(payload.error.code, payload.error.message, false);
    }
    return payload.result as T;
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (timedOut) {
      throw new RpcError('timeout', 'daemon did not answer before the RPC deadline', outcomeUnknown, { cause: error });
    }
    if (controller.signal.aborted) {
      throw new RpcError('aborted', 'RPC request was aborted', outcomeUnknown, { cause: error });
    }
    throw new RpcError('daemon_unavailable', 'cowork daemon is unavailable', outcomeUnknown, { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

type RpcResponse =
  | { version: 1; id: string; result: unknown }
  | { version: 1; id: string; error: { code: string; message: string } };

function isRpcResponse(value: unknown, requestId: string): value is RpcResponse {
  if (!isRecord(value) || value.version !== 1 || value.id !== requestId) return false;
  const keys = Object.keys(value);
  if ('result' in value) {
    return !('error' in value)
      && keys.length === 3
      && keys.every((key) => key === 'version' || key === 'id' || key === 'result');
  }
  return keys.length === 3
    && keys.every((key) => key === 'version' || key === 'id' || key === 'error')
    && isRecord(value.error)
    && Object.keys(value.error).length === 2
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
