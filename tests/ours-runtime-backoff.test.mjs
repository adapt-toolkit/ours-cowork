import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedOursHost } from '../src/ours-runtime.ts';

for (const failure of ['page read', 'notification callback']) {
  test(`failed ${failure} preserves exponential retry backoff until a page is admitted`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0, reads = 0;
    const cursors = [];
    const event = { event: 'contact_removed', cid: 'peer' };
    const waitForAbort = signal => signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    const host = new SharedOursHost(() => {}, async () => ({
      async *resourceEvents(_identity, { signal }) {
        attempts++; reads = 0;
        yield { kind: 'ready' };
        await waitForAbort(signal);
      },
      async readNotificationPage(_identity, { since, signal }) {
        cursors.push(since);
        if (since === 'tip') return { cursor: 10, events: [] };
        if (attempts <= 8) {
          if (failure === 'page read') throw Error('poison page');
          return { cursor: 11, events: [event] };
        }
        if (attempts === 9) {
          if (++reads === 1) return { cursor: 11, events: [event] };
          throw Error('disconnected after admitted page');
        }
        await waitForAbort(signal); throw Error('aborted');
      },
      async releaseLease() { return { failed: 0 }; }, async close() {},
    }), {});
    t.after(() => host.shutdown());
    host.onIdentityNotify((_identity, value) => {
      if (value && attempts <= 8) throw Error('poison callback');
    });
    await host.boot(); const stop = host.trackIdentity('room');
    const settle = () => new Promise(resolve => setImmediate(resolve));
    await settle(); assert.equal(attempts, 1);
    for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = attempts;
      t.mock.timers.tick(delay - 1); await settle();
      assert.equal(attempts, before, `must wait ${delay}ms after consecutive failure`);
      t.mock.timers.tick(1); await settle();
      assert.equal(attempts, before + 1);
    }
    assert.equal(attempts, 9);
    assert(cursors.slice(1, -1).every(cursor => cursor === 10), 'failed callbacks cannot commit the page cursor');
    t.mock.timers.tick(499); await settle(); assert.equal(attempts, 9);
    t.mock.timers.tick(1); await settle(); assert.equal(attempts, 10, 'admitted page resets retry delay');
    assert.equal(cursors.at(-1), 11, 'successful callbacks commit the cursor before reconnect');
    stop(); await settle();
    t.mock.timers.tick(30000); await settle(); assert.equal(attempts, 10, 'disposal cannot reconnect');
  });
}
