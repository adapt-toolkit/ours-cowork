# Web console

Open the production console with:

```sh
ours-cowork web
```

The command safely starts the cowork daemon only when it is absent, waits for `GET /` readiness, then opens `http://127.0.0.1:3052/`. The shared ours daemon must already be running; this command never starts it. `ours-cowork --json web` performs the same readiness checks but returns `{ "url": "http://127.0.0.1:3052/", "opened": false }` inside the standard JSON result without opening a browser.

The console and HTTP room RPC have no authentication. They bind only to `127.0.0.1`; both the `127.0.0.1` and `localhost` browser URLs are accepted. Do not use port forwarding, a reverse proxy, or another mechanism to expose this listener to other hosts.

## Room setup

1. Choose Create room and enter the friendly Name, Goal, and Briefing. The name is shown in the room list, workspace header, and room details.
2. Submit once. The new room is selected and its Invite panel opens.
3. Add one invitation requirement at a time. Choose one-time or public mode and set the minimum acceptances for a public invite. Revoke or consume it before creating another; the standard-SDK room keeps only one live invite so contact admission remains unambiguous.
4. Copy every invite from its blocking receipt before choosing Done. The secret is shown once and is not retained in browser storage, the URL, logs, or durable room metadata.

The room activates after its durable invitation requirements are satisfied. Participants shows admitted identities and their invite roles.

Friendly names are trimmed and Unicode NFC-normalized, must contain 1–64 Unicode characters, and cannot contain Unicode control or format characters. Duplicate names are allowed. Change a name in Room settings. The browser continues to route by the opaque room ID; renaming does not change the URL, storage key, or underlying room identity. Existing unnamed rooms appear as `Room <first 8 room_id characters>`.

## Communication and records

Communication is the human-readable room stream: room and participant messages, the mission briefing, and inert file attachment cards at their exact archive sequence. Files are separate communication items and are not attached to nearby message text. The newest 500 communication items are mounted first; Show 500 earlier reveals more loaded history. Messages are not inserted optimistically; a sent message appears after the daemon's ordered history includes it. Events contains relay, recovery, close, and failure details. Archive contains the complete sequence-numbered stream and can show earlier loaded rows.

Files lists every validated file already loaded from the selected room's paged history. It groups versions only when their raw filenames are exactly equal, including case, Unicode form, and whitespace; versions are numbered oldest-first from archive sequence and displayed newest-first. Group headers and expanded version lists mount 500 entries at a time, with controls to reveal every older entry. Repeated uploads remain distinct versions even when their bytes are identical.

Files never preview or interpret content. Download decodes the archive's canonical base64, verifies the declared size and SHA-256 in the browser, and only then downloads a short-lived `application/octet-stream` Blob. An integrity mismatch is blocked. The reported MIME is shown as metadata only, and unsafe control/format characters or trailing spaces/dots are replaced in the derived download name without changing the displayed or grouped filename. Loaded files remain readable and downloadable when a room is closed or the daemon is disconnected; deleting the room removes its entire local archive and UI, with no per-file deletion.

Room list and connection health poll every five seconds. The selected room, participants, and new history poll every two seconds. Polling pauses while the page is hidden, coalesces overlapping cycles, and refreshes after confirmed mutations. Version one does not use push updates.

Close requires the room title or exact ID and leaves the plaintext local archive. Delete is available only after close, requires the exact room ID, and removes local state only as described in the limitations topic.

Every operation remains available through `ours-cowork room ...` when no browser is available. Use `ours-cowork docs rooms`, `ours-cowork docs invites`, and `ours-cowork docs messaging` for the CLI workflows.
