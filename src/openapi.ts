/**
 * OpenAPI description of the room-management REST surface.
 *
 * The daemon exposes exactly one REST route — `POST /rpc` — carrying the
 * versioned RPC envelope, so the document models that route once and
 * discriminates the seventeen room-management methods through the envelope's
 * `method` field. Nothing here may advertise an operation the REST dispatcher
 * does not actually serve: `room.accept` is deliberately absent because it is
 * reachable only over the private Unix socket.
 *
 * The bundled UI is dependency-free and self-hosted so the documentation stays
 * usable on an offline host and inside the console's `'self'`-only CSP.
 */

export const RPC_PATH = '/rpc';
export const OPENAPI_DOCUMENT_PATH = '/openapi.json';
export const API_DOCS_PATH = '/docs';
export const API_DOCS_SCRIPT_PATH = '/docs/ui.js';
export const API_DOCS_STYLESHEET_PATH = '/docs/ui.css';

/** The RPC contract version, not the package release version. */
const API_VERSION = '1';

type JsonSchema = Record<string, unknown>;

export interface RpcMethodDocumentation {
  /** Envelope `method` value, identical to the REST route table key. */
  readonly method: string;
  readonly summary: string;
  readonly description: string;
  /** JSON Schema for the envelope `params` object. */
  readonly params: JsonSchema;
  /** Description of the `result` returned on success. */
  readonly result: string;
  /** Example `params` object rendered by the documentation UI. */
  readonly example: Record<string, unknown>;
}

const EXAMPLE_ROOM_ID = '01jd7q4h9m2v8xk3znbc5regty';

const roomIdProperty: JsonSchema = {
  type: 'string',
  pattern: '^[0-7][0-9a-hjkmnp-tv-z]{25}$',
  description: '26-character lowercase Crockford ULID identifying the room.',
};
const roleProperty: JsonSchema = {
  type: 'string',
  description: 'Invite role. At most 256 UTF-8 bytes.',
};
const missionTextProperty = (what: string): JsonSchema => ({
  type: 'string',
  description: `${what}. At most 262144 UTF-8 bytes.`,
});
const roomNameProperty: JsonSchema = {
  type: 'string',
  description: 'Friendly room name: 1-64 Unicode characters after trimming and NFC '
    + 'normalization, with no Unicode control or format characters. Duplicates are allowed.',
};
const inviteModeProperty: JsonSchema = {
  type: 'string',
  enum: ['one_time', 'public'],
  description: 'Invitation mode. `one_time` requires `min_accepts` to be 1.',
};
const notifyProperty: JsonSchema = {
  type: 'boolean',
  description: 'Announce the membership change to the room. Defaults to the room\'s quiet setting.',
};

