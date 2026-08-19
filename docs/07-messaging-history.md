# Messaging and history

Post in the room's host-owned voice:

```sh
ours-cowork room message <room-id> --text "Decision recorded"
```

The daemon assigns authorship. Author, identity, display-name, and role flags are rejected for this command.

## Authoring as a role

A room can also post under a named role instead of its own voice. Register the role first, then say something as it:

```sh
ours-cowork room rest-role <room-id> --role Reviewer
ours-cowork room say <room-id> --role Reviewer --text "Reviewed the release diff"
ours-cowork room rest-role <room-id> --role Reviewer --remove
```

The role name is the whole identifier. Nothing is minted, nothing expires, and nothing is presented once: registering the name is the enabling act, and `room.show` lists the registered names in `rest_roles`. Registration and removal are both idempotent, matching is by exact bytes (`Reviewer` and `reviewer` are two roles), and the name `room` is reserved because it is the room's own voice.

This is identification, not authorization. Anyone who can reach the management API can author as any registered role in that room, exactly as they can already post as the room, read all history, and delete the room. If you need per-role access control, put it in front of the API and key it on `params.role`.

The message is signed and sent by the room, so participants see the room's identity with the role as its label, and they see the same role label in anonymous rooms as in named ones. A role may also be held by a participant; a role is a display label, not a channel, so the two are told apart by the identity on the message rather than by the label. A role-authored message can never be replied to as the role: a role has no seat and hears nothing back.

A role briefing set for a REST-addressable role reaches nobody, because briefings are sent to seats and a role has none.

If the room has no active seats, `room say` still succeeds and archives the message, and it is relayed to nobody — the same outcome `room message` already produces for an empty room. A `200` therefore means durable, not received.

An option value that begins with `--` uses the unambiguous inline form, for example `--text=--help` or `--text=--json`. A bare `--` ends option parsing for positional values. Only an exact standalone `--json` before `--` selects global JSON output; text inside `--text=VALUE` is never consumed as a global flag.

Read the ordered archive with numeric paging:

```sh
ours-cowork room history <room-id>
ours-cowork room history <room-id> --after 40 --limit 20
```

Daemon history responses are capped at 3 MiB of JSON so one 2 MiB file record (about 2.8 MiB after base64 expansion) remains retrievable without allowing an unbounded management response. A page may therefore contain fewer records than `--limit` even when more records exist. Continue from the last returned `seq` with `--after`; only an empty page means end of history. The CLI follows these byte-short pages automatically and still prints up to the requested record limit.

Participant messages and files are accepted only from durable seats in an active room. A file is opaque binary data: cowork neither interprets its MIME metadata nor executes its contents. Its filename must be a path-free name of at most 255 UTF-8 bytes (not `.`, `..`, or a name containing `/`, `\\`, or NUL); MIME metadata may be empty and is limited to 255 UTF-8 bytes. Zero-byte files are valid. The maximum file size is 2 MiB (2,097,152 bytes), and a larger file is rejected explicitly.

Before consuming an incoming file from packet state, cowork durably archives its exact bytes as canonical base64 together with size and SHA-256, then durably creates every per-recipient relay intent. Each other active seat receives two core-protocol items: a signed `room_file` metadata envelope and a binary file containing the original bytes. Core receives bytes, never a local filesystem path, so there is no staging-file or path-permission dependency. A seat removed after fan-out is skipped terminally without receiving metadata or bytes. A crash can redrive an unfinished recipient from the archived bytes; an already terminal recipient is not retried.

In an anonymous room, signed file metadata identifies the author only by participant ID and alias. The operator archive still retains the real author and exact file bytes. The participant-facing history projection currently contains messages only; file records remain visible in the complete operator Archive/CLI history, while recipients retrieve file bytes through their ordinary ours file inbox.

History records include messages, files, and the durable relay intent/result trail used for restart recovery.

The web console projects participant and room-authored messages plus the briefing into Communication. Relay, file, recovery, close, and failure records are excluded from chat and shown in Events; Archive retains the complete ordered record stream, including archived file bytes. Messages appear only after the authoritative history refresh observes them.

Version one polls rather than receiving pushed updates: the room list refreshes every five seconds, while the selected room, participants, and history refresh every two seconds. Polling pauses in a hidden tab, coalesces overlap, and refreshes after confirmed mutations. CLI history remains the fallback when a browser is unavailable.
