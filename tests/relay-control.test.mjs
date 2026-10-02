import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {OursClient} from '@ours.network/sdk/client';
import {CoworkStore} from '../src/storage.ts';
import {RoomService} from '../src/service.ts';
import {CoworkDaemon} from '../src/daemon-runtime.ts';
import {SdkRoomPacket} from '../src/packets.ts';

const IDS=['01jz6y7n8p9q0r1s2t3v4w5x6y','01jz6y7n8p9q0r1s2t3v4w5x70'];
const A='A'.repeat(64),B='B'.repeat(64),CID='C'.repeat(64),AT='2026-08-02T10:11:12.000Z';
const tick=()=>new Promise(r=>setImmediate(r));
async function turnsUntil(check,missing='required control progress'){const deadline=Date.now()+1500;while(Date.now()<deadline){if(check())return;await tick();}assert.fail(missing+' did not become observable before the assertion deadline');}
function incoming(n,text='STOP synthetic fixture'){
 return {seq:n,msg_id:n,from:{id:A,name:'Member 0'},peer:{id:A,name:'Member 0'},direction:'in',occurred_at_ms:Date.parse(AT),date:AT,encryption:'e2e',inbox_state:'unread',status:'unread',message_kind:'text',wire_id:n.toString(16).padStart(64,'0'),reply_to:null,text,body:text,transport:'double_ratchet',delivery_state:null,human_read_at_ms:null};
}
async function fixture({file=false,binding=false,lost=false,ackFailure=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'cowork-relay-control-'));const store=new CoworkStore(dir),packets=new Map(),states=[],work=[];
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let destroys=0;
 const track=p=>{work.push(p);void p.catch(()=>{});return p;};
 const rows=id=>{const db=new DatabaseSync(join(dir,'rooms',id,'archive.sqlite3'),{readOnly:true});try{return db.prepare('SELECT payload_json FROM records').all().map(r=>JSON.parse(r.payload_json));}finally{db.close();}};
 try{
  for(const [i,id] of IDS.entries()){
   const state={inbox:[],sends:[],files:[],results:[],operations:[],contacts:[A,B].map(container_id=>({container_id,name:'Synthetic'}))};states.push(state);
   const client=new OursClient({url:'http://127.0.0.1:1',leaseToken:`isolated-control-${i}`,fetch:async(url,options)=>{
    const op=new URL(url).pathname.split('/').at(-1),input=JSON.parse(options.body);state.operations.push(op);let out;
    if(op==='listIncomingMessages')out=state.inbox;
    else if(op==='listIncomingFiles'||op==='listInvites')out=[];
    else if(op==='getHistoryItem')out=state.inbox.find(m=>m.wire_id===input.wire_id)??null;
    else if(op==='getMessages'){if(i===0&&ackFailure){ackFailure=false;throw new Error('synthetic ACK failure');}const selected=state.inbox.splice(0,input.limit);out={messages:selected.map(m=>({...m,status:'read',inbox_state:'read'})),remaining:state.inbox.length};}
    else if(op==='sendMessage'){
     state.sends.push(input);
     if(i===0&&state.sends.length===1){
      if(binding)return new Response(JSON.stringify({error:{code:'NOT_BOUND',message:'synthetic definite refusal'}}),{status:400,headers:{'content-type':'application/json'}});
      entered();await gate;if(lost)throw new Error('synthetic lost send response');
     }
     out={kind:'sent',wireId:`synthetic-${i}-${state.sends.length}`,sent:true,history_stored:true};
    }else if(op==='sendFile'){state.files.push(input);out={kind:'sent',wireId:'synthetic-file',sent:true,history_stored:true,filename:input.filename,mime:input.mime,bytes:Buffer.from(input.data_base64,'base64').length};}
    else if(op==='chooseIdentity'){entered();await gate;out={cid:CID,name:`ours-cowork:Control ${i}`};}
    else if(op==='setCommandCatalog')out={published:true};
    else if(op==='sendCommandResult'){state.results.push(input);out={sent:true,wire_id:'synthetic-command-result',history_stored:true};}
    else if(op==='listContacts')out={contacts:state.contacts,origins:{}};
    else if(op==='generateInvite')out={blob:Buffer.from('synthetic').toString('base64'),inviteId:'synthetic-invite',reusable:false};
    else if(op==='removeContact'){state.contacts=state.contacts.filter(c=>c.container_id!==input.contact);out={notified:true};}
    else throw new Error(`unexpected isolated operation ${op}`);
    return new Response(JSON.stringify(out),{status:200,headers:{'content-type':'application/json'}});
   }});
   const packet=new SdkRoomPacket(`ours-cowork:Control ${i}`,CID,client);packets.set(id,packet);await packet.refresh();
   await store.create({version:2,room_id:id,room_name:`Control ${i}`,identity_name:packet.name,identity_cid:CID,mission:{goal:'Synthetic',briefing:'Synthetic',briefing_version:1},role_briefings:{},state:'active',invites:[],created_at:AT,activated_at:AT,anonymous:false,quiet_membership:true,membership_epoch:2,command_grants:[{caller_cid:A,command:'room.close'},{caller_cid:A,command:'room.delete'}],seats:[A,B].map((identity,j)=>({identity,display_name:`Member ${j}`,role:'builder',invite_id:'synthetic-existing',accepted_at:AT,state:'active',participant_id:`01jz6y7n8p9q0r1s2t3v4w5xa${j+1}`}))});
   const common={version:1,room_id:id,at:AT,author:{identity:A,display_name:'Member 0',role:'builder'},recipient_identities:[B]};
   if(file&&i===0){const bytes=Buffer.from('file');await store.append(id,{...common,kind:'file',file_id:'01jz6y7n8p9q0r1s2t3v4w5xt1',source_file_id:7,source_wire_id:'E'.repeat(64),filename:'synthetic.txt',mime:'text/plain',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),data_base64:bytes.toString('base64')});}
   else await store.append(id,{...common,kind:'message',message_id:`01jz6y7n8p9q0r1s2t3v4w5xt${i+1}`,category:'chat',text:'Synthetic parent'});
  }
  const registry={get:id=>packets.get(id),async destroy(id){destroys++;packets.delete(id);return[];}};
  const service=new RoomService(store,registry);
  return {dir,store,service,states,packets,started,release,track,rows,work,get destroys(){return destroys;},async cleanup(){release();await Promise.allSettled(work);rmSync(dir,{recursive:true,force:true});}};
 }catch(error){release();await Promise.allSettled(work);rmSync(dir,{recursive:true,force:true});throw error;}
}
async function start(f){const first=f.track(f.service.resumePending(IDS[0]));await Promise.race([f.started,first.then(()=>{throw new Error('fixture did not dispatch expected gate');})]);}

