# Command surface coverage

Baseline: latest fetched `origin/main` at `76753c13e009ba7ea585b3a9c8c8e27444234e5c` (2026-09-09).

Status: Owner confirmed room-only scope, including accept, rebind, close and delete. The expanded implementation is awaiting fresh Critic review. Host/process operations and global create/list remain excluded. Consumer extensibility is a separate follow-up PR.

Scope evidence: Owner messages `01m22g1pcy8t3ydb9bcp9xwa1y` (room-only scope), `01m22kd1nseyd47cedsanraya3` (all four operations included), and `01m22kjpa4a3kabtskmcf91mf8` (delete closes then erases all local room data; close retains data), on 2026-09-09.

## Shared dispatch

CLI emits a JSONL RPC request to the private Unix socket. REST uses `POST /rpc`. Both use `createServiceRoutes` in `src/command-routes.ts`, which validates the adapter parameters and calls `RoomService`. This route table was already shared on main, and has been extracted from the HTTP/socket module.

The ours SDK advertises the two existing commands plus 24 shared room operations. A new command uses the same name as its RPC method and the same arguments **without `room_id`**. The receiving room identity supplies the room ID; supplying it is rejected even when it matches. Ordinary handlers call that exact route table and service implementation; close/delete persist a request and invoke the same service after the SDK reply attempt. The two compatibility commands retain their distinct permission and response contracts; removal shares `beginRemovalUnlocked` with operator removal.

## Room operation matrix

All REST entries below mean a method on `POST /rpc`, not a separate REST URL. Each listed room CLI entry is prefixed by `ours-cowork room`.

| CLI | RPC method | Ours command / status |
|---|---|---|
| `create` | `room.create` | Excluded: global Cowork management |
| `settings` | `room.settings` | `room.settings` |
| `role-briefing --role … --text …` | `room.briefing.role.set` | same |
| `role-briefing --role … --delete` | `room.briefing.role.delete` | same |
| `invite` | `room.invite` | same |
| `accept` | `room.accept` (Unix only; absent from REST) | `room.accept`; invite input remains absent from REST |
| `remove` | `room.participant.remove` | same; distinct from legacy `remove-member` |
| `revoke` | `room.revoke` | same |
| `recover` | `room.recover` | same |
| `recover --confirm` | `room.recover.confirm` | same |
| `rebind` | `room.rebind` | same |
| `list` | `room.list` | Excluded: global Cowork management |
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
| `close` | `room.close` | same |
| `delete` | `room.delete` | same |
| — | — | `list-members`: existing contact-safe roster and membership epoch |
| — | — | `remove-member`: existing stable participant ID, confirm=true, epoch, idempotence and no-self-removal contract |

## Host and transport operations

| CLI / endpoint | Behavior | Boundary (excluded from room command catalog) |
|---|---|---|
| `serve`, `start` | Start host supervisor/daemon | Cannot be invoked through an offline room; host process authority |
| `stop`, `restart` | Stop/restart host daemon | Removes command transport; host authority and completion protocol needed |
| `status` / Unix `daemon.status` | Authenticated daemon control-session probe | Host-wide control metadata, not room state |
| Unix `daemon.shutdown` | Capability-bound supervisor shutdown | Private host control; not REST |
| `install-service`, `uninstall-service` | Host systemd/launchd lifecycle | Host OS effects |
| `web` | Open browser and check readiness | Caller-local browser action |
| `docs [topic]`, help, version | Local documentation/formatting | Caller-local presentation |
| `--json` and automatic history paging | Output formatting / client pagination | Adapter behaviors, not business operations |
| REST `GET /docs`, `/docs/ui.js`, `/docs/ui.css`, `/openapi.json` | Documentation assets | Static representation, not service dispatch |
| Other REST `GET` static web assets | Browser console | Static representation, not business operations |

`room.create/list` cross room boundaries: per-room grants do not establish host-wide authority. Host/global exclusions are confirmed. `room.accept` uses the existing private route and consumes a supplied invitation without echoing it. It requires its own grant and remains absent from the REST dispatcher. `room.rebind` uses existing name/CID proof and cannot recreate a missing established identity.

## Lifecycle completion

