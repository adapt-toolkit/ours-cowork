# Daemon lifecycle

Use these commands:

```sh
ours-cowork start
ours-cowork status
ours-cowork restart
ours-cowork stop
ours-cowork serve
```

`start` detaches the standalone CLI in `serve` mode and waits for `management.sock`. `serve` keeps the supervisor in the foreground. `stop` signals the recorded supervisor and waits for its coordinated shutdown; it does not kill an unrelated or unverified process.

Exit codes are stable: `0` success, `2` CLI usage, `3` not found, `4` invalid state or parameters, `5` unauthorized, `6` daemon unavailable, and `7` internal failure. With `--json`, stdout contains exactly one JSON value and stderr stays empty.

