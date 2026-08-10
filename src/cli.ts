#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { connect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureRuntimeState, loadConfig, type CoworkConfig } from './config.ts';
import { MAX_MANAGEMENT_RESPONSE_BYTES } from './contracts.ts';

const EXIT = {
  success: 0,
  webDisabled: 1,
  usage: 2,
  notFound: 3,
  invalidState: 4,
  unauthorized: 5,
  daemonUnavailable: 6,
  internal: 7,
} as const;
const RPC_TIMEOUT_MS = 10_000;
export const NATIVE_RPC_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 30_000;
const WEB_READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 12_000;
const SELF = fileURLToPath(import.meta.url);
const SYSTEMD_UNIT = 'ours-cowork.service';
const LAUNCHD_LABEL = 'network.ours.cowork';

interface RpcResponse {
  version: 1;
  id: string | number | null;
  result?: unknown;
  error?: { code: string; message: string };
}

interface DaemonControlStatus {
  version: 1;
  protocol: 'cowork-supervisor-control';
  running: true;
  session: string;
}

type ControlProbe =
  | { kind: 'running'; status: DaemonControlStatus }
  | { kind: 'absent' }
  | { kind: 'occupied' };

class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;

  constructor(exitCode: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

class RpcTransportError extends CliError {
  readonly connected: boolean;

  constructor(connected: boolean, message: string, options?: ErrorOptions) {
    super(EXIT.daemonUnavailable, 'daemon_unavailable', message, options);
    this.name = 'RpcTransportError';
    this.connected = connected;
  }
}

const NATIVE_MUTATION_METHODS = new Set([
  'room.create',
  'room.invite',
  'room.revoke',
  'room.message',
  'room.close',
  'room.recover',
  'room.recover.confirm',
  'room.participant.remove',
  'room.participant.replace',
]);

export function rpcTimeoutForMethod(method: string): number {
  return NATIVE_MUTATION_METHODS.has(method) ? NATIVE_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS;
}

interface Output {
  json: boolean;
  success(value: unknown, human?: string): void;
  fail(error: CliError): void;
}

function createOutput(json: boolean): Output {
  return {
    json,
    success(value, human) {
      if (json) process.stdout.write(`${JSON.stringify({ ok: true, result: value })}\n`);
      else if (human !== undefined) process.stdout.write(`${human}${human.endsWith('\n') ? '' : '\n'}`);
      else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
    fail(error) {
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })}\n`);
      else process.stderr.write(`ours-cowork: ${error.message}\n`);
    },
  };
}

function usage(): string {
  return `ours-cowork — standalone mission-room daemon

Usage:
  ours-cowork [--json] start|stop|restart|status|serve|web
  ours-cowork [--json] install-service|uninstall-service
  ours-cowork [--json] room <command> [arguments]
  ours-cowork [--json] docs [topic]

Room commands:
  create --goal <text> --briefing <text> [--anonymous] [--quiet-membership]
  settings <room-id> [--goal <text>] [--briefing <text>] [--status <text>] [--quiet-membership true|false]
  role-briefing <room-id> --role <label> (--text <text> | --delete)
  invite <room-id> [--role <label>] [--mode one_time|public] [--min-accepts <n>]
  revoke <room-id> <invite-id>
  remove <room-id> <participant> [--silent]
  replace <room-id> <participant> [--mode one_time|public] [--min-accepts <n>] [--silent]
  list
  show <room-id>
  participants <room-id>
  history <room-id> [--after <seq>] [--limit <n>] [--view operator|participant]
  message <room-id> --text <text>
  close <room-id>
  delete <room-id> --yes
  recover <room-id> [--confirm <old-invite-id> <new-invite-id>]

Run ‘ours-cowork docs’ for the offline documentation index.`;
}

function usageError(message: string): never {
  throw new CliError(EXIT.usage, 'usage', `${message}\n\n${usage()}`);
}

interface ParsedOptions {
  positionals: string[];
  values: Record<string, string>;
  booleans: Set<string>;
}

function parseOptions(
  args: string[],
  valueFlags: readonly string[] = [],
  booleanFlags: readonly string[] = [],
): ParsedOptions {
  const allowedValues = new Set(valueFlags);
  const allowedBooleans = new Set(booleanFlags);
  const values: Record<string, string> = Object.create(null);
  const booleans = new Set<string>();
  const positionals: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (optionsEnded || !token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals < 0 ? token : token.slice(0, equals);
    const inlineValue = equals < 0 ? undefined : token.slice(equals + 1);
    if (allowedBooleans.has(flag)) {
      if (inlineValue !== undefined) usageError(`${flag} does not accept a value`);
      if (booleans.has(flag)) usageError(`duplicate option ${flag}`);
      booleans.add(flag);
      continue;
    }
    if (!allowedValues.has(flag)) usageError(`unknown or not allowed option ${flag}`);
    if (Object.hasOwn(values, flag)) usageError(`duplicate option ${flag}`);
    if (inlineValue !== undefined) {
      values[flag] = inlineValue;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      usageError(`${flag} requires a value; use ${flag}=VALUE when VALUE begins with --`);
    }
    values[flag] = value;
    index += 1;
  }
  return { positionals, values, booleans };
}

function exactPositionals(parsed: ParsedOptions, count: number, command: string): string[] {
  if (parsed.positionals.length !== count) usageError(`${command} requires ${count} positional argument${count === 1 ? '' : 's'}`);
  return parsed.positionals;
}

function requiredFlag(parsed: ParsedOptions, flag: string, command: string): string {
  const value = parsed.values[flag];
  if (value === undefined) usageError(`${command} requires ${flag}`);
  return value;
}

function parseInteger(value: string, flag: string, minimum: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) usageError(`${flag} must be a decimal integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) usageError(`${flag} must be at least ${minimum}`);
  return number;
}

