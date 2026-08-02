# Configuration

The default config file is `~/.ours-cowork/config.json`. It is a strict document:

```json
{
  "version": 1,
  "brokerUrl": "wss://broker1.ours.network",
  "stateDir": "/absolute/private/path",
  "rest": { "enabled": false, "port": 3052 }
}
```

Environment overrides are `OURS_COWORK_CONFIG`, `OURS_COWORK_BROKER_URL`, `OURS_COWORK_STATE_DIR`, and `OURS_COWORK_REST_PORT`. Setting the REST port enables the loopback REST listener. Configuration, private files, and the complete state directory must remain owned by the daemon account with the modes enforced at startup.

CLI room commands always use `management.sock`; they do not switch to REST.
