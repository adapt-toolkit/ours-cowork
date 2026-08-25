# Installation

Install the package so its `ours-cowork` executable is on your `PATH`, then verify the offline help:

```sh
ours-cowork --help
ours-cowork docs
```

Install and start the shared ours daemon first:

```sh
npm install --global @ours.network/cli@2.5.0
ours daemon start
ours daemon status --json
```

The external-history daemon is a breaking storage epoch, not an in-place migration. Before upgrading an older daemon, stop applications, take any manual backup you need, remove the old daemon state yourself, and start with clean state; then recreate identities and re-invite contacts as required. The installer and cowork never delete old state automatically.

Open the local console with:

```sh
ours-cowork web
```

This starts the cowork background daemon when it is absent, waits for `http://127.0.0.1:3052/`, and opens the system browser. It does not start the shared ours daemon. Use `ours-cowork start` when no browser should open, or `ours-cowork serve` in the foreground while diagnosing startup. `ours-cowork --json web` verifies readiness and returns the URL without opening a browser.

The localhost HTTP console has no authentication. Do not proxy, forward, or expose its port to another host. If the selected shared daemon is absent or reports a different state directory, cowork startup fails; there is no embedded fallback.