function loadCliConfig(): CoworkConfig {
  try {
    return loadConfig();
  } catch (error) {
    throw new CliError(EXIT.internal, 'internal', error instanceof Error ? error.message : 'failed to load config', { cause: error });
  }
}

function roomRequest(command: string | undefined, args: string[]): { method: string; params: Record<string, unknown> } {
  if (!command) usageError('room requires a command');
  switch (command) {
    case 'create': {
      const parsed = parseOptions(args, ['--goal', '--briefing'], ['--anonymous', '--quiet-membership']);
      exactPositionals(parsed, 0, 'room create');
      return { method: 'room.create', params: {
        goal: requiredFlag(parsed, '--goal', 'room create'),
        briefing: requiredFlag(parsed, '--briefing', 'room create'),
        ...(parsed.booleans.has('--anonymous') ? { anonymous: true } : {}),
        ...(parsed.booleans.has('--quiet-membership') ? { quiet_membership: true } : {}),
      } };
    }
    case 'settings': {
      const parsed = parseOptions(args, ['--goal', '--briefing', '--status', '--quiet-membership']);
      const [roomId] = exactPositionals(parsed, 1, 'room settings');
      const params: Record<string, unknown> = { room_id: roomId };
      for (const [flag, key] of [['--goal', 'goal'], ['--briefing', 'briefing'], ['--status', 'status']] as const) {
        if (parsed.values[flag] !== undefined) params[key] = parsed.values[flag];
      }
      const quiet = parsed.values['--quiet-membership'];
      if (quiet !== undefined) {
        if (quiet !== 'true' && quiet !== 'false') usageError('--quiet-membership must be true or false');
        params.quiet_membership = quiet === 'true';
      }
      if (Object.keys(params).length === 1) usageError('room settings requires at least one setting option');
      return { method: 'room.settings', params };
    }
    case 'role-briefing': {
      const parsed = parseOptions(args, ['--role', '--text'], ['--delete']);
      const [roomId] = exactPositionals(parsed, 1, 'room role-briefing');
      const role = requiredFlag(parsed, '--role', 'room role-briefing');
      if (parsed.booleans.has('--delete')) {
        if (parsed.values['--text'] !== undefined) usageError('room role-briefing takes either --text or --delete');
        return { method: 'room.briefing.role.delete', params: { room_id: roomId, role } };
      }
      return { method: 'room.briefing.role.set', params: {
        room_id: roomId,
        role,
        text: requiredFlag(parsed, '--text', 'room role-briefing'),
      } };
    }
    case 'invite': {
      const parsed = parseOptions(args, ['--mode', '--role', '--min-accepts']);
      const [roomId] = exactPositionals(parsed, 1, 'room invite');
      const mode = parsed.values['--mode'] ?? 'one_time';
      if (mode !== 'one_time' && mode !== 'public') usageError('--mode must be one_time or public');
      const minimum = parsed.values['--min-accepts'] === undefined
        ? 1
        : parseInteger(parsed.values['--min-accepts'], '--min-accepts', 1);
      if (mode === 'one_time' && minimum !== 1) usageError('one_time invites require --min-accepts 1');
      return { method: 'room.invite', params: {
        room_id: roomId,
        mode,
        // Omitted role = the built-in "Participant" role (daemon-side default).
        ...(parsed.values['--role'] === undefined ? {} : { role: parsed.values['--role'] }),
        min_accepts: minimum,
      } };
    }
    case 'remove': {
      const parsed = parseOptions(args, [], ['--silent']);
      const [roomId, participant] = exactPositionals(parsed, 2, 'room remove');
      return { method: 'room.participant.remove', params: {
        room_id: roomId,
        participant,
        ...(parsed.booleans.has('--silent') ? { notify: false } : {}),
      } };
    }
    case 'replace': {
      const parsed = parseOptions(args, ['--mode', '--min-accepts'], ['--silent']);
      const [roomId, participant] = exactPositionals(parsed, 2, 'room replace');
      const mode = parsed.values['--mode'];
      if (mode !== undefined && mode !== 'one_time' && mode !== 'public') usageError('--mode must be one_time or public');
      return { method: 'room.participant.replace', params: {
        room_id: roomId,
        participant,
        ...(mode === undefined ? {} : { mode }),
        ...(parsed.values['--min-accepts'] === undefined
          ? {}
          : { min_accepts: parseInteger(parsed.values['--min-accepts'], '--min-accepts', 1) }),
        ...(parsed.booleans.has('--silent') ? { notify: false } : {}),
      } };
    }
    case 'revoke': {
      const parsed = parseOptions(args);
      const [roomId, inviteId] = exactPositionals(parsed, 2, 'room revoke');
      return { method: 'room.revoke', params: { room_id: roomId, invite_id: inviteId } };
    }
    case 'list': {
      exactPositionals(parseOptions(args), 0, 'room list');
      return { method: 'room.list', params: {} };
    }
    case 'show':
    case 'participants':
    case 'close': {
      const [roomId] = exactPositionals(parseOptions(args), 1, `room ${command}`);
      return { method: `room.${command}`, params: { room_id: roomId } };
    }
    case 'history': {
      const parsed = parseOptions(args, ['--after', '--limit', '--view']);
      const [roomId] = exactPositionals(parsed, 1, 'room history');
      const params: Record<string, unknown> = { room_id: roomId };
      if (parsed.values['--after'] !== undefined) params.after = parseInteger(parsed.values['--after'], '--after', 0);
      if (parsed.values['--limit'] !== undefined) params.limit = parseInteger(parsed.values['--limit'], '--limit', 1);
      const view = parsed.values['--view'];
      if (view !== undefined) {
        if (view !== 'operator' && view !== 'participant') usageError('--view must be operator or participant');
        params.view = view;
      }
      return { method: 'room.history', params };
    }
    case 'message': {
      const parsed = parseOptions(args, ['--text']);
      const [roomId] = exactPositionals(parsed, 1, 'room message');
      return { method: 'room.message', params: {
        room_id: roomId,
        text: requiredFlag(parsed, '--text', 'room message'),
      } };
    }
    case 'delete': {
      const parsed = parseOptions(args, [], ['--yes']);
      const [roomId] = exactPositionals(parsed, 1, 'room delete');
      if (!parsed.booleans.has('--yes')) usageError('room delete is destructive and requires --yes');
      return { method: 'room.delete', params: { room_id: roomId, confirm: true } };
    }
    case 'recover': {
      const parsed = parseOptions(args, ['--confirm']);
      const [roomId, confirmInviteId] = parsed.positionals;
      if (parsed.values['--confirm'] !== undefined) {
        if (parsed.positionals.length !== 2) usageError('room recover --confirm requires <room-id> --confirm <old-invite-id> <new-invite-id>');
        return { method: 'room.recover.confirm', params: {
          room_id: roomId,
          recovery_of: parsed.values['--confirm'],
          invite_id: confirmInviteId,
        } };
      }
      exactPositionals(parsed, 1, 'room recover');
      return { method: 'room.recover', params: { room_id: roomId } };
    }
    default:
      usageError(`unknown room command: ${command}`);
  }
}

