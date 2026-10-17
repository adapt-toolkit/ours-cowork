import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createResourceSession, type ResourceSession } from '../web/src/state/poller';
let session:ResourceSession|undefined;
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
function visibility(hidden:boolean){Object.defineProperty(document,'hidden',{configurable:true,value:hidden});Object.defineProperty(document,'visibilityState',{configurable:true,value:hidden?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'));}
beforeEach(()=>{
 Object.defineProperty(AbortSignal,'any',{configurable:true,value:(signals:AbortSignal[])=>{const c=new AbortController();for(const s of signals){if(s.aborted)c.abort(s.reason);else s.addEventListener('abort',()=>c.abort(s.reason),{once:true});}return c.signal;}});
 vi.useFakeTimers();vi.setSystemTime(1000);visibility(false);});
afterEach(()=>{session?.close();session=undefined;vi.useRealTimers();visibility(false);});
function fixture(){
 const inputs:ReadableStreamDefaultController<Uint8Array>[]=[],signals:AbortSignal[]=[],calls:string[]=[];
 const health=vi.fn(),snapshot=vi.fn(),recover=vi.fn(async(_id:string|undefined,_signal:AbortSignal)=>{});
 const fetcher=async(path:RequestInfo|URL,init?:RequestInit)=>{calls.push((init?.method??'GET')+' '+path);if(init?.method)return new Response('{}');signals.push(init!.signal!);return new Response(new ReadableStream<Uint8Array>({start(c){inputs.push(c);}}),{headers:{'content-type':'text/event-stream'}});};
 session=createResourceSession({health,snapshot,recover},undefined,fetcher as typeof fetch);
 const raw=(s:string)=>inputs.at(-1)!.enqueue(new TextEncoder().encode(s));
 const emit=(event:string,data:unknown)=>raw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
 const connect=async()=>{await flush();emit('resource-connection',{protocolVersion:1,connectionId:'c',producerGeneration:'g'});await flush();};
 const frame=(kind:string,sequence:number,payload:unknown,viewId='rooms',subscriptionEpoch=1)=>emit('resource',{protocolVersion:1,producerGeneration:'g',viewId,subscriptionEpoch,baselineId:'b',revision:1,sequence,kind,payload});
 const ready=async()=>{frame('snapshot',1,[]);frame('ready',2,{baselineId:'b'});await flush();};
 return {signals,calls,health,snapshot,recover,raw,connect,frame,ready};
}
it('rejects late ready when opening timers were suspended',async()=>{const f=fixture();await f.connect();vi.setSystemTime(11001);await f.ready();expect(f.snapshot).not.toHaveBeenCalled();expect(f.signals[0].aborted).toBe(true);});
it('history progress cannot extend fixed opening deadline',async()=>{const f=fixture();await f.connect();session!.watchRoom('x');f.frame('snapshot',1,{history:[],historyComplete:false},'room_x');await flush();vi.setSystemTime(9000);f.frame('upsert',2,{type:'history-page',records:[{}],complete:false},'room_x');await flush();vi.setSystemTime(11001);f.frame('upsert',3,{type:'history-page',records:[],complete:true},'room_x');f.frame('ready',4,{baselineId:'b'},'room_x');await flush();expect(f.snapshot).not.toHaveBeenCalled();expect(f.signals[0].aborted).toBe(true);});
it('comments do not renew established producer coverage',async()=>{const f=fixture();await f.connect();await f.ready();vi.setSystemTime(6000);f.raw(': live\n\n');await flush();vi.setSystemTime(7001);f.raw(': late\n\n');await flush();expect(f.signals[0].aborted).toBe(true);});
it('pageshow retires elapsed established deadlines',async()=>{const f=fixture();await f.connect();await f.ready();vi.setSystemTime(12000);window.dispatchEvent(new Event('pageshow'));await flush();expect(f.signals[0].aborted).toBe(true);});
it('starts only visible and returns with fresh fenced attempt',async()=>{visibility(true);const f=fixture();await flush();expect(f.calls).toEqual([]);visibility(false);await f.connect();visibility(true);await flush();expect(f.signals[0].aborted).toBe(true);visibility(false);await flush();expect(f.signals).toHaveLength(2);expect(f.snapshot).not.toHaveBeenCalled();});
it('uses scoped recovery cadence and settled probes, canceled at complete ready',async()=>{
 const recover=vi.fn(async(_id:string|undefined,_signal:AbortSignal)=>{});let attempts=0,input:ReadableStreamDefaultController<Uint8Array>|undefined;
 session=createResourceSession({snapshot(){},health(){},recover},undefined,async(_path,init)=>{if(init?.method)return new Response('{}');attempts++;if(attempts<5)return new Response('',{status:503});return new Response(new ReadableStream<Uint8Array>({start(c){input=c;}}),{headers:{'content-type':'text/event-stream'}});});
 session.watchRoom('x');await flush();expect(recover.mock.calls.length).toBe(2);
 await vi.advanceTimersByTimeAsync(3000);expect(attempts).toBe(4);
 await vi.advanceTimersByTimeAsync(9999);expect(attempts).toBe(4);
 await vi.advanceTimersByTimeAsync(1);expect(attempts).toBe(5);
 const emit=(event:string,data:unknown)=>input!.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
 emit('resource-connection',{protocolVersion:1,connectionId:'c',producerGeneration:'g'});await flush();
 for(const viewId of ['rooms','room_x'])for(const [kind,sequence,payload]of [['snapshot',1,viewId==='rooms'?[{room_id:'x'}]:{}],['ready',2,{baselineId:'b'}]]as const)emit('resource',{protocolVersion:1,producerGeneration:'g',viewId,subscriptionEpoch:1,baselineId:'b',revision:1,sequence,kind,payload});
 await flush();const count=recover.mock.calls.length;await vi.advanceTimersByTimeAsync(5000);expect(recover).toHaveBeenCalledTimes(count);
});
it('settled failures probe after 10 then 20 then capped 30 seconds',async()=>{
 let attempts=0;session=createResourceSession({snapshot(){},health(){},async recover(){}},undefined,async()=>{attempts++;return new Response('',{status:503});});await flush();await vi.advanceTimersByTimeAsync(3000);expect(attempts).toBe(4);for(const [delay,count]of [[10000,5],[20000,6],[30000,7],[30000,8]]){await vi.advanceTimersByTimeAsync(delay-1);expect(attempts).toBe(count-1);await vi.advanceTimersByTimeAsync(1);expect(attempts).toBe(count);}
});
it('terminal authentication stops reads and probes',async()=>{
 const recover=vi.fn();let attempts=0;session=createResourceSession({snapshot(){},health(){},recover},undefined,async()=>{attempts++;return new Response('',{status:401});});await flush();await vi.advanceTimersByTimeAsync(100000);expect(attempts).toBe(1);expect(recover).not.toHaveBeenCalled();
});
it('hide releases an abort-ignoring opening request and return starts fresh',async()=>{
 let attempts=0;session=createResourceSession({snapshot(){},health(){}},undefined,async()=>{attempts++;return new Promise<Response>(()=>{});});await flush();visibility(true);await flush();visibility(false);await flush();expect(attempts).toBe(2);
});
it('appends complete live history units atomically while preserving loaded older rows',async()=>{
 const f=fixture();await f.connect();session!.watchRoom('a');f.frame('snapshot',1,[{room_id:'a'}]);f.frame('ready',2,{baselineId:'b'});
 const old={seq:1,record_id:'a:1',text:'older'};f.frame('snapshot',1,{room:{room_id:'a',room_name:'before'},participants:[],history:[old]},'room_a');f.frame('ready',2,{baselineId:'b'},'room_a');await flush();
 const baseline=f.snapshot.mock.calls.at(-1)![2];const count=f.snapshot.mock.calls.length;
 f.frame('upsert',3,{type:'room-update',room:{room_id:'a',room_name:'after'},participants:[],historyAfter:1},'room_a');
 f.frame('upsert',4,{type:'history-page',records:[{seq:2,record_id:'a:2',text:'new'}],complete:false},'room_a');await flush();
 expect(f.snapshot).toHaveBeenCalledTimes(count);expect(baseline.history).toEqual([old]);
 f.frame('upsert',5,{type:'history-page',records:[],complete:true},'room_a');await flush();
 expect(f.snapshot.mock.calls.at(-1)![2]).toMatchObject({room:{room_name:'after'},history:[old,{seq:2,text:'new'}]});expect(f.recover).not.toHaveBeenCalled();
});
it('projection failure recovers only its view while a sibling continues',async()=>{
 const f=fixture();await f.connect();session!.watchRoom('a');session!.watchRoom('b');f.frame('snapshot',1,[{room_id:'a'},{room_id:'b'}]);f.frame('ready',2,{baselineId:'b'});
 for(const id of ['a','b']){f.frame('snapshot',1,{history:[]},'room_'+id);f.frame('ready',2,{baselineId:'b'},'room_'+id);}await flush();
 f.frame('resync',3,{reason:'projection_unavailable'},'room_a');f.frame('snapshot',3,{history:[],room:{room_name:'sibling-new'}},'room_b');await flush();
 expect(f.signals[0].aborted).toBe(false);expect(f.recover.mock.calls.map(call=>call[0])).toEqual(['a']);expect(f.snapshot.mock.calls.at(-1)![2]).toMatchObject({room:{room_name:'sibling-new'}});
});

it('failed room replacement stays scoped, ignores old epoch and stops recovery at ready',async()=>{
 const f=fixture();await f.connect();session!.watchRoom('a');session!.watchRoom('b');f.frame('snapshot',1,[{room_id:'a'},{room_id:'b'}]);f.frame('ready',2,{baselineId:'b'});
 for(const id of ['a','b']){f.frame('snapshot',1,{history:[]},'room_'+id);f.frame('ready',2,{baselineId:'b'},'room_'+id);}await flush();
 f.frame('resync',3,{reason:'projection_unavailable'},'room_a');await flush();await vi.advanceTimersByTimeAsync(1000);
 expect(f.calls.filter(c=>c.startsWith('POST')&&c.endsWith('/room_a'))).toHaveLength(2);expect(f.calls.filter(c=>c.startsWith('POST')&&c.endsWith('/room_b'))).toHaveLength(1);
 f.frame('snapshot',4,{history:[],room:{room_name:'stale'}},'room_a');f.frame('snapshot',1,{history:[],room:{room_name:'replacement'}},'room_a',2);f.frame('ready',2,{baselineId:'b'},'room_a',2);await flush();
 expect(f.snapshot.mock.calls.some(c=>c[2]?.room?.room_name==='stale')).toBe(false);const recovered=f.recover.mock.calls.length;await vi.advanceTimersByTimeAsync(2500);expect(f.recover).toHaveBeenCalledTimes(recovered);expect(f.signals[0].aborted).toBe(false);
});
it('room-list projection failure keeps room bindings live and retries only the list',async()=>{
 const f=fixture();await f.connect();session!.watchRoom('a');
 f.frame('snapshot',1,[{room_id:'a'}]);f.frame('ready',2,{baselineId:'b'});
 f.frame('snapshot',1,{history:[]},'room_a');f.frame('ready',2,{baselineId:'b'},'room_a');await flush();
 f.health.mockClear();f.recover.mockRejectedValueOnce(Error('list unavailable'));
 f.frame('resync',3,{reason:'projection_unavailable'});f.frame('snapshot',3,{history:[],room:{room_name:'still-live'}},'room_a');await flush();
 expect(f.signals[0].aborted).toBe(false);expect(f.recover.mock.calls.map(call=>call[0])).toEqual([undefined]);
 expect(f.health).not.toHaveBeenCalledWith(false,expect.anything());
 expect(f.snapshot.mock.calls.at(-1)![2]).toMatchObject({room:{room_name:'still-live'}});
 await vi.advanceTimersByTimeAsync(1000);
 expect(f.calls.filter(c=>c.startsWith('POST')&&c.endsWith('/rooms'))).toHaveLength(2);
 expect(f.calls.filter(c=>c.startsWith('POST')&&c.endsWith('/room_a'))).toHaveLength(1);
 f.frame('snapshot',1,[{room_id:'a'}],'rooms',2);f.frame('ready',2,{baselineId:'b'},'rooms',2);await flush();
 const count=f.recover.mock.calls.length;await vi.advanceTimersByTimeAsync(4000);expect(f.recover).toHaveBeenCalledTimes(count);expect(f.signals[0].aborted).toBe(false);
});
