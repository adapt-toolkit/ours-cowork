export interface Poller {
  start(): void;
  refresh(): Promise<void>;
  stop(): void;
}

export interface PollClock {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export function createPoller(options: {
  intervalMs: number;
  visible: () => boolean;
  run: (signal: AbortSignal) => Promise<void>;
  clock?: PollClock;
}): Poller {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new TypeError('poll interval must be positive');
  }

  interface ActiveRun {
    generation: number;
    controller: AbortController;
    dirty: boolean;
    promise: Promise<void>;
  }

  let started = false;
  let generation = 0;
  const clock: PollClock = options.clock ?? {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: ActiveRun | undefined;

  function request(expectedGeneration: number): Promise<void> {
    if (!started || generation !== expectedGeneration || !options.visible()) return Promise.resolve();
    if (active?.generation === expectedGeneration) {
      active.dirty = true;
      return active.promise;
    }

    const current: ActiveRun = {
      generation: expectedGeneration,
      controller: new AbortController(),
      dirty: false,
      promise: Promise.resolve(),
    };
    active = current;
    current.promise = execute(current);
    return current.promise;
  }

  async function execute(current: ActiveRun): Promise<void> {
    try {
      do {
        current.dirty = false;
        try {
          await options.run(current.controller.signal);
        } catch (error) {
          if (!started || generation !== current.generation || current.controller.signal.aborted) return;
          throw error;
        }
      } while (current.dirty
        && started
        && generation === current.generation
        && options.visible());
    } finally {
      if (active === current) active = undefined;
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      const currentGeneration = ++generation;
      timer = clock.setInterval(() => {
        void request(currentGeneration).catch(() => undefined);
      }, options.intervalMs);
    },
    refresh() {
      return request(generation);
    },
    stop() {
      if (!started) return;
      started = false;
      generation += 1;
      if (timer !== undefined) clock.clearInterval(timer);
      timer = undefined;
      const stoppedRun = active;
      active = undefined;
      stoppedRun?.controller.abort();
    },
  };
}
