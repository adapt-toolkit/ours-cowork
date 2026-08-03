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

Environment overrides are `OURS_COWORK_CONFIG`, `OURS_COWORK_BROKER_URL`, `OURS_COWORK_STATE_DIR`, and `OURS_COWORK_REST_PORT`. The default console URL is `http://127.0.0.1:3052/`. Setting the REST port enables the loopback listener on that port. Explicitly setting `rest.enabled` to `false` disables both the web console and HTTP room RPC. Configuration, private files, and the complete state directory must remain owned by the daemon account with the modes enforced at startup.

CLI room commands always use `management.sock`; they do not switch to REST.

The HTTP listener is unauthenticated and restricted to `127.0.0.1`. Do not expose it through port forwarding, a reverse proxy, or a non-loopback bind.
