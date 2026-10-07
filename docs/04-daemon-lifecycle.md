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

## Persistent state ownership

Cowork holds an exclusive OS `flock` on the private `daemon.owner` file for the
worker's entire lifetime. Closing its descriptor or process death releases the
lock automatically, including after a container crash or host reboot. The file
itself remains in the state directory: **never remove or replace `daemon.owner`**
while a process could use that state. State must be on a local filesystem with
working `flock` support; unsupported locking fails startup rather than admitting
multiple owners. The native `fs-ext` dependency provides this lock on supported
Unix platforms; installation from source needs the usual Node native build tools
(Python, make and a C/C++ compiler), as does Cowork's SQLite dependency.

On Linux, `daemon.lock` (worker) and `daemon.pid` (supervisor) contain a numeric
PID on the first line and a versioned process identity on the second: host boot
ID, PID namespace and process start time from `/proc`. Restart can therefore
replace a stale record even when an unrelated process has reused its PID. A
matching live identity blocks startup. Unreadable identity, invalid/partial
records and insecure files fail closed. Linux startup requires readable process
identity metadata; other supported Unix platforms retain conservative numeric
PID checks in addition to the OS lifetime lock. CLI status/stop continue to use
the authenticated management session, never these bookkeeping PIDs to signal
processes.

Legacy numeric-only records cannot prove which process originally owned a live
PID. Cowork recovers them automatically only when the PID no longer exists. If a
legacy record refers to a reused live PID, first stop all old Cowork processes
and establish exclusive access to the state volume before removing only
`daemon.pid` and `daemon.lock`. In a container installation, the installer's
exclusive state-directory lock can provide that protection; never unconditionally
remove bookkeeping files on an unprotected native installation. After startup,
new Linux records carry the complete identity. Stop old binaries before upgrading
or downgrading; older versions do not understand the new identity records or take
the lifetime lock. This repairs stale ownership detection, without attributing
the interruption of cleanup to a particular shutdown/reboot cause.