export function rpcCall(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<unknown> {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const request = `${JSON.stringify({ version: 1, id, method, params })}\n`;
  return new Promise((resolveCall, rejectCall) => {
    const socket = connect(socketPath);
    let bytes = '';
    let size = 0;
    let settled = false;
    let connected = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finishError = (error: CliError): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      socket.destroy();
      rejectCall(error);
    };
    timer = setTimeout(() => finishError(new RpcTransportError(connected, 'daemon did not answer the management socket')), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      connected = true;
      socket.write(request);
    });
    socket.on('data', (chunk: string) => {
      if (settled) return;
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > MAX_MANAGEMENT_RESPONSE_BYTES) {
        finishError(new CliError(EXIT.internal, 'internal', 'daemon response exceeded 4 MiB'));
        return;
      }
      bytes += chunk;
      const newline = bytes.indexOf('\n');
      if (newline < 0) return;
      const line = bytes.slice(0, newline);
      if (bytes.slice(newline + 1).trim() !== '') {
        finishError(new CliError(EXIT.internal, 'internal', 'daemon returned more than one response'));
        return;
      }
      let response: RpcResponse;
      try { response = JSON.parse(line) as RpcResponse; }
      catch { finishError(new CliError(EXIT.internal, 'internal', 'daemon returned malformed JSON')); return; }
      if (response.version !== 1 || response.id !== id
        || (response.error === undefined) === (response.result === undefined)) {
        finishError(new CliError(EXIT.internal, 'internal', 'daemon returned an invalid RPC response'));
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      socket.destroy();
      if (response.error) rejectCall(rpcError(response.error));
      else resolveCall(response.result);
    });
    socket.once('end', () => {
      if (!settled) finishError(new CliError(EXIT.internal, 'internal', 'daemon closed without a complete response'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      const unauthorized = error.code === 'EACCES' || error.code === 'EPERM';
      finishError(unauthorized
        ? new CliError(EXIT.unauthorized, 'unauthorized', 'management socket access denied', { cause: error })
        : new RpcTransportError(connected, 'cowork daemon is unavailable', { cause: error }));
    });
  });
}

function rpcError(error: { code: string; message: string }): CliError {
  const exitCode = error.code === 'not_found' ? EXIT.notFound
    : error.code === 'invalid_state' || error.code === 'invalid_params' || error.code === 'invalid_request' ? EXIT.invalidState
      : error.code === 'unauthorized' ? EXIT.unauthorized
        : error.code === 'shutting_down' ? EXIT.daemonUnavailable
          : EXIT.internal;
  return new CliError(exitCode, error.code, error.message);
}

function isDaemonControlStatus(value: unknown): value is DaemonControlStatus {
  if (value === null || typeof value !== 'object') return false;
  const status = value as Record<string, unknown>;
  return Object.keys(status).length === 4
    && status.version === 1
    && status.protocol === 'cowork-supervisor-control'
    && status.running === true
    && typeof status.session === 'string'
    && /^[0-9a-f]{32}$/.test(status.session);
}

async function probeDaemon(config: CoworkConfig, timeoutMs = RPC_TIMEOUT_MS): Promise<ControlProbe> {
  try {
    const result = await rpcCall(join(config.stateDir, 'management.sock'), 'daemon.status', {}, timeoutMs);
    return isDaemonControlStatus(result) ? { kind: 'running', status: result } : { kind: 'occupied' };
  } catch (error) {
    if (error instanceof RpcTransportError) return error.connected ? { kind: 'occupied' } : { kind: 'absent' };
    if (error instanceof CliError && error.code === 'unauthorized') throw error;
    return { kind: 'occupied' };
  }
}

function socketOpen(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = connect(path);
    let finished = false;
    const done = (open: boolean): void => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function waitForOwnedDaemon(config: CoworkConfig, timeoutMs: number): Promise<DaemonControlStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeDaemon(config, Math.min(500, Math.max(1, deadline - Date.now())));
    if (probe.kind === 'running') return probe.status;
    await sleep(200);
  }
  return null;
}

