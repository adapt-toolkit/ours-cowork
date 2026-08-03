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

Participant messages are accepted only from durable seats in an active room. History records include messages and the durable relay intent/result trail used for restart recovery.

The web console projects participant and room-authored messages plus the briefing into Communication. Relay, recovery, close, and failure records are excluded from chat and shown in Events; Archive retains the complete ordered record stream. Messages appear only after the authoritative history refresh observes them.

Version one polls rather than receiving pushed updates: the room list refreshes every five seconds, while the selected room, participants, and history refresh every two seconds. Polling pauses in a hidden tab, coalesces overlap, and refreshes after confirmed mutations. CLI history remains the fallback when a browser is unavailable.
