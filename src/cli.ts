#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { connect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureRuntimeState, loadConfig, type CoworkConfig } from './config.ts';

const EXIT = {
  success: 0,
  usage: 2,
  notFound: 3,
  invalidState: 4,
  unauthorized: 5,
  daemonUnavailable: 6,
  internal: 7,
} as const;
const RPC_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SELF = fileURLToPath(import.meta.url);
const SYSTEMD_UNIT = 'ours-cowork.service';
const LAUNCHD_LABEL = 'network.ours.cowork';

interface RpcResponse {
  version: 1;
  id: string | number | null;
  result?: unknown;
  error?: { code: string; message: string };
}

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
  ours-cowork [--json] start|stop|restart|status|serve
  ours-cowork [--json] install-service|uninstall-service
  ours-cowork [--json] room <command> [arguments]
  ours-cowork [--json] docs [topic]

Room commands:
  create --goal <text> --briefing <text>
  settings <room-id> [--goal <text>] [--briefing <text>] [--status <text>]
  invite <room-id> --role <label> [--mode one_time|public] [--min-accepts <n>]
  revoke <room-id> <invite-id>
  list
  show <room-id>
  participants <room-id>
  history <room-id> [--after <seq>] [--limit <n>]
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
      const parsed = parseOptions(args, ['--goal', '--briefing']);
      exactPositionals(parsed, 0, 'room create');
      return { method: 'room.create', params: {
        goal: requiredFlag(parsed, '--goal', 'room create'),
        briefing: requiredFlag(parsed, '--briefing', 'room create'),
      } };
    }
    case 'settings': {
      const parsed = parseOptions(args, ['--goal', '--briefing', '--status']);
      const [roomId] = exactPositionals(parsed, 1, 'room settings');
      const params: Record<string, unknown> = { room_id: roomId };
      for (const [flag, key] of [['--goal', 'goal'], ['--briefing', 'briefing'], ['--status', 'status']] as const) {
        if (parsed.values[flag] !== undefined) params[key] = parsed.values[flag];
      }
      if (Object.keys(params).length === 1) usageError('room settings requires at least one setting option');
      return { method: 'room.settings', params };
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
        role: requiredFlag(parsed, '--role', 'room invite'),
        min_accepts: minimum,
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
      const parsed = parseOptions(args, ['--after', '--limit']);
      const [roomId] = exactPositionals(parsed, 1, 'room history');
      const params: Record<string, unknown> = { room_id: roomId };
      if (parsed.values['--after'] !== undefined) params.after = parseInteger(parsed.values['--after'], '--after', 0);
      if (parsed.values['--limit'] !== undefined) params.limit = parseInteger(parsed.values['--limit'], '--limit', 1);
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

function rpcCall(socketPath: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const request = `${JSON.stringify({ version: 1, id, method, params })}\n`;
  return new Promise((resolveCall, rejectCall) => {
    const socket = connect(socketPath);
    let bytes = '';
    let size = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finishError = (error: CliError): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      socket.destroy();
      rejectCall(error);
    };
    timer = setTimeout(() => finishError(new CliError(EXIT.daemonUnavailable, 'daemon_unavailable', 'daemon did not answer the management socket')), RPC_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk: string) => {
      if (settled) return;
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > MAX_RESPONSE_BYTES) {
        finishError(new CliError(EXIT.internal, 'internal', 'daemon response exceeded 1 MiB'));
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
      finishError(new CliError(
        unauthorized ? EXIT.unauthorized : EXIT.daemonUnavailable,
        unauthorized ? 'unauthorized' : 'daemon_unavailable',
        unauthorized ? 'management socket access denied' : 'cowork daemon is unavailable',
        { cause: error },
      ));
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

function readPid(path: string): number | null {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new CliError(EXIT.internal, 'internal', 'daemon PID file is not a secure 0600 regular file');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new CliError(EXIT.unauthorized, 'unauthorized', 'daemon PID file is not owned by the current user');
    }
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(path);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino
      || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new CliError(EXIT.internal, 'internal', 'daemon PID file changed while opening');
    }
    const text = fs.readFileSync(fd, 'utf8');
    if (!/^[1-9][0-9]*\n$/.test(text)) throw new CliError(EXIT.internal, 'internal', 'daemon PID file is malformed');
    const pid = Number(text.trim());
    if (!Number.isSafeInteger(pid)) throw new CliError(EXIT.internal, 'internal', 'daemon PID file is malformed');
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

interface ProcessIdentity {
  ppid: number;
  argv: string[];
}

function processIdentity(pid: number): ProcessIdentity | null {
  if (process.platform === 'linux') {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const ppidText = /^PPid:\s+([0-9]+)$/m.exec(status)?.[1];
      if (!ppidText) return null;
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      if (argv.length === 0) return null;
      return { ppid: Number(ppidText), argv };
    } catch { return null; }
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'command='], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    const match = /^\s*([0-9]+)\s+(.+)$/.exec(result.stdout.trim());
    if (!match) return null;
    // Darwin does not expose procfs argv. Keep this parser deliberately
    // conservative: ambiguous quoting means "not owned" and is never signaled.
    const argv = match[2]!.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'[^']*')+/g)
      ?.map((part) => part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')) ?? [];
    return argv.length > 0 ? { ppid: Number(match[1]), argv } : null;
  }
  return null;
}

function sameExecutablePath(candidate: string, expected: string): boolean {
  try { return fs.realpathSync(candidate) === fs.realpathSync(expected); }
  catch { return false; }
}

function argvRuns(argv: string[], script: string, requiredArgument?: string): boolean {
  const index = argv.findIndex((argument) => sameExecutablePath(argument, script));
  return index >= 0 && (requiredArgument === undefined || argv.slice(index + 1).includes(requiredArgument));
}

/**
 * Prove the Task 8 supervisor/worker ownership chain before trusting a PID.
 * The secure PID names the CLI supervisor, the secure lock names its daemon.js
 * worker, and that live worker must still have the supervisor as its parent.
 */
function ownedSupervisorPid(config: CoworkConfig): number | null {
  const supervisorPid = readPid(join(config.stateDir, 'daemon.pid'));
  if (supervisorPid === null || !isAlive(supervisorPid)) return null;
  let workerPid: number | null;
  try { workerPid = readPid(join(config.stateDir, 'daemon.lock')); }
  catch { return null; }
  if (workerPid === null || !isAlive(workerPid)) return null;
  const supervisor = processIdentity(supervisorPid);
  const worker = processIdentity(workerPid);
  if (!supervisor || !worker || worker.ppid !== supervisorPid) return null;
  const daemonScript = fileURLToPath(new URL('./daemon.js', import.meta.url));
  if (!argvRuns(supervisor.argv, SELF, 'serve') || !argvRuns(worker.argv, daemonScript)) return null;
  return supervisorPid;
}

function ambiguousLivePid(config: CoworkConfig): number | null {
  const pid = readPid(join(config.stateDir, 'daemon.pid'));
  return pid !== null && isAlive(pid) ? pid : null;
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

async function waitForOwnedDaemon(config: CoworkConfig, socketPath: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = ownedSupervisorPid(config);
    if (pid !== null && await socketOpen(socketPath) && ownedSupervisorPid(config) === pid) return pid;
    await sleep(200);
  }
  return null;
}

async function startDaemon(config: CoworkConfig): Promise<{ pid: number; alreadyRunning: boolean }> {
  const runtime = ensureRuntimeState(config);
  const existing = ownedSupervisorPid(config);
  if (existing !== null && await socketOpen(runtime.socketPath) && ownedSupervisorPid(config) === existing) {
    return { pid: existing, alreadyRunning: true };
  }
  const ambiguous = ambiguousLivePid(config);
  if (ambiguous !== null) {
    throw new CliError(EXIT.invalidState, 'invalid_state', `live PID ${ambiguous} is not provably the cowork supervisor; refusing to start or signal it`);
  }
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
  const readyPid = await waitForOwnedDaemon(config, runtime.socketPath, START_TIMEOUT_MS);
  if (readyPid === null) {
    throw new CliError(EXIT.internal, 'internal', `daemon did not become ready; inspect ${logPath}`);
  }
  return { pid: readyPid, alreadyRunning: false };
}

async function stopDaemon(config: CoworkConfig): Promise<{ stopped: boolean; pid?: number }> {
  const pid = ownedSupervisorPid(config);
  if (pid === null) return { stopped: false };
  if (ownedSupervisorPid(config) !== pid) {
    throw new CliError(EXIT.invalidState, 'invalid_state', 'cowork supervisor identity changed before signaling; refusing to signal it');
  }
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') throw new CliError(EXIT.unauthorized, 'unauthorized', `permission denied signaling daemon PID ${pid}`);
    if (code !== 'ESRCH') throw new CliError(EXIT.internal, 'internal', `failed to signal daemon PID ${pid}`);
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && isAlive(pid)) await sleep(100);
  if (isAlive(pid)) throw new CliError(EXIT.invalidState, 'invalid_state', `daemon PID ${pid} did not stop within ${STOP_TIMEOUT_MS / 1000} seconds`);
  return { stopped: true, pid };
}