Ours `room.close {}` and `room.delete {"confirm":true}` require separate grants. They durably save `lifecycle_request` before returning an accepted receipt. That receipt means accepted, not completed. After the SDK finishes its reply attempt and intake releases the room lock, the worker invokes shared `closeRoom` or `deleteRoom`. Pending requests resume at daemon startup even if the caller never observed a receipt. Another lifecycle request cannot overwrite pending or failed work.

Close retains metadata, archive and file blobs, removes the live SDK identity, and records `lifecycle_request.state=completed`. Verify completion through management `room.show`: the room is closed and history remains readable. Delete now closes first on every transport, then erases archive, blobs and metadata (including lifecycle state); metadata is removed last so interrupted deletion remains recoverable. Verify deletion through management room absence. CLI/REST wait for their synchronous service result; ours cannot deliver a completed receipt through a destroyed room identity.

Execution failure leaves `state=failed,error=lifecycle_failed` when metadata still exists. Inspect it through management and explicitly retry close/delete after resolving the cause. Final empty-directory deletion residue is cleaned by storage listing without identity recreation. There is no automatic retry of failed requests. Neither missing replies nor accepted receipts prove completion.

## Permission and behavior contract

No command is granted by discovery. Each added command requires an exact CID grant or a grant for the caller's current configured role, and an active seat in an active receiving room. Display names never authenticate. Existing grants for `list-members` or `remove-member` grant none of the added commands. Grant administration accepts the expanded fixed name set through CLI and REST.

The following grants are powerful and deliberately distinct:

- `room.command.grant`, `room.command.revoke`, `room.command.role.set` delegate policy administration. A holder can grant additional room capabilities; do not treat these as a single harmless action.
- `room.message` speaks as the room; `room.say` speaks under a registered REST role. Grants authorize that authorship, not the caller's personal voice.
- `room.show`, `room.participants`, `room.history` (operator view) expose the same operator fields as management, including identity and policy metadata. Use `list-members` for the legacy contact-safe projection.
- `room.participant.remove` is the operator-equivalent removal, including CID selection, pending seats, notify and self-removal. It intentionally does not inherit `remove-member`'s epoch/consent restrictions. Removing the caller can prevent its reply delivery; inspect state through a remaining authorized caller before retrying.
- Invite creation/recovery returns invitation material only to the granted caller. Do not put results into room chat or logs.

SDK command transport wraps the returned business value. Added handlers return `{ok:true,result:<service result>}` or `{ok:false,error:<code>}`; the SDK adds its own outer success/result and correlates the wire reply. Codes use management classification (`invalid_params`, `invalid_state`, `not_found`, `internal`) with command gates `invalid_request`, `room_unavailable`, `unauthorized`. Error messages are omitted from remote replies to avoid leaking internal state. Legacy handler shapes are unchanged.

The shared service preserves validation and effects. CLI history aggregates byte-short pages up to its requested record limit; ours returns one bounded service page, as REST does. Service results are preserved without a new size adapter or omission response contract. SDK delivery limits still apply: an exact 2 MiB file exceeds the current SDK's 2 MiB envelope budget; a transport-valid 1800 KiB file produced a ~2.4 MiB base64 history result for which no correlated SDK reply arrived in the integration test. Use a smaller history page or management transport for a single large record. History behavior on CLI/REST remains unchanged. This transport limitation is documented rather than changing result semantics, following Owner scope correction on 2026-09-09. Delivery is best effort and a missing reply does not prove a mutation failed. Consumer command registration, file loading and execution are not implemented.

Intake owns the room mutex during SDK callbacks. A scoped shared service invocation reuses that ownership and catches expected service errors before they poison a nested service lock. The scope expires in `finally`; normal management invocations still lock normally. Intake defers nested pumping while a command executes and relays durable intents after command handling, avoiding recursive SDK drain. Storage mutation failures still propagate through the store's lock accounting.

## Verification

Verification of the expanded four-command implementation is in progress. Targeted lifecycle/storage/service/daemon tests pass, including durable acceptance, competing requests, recovery after an unobserved acknowledgement, interrupted deletion and retained unrelated rooms. Final full-suite evidence and review will be recorded on the PR. Nothing was deployed or merged.