test('pending relay response permits STOP archive and invite/removal receipts',async()=>{
 const f=await fixture();try{
  await start(f);f.states[0].inbox.push(incoming(1));f.track(f.service.notifyRoom(IDS[0]));
  let invited=false,removed=false;
  f.track(f.service.createInvite(IDS[0],{mode:'one_time',min_accepts:1}).then(()=>{invited=true;}));
  f.track(f.service.removeParticipant(IDS[0],{participant:B,notify:false}).then(()=>{removed=true;}));
  await f.track(f.service.resumePending(IDS[1]));assert.equal(f.states[1].sends.length,1,'independent room is a positive control');
  await turnsUntil(()=>invited&&removed&&f.rows(IDS[0]).some(r=>r.kind==='message'&&r.text==='STOP synthetic fixture'));
  assert.equal(invited,true,'invite receipt must complete while old response is held');
  assert.equal(removed,true,'removal receipt must complete while old response is held');
  assert.equal(f.rows(IDS[0]).some(r=>r.kind==='message'&&r.text==='STOP synthetic fixture'),true,'later STOP must be durably archived');
  assert.equal(f.states[0].inbox.length,0,'archived source is SDK-consumed');
  assert.equal(f.states[0].sends.length,1,'no overlapping or retry dispatch');
  assert.equal(f.rows(IDS[0]).some(r=>r.kind==='relay_result'),false,'response remains unknown');
  f.release();await Promise.all(f.work);await f.track(f.service.drain());assert.equal(invited,true);assert.equal(removed,true);assert.equal(f.rows(IDS[0]).some(r=>r.kind==='message'&&r.text==='STOP synthetic fixture'),true);
 }finally{await f.cleanup();}
});

