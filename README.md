# ours-cowork

`ours-cowork` provides durable ours mission rooms on the one shared ours daemon. It uses `@ours.network/sdk` 3 directly, keeps one ordinary ours identity per room, stores an ordered local archive, and exposes a private Unix management socket plus a localhost web console with room RPC.

```sh
ours-cowork web
ours-cowork docs
```

`ours-cowork web` starts the daemon if it is absent, waits for the console, and opens `http://127.0.0.1:3052/`. Create a room with a name first, then add each invitation requirement from its Invite panel. Names are trimmed, normalized to Unicode NFC, and may contain 1–64 Unicode characters excluding control and format characters. The bounded identity name must not collide with an identity in the shared daemon. The Communication view contains the human-readable room chat; operational records remain in Events and the complete ordered stream remains in Archive.

Each room identity is `ours-cowork:<bounded room name>`. Cowork NFC-normalizes the creation name and retains its first 52 Unicode code points so the complete SDK identity stays within 64 code points. The authenticated identity name is frozen at creation; later room settings may change `room_name` but do not rename the identity, CID, contacts, or history. Identity CIDs, not names, remain the authorization and routing keys. Because identity names are daemon-global, equal names—including distinct long titles with the same retained prefix—collide cleanly. Earlier unreleased ID- and slug-based identity formats are unsupported; no migration is provided for this unreleased major.

The localhost HTTP console has no authentication. Keep it bound to `127.0.0.1`; do not proxy, forward, or expose the port to other hosts. Room state is refreshed by periodic polling, not pushed to the browser.

The same listener describes its own room management REST API: `http://127.0.0.1:3052/openapi.json` is the OpenAPI 3.1 document and `http://127.0.0.1:3052/docs` is the browser UI for it. Both are read-only, load no remote assets, and follow the console's loopback-only exposure rules.

Start or install the shared daemon with the selected `@ours.network/daemon` before starting cowork. Cowork never embeds, starts, stops, or silently substitutes an ours daemon. V1 selection uses `OURS_DAEMON_URL`, `OURS_DAEMON_ID` and `OURS_DAEMON_CREDENTIAL_PATH` together; each room has an independent external owner and requests read the protected current-token file. The temporary legacy SDK selection remains only when the V1 inputs are absent. See [configuration](docs/03-configuration.md) for the exact selection and refusal behavior.

The shared daemon retains application payload history outside its protocol packets: each identity has a `history.sqlite3` database and immutable content-addressed file blobs. Cowork authorizes unread metadata by authenticated CID, reads the corresponding persistent history or blob, durably archives the room item and its complete fan-out, and only then advances that exact SDK unread item. There is no packet-inbox fallback, defer queue, host outbox, or cross-store transaction.

The package keeps room metadata and a per-room indexed `archive.sqlite3` in its own state directory. The archive uses WAL with `synchronous=FULL`; a record is durable at the completed SQLite commit. File bytes are immutable content-addressed blobs written and directory-synced before their referencing transaction, so interruption can leave only an unreferenced blob, never a committed partial file. Only identity names are used to select cowork rooms from the daemon-global identity list; this bookkeeping is not a provenance or authorization boundary. Operator room commands use one JSONL request over `management.sock`. Use `--json` for automation; its stdout is a single JSON value and diagnostics are included in that value.

Ordinary ours-mcp identities can join only as remote participants over the ours protocol.

Granted room members can create message-only scoped reply threads for an explicit subset of stable room participant IDs through the generic Ours command catalog's `start_thread` command. Selected members receive separate root copies and reply with the SDK's native `reply_to_wire_id`; Cowork maps each descendant to the recipient's local immediate-parent copy. The selected participant-ID/CID pairs are immutable, later members are not backfilled, and excluded members receive no scoped message, file notice, notification, participant-history row, command result, or routing metadata. A message without `reply_to_wire_id` remains an ordinary whole-room message. See [Room workflow](./docs/05-room-workflow.md#scoped-reply-threads) for command discovery, schema, errors, and retry behavior, and [Messaging and history](./docs/07-messaging-history.md#reply-threading) for reply and history semantics.

