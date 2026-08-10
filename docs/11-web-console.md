# Web console

Open the production console with:

```sh
ours-cowork web
```

The command safely starts the daemon only when it is absent, waits for `GET /` readiness, then opens `http://127.0.0.1:3052/`. `ours-cowork --json web` performs the same readiness checks but returns `{ "url": "http://127.0.0.1:3052/", "opened": false }` inside the standard JSON result without opening a browser.

The console and HTTP room RPC have no authentication. They bind only to `127.0.0.1`; both the `127.0.0.1` and `localhost` browser URLs are accepted. Do not use port forwarding, a reverse proxy, or another mechanism to expose this listener to other hosts.

## Room setup

1. Choose Create room and enter the friendly Name, Goal, and Briefing. The name is shown in the room list, workspace header, and room details.
2. Submit once. The new room is selected and its Invite panel opens.
3. Add one invitation requirement at a time. Choose one-time or public mode and set the minimum acceptances for a public invite.
4. Copy every invite from its blocking receipt before choosing Done. The secret is shown once and is not retained in browser storage, the URL, logs, or durable room metadata.

The room activates after its durable invitation requirements are satisfied. Participants shows admitted identities and their invite roles.

Friendly names are trimmed and Unicode NFC-normalized, must contain 1–64 Unicode characters, and cannot contain Unicode control or format characters. Duplicate names are allowed. Change a name in Room settings. The browser continues to route by the opaque room ID; renaming does not change the URL, storage key, or underlying room identity. Existing unnamed rooms appear as `Room <first 8 room_id characters>`.

## Communication and records

Communication is the human-readable chat: room and participant messages plus the mission briefing. Messages are not inserted optimistically; a sent message appears after the daemon's ordered history includes it. Events contains relay, recovery, close, and failure details. Archive contains the complete sequence-numbered stream and can show earlier loaded rows.

Room list and connection health poll every five seconds. The selected room, participants, and new history poll every two seconds. Polling pauses while the page is hidden, coalesces overlapping cycles, and refreshes after confirmed mutations. Version one does not use push updates.

Close requires the room title or exact ID and leaves the plaintext local archive. Delete is available only after close, requires the exact room ID, and removes local state only as described in the limitations topic.

Every operation remains available through `ours-cowork room ...` when no browser is available. Use `ours-cowork docs rooms`, `ours-cowork docs invites`, and `ours-cowork docs messaging` for the CLI workflows.
