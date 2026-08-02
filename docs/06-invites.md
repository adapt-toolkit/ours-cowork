# Invites

Create one-time or public invites:

```sh
ours-cowork room invite <room-id> --role reviewer
ours-cowork room invite <room-id> --mode public --role observer --min-accepts 2
ours-cowork room revoke <room-id> <invite-id>
```

The invite blob is shown only in the create receipt. Store or transmit that receipt as needed; durable room metadata intentionally does not store the blob.

After restart, `room recover <room-id>` can mint replacements for recorded public invites whose secrets are unavailable. Preserve each returned replacement blob before confirming it with `room recover <room-id> --confirm <old-invite-id> <new-invite-id>`. Each invocation makes exactly one local management request.
