# Consumer-defined Cowork commands

Status: proposal for Owner review; no consumer extensibility implemented. Critic review is not Owner approval.

Baseline: ours-cowork `76753c13e009ba7ea585b3a9c8c8e27444234e5c`, SDK 3.7.0. Part 1 extracts fixed service routes and expands the room's ours catalog. This document describes a possible later change.

## Intent and feasibility

Consumers should define a room operation once and invoke it through CLI, REST or ours, without adding a built-in to Cowork. Both REST registration and local definition files are feasible. Neither a JSON definition nor registration alone supplies executable business logic: an operator must also provide a handler.

The SDK already registers a catalog of `{name, description, input_schema}` with in-process handlers and authenticates command callers by CID. Cowork already persists per-room CID and role grants. However, its command-name enum is currently fixed, its management routes are static, and handlers run while intake owns the room lock. Dynamic names, persistent registrations, loading, handler invocation and catalog reconciliation all require future implementation. SDK catalog registration replaces the complete catalog; additions must preserve built-ins and all accepted consumer definitions.

## Proposed smallest viable design

Use one versioned JSON definition format and one registry service for both sources. Initially support **composition of existing built-ins**. A handler reference identifies a Cowork built-in plus a declarative argument mapping; no shell, JavaScript upload, dynamic import, arbitrary URL or process execution. This supports consumer-specific names, defaults and constrained workflows using existing operations. It does not provide arbitrary new business logic.

For genuinely new business logic, a later, separately approved option can invoke an operator-installed handler keyed by an opaque handler ID. The operator provisions and reviews that implementation outside REST. Both registration sources resolve that same ID. That option needs an isolation and timeout contract before implementation; a definition file must never double as executable code.

The Owner needs to choose whether built-in composition satisfies the first version. If arbitrary custom business logic is essential immediately, the operator-installed handler option becomes required scope, not something registration can magically provide.

### Example definition

```json
{
  "version": 1,
  "name": "consumer.acme.set-phase",
  "description": "Set the current phase of this room.",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["phase"],
    "properties": { "phase": { "type": "string", "enum": ["design", "build", "review"] } }
  },
  "handler": {
    "kind": "builtin",
    "command": "room.settings",
    "arguments": { "status": { "input": "phase" } }
  }
}
```

Argument mapping supports only literal JSON values and references to explicitly declared top-level inputs. No expression language, template evaluation, recursion or implicit copying of arguments. The target must be an eligible room-scoped built-in. Reject unknown fields and reject caller-selected `room_id`. Resolve the room from the authenticated invocation endpoint. The service validates both the public schema and the mapped built-in input.

For a future installed handler, replace the handler object with an approved shape such as `{ "kind": "installed", "id": "acme.phase.v1" }`. A missing handler ID is a registration error. REST cannot install its implementation or choose a path/URL. Handlers receive immutable parsed arguments, authenticated caller context and narrow room services, never the raw daemon client or filesystem credentials. This is a proposal requiring further design, not a sandbox claim.

## Registration surfaces

REST uses the existing loopback management RPC transport rather than introducing a separate HTTP authentication model:

- `command.definition.put`: `{room_id, definition, expected_revision}`; validates and creates/replaces a REST-owned definition. Initial creation requires revision 0. Return the committed definition revision and effective catalog state.
- `command.definition.list`: room-scoped definitions, origin, revision and publication state, excluding secrets (definitions may not contain credentials).
- `command.definition.delete`: `{room_id, name, expected_revision}`; removes only a REST-owned definition.
- Future CLI adapters call these same methods. Invocation uses `room.command.invoke` with `{room_id, name, arguments}` over CLI/REST. Ours publishes the individual names and invokes the same registry service using its authenticated room/CID context.

Names are illustrative and not implemented routes. Registrar access is host management authority, consistent with today's Unix socket and loopback management listener. If REST is ever exposed beyond the current host boundary, explicit authentication and authorization must precede registration support; loopback is not a multi-user access-control system.

Local configuration adds an explicit directory path, for example `command_definitions_dir`, containing regular `.json` files. Each file contains `{version:1, room_id, definitions:[...]}`. Do not scan the working directory or accept uploaded paths. Validate file ownership/permissions appropriate to the daemon account, reject symlinks, bound file count and total bytes, and validate the whole candidate generation before replacing anything. Suggested initial bounds: 64 consumer definitions per room, 64 KiB per file, 1 MiB per complete generation, schema nesting depth 16. These are proposed limits to validate against SDK catalog capacity.

Initial loading happens at daemon startup. An explicit host-management reload operation is preferable to a filesystem watcher in version one. Startup/reload and REST put share exactly the same schema, handler resolution, name and collision checks. They differ only in ownership and persistence.

## Invocation authority

