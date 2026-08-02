import { describe, expect, it, vi } from 'vitest';

import { RpcError, rpcCall, rpcTimeoutForMethod } from '../web/src/api/rpc';

function rpcResponse(request: RequestInit, value: Record<string, unknown>) {
  const id = JSON.parse(String(request.body)).id as string;
  return Promise.resolve({
    ok: true,
    json: async () => ({ version: 1, id, ...value }),
  } as Response);
}

function abortedRequest(): Promise<Response> {
  return Promise.reject(new DOMException('aborted', 'AbortError'));
}

describe('rpcCall', () => {
  it('sends the exact same-origin envelope and gives every call a unique web ID', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      rpcResponse(init!, { result: { ok: true } }));

    await Promise.all([
      rpcCall('room.message', { room_id: 'r1', text: 'hello' }, { fetch, timeoutMs: 25 }),
      rpcCall('room.message', { room_id: 'r1', text: 'again' }, { fetch, timeoutMs: 25 }),
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
    const requests = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests[0]).toEqual({
      version: 1,
      id: expect.stringMatching(/^web-/),
      method: 'room.message',
      params: { room_id: 'r1', text: 'hello' },
    });
    expect(requests[1].id).not.toBe(requests[0].id);
    expect(fetch.mock.calls[0][0]).toBe('/rpc');
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
    });
  });

  it('requires an exact version and request-ID correlation', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: 1, id: 'web-another-call', result: true }),
    } as Response));

    await expect(rpcCall('room.list', {}, { fetch })).rejects.toMatchObject({
      name: 'RpcError',
      code: 'invalid_response',
      outcomeUnknown: false,
    });
  });

  it('preserves daemon error code/message as a confirmed RpcError', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      rpcResponse(init!, { error: { code: 'invalid_state', message: 'room is closed' } }));

    const failure = rpcCall('room.message', { room_id: 'r1', text: 'hello' }, { fetch });
    await expect(failure).rejects.toEqual(expect.objectContaining({
      name: 'RpcError',
      code: 'invalid_state',
      message: 'room is closed',
      outcomeUnknown: false,
    }));
  });

  it('aborts at the deadline and reports a mutation outcome as unknown without retrying', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }));

      const result = rpcCall('room.message', { room_id: 'r1', text: 'hello' }, { fetch, timeoutMs: 25 });
      const assertion = expect(result).rejects.toMatchObject({
        name: 'RpcError',
        code: 'timeout',
        outcomeUnknown: true,
      });
      await vi.advanceTimersByTimeAsync(25);

      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors a caller abort and never retries the request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) return abortedRequest();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const result = rpcCall('room.list', {}, { fetch, signal: controller.signal });

    controller.abort();

    await expect(result).rejects.toMatchObject({
      name: 'RpcError',
      code: 'aborted',
      outcomeUnknown: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('rpcTimeoutForMethod', () => {
  it('matches CLI native-mutation and read deadlines', () => {
    for (const method of [
      'room.create', 'room.invite', 'room.revoke', 'room.message',
      'room.close', 'room.recover', 'room.recover.confirm',
    ]) expect(rpcTimeoutForMethod(method)).toBe(120_000);
    for (const method of [
      'room.list', 'room.show', 'room.participants', 'room.history',
      'room.settings', 'room.delete',
    ]) expect(rpcTimeoutForMethod(method)).toBe(10_000);
  });
});