test('removed recipient during file notice gets no binary or subsequent room body',async()=>{
 const f=await fixture({file:true});try{
  await start(f);let removed=false;f.track(f.service.removeParticipant(IDS[0],{participant:B,notify:false}).then(()=>{removed=true;}));
  await turnsUntil(()=>removed);assert.equal(removed,true,'membership removal completes while notice response is held');
  f.release();await f.track(f.service.drain());
  assert.equal(f.states[0].files.length,0,'binary must recheck current membership after irreversible notice');
  const result=f.rows(IDS[0]).find(r=>r.kind==='relay_result');assert.equal(result.status,'skipped_removed');
 }finally{await f.cleanup();}
});

test('removed recipient during definite binding rebind gets no redispatch',async()=>{
 const f=await fixture({binding:true});try{
  await start(f);let removed=false;f.track(f.service.removeParticipant(IDS[0],{participant:B,notify:false}).then(()=>{removed=true;}));
  await turnsUntil(()=>removed);assert.equal(removed,true,'rebind wait must not own room mutex');
  f.release();await f.track(f.service.drain());
  assert.equal(f.states[0].sends.length,1,'known refusal recovery must reprepare membership before dispatch');
  assert.equal(f.rows(IDS[0]).find(r=>r.kind==='relay_result').status,'skipped_removed');
 }finally{await f.cleanup();}
});

test('unknown relay failure with forty-item automatic ingress backlog attempts once',async()=>{
 const f=await fixture({lost:true});try{
  await start(f);f.states[0].inbox.push(...Array.from({length:40},(_,i)=>incoming(i+1,`Synthetic queued ${i}`)));f.track(f.service.notifyRoom(IDS[0]));
  await turnsUntil(()=>f.states[0].inbox.length===0);
  assert.equal(f.states[0].inbox.length,0,'automatic ingress continues beyond one snapshot while send is pending');
  f.release();const outcomes=await Promise.allSettled(f.work);assert.equal(outcomes.some(o=>o.status==='rejected'&&o.reason.message.includes('synthetic lost send response')),true,'unknown transport error remains observable');await f.track(f.service.drain());
  assert.equal(f.states[0].sends.length,1,'internal backlog continuation must not replay unknown send');
  assert.equal(f.rows(IDS[0]).some(r=>r.kind==='relay_result'&&r.message_id==='01jz6y7n8p9q0r1s2t3v4w5xt1'),false);
 }finally{await f.cleanup();}
});

test('close marks durable closing and waits response result before unhosting',async()=>{
 const f=await fixture();try{
  await start(f);let closed=false;f.track(f.service.closeRoom(IDS[0]).then(()=>{closed=true;}));
  const metadata=()=>JSON.parse(readFileSync(join(f.dir,'rooms',IDS[0],'room.json'),'utf8'));
  await turnsUntil(()=>metadata().state==='closing');
  assert.equal(metadata().state,'closing','lifecycle authority is durable before outside wait');
  assert.equal(closed,false);await assert.rejects(f.service.updateRoom(IDS[0],{status:'too late'}),/while it is closing/i);const duplicate=f.track(f.service.closeRoom(IDS[0]));assert.equal(f.destroys,0);assert.equal(f.rows(IDS[0]).some(r=>r.kind==='relay_result'),false);
  f.release();await f.track(f.service.drain());await turnsUntil(()=>closed);assert.equal(closed,true);
  assert.equal(f.destroys,1);assert.deepEqual(await duplicate,await f.service.showRoom(IDS[0]));await assert.rejects(f.service.updateRoom(IDS[0],{status:'still too late'}),/while it is closed/i);assert.equal(f.rows(IDS[0]).find(r=>r.kind==='relay_result').status,'queued');
 }finally{await f.cleanup();}
});

for(const rejection of [false,true])test(`claimed ${rejection?'private rejection':'removed-seat bounce'} does not block later STOP intake`,async()=>{
 const f=await fixture();try{
  const row=incoming(1,'Synthetic rejected source');
  if(rejection)row.reply_to={wire_id:'F'.repeat(64)};
  else{const room=await f.store.load(IDS[0]);room.membership_epoch=3;room.command_grants=[];room.seats[0]={...room.seats[0],state:'removed',removed_at:AT,removed_epoch:3};await f.store.save(room);}
  f.states[0].inbox.push(row);await start(f);
  const stop=incoming(2);if(!rejection){stop.from={id:B,name:'Member 1'};stop.peer=stop.from;}
  f.states[0].inbox.push(stop);f.track(f.service.notifyRoom(IDS[0]));
  await turnsUntil(()=>f.rows(IDS[0]).some(r=>r.kind==='message'&&r.text===stop.text));
  assert.equal(f.rows(IDS[0]).some(r=>r.kind==='message'&&r.text===stop.text),true,'one-time notice response must not block ordinary source archive');
  assert.equal(f.states[0].inbox.length,0);assert.equal(f.states[0].sends.length,1);
  if(rejection)assert.equal(f.rows(IDS[0]).find(r=>r.kind==='intake_rejection').notification_attempt_claimed,true);
  else assert.equal(JSON.parse(readFileSync(join(f.dir,'rooms',IDS[0],'room.json'),'utf8')).seats[0].bounced_at!==undefined,true);
 }finally{await f.cleanup();}
});

