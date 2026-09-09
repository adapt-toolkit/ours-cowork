# Command surface coverage

Baseline: latest fetched `origin/main` at `76753c13e009ba7ea585b3a9c8c8e27444234e5c` (2026-09-09).

Status: Part 1 review pending final verification and Owner scope resolution. Part 2 specification signed off by Critic as a reviewable proposal, not Owner design approval. Proposed exclusions below await explicit Owner scope resolution; they are not approved omissions.

## Shared dispatch

CLI emits a JSONL RPC request to the private Unix socket. REST uses `POST /rpc`. Both use `createServiceRoutes` in `src/command-routes.ts`, which validates the adapter parameters and calls `RoomService`. This route table was already shared on main, and has been extracted from the HTTP/socket module.

The ours SDK advertises the two existing commands plus 20 shared room operations. A new command uses the same name as its RPC method and the same arguments **without `room_id`**. The receiving room identity supplies the room ID; supplying it is rejected even when it matches. Handlers call that exact route table and service implementation. The two compatibility commands retain their distinct permission and response contracts; removal shares `beginRemovalUnlocked` with operator removal.

## Room operation matrix

All REST entries below mean a method on `POST /rpc`, not a separate REST URL. Each listed room CLI entry is prefixed by `ours-cowork room`.

| CLI | RPC method | Ours command / status |
|---|---|---|
| `create` | `room.create` | Proposed global exclusion, pending Owner |
| `settings` | `room.settings` | `room.settings` |
| `role-briefing --role … --text …` | `room.briefing.role.set` | same |
| `role-briefing --role … --delete` | `room.briefing.role.delete` | same |
| `invite` | `room.invite` | same |
| `accept` | `room.accept` (Unix only; absent from REST) | Proposed secret-input exclusion, pending Owner |
| `remove` | `room.participant.remove` | same; distinct from legacy `remove-member` |
| `revoke` | `room.revoke` | same |
| `recover` | `room.recover` | same |
| `recover --confirm` | `room.recover.confirm` | same |
| `rebind` | `room.rebind` | Deferred room operation, pending Owner |
| `list` | `room.list` | Proposed global exclusion, pending Owner |
| `show` | `room.show` | same |
| `participants` | `room.participants` | same |
| `command-grants` | `room.command.grants` | same |
| `role-command-grants` | `room.command.role.grants` | same |
| `role-command-set` | `room.command.role.set` | same |
| `command-grant` | `room.command.grant` | same |
| `command-revoke` | `room.command.revoke` | same |
| `history` | `room.history` | same; one service page per call |
| `message` | `room.message` | same |
| `say` | `room.say` | same |
| `rest-role add` | `room.role.rest.add` | same |
| `rest-role remove` | `room.role.rest.remove` | same |
| `close` | `room.close` | Deferred room operation, pending Owner |
| `delete` | `room.delete` | Deferred room operation, pending Owner |
| — | — | `list-members`: existing contact-safe roster and membership epoch |
| — | — | `remove-member`: existing stable participant ID, confirm=true, epoch, idempotence and no-self-removal contract |

## Host and transport operations

| CLI / endpoint | Behavior | Proposed boundary (pending Owner) |
|---|---|---|
| `serve`, `start` | Start host supervisor/daemon | Cannot be invoked through an offline room; host process authority |
| `stop`, `restart` | Stop/restart host daemon | Removes command transport; host authority and completion protocol needed |
| `status` / Unix `daemon.status` | Authenticated daemon control-session probe | Host-wide control metadata, not room state |
| Unix `daemon.shutdown` | Capability-bound supervisor shutdown | Private host control; not REST |
| `install-service`, `uninstall-service` | Host systemd/launchd lifecycle | Host OS effects |
| `web` | Open browser and check readiness | Caller-local browser action |
| `docs [topic]`, help, version | Local documentation/formatting | Caller-local presentation |
| `--json` and history `--follow` | Output formatting / client polling | Adapter behaviors, not business operations |
| REST `GET /docs`, `/docs/ui.js`, `/docs/ui.css`, `/openapi.json` | Documentation assets | Static representation, not service dispatch |
| Other REST `GET` static web assets | Browser console | Static representation, not business operations |

`room.create/list` cross room boundaries: per-room grants do not establish host-wide authority. `room.accept` reads a secret only through the existing private Unix boundary. `room.close/delete/rebind` act on their own runtime/reply channel; exclusion is a scope proposal rather than a claim of impossibility. Supporting them may require deferred completion or an independent host endpoint. These decisions were requested in the assigned room before treating the inventory as complete.

## Permission and behavior contract

No command is granted by discovery. Each added command requires an exact CID grant or a grant for the caller's current configured role, and an active seat in an active receiving room. Display names never authenticate. Existing grants for `list-members` or `remove-member` grant none of the added commands. Grant administration accepts the expanded fixed name set through CLI and REST.

The following grants are powerful and deliberately distinct:

- `room.command.grant`, `room.command.revoke`, `room.command.role.set` delegate policy administration. A holder can grant additional room capabilities; do not treat these as a single harmless action.
- `room.message` speaks as the room; `room.say` speaks under a registered REST role. Grants authorize that authorship, not the caller's personal voice.
- `room.show`, `room.participants`, `room.history` (operator view) expose the same operator fields as management, including identity and policy metadata. Use `list-members` for the legacy contact-safe projection.
- `room.participant.remove` is the operator-equivalent removal, including CID selection, pending seats, notify and self-removal. It intentionally does not inherit `remove-member`'s epoch/consent restrictions. Removing the caller can prevent its reply delivery; inspect state through a remaining authorized caller before retrying.
- Invite creation/recovery returns invitation material only to the granted caller. Do not put results into room chat or logs.

SDK command transport wraps the returned business value. Added handlers return `{ok:true,result:<service result>}` or `{ok:false,error:<code>}`; the SDK adds its own outer success/result and correlates the wire reply. Codes use management classification (`invalid_params`, `invalid_state`, `not_found`, `internal`) with command gates `invalid_request`, `room_unavailable`, `unauthorized`. Error messages are omitted from remote replies to avoid leaking internal state. Legacy handler shapes are unchanged.

The shared service preserves validation and effects. CLI history may aggregate pages and follow them; ours returns one bounded service page, as REST does. Service results are preserved without a new size adapter or omission response contract. SDK delivery limits still apply: an exact 2 MiB file exceeds the current SDK's 2 MiB envelope budget; a transport-valid 1800 KiB file produced a ~2.4 MiB base64 history result for which no correlated SDK reply arrived in the integration test. Use a smaller history page or management transport for a single large record. CLI/REST remain unchanged. This transport limitation is documented rather than changing result semantics, following Owner scope correction on 2026-09-09. Delivery is best effort and a missing reply does not prove a mutation failed. Consumer command registration, file loading and execution are not implemented.

Intake owns the room mutex during SDK callbacks. A scoped shared service invocation reuses that ownership and catches expected service errors before they poison a nested service lock. The scope expires in `finally`; normal management invocations still lock normally. Intake defers nested pumping while a command executes and relays durable intents after command handling, avoiding recursive SDK drain. Storage mutation failures still propagate through the store's lock accounting.
