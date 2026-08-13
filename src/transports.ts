import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import * as nodeFs from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

import { createStaticWebHandler, type StaticWebHandler } from './web.ts';

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const HTTP_HEADERS_TIMEOUT_MS = 5_000;
export const HTTP_REQUEST_TIMEOUT_MS = 10_000;
export const HTTP_BODY_IDLE_TIMEOUT_MS = 5_000;
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MAX_STALE_PRIVATE_SOCKET_CLEANUP = 32;
type HttpSocketPhase = 'headers' | 'body' | 'response' | 'idle';

interface ProtectedPath {
  target: string;
  path: string;
  dev: number;
  ino: number;
}

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
    const owned = Object.create(null) as Record<string, AuthenticatedRoute>;
    for (const [method, route] of Object.entries(routes)) owned[method] = route;
    this.routes = Object.freeze(owned);
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
    const route = Object.hasOwn(this.routes, request.method) ? this.routes[request.method] : undefined;
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
  setRoleBriefing(roomId: string, input: unknown): Promise<unknown>;
  deleteRoleBriefing(roomId: string, input: unknown): Promise<unknown>;
  createInvite(roomId: string, input: unknown): Promise<unknown>;
  acceptExternalInvite(roomId: string, input: unknown): Promise<unknown>;
  revokeInvite(roomId: string, inviteId: string): Promise<unknown>;
  recoverInvites(roomId: string): Promise<unknown>;
  confirmRecoveredInvite(roomId: string, recoveryOf: string, inviteId: string): Promise<unknown>;
  removeParticipant(roomId: string, input: unknown): Promise<unknown>;
  replaceParticipant(roomId: string, input: unknown): Promise<unknown>;
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
  room_id: z.string(),
  after: z.number().optional(),
  limit: z.number().optional(),
  view: z.enum(['operator', 'participant']).optional(),
}).strict();
const RoleBriefingSetParams = z.object({
  room_id: z.string(), role: z.string(), text: z.string(),
}).strict();
const RoleBriefingDeleteParams = z.object({
  room_id: z.string(), role: z.string(),
}).strict();
const ParticipantRemoveParams = z.object({
  room_id: z.string(), participant: z.string(), notify: z.boolean().optional(),
}).strict();
const ParticipantReplaceParams = z.object({
  room_id: z.string(),
  participant: z.string(),
  notify: z.boolean().optional(),
  mode: z.enum(['one_time', 'public']).optional(),
  min_accepts: z.number().optional(),
}).strict();
const ExternalInviteAcceptParams = z.object({
  room_id: z.string(),
  role: z.string(),
  invite: z.string(),
  expected_cid: z.string().optional(),
  replaces_seat: z.string().optional(),
}).strict();

