# Backup and restore

Stop the cowork daemon before taking a cowork backup. A live copy can split room metadata and append-only archive records across different filesystem durability boundaries.

Back up the complete cowork state directory as one unit, preserving ownership and file modes. Do not select only individual room JSON or archive files. Shared ours identity state is outside this directory and must be protected through the shared daemon's own operator backup procedure.

For restore, stop cowork, replace the complete cowork state directory with the complete backup, restore its original owner and `0700`/`0600` permissions, ensure the shared daemon already contains the corresponding room identities, and then start cowork. Do not merge individual room directories from different snapshots. Restore to a compatible package version and verify `ours-cowork status` plus representative `room show` and `room history` calls.

An established room restores only by choosing its exact persisted `ours-cowork-<room_id>` identity with `force: false` and verifying its CID. If that identity is absent from the shared daemon, startup fails clearly; cowork never recreates an established identity. Only a durable `packet_pending` room may create a missing identity. Pre-1.0 custom packet state is not upgraded or recreated in place.
