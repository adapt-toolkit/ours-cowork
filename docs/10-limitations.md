# Limitations

- The retained archive is plaintext on this host. Filesystem ownership and `0700`/`0600` modes limit local access, but the archive is not encrypted at rest by ours-cowork.
- Invite secrets exist only for the process lifetime that minted them and in the CLI receipt returned to the operator. Durable room metadata stores descriptors, not invite blobs. After restart, missing public invites require explicit recovery; one-time invites are not reconstructable.
- Relay recovery is at-least-once. A crash after transport acceptance but before the durable result can retry a send, so participants may observe duplicates. The system does not provide exactly once relay semantics.
- The host records transport acceptance and failures; it does not observe delivery, reading, or remote processing. A successful operator command must not be interpreted as participant receipt.
- Backups require a stopped daemon. Back up and restore the complete state directory as one unit, preserving ownership and modes; partial or live copies are unsupported.
- Service uninstall retains data. It removes the systemd or launchd definition, not configuration, archives, room metadata, or packet state.
- Closing and deleting are separate. First close the room explicitly with `ours-cowork room close <room-id>`. Only a closed room can then be deleted with `ours-cowork room delete <room-id> --yes`.
- Confirmed deletion removes the retained archive and metadata from this host only. It does not claim remote purge, backup erasure, key wipe, or secure erase.
