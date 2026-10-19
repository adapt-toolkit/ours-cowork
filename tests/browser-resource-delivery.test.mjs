// Real committed store/service → management HTTP resource transport → shipped UI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CoworkStore } from '../src/storage.ts';
import { RoomService } from '../src/service.ts';
import { CoworkResourceViews } from '../src/resource-views.ts';
import { createServiceRoutes, RpcDispatcher, TransportServer } from '../src/transports.ts';
import { createStaticWebHandler, loadWebAssets } from '../src/web.ts';
import { chromium } from 'playwright-core';
const ID='01jz6y7n8p9q0r1s2t3v4w5x6y';
const room={version:2,room_id:ID,room_name:'Live committed room',identity_name:`cowork-room-${ID}`,identity_cid:'cid',mission:{goal:'Goal',briefing:'Brief',briefing_version:1},role_briefings:{},rest_roles:[],command_grants:[],role_command_grants:[],anonymous:false,quiet_membership:false,membership_epoch:0,state:'provisioning',invites:[],seats:[],created_at:'2026-08-02T10:11:12.345Z'};

test('committed separate-writer room, participant and loaded history changes render without event or periodic reads', {timeout:120000,skip:process.env.FULL_RESOURCE_QUALIFY!=='1'}, async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cowork-delivery-'));
 const retainState=process.env.KEEP_RESOURCE_TEST_STATE==='1';
 if(retainState)console.log(`Retaining resource test state: ${dir}`);
 const store=new CoworkStore(dir), service=new RoomService(store,{});
 await store.create(room);
 for(let index=0;index<201;index++)await store.append(ID,{version:1,kind:'message',room_id:ID,at:room.created_at,message_id:ID.slice(0,19)+String(index).padStart(7,'0'),author:{identity:'alice',display_name:'Live Alice',role:'Participant'},category:'chat',text:`Loaded history ${index}: `+'x'.repeat(4096),recipient_identities:[]});
 const views=new CoworkResourceViews(store,(d,_signal,_owner,after)=>d.resource==='rooms'?service.listRooms():service.resourceRoom(d.roomId,after));
 let decodedRows=0;const historyStarts=[],readMetadata=store.readMetadata.bind(store);store.readMetadata=async(id,options)=>{historyStarts.push(options.after);const rows=await readMetadata(id,options);decodedRows+=rows.length;return rows;};
 const frameBytes=[],healthWire=[];let chunks=0,roomUpdates=0;const open=views.open.bind(views);views.open=(response,...args)=>{const write=response.write.bind(response);response.write=(chunk,...rest)=>{frameBytes.push(Buffer.byteLength(chunk));if(String(chunk).startsWith('event: resource-coverage\n')){const batch=JSON.parse(String(chunk).split('data: ')[1]);healthWire.push({at:Date.now(),bytes:Buffer.byteLength(chunk),entries:batch.views.length});}if(String(chunk).startsWith('event: resource-chunk'))chunks++;if(String(chunk).includes('"type":"room-update"'))roomUpdates++;return write(chunk,...rest);};return open(response,...args);};
 const dispatcher=new RpcDispatcher(createServiceRoutes(service));
 let allowed=true,authCalls=0;
 const transport=new TransportServer({socketPath:join(dir,'control.sock'),rest:{enabled:true,port:0},unixDispatcher:dispatcher,restDispatcher:dispatcher,management:{dispatcher,authorize:async req=>{authCalls++;return allowed&&req.headers['x-ours-api-token']==='operator';}},resources:views,staticHandler:createStaticWebHandler(loadWebAssets('dist/web'))});
 let browser;
 t.after(async()=>{await browser?.close();await transport.stop();if(!retainState)rmSync(dir,{recursive:true,force:true});});
 await transport.start();
 browser=await chromium.launch({headless:true,executablePath:process.env.COWORK_CHROME_PATH});
 const page=await browser.newPage(), requests=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{const url=new URL(r.url());requests.push({path:url.pathname,method:r.method(),body:r.postData(),at:Date.now()});});
 const origin=`http://127.0.0.1:${transport.restAddress.port}`;
 await page.goto(origin);
 await page.getByLabel('Server credential').fill('operator');
 await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByText('Live committed room',{exact:true}).click();
 await page.getByRole('heading',{name:'Live committed room',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Communication',exact:true}).click();
 await page.getByText(/^Loaded history 0:/).waitFor();await page.getByText(/^Loaded history 200:/).waitFor();
 assert.equal(await page.getByRole('list',{name:'Room communication'}).getByRole('listitem').count(),201,'complete ordered loaded range renders');
 assert.ok(chunks>0,'large baseline uses bounded chunk delivery');assert.ok(frameBytes.every(bytes=>bytes<=512*1024));
 const content=()=>requests.filter(r=>r.path.endsWith('/rpc')&&/room\.(list|show|participants|history)/.test(r.body??''));
 const baseline=content().length,frameStart=frameBytes.length;decodedRows=0;historyStarts.length=0;
 const seat={identity:'alice',display_name:'Live Alice',role:'Participant',invite_id:'invite',participant_id:ID,state:'active',accepted_at:room.created_at};
 // These are the existing supported worker commit seams, independent of the browser.
 const started=Date.now();
 await store.save({...room,seats:[seat]});
 await store.append(ID,{version:1,kind:'message',room_id:ID,at:room.created_at,message_id:ID,author:{identity:'alice',display_name:'Live Alice',role:'Participant'},category:'chat',text:'Actual committed live history',recipient_identities:[]});
 await page.getByRole('tab',{name:'Communication',exact:true}).click();
 await page.getByText('Actual committed live history',{exact:true}).waitFor();
 const commitToRenderMs=Date.now()-started;
 assert.equal(content().length,baseline,'first participant/history commit requires no content RPC');
 const liveUpdateBytes=frameBytes.slice(frameStart).reduce((sum,bytes)=>sum+bytes,0),liveDecodedRows=decodedRows;
 assert.ok(roomUpdates>0,'production cursor adapter emits incremental room units');
 assert.ok(historyStarts.length>0&&historyStarts.every(after=>after>=201),'live captures start after retained archive');
 assert.ok(liveDecodedRows>0&&liveDecodedRows<=3,'bounded capture attempts decode only the appended tail');
 assert.ok(liveUpdateBytes<16000,`small update sent ${liveUpdateBytes} bytes rather than retained archive`);
 const authBaseline=authCalls,idle=Date.now();
 await page.waitForTimeout(Number(process.env.RESOURCE_QUALIFY_IDLE_MS??60000));
 const healthyIdleMs=Date.now()-idle,idleHealth=healthWire.filter(frame=>frame.at>=idle);
 const idleHealthMetrics={envelopes:idleHealth.length,entries:idleHealth.reduce((n,f)=>n+f.entries,0),bodyBytes:idleHealth.reduce((n,f)=>n+f.bytes,0)};
 assert.ok(idleHealthMetrics.envelopes<=(healthyIdleMs<61000?5:Math.floor(healthyIdleMs/15000)+1));
 assert.equal(content().length,baseline,'zero healthy periodic and event-driven content RPC');
 assert.equal(authCalls,authBaseline,'idle coverage performs no indirect auth GET/RPC');
 await store.save({...room,room_name:'Renamed committed room',seats:[seat]});
 await page.getByRole('heading',{name:'Renamed committed room',exact:true}).waitFor();
 await store.save({...room,room_name:'Renamed committed room',state:'closed',closed_at:room.created_at,seats:[seat]});
 await store.delete(ID);
 await page.getByText('Actual committed live history',{exact:true}).waitFor({state:'detached'});
 await page.getByRole('heading',{name:'Renamed committed room',exact:true}).waitFor({state:'detached'});
 assert.equal(content().length,baseline,'rename/delete require no content RPC');
 allowed=false;
 await store.create({...room,room_name:'Denied room'});
 await page.getByRole('heading',{name:'Connect to Cowork'}).waitFor();
 assert.equal(await page.getByText('Denied room',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'cowork-committed-source-to-render PASS',healthyIdleMs,idleHealthMetrics,commitToRenderMs,initialContentRPCs:baseline,healthyPeriodicContentRPCs:0,eventContentRPCs:0,idleAuthCalls:0,loadedHistoryRows:201,liveDecodedRows,liveUpdateBytes,roomUpdates,maxFrameBytes:Math.max(...frameBytes),chunks,requests:requests.reduce((counts,r)=>{const key=r.method+' '+r.path;counts[key]=(counts[key]??0)+1;return counts;},{})}));
});


