# Backup and restore

Stop the cowork daemon before taking a cowork backup. A live copy can split room metadata and append-only archive records across different filesystem durability boundaries.

Back up the complete cowork state directory as one unit, preserving ownership and file modes. Do not select only individual room JSON or archive files. Shared ours identity state is outside this directory and must be protected separately through the shared daemon's own stopped-state backup procedure. That separate state includes each room identity's `history.sqlite3` and immutable content-addressed blobs; copying only the cowork archive does not back up contacts, invites, unread state, or SDK history.

For restore, stop cowork, replace the complete cowork state directory with the complete backup, restore its original owner and `0700`/`0600` permissions, ensure the shared daemon already contains the corresponding room identities, and then start cowork. Do not merge individual room directories from different snapshots. Restore to a compatible package version and verify `ours-cowork status` plus representative `room show` and `room history` calls.

An established room restores only by choosing its exact persisted `ours-cowork:<bounded creation name>` identity with `force: false` and verifying the exact durable identity CID. Mutable `room_name` metadata does not participate in established restore. If that exact identity is absent from the shared daemon or its CID differs, startup fails clearly; cowork never renames, adopts, or recreates an established identity. Only a durable `packet_pending` room may create a missing identity. Upgrade recovery may rewrite an empty-CID overlength sentinel to the deterministic 64-code-point bounded name before that first creation; it never rewrites a name with an established CID.

Earlier unreleased ID- and slug-based identity formats are rejected. This unreleased major provides no migration or down-migration.

Metadata using the exact legacy `cowork-room-<room_id>` form remains loadable so cowork can identify it and provide explicit migration guidance, but it is not a standard-restorable identity. Pre-1.0 custom packet state is refused rather than upgraded, renamed, or recreated in place: back it up with its compatible old release, recreate the room, and re-invite its participants.

The external-history daemon epoch has no automatic migration from older packet-format state. Preserve any desired old-state backup, remove the incompatible daemon state manually, start clean, and recreate/re-invite; neither the SDK installer nor cowork silently deletes or converts it.
