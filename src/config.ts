import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { z } from 'zod';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;

export const CoworkConfigSchema = z.object({
  version: z.literal(1),
  brokerUrl: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'ws:' || protocol === 'wss:';
  }, 'brokerUrl must use ws:// or wss://'),
  stateDir: z.string().min(1),
  rest: z.object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65_535),
  }).strict(),
}).strict();

export type CoworkConfig = z.infer<typeof CoworkConfigSchema>;

export interface RuntimeState {
  socketPath: string;
  pidPath: string;
  lockPath: string;
  tokenPath: string;
  token?: string;
}

export interface ConfigEnvironment {
  OURS_COWORK_CONFIG?: string;
  OURS_COWORK_BROKER_URL?: string;
  OURS_COWORK_STATE_DIR?: string;
  OURS_COWORK_REST_PORT?: string;
}

export interface ConfigIo {
  fs?: typeof nodeFs;
  home?: string;
  random?: (size: number) => Buffer;
}

export class CoworkConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CoworkConfigError';
  }
}

export function defaultConfig(home = homedir()): CoworkConfig {
  return {
    version: 1,
    brokerUrl: 'wss://broker1.ours.network',
    stateDir: resolve(home, '.ours-cowork'),
    rest: { enabled: false, port: 3052 },
  };
}

/** Load one strict config document, then apply the four documented overrides. */
export function loadConfig(
  env: ConfigEnvironment = process.env,
  io: ConfigIo = {},
): CoworkConfig {
  const fs = io.fs ?? nodeFs;
  const defaults = defaultConfig(io.home);
  const configPath = resolve(env.OURS_COWORK_CONFIG ?? join(io.home ?? homedir(), '.ours-cowork', 'config.json'));
  let file = defaults;
  const stat = lstatIfPresent(fs, configPath);
  if (stat) {
    assertSecureFile(fs, configPath, 'config file');
    let parsed: unknown;
    try {
      parsed = JSON.parse(readSecureFile(fs, configPath, 'config file').toString('utf8'));
    } catch (error) {
      throw new CoworkConfigError(`malformed cowork config at ${configPath}`, { cause: error });
    }
    try {
      file = CoworkConfigSchema.parse(parsed);
    } catch (error) {
      throw new CoworkConfigError(`invalid cowork config at ${configPath}`, { cause: error });
    }
  } else if (env.OURS_COWORK_CONFIG !== undefined) {
    throw new CoworkConfigError(`configured cowork config does not exist: ${configPath}`);
  }

  const restPort = env.OURS_COWORK_REST_PORT === undefined
    ? undefined
    : parsePort(env.OURS_COWORK_REST_PORT);
  try {
    return CoworkConfigSchema.parse({
      version: 1,
      brokerUrl: env.OURS_COWORK_BROKER_URL ?? file.brokerUrl,
      stateDir: resolve(env.OURS_COWORK_STATE_DIR ?? file.stateDir),
      rest: {
        enabled: restPort === undefined ? file.rest.enabled : true,
        port: restPort ?? file.rest.port,
      },
    });
  } catch (error) {
    throw new CoworkConfigError('invalid effective cowork config', { cause: error });
  }
}

/** Establish and verify every host-owned runtime path before a wrapper starts. */
export function ensureRuntimeState(config: CoworkConfig, io: ConfigIo = {}): RuntimeState {
  const parsed = CoworkConfigSchema.parse(config);
  const fs = io.fs ?? nodeFs;
  const stateDir = resolve(parsed.stateDir);
  assertSecureAncestors(fs, stateDir, 'state directory');
  const existing = lstatIfPresent(fs, stateDir);
  if (!existing) {
    createSecureDirectoryTree(fs, stateDir, 'state directory');
  }
  assertSecureDirectory(fs, stateDir, 'state directory');

  const roomsPath = join(stateDir, 'rooms');
  const rooms = lstatIfPresent(fs, roomsPath);
  if (!rooms) {
    fs.mkdirSync(roomsPath, { mode: DIRECTORY_MODE });
    secureOpenedDirectory(fs, roomsPath, 'rooms directory');
    fsyncDirectory(fs, stateDir);
  }
  assertSecureDirectory(fs, roomsPath, 'rooms directory');

  const runtime: RuntimeState = {
    socketPath: join(stateDir, 'management.sock'),
    pidPath: join(stateDir, 'daemon.pid'),
    lockPath: join(stateDir, 'daemon.lock'),
    tokenPath: join(stateDir, 'management-token'),
  };
  if (parsed.rest.enabled) runtime.token = loadOrCreateToken(fs, runtime.tokenPath, io.random ?? randomBytes);
  return runtime;
}

function parsePort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    throw new CoworkConfigError('OURS_COWORK_REST_PORT must be a decimal port from 1 to 65535');
  }
  const port = Number(value);
  if (port > 65_535) throw new CoworkConfigError('OURS_COWORK_REST_PORT must be from 1 to 65535');
  return port;
}

