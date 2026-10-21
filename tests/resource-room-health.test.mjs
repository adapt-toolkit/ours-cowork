import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {CoworkStore} from '../src/storage.ts';
import {CoworkResourceViews} from '../src/resource-views.ts';
import {PacketRegistry} from '../src/packets.ts';
const A='01jz6y7n8p9q0r1s2t3v4w5x6y',B='01jz6y7n8p9q0r1s2t3v4w5x6z';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function output(){const frames=[];return Object.assign(new EventEmitter(),{frames,destroyed:false,writableEnded:false,write(s){if(s.startsWith('event: resource\n'))frames.push(JSON.parse(s.split('data: ')[1]));else if(s.startsWith('event: resource-coverage\n'))frames.push(...JSON.parse(s.split('data: ')[1]).views.map(entry=>({...entry,kind:'coverage'}))); return true;},end(){this.writableEnded=true;this.emit('close');}});}
test('one room observation failure retires only that projection and can recover without replacing siblings',async t=>{
 const path=mkdtempSync(join(realpathSync(tmpdir()),'cowork-room-health-'));t.after(()=>rmSync(path,{recursive:true,force:true}));const store=new CoworkStore(path),out=output();
 const views=new CoworkResourceViews(store,async d=>({roomId:d.roomId,history:[]}));t.after(()=>views.close());const c=views.open(out,'owner',async()=>true);
 for(const roomId of [A,B]){const binding=views.register('owner',c.connectionId,roomId,1,{viewId:roomId,resource:'room',roomId});await views.bound('owner',c.connectionId,roomId,1,binding.baselineId);}
 store.setResourceHealth('room-watch',false,A);await tick();
 assert.equal(out.writableEnded,false);assert.deepEqual(out.frames.filter(f=>f.kind==='resync').map(f=>f.viewId),[A]);assert.equal(store.resourceState(B).health,'healthy');assert.equal(store.resourceState(A).health,'failed');
 store.setResourceHealth('room-watch',true,A);const recovered=views.register('owner',c.connectionId,A,2,{viewId:A,resource:'room',roomId:A});await views.bound('owner',c.connectionId,A,2,recovered.baselineId);assert.equal(out.frames.filter(f=>f.viewId===B&&f.kind==='ready').length,1);
 store.setResourceHealth('process',false);await tick();assert.equal(out.writableEnded,true,'process-wide failure remains global');
});
test('registry health routing owns the exact room mapping before watcher startup and clears it on release',async t=>{
 const path=mkdtempSync(join(realpathSync(tmpdir()),'cowork-registry-health-'));t.after(()=>rmSync(path,{recursive:true,force:true}));const listeners=new Set(),events=[],pendingEvents=[];
 const emit=(name,healthy,pending)=>{for(const listener of listeners)listener(name,healthy,pending);};
 const client={async createIdentity(){return {info:{cid:'AB'.repeat(32)}};},async listContacts(){return {contacts:[]};},async listInvites(){return [];},async releaseLease(){return {failed:0};},async close(){}};
 const host={onIdentityNotify(){return()=>{};},onResourceHealth(fn){listeners.add(fn);return()=>listeners.delete(fn);},async listIdentityNames(){return new Set();},async createClient(){return client;},trackIdentity(name){emit(name,false);return()=>emit(name,true);}};
 const registry=new PacketRegistry(host,path,{onResourceHealth:(id,healthy,pending)=>{events.push([id,healthy]);pendingEvents.push([id,pending]);}});t.after(()=>registry.unhostAll());
 await registry.create(A,'ours-cowork:Named room');assert.deepEqual(events,[[A,false]],'startup failure is scoped before watch begins');emit('ours-cowork:Other room',false);assert.equal(events.length,1);emit('ours-cowork:Named room',true,true);assert.deepEqual(pendingEvents.at(-1),[A,true],'existing callback forwards canonical pending for exact room');await registry.unhost(A);assert.deepEqual(events.at(-1),[A,true]);assert.equal(listeners.size,0);const count=events.length;emit('ours-cowork:Named room',false);assert.equal(events.length,count);
});
test('room health failure fences a pending capture and failed probes do not run projections',async t=>{
 const path=mkdtempSync(join(realpathSync(tmpdir()),'cowork-health-fence-'));t.after(()=>rmSync(path,{recursive:true,force:true}));const store=new CoworkStore(path),out=output();let release,entered,reads=0;const started=new Promise(resolve=>entered=resolve);
 const views=new CoworkResourceViews(store,async()=>{reads++;entered();await new Promise(resolve=>release=resolve);return {history:[]};});t.after(()=>views.close());const c=views.open(out,'owner',async()=>true);
 const b=views.register('owner',c.connectionId,A,1,{viewId:A,resource:'room',roomId:A});const bound=assert.rejects(views.bound('owner',c.connectionId,A,1,b.baselineId));await started;store.setResourceHealth('room-watch',false,A);release();await bound;await tick();
 assert.deepEqual(out.frames.map(f=>f.kind),['resync']);const retry=views.register('owner',c.connectionId,A,2,{viewId:A,resource:'room',roomId:A});await assert.rejects(views.bound('owner',c.connectionId,A,2,retry.baselineId),/observation unavailable/);assert.equal(reads,1);assert.equal(out.writableEnded,false);
});

test('pending room intake suppresses certification while list and unrelated room remain healthy',async t=>{
 const path=mkdtempSync(join(realpathSync(tmpdir()),'cowork-room-pending-'));t.after(()=>rmSync(path,{recursive:true,force:true}));
 const store=new CoworkStore(path),out=output();let reads=0;
 t.mock.timers.enable({apis:['setInterval','Date'],now:1000});
 const views=new CoworkResourceViews(store,async d=>{reads++;return {roomId:d.roomId,history:[]};});t.after(()=>views.close());
 const c=views.open(out,'owner',async()=>true);
 for(const descriptor of [{viewId:A,resource:'room',roomId:A},{viewId:B,resource:'room',roomId:B},{viewId:'list',resource:'rooms'}]) {const b=views.register('owner',c.connectionId,descriptor.viewId,1,descriptor);await views.bound('owner',c.connectionId,descriptor.viewId,1,b.baselineId);}
 await tick();store.setResourceHealth('watch-A',true,A,true);await tick();const settled=reads;out.frames.length=0;
 t.mock.timers.tick(15000);await tick();
 const coverage=out.frames.filter(f=>f.kind==='coverage');
 assert.equal(coverage.some(frame=>frame.viewId===A),false,'pending intake cannot be covered by SDK liveness');
 assert.deepEqual(coverage.map(frame=>frame.viewId).sort(),[B,'list'].sort(),'unrelated room and list retain independent health');
 assert.equal(store.resourceState(A).health,'healthy','pending is not explicit source failure');
 assert.equal(store.resourcePending(B),false);assert.equal(store.resourcePending(),false);assert.equal(reads,settled);
 store.setResourceHealth('watch-A',true,A);await tick();
 assert.equal(store.resourcePending(A),false);assert.equal(out.frames.some(frame=>frame.kind==='resync'),false,'successful intake preserves the existing binding');
 store.setResourceHealth('watch-A',true,A,true);store.setResourceHealth('watch-A',false,A);await tick();
 assert.equal(out.frames.filter(frame=>frame.kind==='resync'&&frame.viewId===A).length,1,'explicit failure remains immediate during intake');
 store.setResourceHealth('watch-A',true,A);assert.equal(store.resourcePending(A),false,'cleanup clears pending ownership');
});
