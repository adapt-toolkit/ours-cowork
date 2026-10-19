import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CoworkResourceViews } from '../src/resource-views.ts';
import { SharedOursHost } from '../src/ours-runtime.ts';

function output() {
  const frames = [];
  return Object.assign(new EventEmitter(), { frames, destroyed: false, writableEnded: false, write(frame) { frames.push(frame); return true; }, end() { this.writableEnded = true; this.emit('close'); } });
}

test('capture exhaustion degrades only its view after three attempts and a replacement can recover', { timeout: 5000 }, async t => {
  let position = 0, reads = 0, unstable = true, committed;
  const store = { resourceState: () => ({ protocolVersion: 1, producerGeneration: 'store', position, health: 'healthy' }), onResourceCommit: listener => { committed = listener; return () => {}; } };
  const response = output();
  const views = new CoworkResourceViews(store, async descriptor => {
    if (descriptor.viewId === 'unstable') {
      reads++;
      if (unstable && reads <= 12) { position++; committed({ kind: 'metadata' }); }
    }
    return { position };
  });
  t.after(() => views.close());
  const connection = views.open(response, 'owner', async () => true);
  const binding = views.register('owner', connection.connectionId, 'unstable', 1, { viewId: 'unstable', resource: 'rooms' });
  const failed = assert.rejects(views.bound('owner', connection.connectionId, 'unstable', 1, binding.baselineId), /stable resource projection unavailable/);
  const sibling = views.register('owner', connection.connectionId, 'sibling', 1, { viewId: 'sibling', resource: 'rooms' });
  await failed;
  await views.bound('owner', connection.connectionId, 'sibling', 1, sibling.baselineId);
  committed({ kind: 'metadata' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 3, 'failed views do not spin or resume from later commits');
  const frames = response.frames.filter(frame => frame.startsWith('event: resource\n')).map(frame => JSON.parse(frame.split('data: ')[1]));
  assert.deepEqual(frames.filter(frame => frame.viewId === 'unstable').map(frame => frame.kind), ['resync']);
  assert.equal(response.writableEnded, false, 'sibling retains the shared transport');
  unstable = false;
  const replacement = views.register('owner', connection.connectionId, 'unstable', 2, { viewId: 'unstable', resource: 'rooms' });
  assert.deepEqual((await views.bound('owner', connection.connectionId, 'unstable', 2, replacement.baselineId)).payload, { position: 3 });
  views.remove('owner', connection.connectionId, 'unstable', 2);
  const before = reads; committed({ kind: 'metadata' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, before, 'disposed view receives no new capture');
});

test('finite capture churn settles inside the existing three-attempt budget', async t => {
  let position = 0, reads = 0, committed;
  const store = { resourceState: () => ({ protocolVersion: 1, producerGeneration: 'store', position, health: 'healthy' }), onResourceCommit: listener => { committed = listener; return () => {}; } };
  const views = new CoworkResourceViews(store, async () => { if (++reads <= 2) {position++; committed({kind: 'metadata'});} return { position }; });
  t.after(() => views.close());
  const connection = views.open(output(), 'owner', async () => true);
  const binding = views.register('owner', connection.connectionId, 'rooms', 1, { viewId: 'rooms', resource: 'rooms' });
  assert.deepEqual((await views.bound('owner', connection.connectionId, 'rooms', 1, binding.baselineId)).payload, { position: 2 });
  assert.equal(reads, 3);
});

test('notification startup primes at tip before reconciliation and reconnect retains the admitted cursor', { timeout: 5000 }, async t => {
  const cursors = [], observed = [], reconciliations = [];
  const historical = { event: 'contact_removed', cid: 'historical' };
  const fresh = { event: 'contact_removed', cid: 'fresh' };
  const recovered = { event: 'contact_removed', cid: 'recovered' };
  let primed = false, disconnected = false, complete;
  const done = new Promise(resolve => { complete = resolve; });
  const host = new SharedOursHost(() => {}, async () => ({
    async *resourceEvents(_identity, { signal }) {
      yield { kind: 'ready' };
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    async readNotificationPage(_identity, { since, signal }) {
      cursors.push(since);
      if (since === 'tip') { primed = true; return { cursor: 100, events: [] }; }
      if (since === 0) return { cursor: 100, events: [historical] };
      if (since === 100) return { cursor: 200, events: [fresh] };
      if (since === 200 && !disconnected) { disconnected = true; throw Error('disconnected'); }
      if (since === 200) return { cursor: 300, events: [recovered] };
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw Error('aborted');
    },
    async releaseLease() { return { failed: 0 }; }, async close() {},
  }));
  t.after(() => host.shutdown());
  await host.boot();
  host.onIdentityNotify((_identity, event) => {
    if (!event) reconciliations.push(primed);
    else { observed.push(event); if (event === recovered) complete(); }
  });
  host.trackIdentity('room'); await done;
  assert.deepEqual(observed, [fresh, recovered], 'startup must not replay historical lifecycle work');
  assert.deepEqual(cursors.slice(0, 4), ['tip', 100, 200, 200]);
  assert.deepEqual(reconciliations, [true, true], 'tip is captured before canonical recovery, including startup');
});

test('shared health waits behind complete chunks and disposal rejects blocked output',async()=>{
 const {ResourceOutput}=await import('../src/resource-views.ts');
 const response=output();let blocked=true;response.write=wire=>{response.frames.push(wire);return !blocked;};
 const controller=new AbortController(),failures=[],writer=new ResourceOutput(response,controller.signal,error=>failures.push(error));
 const binding={protocolVersion:1,producerGeneration:'service',viewId:'rooms',subscriptionEpoch:1,baselineId:'baseline',sequence:1,revision:1};
 const data=writer.send({...binding,kind:'snapshot',payload:'x'.repeat(9*1024*1024)});
 const batch=writer.send({protocolVersion:1,producerGeneration:'service',views:[{...binding,sequence:2,source:{protocolVersion:1,producerGeneration:'store',position:1,health:'healthy'}}]});
 assert.equal(response.frames.length,1,'backpressure retains one bounded active chunk assembly');
 blocked=false;response.emit('drain');await Promise.all([data,batch]);
 assert.ok(response.frames.at(-2).includes('"type":"commit"'));assert.ok(response.frames.at(-1).startsWith('event: resource-coverage\n'));assert.deepEqual(failures,[]);
 controller.abort();assert.equal(response.listenerCount('drain'),0);
 const held=output();held.write=wire=>{held.frames.push(wire);return false;};const abort=new AbortController(),pendingWriter=new ResourceOutput(held,abort.signal,()=>{});
 const first=pendingWriter.send({...binding,kind:'snapshot',payload:{}}),next=pendingWriter.send({protocolVersion:1,producerGeneration:'service',views:[]});
 abort.abort();assert.deepEqual((await Promise.allSettled([first,next])).map(result=>result.status),['rejected','rejected']);assert.equal(held.listenerCount('drain'),0);
});
