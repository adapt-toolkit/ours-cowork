import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { CoworkStore } from './storage.ts';
type CoworkResourceState = ReturnType<CoworkStore['resourceState']>;

export async function abortableProjection<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('resource projection aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([read, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export interface ResourceFrameBinding {
  readonly protocolVersion: 1;
  readonly producerGeneration: string;
  readonly subscriptionEpoch: number;
  readonly viewId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly baselineId?: string;
}
export type ResourceHealthReason = 'auth_required' | 'unsupported' | 'upstream_unavailable';
export type ResourceEnvelope = ResourceFrameBinding & (
  | { readonly kind: 'snapshot'; readonly payload: unknown }
  | { readonly kind: 'upsert'; readonly payload: unknown }
  | { readonly kind: 'delete'; readonly payload: { readonly id: string; readonly revision: number } }
  | { readonly kind: 'ready'; readonly payload: { readonly baselineId: string; readonly source: CoworkResourceState } }
  | { readonly kind: 'coverage'; readonly payload: { readonly source: CoworkResourceState } }
  | { readonly kind: 'resync'; readonly payload: { readonly reason: 'capacity' | 'projection_unavailable' } }
  | { readonly kind: 'health'; readonly payload: { readonly healthy: false; readonly reason: ResourceHealthReason } }
);
export interface ResourceWireFrame { event: 'resource' | 'resource-chunk'; data: Record<string, unknown> }
export const RESOURCE_FRAME_BYTES = 512 * 1024;
export const RESOURCE_PENDING_BYTES = 8 * 1024 * 1024;
export const RESOURCE_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

/** Lazily yield byte chunks so backpressure never queues an entire large record.
 * Base64 prevents splitting a Unicode scalar from corrupting JSON/SSE parsing. */
