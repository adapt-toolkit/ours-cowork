import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CoworkApp, type RpcClient } from '../web/src/App';
import type { ResourceDelivery } from '../web/src/state/poller';

const ID='01jz6y7n8p9q0r1s2t3v4w5x70', AT='2026-08-03T00:00:00.000Z';
const room={version:1,room_id:ID,room_name:'Files',identity_name:'cowork-files',identity_cid:'cid-room',mission:{goal:'Files',briefing:'Files'},state:'active',invites:[],seats:[],created_at:AT};
const file={version:1,room_id:ID,seq:1,record_id:`${ID}:1`,at:AT,kind:'file',file_id:ID,author:{identity:'alice',display_name:'Alice',role:'builder'},filename:'evidence.bin',mime:'application/octet-stream',size:1,sha256:'559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',recipient_identities:[],source_file_id:1};
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
afterEach(()=>{
 vi.restoreAllMocks();vi.unstubAllGlobals();location.hash='';
 if(originalCreate)Object.defineProperty(URL,'createObjectURL',originalCreate);else Reflect.deleteProperty(URL,'createObjectURL');
 if(originalRevoke)Object.defineProperty(URL,'revokeObjectURL',originalRevoke);else Reflect.deleteProperty(URL,'revokeObjectURL');
});

for(const invalid of ['none','record','hash','bytes']) it(`loads file content only on explicit download and validates ${invalid}`,async()=>{
 location.hash=`#/rooms/${ID}`;
 let delivery!:ResourceDelivery;
 const result={...file,data_base64:'QQ==',...(invalid==='record'?{seq:2,record_id:`${ID}:2`}:{}),...(invalid==='hash'?{sha256:'0'.repeat(64)}:{}),...(invalid==='bytes'?{data_base64:'Qg=='}:{})};
 const call=vi.fn(async()=>[result]);
 const create=vi.fn(()=> 'blob:verified');
 Object.defineProperty(URL,'createObjectURL',{value:create,configurable:true});Object.defineProperty(URL,'revokeObjectURL',{value:vi.fn(),configurable:true});
 vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
 const rpc={call,resources(value:ResourceDelivery){delivery=value;return {watchRoom(){},unwatchRoom(){},close(){}};}} as RpcClient;
 render(<CoworkApp rpc={rpc}/>);
 await act(async()=>{delivery.snapshot('rooms',undefined,[room]);delivery.snapshot('room',ID,{room,participants:[],history:[file]});delivery.health(true);});
 const download=await screen.findByRole('button',{name:'Download evidence.bin'});
 expect(call).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
 fireEvent.click(download);
 await waitFor(()=>expect(call).toHaveBeenCalledTimes(1));
 expect(call.mock.calls[0]).toEqual(['room.history',{room_id:ID,after:0,limit:1},{signal:expect.any(AbortSignal)}]);
 if(invalid==='none')await waitFor(()=>expect(create).toHaveBeenCalledTimes(1));
 else {await screen.findByText('File integrity check failed; download blocked.');expect(create).not.toHaveBeenCalled();}
});

it('abandons an explicit download when its workspace is disposed even if RPC ignores abort', async () => {
 location.hash=`#/rooms/${ID}`;
 let delivery!:ResourceDelivery;
 let resolve!: (value: unknown) => void;
 const call=vi.fn((_method: string, _params: unknown, _options: {signal: AbortSignal})=>new Promise<unknown>(done=>{resolve=done;}));
 const create=vi.fn(()=> 'blob:unexpected');
 Object.defineProperty(URL,'createObjectURL',{value:create,configurable:true});
 const rpc={call,resources(value:ResourceDelivery){delivery=value;return {watchRoom(){},unwatchRoom(){},close(){}};}} as RpcClient;
 const mounted=render(<CoworkApp rpc={rpc}/>);
 await act(async()=>{delivery.snapshot('rooms',undefined,[room]);delivery.snapshot('room',ID,{room,participants:[],history:[file]});delivery.health(true);});
 fireEvent.click(await screen.findByRole('button',{name:'Download evidence.bin'}));
 await waitFor(()=>expect(call).toHaveBeenCalledTimes(1));
 const signal=call.mock.calls[0]![2].signal;
 mounted.unmount();
 expect(signal.aborted).toBe(true);
 await act(async()=>{resolve([{...file,data_base64:'QQ=='}]);});
 expect(create).not.toHaveBeenCalled();
});
