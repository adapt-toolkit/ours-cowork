# Daemon lifecycle

Use these commands:

```sh
ours-cowork start
ours-cowork status
ours-cowork restart
ours-cowork stop
ours-cowork serve
```

`start` detaches the standalone CLI in `serve` mode and waits for `management.sock`. `serve` keeps the supervisor in the foreground. Before status, stop, restart, or any signal, the CLI proves the complete Task 8 process chain: the private PID must name this CLI in `serve` mode, the private lock must name its live daemon worker, and that worker's parent must be the supervisor. A missing, stale, reused, unrelated, or ambiguous process is never signaled. A live but unverified PID blocks start/restart with invalid state so an operator can inspect it safely.

Exit codes are stable: `0` success, `2` CLI usage, `3` not found, `4` invalid state or parameters, `5` unauthorized, `6` daemon unavailable, and `7` internal failure. With `--json`, stdout contains exactly one JSON value and stderr stays empty. This includes foreground `serve`: supervised worker output is suppressed, and its clean or failed terminal status becomes that one JSON result.
