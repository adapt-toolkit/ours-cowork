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

`start` detaches the standalone CLI in `serve` mode and waits for the authenticated control session on `management.sock`. `serve` keeps the supervisor in the foreground. Status asks the responding worker to prove that its supervisor capability handshake completed. Stop sends a session-bound shutdown request to that worker; the worker asks its own supervisor over their existing authenticated IPC channel to enter the same bounded shutdown path used for signals. The CLI never signals a numeric PID. Stop reports success only after the accepted control session disappears. An occupied socket without this protocol blocks stop/restart with invalid state and is left untouched.

In external daemon mode (see Configuration) the same commands manage only the cowork daemon. Start that ours daemon first: cowork verifies the endpoint at boot and refuses to start while it is unreachable, so `start` reports an internal failure and `status` then reports the daemon as unavailable. `stop` and `restart` leave the external daemon running, and room state stays where it already is — room metadata and archives under cowork's `stateDir`, room identities inside the external daemon's state directory.

`web` uses the same safe start path: an already-running daemon is retained, an absent daemon is started, and readiness is checked with `GET /` before a browser opens. It never retries a room mutation. With `--json`, it returns the URL with `opened: false` and has no browser side effect. If HTTP is explicitly disabled, `web` exits `1` and explains how to enable it.

Exit codes are stable: `0` success, `1` web console disabled, `2` CLI usage, `3` not found, `4` invalid state or parameters, `5` unauthorized, `6` daemon unavailable, and `7` internal failure. With `--json`, stdout contains exactly one JSON value and stderr stays empty. This includes foreground `serve`: supervised worker output is suppressed, and its clean or failed terminal status becomes that one JSON result.
