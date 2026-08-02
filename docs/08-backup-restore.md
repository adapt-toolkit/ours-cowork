# Backup and restore

Stop the daemon before taking a backup. A live copy can split metadata, append-only archive records, packet state, and filesystem durability boundaries across different moments.

Back up the complete state directory as one unit, preserving ownership and file modes. Do not select only `rooms/` or only room JSON files.

For restore, stop the daemon, replace the complete state directory with the complete backup, restore its original owner and `0700`/`0600` permissions, and then start the daemon. Do not merge individual room directories from different snapshots. Restore to a compatible package version and verify `ours-cowork status` plus representative `room show` and `room history` calls.
