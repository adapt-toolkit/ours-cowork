import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  API_DOCS_PATH,
  API_DOCS_SCRIPT_PATH,
  API_DOCS_STYLESHEET_PATH,
  OPENAPI_DOCUMENT_PATH,
  ROOM_RPC_METHODS,
  RPC_PATH,
  apiDocsAsset,
  buildOpenApiDocument,
} from '../src/openapi.ts';
import {
  CreateRoomInputSchema,
  PostMessageInputSchema,
  RoleBriefingDeleteInputSchema,
  RoleBriefingSetInputSchema,
  RuntimeRoleCommandGrantInputSchema,
  UpdateRoomInputSchema,
} from '../src/contracts.ts';
import {
  RpcDispatcher,
  TransportServer,
  createPrivateServiceRoutes,
  createServiceRoutes,
} from '../src/transports.ts';

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function serviceStub() {
  return new Proxy({}, { get: () => async () => null });
}

/** Collect every `$ref` string anywhere inside the document. */
function collectRefs(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else collectRefs(value, found);
    }
  }
  return found;
}

function resolveRef(document, ref) {
  assert.match(ref, /^#\//, `only local refs are usable offline: ${ref}`);
  return ref.slice(2).split('/').reduce((node, part) => (node === undefined ? undefined : node[part]), document);
}

function methodAlternatives(document) {
  return document.paths[RPC_PATH].post.requestBody.content['application/json'].schema.oneOf;
}

async function startTransport(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-openapi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dispatcher = new RpcDispatcher(createServiceRoutes(serviceStub()));
  const server = new TransportServer({
    socketPath: join(dir, 'management.sock'),
    rest: { enabled: true, port: 0 },
    unixDispatcher: dispatcher,
    restDispatcher: dispatcher,
  });
  await server.start();
  t.after(() => server.stop());
  return server.restAddress.port;
}

test('the OpenAPI document is a self-consistent 3.1 description with resolvable local refs', () => {
  const document = buildOpenApiDocument();
  assert.equal(document.openapi, '3.1.0');
  assert.equal(typeof document.info.title, 'string');
  assert.equal(document.info.version, '1');
  assert.deepEqual(document.servers, [
    { url: '/', description: 'This cowork daemon, on its loopback REST port.' },
  ]);
  const refs = collectRefs(document);
  assert(refs.length > 0);
  for (const ref of new Set(refs)) {
    assert.notEqual(resolveRef(document, ref), undefined, `unresolvable ref ${ref}`);
  }
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const [verb, operation] of Object.entries(operations)) {
      assert(['get', 'post'].includes(verb), `${path} declares unsupported verb ${verb}`);
      assert.equal(typeof operation.operationId, 'string');
      assert.equal(typeof operation.summary, 'string');
      assert(Object.keys(operation.responses).length > 0, `${path} documents no response`);
    }
  }
  // The document must round-trip as plain JSON for any consumer.
  assert.deepEqual(JSON.parse(JSON.stringify(document)), document);
});

test('documented RPC methods are exactly the REST route table, excluding the private route', () => {
  const restRoutes = Object.keys(createServiceRoutes(serviceStub())).sort();
  const documented = ROOM_RPC_METHODS.map((entry) => entry.method).sort();
  assert.deepEqual(documented, restRoutes);
  assert.equal(new Set(documented).size, documented.length, 'a method is documented twice');

  const document = buildOpenApiDocument();
  const discriminated = methodAlternatives(document)
    .map((alternative) => resolveRef(document, alternative.$ref).properties.method.const)
    .sort();
  assert.deepEqual(discriminated, restRoutes);

  const mapping = document.paths[RPC_PATH].post.requestBody.content['application/json']
    .schema.discriminator;
  assert.equal(mapping.propertyName, 'method');
  assert.deepEqual(Object.keys(mapping.mapping).sort(), restRoutes);
  for (const [method, ref] of Object.entries(mapping.mapping)) {
    assert.equal(resolveRef(document, ref).properties.method.const, method);
  }

  for (const secret of Object.keys(createPrivateServiceRoutes(serviceStub()))) {
    assert.equal(documented.includes(secret), false, `${secret} is Unix-only and must not be documented`);
    assert.doesNotMatch(JSON.stringify(document), new RegExp(secret.replace('.', '\\.')));
  }
});

