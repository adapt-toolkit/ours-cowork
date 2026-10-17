import React from 'react';
import {act,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {CoworkApp,type RpcClient} from '../web/src/App';
import type {ResourceDelivery} from '../web/src/state/poller';
const ID='01jz6y7n8p9q0r1s2t3v4w5x70', AT='2026-08-03T00:00:00.000Z';
const room={version:1,room_id:ID,room_name:'Files',identity_name:'cowork-files',identity_cid:'cid-room',mission:{goal:'Files',briefing:'Files'},state:'active',invites:[],seats:[],created_at:AT};
const file={version:1,room_id:ID,seq:1,record_id:`${ID}:1`,at:AT,kind:'file',file_id:ID,author:{identity:'alice',display_name:'Alice',role:'builder'},filename:'evidence.bin',mime:'application/octet-stream',size:1,sha256:'559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',recipient_identities:[],source_file_id:1};

afterEach(()=>{location.hash='';});
function setup(){
 let delivery!:ResourceDelivery;let rows:unknown[]=[file];
 const call=vi.fn(async(method:string,params:Record<string,unknown>):Promise<unknown>=>{
  if(method==='room.show')return room;
  if(method==='room.participants')return [];
  if(method==='room.history')return rows.filter(row=>(row as {seq:number}).seq>Number(params.after)).slice(0,1);
  throw Error(method);
 });
 const rpc={call,resources(d:ResourceDelivery){delivery=d;return {watchRoom(){},unwatchRoom(){},close(){}};}} as RpcClient;
 location.hash=`#/rooms/${ID}`;const mounted=render(<CoworkApp rpc={rpc}/>);
 act(()=>delivery.snapshot('rooms',undefined,[room]));
 return {delivery,call,mounted,setRows(value:unknown[]){rows=value;}};
}
it('cold metadata recovery publishes all pages once and later reads only the accepted tail',async()=>{
 const {delivery,call,setRows}=setup();
 await act(async()=>{await delivery.recover!(ID,new AbortController().signal);});
 expect(screen.getByRole('button',{name:'Download evidence.bin'})).toBeInTheDocument();
 expect(call.mock.calls.filter(([method])=>method==='room.history').map(([,params])=>params)).toEqual([
  {room_id:ID,after:0,limit:200,view:'operator-metadata'},
  {room_id:ID,after:1,limit:200,view:'operator-metadata'},
 ]);
 call.mockClear();setRows([file,{...file,seq:2,record_id:`${ID}:2`,file_id:ID.slice(0,-1)+'1',filename:'second.bin'}]);
 await act(async()=>{await delivery.recover!(ID,new AbortController().signal);});
 expect(screen.getByRole('button',{name:'Download second.bin'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Download evidence.bin'})).toBeInTheDocument();
 expect(call.mock.calls.filter(([method])=>method==='room.history').map(([,params])=>params.after)).toEqual([1,2]);
 expect(call.mock.calls.filter(([method])=>method==='room.show')).toHaveLength(1);
 expect(call.mock.calls.filter(([method])=>method==='room.participants')).toHaveLength(1);
 call.mockClear();await act(async()=>{await delivery.recover!(ID,new AbortController().signal);});
 expect(call.mock.calls.filter(([method])=>method==='room.history').map(([,params])=>params.after)).toEqual([2]);
});
for(const retirement of ['snapshot','delete','tombstone','abort','dispose'])it(`does not continue or publish recovery after ${retirement}`,async()=>{
 const {delivery,call,mounted}=setup();let release!:(value:unknown)=>void;
 let held=false;call.mockImplementation(async(method)=>{if(method==='room.history'&&!held){held=true;return new Promise(resolve=>{release=resolve;});}return method==='room.show'?room:[];});
 const controller=new AbortController();let work!:Promise<void>;
 await act(async()=>{work=delivery.recover!(ID,controller.signal);await Promise.resolve();});
 await act(async()=>{
  if(retirement==='snapshot')delivery.snapshot('room',ID,{room,participants:[],history:[]});
  if(retirement==='delete')delivery.snapshot('rooms',undefined,[]);
  if(retirement==='tombstone')delivery.snapshot('room',ID,null);
  if(retirement==='abort')controller.abort();
  if(retirement==='dispose')mounted.unmount();
  release([{...file,data_base64:'QQ=='}]);await work;
 });
 expect(call.mock.calls.filter(([method])=>method==='room.history')).toHaveLength(1);
 expect(screen.queryByRole('button',{name:'Download evidence.bin'})).not.toBeInTheDocument();
});
it('keeps cold pages private until EOF and retries a failed capture from the accepted cursor',async()=>{
 const {delivery,call}=setup();let fail=true;
 call.mockImplementation(async(method,params)=>{
  if(method==='room.show')return room;
  if(method==='room.participants')return [];
  if(params.after===0)return [file];
  expect(screen.queryByRole('button',{name:'Download evidence.bin'})).not.toBeInTheDocument();
  if(fail)throw Error('page unavailable');
  return [];
 });
 await act(async()=>{await expect(delivery.recover!(ID,new AbortController().signal)).rejects.toThrow('page unavailable');});
 expect(screen.queryByRole('button',{name:'Download evidence.bin'})).not.toBeInTheDocument();
 fail=false;call.mockClear();
 await act(async()=>{await delivery.recover!(ID,new AbortController().signal);});
 expect(call.mock.calls.filter(([method])=>method==='room.history').map(([,params])=>params.after)).toEqual([0,1]);
 expect(screen.getByRole('button',{name:'Download evidence.bin'})).toBeInTheDocument();
});
it('rejects a nonadvancing metadata page without committing or looping',async()=>{
 const {delivery,call}=setup();
 call.mockImplementation(async(method)=>method==='room.history'?[file]:method==='room.show'?room:[]);
 await act(async()=>{await expect(delivery.recover!(ID,new AbortController().signal)).rejects.toThrow('Invalid recovery history');});
 expect(call.mock.calls.filter(([method])=>method==='room.history')).toHaveLength(2);
 expect(screen.queryByRole('button',{name:'Download evidence.bin'})).not.toBeInTheDocument();
});