function params(properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema {
  return { type: 'object', additionalProperties: false, properties, required: [...required] };
}

/**
 * Every method the REST dispatcher serves, in route-table order. Kept in step
 * with `createServiceRoutes` by an asserted test rather than by convention.
 */
export const ROOM_RPC_METHODS: readonly RpcMethodDocumentation[] = [
  {
    method: 'room.create',
    summary: 'Create a room',
    description: 'Provisions a room, its durable metadata, and its room packet. The room stays '
      + 'in the provisioning state until its invitation requirements are satisfied.',
    params: params({
      name: roomNameProperty,
      goal: missionTextProperty('Mission goal'),
      briefing: missionTextProperty('Mission briefing'),
      anonymous: {
        type: 'boolean',
        description: 'Project participants under aliases instead of contact identities.',
      },
      quiet_membership: {
        type: 'boolean',
        description: 'Suppress membership announcements for this room by default.',
      },
    }, ['goal', 'briefing']),
    result: 'The created room record, including `room_id`, `room_name`, `state`, mission, '
      + 'invites, and seats.',
    example: { goal: 'Ship the release', briefing: 'Coordinate the 1.0 cut.', name: 'Release' },
  },
  {
    method: 'room.settings',
    summary: 'Update room settings',
    description: 'Updates mutable room settings. At least one setting besides `room_id` is '
      + 'required; omitted settings are left unchanged.',
    params: params({
      room_id: roomIdProperty,
      name: roomNameProperty,
      goal: missionTextProperty('Replacement mission goal'),
      briefing: missionTextProperty('Replacement mission briefing'),
      status: { type: 'string', minLength: 1, description: 'Operator status line.' },
      quiet_membership: {
        type: 'boolean',
        description: 'Suppress membership announcements for this room.',
      },
    }, ['room_id']),
    result: 'The updated room record.',
    example: { room_id: EXAMPLE_ROOM_ID, name: 'Release cut' },
  },
  {
    method: 'room.briefing.role.set',
    summary: 'Set a role briefing',
    description: 'Creates or replaces the briefing for one role and bumps its briefing version.',
    params: params({
      room_id: roomIdProperty,
      role: roleProperty,
      text: missionTextProperty('Role briefing text'),
    }, ['room_id', 'role', 'text']),
    result: 'The updated room record with the stored role briefing.',
    example: { room_id: EXAMPLE_ROOM_ID, role: 'Reviewer', text: 'Review every merge request.' },
  },
  {
    method: 'room.briefing.role.delete',
    summary: 'Delete a role briefing',
    description: 'Removes the briefing for one role.',
    params: params({ room_id: roomIdProperty, role: roleProperty }, ['room_id', 'role']),
    result: 'The updated room record without the removed role briefing.',
    example: { room_id: EXAMPLE_ROOM_ID, role: 'Reviewer' },
  },
  {
    method: 'room.invite',
    summary: 'Mint an invitation requirement',
    description: 'Mints one invitation requirement and returns its receipt. The invite secret is '
      + 'returned once in `blob` and is never stored in room metadata or replayed by any later call.',
    params: params({
      room_id: roomIdProperty,
      mode: inviteModeProperty,
      role: roleProperty,
      min_accepts: {
        type: 'integer',
        minimum: 1,
        description: 'Acceptances required before the requirement is satisfied. Must be 1 for '
          + '`one_time` invites.',
      },
    }, ['room_id', 'mode', 'min_accepts']),
    result: 'An invite receipt: `room_id`, the recorded `invite`, the one-shot `blob` secret, and '
      + '`reusable`.',
    example: { room_id: EXAMPLE_ROOM_ID, mode: 'one_time', role: 'Reviewer', min_accepts: 1 },
  },
  {
    method: 'room.participant.remove',
    summary: 'Remove a participant',
    description: 'Removes one participant seat, bumps the membership epoch, and severs the '
      + 'contact. The receipt reports what actually happened, including retained key material.',
    params: params({
      room_id: roomIdProperty,
      participant: {
        type: 'string',
        minLength: 1,
        description: 'Participant id, identity, display name, or alias.',
      },
      notify: notifyProperty,
    }, ['room_id', 'participant']),
    result: 'A removal receipt with `participant_id`, `epoch`, `status`, `notified`, and '
      + '`key_material_retained`.',
    example: { room_id: EXAMPLE_ROOM_ID, participant: 'Reviewer-1', notify: true },
  },
  {
    method: 'room.participant.replace',
    summary: 'Replace a participant',
    description: 'Removes one participant seat and mints a replacement invitation requirement in '
      + 'the same operation.',
    params: params({
      room_id: roomIdProperty,
      participant: {
        type: 'string',
        minLength: 1,
        description: 'Participant id, identity, display name, or alias.',
      },
      notify: notifyProperty,
      mode: inviteModeProperty,
      min_accepts: {
        type: 'integer',
        minimum: 1,
        description: 'Acceptances required for the replacement invitation requirement.',
      },
    }, ['room_id', 'participant']),
    result: 'An invite receipt for the replacement, extended with the `removal` receipt.',
    example: { room_id: EXAMPLE_ROOM_ID, participant: 'Reviewer-1', mode: 'one_time' },
  },
  {
    method: 'room.revoke',
    summary: 'Revoke an invitation requirement',
    description: 'Revokes one live invitation requirement so it can no longer admit a seat.',
    params: params({
      room_id: roomIdProperty,
      invite_id: { type: 'string', minLength: 1, description: 'Recorded invite identifier.' },
    }, ['room_id', 'invite_id']),
    result: 'The updated room record with the invite marked revoked.',
    example: { room_id: EXAMPLE_ROOM_ID, invite_id: 'inv-01' },
  },
  {
    method: 'room.recover',
    summary: 'Recover unusable invitations',
    description: 'Mints recovery invitations for requirements whose secret can no longer admit a '
      + 'seat. Each recovery must be confirmed before it replaces the original.',
    params: params({ room_id: roomIdProperty }, ['room_id']),
    result: 'The list of recovery invite receipts, each carrying `recovery_of`.',
    example: { room_id: EXAMPLE_ROOM_ID },
  },
  {
    method: 'room.recover.confirm',
    summary: 'Confirm a recovery invitation',
    description: 'Confirms that a recovery invitation was handed over, retiring the invitation '
      + 'requirement it recovers.',
    params: params({
      room_id: roomIdProperty,
      recovery_of: { type: 'string', minLength: 1, description: 'Invite id being recovered.' },
      invite_id: { type: 'string', minLength: 1, description: 'Recovery invite id to confirm.' },
    }, ['room_id', 'recovery_of', 'invite_id']),
    result: 'The updated room record with the confirmed recovery.',
    example: { room_id: EXAMPLE_ROOM_ID, recovery_of: 'inv-01', invite_id: 'inv-02' },
  },
  {
    method: 'room.list',
    summary: 'List rooms',
    description: 'Lists every room held on this host. Takes no parameters.',
    params: params({}, []),
    result: 'An array of room records.',
    example: {},
  },
  {
    method: 'room.show',
    summary: 'Show one room',
    description: 'Returns the complete durable record for one room.',
    params: params({ room_id: roomIdProperty }, ['room_id']),
    result: 'The room record.',
    example: { room_id: EXAMPLE_ROOM_ID },
  },
  {
    method: 'room.participants',
    summary: 'List participants',
    description: 'Returns the room\'s seats, including pending, active, and removed states.',
    params: params({ room_id: roomIdProperty }, ['room_id']),
    result: 'An array of seat records.',
    example: { room_id: EXAMPLE_ROOM_ID },
  },
  {
    method: 'room.history',
    summary: 'Read room history',
    description: 'Reads one page of the room\'s ordered communication archive. The operator view '
      + 'returns every record kind; the participant view returns message records only, with '
      + 'routing identities removed and authors reduced to alias form in anonymous rooms.',
    params: params({
      room_id: roomIdProperty,
      after: {
        type: 'integer',
        minimum: 0,
        description: 'Return records with a sequence number greater than this value.',
      },
      limit: { type: 'integer', minimum: 1, description: 'Maximum number of records to return.' },
      view: {
        type: 'string',
        enum: ['operator', 'participant'],
        description: 'History projection. Defaults to the operator view.',
      },
    }, ['room_id']),
    result: 'An array of communication records, byte-bounded to one page.',
    example: { room_id: EXAMPLE_ROOM_ID, after: 0, limit: 50, view: 'operator' },
  },
  {
    method: 'room.message',
    summary: 'Post an operator message',
    description: 'Appends an operator message to the room archive and relays it to active seats. '
      + 'Authorship is assigned by the daemon.',
    params: params({
      room_id: roomIdProperty,
      text: missionTextProperty('Message text'),
    }, ['room_id', 'text']),
    result: 'The appended message record with its `seq` and `record_id`.',
    example: { room_id: EXAMPLE_ROOM_ID, text: 'Standup at 10:00.' },
  },
  {
    method: 'room.close',
    summary: 'Close a room',
    description: 'Closes the room forward-only. The plaintext local archive is left in place.',
    params: params({ room_id: roomIdProperty }, ['room_id']),
    result: 'The closed room record.',
    example: { room_id: EXAMPLE_ROOM_ID },
  },
  {
    method: 'room.delete',
    summary: 'Delete a room',
    description: 'Removes this host\'s local room state after the room is closed. The scope is '
      + 'this host only.',
    params: params({
      room_id: roomIdProperty,
      confirm: { type: 'boolean', const: true, description: 'Must be `true`.' },
    }, ['room_id', 'confirm']),
    result: 'A delete receipt: `{ "version": 1, "room_id": "...", "deleted": true, '
      + '"scope": "this_host" }`.',
    example: { room_id: EXAMPLE_ROOM_ID, confirm: true },
  },
];

/** `room.briefing.role.set` -> `RoomBriefingRoleSet`. */
function schemaBaseName(method: string): string {
  return method.split('.').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

const RPC_ERROR_CODES: readonly (readonly [string, string])[] = [
  ['invalid_json', 'The request body was not valid JSON.'],
  ['invalid_request', 'The RPC envelope did not match the strict envelope schema.'],
  ['invalid_params', 'The `params` object failed method validation.'],
  ['not_found', 'The referenced room or record does not exist.'],
  ['invalid_state', 'The room is not in a state that permits the operation.'],
  ['shutting_down', 'The daemon stopped accepting work.'],
  ['method_not_found', 'The method is not served over REST.'],
  ['unsupported_media_type', 'The request did not declare `application/json`.'],
  ['forbidden', 'The request origin or Host header was not the loopback console origin.'],
  ['request_too_large', 'The request body exceeded 1 MiB.'],
  ['internal', 'The daemon failed to complete the operation.'],
];

function errorResponseSpec(description: string, codes: readonly string[]): JsonSchema {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/RpcErrorResponse' },
        example: {
          version: 1,
          id: 'req-1',
          error: { code: codes[0], message: 'see the daemon response for detail' },
        },
      },
    },
  };
}

