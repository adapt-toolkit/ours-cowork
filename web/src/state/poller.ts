export interface Poller {
  start(): void;
  refresh(): Promise<void>;
  stop(): void;
}

export interface PollClock {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export function createPoller(options: {
  intervalMs?: number;
  visible: () => boolean;
  run: (signal: AbortSignal) => Promise<void>;
  clock?: PollClock;
}): Poller {
  if (options.intervalMs !== undefined && (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0)) {
    throw new TypeError('poll interval must be positive');
  }

  interface ActiveRun {
    generation: number;
    controller: AbortController;
    dirty: boolean;
    promise: Promise<void>;
  }

  let started = false;
  let generation = 0;
  const clock: PollClock = options.clock ?? {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: ActiveRun | undefined;

  function request(expectedGeneration: number): Promise<void> {
    if (!started || generation !== expectedGeneration || !options.visible()) return Promise.resolve();
    if (active?.generation === expectedGeneration) {
      active.dirty = true;
      return active.promise;
    }

    const current: ActiveRun = {
      generation: expectedGeneration,
      controller: new AbortController(),
      dirty: false,
      promise: Promise.resolve(),
    };
    active = current;
    current.promise = execute(current);
    return current.promise;
  }

  async function execute(current: ActiveRun): Promise<void> {
    try {
      do {
        current.dirty = false;
        try {
          await options.run(current.controller.signal);
        } catch (error) {
          if (!started || generation !== current.generation || current.controller.signal.aborted) return;
          throw error;
        }
      } while (current.dirty
        && started
        && generation === current.generation
        && options.visible());
    } finally {
      if (active === current) active = undefined;
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      const currentGeneration = ++generation;
      if (options.intervalMs !== undefined) timer = clock.setInterval(() => {
        void request(currentGeneration).catch(() => undefined);
      }, options.intervalMs);
    },
    refresh() {
      return request(generation);
    },
    stop() {
      if (!started) return;
      started = false;
      generation += 1;
      if (timer !== undefined) clock.clearInterval(timer);
      timer = undefined;
      const stoppedRun = active;
      active = undefined;
      stoppedRun?.controller.abort();
    },
  };
}

export interface ResourceSession {
  watchRoom(roomId: string): void;
  unwatchRoom(roomId: string): void;
  close(): void;
}
export interface ResourceDelivery {
  snapshot(resource: 'rooms' | 'room', roomId: string | undefined, payload: unknown): void;
  health(healthy: boolean, error?: unknown): void;
  authenticationRequired?(): void;
  degraded?(roomId?: string): void;
  recover?(roomId: string | undefined, signal: AbortSignal): Promise<void>;
}
export class ResourceHttpError extends Error {
  constructor(readonly status: number) { super(`Resource delivery HTTP ${status}`); }
}
function terminalAuthentication(error: unknown): boolean {
  return error instanceof ResourceHttpError && (error.status === 401 || error.status === 403)
    || !!error && typeof error === 'object' && 'code' in error && ['unauthorized','forbidden'].includes(String(error.code));
}
/** Fetch keeps the existing in-memory operator credential and abort ownership. */
export function createResourceSession(delivery: ResourceDelivery, credential?: string, fetchRequest = globalThis.fetch): ResourceSession {
  const lifetime = new AbortController(), rooms = new Set<string>();
  let registerRoom: ((id: string) => void) | undefined;
  let removeRoom: ((id: string) => void) | undefined;
  const degraded = new Map<string, Poller>();
  const visible = () => document.visibilityState !== 'hidden' && !document.hidden;
  const stopRecovery = () => {for(const poller of degraded.values())poller.stop();degraded.clear();};
  let activeAttempt: AbortController | undefined;
  let checkResume: (() => void) | undefined;
  let failures = 0;
  const visibility = () => {
    if (!visible()) {activeAttempt?.abort();stopRecovery();}
    else checkResume?.();
  };
  document.addEventListener('visibilitychange',visibility);
  window.addEventListener('pageshow',visibility);
  lifetime.signal.addEventListener('abort',()=>{stopRecovery();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pageshow',visibility);},{once:true});
  const terminal = (error: unknown) => {
    if (!terminalAuthentication(error)) return false;
    delivery.health(false,error);lifetime.abort();for(const poller of degraded.values())poller.stop();degraded.clear();
    delivery.authenticationRequired?.();return true;
  };
  const recover = (roomId?: string) => {
    if (!visible() || lifetime.signal.aborted) return;
    const key=roomId??'';
    if (degraded.has(key)) return;
    delivery.degraded?.(roomId);
    const poller=createPoller({intervalMs:roomId ? 2000 : 5000,visible:()=>visible()&&!lifetime.signal.aborted,run:async signal=>{
      try {await delivery.recover?.(roomId,AbortSignal.any([signal,lifetime.signal]));}
      catch(error){if(!signal.aborted && !lifetime.signal.aborted && !terminal(error))delivery.degraded?.(roomId);}
    }});
    degraded.set(key,poller);poller.start();void poller.refresh();
  };
  const prefix = new URL('.', location.href).pathname + (credential === undefined ? 'resources' : 'browser/resources');
  const headers = { ...(credential === undefined ? {} : { 'x-ours-api-token': credential }) };
  const request = async (path: string, options: RequestInit, signal: AbortSignal) => {
    signal.throwIfAborted();
    let abort!: () => void;
    const aborted=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason??new DOMException('Resource owner retired','AbortError'));signal.addEventListener('abort',abort,{once:true});});
    const pending=fetchRequest(prefix + path, { ...options, headers: {...headers,...options.headers}, credentials: 'same-origin', redirect: 'error', signal });
    void pending.then(response=>{if(signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
    let response: Response;
    try {response=await Promise.race([pending,aborted]);signal.throwIfAborted();}
    finally {signal.removeEventListener('abort',abort);}
    if (!response.ok) throw new ResourceHttpError(response.status);
    return response;
  };
  void (async () => {
    while (!lifetime.signal.aborted) {
      if(!visible())await new Promise<void>(resolve=>{
        const done=()=>{if(!visible()&&!lifetime.signal.aborted)return;document.removeEventListener('visibilitychange',done);lifetime.signal.removeEventListener('abort',done);resolve();};
        document.addEventListener('visibilitychange',done);lifetime.signal.addEventListener('abort',done,{once:true});done();
      });
      if(lifetime.signal.aborted)break;
      // Retire the prior reader epoch before probing, without awaiting ignored aborts.
      stopRecovery();
      const attempt = new AbortController(), signal = AbortSignal.any([lifetime.signal,attempt.signal]);
      activeAttempt=attempt;
      const openingDeadline=Date.now()+10_000;
      let established=false,byteDeadline=Number.POSITIVE_INFINITY;
      const views = new Map<string, { resource: 'rooms' | 'room'; roomId?: string; epoch: number; sequence: number; revision: number; completedRevision?: number; baselineId?: string; pending?: unknown; ready: boolean; source?: {protocolVersion:1;producerGeneration:string;position:number;health:'healthy'}; failures: number; failed?: boolean; retry?: ReturnType<typeof setTimeout>; expires: number; registration?: Promise<unknown> }>();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancelRead = () => { void reader?.cancel().catch(()=>{}); };
      signal.addEventListener('abort',cancelRead,{once:true});
      const deadline = () => Math.min(established ? byteDeadline : openingDeadline,...[...views.values()].map(view=>view.expires));
      const check = () => {
        signal.throwIfAborted();
        if(!visible() || Date.now()>=deadline()) {attempt.abort(Error('Resource coverage expired'));signal.throwIfAborted();}
      };
      const arm = () => {clearTimeout(timer);timer=setTimeout(()=>attempt.abort(Error('Resource coverage expired')),Math.max(0,deadline()-Date.now()));};
      checkResume=()=>{try{check();}catch{/* Abort wakes the attempt owner. */}};
      try {
        arm();
        const response = await request('',{headers:{accept:'text/event-stream'}},signal);
        check();
        if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw Error('Invalid resource transport');
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8',{fatal:true});
        let buffer = '', generation = '', connection = '';
        let assembly: { id: string; totalBytes: number; parts: number; chunks: Uint8Array[]; bytes: number; binding: Record<string,unknown> } | undefined;
        const epochs = new Map<string,number>();
        const register = (resource: 'rooms' | 'room',roomId?: string, failures = 0) => {
          const viewId = roomId ? `room_${roomId}` : 'rooms';
          if (views.has(viewId)) return;
          if (roomId && views.size >= 64) {recover(roomId);return;}
          check();
          const epoch=(epochs.get(viewId)??0)+1;epochs.set(viewId,epoch);
          views.set(viewId,{resource,roomId,epoch,sequence:0,revision:0,ready:false,failures,expires:established?Date.now()+10_000:openingDeadline});arm();
          const registration = request(`/${connection}/views/${viewId}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subscriptionEpoch:epoch,descriptor:{viewId,resource,...(roomId?{roomId}:{})}})},signal).catch(error=>{
            if(signal.aborted || !visible())return;
            if(terminal(error))return;
            if(roomId && !rooms.has(roomId))return;
            if(roomId && error instanceof ResourceHttpError && error.status===409){views.delete(viewId);recover(roomId);arm();return;}
            attempt.abort(error);
          });
          views.get(viewId)!.registration=registration;
        };
        removeRoom = id => {
          const viewId=`room_${id}`, view=views.get(viewId);clearTimeout(view?.retry);views.delete(viewId);arm();
          if(view)void Promise.resolve(view.registration).then(()=>request(`/${connection}/views/${viewId}?epoch=${view.epoch}`,{method:'DELETE'},signal)).then(()=>{
            const next=[...degraded.keys()].find(room=>rooms.has(room));if(next)register('room',next);
          }).catch(error=>{if(!terminal(error))attempt.abort(error);});
        };
        const source = (view: {source?: {producerGeneration:string;position:number};expires:number}, evidence: any, commit = true) => {
          if(evidence?.protocolVersion!==1 || typeof evidence.producerGeneration!=='string' || !evidence.producerGeneration
            || !Number.isSafeInteger(evidence.position) || evidence.position<0 || evidence.health!=='healthy'
            || (view.source && (view.source.producerGeneration!==evidence.producerGeneration || view.source.position>evidence.position))) throw Error('Invalid resource source');
          if(commit){view.source=evidence;view.expires=Date.now()+45_000;}
        };
        const apply = (value: Record<string,unknown>) => {
          check();
          const view = views.get(String(value.viewId));
          if (!view) return; // Late frames from a released binding have no owner.
          if (Number(value.subscriptionEpoch)<view.epoch) return;
          if (value.protocolVersion!==1 || value.producerGeneration!==generation || value.subscriptionEpoch!==view.epoch
            || value.sequence!==view.sequence+1 || !Number.isSafeInteger(value.revision) || Number(value.revision)<view.revision
            || typeof value.baselineId!=='string' || (view.baselineId!==undefined && view.baselineId!==value.baselineId)) throw Error('Resource binding lost');
          const newer=Number(value.revision)>(view.completedRevision??0);
          view.sequence=Number(value.sequence);view.revision=Number(value.revision);view.baselineId=value.baselineId;
          if (value.kind==='snapshot') {
            if(newer && value.source!==undefined && (value.payload as {historyComplete?:boolean}|null)?.historyComplete!==false)source(view,value.source,false);
            view.pending=value.payload;
            if(view.resource==='rooms' && Array.isArray(value.payload)) {
              const available=new Set(value.payload.map(row=>String(row.room_id)));
              for(const id of [...rooms])if(!available.has(id)){rooms.delete(id);degraded.get(id)?.stop();degraded.delete(id);removeRoom?.(id);}
            }
            if(view.ready && !(value.payload as {historyComplete?:boolean}|null)?.hasOwnProperty('historyComplete')) delivery.snapshot(view.resource,view.roomId,value.payload);
          } else if(value.kind==='upsert') {
            const page=value.payload as {type?:string;records?:{seq:number}[];complete?:boolean;historyAfter?:number;room?:unknown;participants?:unknown};
            const pending=view.pending as {history?:{seq:number}[];historyComplete?:boolean;historyAfter?:number};
            if(page?.type==='room-update') {
              if(!view.ready || !pending || !Array.isArray(pending.history) || pending.historyComplete===false
                || page.historyAfter!==(pending.history.at(-1)?.seq??0))throw Error('Invalid history cursor');
              view.pending={room:page.room,participants:page.participants,history:[...pending.history],historyComplete:false,historyAfter:page.historyAfter};
            } else {
              if(page?.type!=='history-page' || !Array.isArray(page.records) || !pending || !Array.isArray(pending.history) || pending.historyComplete!==false)throw Error('Invalid history unit');
              if(pending.historyAfter!==undefined) {
                let seq=pending.history.at(-1)?.seq??0;
                for(const record of page.records)if(record.seq!==++seq)throw Error('Invalid history sequence');
              }
              pending.history.push(...page.records);
              if(page.complete && newer && value.source!==undefined)source(view,value.source,false);
              if(page.complete){delete pending.historyComplete;delete pending.historyAfter;if(view.ready)delivery.snapshot(view.resource,view.roomId,pending);}
            }
            arm();
          } else if(value.kind==='ready') {
            if(view.pending===undefined || !value.payload || (value.payload as {baselineId?:unknown}).baselineId!==view.baselineId) throw Error('Invalid resource baseline');
            if((view.pending as {historyComplete?:boolean}|null)?.historyComplete===false)throw Error('Incomplete resource history');
            source(view,(value.payload as {source?:unknown}).source);view.ready=true;view.completedRevision=view.revision;
            const key=view.roomId??'';degraded.get(key)?.stop();degraded.delete(key);
            delivery.snapshot(view.resource,view.roomId,view.pending);
            if([...views.values()].every(v=>v.ready||v.failed)){established=true;byteDeadline=Date.now()+45_000;failures=0;if([...views.values()].every(v=>v.ready&&!v.failed))delivery.health(true);}
            arm();
          } else if(value.kind==='coverage') { if(!view.ready) throw Error('Resource baseline missing');source(view,(value.payload as {source?:unknown})?.source);arm(); }
          else if(value.kind==='health' && (value.payload as {reason?:string})?.reason==='auth_required') {terminal(new ResourceHttpError(401));}
          else if(value.kind==='resync' && ['capacity','projection_unavailable'].includes((value.payload as {reason?:string})?.reason??'')) {
            view.failed=true;view.expires=Number.POSITIVE_INFINITY;recover(view.roomId);
            if([...views.values()].every(v=>v.ready||v.failed)){established=true;byteDeadline=Date.now()+45_000;}
            // Only a witnessed failed capture probes again. Healthy sibling
            // bindings keep their stream and never enter content polling.
            if((value.payload as {reason:string}).reason==='projection_unavailable')view.retry=setTimeout(()=>{
              if(signal.aborted || views.get(String(value.viewId))!==view || (view.roomId!==undefined && !rooms.has(view.roomId)))return;
              views.delete(String(value.viewId));register(view.resource,view.roomId,view.failures+1);
            },view.failures<3?1000:Math.min(30_000,(view.failures-2)*10_000));
            arm();
          }
          else throw Error('Resource recovery required');
          // Paged history is one logical record; incomplete units cannot certify it.
          if((value.kind==='snapshot' || value.kind==='upsert')
            && (view.pending as {historyComplete?:boolean}|null)?.historyComplete!==false) {
            if(view.ready && newer && value.source!==undefined){source(view,value.source);arm();}
            view.completedRevision=view.revision;
          }
        };
        for (;;) {
          const step = await reader.read();check();if(step.done)throw Error('Resource transport ended');
          if(established && step.value.length)byteDeadline=Date.now()+45_000;arm();
          buffer += decoder.decode(step.value,{stream:true});
          if(new TextEncoder().encode(buffer).length>8*1024*1024)throw Error('Resource input capacity');
          let end: number;
          while((end=buffer.indexOf('\n\n'))>=0) {
            check();
            const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
            if(new TextEncoder().encode(frame).length>512*1024)throw Error('Resource frame capacity');
            if(frame.startsWith(':'))continue;
            const event=frame.split('\n').find(line=>line.startsWith('event: '))?.slice(7);
            const data=frame.split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6)).join('\n');
            const value=JSON.parse(data) as Record<string,unknown>;
            if(event==='resource-connection') {
              if(connection || value.protocolVersion!==1 || typeof value.connectionId!=='string' || typeof value.producerGeneration!=='string')throw Error('Invalid resource connection');
              connection=value.connectionId;generation=value.producerGeneration;
              register('rooms');registerRoom=id=>register('room',id);for(const id of rooms)if(!degraded.has(id))registerRoom(id);
            } else if(event==='resource') {if(assembly)throw Error('Interleaved resource assembly');apply(value);}
            else if(event==='resource-coverage') {
              if(assembly || value.protocolVersion!==1 || value.producerGeneration!==generation || !Array.isArray(value.views))throw Error('Invalid resource coverage');
              for(const entry of value.views) {
                if(!entry || typeof entry!=='object')throw Error('Invalid resource coverage entry');
                apply({...entry,protocolVersion:value.protocolVersion,producerGeneration:value.producerGeneration,kind:'coverage',payload:{source:entry.source}});
              }
            }
            else if(event==='resource-chunk') {
              if(value.type==='start') {
                if(assembly || !Number.isSafeInteger(value.totalBytes) || Number(value.totalBytes)<=0 || Number(value.totalBytes)>16*1024*1024 || !Number.isSafeInteger(value.parts) || Number(value.parts)<=0 || Number(value.parts)>64)throw Error('Resource assembly capacity');
                assembly={id:String(value.id),totalBytes:Number(value.totalBytes),parts:Number(value.parts),chunks:[],bytes:0,binding:value};
              } else {
                if(!assembly || value.id!==assembly.id || ['producerGeneration','viewId','subscriptionEpoch','revision','sequence'].some(k=>value[k]!==assembly!.binding[k]))throw Error('Resource chunk binding');
                if(value.type==='chunk') {
                  if(value.index!==assembly.chunks.length || typeof value.data!=='string')throw Error('Resource chunk order');
                  const bytes=Uint8Array.from(atob(value.data),c=>c.charCodeAt(0));assembly.bytes+=bytes.length;
                  if(assembly.bytes>assembly.totalBytes || assembly.chunks.length>=assembly.parts)throw Error('Resource chunk capacity');assembly.chunks.push(bytes);
                } else if(value.type==='commit') {
                  if(assembly.bytes!==assembly.totalBytes || value.totalBytes!==assembly.totalBytes || assembly.chunks.length!==assembly.parts)throw Error('Incomplete resource assembly');
                  const bytes=new Uint8Array(assembly.bytes);let offset=0;for(const chunk of assembly.chunks){bytes.set(chunk,offset);offset+=chunk.length;}
                  const complete=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
                  if(['producerGeneration','viewId','subscriptionEpoch','revision','sequence'].some(k=>complete[k]!==assembly!.binding[k]))throw Error('Resource assembly binding');
                  assembly=undefined;apply(complete);
                } else throw Error('Invalid resource chunk');
              }
            } else throw Error('Resource service unavailable');
          }
        }
      } catch(error) {
        if(!lifetime.signal.aborted && visible() && !terminal(error)){
          delivery.health(false,error);recover();for(const id of rooms)recover(id);
        }
      }
      finally {for(const view of views.values())clearTimeout(view.retry);signal.removeEventListener('abort',cancelRead);clearTimeout(timer);registerRoom=undefined;removeRoom=undefined;checkResume=undefined;activeAttempt=undefined;attempt.abort();void reader?.cancel().catch(()=>{});}
      if(!lifetime.signal.aborted && visible())await new Promise<void>(resolve=>{
        const finish=()=>{clearTimeout(timer);lifetime.signal.removeEventListener('abort',finish);document.removeEventListener('visibilitychange',hidden);resolve();};
        const hidden=()=>{if(!visible())finish();};
        const timer=setTimeout(finish,++failures<=3?1000:Math.min(30_000,(failures-3)*10_000));
        lifetime.signal.addEventListener('abort',finish,{once:true});document.addEventListener('visibilitychange',hidden);
      });
    }
  })();
  return {
    watchRoom(id){if(lifetime.signal.aborted)return;rooms.add(id);if(degraded.size)recover(id);registerRoom?.(id);},
    unwatchRoom(id){rooms.delete(id);degraded.get(id)?.stop();degraded.delete(id);removeRoom?.(id);},
    close(){lifetime.abort();for(const poller of degraded.values())poller.stop();degraded.clear();},
  };
}