function loadOrCreateToken(
  fs: typeof nodeFs,
  path: string,
  random: (size: number) => Buffer,
): string {
  if (lstatIfPresent(fs, path)) {
    assertSecureFile(fs, path, 'management token');
    const token = readSecureFile(fs, path, 'management token').toString('utf8');
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw new CoworkConfigError('management token must contain exactly 64 lowercase hexadecimal characters');
    }
    return token;
  }

  let token: string;
  try {
    const bytes = random(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error('random source returned the wrong byte count');
    token = bytes.toString('hex');
  } catch (error) {
    throw new CoworkConfigError('failed to generate management token', { cause: error });
  }
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW, FILE_MODE);
    created = true;
    fs.fchmodSync(fd, FILE_MODE);
    writeAll(fs, fd, Buffer.from(token, 'ascii'));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertSecureFile(fs, path, 'management token');
    fsyncDirectory(fs, dirname(path));
    return token;
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* creation failure wins */ }
    if (created) try { fs.unlinkSync(path); } catch { /* creation failure wins */ }
    throw new CoworkConfigError('failed to create management token', { cause: error });
  }
}

function assertSecureAncestors(fs: typeof nodeFs, path: string, label: string): void {
  const absolute = isAbsolute(path) ? path : resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  const components = absolute.slice(root.length).split('/').filter(Boolean);
  for (const [index, component] of components.entries()) {
    cursor = join(cursor, component);
    const stat = lstatIfPresent(fs, cursor);
    if (stat?.isSymbolicLink()) throw new CoworkConfigError(`${label} must not traverse a symbolic link (symlink): ${cursor}`);
    if (!stat) break;
    if (!stat.isDirectory()) {
      if (index === components.length - 1) return;
      throw new CoworkConfigError(`${label} ancestor is not a directory: ${cursor}`);
    }
    if (index < components.length - 1) assertTrustedAncestor(stat, cursor, label);
  }
}

function assertTrustedAncestor(stat: nodeFs.Stats, path: string, label: string): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  const trustedStickyDirectory = (stat.mode & 0o1000) !== 0;
  if (stat.uid !== uid && !trustedStickyDirectory) {
    throw new CoworkConfigError(`${label} has a non-owned ancestor: ${path}`);
  }
  const writableByOthers = (stat.mode & 0o022) !== 0;
  if (writableByOthers && !trustedStickyDirectory) {
    throw new CoworkConfigError(`${label} has an unsafe writable ancestor: ${path}`);
  }
}

function createSecureDirectoryTree(fs: typeof nodeFs, path: string, label: string): void {
  const missing: string[] = [];
  let cursor = path;
  while (!lstatIfPresent(fs, cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) throw new CoworkConfigError(`cannot locate an existing ancestor for ${label}`);
    cursor = parent;
  }
  assertSecureAncestors(fs, path, label);
  for (const directory of missing.reverse()) {
    fs.mkdirSync(directory, { mode: DIRECTORY_MODE });
    secureOpenedDirectory(fs, directory, label);
    fsyncDirectory(fs, dirname(directory));
  }
}

function secureOpenedDirectory(fs: typeof nodeFs, path: string, label: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(path);
    if (!opened.isDirectory() || current.isSymbolicLink()
      || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new CoworkConfigError(`${label} changed while opening`);
    }
    fs.fchmodSync(fd, DIRECTORY_MODE);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function assertSecureDirectory(fs: typeof nodeFs, path: string, label: string): void {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink()) throw new CoworkConfigError(`${label} must not be a symbolic link (symlink)`);
  if (!stat.isDirectory()) throw new CoworkConfigError(`${label} must be a directory`);
  if ((stat.mode & 0o777) !== DIRECTORY_MODE) {
    throw new CoworkConfigError(`${label} mode must be 0700`);
  }
  assertOwner(stat, label);
}

function assertSecureFile(fs: typeof nodeFs, path: string, label: string): void {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink()) throw new CoworkConfigError(`${label} must not be a symbolic link (symlink)`);
  if (!stat.isFile() || stat.nlink !== 1) throw new CoworkConfigError(`${label} must be a single-link regular file`);
  if ((stat.mode & 0o777) !== FILE_MODE) throw new CoworkConfigError(`${label} mode must be 0600`);
  assertOwner(stat, label);
}

function assertOwner(stat: nodeFs.Stats, label: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new CoworkConfigError(`${label} must be owned by the current user`);
  }
}

function readSecureFile(fs: typeof nodeFs, path: string, label: string): Buffer {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== FILE_MODE
      || (typeof process.getuid === 'function' && opened.uid !== process.getuid())
      || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new CoworkConfigError(`${label} changed while opening`);
    }
    return fs.readFileSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fsyncDirectory(fs: typeof nodeFs, path: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeAll(fs: typeof nodeFs, fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) throw new Error('write made no progress');
    offset += written;
  }
}

function lstatIfPresent(fs: typeof nodeFs, path: string): nodeFs.Stats | undefined {
  try { return fs.lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
