import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {CoworkStore} from '../src/storage.ts';
import {RoomService} from '../src/service.ts';
import {CoworkResourceViews} from '../src/resource-views.ts';
const A='01jz6y7n8p9q0r1s2t3v4w5x6y',B='01jz6y7n8p9q0r1s2t3v4w5x6z',AT='2026-08-02T10:11:12.345Z';
const room=id=>({version:2,room_id:id,room_name:id,identity_name:`cowork-room-${id}`,identity_cid:`cid-${id}`,mission:{goal:'Goal',briefing:'Brief',briefing_version:1},role_briefings:{},rest_roles:[],command_grants:[],role_command_grants:[],anonymous:false,quiet_membership:false,membership_epoch:0,state:'provisioning',invites:[],seats:[],created_at:AT});
function setup(t){const path=mkdtempSync(join(realpathSync(tmpdir()),'cowork-incremental-'));t.after(()=>rmSync(path,{recursive:true,force:true}));const store=new CoworkStore(path);const service=new RoomService(store,{});return {store,service};}
function output(){const chunks=[];return Object.assign(new EventEmitter(),{chunks,destroyed:false,writableEnded:false,write(data){chunks.push(data);return true;},end(){this.writableEnded=true;this.emit('close');},frames(){return chunks.filter(s=>s.startsWith('event: resource\n')).map(s=>JSON.parse(s.split('data: ')[1]));}});}
async function settled(response,predicate){for(let i=0;i<200;i++){if(predicate(response.frames()))return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('expected resource publication');}
async function append(store,seq,text){return store.append(A,{version:1,kind:'message',room_id:A,at:AT,message_id:`${A.slice(0,22)}${String(seq).padStart(4,'0')}`,author:{identity:'alice',display_name:'Alice',role:'builder'},category:'chat',text,recipient_identities:[]});}

test('room capture ignores unrelated commits but fences a same-room mutation',async t=>{
 const {store,service}=setup(t);await store.create(room(A));await store.create(room(B));const out=output();let reads=0,mutateA=false;
 const views=new CoworkResourceViews(store,async d=>{const value=await service.resourceRoom(d.roomId);if(d.roomId===A){reads++;await store.save({...room(B),room_name:`B-${reads}`});if(mutateA){mutateA=false;await store.save({...room(A),room_name:'A-new'});}}return value;});t.after(()=>views.close());
 const c=views.open(out,'owner',async()=>true);const b=views.register('owner',c.connectionId,'A',1,{viewId:'A',resource:'room',roomId:A});
 assert.equal((await views.bound('owner',c.connectionId,'A',1,b.baselineId)).payload.room.room_id,A);assert.equal(reads,1,'B-only writes cannot consume A capture attempts');
 mutateA=true;await store.save({...room(A),room_name:'A-before'});
 await settled(out,frames=>frames.some(f=>f.payload?.room?.room_name==='A-new'));
 assert.equal(out.frames().some(f=>f.payload?.room?.room_name==='A-before'),false,'mixed A capture must not publish');
 assert.equal(out.frames().some(f=>f.kind==='resync'),false);
});

test('live room metadata and append decode and send only the new archive tail',async t=>{
 const {store,service}=setup(t);await store.create(room(A));
 for(let i=1;i<=80;i++)await append(store,i,`old-${i}:`+'x'.repeat(4000));
 let decoded=0;const reads=[];const read=store.readMetadata.bind(store);store.readMetadata=async(id,options)=>{reads.push(options.after);const rows=await read(id,options);decoded+=rows.length;return rows;};
 const out=output();const views=new CoworkResourceViews(store,(d,_signal,_owner,after)=>service.resourceRoom(d.roomId,after));t.after(()=>views.close());
 const c=views.open(out,'owner',async()=>true);const b=views.register('owner',c.connectionId,'A',1,{viewId:'A',resource:'room',roomId:A});const baseline=await views.bound('owner',c.connectionId,'A',1,b.baselineId);assert.equal(baseline.payload.history.length,80);
 const offset=out.chunks.length;decoded=0;reads.length=0;
 await store.save({...room(A),room_name:'Renamed'});await settled(out,frames=>frames.some(f=>f.payload?.room?.room_name==='Renamed'));
 await append(store,81,'new-tail');await settled(out,frames=>JSON.stringify(frames).includes('new-tail'));
 assert.equal(decoded,1,'metadata change decodes zero old records and append decodes one');assert.ok(reads.every(after=>after>=80));
 const sent=out.chunks.slice(offset).join('');assert.ok(Buffer.byteLength(sent)<12000,`small update sent ${Buffer.byteLength(sent)} bytes`);assert.equal(sent.includes('old-1:'),false);
 const replacement=views.register('owner',c.connectionId,'A',2,{viewId:'A',resource:'room',roomId:A});assert.equal((await views.bound('owner',c.connectionId,'A',2,replacement.baselineId)).payload.history.length,81,'replacement retains complete baseline');
});

test('retiring a blocked delta cannot publish late or carry its cursor into a replacement',async t=>{
 const {store,service}=setup(t);await store.create(room(A));await append(store,1,'first');
 const out=output(),cursors=[];let held=false,release,entered;const blocked=new Promise(resolve=>entered=resolve);
 const views=new CoworkResourceViews(store,(d,_signal,_owner,after)=>{cursors.push(after);return service.resourceRoom(d.roomId,after);});t.after(()=>views.close());
 const c=views.open(out,'owner',async()=>{if(held){held=false;entered();await new Promise(resolve=>release=resolve);}return true;});
 const b=views.register('owner',c.connectionId,'A',1,{viewId:'A',resource:'room',roomId:A});await views.bound('owner',c.connectionId,'A',1,b.baselineId);
 held=true;await append(store,2,'blocked-tail');await blocked;
 const replacement=views.register('owner',c.connectionId,'A',2,{viewId:'A',resource:'room',roomId:A});release();
 const baseline=await views.bound('owner',c.connectionId,'A',2,replacement.baselineId);assert.equal(baseline.payload.history.length,2);
 assert.deepEqual(cursors,[undefined,1,undefined]);assert.equal(out.frames().some(f=>f.subscriptionEpoch===1&&JSON.stringify(f.payload).includes('blocked-tail')),false);
 await append(store,3,'accepted-tail');await settled(out,frames=>JSON.stringify(frames).includes('accepted-tail'));assert.equal(cursors.at(-1),2);
});
