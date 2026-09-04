# Room workflow

Create a room and inspect its host-owned identity:

```sh
ours-cowork room create --name "Release bridge" --goal "Ship the fix" --briefing "Review evidence first"
ours-cowork room list
ours-cowork room show <room-id>
```

In the web console, choose Create room, enter Name, Goal, and Briefing, and submit once. Names are trimmed and Unicode NFC-normalized, must contain 1–64 Unicode characters, and cannot contain Unicode control or format characters. The bounded identity name must not collide with an identity already in the shared daemon. The created room is selected automatically and its Invite panel opens. Add invitation requirements one at a time; the UI does not combine room creation and invites into a fabricated atomic operation.

Update the display name with `ours-cowork room settings <room-id> --name "New name"`; other mutable mission fields use the same `room settings` command. A new room identity is `ours-cowork:<bounded creation name>`: NFC normalization followed by the first 52 Unicode code points, for a 64-code-point maximum including the prefix. That authenticated name is persisted and frozen. Messenger displays the retained human-readable prefix from the identity itself; longer local `room_name` metadata remains available in Cowork. Renaming a room changes only mutable local metadata; it does not change the identity name, CID, contacts, invites, URLs, history, or earlier author labels. Because identity names are daemon-global, the same normalized name—or distinct long names sharing the retained prefix—collides and fails cleanly without a losing room sentinel. Earlier unreleased ID- and slug-based formats are unsupported and receive no migration. Inspect admitted seats with `room participants`. A room activates only when its recorded invite requirement is satisfied. Roles are display labels; participant identity CIDs, not roles, are authorization keys.

Membership changes are deliberately independent operator actions. Add a participant by issuing an invite for the intended role and admitting that identity; remove a participant with `ours-cowork room remove <room-id> <participant>`. To preserve coverage, add and confirm the new participant before removing the old one. To remove a dead participant first, remove it and issue a new invite afterward. Cowork does not combine these actions into a replacement operation or infer successor lineage.

Close with `ours-cowork room close <room-id>`. Close is forward-only and removes the live standard SDK room identity while retaining the local archive. Archive deletion is a separate explicit operation described in the limitations topic.

If the shared daemon restarts or a room SDK lease is lost, Cowork automatically attempts a non-force rebind of the room's exact persisted identity name and verifies its pinned CID before resuming the rejected operation. Concurrent recovery joins one attempt; transient connection failures use bounded exponential backoff. A live competing session, missing identity, or CID mismatch fails closed and is never force-bound or recreated. Startup isolates rooms that cannot be safely restored, releases their local leases, and continues serving healthy rooms.

Use `ours-cowork room rebind <room-id>` for explicit recovery. This canonical operation applies the same name-and-CID proof, refreshes SDK contact/invite state, reconciles the room, and resumes durable pending fanout before reporting success. It refuses closing or closed rooms. Structured daemon logs emit `identity_rebind_*` and `startup_room_recovery_failed` events for diagnosis.

Every web action has an equivalent CLI fallback in the room commands above and in the invites and messaging topics.