// Exercise the maintained browser consumer without requiring a built/native service.
async function consumerFixture(t, connect = true) {
 const {JSDOM}=await import('jsdom');
 const dom=new JSDOM('',{url:'http://cowork.example/',pretendToBeVisual:true});
 const previous={document:globalThis.document,window:globalThis.window,location:globalThis.location};
 Object.assign(globalThis,{document:dom.window.document,window:dom.window,location:dom.window.location});
 const {createResourceSession}=await import('../web/src/state/poller.ts');
 const health=[],snapshots=[],requests=[];let output;
 const stream=new ReadableStream({start(c){output=c;}});
 const session=createResourceSession({snapshot:(...args)=>snapshots.push(args),health:healthy=>health.push(healthy)},'operator',async(url,options)=>{requests.push({url,options});return url.endsWith('/resources')?new Response(stream,{headers:{'content-type':'text/event-stream'}}):Response.json({});});
 session.watchRoom(ID);
 const send=(event,value)=>output.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
 const source={protocolVersion:1,producerGeneration:'store',position:1,health:'healthy'};
 const frame=(viewId,kind,sequence,revision=1,payload={})=>({protocolVersion:1,producerGeneration:'service',viewId,subscriptionEpoch:1,baselineId:viewId,kind,sequence,revision,payload});
 const entry=(viewId,sequence)=>({...frame(viewId,'coverage',sequence),source});
 const batch=(entries,producerGeneration='service')=>send('resource-coverage',{protocolVersion:1,producerGeneration,views:entries});
 t.after(()=>{session.close();Object.assign(globalThis,previous);dom.window.close();});
 if(connect)send('resource-connection',{protocolVersion:1,connectionId:'connection',producerGeneration:'service'});
 await consumerSettle();
 const ready=async()=>{for(const viewId of ['rooms',`room_${ID}`]){send('resource',frame(viewId,'snapshot',1,1,viewId==='rooms'?[{room_id:ID}]:{history:[]}));send('resource',frame(viewId,'ready',2,1,{baselineId:viewId,source}));}await consumerSettle();};
 return {send,sendRaw:wire=>output.enqueue(new TextEncoder().encode(wire)),source,frame,entry,batch,ready,health,snapshots,session,requests,dom};
}
const consumerSettle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};

