import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import * as nodeFs from 'node:fs';

import { z } from 'zod';

export const MAX_REQUEST_BYTES = 1024 * 1024;

const RpcIdSchema = z.union([
  z.string().min(1).max(256),
  z.number().int().nonnegative().safe(),
]);
const RpcRequestSchema = z.object({
  version: z.literal(1),
  id: RpcIdSchema,
  method: z.string().min(1).max(256),
  params: z.record(z.unknown()),
}).strict();

export type RpcId = z.infer<typeof RpcIdSchema>;
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcResponse =
  | { version: 1; id: RpcId; result: unknown }
  | { version: 1; id: RpcId | null; error: { code: string; message: string } };

/** The literal makes accidentally publishing an unauthenticated route a type error. */
export interface AuthenticatedRoute {
  auth: true;
  run: (params: Record<string, unknown>) => unknown | Promise<unknown>;
}

export type AuthenticatedRouteTable = Readonly<Record<string, AuthenticatedRoute>>;

export class RpcDispatcher {
  private readonly routes: AuthenticatedRouteTable;
  private readonly work = new Set<Promise<unknown>>();
  private accepting = true;

  constructor(routes: AuthenticatedRouteTable) {
    this.routes = Object.freeze({ ...routes });
    for (const [method, route] of Object.entries(this.routes)) {
      if (!method || route.auth !== true || typeof route.run !== 'function') {
        throw new TypeError(`RPC route "${method}" is not an authenticated route`);
      }
    }
  }

  dispatch(input: unknown): Promise<RpcResponse> {
    const parsed = RpcRequestSchema.safeParse(input);
    if (!parsed.success) {
      const candidateId = typeof input === 'object' && input !== null && 'id' in input
        ? RpcIdSchema.safeParse((input as { id?: unknown }).id)
        : undefined;
      return Promise.resolve(errorResponse(candidateId?.success ? candidateId.data : null, 'invalid_request', 'invalid RPC request'));
    }
    const request = parsed.data;
    if (!this.accepting) return Promise.resolve(errorResponse(request.id, 'shutting_down', 'daemon is shutting down'));
    const route = this.routes[request.method];
    if (!route) return Promise.resolve(errorResponse(request.id, 'method_not_found', 'method not found'));
    const operation = Promise.resolve().then(() => route.run(request.params)).then(
      (result): RpcResponse => ({ version: 1, id: request.id, result }),
      (error): RpcResponse => errorResponse(
        request.id,
        classifyServiceError(error),
        error instanceof Error ? error.message : 'internal error',
      ),
    );
    this.work.add(operation);
    void operation.finally(() => this.work.delete(operation));
    return operation;
  }

  beginShutdown(): void { this.accepting = false; }

  async drain(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }
}

export interface RoomServiceApi {
  createRoom(input: unknown): Promise<unknown>;
  updateRoom(roomId: string, input: unknown): Promise<unknown>;
  createInvite(roomId: string, input: unknown): Promise<unknown>;
  revokeInvite(roomId: string, inviteId: string): Promise<unknown>;
  recoverInvites(roomId: string): Promise<unknown>;
  confirmRecoveredInvite(roomId: string, recoveryOf: string, inviteId: string): Promise<unknown>;
  listRooms(): Promise<unknown>;
  showRoom(roomId: string): Promise<unknown>;
  participants(roomId: string): Promise<unknown>;
  history(roomId: string, options: unknown): Promise<unknown>;
  postMessage(roomId: string, input: unknown): Promise<unknown>;
  closeRoom(roomId: string): Promise<unknown>;
  deleteRoom(roomId: string, input: unknown): Promise<unknown>;
}

const RoomIdParams = z.object({ room_id: z.string() }).strict();
const InviteRevokeParams = z.object({ room_id: z.string(), invite_id: z.string() }).strict();
const RecoverConfirmParams = z.object({
  room_id: z.string(), recovery_of: z.string(), invite_id: z.string(),
}).strict();
const HistoryParams = z.object({
  room_id: z.string(), after: z.number().optional(), limit: z.number().optional(),
}).strict();