export function* resourceFrames(envelope: ResourceEnvelope): Generator<ResourceWireFrame> {
  const bytes = Buffer.from(JSON.stringify(envelope));
  if (bytes.length > RESOURCE_ASSEMBLY_BYTES) throw new Error('resource assembly limit exceeded');
  const ordinary = { event: 'resource' as const, data: envelope as unknown as Record<string, unknown> };
  if (Buffer.byteLength(`event: resource\ndata: ${bytes.toString('utf8')}\n\n`) <= RESOURCE_FRAME_BYTES) {
    yield ordinary; return;
  }
  const id = `${envelope.viewId}:${envelope.subscriptionEpoch}:${envelope.sequence}`;
  const binding = { protocolVersion: 1, id, producerGeneration: envelope.producerGeneration,
    viewId: envelope.viewId, subscriptionEpoch: envelope.subscriptionEpoch, revision: envelope.revision,
    sequence: envelope.sequence };
  yield { event: 'resource-chunk', data: { ...binding, type: 'start', totalBytes: bytes.length, parts: Math.ceil(bytes.length / CHUNK_BYTES) } };
  for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_BYTES, index++) {
    yield { event: 'resource-chunk', data: { ...binding, type: 'chunk', index, data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') } };
  }
  yield { event: 'resource-chunk', data: { ...binding, type: 'commit', totalBytes: bytes.length } };
}

interface PendingOutput {
  envelope: ResourceEnvelope;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** One bounded Cowork HTTP writer. The active record owns the assembly budget;
 * waiting live records share the smaller pending-output budget. */
export class ResourceOutput {
  readonly #pending: PendingOutput[] = [];
  #pendingBytes = 0;
  #active?: PendingOutput;
  #closed = false;
  #releaseDrain?: () => void;
  readonly #abort = () => this.close();
  constructor(
    readonly response: ServerResponse,
    readonly signal: AbortSignal,
    readonly failed: (error: Error) => void,
  ) {
    if (signal.aborted) this.close();
    else {
      signal.addEventListener('abort', this.#abort, { once: true });
      response.once('close', this.#abort);
    }
  }

  send(envelope: ResourceEnvelope): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('resource output closed'));
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (bytes > RESOURCE_ASSEMBLY_BYTES) return this.#fail(new Error('resource assembly limit exceeded'));
    if (this.#active && this.#pendingBytes + bytes > RESOURCE_PENDING_BYTES) {
      return this.#fail(new Error('resource pending limit exceeded'));
    }
    return new Promise<void>((resolve, reject) => {
      const item = { envelope, bytes, resolve, reject };
      if (!this.#active) {
        this.#active = item;
        void this.#pump();
      } else {
        this.#pending.push(item);
        this.#pendingBytes += bytes;
      }
    });
  }

  #fail(error: Error): Promise<never> {
    this.close(error);
    this.failed(error);
    return Promise.reject(error);
  }

  close(error = new Error('resource output closed')): void {
    if (this.#closed) return;
    this.#closed = true;
    this.signal.removeEventListener('abort', this.#abort);
    this.response.removeListener('close', this.#abort);
    this.#releaseDrain?.();
    this.#active?.reject(error);
    for (const item of this.#pending.splice(0)) item.reject(error);
    this.#pendingBytes = 0;
    if (!this.response.destroyed && !this.response.writableEnded) this.response.end();
  }

  async #pump(): Promise<void> {
    try {
      while (this.#active && !this.#closed) {
        const item = this.#active;
        for (const frame of resourceFrames(item.envelope)) {
          if (this.#closed) break;
          const writable = this.response.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
          if (!writable) await this.#drain();
        }
        if (this.#closed) break;
        item.resolve();
        this.#active = this.#pending.shift();
        if (this.#active) this.#pendingBytes -= this.#active.bytes;
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('resource output failed');
      this.close(failure);
      this.failed(failure);
    }
  }

  #drain(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise(resolve => {
      const release = () => {
        this.response.removeListener('drain', release);
        this.#releaseDrain = undefined;
        resolve();
      };
      this.#releaseDrain = release;
      this.response.once('drain', release);
    });
  }
}

export interface ResourceDescriptor { viewId: string; resource: 'rooms' | 'room'; roomId?: string }
export function canonicalResourceDescriptor(input: unknown): ResourceDescriptor {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('invalid resource descriptor');
  const value = input as ResourceDescriptor;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.viewId) || !['rooms','room'].includes(value.resource)
    || Object.keys(value).some(key => !['viewId','resource','roomId'].includes(key))
    || (value.resource === 'room' && !/^[0-9a-hjkmnp-tv-z]{26}$/.test(value.roomId ?? ''))
    || (value.resource === 'rooms' && value.roomId !== undefined)) throw Error('invalid resource descriptor');
  return { ...value };
}
interface View {
  descriptor: ResourceDescriptor; epoch: number; baselineId: string; controller: AbortController;
  revision: number; sequence: number; dirty: boolean; running: boolean; failed: boolean;
  initial: Promise<BoundProjection>; resolveInitial(value: BoundProjection): void; rejectInitial(error: Error): void;
  payload?: unknown; covered?: CoworkResourceState; baselineReady: boolean; commits: number; historyAfter?: number;
}
interface BoundProjection {
  payload: unknown; source: CoworkResourceState; producerGeneration: string; revision: number; baselineId: string; descriptor: ResourceDescriptor;
}
interface Connection {
  id: string; owner: string; controller: AbortController; output: ResourceOutput;
  views: Map<string, View>; epochs: Map<string, number>;
  authorized(): Promise<boolean>; observer: {snapshot(roomId?: string): CoworkResourceState}; dispose(): void; tail: Promise<void>; close(): void;
}
const MAX_RESOURCE_VIEW_IDENTITIES = 256;
class ResourceCapacityError extends Error {}
export class ResourceBindingError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
/** Committed snapshot/ready/bound-read protocol. No controllers,
 * notification reads or presence are acquired by this delivery owner. */
export class CoworkResourceViews {
  readonly producerGeneration = randomUUID();
  private connections = new Map<string, Connection>();
  constructor(private store: CoworkStore, private project: (descriptor: ResourceDescriptor, signal: AbortSignal, owner: string, historyAfter?: number) => Promise<unknown>) {}
  open(response: ServerResponse, owner: string, authorized: () => Promise<boolean>) {
    const id = randomUUID(), controller = new AbortController();
    let connection: Connection | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (controller.signal.aborted) return;
      controller.abort(); clearInterval(timer); this.connections.delete(id);
      if (connection) {
        for (const view of connection.views.values()) this.retire(view);
        connection.views.clear(); connection.dispose(); connection.output.close();
      }
      response.off('close', close);
    };
    const output = new ResourceOutput(response, controller.signal, close);
    const observer = { snapshot: (roomId?: string) => this.store.resourceState(roomId) };
    const dispose = this.store.onResourceCommit(event => {
      if (!connection || controller.signal.aborted) return;
      if (observer.snapshot().health !== 'healthy') {
        void Promise.allSettled([...connection.views.values()].map(view => this.emit(connection!,view,'health',{healthy:false,reason:'upstream_unavailable'}))).then(close);
      } else for (const view of connection.views.values()) {
        if (view.descriptor.resource === 'room' && observer.snapshot(view.descriptor.roomId).health !== 'healthy') {
          if (!view.failed) {
            view.failed=true; this.retire(view);
            void this.emit(connection,view,'resync',{reason:'projection_unavailable'}).catch(close);
          }
        } else if ((event.kind === 'health' && !event.roomId) || (view.descriptor.resource === 'rooms' ? event.kind !== 'history' && event.kind !== 'health' : event.roomId === view.descriptor.roomId)) { view.commits++; this.schedule(connection, view); }
        else if (view.covered && !view.running && !view.dirty) view.covered = observer.snapshot();
      }
    });
    connection = { id, owner, controller, output, views: new Map(), epochs: new Map(), authorized, observer, dispose, tail: Promise.resolve(), close };
    this.connections.set(id, connection); response.once('close', close);
    response.write(`event: resource-connection\ndata: ${JSON.stringify({ protocolVersion:1, connectionId:id, producerGeneration:this.producerGeneration, continuity:'reset', baselineRequired:true })}\n\n`);
    if (observer.snapshot().health !== 'healthy') {
      response.write(`event: resource-service-health\ndata: ${JSON.stringify({protocolVersion:1,healthy:false,reason:'upstream_unavailable'})}\n\n`); close();
    } else {
      timer = setInterval(() => {
        for (const view of connection!.views.values()) {
          if (view.baselineReady && !view.failed && view.covered && connection!.observer.snapshot(view.descriptor.roomId).health === 'healthy'
            && view.covered.position === connection!.observer.snapshot().position) {
            void this.emit(connection!, view, 'coverage', { source: view.covered }).catch(close);
          }
        }
        if (!connection!.views.size) response.write(': keepalive\n\n');
      }, 2000); timer.unref();
    }
    return { connectionId:id, close };
  }
  register(owner: string, connectionId: string, viewId: string, epoch: number, input: unknown) {
    const connection = this.get(owner, connectionId);
    let descriptor: ResourceDescriptor;
    try { descriptor = canonicalResourceDescriptor(input); } catch { throw new ResourceBindingError(400, 'invalid resource descriptor'); }
    if (descriptor.viewId !== viewId || !Number.isSafeInteger(epoch) || epoch < 1) throw new ResourceBindingError(400, 'invalid resource epoch');
    if ((connection.epochs.get(viewId) ?? 0) >= epoch) throw new ResourceBindingError(409, 'obsolete resource epoch');
    if (connection.observer.snapshot().health !== 'healthy') throw new ResourceBindingError(503, 'resource observation unavailable');
    if(!connection.views.has(viewId) && connection.views.size>=64)throw new ResourceBindingError(409,'resource view capacity exceeded');
    if (!connection.epochs.has(viewId) && connection.epochs.size >= MAX_RESOURCE_VIEW_IDENTITIES) throw new ResourceBindingError(409, 'resource view identity capacity exceeded');
    const old = connection.views.get(viewId); if (old) this.retire(old);
    let resolveInitial!: View['resolveInitial'], rejectInitial!: View['rejectInitial'];
    const initial = new Promise<BoundProjection>((resolve, reject) => {resolveInitial=resolve;rejectInitial=reject;}); void initial.catch(()=>{});
    const view: View = {descriptor,epoch,baselineId:randomUUID(),controller:new AbortController(),revision:0,sequence:0,dirty:false,running:false,failed:false,baselineReady:false,commits:0,initial,resolveInitial,rejectInitial};
    connection.views.set(viewId, view); connection.epochs.set(viewId, epoch); this.schedule(connection,view);
    return {subscriptionEpoch:epoch,baselineId:view.baselineId};
  }
  remove(owner: string, connectionId: string, viewId: string, epoch: number) {
    const connection = this.get(owner,connectionId),view=connection.views.get(viewId);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(viewId) || !Number.isSafeInteger(epoch) || epoch < 1) throw new ResourceBindingError(400, 'invalid resource epoch');
    if (!connection.epochs.has(viewId) && connection.epochs.size >= MAX_RESOURCE_VIEW_IDENTITIES) throw new ResourceBindingError(409, 'resource view identity capacity exceeded');
    // Retain the fence even when DELETE overtakes the registration body.
    connection.epochs.set(viewId, Math.max(connection.epochs.get(viewId) ?? 0, epoch));
    if (view && view.epoch <= epoch) { this.retire(view); connection.views.delete(viewId); }
  }
  async bound(owner:string,connectionId:string,viewId:string,epoch:number,baselineId:string):Promise<BoundProjection> {
    const connection=this.get(owner,connectionId),view=connection.views.get(viewId);
    if (!view || view.epoch!==epoch || view.baselineId!==baselineId) throw new ResourceBindingError(409,'resource binding mismatch');
    const baseline=await view.initial;
    if (!this.current(connection,view) || view.failed) throw new ResourceBindingError(409,'resource binding retired');
    return baseline;
  }
  close() {for(const connection of this.connections.values())connection.close();}
  private get(owner:string,id:string) {
    const connection=this.connections.get(id);
    if(!connection || connection.owner!==owner)throw new ResourceBindingError(409,'unknown resource connection');return connection;
  }
  private current(connection:Connection,view:View) {return !connection.controller.signal.aborted && !view.controller.signal.aborted && connection.views.get(view.descriptor.viewId)===view;}
  private retire(view:View) {view.controller.abort();view.rejectInitial(new ResourceBindingError(409,'resource binding retired'));}
  private async emit(connection:Connection,view:View,kind:ResourceEnvelope['kind'],payload:unknown) {
    if (kind === 'snapshot' || kind === 'upsert') {
      if (!await connection.authorized()) {
        await this.emit(connection,view,'health',{healthy:false,reason:'auth_required'});
        connection.close(); throw new ResourceBindingError(401,'authentication required');
      }
      if (!this.current(connection,view)) throw Error('resource binding retired');
    }
    const envelope = {protocolVersion:1,producerGeneration:this.producerGeneration,viewId:view.descriptor.viewId,subscriptionEpoch:view.epoch,baselineId:view.baselineId,sequence:view.sequence+1,revision:view.revision,kind,payload} as ResourceEnvelope;
    if (Buffer.byteLength(JSON.stringify(envelope)) > RESOURCE_ASSEMBLY_BYTES) throw new ResourceCapacityError('resource assembly capacity');
    view.sequence++;
    return connection.output.send(envelope);
  }
  private schedule(connection:Connection,view:View) {
    if(!this.current(connection,view)||view.failed)return;
    view.dirty=true;if(view.running)return;view.running=true;
    const task=connection.tail.then(()=>this.refresh(connection,view));connection.tail=task.catch(()=>{});
    void task.finally(()=>{view.running=false;if(view.dirty)this.schedule(connection,view);}).catch(connection.close);
  }
  private async refresh(connection:Connection,view:View) {
    try {
      if(!view.dirty||!this.current(connection,view))return;
      view.dirty=false;
      let payload:unknown,source:CoworkResourceState|undefined;
      for(let attempt=0;attempt<3;attempt++) {
        view.controller.signal.throwIfAborted();
        if(connection.observer.snapshot(view.descriptor.roomId).health!=='healthy')throw Error('resource observation unavailable');
        const before=view.commits;
        payload=await abortableProjection(this.project(view.descriptor,view.controller.signal,connection.owner,view.historyAfter),view.controller.signal);
        view.controller.signal.throwIfAborted();
        const after=connection.observer.snapshot(view.descriptor.roomId);
        if(after.health!=='healthy')throw Error('resource observation unavailable');
        if(before===view.commits) {source=after;view.dirty=false;break;}
      }
      if (!source) throw Error('stable resource projection unavailable');
      if(!this.current(connection,view))return;
      const first=view.payload===undefined;
      const room = payload as { history?: {seq:number}[]; historyAfter?: number } | null;
      const incremental = !first && view.descriptor.resource === 'room' && room?.historyAfter !== undefined;
      if (incremental && (room.historyAfter !== view.historyAfter || !Array.isArray(room.history))) throw Error('invalid history cursor');
      // Retain only comparison metadata. The initial bound response owns its full
      // baseline; live captures neither decode nor serialize that archive again.
      const comparison = view.descriptor.resource === 'room' && room && Array.isArray(room.history)
        ? {...room,history:[],historyAfter:undefined} : payload;
      const historyChanged=Array.isArray(room?.history) && (incremental ? room.history.length>0 : (room.history.at(-1)?.seq??0)!==view.historyAfter);
      const changed=first || historyChanged || JSON.stringify(comparison, (key,value)=>key==='observedAt'?undefined:value)!==JSON.stringify(view.payload, (key,value)=>key==='observedAt'?undefined:value);
      if (changed) {
        view.revision++;
        if (view.descriptor.resource === 'room' && room && Array.isArray(room.history)
          && (incremental || Buffer.byteLength(JSON.stringify(payload)) > 3 * 1024 * 1024)) {
          if (incremental) await this.emit(connection,view,'upsert',{...room,type:'room-update',history:[]});
          else await this.emit(connection,view,'snapshot',{...room,history:[],historyComplete:false});
          let records: unknown[] = [], bytes = 0;
          for (const record of room.history) {
            const size = Buffer.byteLength(JSON.stringify(record));
            if (records.length && bytes + size > 3 * 1024 * 1024) {
              await this.emit(connection,view,'upsert',{type:'history-page',records,complete:false});records=[];bytes=0;
            }
            records.push(record);bytes += size;
          }
          await this.emit(connection,view,'upsert',{type:'history-page',records,complete:true});
        } else await this.emit(connection,view,'snapshot',payload);
        if(!this.current(connection,view))return;
        view.payload=comparison;
        if (view.descriptor.resource === 'room' && room && Array.isArray(room.history)) {
          view.historyAfter = room.history.at(-1)?.seq ?? (incremental ? view.historyAfter : 0);
        }
      }
      // Coverage becomes publishable only after all canonical content has been
      // flushed. A relevant commit during authorization remains pending; only
      // unrelated commits may advance coverage without a new projection.
      view.covered = view.dirty ? source : connection.observer.snapshot(view.descriptor.roomId);
      if(first) {
        await this.emit(connection,view,'ready',{baselineId:view.baselineId,source:view.covered});
        if (this.current(connection,view)) view.baselineReady = true;
        if(this.current(connection,view))view.resolveInitial({payload,source:view.covered,producerGeneration:this.producerGeneration,revision:view.revision,baselineId:view.baselineId,descriptor:view.descriptor});
      } else await this.emit(connection,view,'coverage',{source:view.covered});
    } catch(error) {
      if(!this.current(connection,view))return;view.failed=true;
      view.rejectInitial(error instanceof Error?error:Error('projection failed'));
      await this.emit(connection,view,'resync',{reason:error instanceof ResourceCapacityError?'capacity':'projection_unavailable'}).catch(connection.close);
    }
  }
}
