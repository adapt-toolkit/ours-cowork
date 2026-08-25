# Room workflow

Create a room and inspect its host-owned identity:

```sh
ours-cowork room create --name "Release bridge" --goal "Ship the fix" --briefing "Review evidence first"
ours-cowork room list
ours-cowork room show <room-id>
```

In the web console, choose Create room, enter Name, Goal, and Briefing, and submit once. Names are trimmed and Unicode NFC-normalized, must contain 1–64 Unicode characters, and cannot contain Unicode control or format characters. The normalized name must not collide with an identity already in the shared daemon. The created room is selected automatically and its Invite panel opens. Add invitation requirements one at a time; the UI does not combine room creation and invites into a fabricated atomic operation.

Update the display name with `ours-cowork room settings <room-id> --name "New name"`; other mutable mission fields use the same `room settings` command. A new room identity is exactly `ours-cowork:<normalized creation name>`, and that exact authenticated name is persisted and frozen. Messenger therefore displays the room name from the identity itself rather than separate `room_name` metadata. Renaming a room changes only mutable local metadata; it does not change the identity name, CID, contacts, invites, URLs, history, or earlier author labels. Because identity names are daemon-global, attempting to create another room with the same normalized creation name fails closed. Earlier unreleased ID- and slug-based formats are unsupported and receive no migration. Inspect admitted seats with `room participants`. A room activates only when its recorded invite requirement is satisfied. Roles are display labels; participant identity CIDs, not roles, are authorization keys.

Close with `ours-cowork room close <room-id>`. Close is forward-only and removes the live standard SDK room identity while retaining the local archive. Archive deletion is a separate explicit operation described in the limitations topic.

Every web action has an equivalent CLI fallback in the room commands above and in the invites and messaging topics.
