import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStaticWebHandler, loadWebAssets } from '../src/web.ts';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port, path, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('static web handler serves only the startup allowlist with hardened headers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-web-assets-'));
  const root = join(dir, 'web');
  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(assets, 'app.js'), 'globalThis.cowork = true;');
  writeFileSync(join(assets, 'theme.css'), ':root { color-scheme: dark; }');
  writeFileSync(join(dir, 'secret'), 'not public');
  symlinkSync(join(dir, 'secret'), join(assets, 'escape.js'));

  const handler = createStaticWebHandler(loadWebAssets(root));
  const server = http.createServer(async (incoming, response) => {
    if (!await handler(incoming, response)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  });
  const port = await listen(server);
  t.after(async () => { await close(server); rmSync(dir, { recursive: true, force: true }); });

  const index = await request(port, '/');
  assert.equal(index.statusCode, 200);
  assert.match(index.body, /<div id="root">/);
  assert.match(index.headers['content-security-policy'], /default-src 'self'/);
  assert.match(index.headers['content-security-policy'], /object-src 'none'/);
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');

  const script = await request(port, '/assets/app.js');
  assert.equal(script.statusCode, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(script.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal((await request(port, '/assets/theme.css')).headers['content-type'], 'text/css; charset=utf-8');

  for (const path of ['/../secret', '/%2e%2e/secret', '/assets/missing.js', '/assets/escape.js', '/assets/']) {
    assert.equal((await request(port, path)).statusCode, 404, path);
  }
  assert.equal((await request(port, '/assets/app.js', 'POST')).statusCode, 404);
});

test('a missing production web root degrades only GET / to a 503', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-web-missing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handler = createStaticWebHandler(loadWebAssets(join(dir, 'absent')));
  const server = http.createServer(async (incoming, response) => {
    if (!await handler(incoming, response)) {
      response.writeHead(404);
      response.end();
    }
  });
  const port = await listen(server);
  t.after(() => close(server));

  const index = await request(port, '/');
  assert.equal(index.statusCode, 503);
  assert.equal(index.body, 'web console assets unavailable');
  assert.equal((await request(port, '/assets/missing.js')).statusCode, 404);
});