test('browser shared coverage keeps two views independent through the 45-second deadline',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000});
 const f=await consumerFixture(t);await f.ready();assert.equal(f.health.at(-1),true);
 t.mock.timers.tick(30_000);f.batch([f.entry('rooms',3),f.entry(`room_${ID}`,3)]);await consumerSettle();
 t.mock.timers.tick(30_000);f.batch([f.entry('rooms',4)]);await consumerSettle();assert.equal(f.health.at(-1),true);
 t.mock.timers.tick(14_999);await consumerSettle();assert.equal(f.health.at(-1),true);
 t.mock.timers.tick(1);await consumerSettle();assert.equal(f.health.at(-1),false,'missing room coverage must expire despite list coverage');
});
for(const invalid of ['generation','gap','source','assembly'])test(`browser coverage batch recovers on invalid ${invalid}`,async t=>{
 const f=await consumerFixture(t);await f.ready();
 if(invalid==='assembly')f.send('resource-chunk',{type:'start',id:'chunk',totalBytes:2,parts:1});
 const entry=f.entry('rooms',invalid==='gap'?4:3);if(invalid==='source')entry.source={...f.source,position:-1};
 f.batch([entry],invalid==='generation'?'wrong':'service');await consumerSettle();assert.equal(f.health.at(-1),false);
});
test('browser source-qualified complete data renews health while stale data and partial history do not',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000});
 const f=await consumerFixture(t);await f.ready();
 t.mock.timers.tick(30_000);
 for(const viewId of ['rooms',`room_${ID}`])f.send('resource',{...f.frame(viewId,'snapshot',3,2,viewId==='rooms'?[{room_id:ID}]:{history:[]}),source:{...f.source,position:2}});
 await consumerSettle();t.mock.timers.tick(30_000);
 f.batch([{...f.entry('rooms',4),revision:2,source:{...f.source,position:2}}]);
 f.send('resource',{...f.frame(`room_${ID}`,'snapshot',4,2,{history:[]}),source:{...f.source,position:3}});
 await consumerSettle();assert.equal(f.health.at(-1),true);
 t.mock.timers.tick(15_000);await consumerSettle();assert.equal(f.health.at(-1),false);
});
test('browser startup remains fixed at ten seconds despite partial traffic',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000});
 const f=await consumerFixture(t);t.mock.timers.tick(9999);f.send('resource',f.frame('rooms','snapshot',1,1,[{room_id:ID}]));await consumerSettle();
 t.mock.timers.tick(1);await consumerSettle();assert.equal(f.health.at(-1),false);
});