test('accepted SDK lifecycle command waits response commit without ingress self-await',async()=>{
 const f=await fixture();try{
  await f.service.reloadConsumerCommands(IDS[0]);await start(f);
  const command=incoming(1);command.message_kind='command';command.body=JSON.stringify({command:'room.close',arguments:{}});command.text=command.body;
  f.states[0].inbox.push(command);f.track(f.service.notifyRoom(IDS[0]));
  await turnsUntil(()=>f.states[0].results.length>0);
  assert.equal(f.states[0].results.length,1,'SDK accepted command result must precede old relay response');
  assert.equal(f.states[0].results[0].outcome.ok,true);assert.equal(f.states[0].results[0].outcome.result.result.status,'accepted');
  assert.equal(f.destroys,0);assert.equal(f.rows(IDS[0]).some(r=>r.kind==='relay_result'),false);
  f.release();await f.track(f.service.drain());await turnsUntil(()=>f.destroys===1);
  assert.equal(f.destroys,1);assert.equal((await f.store.load(IDS[0])).lifecycle_request.state,'completed');
  assert.equal(f.rows(IDS[0]).find(r=>r.kind==='relay_result').status,'queued');
 }finally{await f.cleanup();}
});

test('concurrent close and delete wait pending result and cannot recreate deleted room',async()=>{
 const f=await fixture();try{
  await start(f);const close=f.track(f.service.closeRoom(IDS[0])),deletion=f.track(f.service.deleteRoom(IDS[0],{confirm:true}));
  const metadata=()=>JSON.parse(readFileSync(join(f.dir,'rooms',IDS[0],'room.json'),'utf8'));
  await turnsUntil(()=>metadata().state==='closing');assert.equal(metadata().state,'closing');assert.equal(f.destroys,0);
  f.release();await Promise.all([close,deletion]);assert.equal(f.destroys,1);
  assert.equal(existsSync(join(f.dir,'rooms',IDS[0])),false);
  await assert.rejects(f.service.closeRoom(IDS[0]));assert.equal(existsSync(join(f.dir,'rooms',IDS[0])),false);
 }finally{await f.cleanup();}
});

test('missing unread metadata and source archive failure never dispatch',async()=>{
 const f=await fixture();try{
  f.packets.get(IDS[0]).listUnreadSourceIds=async()=>{throw new Error('synthetic unread metadata unavailable');};
  await assert.rejects(f.service.resumePending(IDS[0]),/unread metadata unavailable/);assert.equal(f.states[0].sends.length,0);
  const append=f.store.append.bind(f.store);f.store.append=async(id,row)=>{if(row.kind==='message'&&row.source_msg_id!==undefined)throw new Error('synthetic archive fsync failure');return append(id,row);};
  f.states[1].inbox.push(incoming(1));await assert.rejects(f.service.resumePending(IDS[1]),/archive fsync failure/);
  assert.equal(f.states[1].sends.length,0);assert.equal(f.states[1].inbox.length,1,'failed source remains SDK unread');
 }finally{await f.cleanup();}
});

test('result fsync failure prevents later ordered effect',async()=>{
 const f=await fixture();try{
  await f.store.append(IDS[0],{version:1,kind:'message',room_id:IDS[0],at:AT,message_id:'01jz6y7n8p9q0r1s2t3v4w5xt3',author:{identity:A,display_name:'Member 0',role:'builder'},category:'chat',text:'Later synthetic',recipient_identities:[B]});
  const append=f.store.append.bind(f.store);f.store.append=async(id,row)=>{if(row.kind==='relay_result')throw new Error('synthetic result fsync failure');return append(id,row);};
  const completion=f.track(f.service.resumePending(IDS[0]));await f.started;f.release();
  await assert.rejects(completion,/result fsync failure/);assert.equal(f.states[0].sends.length,1);assert.equal(f.rows(IDS[0]).some(r=>r.kind==='relay_result'),false);
 }finally{await f.cleanup();}
});

