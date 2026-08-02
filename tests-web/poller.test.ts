import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPoller } from '../web/src/state/poller';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('createPoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([5_000, 2_000])('runs on a %i ms cadence', async (intervalMs) => {
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs, visible: () => true, run });

    poller.start();
    await vi.advanceTimersByTimeAsync(intervalMs - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(run).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('pauses while hidden and resumes on the next visible cadence', async () => {
    let visible = false;
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs: 2_000, visible: () => visible, run });

    poller.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run).not.toHaveBeenCalled();
    visible = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it('refreshes immediately without shifting the cadence', async () => {
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs: 5_000, visible: () => true, run });

    poller.start();
    await poller.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('coalesces overlapping requests into exactly one replacement run', async () => {
    const first = deferred();
    const run = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const poller = createPoller({ intervalMs: 5_000, visible: () => true, run });
    poller.start();

    const initial = poller.refresh();
    const overlapOne = poller.refresh();
    const overlapTwo = poller.refresh();
    expect(run).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.all([initial, overlapOne, overlapTwo]);
    expect(run).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('aborts an active run and cancels future cadence on stop', async () => {
    let observedSignal: AbortSignal | undefined;
    const run = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      observedSignal = signal;
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const poller = createPoller({ intervalMs: 2_000, visible: () => true, run });
    poller.start();

    const active = poller.refresh();
    poller.stop();

    await expect(active).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale generation rejection after stop and restart', async () => {
    const oldRun = deferred();
    const run = vi.fn()
      .mockImplementationOnce(() => oldRun.promise)
      .mockResolvedValue(undefined);
    const poller = createPoller({ intervalMs: 2_000, visible: () => true, run });
    poller.start();

    const stale = poller.refresh();
    poller.stop();
    poller.start();
    await poller.refresh();
    oldRun.reject(new Error('stale failure'));

    await expect(stale).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});