test('each documented method carries a strict params schema and a conforming example', () => {
  const document = buildOpenApiDocument();
  for (const entry of ROOM_RPC_METHODS) {
    const alternative = methodAlternatives(document)
      .map((candidate) => resolveRef(document, candidate.$ref))
      .find((candidate) => candidate.properties.method.const === entry.method);
    assert(alternative, `${entry.method} is missing from the request body`);
    assert.deepEqual(alternative.required, ['version', 'id', 'method', 'params']);
    assert.equal(alternative.additionalProperties, false);
    assert.equal(alternative.properties.version.const, 1);
    assert(alternative.description.includes('Result:'), `${entry.method} documents no result`);

    const schema = resolveRef(document, alternative.properties.params.$ref);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false, `${entry.method} params must be strict`);
    for (const required of schema.required) {
      assert(Object.hasOwn(schema.properties, required),
        `${entry.method} requires undocumented ${required}`);
      assert(Object.hasOwn(entry.example, required),
        `${entry.method} example omits required ${required}`);
    }
    for (const name of Object.keys(entry.example)) {
      assert(Object.hasOwn(schema.properties, name),
        `${entry.method} example uses undocumented ${name}`);
    }
    const example = alternative.examples[0];
    assert.equal(example.method, entry.method);
    assert.deepEqual(example.params, entry.example);
  }
  // Every method except room.list is addressed to one room.
  for (const entry of ROOM_RPC_METHODS) {
    if (entry.method === 'room.list' || entry.method === 'room.create') continue;
    assert(Object.hasOwn(entry.params.properties, 'room_id'), `${entry.method} omits room_id`);
    assert(entry.params.required.includes('room_id'), `${entry.method} must require room_id`);
  }
});

test('the /rpc operation documents the statuses the transport actually returns', () => {
  const responses = buildOpenApiDocument().paths[RPC_PATH].post.responses;
  assert.deepEqual(Object.keys(responses).sort(), ['200', '400', '403', '404', '413', '415', '500']);
  for (const [status, response] of Object.entries(responses)) {
    const schema = response.content['application/json'].schema;
    assert.equal(
      schema.$ref,
      status === '200' ? '#/components/schemas/RpcSuccessResponse' : '#/components/schemas/RpcErrorResponse',
    );
  }
});

