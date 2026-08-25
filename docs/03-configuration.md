# Configuration

The default cowork config file is `~/.ours-cowork/config.json`. It contains only cowork-owned settings and is strict:

```json
{
  "version": 1,
  "stateDir": "/absolute/private/path",
  "rest": { "enabled": true, "port": 3052 }
}
```

Room identity naming is not configurable. Creation uses exactly `ours-cowork:<normalized room name>`; ID-based and slug-based modes are unsupported.

Cowork overrides are `OURS_COWORK_CONFIG`, `OURS_COWORK_STATE_DIR`, and `OURS_COWORK_REST_PORT`. The default console URL is `http://127.0.0.1:3052/`. Setting the REST port enables the loopback listener on that port. Explicitly setting `rest.enabled` to `false` disables both the web console and HTTP room RPC. Configuration, private files, and the complete cowork state directory must remain owned by the daemon account with the modes enforced at startup.

## Shared ours daemon selection

Cowork uses the SDK 3 shared-daemon selection without wrapping or rewriting it. The wholly default selection is port 3050 with state directory `~/.ours`. For a configured daemon, point `OURS_CONFIG` at the configuration written by `ours config setup`, or set both `OURS_PORT` and `OURS_STATE_DIR`. The SDK proves the daemon's state root through the unauthenticated `/state-dir` route before sending a credential.

```sh
ours config setup --port 3070 --state-dir /srv/ours
ours daemon start
OURS_CONFIG=/absolute/path/to/ours-config.json ours-cowork start
```

`OURS_API_TOKEN` remains an SDK/operator input and is never copied into cowork configuration, logs, or generated services. `ours-cowork install-service` preserves non-secret `OURS_CONFIG`, `OURS_PORT`, and `OURS_STATE_DIR` selections present during installation.

The old cowork keys `brokerUrl` and `daemon`, and the old overrides `OURS_COWORK_BROKER_URL`, `OURS_COWORK_DAEMON_MODE`, `OURS_COWORK_DAEMON_ENDPOINT`, and `OURS_COWORK_DAEMON_STATE_DIR`, have been removed. Supplying any of them is a startup error with migration guidance; they are never silently ignored. Configure broker and daemon lifecycle with `@ours.network/cli` instead.

Cowork persists each room's exact `identity_name` in durable room metadata before creating that identity. It filters the daemon-global identity list by those local names. This is application bookkeeping only: cowork does not infer ownership, root/role membership, provenance, or a same-user security boundary.

Fresh and packet-pending provisioning never adopt an identity merely because its name exists. An established room is restored only against its durably recorded CID. A collision therefore fails closed. In the rare crash window where the shared daemon committed a new identity before cowork persisted its CID, restart also fails closed rather than guessing ownership. Recovery requires an operator to verify that no cowork room metadata records the candidate CID, explicitly remove that exact orphan with the standard ours identity tooling, and then start or restart the cowork daemon; boot retries the packet-pending create. Identity removal is destructive—do not perform it when provenance is uncertain. `ours-cowork room recover` is unrelated invite-secret recovery and does not provision room identities.

CLI room commands always use `management.sock`; they do not switch to REST. The HTTP listener is unauthenticated and restricted to `127.0.0.1`. Do not expose it through port forwarding, a reverse proxy, or a non-loopback bind.
