# Service management

Install a per-user boot service with:

```sh
ours-cowork install-service
ours-cowork uninstall-service
```

Linux uses `ours-cowork.service` under the systemd user directory. macOS uses the `network.ours.cowork` launchd agent. Both definitions execute the installed cowork CLI directly in `serve` mode and preserve the effective broker, state directory, and optional REST port settings. When an external ours daemon is selected, they also preserve its mode, endpoint, and state directory — never its API token, which the daemon keeps in its own state directory. A dedicated daemon needs its own service, installed and ordered before this one.

Installation rejects service values containing NUL, newline, carriage return, or other unsafe control characters before creating or replacing a definition. It then stops a manually detached daemon through the authenticated control session before the service takes ownership. Uninstall first requires systemd to disable/stop the unit or launchd to unload the agent. If that operation fails, uninstall reports failure and retains the service definition for inspection or retry. After a successful unload, uninstall removes only the service definition; it retains all cowork configuration, room archives, and embedded SDK identity state. Remove data only through the explicit closed-room deletion command or a separate, deliberate host-data operation.