async function startDaemon(config: CoworkConfig): Promise<{ started: boolean; alreadyRunning: boolean }> {
  const socketPath = join(config.stateDir, 'management.sock');
  const existing = await probeDaemon(config);
  if (existing.kind === 'running') return { started: false, alreadyRunning: true };
  if (existing.kind === 'occupied' || await socketOpen(socketPath)) {
    throw new CliError(EXIT.invalidState, 'invalid_state', 'management socket is occupied by an endpoint without cowork supervisor control');
  }
  ensureRuntimeState(config);
  const logPath = join(config.stateDir, 'daemon.log');
  const logFd = fs.openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(SELF, ['serve'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  if (!child.pid) throw new CliError(EXIT.internal, 'internal', 'failed to spawn cowork daemon');
  const ready = await waitForOwnedDaemon(config, START_TIMEOUT_MS);
  if (ready === null) {
    throw new CliError(EXIT.internal, 'internal', `daemon did not become ready; inspect ${logPath}`);
  }
  return { started: true, alreadyRunning: false };
}

interface WebCommandDependencies {
  ensureDaemon(config: CoworkConfig): Promise<{ started: boolean; alreadyRunning: boolean }>;
  waitForHttpReady(url: string): Promise<boolean>;
  openBrowser(url: string): void;
}

export function browserOpenCommand(url: string, platform = process.platform): { command: string; args: string[] } {
  if (platform === 'linux') return { command: 'xdg-open', args: [url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd.exe', args: ['/c', 'start', '', url] };
  throw new CliError(EXIT.internal, 'internal', `opening the web console is unsupported on ${platform}`);
}

function openBrowser(url: string): void {
  const { command, args } = browserOpenCommand(url);
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new CliError(EXIT.internal, 'internal', `failed to open the web console with ${command}`, { cause: result.error });
  }
}

function httpGetReady(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveReady) => {
    let response: http.IncomingMessage | undefined;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      deadline = undefined;
      request.removeListener('response', onResponse);
      request.removeListener('error', onRequestError);
      request.removeListener('timeout', onRequestTimeout);
      request.removeListener('close', onRequestClose);
      request.setTimeout(0);
      if (response) {
        response.removeListener('end', onResponseEnd);
        response.removeListener('error', onResponseError);
        response.removeListener('aborted', onResponseAborted);
        response.removeListener('close', onResponseClose);
        if (!response.destroyed) response.destroy();
      }
      if (!request.destroyed) request.destroy();
      resolveReady(ready);
    };
    const onRequestError = (): void => settle(false);
    const onRequestTimeout = (): void => settle(false);
    const onRequestClose = (): void => { if (!response) settle(false); };
    const onResponseEnd = (): void => settle(response?.complete === true && response.statusCode === 200);
    const onResponseError = (): void => settle(false);
    const onResponseAborted = (): void => settle(false);
    const onResponseClose = (): void => settle(response?.complete === true && response.statusCode === 200);
    const onResponse = (incoming: http.IncomingMessage): void => {
      if (settled) { incoming.destroy(); return; }
      response = incoming;
      incoming.once('end', onResponseEnd);
      incoming.once('error', onResponseError);
      incoming.once('aborted', onResponseAborted);
      incoming.once('close', onResponseClose);
      incoming.resume();
    };
    const request = http.get(url);
    request.once('response', onResponse);
    request.once('error', onRequestError);
    request.once('timeout', onRequestTimeout);
    request.once('close', onRequestClose);
    request.setTimeout(timeoutMs);
    deadline = setTimeout(() => settle(false), timeoutMs);
  });
}