export function createServiceRoutes(service: RoomServiceApi): AuthenticatedRouteTable {
  return {
    'room.create': { auth: true, run: (params) => service.createRoom(params) },
    'room.settings': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({
        room_id: z.string(),
        name: z.unknown().optional(),
        goal: z.unknown().optional(),
        briefing: z.unknown().optional(),
        status: z.unknown().optional(),
        quiet_membership: z.unknown().optional(),
      }).strict().parse(params);
      return service.updateRoom(room_id, input);
    } },
    'room.briefing.role.set': { auth: true, run: (params) => {
      const { room_id, ...input } = RoleBriefingSetParams.parse(params);
      return service.setRoleBriefing(room_id, input);
    } },
    'room.briefing.role.delete': { auth: true, run: (params) => {
      const { room_id, ...input } = RoleBriefingDeleteParams.parse(params);
      return service.deleteRoleBriefing(room_id, input);
    } },
    'room.invite': { auth: true, run: (params) => {
      const { room_id, ...input } = z.object({
        room_id: z.string(), mode: z.unknown(), role: z.unknown().optional(), min_accepts: z.unknown(),
      }).strict().parse(params);
      return service.createInvite(room_id, input);
    } },
    'room.participant.remove': { auth: true, run: (params) => {
      const { room_id, ...input } = ParticipantRemoveParams.parse(params);
      return service.removeParticipant(room_id, input);
    } },
    'room.participant.replace': { auth: true, run: (params) => {
      const { room_id, ...input } = ParticipantReplaceParams.parse(params);
      return service.replaceParticipant(room_id, input);
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

/** Secret-bearing mutation routes are deliberately available only to the Unix dispatcher. */
export function createPrivateServiceRoutes(service: RoomServiceApi): AuthenticatedRouteTable {
  return {
    'room.accept': { auth: true, run: (params) => {
      const { room_id, ...input } = ExternalInviteAcceptParams.parse(params);
      return service.acceptExternalInvite(room_id, input);
    } },
  } satisfies AuthenticatedRouteTable;
}

export interface TransportServerOptions {
  socketPath: string;
  rest: { enabled: boolean; port: number };
  unixDispatcher: RpcDispatcher;
  restDispatcher: RpcDispatcher;
  staticHandler?: StaticWebHandler;
  fs?: typeof nodeFs;
  log?: (...parts: unknown[]) => void;
}

export class TransportServer {
  private readonly options: TransportServerOptions;
  private readonly fs: typeof nodeFs;
  private readonly staticHandler: StaticWebHandler;
  private readonly sockets = new Set<net.Socket>();
  private readonly httpSockets = new Set<net.Socket>();
  private readonly httpPhases = new Map<net.Socket, HttpSocketPhase>();
  private readonly activeHttpResponses = new Map<net.Socket, number>();
  private readonly requests = new Set<Promise<void>>();
  private unixServer?: net.Server;
  private httpServer?: http.Server;
  private startWork?: Promise<void>;
  private stopWork?: Promise<void>;
  private ownedSocket?: { dev: number; ino: number; uid: number };
  private privateSocketPath?: string;
  private protectedPrivateReplacement?: ProtectedPath;

  constructor(options: TransportServerOptions) {
    this.options = options;
    this.fs = options.fs ?? nodeFs;
    this.staticHandler = options.staticHandler ?? createStaticWebHandler(new Map());
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
    await this.cleanupStalePrivateSockets();
    const unix = net.createServer((socket) => this.handleUnix(socket));
    this.unixServer = unix;
    const privateSocketPath = `${this.options.socketPath}.private-${process.pid}-${randomBytes(6).toString('hex')}`;
    this.privateSocketPath = privateSocketPath;
    try {
      await listen(unix, privateSocketPath);
      this.fs.chmodSync(privateSocketPath, 0o600);
      this.ownedSocket = this.captureOwnedSocket(privateSocketPath);
      this.publishPrivateSocket(privateSocketPath);
      if (this.options.rest.enabled) {
        const rest = http.createServer((request, response) => this.track(this.handleRest(request, response)));
        rest.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
        rest.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
        rest.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
        rest.on('connection', (socket) => {
          this.httpSockets.add(socket);
          this.httpPhases.set(socket, 'headers');
          socket.setTimeout(HTTP_KEEP_ALIVE_TIMEOUT_MS, () => socket.destroy());
          socket.on('close', () => {
            this.httpSockets.delete(socket);
            this.httpPhases.delete(socket);
          });
        });
        this.httpServer = rest;
        await listen(rest, this.options.rest.port, '127.0.0.1');
      }
    } catch (error) {
      const quarantined = this.quarantinePublicPath();
      await this.closeServers();
      const cleanupErrors: unknown[] = [];
      if (quarantined) {
        try { this.releaseQuarantinedPath(quarantined); } catch (caught) { cleanupErrors.push(caught); }
      }
      const protectedPrivate = this.protectedPrivateReplacement;
      this.protectedPrivateReplacement = undefined;
      if (protectedPrivate) {
        try { this.restoreProtectedPath(protectedPrivate); } catch (caught) { cleanupErrors.push(caught); }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'transport startup and ownership-safe cleanup failed');
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    this.stopWork ??= this.stopUnlocked();
    return this.stopWork;
  }

  private async stopUnlocked(): Promise<void> {
    for (const dispatcher of new Set([this.options.unixDispatcher, this.options.restDispatcher])) {
      dispatcher.beginShutdown();
    }
    const httpServer = this.httpServer;
    const quarantined = this.quarantinePublicPath();
    const closing = this.closeServers();
    for (const socket of this.sockets) socket.end();
    // Header/body readers and keep-alive sockets have not dispatched service
    // work and can be aborted immediately. Active operations keep their
    // connection until the complete response has been flushed.
    for (const socket of this.httpSockets) {
      if (!this.activeHttpResponses.has(socket)) socket.destroy();
    }
    await this.drainRequests();
    httpServer?.closeAllConnections?.();
    for (const socket of this.httpSockets) socket.destroy();
    for (const dispatcher of new Set([this.options.unixDispatcher, this.options.restDispatcher])) {
      await dispatcher.drain();
    }
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.httpSockets.clear();
    this.httpPhases.clear();
    this.activeHttpResponses.clear();
    await closing;
    if (quarantined) this.releaseQuarantinedPath(quarantined);
    this.ownedSocket = undefined;
    this.privateSocketPath = undefined;
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
        const operation = this.dispatchBytes(this.options.unixDispatcher, line).then((response) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
        });
        this.track(operation);
      }
    });
    socket.on('error', (error) => this.options.log?.('Unix transport socket error:', error));
  }

  private async handleRest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const socket = request.socket;
    this.httpPhases.set(socket, 'body');
    let responseActive = false;
    const activateResponse = (): void => {
      if (responseActive) return;
      responseActive = true;
      this.activeHttpResponses.set(socket, (this.activeHttpResponses.get(socket) ?? 0) + 1);
      this.httpPhases.set(socket, 'response');
      socket.setTimeout(0);
    };
    try {
      if (request.url !== '/rpc') {
        if (request.method === 'GET') {
          activateResponse();
          if (await this.staticHandler(request, response)) return;
        }
        activateResponse();
        sendJson(response, 404, errorResponse(null, 'not_found', 'not found'));
        request.resume();
        return await responseFinished(response);
      }
      if (request.method !== 'POST') {
        activateResponse();
        sendJson(response, 404, errorResponse(null, 'not_found', 'not found'));
        request.resume();
        return await responseFinished(response);
      }
      if (!isJsonMediaType(request.headers['content-type'])) {
        activateResponse();
        sendJson(response, 415, errorResponse(null, 'unsupported_media_type', 'application/json required'));
        request.resume();
        return await responseFinished(response);
      }
      if (!this.safeRestOrigin(request)) {
        activateResponse();
        sendJson(response, 403, errorResponse(null, 'forbidden', 'forbidden request origin'));
        request.resume();
        return await responseFinished(response);
      }
      const declared = request.headers['content-length'];
      if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
        activateResponse();
        sendJson(response, 413, errorResponse(null, 'request_too_large', 'request exceeds 1 MiB'));
        request.resume();
        return await responseFinished(response);
      }
      const body = await readBody(request, MAX_REQUEST_BYTES);
      if (!body.ok) {
        activateResponse();
        sendJson(response, 413, errorResponse(null, 'request_too_large', 'request exceeds 1 MiB'));
        return await responseFinished(response);
      }
      activateResponse();
      const rpc = await this.dispatchBytes(this.options.restDispatcher, body.bytes);
      const status = 'error' in rpc
        ? rpc.error.code === 'method_not_found' ? 404
          : rpc.error.code === 'internal' ? 500 : 400
        : 200;
      sendJson(response, status, rpc);
      await responseFinished(response);
    } finally {
      if (responseActive) {
        const remaining = (this.activeHttpResponses.get(socket) ?? 1) - 1;
        if (remaining > 0) this.activeHttpResponses.set(socket, remaining);
        else this.activeHttpResponses.delete(socket);
      }
      if (!socket.destroyed && !this.activeHttpResponses.has(socket)) {
        this.httpPhases.set(socket, 'idle');
        socket.setTimeout(HTTP_KEEP_ALIVE_TIMEOUT_MS);
      }
    }
  }

  private safeRestOrigin(request: http.IncomingMessage): boolean {
    const port = this.restAddress.port;
    const authority = request.headers.host;
    if (authority !== `127.0.0.1:${port}` && authority !== `localhost:${port}`) return false;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${authority}`) return false;
    return request.headers['sec-fetch-site']?.toLowerCase() !== 'cross-site';
  }

  private async dispatchBytes(dispatcher: RpcDispatcher, bytes: Uint8Array): Promise<RpcResponse> {
    let input: unknown;
    try { input = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch {
      return errorResponse(null, 'invalid_json', 'invalid JSON');
    }
    return dispatcher.dispatch(input);
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

  private async drainRequests(): Promise<void> {
    while (this.requests.size > 0) await Promise.allSettled([...this.requests]);
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

  private captureOwnedSocket(path: string): { dev: number; ino: number; uid: number } {
    const stat = this.fs.lstatSync(path);
    const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
      throw new Error('management socket is not an owned 0600 Unix socket');
    }
    return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
  }

  private async closeServers(): Promise<void> {
    await Promise.allSettled([
      closeServer(this.httpServer),
      closeServer(this.unixServer),
    ]);
    this.httpServer = undefined;
    this.unixServer = undefined;
  }

  private publishPrivateSocket(privateSocketPath: string): void {
    try {
      // link(2) is an atomic no-replace publication within the state
      // directory: an occupant appearing at the final instant wins EEXIST and
      // is never overwritten.
      this.fs.linkSync(privateSocketPath, this.options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('management socket path was occupied during atomic publication', { cause: error });
      }
      throw error;
    }
    const owned = this.ownedSocket;
    const published = this.fs.lstatSync(this.options.socketPath);
    if (!owned || published.dev !== owned.dev || published.ino !== owned.ino
      || published.uid !== owned.uid || (published.mode & 0o777) !== 0o600
      || !published.isSocket() || published.isSymbolicLink()) {
      throw new Error('management socket changed during private publication');
    }
    const privateSocket = this.fs.lstatSync(privateSocketPath);
    if (privateSocket.dev !== owned.dev || privateSocket.ino !== owned.ino
      || privateSocket.uid !== owned.uid || !privateSocket.isSocket() || privateSocket.isSymbolicLink()) {
      throw new Error('private management socket changed during publication');
    }
    const quarantined = this.quarantinePath(privateSocketPath, 'private-alias');
    const moved = this.fs.lstatSync(quarantined.path);
    if (moved.dev === owned.dev && moved.ino === owned.ino && moved.uid === owned.uid
      && moved.isSocket() && !moved.isSymbolicLink()) {
      // POSIX has no conditional unlink-by-inode. The unpredictable alias is
      // therefore the terminal safe residue for this inert owned socket.
      return;
    }
    this.protectedPrivateReplacement = quarantined;
    throw new Error(`private management socket changed during removal; replacement protected at ${quarantined.path}`);
  }

  private async cleanupStalePrivateSockets(): Promise<void> {
    // CoworkDaemon invokes transport startup only while holding the exclusive
    // daemon lock. Bound the number of stale path mutations per boot and never
    // remove a non-socket, symlink, foreign owner, or inode that changed after
    // inspection.
    const directory = dirname(this.options.socketPath);
    const prefix = `${basename(this.options.socketPath)}.private-`;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const candidates = this.fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .slice(0, MAX_STALE_PRIVATE_SOCKET_CLEANUP);
    for (const name of candidates) {
      const path = join(directory, name);
      let observed: nodeFs.Stats;
      try { observed = this.fs.lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!observed.isSocket() || observed.isSymbolicLink()
        || (uid !== undefined && observed.uid !== uid)) continue;
      if (await unixSocketIsLive(path)) continue;
      let quarantined: ProtectedPath;
      try { quarantined = this.quarantinePath(path, 'stale-private'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const moved = this.fs.lstatSync(quarantined.path);
      if (moved.dev === observed.dev && moved.ino === observed.ino && moved.uid === observed.uid
        && moved.isSocket() && !moved.isSymbolicLink()) {
        // Do not unlink even an inspected owned socket: a final-instant name
        // substitution cannot be detected atomically by Node/POSIX.
        continue;
      }
      this.restoreProtectedPath(quarantined);
      throw new Error(`stale private socket changed during cleanup; replacement preserved with safe residue at ${quarantined.path}`);
    }
  }

  private quarantinePath(target: string, label: string): ProtectedPath {
    // Residues deliberately do not match the `.private-*` discovery prefix.
    // One daemon lifecycle creates at most one private-alias residue and one
    // public residue; a stale pass creates at most 32. They remain inert until
    // the configured state directory is removed offline (or OS-cleared when
    // callers deliberately place that directory in a runtime filesystem).
    const path = `${this.options.socketPath}.safe-residue-${label}-${process.pid}-${randomBytes(6).toString('hex')}`;
    this.fs.renameSync(target, path);
    const moved = this.fs.lstatSync(path);
    return { target, path, dev: moved.dev, ino: moved.ino };
  }

  private restoreProtectedPath(protectedPath: ProtectedPath): void {
    const moved = this.fs.lstatSync(protectedPath.path);
    if (moved.dev !== protectedPath.dev || moved.ino !== protectedPath.ino) {
      throw new Error(`protected management path changed; safe residue remains at ${protectedPath.path}`);
    }
    try {
      // Atomic no-replace restoration. Keep the collision-resistant alias as
      // residue: deleting a non-owned inode by pathname would reintroduce the
      // same final-instant substitution race this path is containing.
      this.fs.linkSync(protectedPath.path, protectedPath.target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`management path reoccupied; replacement remains at safe residue ${protectedPath.path}`);
      }
      throw new Error(`failed to restore protected management path; safe residue remains at ${protectedPath.path}`, { cause: error });
    }
    const restored = this.fs.lstatSync(protectedPath.target);
    if (restored.dev !== protectedPath.dev || restored.ino !== protectedPath.ino) {
      throw new Error(`restored management path changed; safe residue remains at ${protectedPath.path}`);
    }
  }

  private quarantinePublicPath(): { path: string; dev: number; ino: number; owned: boolean } | undefined {
    const quarantinePath = `${this.options.socketPath}.replacement-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      this.fs.renameSync(this.options.socketPath, quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    // Inspect only after the atomic move. If the public path changed just
    // before rename, this is the inode actually displaced by shutdown.
    const moved = this.fs.lstatSync(quarantinePath);
    const owned = this.ownedSocket;
    return {
      path: quarantinePath,
      dev: moved.dev,
      ino: moved.ino,
      owned: owned !== undefined && moved.dev === owned.dev && moved.ino === owned.ino,
    };
  }

  private releaseQuarantinedPath(quarantined: { path: string; dev: number; ino: number; owned: boolean }): void {
    const moved = this.fs.lstatSync(quarantined.path);
    if (moved.dev !== quarantined.dev || moved.ino !== quarantined.ino) {
      throw new Error(`quarantined management path changed; safe residue remains at ${quarantined.path}`);
    }
    if (quarantined.owned) {
      // Keep exact owned socket inodes as terminal safe residues. Removing a
      // pathname after inspection would permit an undetectable final swap.
      return;
    }
    try {
      this.fs.lstatSync(this.options.socketPath);
      throw new Error(`management path reoccupied; replacement preserved as safe residue at ${quarantined.path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      this.fs.renameSync(quarantined.path, this.options.socketPath);
    } catch (error) {
      throw new Error(`failed to restore management path; safe residue remains at ${quarantined.path}`, { cause: error });
    }
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

function isJsonMediaType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json'
    || (mediaType?.startsWith('application/') === true && mediaType.endsWith('+json'));
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
    let idle = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy(new Error('request body timed out'));
      rejectBody(new Error('request body timed out'));
    }, HTTP_BODY_IDLE_TIMEOUT_MS);
    const resetIdle = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (settled) return;
        settled = true;
        request.destroy(new Error('request body timed out'));
        rejectBody(new Error('request body timed out'));
      }, HTTP_BODY_IDLE_TIMEOUT_MS);
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      resetIdle();
      size += chunk.length;
      if (size > limit) {
        settled = true;
        clearTimeout(idle);
        request.resume();
        resolveBody({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(idle);
        resolveBody({ ok: true, bytes: Buffer.concat(chunks, size) });
      }
    });
    request.on('aborted', () => {
      if (!settled) {
        settled = true;
        clearTimeout(idle);
        rejectBody(new Error('request body aborted'));
      }
    });
    request.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(idle);
        rejectBody(error);
      }
    });
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

function responseFinished(response: http.ServerResponse): Promise<void> {
  if (response.writableFinished || response.destroyed) return Promise.resolve();
  return new Promise((resolveResponse, rejectResponse) => {
    response.once('finish', resolveResponse);
    response.once('close', resolveResponse);
    response.once('error', rejectResponse);
  });
}
