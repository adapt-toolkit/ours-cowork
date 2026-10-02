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

Start the shared ours daemon separately with `ours daemon start` or its installed service. Cowork verifies the selected daemon at boot and refuses to start while it is unreachable or mismatched. `ours-cowork stop` and `restart` never start, stop, restart, or signal the shared daemon. Under an installed cowork service, an unavailable shared daemon causes bounded service retries rather than an embedded fallback.

If the shared daemon restarts underneath a running cowork, room notification watches reconnect with bounded backoff. A replacement watch fixes its new tip before cowork rechecks the affected room. Notifications are wakeups rather than payload storage: bounded intake reads authoritative unread metadata and persistent history from the daemon, so traffic across the reconnect boundary remains discoverable even when a wakeup is duplicated.

`web` uses the same safe cowork start path: an already-running cowork daemon is retained, an absent cowork daemon is started, and readiness is checked with `GET /` before a browser opens. The shared ours daemon must already be running. `web` never retries a room mutation. With `--json`, it returns the URL with `opened: false` and has no browser side effect. If HTTP is explicitly disabled, `web` exits `1` and explains how to enable it.

Exit codes are stable: `0` success, `1` web console disabled, `2` CLI usage, `3` not found, `4` invalid state or parameters, `5` unauthorized, `6` daemon unavailable, and `7` internal failure. With `--json`, stdout contains exactly one JSON value and stderr stays empty. This includes foreground `serve`: supervised worker output is suppressed, and its clean or failed terminal status becomes that one JSON result.

Management now opens after shared-host initialization and before room recovery.
The `daemon.recovery` RPC (empty parameters) uses the private owner-only Unix
management socket or existing loopback `/rpc` transport. HTTP RPC has no
credential authentication; its existing local Host/Origin restrictions apply.
The `auth: true` route declaration does not add request authentication. It reports `version`, `ready`, `phase`,
`rooms`, `failed_rooms`, and `pending_fanout`. Phases are `initializing`, `restore`,
`lifecycle`, `reconcile`, `close`, `fanout`, `running`, and `stopping`. These are
aggregate process-local counts; they contain no room identifiers, message bodies,
or native error details. They do not report recipient acknowledgement or queue age.

`daemon.status` and the session-bound shutdown control remain available during
recovery. Status proves owned process liveness. `start` additionally waits for
structural room readiness using `daemon.recovery`; older workers without that RPC
retain their original control-handshake behavior. Public and private room RPCs
reject while structural recovery is incomplete or shutdown has begun. Ready means
restoration, pending lifecycle requests, reconciliation, and closing prerequisites
have completed; it does not mean every queued message has been forwarded.

After prerequisites, recovered rooms start their tracked fanout independently.
Readiness and queued notification scheduling do not await the fanout backlog.
Shutdown still stops intake/transports and drains tracked startup work before
unhosting identities. Intake reads bounded body snapshots (up to 32 messages and 32 files) and offers
a separate tracked serial forwarding worker a turn without waiting for the unread
queue to empty. Waiting for a send response releases the room mutex and does not
occupy the sole reader. Closing is saved durably before waiting outside that mutex
for dispatched relay/notice work and its result commit; deletion follows closure.
Leading typed commands and raced message acknowledgements each yield after 32 SDK
reads. Unread sources and later work in their recipient lane remain deferred until
consumption. A required full metadata barrier covers sources outside the body
snapshot; a metadata failure prevents that relay turn.

An observed-effect result commit failure is retained after its worker exits.
Repeated close/delete requests fail closed; shutdown reports a durability error
before application PID removal, unhosting, host shutdown or lock release. The
retained archive must be inspected with storage before recovery; repeating a
mutation does not repair its result durability. Unresolved phases after an accepted file notice retain the same barrier, including
preparation failure and unknown binary outcomes. Ordinary message transport failures
retain existing error cleanup behavior without inventing relay results. The
supervisor's existing 10-second watchdog can still force process exit, a separate
crash/restart boundary with the existing at-least-once limitations. A file notice
accepted before closure/shutdown suppresses its binary and records send_failed
plus the accepted metadata wire, rather than claiming queued file bytes.

A binary transport failure after an accepted file notice permits independently eligible recipients in the current serial pass, while deferring the failed recipient. It blocks subsequent passes and lifecycle cleanup; its typed failure takes precedence over ordinary errors at startup. Preparation or observed-result append failures stop the pass immediately.