export async function waitForHttpReadiness(url: string, timeoutMs = WEB_READY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    if (await httpGetReady(url, Math.min(500, remaining))) return true;
    await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
  }
  return false;
}

export async function openWebConsole(
  config: CoworkConfig,
  json: boolean,
  dependencies: WebCommandDependencies = {
    ensureDaemon: startDaemon,
    waitForHttpReady: waitForHttpReadiness,
    openBrowser,
  },
): Promise<{ url: string; opened: boolean }> {
  if (!config.rest.enabled) {
    throw new CliError(
      EXIT.webDisabled,
      'web_disabled',
      'web console is disabled (rest.enabled=false); enable it in cowork configuration and restart the daemon',
    );
  }
  const url = `http://127.0.0.1:${config.rest.port}/`;
  await dependencies.ensureDaemon(config);
  if (!await dependencies.waitForHttpReady(url)) {
    throw new CliError(EXIT.internal, 'internal', `web console did not become ready at ${url}`);
  }
  if (json) return { url, opened: false };
  dependencies.openBrowser(url);
  return { url, opened: true };
}

async function stopDaemon(config: CoworkConfig): Promise<{ stopped: boolean }> {
  const socketPath = join(config.stateDir, 'management.sock');
  const initial = await probeDaemon(config);
  if (initial.kind === 'absent') {
    if (await socketOpen(socketPath)) {
      throw new CliError(EXIT.invalidState, 'invalid_state', 'management socket is occupied by a non-cowork endpoint');
    }
    return { stopped: false };
  }
  if (initial.kind === 'occupied') {
    throw new CliError(EXIT.invalidState, 'invalid_state', 'management endpoint did not prove cowork supervisor control');
  }
  let response: unknown;
  try {
    response = await rpcCall(
      socketPath,
      'daemon.shutdown',
      { session: initial.status.session },
    );
  } catch (error) {
    throw new CliError(EXIT.invalidState, 'invalid_state', 'cowork daemon did not accept self-shutdown', { cause: error });
  }
  if (response === null || typeof response !== 'object'
    || Object.keys(response).length !== 2
    || (response as Record<string, unknown>).accepted !== true
    || (response as Record<string, unknown>).session !== initial.status.session) {
    throw new CliError(EXIT.invalidState, 'invalid_state', 'cowork daemon returned an invalid self-shutdown receipt');
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const observed = await probeDaemon(config, Math.min(500, Math.max(1, deadline - Date.now())));
    if (observed.kind === 'running' && observed.status.session !== initial.status.session) {
      return { stopped: true };
    }
    if (observed.kind === 'absent'
      && !await socketOpen(socketPath, Math.min(500, Math.max(1, deadline - Date.now())))) {
      return { stopped: true };
    }
    await sleep(100);
  }
  throw new CliError(EXIT.invalidState, 'invalid_state', 'cowork control session remained live after bounded self-shutdown');
}

