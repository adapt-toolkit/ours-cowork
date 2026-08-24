# Invites

Create one-time or public invites:

```sh
ours-cowork room invite <room-id> --role reviewer
ours-cowork room invite <room-id> --mode public --role observer --min-accepts 2
ours-cowork room revoke <room-id> <invite-id>
```

The invite blob is returned only in an invite or recovery receipt. Store or transmit that receipt as needed; durable room metadata intentionally does not store the blob.

Current SDK rooms expose the core's authenticated per-contact invite provenance. Cowork may therefore keep multiple invitations live concurrently: each established contact is admitted only through the exact live invite ID recorded by the verified handshake, and inherits that invite's role and requirement. Missing, unknown, revoked, or unconfirmed-recovery provenance never admits a seat.

For compatibility, an older SDK that omits the `origins` capability retains the single-live restriction. Legacy contacts without a stored origin remain unseated after upgrade; Cowork does not guess their role. Upgrade the ours SDK before relying on concurrent invitations.

The web console shows each returned invite secret once in a blocking receipt. Copy and save it before choosing Done: closing the receipt discards the browser copy. The secret is not placed in the URL, browser storage, logs, or room metadata. One-time and public receipts use the same handling.

After restart, `room recover <room-id>` can mint replacements for durable invites marked as needing replacement. Preserve each returned replacement blob before confirming its exact old/new pair with `room recover <room-id> --confirm <old-invite-id> <new-invite-id>`. The web recovery receipt names both IDs and requires the same confirmation. Each invocation makes exactly one local management request.
