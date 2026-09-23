import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CoworkStore} from '../src/storage.ts';
import {RoomService} from '../src/service.ts';
import {createServiceRoutes} from '../src/command-routes.ts';
import {RpcDispatcher} from '../src/transports.ts';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'cowork-rest-')),store=new CoworkStore(root),sent=[];
 const packet={name:'room',cid:'A'.repeat(64),listContacts:()=>[],listInvites:()=>[],supportsInviteProvenance:true,registerRuntimeCommands:async()=>{},listUnreadMessages:async()=>[],listUnreadFiles:async()=>[],send:async()=>({status:'queued',wire_id:'metadata-wire'}),sendFile:async(cid,name,mime,bytes)=>{sent.push({cid,name,mime,bytes});return {status:'queued',wire_id:'file-wire'};}};
 const packets={preflightCreate:async()=>{},create:async()=>packet,get:()=>packet};
 const service=new RoomService(store,packets);
 const room=await service.createRoom({name:'rest-test',goal:'test',briefing:'test',activate_empty:true});
 await service.addRestRole(room.room_id,{role:'Web'});
 return {root,store,service,room,sent,async close(){service.beginShutdown();await service.drain();await rm(root,{recursive:true,force:true});}};
}
const input=()=>({upload_id:randomUUID(),role:'Web',filename:'hello.txt',mime:'text/plain',data_base64:Buffer.from('hello').toString('base64')});

test('empty room REST upload archives once, wakes events, resumes durable cursor and keeps bytes',async()=>{
 const f=await fixture();try{
  assert.equal(f.room.state,'active');assert.equal(f.room.seats.length,0);
  const waiting=f.service.events(f.room.room_id,{after:0,wait_ms:20000});
  const upload=input(),receipt=await f.service.sendFile(f.room.room_id,upload),events=await waiting;
  assert.equal(receipt.state,'archived');assert.equal(events.records[0].kind,'file');assert.equal(events.records[0].data_base64,upload.data_base64);
  assert.equal(events.records[0].source_wire_id,undefined);assert.equal(events.records[0].source_file_id,undefined);
  assert.equal(events.records[0].author.identity,f.room.identity_cid);
  assert.equal((await f.service.sendFile(f.room.room_id,upload)).file_id,receipt.file_id);
  await assert.rejects(f.service.sendFile(f.room.room_id,{...upload,data_base64:'Y2hhbmdlZA=='}),/idempotency conflict/);
  const reopened=new RoomService(new CoworkStore(f.root),{get:()=>undefined});
  const replay=await reopened.events(f.room.room_id,{after:0,wait_ms:0});assert.equal(replay.records[0].file_id,receipt.file_id);
  const next=await reopened.events(f.room.room_id,{after:events.next_after,wait_ms:0});assert.equal(next.records.length,0);
 }finally{await f.close();}
});

test('upload fans out through room identity to active seats with no bridge',async()=>{
 const f=await fixture();try{
  const room=await f.store.load(f.room.room_id);
  room.seats=[{participant_id:'01jz6y7n8p9q0r1s2t3v4w5x6z',identity:'B'.repeat(64),display_name:'Agent',role:'Participant',invite_id:'test-invite',state:'active',accepted_at:new Date().toISOString()}];
  await f.store.save(room);
  const receipt=await f.service.sendFile(room.room_id,input());await f.service.drain();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].bytes.toString(),'hello');assert.equal(f.sent[0].cid,'B'.repeat(64));
  const records=await f.store.read(room.room_id);assert(records.some(r=>r.kind==='relay_result'&&r.file_id===receipt.file_id&&r.status==='queued'));
 }finally{await f.close();}
});

test('REST route rejects malformed bytes, forged metadata, absent roles and excessive event waits',async()=>{
 const f=await fixture();try{
  const dispatch=new RpcDispatcher(createServiceRoutes(f.service));
  for(const change of [{data_base64:'!!!'},{filename:'../x'},{role:'Unregistered'},{author:{identity:'B'.repeat(64)}}]){
   const result=await dispatch.dispatch({version:1,id:'test',method:'room.file.send',params:{room_id:f.room.room_id,...input(),...change}});assert(result.error);
  }
  await assert.rejects(f.service.events(f.room.room_id,{after:0,wait_ms:20001}));
  assert.equal((await f.store.read(f.room.room_id)).length,0);
 }finally{await f.close();}
});

test('failed archive commit cannot wake event readers with a non-durable upload',async()=>{
 const f=await fixture();try{
  const failing=new CoworkStore(f.root,{beforeRecordCommit:()=>{throw Error('commit failed');}});
  let wakeCount=0;const unsubscribe=failing.subscribeArchive(f.room.room_id,()=>wakeCount++);
  const service=new RoomService(failing,{get:()=>undefined});
  await assert.rejects(service.sendFile(f.room.room_id,input()),/failed to append/);
  assert.equal(wakeCount,0);assert.equal((await f.store.read(f.room.room_id)).length,0);unsubscribe();
 }finally{await f.close();}
});
