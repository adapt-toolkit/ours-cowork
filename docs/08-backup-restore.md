# Backup and restore

Stop the daemon before taking a backup. A live copy can split metadata, append-only archive records, embedded SDK identity state, and filesystem durability boundaries across different moments.

Back up the complete state directory as one unit, preserving ownership and file modes. Do not select only `rooms/` or only room JSON files.

For restore, stop the daemon, replace the complete state directory with the complete backup, restore its original owner and `0700`/`0600` permissions, and then start the daemon. Do not merge individual room directories from different snapshots. Restore to a compatible package version and verify `ours-cowork status` plus representative `room show` and `room history` calls.

Room restore requires both cowork room metadata and its private `<state-dir>/ours-sdk` identity state. Current rooms restore the exact `ours-cowork-<room_id>` identity and verify its CID before hosting it. Pre-1.0 custom packet state is not upgraded or recreated in place; startup refuses it with guidance to use the old release for backup, recreate the room, and re-invite participants.
