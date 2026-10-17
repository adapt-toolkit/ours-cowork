import test from 'node:test';
import assert from 'node:assert/strict';
import { OursClient } from '@ours.network/sdk/client';
import { SharedOursHost } from '../src/ours-runtime.ts';

const deferred = () => { let resolve; const promise = new Promise(done => {resolve=done;}); return {promise,resolve}; };
function fixture() {
 const health=[], logs=[];let send, streams=0, canonical=0, active=0, maximum=0;
 const held=deferred(), entered=deferred(), reconciled=deferred();
 const client=new OursClient({url:'http://sdk.test',fetch:async(_url,{signal})=>{
  streams++;
  return new Response(new ReadableStream({start(controller){
   signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});
   send=kind=>{if(signal.aborted)return;controller.enqueue(new TextEncoder().encode(`event: resource\ndata: ${JSON.stringify({kind,protocolVersion:1,producerGeneration:'source',position:kind==='ready'?0:1})}\n\n`));};
   send('ready');
  }}),{headers:{'content-type':'text/event-stream'}});
 }});
 const host=new SharedOursHost((...args)=>logs.push(args.map(String).join(' ')),async()=>({
  resourceEvents:client.resourceEvents.bind(client),
  async readNotificationPage(_id,{since,signal}){
   if(since==='tip')return {cursor:100,events:[]};
   if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
   throw Error('aborted');
  },async releaseLease(){return {failed:0};},async close(){},
 }));
 host.onResourceHealth((_identity,value)=>health.push(value));
 host.onIdentityNotify(async()=>{
  active++;maximum=Math.max(maximum,active);
  try {if(++canonical===2){entered.resolve();await held.promise;}if(canonical===3)reconciled.resolve();}
  finally {active--;}
 });
 return {host,health,logs,held,entered,reconciled,send:kind=>send(kind),get streams(){return streams;},get canonical(){return canonical;},get maximum(){return maximum;}};
}
async function start(f){await f.host.boot();f.host.trackIdentity('room');while(!f.health.includes(true))await new Promise(resolve=>setImmediate(resolve));}

test('canonical work longer than six seconds does not stop coverage draining and commits coalesce', {timeout:10000}, async t=>{
 const f=fixture();t.after(async()=>{f.held.resolve();await f.host.shutdown();});await start(f);
 f.send('committed');await f.entered.promise;
 for(let i=0;i<100;i++)f.send('committed');
 const timer=setInterval(()=>f.send('coverage'),500);t.after(()=>clearInterval(timer));
 await new Promise(resolve=>setTimeout(resolve,6200));f.held.resolve();
 await Promise.race([f.reconciled.promise,new Promise(resolve=>setTimeout(resolve,100))]);
 assert.equal(f.streams,1);assert.deepEqual(f.logs,[]);assert.equal(f.health.slice(1).includes(false),false);
 assert.equal(f.canonical,3,'a burst retains one pending canonical pass');assert.equal(f.maximum,1);
});

test('canonical completion after stream failure cannot restore attempt health', {timeout:3000}, async t=>{
 const f=fixture();t.after(async()=>{f.held.resolve();await f.host.shutdown();});await start(f);
 f.send('committed');await f.entered.promise;f.send('resync');
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(f.health.at(-1),false,'source loss is observed while canonical work remains pending');
 const before=f.health.length;f.held.resolve();await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(f.health.slice(before).includes(true),false);
});