function serviceEnvironment(config: CoworkConfig): Record<string, string> {
  return {
    OURS_COWORK_BROKER_URL: config.brokerUrl,
    OURS_COWORK_STATE_DIR: config.stateDir,
    ...(config.rest.enabled ? { OURS_COWORK_REST_PORT: String(config.rest.port) } : {}),
  };
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
    const result = await rpcCall(join(config.stateDir, 'management.sock'), request.method, request.params);
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
        ? `ours-cowork is already running (pid ${result.pid})`
        : `ours-cowork started (pid ${result.pid})`);
      return;
    }
    case 'stop': {
      const result = await stopDaemon(config);
      output.success(result, result.stopped ? `ours-cowork stopped (pid ${result.pid})` : 'ours-cowork is not running');
      return;
    }
    case 'restart': {
      await stopDaemon(config);
      const result = await startDaemon(config);
      output.success(result, `ours-cowork restarted (pid ${result.pid})`);
      return;
    }
    case 'status': {
      const runtime = { socketPath: join(config.stateDir, 'management.sock') };
      const pid = ownedSupervisorPid(config);
      if (pid === null || !await socketOpen(runtime.socketPath) || ownedSupervisorPid(config) !== pid) {
        throw new CliError(EXIT.daemonUnavailable, 'daemon_unavailable', 'ours-cowork is stopped');
      }
      output.success({ running: true, pid, broker_url: config.brokerUrl, state_dir: config.stateDir }, `ours-cowork is running (pid ${pid})`);
      return;
    }
    case 'install-service': {
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

void main();