function serviceEnvironment(config: CoworkConfig): Record<string, string> {
  return {
    OURS_COWORK_BROKER_URL: config.brokerUrl,
    OURS_COWORK_STATE_DIR: config.stateDir,
    ...(config.rest.enabled ? { OURS_COWORK_REST_PORT: String(config.rest.port) } : {}),
  };
}

function validateServiceConfiguration(config: CoworkConfig): void {
  const values = { cowork_cli: SELF, ...serviceEnvironment(config) };
  for (const [label, value] of Object.entries(values)) {
    if (/[\x00-\x1f\x7f-\x9f]/.test(value)) {
      throw new CliError(EXIT.invalidState, 'invalid_state', `${label} contains a control character unsafe for a service definition`);
    }
  }
}

/** Quote a general systemd value and suppress unit/environment expansion. */
function systemdValueQuote(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', '$$')}"`;
}

/**
 * Quote ExecStart argv[0]. systemd applies % specifiers there but does not
 * perform $ variable expansion on the executable. A literal quote is not a
 * legal systemd executable name even after syntax unquoting, so fail closed.
 */
function systemdExecutableQuote(value: string): string {
  if (value.includes('"') || /[\0\n\r]/.test(value)) {
    throw new CliError(EXIT.invalidState, 'invalid_state', 'cowork CLI path contains a character unsupported by systemd ExecStart');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('%', '%%')}"`;
}

function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function runTool(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0;
}

