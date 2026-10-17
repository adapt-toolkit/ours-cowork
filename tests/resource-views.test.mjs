import test, { before, after } from 'node:test';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoworkStore } from '../src/storage.ts';
// Browser resource sessions own visibility listeners; Node tests need their DOM owner.
const browser = new JSDOM('', { url: 'http://cowork.example/', pretendToBeVisual: true });
const previousBrowserGlobals = { document: globalThis.document, window: globalThis.window };
before(() => { globalThis.document = browser.window.document; globalThis.window = browser.window; });
after(() => {
 for (const [key, value] of Object.entries(previousBrowserGlobals)) {
  if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
 }
 browser.window.close();
});
const ID='01jz6y7n8p9q0r1s2t3v4w5x6y';
const room={version:2,room_id:ID,room_name:'Room',identity_name:`cowork-room-${ID}`,identity_cid:'cid',mission:{goal:'Goal',briefing:'Brief',briefing_version:1},role_briefings:{},rest_roles:[],command_grants:[],role_command_grants:[],anonymous:false,quiet_membership:false,membership_epoch:0,state:'provisioning',invites:[],seats:[],created_at:'2026-08-02T10:11:12.345Z'};
function fixture(t,options={}) { const path=mkdtempSync('/tmp/cwr-');t.after(()=>rmSync(path,{recursive:true,force:true}));return new CoworkStore(path,options); }
test('only committed room writes wake subscribers; listeners cannot fail persistence',async t=>{
 const store=fixture(t);const events=[];
 assert.equal(typeof store.onResourceCommit,'function');
 const off=store.onResourceCommit(e=>events.push(e));store.onResourceCommit(()=>{throw Error('listener');});
 await store.create(room);await store.save({...room,room_name:'Changed'});
 assert.deepEqual(events.map(e=>[e.roomId,e.kind]),[[ID,'metadata'],[ID,'metadata']]);
 off();await store.save(room);assert.equal(events.length,2);
});
test('canonical delivery subscribes before projection and replaces history on deletion',async t=>{
 const {CoworkResourceViews}=await import('../src/resource-views.ts');
 const store=fixture(t);await store.create(room);
 const frames=[];const response=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,write(s){frames.push(s);return true;},end(){this.writableEnded=true;this.emit('close');}});
 const views=new CoworkResourceViews(store,async d=>d.resource==='rooms'?store.list():store.mutex(d.roomId,async()=>{return {room:await store.load(d.roomId),participants:(await store.load(d.roomId)).seats,history:await store.read(d.roomId)};}).catch(()=>null));
 const connection=views.open(response,'owner',async()=>true);t.after(()=>views.close());
 const binding=views.register('owner',connection.connectionId,'room',1,{viewId:'room',resource:'room',roomId:ID});
 const initial=await views.bound('owner',connection.connectionId,'room',1,binding.baselineId);assert.equal(initial.payload.room.room_name,'Room');
 await store.save({...room,state:'closed'});await store.delete(ID);
 await new Promise(r=>setTimeout(r,25));
 const resources=frames.filter(s=>s.startsWith('event: resource\n')).map(s=>JSON.parse(s.split('data: ')[1]));
 assert.equal(resources.filter(f=>f.kind==='snapshot').at(-1).payload,null);
 connection.close();assert.equal(response.writableEnded,true);
});
test('runtime observes committed acceptance and reconnects notification pages from retained cursor',async t=>{
 const {SharedOursHost}=await import('../src/ours-runtime.ts');
 const since=[];let reconnect=0,wakes=0;
 const client={async *resourceEvents(_id,{signal}){yield {kind:'ready'};yield {kind:'committed'};await new Promise(r=>signal.addEventListener('abort',r,{once:true}));},async readNotificationPage(_id,opts){since.push(opts.since);if(since.length===1)return {cursor:7,events:[]};if(since.length===2)throw Error('disconnect');await new Promise(r=>opts.signal.addEventListener('abort',r,{once:true}));throw Error('abort');},async releaseLease(){return {failed:0};},async close(){}};
 const host=new SharedOursHost(()=>{},async()=>client,{});await host.boot();host.onIdentityNotify(()=>{wakes++;});host.trackIdentity('room');t.after(()=>host.shutdown());
 await new Promise(r=>setTimeout(r,600));assert.deepEqual(since.slice(0,3),['tip',7,7]);assert.ok(wakes>=3);
});
function output() {
 const frames=[];const response=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,write(s){frames.push(s);return true;},end(){this.writableEnded=true;this.emit('close');}});
 return {frames,response,resources:()=>frames.filter(s=>s.startsWith('event: resource\n')).map(s=>JSON.parse(s.split('data: ')[1]))};
}
test('initial projection race captures the winning commit; unrelated rooms are not reread; source failure closes live transport',async t=>{
 const {CoworkResourceViews}=await import('../src/resource-views.ts');const store=fixture(t);await store.create(room);
 const out=output();let reads=0;
 const views=new CoworkResourceViews(store,async()=>{reads++;const captured=await store.load(ID);if(reads===1)await store.save({...room,room_name:'Concurrent client'});return captured;});t.after(()=>views.close());
 const connection=views.open(out.response,'owner',async()=>true);const binding=views.register('owner',connection.connectionId,'room',1,{viewId:'room',resource:'room',roomId:ID});
 const initial=await views.bound('owner',connection.connectionId,'room',1,binding.baselineId);assert.equal(initial.payload.room_name,'Concurrent client');
 await new Promise(r=>setTimeout(r,10));const settled=reads;
 await store.create({...room,room_id:'01jz6y7n8p9q0r1s2t3v4w5x6z',identity_name:'other'});await new Promise(r=>setTimeout(r,10));assert.equal(reads,settled);
 store.setResourceHealth('upstream',false);await new Promise(r=>setTimeout(r,10));assert.equal(out.resources().at(-1).kind,'health');assert.equal(out.response.writableEnded,true);
 const count=out.frames.length;await store.save(room);assert.equal(out.frames.length,count,'disposed streams receive no commits');
});
test('resource transport preserves management/browser origin and credential boundaries',async t=>{
 const {CoworkResourceViews}=await import('../src/resource-views.ts');const {TransportServer,RpcDispatcher}=await import('../src/transports.ts');
 const store=fixture(t);const views=new CoworkResourceViews(store,async()=>[]);let allowed=true;
 const dispatcher=new RpcDispatcher({});const socket=join(store.stateDir,'resource.sock');
 const transport=new TransportServer({socketPath:socket,rest:{enabled:true,port:0},unixDispatcher:dispatcher,restDispatcher:dispatcher,management:{dispatcher,authorize:async req=>allowed&&req.headers['x-ours-api-token']==='operator'},publicOrigin:'https://cowork.example',resources:views});
 await transport.start();t.after(()=>transport.stop());const base=`http://127.0.0.1:${transport.restAddress.port}`;
 assert.equal((await fetch(base+'/resources')).status,403);
 assert.equal((await fetch(base+'/browser/resources')).status,401);
 assert.equal((await fetch(base+'/browser/resources',{headers:{'x-ours-api-token':'operator',origin:'https://evil.example'}})).status,403);
 assert.equal((await fetch(base+'/management/resources',{headers:{'x-ours-api-token':'operator',origin:'https://cowork.example'}})).status,403);
 const abort=new AbortController();const headers={'x-ours-api-token':'operator',origin:'https://cowork.example'};
 const response=await fetch(base+'/browser/resources',{headers,signal:abort.signal});assert.equal(response.status,200);const reader=response.body.getReader();
 const start=new TextDecoder().decode((await reader.read()).value);const connection=JSON.parse(start.split('data: ')[1]);
 const path=`/browser/resources/${connection.connectionId}/views/rooms`;
 const register=await fetch(base+path,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({subscriptionEpoch:1,descriptor:{viewId:'rooms',resource:'rooms'}})});assert.equal(register.status,200);
 assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,'x-ours-api-token':'other','content-type':'application/json'},body:'{}'})).status,401);
 allowed=false;assert.equal((await fetch(base+path+'?epoch=1&baselineId=no',{headers})).status,401);
 abort.abort();await reader.cancel().catch(()=>{});
});
test('separate UI consumes full snapshots without healthy content GETs and replaces deleted history',async t=>{
 const {createResourceSession}=await import('../web/src/state/poller.ts');const previous=globalThis.location;globalThis.location={href:'http://cowork.example/'};t.after(()=>{globalThis.location=previous;});
 const requests=[],received=[],health=[];let send;
 const stream=new ReadableStream({start(controller){send=value=>controller.enqueue(new TextEncoder().encode(value));}});
 const fakeFetch=async(url,options)=>{requests.push({url,options});return url.endsWith('/browser/resources')?new Response(stream,{headers:{'content-type':'text/event-stream'}}):new Response('{}',{headers:{'content-type':'application/json'}});};
 const session=createResourceSession({snapshot:(...args)=>{if(args[0]==='room')received.push(args);},health:state=>health.push(state)},'in-memory',fakeFetch);t.after(()=>session.close());session.watchRoom(ID);
 send('event: resource-connection\ndata: '+JSON.stringify({protocolVersion:1,connectionId:'connection',producerGeneration:'generation'})+'\n\n');await new Promise(r=>setTimeout(r,10));
 // Health requires both owned baselines, including the room list.
 for(const [index,[kind,payload]] of [['snapshot',[{room_id:ID}]],['ready',{baselineId:'rooms-baseline'}]].entries()) {
  send('event: resource\ndata: '+JSON.stringify({protocolVersion:1,producerGeneration:'generation',viewId:'rooms',subscriptionEpoch:1,baselineId:'rooms-baseline',revision:1,sequence:index+1,kind,payload})+'\n\n');
 }
 let sequence=0;const frame=(kind,payload)=>send('event: resource\ndata: '+JSON.stringify({protocolVersion:1,producerGeneration:'generation',viewId:`room_${ID}`,subscriptionEpoch:1,baselineId:'baseline',revision:1,sequence:++sequence,kind,payload})+'\n\n');
 frame('snapshot',{history:[{seq:1},{seq:2}]});frame('ready',{baselineId:'baseline'});frame('snapshot',{history:[]});frame('coverage',{});
 await new Promise(r=>setTimeout(r,25));assert.equal(received.length,2);assert.deepEqual(received.at(-1)[2].history,[]);assert.deepEqual(health,[true]);
 assert.equal(requests.length,3);assert.ok(requests.every(r=>!r.url.includes('rpc')));assert.ok(requests.every(r=>r.options.headers['x-ours-api-token']==='in-memory'));
 session.close();
});
test('service snapshot recovery preserves canonical participants and exact ordered history across loaded pages',async t=>{
 const {RoomService}=await import('../src/service.ts');const {CoworkResourceViews}=await import('../src/resource-views.ts');
 const store=fixture(t);await store.create(room);const service=new RoomService(store,{});const out=output();
 const views=new CoworkResourceViews(store,d=>service.resourceRoom(d.roomId));t.after(()=>views.close());
 const connection=views.open(out.response,'operator',async()=>true);const binding=views.register('operator',connection.connectionId,'room',1,{viewId:'room',resource:'room',roomId:ID});
 await views.bound('operator',connection.connectionId,'room',1,binding.baselineId);
 const seat={identity:'alice',display_name:'Alice',role:'Participant',invite_id:'invite',participant_id:ID,state:'active',accepted_at:room.created_at};
 await store.save({...room,seats:[seat]});await store.save({...room,seats:[seat]});
 // Force the second canonical history page through the existing 200-row API.
 for(let index=0;index<201;index++)await store.append(ID,{version:1,kind:'message',room_id:ID,at:room.created_at,message_id:`${ID.slice(0,19)}${String(index).padStart(7,'0')}`,author:{identity:'alice',display_name:'Alice',role:'Participant'},category:'chat',text:`Message ${index}`,recipient_identities:[]});
 // A sustained burst may exhaust the three-capture budget; recover with a new epoch.
 const recovered=views.register('operator',connection.connectionId,'room',2,{viewId:'room',resource:'room',roomId:ID});
 await views.bound('operator',connection.connectionId,'room',2,recovered.baselineId);
 const snapshot=out.resources().filter(f=>f.kind==='snapshot').at(-1).payload;
 assert.equal(snapshot.history.length,201);assert.deepEqual(snapshot.history.map(row=>row.record_id),(await store.read(ID)).map(row=>row.record_id));assert.deepEqual(snapshot.history.map(row=>row.seq),Array.from({length:201},(_,i)=>i+1));assert.deepEqual(snapshot.participants,[seat]);
 await store.save({...await store.load(ID),room_name:'Stable after recovery'});
 for(let retry=0;retry<100 && out.resources().filter(f=>f.kind==='snapshot'&&f.subscriptionEpoch===2).at(-1)?.payload?.room?.room_name!=='Stable after recovery';retry++)await new Promise(r=>setTimeout(r,5));
 const stable=out.resources().filter(f=>f.kind==='snapshot'&&f.subscriptionEpoch===2).at(-1);
 assert.equal(stable.payload.room.room_name,'Stable after recovery');assert.deepEqual(stable.payload.history,snapshot.history);
 assert.equal(out.resources().filter(f=>f.subscriptionEpoch===2&&f.kind==='resync').length,0,'stable delivery resumes without another fallback');
});
test('large canonical history uses bounded units and never closes unrelated views',async t=>{
 const {CoworkResourceViews,RESOURCE_FRAME_BYTES}=await import('../src/resource-views.ts');const store=fixture(t);const out=output();
 const history=Array.from({length:18},(_,seq)=>({seq:seq+1,text:'x'.repeat(1024*1024)}));
 const views=new CoworkResourceViews(store,async d=>d.resource==='rooms'?[]:{room,participants:[],history});t.after(()=>views.close());const c=views.open(out.response,'owner',async()=>true);
 const b=views.register('owner',c.connectionId,`room_${ID}`,1,{viewId:`room_${ID}`,resource:'room',roomId:ID});await views.bound('owner',c.connectionId,`room_${ID}`,1,b.baselineId);
 assert.equal(out.response.writableEnded,false);assert.ok(out.frames.every(f=>Buffer.byteLength(f)<=RESOURCE_FRAME_BYTES));assert.ok(out.frames.some(f=>f.startsWith('event: resource-chunk')));
 const {createResourceSession}=await import('../web/src/state/poller.ts');const previous=globalThis.location;globalThis.location={href:'http://cowork.example/'};t.after(()=>{globalThis.location=previous;});
 let feed;const received=[];const stream=new ReadableStream({start(controller){feed=text=>controller.enqueue(new TextEncoder().encode(text));}});
 const client=createResourceSession({snapshot:(_resource,_id,payload)=>received.push(payload),health(){}},undefined,async(url)=>url.endsWith('/resources')?new Response(stream,{headers:{'content-type':'text/event-stream'}}):new Response('{}'));t.after(()=>client.close());client.watchRoom(ID);
 for(const frame of out.frames)feed(frame);
 for(let retry=0;retry<100 && !received.length;retry++)await new Promise(r=>setTimeout(r,10));
 assert.equal(received.length,1);assert.deepEqual(received[0].history,history);
});
test('idle coverage never authorizes; real content is gated on fresh authorization',async t=>{
 const {CoworkResourceViews}=await import('../src/resource-views.ts');const store=fixture(t);await store.create(room);let authorizations=0,allowed=true;const out=output();
 const views=new CoworkResourceViews(store,()=>store.list());t.after(()=>views.close());const c=views.open(out.response,'owner',async()=>{authorizations++;return allowed;});const b=views.register('owner',c.connectionId,'rooms',1,{viewId:'rooms',resource:'rooms'});await views.bound('owner',c.connectionId,'rooms',1,b.baselineId);
 const before=authorizations;await new Promise(r=>setTimeout(r,2100));assert.equal(authorizations,before);allowed=false;const snapshots=out.resources().filter(f=>f.kind==='snapshot').length;await store.save({...room,room_name:'Denied publication'});await new Promise(r=>setTimeout(r,20));assert.equal(out.resources().filter(f=>f.kind==='snapshot').length,snapshots);assert.equal(out.resources().at(-1).payload.reason,'auth_required');
});
test('terminal authentication stops retries and returns to credential owner',async t=>{
 const {createResourceSession}=await import('../web/src/state/poller.ts');const previous=globalThis.location;globalThis.location={href:'http://cowork.example/'};t.after(()=>{globalThis.location=previous;});let requests=0,terminal=0;
 const session=createResourceSession({snapshot(){},health(){},authenticationRequired(){terminal++;}},'revoked',async()=>{requests++;return new Response('',{status:401});});t.after(()=>session.close());await new Promise(r=>setTimeout(r,1150));assert.equal(requests,1);assert.equal(terminal,1);
});
test('more than 63 retained rooms use scoped recovery; released bindings DELETE and reactivate capacity',async t=>{
 const {createResourceSession}=await import('../web/src/state/poller.ts');const previous=globalThis.location;globalThis.location={href:'http://cowork.example/'};t.after(()=>{globalThis.location=previous;});
 const requests=[],recovered=[];let send;const stream=new ReadableStream({start(c){send=value=>c.enqueue(new TextEncoder().encode(value));}});
 const fetcher=async(url,options)=>{requests.push({url,options});return url.endsWith('/resources')?new Response(stream,{headers:{'content-type':'text/event-stream'}}):new Response('{}');};
 const session=createResourceSession({snapshot(){},health(){},async recover(id){recovered.push(id);}},'credential',fetcher);t.after(()=>session.close());
 const ids=Array.from({length:65},(_,i)=>`${ID.slice(0,23)}${String(i).padStart(3,'0')}`);for(const id of ids)session.watchRoom(id);
 send('event: resource-connection\ndata: '+JSON.stringify({protocolVersion:1,connectionId:'connection',producerGeneration:'generation'})+'\n\n');await new Promise(r=>setTimeout(r,30));
 assert.equal(requests.filter(r=>r.options.method==='POST').length,64);assert.deepEqual(recovered,ids.slice(63));assert.equal(requests.filter(r=>!r.options.method).length,1);
 session.unwatchRoom(ids[0]);await new Promise(r=>setTimeout(r,20));assert.equal(requests.filter(r=>r.options.method==='DELETE').length,1);assert.equal(requests.filter(r=>r.options.method==='POST').length,65);assert.equal(requests.filter(r=>!r.options.method).length,1);
});
test('visiting over 63 rooms releases inactive histories without background recovery polling',async t=>{
 const {createResourceSession}=await import('../web/src/state/poller.ts');const previous=globalThis.location;globalThis.location={href:'http://cowork.example/'};t.after(()=>{globalThis.location=previous;});
 const priorInterval=globalThis.setInterval;let intervalCalls=0;globalThis.setInterval=(...args)=>{intervalCalls++;return priorInterval(...args);};t.after(()=>{globalThis.setInterval=priorInterval;});
 const requests=[];let send,recoveries=0;const stream=new ReadableStream({start(c){send=value=>c.enqueue(new TextEncoder().encode(value));}});
 const session=createResourceSession({snapshot(){},health(){},async recover(){recoveries++;}},'credential',async(url,options)=>{requests.push({url,options});return url.endsWith('/resources')?new Response(stream,{headers:{'content-type':'text/event-stream'}}):new Response('{}');});t.after(()=>session.close());
 send('event: resource-connection\ndata: '+JSON.stringify({protocolVersion:1,connectionId:'connection',producerGeneration:'generation'})+'\n\n');await new Promise(r=>setTimeout(r,5));
 for(let index=0;index<100;index++){const id=`${ID.slice(0,23)}${String(index).padStart(3,'0')}`;session.watchRoom(id);session.unwatchRoom(id);}
 await new Promise(r=>setTimeout(r,25));assert.equal(requests.filter(r=>r.options.method==='POST').length,101);assert.equal(requests.filter(r=>r.options.method==='DELETE').length,100);assert.equal(recoveries,0);assert.equal(intervalCalls,0);assert.equal(requests.filter(r=>!r.options.method).length,1);
});
test('delayed authorizer cannot publish coverage before baseline or ahead of updated content',async t=>{
 const {CoworkResourceViews}=await import('../src/resource-views.ts');const store=fixture(t);await store.create(room);const out=output();
 let release;const pending=()=>new Promise(resolve=>{release=()=>resolve(true);});let authorization=pending();
 const views=new CoworkResourceViews(store,()=>store.list());t.after(()=>views.close());const c=views.open(out.response,'owner',()=>authorization);
 const binding=views.register('owner',c.connectionId,'rooms',1,{viewId:'rooms',resource:'rooms'});
 await new Promise(r=>setTimeout(r,2100));assert.deepEqual(out.resources(),[],'no coverage may precede the complete baseline');
 release();await views.bound('owner',c.connectionId,'rooms',1,binding.baselineId);assert.deepEqual(out.resources().map(frame=>frame.kind),['snapshot','ready']);
 authorization=pending();const before=out.resources().length;await store.save({...room,room_name:'Awaiting authorization'});
 await new Promise(r=>setTimeout(r,2100));assert.equal(out.resources().length,before,'coverage may not claim a commit whose content is awaiting authorization');
 release();for(let retry=0;retry<50 && out.resources().filter(frame=>frame.kind==='snapshot').length<2;retry++)await new Promise(r=>setTimeout(r,5));
 assert.equal(out.resources().filter(frame=>frame.kind==='snapshot').at(-1).payload[0].room_name,'Awaiting authorization');
});

