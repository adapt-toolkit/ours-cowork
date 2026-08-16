# ours-cowork

`ours-cowork` is a standalone standard-SDK daemon for durable ours mission rooms. It owns one ordinary ours identity per room through an embedded `@ours.network/sdk` runtime by default, an ordered local archive, a private Unix management socket, and a localhost web console with room RPC.

```sh
ours-cowork web
ours-cowork docs
```

`ours-cowork web` starts the daemon if it is absent, waits for the console, and opens `http://127.0.0.1:3052/`. Create a room with a friendly display name first, then add each invitation requirement from its Invite panel. Names are trimmed, normalized to Unicode NFC, and may contain 1–64 Unicode characters excluding control and format characters. Duplicate names are allowed. The Communication view contains the human-readable room chat; operational records remain in Events and the complete ordered stream remains in Archive.

The friendly `room_name` is presentation metadata. New rooms use the globally unique SDK identity `ours-cowork-<room_id>`; that authenticated name is independent of later display-name changes. Duplicate display names are allowed because identity CIDs and room IDs, not names, are the authorization and routing keys. Pre-1.0 rooms using `cowork-room-<room_id>` or `ours-cowork-room:<name>` custom packet state are detected and refused: back them up with the old release, recreate them, and re-invite their participants.

The localhost HTTP console has no authentication. Keep it bound to `127.0.0.1`; do not proxy, forward, or expose the port to other hosts. Room state is refreshed by periodic polling, not pushed to the browser.

By default the runtime is embedded and no configuration changes. A `daemon` block with `mode: "external"` instead hosts the room identities on an ours daemon you already run — the common one, or a dedicated one on its own port and state directory. See the configuration topic.

The package runs independently with its own config and state directory. Operator room commands use one JSONL request over `management.sock`. Use `--json` for automation; its stdout is a single JSON value and diagnostics are included in that value.

Ordinary ours-mcp identities can join only as remote participants over the ours protocol.

Active participants can also send files through the room identity. Cowork treats
them as opaque bytes, archives them before consuming SDK inbox state, and relays an
SDK-authenticated metadata envelope plus the binary file to every other active seat.
Files are limited to 2 MiB; larger inputs fail loudly instead of weakening
crash recovery guarantees.

The release package contains the standalone daemon, operator CLI, deterministic web assets, and all eleven offline operator topics. Standard identity, messaging, reply, file, and lifecycle behavior comes from the public `@ours.network/sdk`; no custom MUFL room actor is shipped.

Licensed under [FSL-1.1-Apache-2.0](./LICENSE).

The eleven offline topics cover prerequisites, installation, configuration, lifecycle, rooms, invites, messaging/history, backup/restore, service management, exact limitations, and the web console. Read them without a running daemon:

```sh
ours-cowork docs limitations
ours-cowork docs web
```

Before production use, read the limitations topic. In particular, backups require a stopped daemon and restore uses the complete state directory.
