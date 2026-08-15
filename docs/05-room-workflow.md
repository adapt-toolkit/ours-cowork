# Room workflow

Create a room and inspect its host-owned identity:

```sh
ours-cowork room create --name "Release bridge" --goal "Ship the fix" --briefing "Review evidence first"
ours-cowork room list
ours-cowork room show <room-id>
```

In the web console, choose Create room, enter Name, Goal, and Briefing, and submit once. Names are trimmed and Unicode NFC-normalized, must contain 1–64 Unicode characters, and cannot contain Unicode control or format characters. Duplicate names are allowed. The created room is selected automatically and its Invite panel opens. Add invitation requirements one at a time; the UI does not combine room creation and invites into a fabricated atomic operation.

Update the display name with `ours-cowork room settings <room-id> --name "New name"`; other mutable mission fields use the same `room settings` command. A new room uses the standard SDK identity `ours-cowork-<room_id>`. The display name is persisted as mutable `room_name`, while the authenticated identity name is intentionally independent of it: renaming a room does not change its CID, contacts, or history. Duplicate display names are allowed because identity CIDs and room IDs, not names, are the authorization and routing keys. Pre-1.0 custom room identities are refused with instructions to back up, recreate, and re-invite rather than being silently renamed or reprovisioned. Inspect admitted seats with `room participants`. A room activates only when its recorded invite requirement is satisfied. Roles are display labels; participant identity CIDs, not roles, are authorization keys.

Close with `ours-cowork room close <room-id>`. Close is forward-only and removes the live standard SDK room identity while retaining the local archive. Archive deletion is a separate explicit operation described in the limitations topic.

Every web action has an equivalent CLI fallback in the room commands above and in the invites and messaging topics.
