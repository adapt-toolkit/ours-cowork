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

If the shared daemon restarts underneath a running cowork, room notification watches reconnect with bounded backoff. A replacement watch fixes its new tip before cowork requests a full room refresh, so traffic arriving across the reconnect boundary is recovered by the refresh, the live watch, or harmlessly both.

`web` uses the same safe cowork start path: an already-running cowork daemon is retained, an absent cowork daemon is started, and readiness is checked with `GET /` before a browser opens. The shared ours daemon must already be running. `web` never retries a room mutation. With `--json`, it returns the URL with `opened: false` and has no browser side effect. If HTTP is explicitly disabled, `web` exits `1` and explains how to enable it.

Exit codes are stable: `0` success, `1` web console disabled, `2` CLI usage, `3` not found, `4` invalid state or parameters, `5` unauthorized, `6` daemon unavailable, and `7` internal failure. With `--json`, stdout contains exactly one JSON value and stderr stays empty. This includes foreground `serve`: supervised worker output is suppressed, and its clean or failed terminal status becomes that one JSON result.
