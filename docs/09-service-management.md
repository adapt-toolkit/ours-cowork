# Service management

Install a per-user boot service with:

```sh
ours-cowork install-service
ours-cowork uninstall-service
```

Linux uses `ours-cowork.service` under the systemd user directory. macOS uses the `network.ours.cowork` launchd agent. Both definitions capture the installing process's absolute Node executable and the canonical installed cowork CLI path, then execute that pair in `serve` mode without relying on service-manager `PATH` lookup or the CLI's `#!/usr/bin/env node` shebang. They preserve the cowork state directory and optional REST port. They also preserve a non-secret SDK-standard `OURS_CONFIG`, `OURS_PORT`, or `OURS_STATE_DIR` selection present during installation. They never copy `OURS_API_TOKEN` or broker settings.

Install and start the shared daemon's own service first with `ours daemon install-service --yes`. Cowork never manages that service. Both cowork definitions restart on failure and keep retrying at a fixed interval for as long as the failure lasts. The systemd unit sets `StartLimitIntervalSec=0` with `RestartSec=5`, so an unavailable shared daemon does not permanently exhaust the start limit. A clean cowork stop is still final. The launchd agent uses `KeepAlive` and retries on launchd's own interval.

Installation rejects service values containing NUL, newline, carriage return, or other unsafe control characters before creating or replacing a definition. It then stops a manually detached cowork daemon through the authenticated control session before the service takes ownership. Uninstall first requires systemd to disable/stop the unit or launchd to unload the agent. If that operation fails, uninstall reports failure and retains the service definition for inspection or retry. After a successful unload, uninstall retains cowork configuration, room metadata and archives, and every identity in the shared daemon.

Re-run `ours-cowork install-service` after relocating or replacing either the Node runtime or the installed package. Reinstallation replaces the managed definition with the current absolute paths and remains safe to repeat; an old definition cannot follow a removed version-manager runtime or package location by itself.