export function createServiceRoutes(service: RoomServiceApi): AuthenticatedRouteTable {
  return {
    'room.create': { auth: true, run: (params) => service.createRoom(params) },
    'room.settings': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({
        room_id: z.string(), goal: z.unknown().optional(), briefing: z.unknown().optional(), status: z.unknown().optional(),
      }).strict().parse(params);
      return service.updateRoom(room_id, input);
    } },
    'room.invite': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({
        room_id: z.string(), mode: z.unknown(), role: z.unknown(), min_accepts: z.unknown(),
      }).strict().parse(params);
      return service.createInvite(room_id, input);
    } },
    'room.revoke': { auth: true, run: (params) => {
      const value = InviteRevokeParams.parse(params);
      return service.revokeInvite(value.room_id, value.invite_id);
    } },
    'room.recover': { auth: true, run: (params) => service.recoverInvites(RoomIdParams.parse(params).room_id) },
    'room.recover.confirm': { auth: true, run: (params) => {
      const value = RecoverConfirmParams.parse(params);
      return service.confirmRecoveredInvite(value.room_id, value.recovery_of, value.invite_id);
    } },
    'room.list': { auth: true, run: (params) => {
      z.object({}).strict().parse(params);
      return service.listRooms();
    } },
    'room.show': { auth: true, run: (params) => service.showRoom(RoomIdParams.parse(params).room_id) },
    'room.participants': { auth: true, run: (params) => service.participants(RoomIdParams.parse(params).room_id) },
    'room.history': { auth: true, run: (params) => {
      const { room_id, ...options } = HistoryParams.parse(params);
      return service.history(room_id, options);
    } },
    'room.message': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({ room_id: z.string(), text: z.unknown() }).strict().parse(params);
      return service.postMessage(room_id, input);
    } },
    'room.close': { auth: true, run: (params) => service.closeRoom(RoomIdParams.parse(params).room_id) },
    'room.delete': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({ room_id: z.string(), confirm: z.unknown() }).strict().parse(params);
      return service.deleteRoom(room_id, input);
    } },
  } satisfies AuthenticatedRouteTable;
}

export interface TransportServerOptions {
  socketPath: string;
  rest: { enabled: boolean; port: number };
  dispatcher: RpcDispatcher;
  token?: string;
  fs?: typeof nodeFs;
  timingSafeEqual?: (left: Uint8Array, right: Uint8Array) => boolean;
  log?: (...parts: unknown[]) => void;
}

export class TransportServer {
  private readonly options: TransportServerOptions;
  private readonly fs: typeof nodeFs;
  private readonly compare: (left: Uint8Array, right: Uint8Array) => boolean;
  private readonly sockets = new Set<net.Socket>();
  private readonly requests = new Set<Promise<void>>();
  private unixServer?: net.Server;
  private httpServer?: http.Server;
  private startWork?: Promise<void>;
  private stopWork?: Promise<void>;

  constructor(options: TransportServerOptions) {
    this.options = options;
    this.fs = options.fs ?? nodeFs;
    this.compare = options.timingSafeEqual ?? nodeTimingSafeEqual;
    if (options.rest.enabled && !/^[0-9a-f]{64}$/.test(options.token ?? '')) {
      throw new Error('REST requires a valid 64-hex management token');
    }
  }

  get restAddress(): net.AddressInfo {
    const address = this.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('REST transport is not listening');
    return address;
  }

  start(): Promise<void> {
    this.startWork ??= this.startUnlocked();
    return this.startWork;
  }

  private async startUnlocked(): Promise<void> {
    await this.prepareUnixPath();
    const unix = net.createServer((socket) => this.handleUnix(socket));
    this.unixServer = unix;
    try {
      await listen(unix, this.options.socketPath);
      this.fs.chmodSync(this.options.socketPath, 0o600);
      if (this.options.rest.enabled) {
        const rest = http.createServer((request, response) => this.track(this.handleRest(request, response)));
        this.httpServer = rest;
        await listen(rest, this.options.rest.port, '127.0.0.1');
      }
    } catch (error) {
      await this.closeServers();
      this.removeOwnedSocket();
      throw error;
    }
  }

  stop(): Promise<void> {
    this.stopWork ??= this.stopUnlocked();
    return this.stopWork;
  }

  private async stopUnlocked(): Promise<void> {
    this.options.dispatcher.beginShutdown();
    const closing = this.closeServers();
    for (const socket of this.sockets) socket.end();
    await Promise.allSettled([...this.requests]);
    await this.options.dispatcher.drain();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await closing;
    this.removeOwnedSocket();
  }