function installSystemd(config: CoworkConfig): string {
  validateServiceConfiguration(config);
  const path = systemdUnitPath();
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const environment = Object.entries(serviceEnvironment(config))
    .map(([key, value]) => `Environment=${systemdValueQuote(`${key}=${value}`)}`)
    .join('\n');
  const unit = `[Unit]
Description=ours-cowork standalone mission-room daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdExecutableQuote(SELF)} serve
${environment}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(path, unit, { mode: 0o600 });
  if (!runTool('systemctl', ['--user', 'daemon-reload'])
    || !runTool('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])) {
    throw new CliError(EXIT.internal, 'internal', 'failed to enable the systemd user service');
  }
  // Linger is best-effort because some workstation installs deliberately omit loginctl.
  runTool('loginctl', ['enable-linger', userInfo().username]);
  return path;
}

function uninstallSystemd(): string {
  const path = systemdUnitPath();
  if (!runTool('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])) {
    throw new CliError(EXIT.internal, 'internal', `failed to stop/disable ${SYSTEMD_UNIT}; service definition retained at ${path}`);
  }
  fs.rmSync(path, { force: true });
  if (!runTool('systemctl', ['--user', 'daemon-reload'])) {
    throw new CliError(EXIT.internal, 'internal', 'failed to reload systemd after uninstall');
  }
  return path;
}

function installLaunchd(config: CoworkConfig): string {
  validateServiceConfiguration(config);
  const path = launchdPlistPath();
  const logPath = join(config.stateDir, 'daemon.log');
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const environment = Object.entries(serviceEnvironment(config))
    .map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(SELF)}</string><string>serve</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${environment}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`;
  fs.writeFileSync(path, plist, { mode: 0o600 });
  runTool('launchctl', ['unload', path]);
  if (!runTool('launchctl', ['load', '-w', path])) {
    throw new CliError(EXIT.internal, 'internal', 'failed to load the launchd agent');
  }
  return path;
}

function uninstallLaunchd(): string {
  const path = launchdPlistPath();
  if (!runTool('launchctl', ['unload', path])) {
    throw new CliError(EXIT.internal, 'internal', `failed to unload ${LAUNCHD_LABEL}; service definition retained at ${path}`);
  }
  fs.rmSync(path, { force: true });
  return path;
}

function docsDirectory(): string {
  return fileURLToPath(new URL('../docs/', import.meta.url));
}

const DOC_TOPICS: Readonly<Record<string, string>> = Object.freeze({
  prerequisites: '01-prerequisites.md',
  installation: '02-installation.md',
  configuration: '03-configuration.md',
  lifecycle: '04-daemon-lifecycle.md',
  rooms: '05-room-workflow.md',
  invites: '06-invites.md',
  messaging: '07-messaging-history.md',
  'backup-restore': '08-backup-restore.md',
  services: '09-service-management.md',
  limitations: '10-limitations.md',
  web: '11-web-console.md',
});

function readDocs(topic: string | undefined): { topic: string; text: string } {
  if (topic === undefined) {
    const lines = ['ours-cowork offline documentation', '', ...Object.keys(DOC_TOPICS).map((name) => `  ${name}`), '', 'Usage: ours-cowork docs <topic>'];
    return { topic: 'index', text: lines.join('\n') };
  }
  const file = DOC_TOPICS[topic];
  if (!file) usageError(`unknown docs topic: ${topic}`);
  try { return { topic, text: fs.readFileSync(join(docsDirectory(), file), 'utf8') }; }
  catch (error) { throw new CliError(EXIT.internal, 'internal', `offline documentation is missing: ${file}`, { cause: error }); }
}

async function readHistoryPages(
  socketPath: string,
  params: Record<string, unknown>,
): Promise<unknown[]> {
  const requested = typeof params.limit === 'number' ? params.limit : Number.MAX_SAFE_INTEGER;
  let after = typeof params.after === 'number' ? params.after : 0;
  const records: unknown[] = [];
  while (records.length < requested) {
    const remaining = requested - records.length;
    const pageParams = { ...params, after, ...(remaining < Number.MAX_SAFE_INTEGER ? { limit: remaining } : {}) };
    const page = await rpcCall(
      socketPath,
      'room.history',
      pageParams,
      rpcTimeoutForMethod('room.history'),
    );
    if (!Array.isArray(page)) {
      throw new CliError(EXIT.internal, 'internal', 'daemon returned an invalid history page');
    }
    if (page.length === 0) break;
    for (const record of page) {
      const seq = record !== null && typeof record === 'object'
        ? (record as { seq?: unknown }).seq
        : undefined;
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= after) {
        throw new CliError(EXIT.internal, 'internal', 'daemon returned a non-progressing history page');
      }
      after = seq;
      records.push(record);
      if (records.length === requested) break;
    }
  }
  return records;
}

