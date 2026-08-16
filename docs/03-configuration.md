# Configuration

The default config file is `~/.ours-cowork/config.json`. It is a strict document:

```json
{
  "version": 1,
  "brokerUrl": "wss://broker1.ours.network",
  "stateDir": "/absolute/private/path",
  "rest": { "enabled": true, "port": 3052 }
}
```

Environment overrides are `OURS_COWORK_CONFIG`, `OURS_COWORK_BROKER_URL`, `OURS_COWORK_STATE_DIR`, `OURS_COWORK_REST_PORT`, `OURS_COWORK_DAEMON_MODE`, `OURS_COWORK_DAEMON_ENDPOINT`, and `OURS_COWORK_DAEMON_STATE_DIR`. The default console URL is `http://127.0.0.1:3052/`. Setting the REST port enables the loopback listener on that port. Explicitly setting `rest.enabled` to `false` disables both the web console and HTTP room RPC. Configuration, private files, and the complete state directory must remain owned by the daemon account with the modes enforced at startup.

## Which ours daemon hosts the rooms

Omit the `daemon` block and nothing changes: cowork runs its own ours runtime below `stateDir`, which is what every existing installation does. There is no migration.

To host the room identities on an ours daemon you already run, add the block and name both fields:

```json
{
  "version": 1,
  "brokerUrl": "wss://broker1.ours.network",
  "stateDir": "/absolute/private/path",
  "rest": { "enabled": true, "port": 3052 },
  "daemon": {
    "mode": "external",
    "endpoint": "http://127.0.0.1:3050",
    "stateDir": "/home/operator/.ours"
  }
}
```

`endpoint` is the daemon's base URL — an `http`/`https` origin with no path, query, or credentials — and `stateDir` is the state directory that daemon owns. Point both at your common daemon (`http://127.0.0.1:3050` with `~/.ours`), or at a dedicated daemon on its own port with its own isolated state directory and service. Both fields are required together: an API token belongs to one state directory, and the SDK refuses to offer it to an endpoint that was not chosen just as deliberately.

`http://` is accepted only for a daemon on this host — `localhost`, any `127.0.0.0/8` address, or `[::1]`. Any other host requires `https://`, and a plaintext remote endpoint is rejected when the configuration is read, before a token is looked up. The API token is a bearer credential; cowork will not put one on the wire in the clear.

Cowork never asks for that token. It reads the daemon's own `daemon-token` file inside the state directory you named, or `OURS_API_TOKEN` when you set one. Tokens are never written into cowork's config file, its logs, or a generated service definition.

At startup cowork asks the endpoint which state directory it owns before sending any credential. If the endpoint is unreachable, is not an ours daemon, or owns a different state directory, startup fails and cowork stays stopped. It does not start a runtime of its own instead. `mode: "embedded"` states the default explicitly and rejects the two other fields.

The equivalent environment selection is `OURS_COWORK_DAEMON_ENDPOINT` plus `OURS_COWORK_DAEMON_STATE_DIR`, which imply external mode; `OURS_COWORK_DAEMON_MODE` sets it directly. `install-service` copies whichever selection is in effect into the generated unit.

CLI room commands always use `management.sock`; they do not switch to REST.

The HTTP listener is unauthenticated and restricted to the `127.0.0.1` interface. The console works through both `http://127.0.0.1:<port>` and `http://localhost:<port>`. Do not expose it through port forwarding, a reverse proxy, or a non-loopback bind.
