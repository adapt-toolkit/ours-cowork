# Consumer commands over ours

## Status and scope

The Owner authorized this implementation as a separate PR after reviewing the two-service callback workflow. This branch builds on the shared-command PR. Consumers register definitions through Cowork REST or a local file; discovery and execution are through the ours command catalog. There is no consumer command execution endpoint or new CLI execution command.

The consumer runs its own HTTP service. Cowork validates the incoming ours request, checks room membership and an exact command grant, sends one authenticated callback, and returns the consumer result in the correlated ours command reply. No consumer code is loaded into Cowork.

Runtime catalog updates require the released SDK 3.7.2 and shared daemon provided by ours CLI 2.7.2 (catalog protocol 11). Older peers may need their own SDK/daemon upgrade to discover later additions. Updating the Cowork npm dependency alone does not upgrade an already-running shared daemon. When consumer configuration is enabled, startup checks the daemon SDK release, rejecting versions below 3.7.2, prereleases and unknown version strings. The daemon control API protocol number is unrelated to catalog support.

## Two-service setup

1. The consumer implements a POST endpoint and creates a random bearer token. It must verify `Authorization: Bearer <token>` before processing the request, rejecting missing or incorrect credentials. Use HTTPS for remote callbacks; HTTP is accepted only for literal loopback hosts.
2. The Cowork host configures an exact destination and a private credential path. Consumers cannot introduce arbitrary URLs through registration. For example, extend the normal Cowork configuration with:

```json
{
  "consumer_commands": {
    "handlers": [{
      "id": "orders",
      "url": "https://consumer.example/cowork/orders",
      "token_file": "/home/cowork/private/orders.token"
    }],
    "timeout_ms": 5000,
    "definitions_file": "/home/cowork/private/commands.json"
  }
}
```

`definitions_file` is optional. The credential directory must already exist, be owned by the Cowork process user and have mode 0700. An existing token file must be owner-owned, mode 0600 and at most 4096 bytes. Missing credentials allow startup but disable callback execution until provisioned. Configuration changes to destinations require restarting the application through the normal operator process.

3. The consumer supplies its token through management RPC `consumer.handler.credential.set`, with params `{ "handler": "orders", "token": "<consumer-generated-token>" }`. Cowork writes the secret atomically to the selected private file. The result contains only `{ "handler": "orders", "configured": true }`. The same operation rotates the credential; subsequent callbacks use the new value. A callback already in flight can use the previous credential, so coordinate a short overlap on the consumer side. Restart loads the persisted credential. Alternatively, the operator can provision the consumer's token directly into the private file before startup.

The existing Cowork REST management surface is loopback-only with Host/Origin checks, not a new token-authenticated public API. A consumer on another host needs an operator-provided authenticated private tunnel or HTTPS gateway to this management surface. Do not expose the loopback management API directly. Gateway authentication and request-body redaction remain deployment responsibilities. The callback bearer token authenticates Cowork to the consumer; it does not grant management access to Cowork.

4. Read `room.command.definition.list` with `{ "room_id": "<room>" }` to obtain `revision`, then register:

```json
{
  "version": 1,
  "id": "register-orders",
  "method": "room.command.definition.put",
  "params": {
    "room_id": "<room>",
    "expected_revision": 0,
    "definition": {
      "name": "consumer.orders",
      "description": "Look up an order",
      "handler": "orders",
      "input_schema": {
        "type": "object",
        "properties": { "id": { "type": "integer" } },
        "required": ["id"],
        "additionalProperties": false
      }
    }
  }
}
```

All management calls use the existing `POST /rpc` version-1 envelope. The definition contains only public metadata and a handler ID, never a credential or destination URL. Publication adds the command beside the built-ins in that room's ours catalog. Discovery does not grant invocation permission.

5. Grant `consumer.orders` to an active authenticated CID with `room.command.grant`, or to an exact role with `room.command.role.set`. Existing CLI grant operations also accept registered consumer command names. Unknown names cannot be granted. Only active room members with a current exact CID or role grant can execute the callback.
6. A participant invokes `consumer.orders` over ours with `{ "id": 42 }`. Cowork sends:

```json
{
  "version": 1,
  "command": "consumer.orders",
  "registration_revision": 1,
  "request_id": "<authenticated SDK request wire ID>",
  "room_id": "<receiving room>",
  "caller_cid": "<authenticated sender CID>",
  "arguments": { "id": 42 }
}
```

The callback includes `Content-Type: application/json` and the consumer-provisioned Authorization header. Routing and context come from Cowork and the SDK, not caller arguments. The trusted consumer receives the real caller CID, including for an anonymous room; room relay aliases are not callback identities. The handler may call Cowork's protected management REST interface using its separately authorized access. Cowork holds no room mutex while awaiting HTTP; one SDK reader per room preserves command/message ordering.