test('resource projections keep file bytes on demand while public history still returns them', async t => {
 const fs=await import('node:fs');const {createHash}=await import('node:crypto');const {RoomService}=await import('../src/service.ts');const {CoworkResourceViews}=await import('../src/resource-views.ts');
 let blobReads=0;const store=fixture(t,{fs:{...fs,openSync(path,...args){if(String(path).includes('/blobs/'))blobReads++;return fs.openSync(path,...args);}}});
 await store.create(room);const data=Buffer.from('private file content');
 const record=await store.append(ID,{version:1,kind:'file',room_id:ID,at:room.created_at,file_id:ID,author:{identity:'alice',display_name:'Alice',role:'builder'},filename:'evidence.bin',mime:'application/octet-stream',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),data_base64:data.toString('base64'),recipient_identities:[],source_file_id:1});
 blobReads=0;const service=new RoomService(store,{});const out=output();const views=new CoworkResourceViews(store,d=>service.resourceRoom(d.roomId));t.after(()=>views.close());const connection=views.open(out.response,'owner',async()=>true);const binding=views.register('owner',connection.connectionId,'room',1,{viewId:'room',resource:'room',roomId:ID});
 const baseline=await views.bound('owner',connection.connectionId,'room',1,binding.baselineId);
 assert.equal(blobReads,0,'metadata projection must not read file blobs');
 assert.equal('data_base64' in baseline.payload.history[0],false);
 await store.save({...room,room_name:'Metadata commit'});
 for(let retry=0;retry<100&&out.resources().filter(frame=>frame.kind==='snapshot').length<2;retry++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(out.resources().filter(frame=>frame.kind==='snapshot').length,2);
 assert.equal(blobReads,0);assert.ok(out.resources().filter(frame=>frame.kind==='snapshot').every(frame=>!JSON.stringify(frame.payload).includes('data_base64')));
 const {createServiceRoutes}=await import('../src/command-routes.ts');
 const route=createServiceRoutes(service)['room.history'];assert.equal(route.auth,true);
 const metadata=await route.run({room_id:ID,after:0,limit:1,view:'operator-metadata'});
 assert.equal(metadata.length,1);assert.equal(metadata[0].record_id,record.record_id);
 assert.equal('data_base64' in metadata[0],false);assert.equal(blobReads,0,'recovery must not open file blobs');
 assert.deepEqual(await route.run({room_id:ID,after:record.seq,limit:1,view:'operator-metadata'}),[]);
 assert.deepEqual(await service.history(ID,{view:'participant'}),[]);
 assert.deepEqual(await service.history(ID,{after:record.seq-1,limit:1}),[record],'existing explicit authenticated history read retains exact bytes');assert.ok(blobReads>0);
});
