import test from 'node:test';
import assert from 'node:assert/strict';

const roomId='01jz6y7n8p9q0r1s2t3v4w5x6y', at='2026-08-02T10:11:12.000Z';
const seats=['A','B','C'].map((c,i)=>({identity:c.repeat(64),state:'active',role:'reviewer',
  display_name:c,participant_id:`01jz6y7n8p9q0r1s2t3v4w5xa${i+1}`,alias:`reviewer #${i+1}`}));
const room={room_id:roomId,state:'active',anonymous:false,seats};
function row(seq,id,text) {
  return {version:1,kind:'message',room_id:roomId,seq,record_id:`${roomId}:${seq}`,at,
    message_id:id,category:'chat',text,author:{identity:seats[0].identity,display_name:'A',role:'reviewer'},
    recipient_identities:seats.map(s=>s.identity)};
}
const visible=row(1,'01jz6y7n8p9q0r1s2t3v4w5xt1','ordinary');
const root={...row(2,'01jz6y7n8p9q0r1s2t3v4w5xt2','Thread: secret'),
  recipient_identities:seats.slice(0,2).map(s=>s.identity), scope:{thread_id:'01jz6y7n8p9q0r1s2t3v4w5xt2'},
  thread_root:{schema_version:1,thread_id:'01jz6y7n8p9q0r1s2t3v4w5xt2',topic:'secret',
    creator_participant_id:seats[0].participant_id,members:seats.slice(0,2).map(({identity,participant_id})=>({identity,participant_id})),
    idempotency_key:'key',fingerprint:'0'.repeat(64)}};
const intent={version:1,room_id:roomId,kind:'relay_intent',seq:3,record_id:`${roomId}:3`,at,message_id:root.message_id,recipient_identity:seats[0].identity};
const result={...intent,kind:'relay_result',seq:4,record_id:`${roomId}:4`,intent_record_id:intent.record_id,status:'queued',wire_id:'root-copy'};
const child={...row(5,'01jz6y7n8p9q0r1s2t3v4w5xt3','secret reply'),recipient_identities:[seats[1].identity],scope:{thread_id:root.message_id,parent_key:`message:${root.message_id}`},source_msg_id:1,source_wire_id:'child-wire',source_reply_to:{wire_id:'root-copy'}};
const rejection={version:1,room_id:roomId,kind:'intake_rejection',seq:6,record_id:`${roomId}:6`,at,source_kind:'message',source_msg_id:2,source_wire_id:'rejected',sender_identity:seats[2].identity,sender_participant_id:seats[2].participant_id,fingerprint:'0'.repeat(64),error:'reply_target_unavailable',notification_attempt_claimed:true};
async function api() { const mod=await import('../src/thread-history.ts').catch(()=>({})); assert.equal(typeof mod.projectParticipantHistory,'function','participant projection must exist'); return mod; }

test('hidden insertion cannot change dense public cursors, record IDs, or restart projection',async()=>{
 const {projectParticipantHistory:p,ParticipantHistoryRecordSchema:s}=await api();
 const second=row(2,'01jz6y7n8p9q0r1s2t3v4w5xt4','second');
 const records=[visible,root,intent,result,child,rejection,{...second,seq:7,record_id:`${roomId}:7`}];
 for(const anonymous of [false,true]) {
  const r={...room,anonymous};
  const rows=records.map(x=>x.kind==='message'?{...x,author_alias:{participant_id:seats[0].participant_id,alias:'reviewer #1'}}:x);
  const baseline=[rows[0],{...rows.at(-1),seq:2,record_id:`${roomId}:2`}];
  for(const page of [{},{after:0,limit:1},{after:1,limit:1},{after:2,limit:1}]) {
   const before=p(r,baseline,seats[2].identity,page);
   assert.equal(JSON.stringify(p(r,rows,seats[2].identity,page)),JSON.stringify(before));
   assert.equal(JSON.stringify(p(r,JSON.parse(JSON.stringify(rows)),seats[2].identity,page)),JSON.stringify(before));
  }
  const out=p(r,rows,seats[0].identity,{});
  assert.deepEqual(out.map(x=>x.text),['ordinary','Thread: secret','secret reply','second']);
  assert.equal(out[0].record_id,`${roomId}:participant:${seats[0].participant_id}:1`);
  out.forEach(x=>assert.equal(s.safeParse(x).success,true));
  assert.equal(s.safeParse({...out[0],source_wire_id:'secret'}).success,false);
  assert.equal(s.safeParse({...out[0],record_id:`${roomId}:1`}).success,false);
  const serialized=JSON.stringify(out);
  for(const leak of ['recipient_identities','source_wire_id','source_msg_id','parent_key','idempotency_key','fingerprint','author_alias']) assert.equal(serialized.includes(leak),false,leak);
  if(anonymous) for(const seat of seats) assert.equal(serialized.includes(seat.identity),false);
 }
 const replacement={...room,seats:seats.map((s,i)=>i===0?{...s,participant_id:'01jz6y7n8p9q0r1s2t3v4w5xff'}:s)};
 assert.deepEqual(p(replacement,records,seats[0].identity,{}).map(x=>x.text),['ordinary','second']);
 assert.throws(()=>p({...room,seats:[]},records,seats[0].identity,{}),/unauthorized/);
});

