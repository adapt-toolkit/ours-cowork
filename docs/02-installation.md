# Installation

Install the package so its `ours-cowork` executable is on your `PATH`, then verify the offline help:

```sh
ours-cowork --help
ours-cowork docs
```

Open the local console with:

```sh
ours-cowork web
```

This starts the background daemon when it is absent, waits for `http://127.0.0.1:3052/`, and opens the system browser. Use `ours-cowork start` when no browser should open, or `ours-cowork serve` in the foreground while diagnosing startup. `ours-cowork --json web` verifies readiness and returns the URL without opening a browser.

The localhost HTTP console has no authentication. Do not proxy, forward, or expose its port to another host. The daemon hosts its own room packets and does not require another local ours process.