Active participants can also send files through the room identity. Cowork treats
them as opaque bytes, archives them before consuming SDK inbox state, and relays an
SDK-authenticated metadata envelope plus the binary file to every other active seat.
Files are limited to 2 MiB; larger inputs fail loudly instead of weakening
crash recovery guarantees.

The release package contains the cowork daemon, operator CLI, deterministic web assets, and all eleven offline operator topics. Standard identity, messaging, reply, file, and lifecycle behavior comes from the public `@ours.network/sdk`; no custom MUFL room actor is shipped.

Licensed under [FSL-1.1-Apache-2.0](./LICENSE).

The eleven offline topics cover prerequisites, installation, configuration, lifecycle, rooms, invites, messaging/history, backup/restore, service management, exact limitations, and the web console. Read them without a running daemon:

```sh
ours-cowork docs limitations
ours-cowork docs web
```

Before production use, read the limitations topic. In particular, backups require a stopped daemon and restore uses the complete state directory.
Lost room identity leases are recovered automatically with a non-force bind and exact persisted-CID proof. Operators can invoke the same safe path explicitly with `ours-cowork room rebind <room-id>`; it never recreates an established identity or steals a live lease.
The localhost host-management CLI/API and web Archive retain full scoped-thread visibility for administrators, including excluded-member traffic that participant APIs hide. Runtime `room.history` is an authenticated, grant-gated participant view with viewer-local cursors; host cursors and participant cursors are not interchangeable. The shared SDK history remains local to each identity and does not define Cowork routing or host archive retention.

## Container lifecycle verification

After building with the selected locked SDK/CLI artifacts, run
`npm run test:v1-lifecycle` in an isolated Docker environment. This existing
integration uses the installed CLI and local development broker with temporary
state; it checks the explicit daemon-selection and room-recovery path. It does
not verify an external production broker or a complete Compose deployment.
For the existing browser smoke (`npm run test:browser`), provide system Chrome
or Chromium through `COWORK_CHROME_PATH`; no browser is needed by the server.

### Build with selected SDK and CLI archives

Run in the build container with Node 22+, npm and tar available:

```sh
node scripts/build-selected.mjs --sdk /artifacts/ours.network-sdk-3.7.2.tgz --cli /artifacts/ours.network-cli-2.7.2.tgz --out-dir /artifacts/consumer
```

The recipe validates package names, installs and builds in disposable staging,
then writes one complete portable npm archive. Stdout is a JSON object with its
actual `filename`; build/npm logs go to stderr. Normal source manifests, locks
and installed dependencies are preserved. The installer must install the same
selected SDK and CLI archives alongside this package; its final dependency
versions come from those archives. Existing bundling choices are unchanged.

Focused build/install verification (two real builds, including changed bytes
under identical input names and versions, plus a missing-vendor negative check):

```sh
node scripts/check-build-selected.mjs --sdk /artifacts/ours.network-sdk-3.7.2.tgz --cli /artifacts/ours.network-cli-2.7.2.tgz
```

For development against the selected, unpublished SDK/CLI sources, see [selected-source development](docs/selected-source-development.md).

### Authenticated HTTP gateway management

The installer can enable `OURS_COWORK_HTTP_MANAGEMENT=1` with a pinned
`OURS_DAEMON_URL` and `OURS_DAEMON_ID`. `/management/rpc` accepts the existing
issued `X-Ours-Api-Token` and verifies it against that daemon on every request.
It exposes the room service methods, including `room.accept`, but excludes
`daemon.status` and `daemon.shutdown`; supervisor control remains local.
Invalid/revoked credentials, instance mismatch, redirects and daemon outages fail
closed. Browser-origin requests cannot use machine management.

The separate `/browser/rpc` uses the ordinary room routes and also requires an
issued token. The browser prompt explains its operator authority; the token stays
in memory and is cleared by reload. `OURS_COWORK_PUBLIC_ORIGIN` pins the exact
external HTTP(S) origin behind a gateway. Same-origin proxy credentials remain
available, and assets/RPC paths work beneath a nested `/base/cowork/` mount.
The legacy unauthenticated loopback `/rpc` must remain blocked at the gateway.
All applications on the gateway origin share trust; a prefix is not isolation.
`ours-cowork --json capabilities` advertises `cowork.http-management-v1`.