  private handleUnix(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    let rejected = false;
    socket.on('data', (chunk: Buffer) => {
      if (rejected) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_REQUEST_BYTES && buffered.indexOf(0x0a) < 0) {
        rejected = true;
        socket.end(`${JSON.stringify(errorResponse(null, 'request_too_large', 'request exceeds 1 MiB'))}\n`);
        return;
      }
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (line.length > MAX_REQUEST_BYTES) {
          rejected = true;
          socket.end(`${JSON.stringify(errorResponse(null, 'request_too_large', 'request exceeds 1 MiB'))}\n`);
          return;
        }
        const operation = this.dispatchBytes(line).then((response) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
        });
        this.track(operation);
      }
    });
    socket.on('error', (error) => this.options.log?.('Unix transport socket error:', error));
  }

  private async handleRest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.authorized(request.headers.authorization)) {
      sendJson(response, 401, errorResponse(null, 'unauthorized', 'unauthorized'));
      request.resume();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/rpc') {
      sendJson(response, 404, errorResponse(null, 'not_found', 'not found'));
      request.resume();
      return;
    }
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
      sendJson(response, 413, errorResponse(null, 'request_too_large', 'request exceeds 1 MiB'));
      request.resume();
      return;
    }
    const body = await readBody(request, MAX_REQUEST_BYTES);
    if (!body.ok) {
      sendJson(response, 413, errorResponse(null, 'request_too_large', 'request exceeds 1 MiB'));
      return;
    }
    const rpc = await this.dispatchBytes(body.bytes);
    const status = 'error' in rpc
      ? rpc.error.code === 'method_not_found' ? 404
        : rpc.error.code === 'internal' ? 500 : 400
      : 200;
    sendJson(response, status, rpc);
  }

  private authorized(header: string | undefined): boolean {
    const expectedText = this.options.token;
    if (!expectedText || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const suppliedText = header.slice('Bearer '.length);
    if (!/^[0-9a-f]{64}$/.test(suppliedText) || suppliedText.length !== expectedText.length) return false;
    const supplied = Buffer.from(suppliedText, 'hex');
    const expected = Buffer.from(expectedText, 'hex');
    if (supplied.length !== expected.length) return false;
    try { return this.compare(supplied, expected); } catch { return false; }
  }

  private async dispatchBytes(bytes: Uint8Array): Promise<RpcResponse> {
    let input: unknown;
    try { input = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch {
      return errorResponse(null, 'invalid_json', 'invalid JSON');
    }
    return this.options.dispatcher.dispatch(input);
  }

  private track(work: Promise<void>): void {
    this.requests.add(work);
    void work.then(
      () => this.requests.delete(work),
      (error) => {
        this.requests.delete(work);
        this.options.log?.('transport request failed:', error);
      },
    );
  }

  private async prepareUnixPath(): Promise<void> {
    let stat: nodeFs.Stats;
    try { stat = this.fs.lstatSync(this.options.socketPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isSocket()) {
      throw new Error('management socket path contains a non-socket or symbolic link');
    }
    if (await unixSocketIsLive(this.options.socketPath)) {
      throw new Error('management socket is already in use by a live daemon');
    }
    const observed = this.fs.lstatSync(this.options.socketPath);
    if (observed.dev !== stat.dev || observed.ino !== stat.ino || !observed.isSocket()) {
      throw new Error('management socket changed during stale-socket check');
    }
    this.fs.unlinkSync(this.options.socketPath);
  }

  private removeOwnedSocket(): void {
    try {
      const stat = this.fs.lstatSync(this.options.socketPath);
      if (stat.isSocket()) this.fs.unlinkSync(this.options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async closeServers(): Promise<void> {
    await Promise.allSettled([
      closeServer(this.httpServer),
      closeServer(this.unixServer),
    ]);
    this.httpServer = undefined;
    this.unixServer = undefined;
  }
}

function errorResponse(id: RpcId | null, code: string, message: string): RpcResponse {
  return { version: 1, id, error: { code, message } };
}

function classifyServiceError(error: unknown): string {
  if (error instanceof z.ZodError) return 'invalid_params';
  const name = error instanceof Error ? error.name : '';
  if (name === 'CoworkStorageError' && /does not exist|missing/i.test(String(error))) return 'not_found';
  if (name === 'RoomServiceError') return 'invalid_state';
  return 'internal';
}

function sendJson(response: http.ServerResponse, status: number, value: RpcResponse): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readBody(request: http.IncomingMessage, limit: number): Promise<{ ok: true; bytes: Buffer } | { ok: false }> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        request.resume();
        resolveBody({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!settled) resolveBody({ ok: true, bytes: Buffer.concat(chunks, size) });
    });
    request.on('aborted', () => {
      if (!settled) rejectBody(new Error('request body aborted'));
    });
    request.on('error', rejectBody);
  });
}

function unixSocketIsLive(path: string): Promise<boolean> {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = net.createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      rejectProbe(new Error('timed out probing existing management socket'));
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolveProbe(false);
      else rejectProbe(error);
    });
  });
}

function listen(server: net.Server | http.Server, ...args: unknown[]): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => { server.off('listening', onListening); rejectListen(error); };
    const onListening = () => { server.off('error', onError); resolveListen(); };
    server.once('error', onError);
    server.once('listening', onListening);
    (server.listen as (...values: unknown[]) => void)(...args);
  });
}

function closeServer(server: net.Server | http.Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}