Registration is not an invocation grant. New definitions start with no CID or role grants. An active room seat must have a current exact grant for the consumer name. Built-in composition additionally requires the current grant for its target built-in: a wrapper cannot turn a harmless-looking name into policy administration, room authorship or a confidential room snapshot without that underlying authority. A host management invocation retains existing management authority.

Do not derive permission from display names, role labels such as “Owner”, the registration author, definition contents or advertised catalog presence. Resolve roles from current seat state and configured grants. Removed seats lose invocation authority. Roles configured by a host operator may grant consumer names; arbitrary registrants cannot edit grants through definition fields.

Built-ins that administer command policy, speak as the room or another registered role, or return operator-private data require explicit review before allowing composition. Proposal: exclude these targets from initial composition even if directly invocable as fixed built-ins. This limits the first version; Owner may choose a broader policy explicitly.

A successful definition replacement changes executable meaning. Therefore invalidate its existing invocation grants atomically on replacement, or bind grants to a definition revision. Proposal: revision-bound grants; callers reauthorize the new revision. Delete also removes grants. Definitions do not mutate built-in grants.

## Validation, collisions and persistence

Reserve all built-in names and `room.*`; require consumer names under `consumer.<namespace>.<name>`, bounded to 128 portable ASCII characters. Namespace is organizational, not proof of identity. Reject case-folding aliases and duplicate names; no implicit overwrite or source precedence.

REST registrations are persisted as versioned room state with origin and revision. Local files are the source of truth for local definitions; keep an effective validated snapshot and source revision/hash in room state for inspection and recovery. REST cannot overwrite or delete a locally owned name. Local reload refuses a collision with a REST-owned name, and a second local file defining the same name rejects the entire generation. Explicit source migration requires removing the old registration and reauthorizing the new one.

Compile/validate schemas at registration with bounded complexity, no remote references and no network resolution. Registration must reject incompatible schemas, reserved field mappings, missing targets, recursive consumer targets and unsupported handler kinds before committing state. Validation is repeated at invocation; SDK sender-side validation is useful but is not the trust boundary.

Commit the desired definition generation durably, then publish the complete SDK catalog. These are not one atomic transaction. If publication fails, retain desired state with `publication_pending`, fail closed for affected new/replaced names and report the concrete pending revision. Retry catalog reconciliation on bounded recovery/startup. Never claim registration is ready merely because metadata committed. Unchanged built-ins remain available. Removal disables dispatch before catalog withdrawal; stale peer catalogs cannot invoke removed definitions. On startup, do not publish consumer names until definitions and handlers validate.

A malformed local reload leaves the last valid generation effective and returns errors; it does not apply a partial directory. A malformed startup generation leaves consumer commands unavailable with a clear management status; built-ins may start independently. Missing files during an explicit successful reload remove their local definitions and grants. Protect in-flight execution using an immutable accepted revision: deletion/replacement prevents new calls, while an already authorized invocation finishes under its captured revision. Document the timing; revocation is not cancellation of a committed effect.

## Execution, errors and transport limits

All transports call the registry's validation/authorization/dispatch path. Preserve built-in state validation, locking and effects. Preserve Part 1's intake-owned execution for composed built-ins, with nested drains deferred until the command finishes; registration must not recursively invoke intake. This proposal adds no execution scheduler. No command runs an unbounded consumer loop while holding the room mutex.

Composition is one built-in call in version one; no transaction across a sequence of effects, automatic compensation, background jobs or retry workflow. Return correlated success/error results, with bounded public diagnostics. Registration errors identify field and reason but never credentials or filesystem contents. Handler failures must not manufacture a successful business result.

A request or reply can be lost after an effect commits. Do not promise exactly-once execution based on a wire ID. Reuse a built-in's existing idempotent semantics where applicable; otherwise callers inspect current state before retrying. Installed handlers, if approved, must define their own idempotency and cancellation contracts.

Verify advertised catalog, request and result size limits against the exact SDK/core release before selecting registration bounds. Large histories, files and room snapshots may need pagination or a retrieval artifact; returning a small “too large” error after a mutation is not evidence that the mutation did not happen. Dynamic handlers must declare bounded output and must not quietly truncate success values.

## Owner decisions and review gates

1. Is one-call built-in composition sufficient, or are operator-installed custom handlers required in the first release?
2. Approve the proposed source ownership, explicit reload and revision-bound grant behavior.
3. Approve eligible built-in targets and invocation policy; initial exclusion of policy administration and privileged authorship/data is a proposal.
4. Approve bounds after validating SDK catalog/result capacity and workload examples.

Before future implementation acceptance, test the same definition through REST and local loading; duplicate/reserved names; stale revisions; removed callers; target-grant refusal; definition replacement revocation; restart and publication failure recovery; malformed local generations; deletion with stale peer catalogs; bounded errors; and equivalent CLI/REST/ours outcomes. If installed handlers are added, independently review isolation, resource budgets and failure recovery first.