async function execute(args: string[], output: Output): Promise<void> {
  const command = args[0] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    if (args.length !== 1 && args.length !== 0) usageError('help takes no arguments');
    output.success({ usage: usage() }, usage());
    return;
  }
  if (command === 'docs') {
    if (args.length > 2) usageError('docs accepts at most one topic');
    const document = readDocs(args[1]);
    output.success(document, document.text);
    return;
  }
  if (command === 'room') {
    const request = roomRequest(args[1], args.slice(2));
    const config = loadCliConfig();
    const socketPath = join(config.stateDir, 'management.sock');
    const result = request.method === 'room.history'
      ? await readHistoryPages(socketPath, request.params)
      : await rpcCall(
        socketPath,
        request.method,
        request.params,
        rpcTimeoutForMethod(request.method),
      );
    output.success(result);
    return;
  }
  if (args.length !== 1) usageError(`${command} takes no arguments`);
  const config = loadCliConfig();
  switch (command) {
    case 'serve': {
      const modulePath = './' + 'daemon.js';
      const daemon = await import(modulePath) as { runSupervisor: (options?: { quiet?: boolean }) => Promise<number> };
      const code = await daemon.runSupervisor({ quiet: output.json });
      if (code !== 0) throw new CliError(EXIT.internal, 'internal', `daemon exited with status ${code}`);
      output.success({ served: true, exit_code: code }, 'ours-cowork daemon stopped cleanly');
      return;
    }
    case 'start': {
      const result = await startDaemon(config);
      output.success(result, result.alreadyRunning
        ? 'ours-cowork is already running'
        : 'ours-cowork started');
      return;
    }
    case 'stop': {
      const result = await stopDaemon(config);
      output.success(result, result.stopped ? 'ours-cowork stopped' : 'ours-cowork is not running');
      return;
    }
    case 'restart': {
      await stopDaemon(config);
      const result = await startDaemon(config);
      output.success(result, 'ours-cowork restarted');
      return;
    }
    case 'status': {
      const probe = await probeDaemon(config);
      if (probe.kind !== 'running') {
        throw new CliError(EXIT.daemonUnavailable, 'daemon_unavailable', 'ours-cowork is stopped');
      }
      output.success({ running: true }, 'ours-cowork is running');
      return;
    }
    case 'web': {
      const result = await openWebConsole(config, output.json);
      output.success(result, `opened web console at ${result.url}`);
      return;
    }
    case 'install-service': {
      validateServiceConfiguration(config);
      await stopDaemon(config);
      ensureRuntimeState(config);
      const path = process.platform === 'linux' ? installSystemd(config)
        : process.platform === 'darwin' ? installLaunchd(config)
          : usageError(`install-service is unsupported on ${process.platform}`);
      output.success({ installed: true, path, data_retained_on_uninstall: true }, `installed ours-cowork service at ${path}`);
      return;
    }
    case 'uninstall-service': {
      const path = process.platform === 'linux' ? uninstallSystemd()
        : process.platform === 'darwin' ? uninstallLaunchd()
          : usageError(`uninstall-service is unsupported on ${process.platform}`);
      output.success({ installed: false, path, data_retained: true }, `uninstalled service; cowork data retained in ${config.stateDir}`);
      return;
    }
    default:
      usageError(`unknown command: ${command}`);
  }
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  let optionsEnded = false;
  const jsonIndexes: number[] = [];
  for (const [index, argument] of raw.entries()) {
    if (argument === '--') optionsEnded = true;
    else if (!optionsEnded && argument === '--json') jsonIndexes.push(index);
  }
  const jsonCount = jsonIndexes.length;
  if (jsonCount > 1) {
    const output = createOutput(true);
    const error = new CliError(EXIT.usage, 'usage', 'duplicate option --json');
    output.fail(error);
    process.exitCode = error.exitCode;
    return;
  }
  const json = jsonCount === 1;
  const output = createOutput(json);
  const indexes = new Set(jsonIndexes);
  const args = raw.filter((_argument, index) => !indexes.has(index));
  try {
    await execute(args, output);
  } catch (error) {
    const failure = error instanceof CliError
      ? error
      : new CliError(EXIT.internal, 'internal', error instanceof Error ? error.message : 'internal error', { cause: error });
    output.fail(failure);
    process.exitCode = failure.exitCode;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) void main();
