import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CoworkStore } from '../src/storage.ts';
import { CoworkResourceViews } from '../src/resource-views.ts';
import { RpcDispatcher, TransportServer } from '../src/transports.ts';

async function fixture(t) {
  const dir = mkdtempSync('/tmp/cwr-lifecycle-');
  const store = new CoworkStore(dir);
  const views = new CoworkResourceViews(store, async () => []);
  const dispatcher = new RpcDispatcher({});
  const transport = new TransportServer({ socketPath: join(dir, 'control.sock'), rest: { enabled: true, port: 0 }, unixDispatcher: dispatcher, restDispatcher: dispatcher, resources: views });
  await transport.start();
  const base = `http://127.0.0.1:${transport.restAddress.port}`;
  const controller = new AbortController();
  const stream = await fetch(`${base}/resources`, { signal: controller.signal });
  const reader = stream.body.getReader();
  const { connectionId } = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('data: ')[1]);
  t.after(async () => { controller.abort(); await reader.cancel().catch(() => {}); await transport.stop(); rmSync(dir, { recursive: true, force: true }); });
  const path = id => `${base}/resources/${connectionId}/views/${id}`;
  const body = (id, epoch) => JSON.stringify({ subscriptionEpoch: epoch, descriptor: { viewId: id, resource: 'rooms' } });
  const post = (id, epoch) => fetch(path(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(id, epoch) });
  const bound = (id, epoch, binding) => fetch(`${path(id)}?epoch=${epoch}&baselineId=${binding.baselineId}`);
  return { views, connectionId, path, body, post, bound };
}

test('DELETE before delayed POST retires its epoch and stale DELETE preserves the replacement', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const request = http.request(f.path('rooms'), { method: 'POST', headers: { 'content-type': 'application/json' } });
  t.after(() => request.destroy());
  const response = once(request, 'response');
  const body = f.body('rooms', 1);
  request.write(body.slice(0, -1));
  assert.equal((await fetch(`${f.path('rooms')}?epoch=1`, { method: 'DELETE' })).status, 200);
  request.end(body.slice(-1));
  const [delayed] = await response; delayed.resume();
  assert.equal(delayed.statusCode, 409, 'retired delayed registration must be rejected');
  const replacement = await f.post('rooms', 2); assert.equal(replacement.status, 200);
  const binding = await replacement.json();
  assert.equal((await fetch(`${f.path('rooms')}?epoch=1`, { method: 'DELETE' })).status, 200);
  assert.equal((await f.bound('rooms', 2, binding)).status, 200);
  assert.equal((await fetch(`${f.path('rooms')}?epoch=3`, { method: 'DELETE' })).status, 200);
  assert.equal((await f.bound('rooms', 2, binding)).status, 409);
  assert.equal((await f.post('rooms', 3)).status, 409, 'higher DELETE also fences a delayed replacement');
  assert.equal((await f.post('rooms', 4)).status, 200);
});

for (const replacement of [false, true]) {
  test(`abandoned HTTP registration response retires only its own binding (replacement=${replacement})`, { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const sibling = await (await f.post('sibling', 1)).json();
    const originalEnd = http.ServerResponse.prototype.end;
    let heldResponse, binding, releaseHeld;
    const held = new Promise(resolve => { releaseHeld = resolve; });
    // Hold only the control response, after real registration but before HTTP finish.
    http.ServerResponse.prototype.end = function (...args) {
      if (this.req.headers['x-test-hold'] === 'yes') {
        heldResponse = this; binding = JSON.parse(String(args[0])); releaseHeld(); return this;
      }
      return originalEnd.apply(this, args);
    };
    t.after(() => { http.ServerResponse.prototype.end = originalEnd; });
    const request = http.request(f.path('rooms'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-hold': 'yes' } });
    request.on('error', () => {}); t.after(() => request.destroy());
    request.end(f.body('rooms', 1)); await held;
    let newer;
    if (replacement) newer = await (await f.post('rooms', 2)).json();
    const closed = once(heldResponse, 'close'); request.destroy(); await closed;
    assert.equal((await f.bound('rooms', 1, binding)).status, 409, 'lost response must not leave an orphan');
    assert.equal((await f.post('rooms', 1)).status, 409, 'abandoned epoch stays retired');
    assert.equal((await f.bound('sibling', 1, sibling)).status, 200, 'successful response keeps sibling live on shared SSE');
    if (replacement) assert.equal((await f.bound('rooms', 2, newer)).status, 200, 'old response close must preserve newer epoch');
  });
}

test('DELETE validates epochs and bounds retained tombstones without evicting them', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const epoch of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.views.remove('local', f.connectionId, 'rooms', epoch), /invalid resource epoch/);
  }
  for (let i = 0; i < 256; i++) f.views.remove('local', f.connectionId, `view_${i}`, 1);
  assert.throws(() => f.views.remove('local', f.connectionId, 'overflow', 1), /capacity/);
  assert.throws(() => f.views.register('local', f.connectionId, 'overflow', 1, { viewId: 'overflow', resource: 'rooms' }), /capacity/);
  assert.throws(() => f.views.register('local', f.connectionId, 'view_0', 1, { viewId: 'view_0', resource: 'rooms' }), /obsolete/);
  assert.doesNotThrow(() => f.views.register('local', f.connectionId, 'view_0', 2, { viewId: 'view_0', resource: 'rooms' }));
});
