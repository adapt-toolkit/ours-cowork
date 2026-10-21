# Preparing stopped state for backup

`ours-cowork --json prepare-backup` prepares the selected Cowork state directory
for opaque archive capture. The caller must stop writers and retain its outer
operation lock until capture finishes; this command does not create a backup.

Preparation acquires Cowork's daemon lock and validates owned private socket
residues before removing them. It covers the primary management socket and the
recognized private publication aliases. A live primary socket is refused. After
the liveness probe, its inode, type, ownership and permissions must still match.
Regular files, symbolic links and unrelated entries are not removed.

The operation is repeatable and reports the number of removed socket entries.
It neither changes identity state nor starts the daemon.