test('shutdown waits unknown response and preserves later SDK unread source',async()=>{
 const f=await fixture();try{
  await start(f);f.service.beginShutdown();f.states[0].inbox.push(incoming(1));
  let drained=false;const drain=f.track(f.service.drain().then(()=>{drained=true;}));f.track(f.service.notifyRoom(IDS[0]));
  for(let n=0;n<10;n++)await tick();assert.equal(drained,false);assert.equal(f.states[0].inbox.length,1);
  f.release();await drain;assert.equal(f.rows(IDS[0]).find(r=>r.kind==='relay_result').status,'queued');assert.equal(f.states[0].inbox.length,1);
 }finally{await f.cleanup();}
});

test('stale claimed bounce does not revive after removal rejoin and removal',async()=>{
 const f=await fixture();try{
  const room=await f.store.load(IDS[0]);room.membership_epoch=3;room.command_grants=[];room.seats[0]={...room.seats[0],state:'removed',removed_at:AT,removed_epoch:3};await f.store.save(room);
  await start(f);f.states[0].inbox.push(incoming(1,'Synthetic departed message'));f.track(f.service.notifyRoom(IDS[0]));
  const metadata=()=>JSON.parse(readFileSync(join(f.dir,'rooms',IDS[0],'room.json'),'utf8'));
  await turnsUntil(()=>metadata().seats[0].bounced_at!==undefined,'claimed immutable bounce');
  const next=await f.store.load(IDS[0]);next.membership_epoch=4;next.seats.push({...room.seats[0],state:'active',participant_id:'01jz6y7n8p9q0r1s2t3v4w5xa3',removed_at:undefined,removed_epoch:undefined});await f.store.save(next);
  next.membership_epoch=5;next.seats[2]={...next.seats[2],state:'removed',removed_at:AT,removed_epoch:5};await f.store.save(next);
  f.release();await f.track(f.service.drain());assert.equal(f.states[0].sends.length,1,'old bounce claim cannot authorize current departed lifecycle');
 }finally{await f.cleanup();}
});


test('ACK failure frees ingress while claimed rejection waits behind held relay',async()=>{
 const f=await fixture({ackFailure:true});try{
  await start(f);const rejected=incoming(1,'Synthetic rejected');rejected.reply_to={wire_id:'F'.repeat(64)};
  f.states[0].inbox.push(rejected);f.track(f.service.notifyRoom(IDS[0]));
  await turnsUntil(()=>f.states[0].operations.includes('getMessages'));
  await tick();
  f.states[0].inbox.push(incoming(2));f.track(f.service.notifyRoom(IDS[0]));
  await turnsUntil(()=>f.rows(IDS[0]).some(r=>r.kind==='message'&&r.text==='STOP synthetic fixture'));
  assert.equal(f.states[0].inbox.length,0,'fresh notify consumes replay and STOP while old response is held');
  assert.equal(f.rows(IDS[0]).filter(r=>r.kind==='intake_rejection').length,1,'durable claim is not repeated');
  assert.equal(f.states[0].sends.length,1,'claimed notice does not overlap held serial relay');
  f.release();const outcomes=await Promise.allSettled(f.work);await f.track(f.service.drain());
  assert.equal(outcomes.some(o=>o.status==='rejected'&&o.reason.message.includes('synthetic ACK failure')),true,'original ingress failure remains observable');
  assert.equal(f.states[0].sends.filter(send=>JSON.parse(send.text).text==='reply_target_unavailable').length,1,'content-free notice attempts once after response');
 }finally{await f.cleanup();}
});


