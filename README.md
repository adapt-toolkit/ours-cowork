# ours-cowork

`ours-cowork` is a standalone daemon for durable ours mission rooms. It owns one ordinary packet per room, an ordered local archive, a private Unix management socket, and a localhost web console with room RPC.

```sh
ours-cowork web
ours-cowork docs
```

`ours-cowork web` starts the daemon if it is absent, waits for the console, and opens `http://127.0.0.1:3052/`. Create a room with a friendly display name first, then add each invitation requirement from its Invite panel. Names are trimmed, normalized to Unicode NFC, and may contain 1–64 Unicode characters excluding control and format characters. Duplicate names are allowed. The Communication view contains the human-readable room chat; operational records remain in Events and the complete ordered stream remains in Archive.

The friendly `room_name` is presentation metadata. New rooms announce the technical identity `ours-cowork-room:<initial room_name>`; that authenticated announced name is frozen when the display name later changes. Duplicate display and announced names are allowed because identity CIDs, not names, are the authorization and routing keys. The opaque `room_id` remains the stable key for URLs, storage, and identity correlation. Existing `cowork-room-<room_id>` identities are never renamed or recreated, and rooms created before friendly names existed migrate only their display metadata to `Room <first 8 room_id characters>`.

The localhost HTTP console has no authentication. Keep it bound to `127.0.0.1`; do not proxy, forward, or expose the port to other hosts. Room state is refreshed by periodic polling, not pushed to the browser.

The same listener describes its own room management REST API: `http://127.0.0.1:3052/openapi.json` is the OpenAPI 3.1 document and `http://127.0.0.1:3052/docs` is the browser UI for it. Both are read-only, load no remote assets, and follow the console's loopback-only exposure rules.

The package runs independently with its own config and state directory. Operator room commands use one JSONL request over `management.sock`. Use `--json` for automation; its stdout is a single JSON value and diagnostics are included in that value.

Ordinary ours-mcp identities can join only as remote participants over the ours protocol.

Active participants can also send files through the room packet. Cowork treats
them as opaque bytes, archives them before consuming packet state, and relays a
signed metadata envelope plus the core binary file to every other active seat.
Files are limited to 2 MiB; larger inputs fail loudly instead of weakening
crash recovery guarantees.

The release package contains the standalone daemon, operator CLI, compiled room packet, deterministic web assets, and all eleven offline operator topics. It has no dependency on another agent daemon.

Licensed under [FSL-1.1-Apache-2.0](./LICENSE).

The eleven offline topics cover prerequisites, installation, configuration, lifecycle, rooms, invites, messaging/history, backup/restore, service management, exact limitations, and the web console. Read them without a running daemon:

```sh
ours-cowork docs limitations
ours-cowork docs web
```

Before production use, read the limitations topic. In particular, backups require a stopped daemon and restore uses the complete state directory.
