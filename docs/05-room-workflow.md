# Room workflow

Create a room and inspect its host-owned identity:

```sh
ours-cowork room create --goal "Ship the fix" --briefing "Review evidence first"
ours-cowork room list
ours-cowork room show <room-id>
```

Update mutable mission fields with `room settings`. Inspect admitted seats with `room participants`. A room activates only when its recorded invite requirements are satisfied. Roles are display labels; participant identity CIDs, not roles, are authorization keys.

Close with `ours-cowork room close <room-id>`. Close is forward-only and removes live room packet state while retaining the local archive. Archive deletion is a separate explicit operation described in the limitations topic.