for(const ambiguity of ['before','after'])for(const lifecycle of ['close','delete'])test(`${lifecycle} retries retain ${ambiguity}-commit result failure barrier`,async()=>{
 const f=await fixture();try{
  const append=f.store.append.bind(f.store);let failed=false;
  f.store.append=async(id,row)=>{
   if(row.kind==='relay_result'&&!failed){failed=true;if(ambiguity==='after')await append(id,row);throw new Error('synthetic result commit ambiguity');}
   return append(id,row);
  };
  await start(f);
  const first=f.track(lifecycle==='close'?f.service.closeRoom(IDS[0]):f.service.deleteRoom(IDS[0],{confirm:true}));
  await turnsUntil(()=>JSON.parse(readFileSync(join(f.dir,'rooms',IDS[0],'room.json'),'utf8')).state==='closing');
  f.release();await assert.rejects(first,/synthetic result commit ambiguity/);
  f.store.append=append;
  for(const retry of ['close','delete'])await assert.rejects(f.track(retry==='close'?f.service.closeRoom(IDS[0]):f.service.deleteRoom(IDS[0],{confirm:true})),/synthetic result commit ambiguity/,'a later lifecycle request cannot infer durable completion');
  assert.equal(f.destroys,0);assert.equal(existsSync(join(f.dir,'rooms',IDS[0],'archive.sqlite3')),true);
  assert.equal(f.states[0].sends.length,1,'retained failure never redispatches an observed operation');
  assert.equal((await f.store.load(IDS[0])).state,'closing');
  assert.equal(f.rows(IDS[0]).filter(row=>row.kind==='relay_result').length,ambiguity==='after'?1:0,'visible row does not waive failed durability acknowledgment');
 }finally{await f.cleanup();}
});

for(const lifecycle of ['close','delete','shutdown'])test(`${lifecycle} during file notice commits partial outcome before teardown`,async()=>{
 const f=await fixture({file:true});try{
  await start(f);let completed=false;
  const original=f.store.delete.bind(f.store);let erasedResults;
  f.store.delete=async(id)=>{erasedResults=f.rows(id).filter(row=>row.kind==='relay_result');return original(id);};
  let completion;
  if(lifecycle==='shutdown'){f.service.beginShutdown();completion=f.track(f.service.drain().then(()=>{completed=true;}));}
  else {completion=f.track((lifecycle==='close'?f.service.closeRoom(IDS[0]):f.service.deleteRoom(IDS[0],{confirm:true})).then(()=>{completed=true;}));await turnsUntil(()=>JSON.parse(readFileSync(join(f.dir,'rooms',IDS[0],'room.json'),'utf8')).state==='closing');}
  assert.equal(completed,false);assert.equal(f.destroys,0);f.release();await completion;
  const results=erasedResults??f.rows(IDS[0]).filter(row=>row.kind==='relay_result');
  assert.equal(f.states[0].files.length,0,'no binary dispatch after lifecycle authority');
  assert.equal(results.length,1,'observed notice phase is durable before teardown');
  assert.equal(results[0].metadata_wire_id,'synthetic-0-1');
  assert.equal(results[0].status,'send_failed','a suppressed binary must never be claimed queued');
  assert.equal(results[0].wire_id,undefined);
  assert.equal(f.states[0].sends.length,1);
 }finally{await f.cleanup();}
});


for(const ambiguity of ['before','after'])test(`daemon shutdown after exited ${ambiguity}-commit failure retains host and archive`,async()=>{
 const f=await fixture();try{
  const append=f.store.append.bind(f.store);f.store.append=async(id,row)=>{if(row.kind==='relay_result'){if(ambiguity==='after')await append(id,row);throw new Error('synthetic shutdown commit failure');}return append(id,row);};
  const completion=f.track(f.service.resumePending(IDS[0]));await f.started;f.release();await assert.rejects(completion,/synthetic shutdown commit failure/);
  const events=[];const daemon=new CoworkDaemon({config:{version:1,stateDir:f.dir,rest:{enabled:false,port:3010}},prepare:()=>({socketPath:join(f.dir,'test.sock')}),lock:()=>({release(){events.push('lock.release');}}),host:{async boot(){},close(){events.push('host.close');}},store:{async list(){return[];}},registry:{async unhostAll(){events.push('unhost');}},service:f.service,writePid(){},removePid(){events.push('pid.remove');},transports:{async start(){},async stop(){events.push('transports.stop');}}});
  await daemon.boot();
  await assert.rejects(f.track(daemon.shutdown()),error=>error instanceof AggregateError&&error.errors.some(cause=>cause.message.includes('synthetic shutdown commit failure')));
  await assert.rejects(f.track(daemon.shutdown()));
  assert.equal(events.includes('transports.stop'),true,'notification transport stops as positive control');
  assert.equal(events.includes('unhost'),false);assert.equal(events.includes('host.close'),false);assert.equal(events.includes('lock.release'),false);assert.equal(events.includes('pid.remove'),false);
  assert.equal(existsSync(join(f.dir,'rooms',IDS[0],'archive.sqlite3')),true);assert.equal(f.states[0].sends.length,1);
 }finally{await f.cleanup();}
});
