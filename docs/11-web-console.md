# Web console

Open the production console with:

```sh
ours-cowork web
```

The command safely starts the daemon only when it is absent, waits for `GET /` readiness, then opens `http://127.0.0.1:3052/`. `ours-cowork --json web` performs the same readiness checks but returns `{ "url": "http://127.0.0.1:3052/", "opened": false }` inside the standard JSON result without opening a browser.

The console and HTTP room RPC have no authentication. They bind only to `127.0.0.1`; both the `127.0.0.1` and `localhost` browser URLs are accepted. Do not use port forwarding, a reverse proxy, or another mechanism to expose this listener to other hosts.

## API description

The same loopback listener serves an OpenAPI 3.1 description of the room management REST API and a browser UI for it:

- `http://127.0.0.1:3052/openapi.json` — the machine-readable document.
- `http://127.0.0.1:3052/docs` — the UI that renders the document and can send requests.

Both are read-only GET routes with no authentication, exactly like the console itself, and they are available whenever `rest.enabled` is true. They ship inside the daemon and load no remote assets, so they work on an offline host. Do not expose either route to another host.

Every room operation is carried by the single route `POST /rpc` with the envelope `{ "version": 1, "id": ..., "method": ..., "params": ... }`; the document describes the twenty methods the REST listener serves, discriminated on `method`. Operations that carry an invite secret are not part of it — they are reachable only over `management.sock`.

## Room setup

1. Choose Create room and enter the friendly Name, Goal, and Briefing. The name is shown in the room list, workspace header, and room details.
2. Submit once. The new room is selected and its Invite panel opens.
3. Add one invitation requirement at a time. Choose one-time or public mode and set the minimum acceptances for a public invite.
4. Copy every invite from its blocking receipt before choosing Done. The secret is shown once and is not retained in browser storage, the URL, logs, or durable room metadata.

The room activates after its durable invitation requirements are satisfied. Participants shows admitted identities and their invite roles.

Friendly names are trimmed and Unicode NFC-normalized, must contain 1–64 Unicode characters, and cannot contain Unicode control or format characters. Duplicate names are allowed. Change a name in Room settings. The browser continues to route by the opaque room ID; renaming does not change the URL, storage key, or underlying room identity. Existing unnamed rooms appear as `Room <first 8 room_id characters>`.

## Communication and records

Communication is the human-readable room stream: room and participant messages, the mission briefing, and inert file attachment cards at their exact archive sequence. Files are separate communication items and are not attached to nearby message text. The newest 500 communication items are mounted first; Show 500 earlier reveals more loaded history. Messages are not inserted optimistically; a sent message appears after the daemon's ordered history includes it. Events contains relay, recovery, close, and failure details. Archive contains the complete sequence-numbered stream and can show earlier loaded rows.

Files lists every validated file already loaded from the selected room's paged history. It groups versions only when their raw filenames are exactly equal, including case, Unicode form, and whitespace; versions are numbered oldest-first from archive sequence and displayed newest-first. Group headers and expanded version lists mount 500 entries at a time, with controls to reveal every older entry. Repeated uploads remain distinct versions even when their bytes are identical.

Files never preview or interpret content. Download decodes the archive's canonical base64, verifies the declared size and SHA-256 in the browser, and only then downloads a short-lived `application/octet-stream` Blob. An integrity mismatch is blocked. The reported MIME is shown as metadata only, and unsafe control/format characters or trailing spaces/dots are replaced in the derived download name without changing the displayed or grouped filename. Loaded files remain readable and downloadable when a room is closed or the daemon is disconnected; deleting the room removes its entire local archive and UI, with no per-file deletion.

## Sending as a registered role

A room whose metadata lists at least one REST-addressable role shows a **Send as** control above the composer. It is a testing affordance, marked as one in the console, and it defaults to the room's own voice. The picker offers only the roles already registered for that room, and it never registers or removes one: use `ours-cowork room rest-role <room-id> --role <label>` for that, and see `ours-cowork docs messaging` for what a role is. Nothing is minted and nothing expires — registering the name is the enabling act, so there is no credential for the console to hold or display.

Choosing a role sends over `room.say` instead of `room.message`. The daemon still signs as the room, so the archive and every participant show the room's identity with the role as its label; the selected role is repeated in the placeholder and on the send button so the active author is visible before you send. The selection stays with its own room across navigation. If the role is unregistered while it is selected, the console refuses the send and keeps the draft rather than silently falling back to the room's own voice.

Room list and connection health poll every five seconds. The selected room, participants, and new history poll every two seconds. Polling pauses while the page is hidden, coalesces overlapping cycles, and refreshes after confirmed mutations. Version one does not use push updates.

Close requires the room title or exact ID and leaves the plaintext local archive. Delete is available only after close, requires the exact room ID, and removes local state only as described in the limitations topic.

Every operation remains available through `ours-cowork room ...` when no browser is available. Use `ours-cowork docs rooms`, `ours-cowork docs invites`, and `ours-cowork docs messaging` for the CLI workflows.
