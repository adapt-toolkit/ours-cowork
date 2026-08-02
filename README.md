# ours-cowork

`ours-cowork` is a standalone daemon for durable ours mission rooms. It owns one ordinary packet per room, an ordered local archive, a private Unix management socket, and optional loopback REST management.

```sh
ours-cowork start
ours-cowork room create --goal "Coordinate release" --briefing "Report evidence and blockers"
ours-cowork docs
```

The package runs independently with its own config and state directory. Operator room commands use one JSONL request over `management.sock`. Use `--json` for automation; its stdout is a single JSON value and diagnostics are included in that value.

The ten offline topics cover prerequisites, installation, configuration, lifecycle, rooms, invites, messaging/history, backup/restore, service management, and exact limitations. Read them without a running daemon:

```sh
ours-cowork docs limitations
```

Before production use, read the limitations topic. In particular, backups require a stopped daemon and restore uses the complete state directory.