test('the documentation UI is self-contained and references the schema endpoint', () => {
  const page = apiDocsAsset(API_DOCS_PATH);
  assert.equal(page.contentType, 'text/html; charset=utf-8');
  assert(page.body.includes(`data-document="${OPENAPI_DOCUMENT_PATH}"`));
  assert(page.body.includes(`data-rpc="${RPC_PATH}"`));
  assert(page.body.includes(`src="${API_DOCS_SCRIPT_PATH}"`));
  assert(page.body.includes(`href="${API_DOCS_STYLESHEET_PATH}"`));

  const script = apiDocsAsset(API_DOCS_SCRIPT_PATH);
  assert.equal(script.contentType, 'text/javascript; charset=utf-8');
  assert(script.body.includes('fetch(documentUrl)'), 'the UI must load the OpenAPI document');
  assert(script.body.includes('fetch(rpcUrl'), 'the UI must send requests to the real route');

  for (const asset of [page, script, apiDocsAsset(API_DOCS_STYLESHEET_PATH)]) {
    assert.doesNotMatch(asset.body, /\b(?:https?|wss?):\/\//i, 'documentation assets must be local');
    assert.doesNotMatch(asset.body, /localStorage|sessionStorage|indexedDB|document\.cookie/i);
  }
  assert.equal(apiDocsAsset('/docs/../rpc'), undefined);
  assert.equal(apiDocsAsset('/openapi.json/'), undefined);
  assert.equal(apiDocsAsset('/'), undefined);
});

test('the REST listener serves the schema and UI endpoints beside /rpc', async (t) => {
  const port = await startTransport(t);

  const schema = await get(port, OPENAPI_DOCUMENT_PATH);
  assert.equal(schema.status, 200);
  assert.equal(schema.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(schema.headers['x-content-type-options'], 'nosniff');
  assert.match(schema.headers['content-security-policy'], /script-src 'self'/);
  assert.deepEqual(JSON.parse(schema.body), buildOpenApiDocument());

  const withQuery = await get(port, `${OPENAPI_DOCUMENT_PATH}?v=1`);
  assert.equal(withQuery.status, 200);
  assert.deepEqual(JSON.parse(withQuery.body), buildOpenApiDocument());

  for (const [path, contentType] of [
    [API_DOCS_PATH, 'text/html; charset=utf-8'],
    [API_DOCS_SCRIPT_PATH, 'text/javascript; charset=utf-8'],
    [API_DOCS_STYLESHEET_PATH, 'text/css; charset=utf-8'],
  ]) {
    const response = await get(port, path);
    assert.equal(response.status, 200, `${path} was not served`);
    assert.equal(response.headers['content-type'], contentType);
    assert.equal(response.body, apiDocsAsset(path).body);
  }

  const ui = await get(port, API_DOCS_PATH);
  assert(ui.body.includes(OPENAPI_DOCUMENT_PATH), 'the served UI must reference the schema endpoint');
});

test('documentation endpoints stay read-only and do not shadow the RPC route', async (t) => {
  const port = await startTransport(t);

  for (const path of [OPENAPI_DOCUMENT_PATH, API_DOCS_PATH, API_DOCS_SCRIPT_PATH]) {
    const response = await post(port, path, '{}');
    assert.equal(response.status, 404, `${path} must reject non-GET`);
    assert.equal(JSON.parse(response.body).error.code, 'not_found');
  }
  const unknown = await get(port, '/docs/unknown');
  assert.equal(unknown.status, 404);

  const listed = await post(port, RPC_PATH, JSON.stringify({
    version: 1, id: 'req-1', method: 'room.list', params: {},
  }));
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(listed.body), { version: 1, id: 'req-1', result: null });
});

test('documented examples satisfy the contract schemas the service enforces', () => {
  const contracts = {
    'room.create': CreateRoomInputSchema,
    'room.settings': UpdateRoomInputSchema,
    'room.briefing.role.set': RoleBriefingSetInputSchema,
    'room.briefing.role.delete': RoleBriefingDeleteInputSchema,
    'room.command.role.set': RuntimeRoleCommandGrantInputSchema,
    'room.message': PostMessageInputSchema,
  };
  for (const [method, schema] of Object.entries(contracts)) {
    const entry = ROOM_RPC_METHODS.find((candidate) => candidate.method === method);
    assert(entry, `${method} is no longer documented`);
    const { room_id: _roomId, ...input } = entry.example;
    schema.parse(input);
    // Documenting a parameter the contract rejects would mislead every consumer.
    const shape = (typeof schema.innerType === 'function' ? schema.innerType() : schema).shape;
    for (const name of Object.keys(entry.params.properties)) {
      if (name === 'room_id') continue;
      assert(Object.hasOwn(shape, name), `${method} documents unsupported ${name}`);
    }
  }
});

test('every documented example is accepted by the route table it describes', async (t) => {
  const port = await startTransport(t);
  const document = buildOpenApiDocument();
  for (const alternative of methodAlternatives(document)) {
    const example = resolveRef(document, alternative.$ref).examples[0];
    const response = await post(port, RPC_PATH, JSON.stringify(example));
    assert.equal(response.status, 200, `${example.method} example was rejected: ${response.body}`);
    assert.equal(JSON.parse(response.body).id, example.id);
  }
});
