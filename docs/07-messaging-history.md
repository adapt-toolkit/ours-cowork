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

Daemon history responses are capped at 3 MiB of JSON so one 2 MiB file record (about 2.8 MiB after base64 expansion) remains retrievable without allowing an unbounded management response. A page may therefore contain fewer records than `--limit` even when more records exist. Continue from the last returned `seq` with `--after`; only an empty page means end of history. The CLI follows these byte-short pages automatically and still prints up to the requested record limit.

Participant messages and files are accepted only from durable seats in an active room. A file is opaque binary data: cowork neither interprets its MIME metadata nor executes its contents. Its filename must be a path-free name of at most 255 UTF-8 bytes (not `.`, `..`, or a name containing `/`, `\\`, or NUL); MIME metadata may be empty and is limited to 255 UTF-8 bytes. Zero-byte files are valid. The maximum file size is 2 MiB (2,097,152 bytes), and a larger file is rejected explicitly.

Incoming message listings contain authorization metadata but no body. Cowork resolves each selected wire ID through persistent SDK history, verifies that the history row matches the listing, archives the message and complete recipient-intent fan-out, and then asks the SDK to read one oldest unread row. If an older introduction becomes unread between listing and acknowledgement, that authoritative row is archived through the same intake path before cowork retries the expected row. There is no defer operation; an empty acknowledgement means another reader already advanced the expected row.

For a file, cowork reads the identity-scoped immutable blob while the item is still unread and verifies its length and SHA-256 against SDK metadata. It then durably archives the exact bytes as canonical base64 together with the reply reference and every per-recipient relay intent before selecting that exact 64-hex wire ID with `getFiles`. Each other active seat receives two SDK items: an authenticated `room_file` metadata envelope and a binary file containing the original bytes. The SDK receives bytes, never a local filesystem path, so there is no staging-file or path-permission dependency. A seat removed after fan-out is skipped terminally without receiving metadata or bytes. A crash can redrive an unfinished recipient from the cowork archive; an already terminal recipient is not retried.

In an anonymous room, SDK-authenticated file metadata identifies the author only by participant ID and alias. The operator archive still retains the real author and exact file bytes. The participant-facing history projection currently contains messages only; file records remain visible in the complete operator Archive/CLI history, while recipients retrieve file bytes through their ordinary ours file inbox.

Cowork history records include messages, files, and the durable relay intent/result trail used for restart recovery. This application archive is distinct from the shared daemon's per-identity `history.sqlite3` and immutable blob store; neither is a substitute backup for the other.

The web console projects participant and room-authored messages plus the briefing into Communication. Relay, file, recovery, close, and failure records are excluded from chat and shown in Events; Archive retains the complete ordered record stream, including archived file bytes. Messages appear only after the authoritative history refresh observes them.

Version one polls rather than receiving pushed updates: the room list refreshes every five seconds, while the selected room, participants, and history refresh every two seconds. Polling pauses in a hidden tab, coalesces overlap, and refreshes after confirmed mutations. CLI history remains the fallback when a browser is unavailable.
