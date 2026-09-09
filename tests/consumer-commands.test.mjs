import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ConsumerHandlers, MAX_CONSUMER_RESPONSE_BYTES } from '../src/consumer-commands.ts';

const definition = { name: 'consumer.orders', description: 'Read order', handler: 'orders', input_schema: {
  type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false,
}, source: 'rest', revision: 1 };
const context = { sender_cid: 'A'.repeat(64), request_wire_id: 'B'.repeat(64), sender_name: 'Untrusted' };
const project = ({ source, revision, ...value }) => value;
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'cowork-callback-'));
  const token_file = join(root, 'token');
  fs.chmodSync(root, 0o700);
  let callback = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"result":null}'); };
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
    callback(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = { handlers: [{ id: 'orders', url: `http://127.0.0.1:${server.address().port}/callback`, token_file }], timeout_ms: 100 };
  const handlers = new ConsumerHandlers(config);
  return { root, token_file, config, handlers, requests, setCallback(value) { callback = value; } };
}

test('consumer provisions and rotates a private callback credential without exposing it in results', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.handlers.invoke(definition, 'room', { id: 7 }, context), { ok: false, error: 'consumer_handler_unavailable' });
  assert.equal(f.requests.length, 0);
  const first = 'first-consumer-token-value';
  assert.deepEqual(f.handlers.provisionCredential({ handler: 'orders', token: first }), { handler: 'orders', configured: true });
  assert.equal(fs.statSync(f.token_file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.token_file, 'utf8'), first);
  f.setCallback((req, res) => {
    if (req.headers.authorization !== `Bearer ${first}`) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"result":{"order":7}}');
  });
  assert.deepEqual(await f.handlers.invoke(definition, 'room', { id: 7 }, context), { ok: true, result: { order: 7 } });
  assert.deepEqual(f.requests[0], { authorization: `Bearer ${first}`, body: { version: 1, command: definition.name,
    registration_revision: 1, request_id: context.request_wire_id, room_id: 'room', caller_cid: context.sender_cid, arguments: { id: 7 } } });
  f.handlers.provisionCredential({ handler: 'orders', token: 'rotated-consumer-token' });
  assert.equal((await f.handlers.invoke(definition, 'room', { id: 7 }, context)).error, 'consumer_http_error');
  const restarted = new ConsumerHandlers(f.config);
  await restarted.invoke(definition, 'room', { id: 7 }, context);
  assert.equal(f.requests.at(-1).authorization, 'Bearer rotated-consumer-token');
  assert.throws(() => f.handlers.provisionCredential({ handler: 'unconfigured', token: first }), /unknown/);
});

test('callback validates arguments before HTTP and refuses redirects, malformed, oversized and timed out replies without retries', async (t) => {
  const f = await fixture(t);
  f.handlers.provisionCredential({ handler: 'orders', token: 'consumer-token-for-test' });
  assert.equal((await f.handlers.invoke(definition, 'room', { id: 'wrong' }, context)).error, 'invalid_params');
  assert.equal(f.requests.length, 0);
  const cases = [
    ['consumer_http_error', (_req, res) => { res.writeHead(302, { location: '/other' }); res.end(); }],
    ['consumer_invalid_response', (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }],
    ['consumer_response_too_large', (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(MAX_CONSUMER_RESPONSE_BYTES + 1)); }],
    ['consumer_timeout', () => {}],
  ];
  for (const [error, callback] of cases) {
    f.setCallback(callback);
    const before = f.requests.length;
    assert.deepEqual(await f.handlers.invoke(definition, 'room', { id: 7 }, context), { ok: false, error, execution: 'unknown' });
    assert.equal(f.requests.length, before + 1, 'exactly one HTTP attempt');
  }
});

test('consumer schemas and handler references cannot inject built-ins, destinations or external schema resolution', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.handlers.validate({ ...project(definition), name: 'room.show' }));
  assert.throws(() => f.handlers.validate({ ...project(definition), handler: 'https://example.invalid' }), /unknown/);
  assert.throws(() => f.handlers.validate({ ...project(definition), input_schema: { type: 'object', additionalProperties: false, $ref: 'https://example.invalid/schema' } }), /unsupported/);
  assert.throws(() => f.handlers.validate({ ...project(definition), input_schema: { type: 'object' } }), /additionalProperties/);
  // Churn crosses the bounded application cache; individual compiler instances
  // have no global retained schema registry.
  for (let n = 0; n < 270; n++) f.handlers.validate({ ...project(definition), input_schema: {
    ...definition.input_schema, properties: { id: { type: 'integer', maximum: n } },
  } });
  f.handlers.validate(project(definition));
});
