# Configuration

The default cowork config file is `~/.ours-cowork/config.json`. It contains only cowork-owned settings and is strict:

```json
{
  "version": 1,
  "stateDir": "/absolute/private/path",
  "rest": { "enabled": true, "port": 3052 }
}
```

The optional `rest.host` accepts only `127.0.0.1` or `0.0.0.0`; omitting it keeps the `127.0.0.1` default. A container may explicitly use `0.0.0.0` so a host-loopback-only published port can reach the listener through the container interface. Bind that publication to host `127.0.0.1`, never a wildcard host or LAN address. The published host port must equal the container REST port because request validation accepts only `127.0.0.1:<REST port>` or `localhost:<REST port>` as the HTTP authority.

Room identity naming is not configurable. Creation NFC-normalizes the room name and uses `ours-cowork:<first 52 Unicode code points>`, making the complete SDK identity at most 64 code points without adding an opaque uniqueness suffix. ID-based and slug-based modes are unsupported.

Cowork overrides are `OURS_COWORK_CONFIG`, `OURS_COWORK_STATE_DIR`, and `OURS_COWORK_REST_PORT`. The default console URL is `http://127.0.0.1:3052/`. Setting the REST port enables the configured listener on that port. Explicitly setting `rest.enabled` to `false` disables both the web console and HTTP room RPC. Configuration, private files, and the complete cowork state directory must remain owned by the daemon account with the modes enforced at startup.

## Shared ours daemon selection

For V1, select the shared daemon with the complete non-secret environment triple:

```sh
OURS_DAEMON_URL=http://127.0.0.1:3050 \
OURS_DAEMON_ID=12345678-1234-1234-1234-123456789abc \
OURS_DAEMON_CREDENTIAL_PATH=/absolute/protected/current-token \
ours-cowork start
```

Use the actual configured lowercase daemon UUID and an absolute protected credential
file path. Cowork supplies these values to the official SDK with external session
mode for both its notification watcher and each independent room client. The SDK
checks daemon identity/capability metadata before reading the credential; HTTP
selection is not cryptographic server proof. Requests read the current file, so
atomic token replacement does not require a cowork restart. A partial triple fails
before attachment. Token bytes are never copied into cowork configuration, logs or
service definitions.

Without any V1 triple input, the temporary legacy SDK selection remains: the default
port3050 and `~/.ours`, `OURS_CONFIG`, or paired `OURS_PORT` and `OURS_STATE_DIR`.
That path proves state-root coherence through `/state-dir`. Failed V1 selection or
API requests never fall back to legacy mode. `ours-cowork install-service` preserves
chosen non-secret standard selection values, including the V1 UUID and credential
file path. Cowork’s strict application config schema is unchanged.

The old cowork keys `brokerUrl` and `daemon`, and the old overrides `OURS_COWORK_BROKER_URL`, `OURS_COWORK_DAEMON_MODE`, `OURS_COWORK_DAEMON_ENDPOINT`, and `OURS_COWORK_DAEMON_STATE_DIR`, have been removed. Supplying any of them is a startup error with migration guidance; they are never silently ignored. Configure broker and daemon lifecycle with `@ours.network/cli` instead.

Cowork persists each room's exact `identity_name` in durable room metadata before creating that identity. It filters the daemon-global identity list by those local names. This is application bookkeeping only: cowork does not infer ownership, root/role membership, provenance, or a same-user security boundary.

Fresh and packet-pending provisioning never adopt an identity merely because its name exists. Cowork validates the final name and checks its availability before writing a fresh sentinel; a proven SDK `NAME_INVALID` or `NAME_TAKEN` refusal discards only that exact empty sentinel. An established room is restored only against its durably recorded CID. A collision therefore fails closed. On upgrade, an empty-CID sentinel produced by the former overlength-name defect is rewritten to the bounded name before provisioning; an established non-empty-CID identity is never renamed. A forbidden SDK character retained inside the bounded name remains a typed failure and requires operator-assisted room recreation rather than lossy character replacement. In the rare crash window where the shared daemon committed a new identity before cowork persisted its CID, restart also fails closed rather than guessing ownership. Recovery requires an operator to verify that no cowork room metadata records the candidate CID, explicitly remove that exact orphan with the standard ours identity tooling, and then start or restart the cowork daemon; boot retries the packet-pending create. Identity removal is destructive—do not perform it when provenance is uncertain. `ours-cowork room recover` is unrelated invite-secret recovery and does not provision room identities.

CLI room commands always use `management.sock`; they do not switch to REST. The unauthenticated HTTP listener defaults to `127.0.0.1`; the explicit container listener described above does not permit non-loopback host exposure. Do not expose it through port forwarding, a reverse proxy, wildcard host publication, or a LAN address.