test('browser replaced epochs cannot renew a new room and incomplete history cannot renew the current room',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000});
 const f=await consumerFixture(t);await f.ready();
 f.session.unwatchRoom(ID);f.session.watchRoom(ID);await consumerSettle();
 const current=(kind,sequence,payload)=>({...f.frame(`room_${ID}`,kind,sequence,1,payload),subscriptionEpoch:2});
 f.send('resource',current('snapshot',1,{history:[]}));f.send('resource',current('ready',2,{baselineId:`room_${ID}`,source:f.source}));await consumerSettle();
 t.mock.timers.tick(30_000);
 f.batch([f.entry('rooms',3),{...f.entry(`room_${ID}`,3),source:{...f.source,position:100}}]);
 f.send('resource',{...current('upsert',3,{type:'room-update',historyAfter:0,room:{},participants:[]}),revision:2,source:{...f.source,position:2}});
 await consumerSettle();assert.equal(f.health.at(-1),true);
 t.mock.timers.tick(15_000);await consumerSettle();assert.equal(f.health.at(-1),false,'old epoch and unfinished history grant no coverage');
});
test('browser resumes by retiring expired ownership before queued coverage',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000});
 const f=await consumerFixture(t);await f.ready();
 t.mock.timers.setTime(145000);
 f.batch([f.entry('rooms',3),f.entry(`room_${ID}`,3)]);
 f.dom.window.dispatchEvent(new f.dom.window.Event('pageshow'));
 await consumerSettle();assert.equal(f.health.at(-1),false);
});
test('browser completed history page qualifies its shared logical revision only after final commit',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000});
 const f=await consumerFixture(t);await f.ready();t.mock.timers.tick(30_000);
 f.batch([f.entry('rooms',3)]);
 f.send('resource',f.frame(`room_${ID}`,'upsert',3,2,{type:'room-update',historyAfter:0,room:{},participants:[]}));
 f.send('resource',{...f.frame(`room_${ID}`,'upsert',4,2,{type:'history-page',records:[{seq:1}],complete:true}),source:{...f.source,position:2}});
 await consumerSettle();t.mock.timers.tick(30_000);assert.equal(f.health.at(-1),true);f.batch([{...f.entry('rooms',4),source:f.source}]);await consumerSettle();
 assert.equal(f.health.at(-1),true,'final page source extends room health despite revision shared with start unit');
});
test('browser newly registered view keeps ten-second ready budget after connection establishment',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000});
 const f=await consumerFixture(t);await f.ready();f.session.unwatchRoom(ID);f.session.watchRoom(ID);await consumerSettle();
 f.send('resource',{...f.frame(`room_${ID}`,'snapshot',1,1,{history:[]}),subscriptionEpoch:2,source:f.source});
 await consumerSettle();t.mock.timers.tick(9999);await consumerSettle();assert.equal(f.health.at(-1),true);
 t.mock.timers.tick(1);await consumerSettle();assert.equal(f.health.at(-1),false);
});


test('held canonical intake expires through the browser owner despite live sibling batches',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000});
 const f=await consumerFixture(t,false),dir=mkdtempSync(join(tmpdir(),'cowork-held-browser-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new CoworkStore(dir);await store.create(room);
 const response=Object.assign(new (await import('node:events')).EventEmitter(),{destroyed:false,writableEnded:false,write(wire){f.sendRaw(wire);return true;},end(){this.writableEnded=true;this.emit('close');}});
 const views=new CoworkResourceViews(store,async descriptor=>descriptor.resource==='rooms'?store.list():{room:await store.load(ID),history:[]});t.after(()=>views.close());
 const connection=views.open(response,'owner',async()=>true);await consumerSettle();
 for(const descriptor of [{viewId:'rooms',resource:'rooms'},{viewId:`room_${ID}`,resource:'room',roomId:ID}]){const b=views.register('owner',connection.connectionId,descriptor.viewId,1,descriptor);await views.bound('owner',connection.connectionId,descriptor.viewId,1,b.baselineId);}
 await consumerSettle();assert.equal(f.health.at(-1),true);
 store.setResourceHealth('room-watch',true,ID,true);await consumerSettle();
 for(let tick=0;tick<2;tick++){t.mock.timers.tick(15000);await consumerSettle();assert.equal(f.health.at(-1),true);}
 t.mock.timers.tick(14999);await consumerSettle();assert.equal(f.health.at(-1),true);
 t.mock.timers.tick(1);await consumerSettle();assert.equal(f.health.at(-1),false,'pending canonical room expires at forty-five seconds while list remains live');
 assert.equal(response.writableEnded,false,'consumer recovery retains independent producer ownership until disposal');
 store.setResourceHealth('room-watch',true,ID);await consumerSettle();assert.equal(store.resourcePending(ID),false);
});
