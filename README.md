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

Start or install the shared daemon with `@ours.network/cli` 2.7.0 before starting cowork. Cowork never embeds, starts, stops, or silently substitutes an ours daemon. It uses the SDK-standard shared selection (the default `~/.ours` daemon, `OURS_CONFIG`, or a coherent `OURS_PORT` plus `OURS_STATE_DIR` selection) and fails clearly when that daemon is unavailable or mismatched.

The shared daemon retains application payload history outside its protocol packets: each identity has a `history.sqlite3` database and immutable content-addressed file blobs. Cowork authorizes unread metadata by authenticated CID, reads the corresponding persistent history or blob, durably archives the room item and its complete fan-out, and only then advances that exact SDK unread item. There is no packet-inbox fallback, defer queue, host outbox, or cross-store transaction.

The package keeps room metadata and a per-room indexed `archive.sqlite3` in its own state directory. The archive uses WAL with `synchronous=FULL`; a record is durable at the completed SQLite commit. File bytes are immutable content-addressed blobs written and directory-synced before their referencing transaction, so interruption can leave only an unreferenced blob, never a committed partial file. Only identity names are used to select cowork rooms from the daemon-global identity list; this bookkeeping is not a provenance or authorization boundary. Operator room commands use one JSONL request over `management.sock`. Use `--json` for automation; its stdout is a single JSON value and diagnostics are included in that value.

Ordinary ours-mcp identities can join only as remote participants over the ours protocol.

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
