import * as nodeFs from 'node:fs';
import type * as http from 'node:http';
import { extname, join } from 'node:path';

const NO_FOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

export interface StaticAsset {
  bytes: Buffer;
  contentType: string;
  immutable: boolean;
}

export type StaticWebHandler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => Promise<boolean>;

interface DirectoryIdentity {
  path: string;
  label: string;
  dev: number;
  ino: number;
}

/** Load the complete public file allowlist before the listener accepts traffic. */
export function loadWebAssets(
  root: string,
  fs: typeof nodeFs = nodeFs,
): ReadonlyMap<string, StaticAsset> {
  let rootIdentity: DirectoryIdentity;
  try {
    rootIdentity = observeDirectory(fs, root, 'web asset root');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }

  const manifest = new Map<string, StaticAsset>();
  manifest.set('/', loadAsset(fs, join(root, 'index.html'), false, [rootIdentity]));

  const assetsDirectory = join(root, 'assets');
  assertDirectoryIdentity(fs, rootIdentity);
  const assetsIdentity = observeDirectory(fs, assetsDirectory, 'web assets directory');
  assertDirectoryIdentity(fs, rootIdentity);
  const directories = [rootIdentity, assetsIdentity];
  assertDirectoryIdentities(fs, directories);
  const assetEntries = fs.readdirSync(assetsDirectory, { withFileTypes: true });
  assertDirectoryIdentities(fs, directories);

  for (const entry of assetEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const path = join(assetsDirectory, entry.name);
    manifest.set(`/assets/${entry.name}`, loadAsset(fs, path, true, directories));
  }
  assertDirectoryIdentities(fs, directories);
  return manifest;
}

export function createStaticWebHandler(assets: ReadonlyMap<string, StaticAsset>): StaticWebHandler {
  return async (request, response) => {
    if (request.method !== 'GET') return false;
    const pathname = safePathname(request.url);
    if (pathname === undefined) return false;
    const asset = assets.get(pathname);
    if (!asset) {
      if (pathname !== '/') return false;
      const body = Buffer.from('web console assets unavailable', 'utf8');
      response.writeHead(503, staticHeaders('text/plain; charset=utf-8', body.length, false));
      response.end(body);
      await responseFinished(response);
      return true;
    }
    response.writeHead(200, staticHeaders(asset.contentType, asset.bytes.length, asset.immutable));
    response.end(asset.bytes);
    await responseFinished(response);
    return true;
  };
}

function loadAsset(
  fs: typeof nodeFs,
  path: string,
  immutable: boolean,
  directories: readonly DirectoryIdentity[],
): StaticAsset {
  assertDirectoryIdentities(fs, directories);
  const observed = fs.lstatSync(path);
  assertDirectoryIdentities(fs, directories);
  if (observed.isSymbolicLink() || !observed.isFile() || observed.nlink !== 1) {
    throw new Error(`web asset must be a non-symbolic-link regular file: ${path}`);
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(fd);
    assertDirectoryIdentities(fs, directories);
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== observed.dev || opened.ino !== observed.ino) {
      throw new Error(`web asset changed while opening: ${path}`);
    }
    const bytes = fs.readFileSync(fd);
    assertDirectoryIdentities(fs, directories);
    return {
      bytes,
      contentType: CONTENT_TYPES.get(extname(path).toLowerCase()) ?? 'application/octet-stream',
      immutable,
    };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function observeDirectory(fs: typeof nodeFs, path: string, label: string): DirectoryIdentity {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a non-symbolic-link directory`);
  }
  return { path, label, dev: stat.dev, ino: stat.ino };
}

function assertDirectoryIdentities(
  fs: typeof nodeFs,
  directories: readonly DirectoryIdentity[],
): void {
  for (const directory of directories) assertDirectoryIdentity(fs, directory);
}

function assertDirectoryIdentity(fs: typeof nodeFs, expected: DirectoryIdentity): void {
  const current = fs.lstatSync(expected.path);
  if (current.isSymbolicLink() || !current.isDirectory()
    || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`${expected.label} changed during web asset loading`);
  }
}

function safePathname(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const raw = url.split(/[?#]/, 1)[0] ?? '';
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return undefined;
  if (decoded.split('/').some((part) => part === '.' || part === '..')) return undefined;
  return decoded;
}

function staticHeaders(contentType: string, length: number, immutable: boolean): http.OutgoingHttpHeaders {
  return {
    'content-type': contentType,
    'content-length': length,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
  };
}

function responseFinished(response: http.ServerResponse): Promise<void> {
  if (response.writableFinished || response.destroyed) return Promise.resolve();
  return new Promise((resolveResponse, rejectResponse) => {
    response.once('finish', resolveResponse);
    response.once('close', resolveResponse);
    response.once('error', rejectResponse);
  });
}