function documentResponseSpec(description: string, mediaType: string): JsonSchema {
  return { description, content: { [mediaType]: { schema: { type: 'string' } } } };
}

/**
 * Build the OpenAPI 3.1 document for the room-management REST API.
 *
 * The server URL is relative so the document stays correct whichever loopback
 * authority and REST port the daemon was configured with.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const schemas: Record<string, JsonSchema> = {
    RpcId: {
      description: 'Caller-chosen correlation id echoed in the response.',
      oneOf: [
        { type: 'string', minLength: 1, maxLength: 256 },
        { type: 'integer', minimum: 0 },
      ],
    },
    RpcError: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: RPC_ERROR_CODES.map(([code]) => code),
          description: RPC_ERROR_CODES.map(([code, text]) => `\`${code}\`: ${text}`).join(' '),
        },
        message: { type: 'string', description: 'Human-readable detail. Not machine-parsed.' },
      },
    },
    RpcSuccessResponse: {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'id', 'result'],
      properties: {
        version: { type: 'integer', const: 1 },
        id: { $ref: '#/components/schemas/RpcId' },
        result: {
          description: 'Method-specific result. See the individual method descriptions.',
        },
      },
    },
    RpcErrorResponse: {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'id', 'error'],
      properties: {
        version: { type: 'integer', const: 1 },
        id: {
          description: 'The request id, or null when it could not be recovered from the body.',
          oneOf: [{ $ref: '#/components/schemas/RpcId' }, { type: 'null' }],
        },
        error: { $ref: '#/components/schemas/RpcError' },
      },
    },
  };

  const requestSchemaNames: string[] = [];
  const discriminatorMapping: Record<string, string> = {};
  for (const entry of ROOM_RPC_METHODS) {
    const base = schemaBaseName(entry.method);
    const paramsName = `${base}Params`;
    const requestName = `${base}Request`;
    schemas[paramsName] = { ...entry.params, description: `Parameters for \`${entry.method}\`.` };
    schemas[requestName] = {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'id', 'method', 'params'],
      title: entry.summary,
      description: `${entry.description}\n\nResult: ${entry.result}`,
      properties: {
        version: { type: 'integer', const: 1 },
        id: { $ref: '#/components/schemas/RpcId' },
        method: { type: 'string', const: entry.method },
        params: { $ref: `#/components/schemas/${paramsName}` },
      },
      examples: [{ version: 1, id: 'req-1', method: entry.method, params: entry.example }],
    };
    requestSchemaNames.push(requestName);
    discriminatorMapping[entry.method] = `#/components/schemas/${requestName}`;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'ours-cowork room management API',
      version: API_VERSION,
      summary: 'Loopback REST control surface for cowork mission rooms.',
      description: [
        'Every room-management operation is carried by a single REST route, `POST /rpc`, using '
        + 'the versioned RPC envelope `{ "version": 1, "id": ..., "method": ..., "params": ... }`. '
        + 'The `method` field selects the operation; the request schemas below are discriminated '
        + 'on it.',
        '',
        'The listener binds `127.0.0.1` only and has no authentication, so it accepts requests '
        + 'whose `Host` header is `127.0.0.1:<port>` or `localhost:<port>`, rejects cross-site '
        + 'fetches, and must not be exposed to other hosts through forwarding or a proxy.',
        '',
        'Requests must declare `Content-Type: application/json` and stay within 1 MiB. Operations '
        + 'that need an invite secret are not served here: they are reachable only over the '
        + 'daemon\'s private Unix socket.',
      ].join('\n'),
      license: { name: 'FSL-1.1-Apache-2.0' },
    },
    servers: [{ url: '/', description: 'This cowork daemon, on its loopback REST port.' }],
    tags: [
      { name: 'rooms', description: 'Room management over the RPC envelope.' },
      { name: 'documentation', description: 'The API description and its browser UI.' },
    ],
    paths: {
      [RPC_PATH]: {
        post: {
          tags: ['rooms'],
          operationId: 'roomManagementRpc',
          summary: 'Invoke a room-management method',
          description: 'Dispatches one room-management method. The HTTP status reflects the '
            + 'envelope outcome: 200 on success, 404 when the method is not served over REST, '
            + '500 on an internal failure, and 400 for every other error code — including '
            + '`not_found`.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: requestSchemaNames.map((name) => ({ $ref: `#/components/schemas/${name}` })),
                  discriminator: { propertyName: 'method', mapping: discriminatorMapping },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'The method completed. `result` is method-specific.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RpcSuccessResponse' },
                },
              },
            },
            400: errorResponseSpec(
              'The envelope, parameters, or room state rejected the call.',
              ['invalid_params', 'invalid_json', 'invalid_request', 'not_found', 'invalid_state',
                'shutting_down'],
            ),
            403: errorResponseSpec(
              'The Host header was not a loopback console authority, the Origin did not match it, '
              + 'or the fetch was cross-site.',
              ['forbidden'],
            ),
            404: errorResponseSpec(
              'The method is not part of the REST route table.',
              ['method_not_found'],
            ),
            413: errorResponseSpec('The request body exceeded 1 MiB.', ['request_too_large']),
            415: errorResponseSpec(
              'The request did not declare `application/json`.',
              ['unsupported_media_type'],
            ),
            500: errorResponseSpec('The daemon failed to complete the operation.', ['internal']),
          },
        },
      },
      [OPENAPI_DOCUMENT_PATH]: {
        get: {
          tags: ['documentation'],
          operationId: 'getOpenApiDocument',
          summary: 'Fetch this OpenAPI document',
          description: 'Returns the OpenAPI 3.1 description of the room-management REST API.',
          responses: {
            200: {
              description: 'The OpenAPI document.',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      [API_DOCS_PATH]: {
        get: {
          tags: ['documentation'],
          operationId: 'getApiDocsPage',
          summary: 'Open the API documentation UI',
          description: `Serves the browser UI that renders \`${OPENAPI_DOCUMENT_PATH}\`.`,
          responses: { 200: documentResponseSpec('The documentation page.', 'text/html') },
        },
      },
      [API_DOCS_SCRIPT_PATH]: {
        get: {
          tags: ['documentation'],
          operationId: 'getApiDocsScript',
          summary: 'Fetch the documentation UI script',
          responses: { 200: documentResponseSpec('The UI script.', 'text/javascript') },
        },
      },
      [API_DOCS_STYLESHEET_PATH]: {
        get: {
          tags: ['documentation'],
          operationId: 'getApiDocsStylesheet',
          summary: 'Fetch the documentation UI stylesheet',
          responses: { 200: documentResponseSpec('The UI stylesheet.', 'text/css') },
        },
      },
    },
    components: { schemas },
  };
}

const DOCS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ours-cowork room management API</title>
<link rel="stylesheet" href="${API_DOCS_STYLESHEET_PATH}">
</head>
<body>
<main id="api-docs" data-document="${OPENAPI_DOCUMENT_PATH}" data-rpc="${RPC_PATH}">
<p class="loading">Loading <code>${OPENAPI_DOCUMENT_PATH}</code>&hellip;</p>
</main>
<script src="${API_DOCS_SCRIPT_PATH}"></script>
</body>
</html>
`;

const DOCS_STYLESHEET = `:root { color-scheme: light dark; --line: #8883; --accent: #2563eb; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
main { margin: 0 auto; max-width: 60rem; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
code, pre, textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
pre { background: #8881; border-radius: 6px; margin: 0; overflow-x: auto; padding: .6rem .75rem; }
.subtitle { color: #8889; margin: 0 0 1rem; }
.intro { border-left: 3px solid var(--accent); padding-left: .9rem; white-space: pre-wrap; }
.route { border: 1px solid var(--line); border-radius: 8px; margin-bottom: .5rem; padding: .6rem .8rem; }
.verb { background: var(--accent); border-radius: 4px; color: #fff; font-size: .72rem;
  font-weight: 700; letter-spacing: .04em; margin-right: .5rem; padding: .12rem .4rem; }
details.method { border: 1px solid var(--line); border-radius: 8px; margin-bottom: .5rem; }
details.method > summary { cursor: pointer; padding: .6rem .8rem; }
details.method[open] > summary { border-bottom: 1px solid var(--line); }
summary .name { font-family: ui-monospace, monospace; font-weight: 600; }
summary .summary-text { color: #8889; margin-left: .6rem; }
.body { padding: .8rem; }
.description { margin: 0 0 .8rem; white-space: pre-wrap; }
table { border-collapse: collapse; margin-bottom: .8rem; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: .35rem .5rem; text-align: left;
  vertical-align: top; }
th { font-size: .78rem; letter-spacing: .04em; text-transform: uppercase; }
td.param { font-family: ui-monospace, monospace; white-space: nowrap; }
.required { color: #b91c1c; font-size: .75rem; margin-left: .3rem; }
textarea { border: 1px solid var(--line); border-radius: 6px; padding: .5rem; width: 100%; }
button { background: var(--accent); border: 0; border-radius: 6px; color: #fff; cursor: pointer;
  font: inherit; margin: .5rem 0; padding: .4rem 1rem; }
.status { font-weight: 600; margin: .5rem 0 .35rem; }
.status.failed { color: #b91c1c; }
.error { color: #b91c1c; }
`;

const DOCS_SCRIPT = `'use strict';
(function () {
  var root = document.getElementById('api-docs');
  var documentUrl = root.dataset.document;
  var rpcUrl = root.dataset.rpc;

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function resolveRef(spec, ref) {
    return ref.replace(/^#\\//, '').split('/').reduce(function (node, part) {
      return node === undefined ? undefined : node[part];
    }, spec);
  }

  function typeLabel(schema) {
    if (!schema) return 'any';
    if (schema.const !== undefined) return JSON.stringify(schema.const);
    if (schema.enum) return schema.enum.map(function (value) { return JSON.stringify(value); }).join(' | ');
    return schema.type || 'any';
  }

  function parameterTable(schema) {
    var properties = (schema && schema.properties) || {};
    var names = Object.keys(properties);
    if (names.length === 0) return element('p', 'description', 'No parameters.');
    var required = (schema && schema.required) || [];
    var table = document.createElement('table');
    var head = table.insertRow();
    ['Parameter', 'Type', 'Description'].forEach(function (label) {
      head.appendChild(element('th', null, label));
    });
    names.forEach(function (name) {
      var property = properties[name];
      var row = table.insertRow();
      var cell = element('td', 'param', name);
      if (required.indexOf(name) >= 0) cell.appendChild(element('span', 'required', 'required'));
      row.appendChild(cell);
      row.appendChild(element('td', null, typeLabel(property)));
      row.appendChild(element('td', null, property.description || ''));
    });
    return table;
  }

  function tryItPanel(example) {
    var panel = document.createElement('div');
    var input = document.createElement('textarea');
    input.rows = Math.min(14, JSON.stringify(example, null, 2).split('\\n').length + 1);
    input.value = JSON.stringify(example, null, 2);
    input.setAttribute('aria-label', 'Request body');
    var send = element('button', null, 'Send request');
    var output = document.createElement('div');
    send.addEventListener('click', function () {
      var body = input.value;
      try { JSON.parse(body); } catch (error) {
        output.textContent = '';
        output.appendChild(element('p', 'status failed', 'Request body is not valid JSON.'));
        return;
      }
      send.disabled = true;
      output.textContent = '';
      output.appendChild(element('p', 'status', 'Sending\\u2026'));
      fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
      }).then(function (response) {
        return response.text().then(function (text) { return { status: response.status, text: text }; });
      }).then(function (result) {
        var pretty = result.text;
        try { pretty = JSON.stringify(JSON.parse(result.text), null, 2); } catch (error) { /* raw */ }
        output.textContent = '';
        output.appendChild(element(
          'p',
          result.status === 200 ? 'status' : 'status failed',
          'HTTP ' + result.status
        ));
        output.appendChild(element('pre', null, pretty));
      }).catch(function (error) {
        output.textContent = '';
        output.appendChild(element('p', 'status failed', 'Request failed: ' + error));
      }).then(function () { send.disabled = false; });
    });
    panel.appendChild(element('h3', null, 'Try it'));
    panel.appendChild(input);
    panel.appendChild(send);
    panel.appendChild(output);
    return panel;
  }

  function methodPanel(spec, ref) {
    var schema = resolveRef(spec, ref);
    var method = schema.properties.method.const;
    var panel = element('details', 'method');
    var summary = document.createElement('summary');
    summary.appendChild(element('span', 'name', method));
    summary.appendChild(element('span', 'summary-text', schema.title || ''));
    panel.appendChild(summary);
    var body = element('div', 'body');
    body.appendChild(element('p', 'description', schema.description || ''));
    body.appendChild(parameterTable(resolveRef(spec, schema.properties.params.$ref)));
    body.appendChild(tryItPanel((schema.examples && schema.examples[0]) || {
      version: 1, id: 'req-1', method: method, params: {},
    }));
    panel.appendChild(body);
    return panel;
  }

  function renderRoutes(spec) {
    var section = document.createDocumentFragment();
    Object.keys(spec.paths).forEach(function (path) {
      Object.keys(spec.paths[path]).forEach(function (verb) {
        var operation = spec.paths[path][verb];
        var route = element('div', 'route');
        var heading = document.createElement('div');
        heading.appendChild(element('span', 'verb', verb.toUpperCase()));
        heading.appendChild(element('code', null, path));
        route.appendChild(heading);
        route.appendChild(element('p', 'description', operation.summary || ''));
        section.appendChild(route);
      });
    });
    return section;
  }

  function render(spec) {
    root.textContent = '';
    root.appendChild(element('h1', null, spec.info.title));
    root.appendChild(element('p', 'subtitle', 'API version ' + spec.info.version + ' \\u00b7 OpenAPI ' + spec.openapi));
    root.appendChild(element('p', 'intro', spec.info.description || ''));
    root.appendChild(element('h2', null, 'Routes'));
    root.appendChild(renderRoutes(spec));
    root.appendChild(element('h2', null, 'Room management methods'));
    var alternatives = spec.paths[rpcUrl].post.requestBody.content['application/json'].schema.oneOf;
    alternatives.forEach(function (alternative) {
      root.appendChild(methodPanel(spec, alternative.$ref));
    });
  }

  fetch(documentUrl).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }).then(render).catch(function (error) {
    root.textContent = '';
    root.appendChild(element('p', 'error', 'Could not load ' + documentUrl + ': ' + error));
  });
}());
`;

export interface ApiDocsAsset {
  readonly body: string;
  readonly contentType: string;
}

/** Resolve one of the read-only documentation assets, or undefined for any other path. */
export function apiDocsAsset(pathname: string): ApiDocsAsset | undefined {
  switch (pathname) {
    case OPENAPI_DOCUMENT_PATH:
      return {
        body: `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`,
        contentType: 'application/json; charset=utf-8',
      };
    case API_DOCS_PATH:
      return { body: DOCS_PAGE, contentType: 'text/html; charset=utf-8' };
    case API_DOCS_SCRIPT_PATH:
      return { body: DOCS_SCRIPT, contentType: 'text/javascript; charset=utf-8' };
    case API_DOCS_STYLESHEET_PATH:
      return { body: DOCS_STYLESHEET, contentType: 'text/css; charset=utf-8' };
    default:
      return undefined;
  }
}