7. The consumer returns HTTP 2xx with JSON `{ "ok": true, "result": { "order": 42 } }` or `{ "ok": false, "error": "order_not_found" }`. A result may be any JSON value, including null. Cowork returns that envelope as the SDK handler result. The SDK adds its normal outer result envelope and reply correlation.

## Local definitions

The optional owner-private JSON file supplies an entire generation:

```json
{
  "version": 1,
  "rooms": [{
    "room_id": "<room>",
    "commands": [{
      "name": "consumer.orders",
      "description": "Look up an order",
      "handler": "orders",
      "input_schema": {
        "type": "object",
        "properties": { "id": { "type": "integer" } },
        "required": ["id"],
        "additionalProperties": false
      }
    }]
  }]
}
```

Replace the file atomically, then call `room.command.definition.reload` for each affected hosted room. The complete file is validated before any selected-room change. Invalid JSON/schema, duplicate names/rooms, unknown handlers, and collisions with REST definitions reject the reload and preserve the previous generation. Startup also validates the complete file and fails if it is invalid. This is explicit reload, not a file watcher or an all-room transaction.

Local definitions own their names. REST cannot replace/delete them. Remove or change them in the file and reload. Unchanged local definitions retain grants. Changed or removed definitions clear both CID and role grants for their names. Removing the file setting makes the next startup/reload remove previously stored local definitions. REST definitions remain durable room metadata across restart.

## Registry consistency

A room has a monotonically increasing `revision`. REST put/delete require `expected_revision`; stale writers fail. Every REST replacement clears the name's grants, including a same-content replacement. Use list first and grant again deliberately after a change. Delete uses `room.command.definition.delete` with room ID, current revision and name.

Desired definitions and grant removal are saved together before catalog publication. Responses report `published: false` if SDK publication failed after commit. Do not repeat the mutation blindly: inspect list and retry `room.command.definition.reload`. Consumer execution fails closed while publication is pending. Startup republishes the durable generation. Old catalog entries cannot bypass current membership, definition existence, current publication status or grants. An invocation authorized before a change may complete using its captured definition and credential; deletion does not cancel an already started remote operation.

## Validation and failure behavior

- Names use the reserved `consumer.` namespace and lowercase letters, digits, dots and hyphens, at most 128 characters. Built-in names cannot collide. Each room allows 64 consumer definitions; the configuration allows 64 handler references and the local file 256 room entries.
- Input schemas are bounded to 16 KiB and depth 16, with a top-level object and `additionalProperties: false`. Strict Ajv validation runs before HTTP. External references, schema IDs, async schemas, regex patterns and format execution are unsupported. The current conservative schema traversal reserves those keyword names throughout the schema document, including property maps. Arguments are bounded to 64 KiB. Validator caching is bounded and compiler instances do not share an accumulating schema registry.
- Destinations are exact host-selected URLs. URL credentials, queries, fragments, non-HTTPS remote destinations and redirects are refused. The callback token is never advertised or placed in room metadata, arguments, normal API results or generated error messages. Trusted consumers must also avoid returning their own secrets in results.
- One HTTP attempt is made per handler invocation. A configurable 100–30000 ms timeout (default 5000) covers headers and response streaming. Responses must be JSON and at most 256 KiB. This limit applies to the new callback protocol, not shared built-in service results.
- Timeout, HTTP refusal, network failure and malformed/oversized responses return a specific consumer error with `execution: "unknown"`. A remote side effect may already have happened. Cowork does not automatically retry HTTP. The consumer should deduplicate durable effects by `request_id`; this is not an exactly-once execution guarantee.
- Consumer-returned `{ok:false,error}` values are delivered unchanged. Failure does not prevent a later independent command from executing. SDK delivery limits and transport failures still apply to the final correlated reply.

## Review boundary

This document describes the separate implementation branch. Tests exercise credential provisioning/rotation and restart loading, default-deny grants, replacement/delete/reload/publication failure, schema and response validation, single-reader intake, and a real SDK command whose HTTP callback reenters Cowork REST. Test results and Critic verdict are reported separately; this document does not claim Owner approval or production deployment.


## Room lifecycle interaction

The base command surface includes accept, rebind, close and delete. Accepted lifecycle shutdown prevents new consumer invocations. HTTP work already authorized may complete with its captured definition and credential. The single SDK reader executes durable close/delete work after its reply attempt and outside the room mutex; callbacks can still call management REST without waiting on their own reader.

Room deletion erases persisted room definitions and grants together with the room archive, files and metadata. Shared host configuration, the source definitions file and handler credentials are host-managed resources and are not removed by a room deletion. A stale local file entry cannot recreate the deleted room or its identity.