test('anonymous scoped roots and descendants fail closed on corrupt author aliases',async()=>{
 const {projectParticipantHistory:p}=await api();
 const validRoot={...root,author_alias:{participant_id:seats[0].participant_id,alias:'reviewer #1'}};
 for(const author_alias of [undefined,{participant_id:'bad',alias:'bad'},{participant_id:seats[1].participant_id,alias:'wrong'}]) {
  assert.deepEqual(p({...room,anonymous:true},[{...root,author_alias}],seats[0].identity,{}),[]);
  assert.deepEqual(p({...room,anonymous:true},[validRoot,intent,result,{...child,author_alias}],seats[0].identity,{}).map(x=>x.text),['Thread: secret']);
 }
});

test('missing scope and mismatched scoped parents never turn private descendants into broadcasts',async()=>{
 const {projectParticipantHistory:p}=await api();
 const {scope,...missing}=child;
 assert.deepEqual(p(room,[root,intent,result,missing],seats[2].identity,{}),[]);
 const otherId='01jz6y7n8p9q0r1s2t3v4w5xt5';
 const other={...root,message_id:otherId,seq:1,record_id:`${roomId}:1`,scope:{thread_id:otherId},thread_root:{...root.thread_root,thread_id:otherId,members:seats.map(({identity,participant_id})=>({identity,participant_id}))}};
 assert.deepEqual(p(room,[other,root,intent,result,{...child,scope:{...scope,thread_id:otherId}}],seats[2].identity,{}).map(x=>x.message_id),[otherId]);
 assert.deepEqual(p(room,[child],seats[0].identity,{}),[]);
 assert.deepEqual(p(room,[{...visible,source_reply_to:{wire_id:'unknown-legacy'}}],seats[2].identity,{}).map(x=>x.text),['ordinary']);
});

test('participant pages enforce visible limits and serialized byte bounds',async()=>{
 const {projectParticipantHistory:p}=await api();
 const records=Array.from({length:205},(_,i)=>row(i+1,`01jz6y7n8p9q0r1s2t3v4w6${String(i).padStart(3,'0')}`,'Public'));
 assert.equal(p(room,records,seats[2].identity,{}).length,200);
 assert.deepEqual(p(room,records,seats[2].identity,{after:200}).map(x=>x.seq),[201,202,203,204,205]);
 const large=records.slice(0,15).map(x=>({...x,text:'x'.repeat(262144)}));
 const first=p(room,large,seats[2].identity,{limit:15});
 assert(first.length>0 && first.length<15);
 assert(Buffer.byteLength(JSON.stringify(first))<=3*1024*1024);
 const second=p(room,large,seats[2].identity,{after:first.at(-1).seq,limit:15});
 assert.equal(first.length+second.length,15);
});

test('recursive native ancestry hides accepted scope-erased chains while preserving ordinary pages', async () => {
 const {projectParticipantHistory:p}=await api();
 const {scope: _scope,...missing}=child;
 const descendants=Array.from({length:3},(_,i)=>({...row(6+i,`01jz6y7n8p9q0r1s2t3v4w5xt${i+5}`,'PRIVATE deeper reply'),
   source_wire_id:`deep-source-${i}`,source_reply_to:{wire_id:i===0?'child-wire':`deep-source-${i-1}`}}));
 const last={...visible,seq:10,record_id:`${roomId}:10`,message_id:'01jz6y7n8p9q0r1s2t3v4w5xt8',text:'last ordinary'};
 const rows=JSON.parse(JSON.stringify([visible,root,intent,result,missing,...descendants,last]));
 for(const page of [{},{after:0,limit:1},{after:1,limit:1},{after:2,limit:1}]) {
   assert.deepEqual(p(room,rows,seats[2].identity,page),p(room,[visible,last],seats[2].identity,page));
 }
});
