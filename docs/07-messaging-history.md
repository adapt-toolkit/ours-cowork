# Messaging and history

Post in the room's host-owned voice:

```sh
ours-cowork room message <room-id> --text "Decision recorded"
```

The daemon assigns authorship. Author, identity, display-name, and role flags are rejected for this command.

An option value that begins with `--` uses the unambiguous inline form, for example `--text=--help` or `--text=--json`. A bare `--` ends option parsing for positional values. Only an exact standalone `--json` before `--` selects global JSON output; text inside `--text=VALUE` is never consumed as a global flag.

Read the ordered archive with numeric paging:

```sh
ours-cowork room history <room-id>
ours-cowork room history <room-id> --after 40 --limit 20
```

Daemon history responses are capped at 3 MiB of JSON so one maximum-size file record (about 2.7 MiB after base64 expansion) remains retrievable without allowing an unbounded management response. A page may therefore contain fewer records than `--limit` even when more records exist. Continue from the last returned `seq` with `--after`; only an empty page means end of history. The CLI follows these byte-short pages automatically and still prints up to the requested record limit.

Participant messages and files are accepted only from durable seats in an active room. A file is opaque binary data: cowork neither interprets its MIME metadata nor executes its contents. Its filename must be a path-free name of at most 255 UTF-8 bytes (not `.`, `..`, or a name containing `/`, `\\`, or NUL); MIME metadata may be empty and is limited to 255 UTF-8 bytes. Zero-byte files are valid. The maximum accepted file size is 2,000,000 bytes. A larger file, or one whose name or MIME metadata is out of bounds, is refused: the payload is discarded, a `file_rejected` record is appended to room history (operator view), and the sender receives a signed `room_file_rejected` notice carrying the file name, the size that arrived, the limit, and the reason (`too_large`, `invalid_filename`, or `invalid_mime`). A refused file is never relayed to anyone. Rooms created before the maximum came down to 2,000,000 bytes may hold archived files up to 2,097,152 bytes; those remain readable.

Before consuming an incoming file from packet state, cowork durably archives its exact bytes as canonical base64 together with size and SHA-256, then durably creates every per-recipient relay intent. Each other active seat receives two core-protocol items: a signed `room_file` metadata envelope and a binary file containing the original bytes. Core receives bytes, never a local filesystem path, so there is no staging-file or path-permission dependency. A seat removed after fan-out is skipped terminally without receiving metadata or bytes. A crash can redrive an unfinished recipient from the archived bytes; an already terminal recipient is not retried.

In an anonymous room, signed file metadata identifies the author only by participant ID and alias. The operator archive still retains the real author and exact file bytes. The participant-facing history projection currently contains messages only; file records remain visible in the complete operator Archive/CLI history, while recipients retrieve file bytes through their ordinary ours file inbox.

History records include messages, files, and the durable relay intent/result trail used for restart recovery.

The web console projects participant and room-authored messages plus the briefing into Communication. Relay, file, recovery, close, and failure records are excluded from chat and shown in Events; Archive retains the complete ordered record stream, including archived file bytes. Messages appear only after the authoritative history refresh observes them.

Version one polls rather than receiving pushed updates: the room list refreshes every five seconds, while the selected room, participants, and history refresh every two seconds. Polling pauses in a hidden tab, coalesces overlap, and refreshes after confirmed mutations. CLI history remains the fallback when a browser is unavailable.
