# Daemon lifecycle

Use these commands:

```sh
ours-cowork start
ours-cowork status
ours-cowork restart
ours-cowork stop
ours-cowork serve
ours-cowork web
```

These commands manage only the cowork process. `start` detaches the cowork CLI in `serve` mode and waits for the authenticated control session on `management.sock`. `serve` keeps the supervisor in the foreground. Status asks the responding worker to prove that its supervisor capability handshake completed. Stop sends a session-bound shutdown request to that worker; the worker asks its own supervisor over their existing authenticated IPC channel to enter the same bounded shutdown path used for signals. The CLI never signals a numeric PID. Stop reports success only after the accepted control session disappears. An occupied socket without this protocol blocks stop/restart with invalid state and is left untouched.

Start the shared ours daemon separately with `ours-daemon start` or its installed service. Cowork verifies the selected daemon at boot and refuses to start while it is unreachable or mismatched. `ours-cowork stop` and `restart` never start, stop, restart, or signal the shared daemon. Under an installed cowork service, an unavailable shared daemon causes bounded service retries rather than an embedded fallback.

If the shared daemon restarts underneath a running cowork, room notification watches reconnect with bounded backoff. A replacement watch fixes its new tip before cowork rechecks the affected room. Notifications are wakeups rather than payload storage: bounded intake reads authoritative unread metadata and persistent history from the daemon, so traffic across the reconnect boundary remains discoverable even when a wakeup is duplicated.

V1 room owners remain unchanged across notification reconnects and shared-daemon
restart. Typed `NOT_BOUND` recovery rebinds the same owner with `force:false`, checks
the durable room CID and retries only the rejected operation. Ambiguous transport
failures do not cause blind mutation replay. A terminally retired owner cannot be
revived by generating another ID during recovery.

Orderly shutdown drains existing room work and aborted notification watchers before
terminal lease release. Failed release results are reported through the existing
shutdown error path. Permanent room identities remain on normal stop; a new cowork
worker creates fresh room owners and restores the exact recorded CIDs. Room deletion
removes its identity before retiring its owner.

Before each V1 SDK attachment, the worker registers that exact owner with its
existing authenticated IPC supervisor and waits for acknowledgement. Registration
is held in supervisor memory. If the held child exits, the supervisor records its
terminal event before attempting release. If the supervisor disappears, the live
worker stops intake, drains room work, packet refresh/rebind and aborted watches,
then records its own SessionEnd before release. Disconnect or a timeout alone is
never evidence that another process died.

Terminal events are private immutable files under `owner-terminal/` in the cowork
state directory. Each preserves the original owner, reason/time, actual child PID,
namespaced supervisor/worker incarnation markers, and fixed daemon endpoint, UUID
and credential-file path. The markers identify this authenticated IPC incarnation;
they do not claim to be OS boot or procfs values. No token bytes or IPC capability
are stored. The SDK reads the current protected credential file for delivery and
its bounded observation release must acknowledge complete cleanup before the file
is removed. The surviving supervisor retries serially. Ordinary startup replays
pending events before admitting replacement room owners, using each saved target
even if the new launch configuration differs. Failed delivery retains the event
and blocks replacement admission; it does not authorize takeover.

If all trustworthy live participants disappear before a terminal event is
published, ownership remains unknown. This recovery does not infer death from a
saved PID, a missing file or elapsed time, and it makes no OS reboot/power-loss
guarantee.

`web` uses the same safe cowork start path: an already-running cowork daemon is retained, an absent cowork daemon is started, and readiness is checked with `GET /` before a browser opens. The shared ours daemon must already be running. `web` never retries a room mutation. With `--json`, it returns the URL with `opened: false` and has no browser side effect. If HTTP is explicitly disabled, `web` exits `1` and explains how to enable it.

Exit codes are stable: `0` success, `1` web console disabled, `2` CLI usage, `3` not found, `4` invalid state or parameters, `5` unauthorized, `6` daemon unavailable, and `7` internal failure. With `--json`, stdout contains exactly one JSON value and stderr stays empty. This includes foreground `serve`: supervised worker output is suppressed, and its clean or failed terminal status becomes that one JSON result.
