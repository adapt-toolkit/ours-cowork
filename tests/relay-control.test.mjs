import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {OursClient} from '@ours.network/sdk/client';
import {CoworkStore} from '../src/storage.ts';
import {RoomService} from '../src/service.ts';
import {SdkRoomPacket} from '../src/packets.ts';

const IDS=['01jz6y7n8p9q0r1s2t3v4w5x6y','01jz6y7n8p9q0r1s2t3v4w5x70'];
const A='A'.repeat(64),B='B'.repeat(64),CID='C'.repeat(64),AT='2026-08-02T10:11:12.000Z';
const tick=()=>new Promise(r=>setImmediate(r));
async function turnsUntil(check){for(let n=0;n<100;n++){if(check())return;await tick();}}
function incoming(n,text='STOP synthetic fixture'){
 return {seq:n,msg_id:n,from:{id:A,name:'Member 0'},peer:{id:A,name:'Member 0'},direction:'in',occurred_at_ms:Date.parse(AT),date:AT,encryption:'e2e',inbox_state:'unread',status:'unread',message_kind:'text',wire_id:n.toString(16).padStart(64,'0'),reply_to:null,text,body:text,transport:'double_ratchet',delivery_state:null,human_read_at_ms:null};
}
async function fixture({file=false,binding=false,lost=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'cowork-relay-control-'));const store=new CoworkStore(dir),packets=new Map(),states=[],work=[];
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let destroys=0;
 const track=p=>{work.push(p);void p.catch(()=>{});return p;};
 const rows=id=>{const db=new DatabaseSync(join(dir,'rooms',id,'archive.sqlite3'),{readOnly:true});try{return db.prepare('SELECT payload_json FROM records').all().map(r=>JSON.parse(r.payload_json));}finally{db.close();}};
 try{
  for(const [i,id] of IDS.entries()){
   const state={inbox:[],sends:[],files:[],operations:[],contacts:[A,B].map(container_id=>({container_id,name:'Synthetic'}))};states.push(state);
   const client=new OursClient({url:'http://127.0.0.1:1',leaseToken:`isolated-control-${i}`,fetch:async(url,options)=>{
    const op=new URL(url).pathname.split('/').at(-1),input=JSON.parse(options.body);state.operations.push(op);let out;
    if(op==='listIncomingMessages')out=state.inbox;
    else if(op==='listIncomingFiles'||op==='listInvites')out=[];
    else if(op==='getHistoryItem')out=state.inbox.find(m=>m.wire_id===input.wire_id)??null;
    else if(op==='getMessages'){const selected=state.inbox.splice(0,input.limit);out={messages:selected.map(m=>({...m,status:'read',inbox_state:'read'})),remaining:state.inbox.length};}
    else if(op==='sendMessage'){
     state.sends.push(input);
     if(i===0&&state.sends.length===1){
      if(binding)return new Response(JSON.stringify({error:{code:'NOT_BOUND',message:'synthetic definite refusal'}}),{status:400,headers:{'content-type':'application/json'}});
      entered();await gate;if(lost)throw new Error('synthetic lost send response');
     }
     out={kind:'sent',wireId:`synthetic-${i}-${state.sends.length}`,sent:true,history_stored:true};
    }else if(op==='sendFile'){state.files.push(input);out={kind:'sent',wireId:'synthetic-file',sent:true,history_stored:true,filename:input.filename,mime:input.mime,bytes:Buffer.from(input.data_base64,'base64').length};}
    else if(op==='chooseIdentity'){entered();await gate;out={info:{cid:CID}};}
    else if(op==='listContacts')out={contacts:state.contacts,origins:{}};
    else if(op==='generateInvite')out={blob:Buffer.from('synthetic').toString('base64'),inviteId:'synthetic-invite',reusable:false};
    else if(op==='removeContact'){state.contacts=state.contacts.filter(c=>c.container_id!==input.contact);out={notified:true};}
    else throw new Error(`unexpected isolated operation ${op}`);
    return new Response(JSON.stringify(out),{status:200,headers:{'content-type':'application/json'}});
   }});
   const packet=new SdkRoomPacket(`ours-cowork:Control ${i}`,CID,client);packets.set(id,packet);await packet.refresh();
   await store.create({version:2,room_id:id,room_name:`Control ${i}`,identity_name:packet.name,identity_cid:CID,mission:{goal:'Synthetic',briefing:'Synthetic',briefing_version:1},role_briefings:{},state:'active',invites:[],created_at:AT,activated_at:AT,anonymous:false,quiet_membership:true,membership_epoch:2,seats:[A,B].map((identity,j)=>({identity,display_name:`Member ${j}`,role:'builder',invite_id:'synthetic-existing',accepted_at:AT,state:'active',participant_id:`01jz6y7n8p9q0r1s2t3v4w5xa${j+1}`}))});
   const common={version:1,room_id:id,at:AT,author:{identity:A,display_name:'Member 0',role:'builder'},recipient_identities:[B]};
   if(file&&i===0){const bytes=Buffer.from('file');await store.append(id,{...common,kind:'file',file_id:'01jz6y7n8p9q0r1s2t3v4w5xt1',filename:'synthetic.txt',mime:'text/plain',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),data_base64:bytes.toString('base64')});}
   else await store.append(id,{...common,kind:'message',message_id:`01jz6y7n8p9q0r1s2t3v4w5xt${i+1}`,category:'chat',text:'Synthetic parent'});
  }
  const registry={get:id=>packets.get(id),async destroy(id){destroys++;packets.delete(id);return[];}};
  const service=new RoomService(store,registry);
  return {dir,store,service,states,packets,started,release,track,rows,get destroys(){return destroys;},async cleanup(){release();await Promise.allSettled(work);rmSync(dir,{recursive:true,force:true});}};
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
  f.release();await f.track(f.service.drain());
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
  assert.equal(closed,false);assert.equal(f.destroys,0);assert.equal(f.rows(IDS[0]).some(r=>r.kind==='relay_result'),false);
  f.release();await f.track(f.service.drain());await turnsUntil(()=>closed);assert.equal(closed,true);
  assert.equal(f.destroys,1);assert.equal(f.rows(IDS[0]).find(r=>r.kind==='relay_result').status,'queued');
 }finally{await f.cleanup();}
});
