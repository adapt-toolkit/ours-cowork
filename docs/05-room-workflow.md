# Room workflow

Create a room and inspect its host-owned identity:

```sh
ours-cowork room create --name "Release bridge" --goal "Ship the fix" --briefing "Review evidence first"
ours-cowork room list
ours-cowork room show <room-id>
```

In the web console, choose Create room, enter Name, Goal, and Briefing, and submit once. Names are trimmed and Unicode NFC-normalized, must contain 1–64 Unicode characters, and cannot contain Unicode control or format characters. The bounded identity name must not collide with an identity already in the shared daemon. The created room is selected automatically and its Invite panel opens. Add invitation requirements one at a time; the UI does not combine room creation and invites into a fabricated atomic operation.

Update the display name with `ours-cowork room settings <room-id> --name "New name"`; other mutable mission fields use the same `room settings` command. A new room identity is `ours-cowork:<bounded creation name>`: NFC normalization followed by the first 52 Unicode code points, for a 64-code-point maximum including the prefix. That authenticated name is persisted and frozen. Messenger displays the retained human-readable prefix from the identity itself; longer local `room_name` metadata remains available in Cowork. Renaming a room changes only mutable local metadata; it does not change the identity name, CID, contacts, invites, URLs, history, or earlier author labels. Because identity names are daemon-global, the same normalized name—or distinct long names sharing the retained prefix—collides and fails cleanly without a losing room sentinel. Earlier unreleased ID- and slug-based formats are unsupported and receive no migration. Inspect admitted seats with `room participants`. A room activates only when its recorded invite requirement is satisfied.

Runtime commands are default-deny. Per-CID grants use `command-grant` and `command-revoke`. An operator may instead register a durable role policy with `role-command-set <room-id> --role <label> --commands <comma-list>` and inspect it with `role-command-grants`; use `--commands none` to remove it. A role policy authorizes only an authenticated, active seat whose durable admission role exactly matches the policy. Display names, message labels, pending seats, removed seats, and caller-supplied role text never confer authority. Removing a role policy does not remove an independently configured per-CID grant.

## Scoped reply threads

The dedicated `start_thread` runtime command creates a scoped reply thread after an operator grants that exact command name. Discover and invoke it through the SDK's generic command APIs, then use the SDK's native reply field:

```ts
const definitions = await client.listContactCommands({ contact: roomCid });
const start = definitions.find(c => c.name === 'start_thread');
if (!start) throw new Error('This room does not advertise start_thread');
await client.sendCommand({ contact: roomCid, command: start.name,
  arguments: { topic: 'Review', participant_ids: selectedParticipantIds,
    idempotency_key: stableKeyForThisCreation } });
// Receive the room's root normally; reply using YOUR received root wire ID.
await client.sendMessage({ contact: roomCid, text: 'My reply',
  reply_to_wire_id: receivedRoot.wire_id });
// Omitting reply_to_wire_id creates an ordinary whole-room message.
```

Here, `client` is an existing bound Ours client and `roomCid` is its room contact CID. Obtain `selectedParticipantIds` from the room's separately permitted `list-members` roster command; they are the chosen stable participant IDs and must include the creator. `stableKeyForThisCreation` is an opaque client-generated key reused only for identical retries. `receivedRoot` is this member's incoming copy of the root message, not another member's copy.

The input object has exactly `topic`, `participant_ids`, and `idempotency_key`. A topic contains 1–120 Unicode code points, contains at least one non-whitespace character, excludes Unicode control and format characters, and is trimmed after the raw value passes those bounds. An idempotency key contains 1–128 ASCII characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`. The participant list contains one or more distinct, active roster IDs. A one-member thread is valid; its replies are archived and acknowledged with no other recipient.

The authenticated creator must be active, selected, and granted `start_thread`. Creation records the selected seats as immutable pairs of participant ID and CID. Later admissions are not backfilled, and removing then re-admitting a CID does not restore access under its new participant ID. Roots and replies go only to selected original seats that are still active. A member does not need a `start_thread` grant to reply after receiving a root. Each recipient replies to its own received wire ID; Cowork translates each relayed reply to that recipient's copy of the immediate parent.

A successful command result is `{"ok":true,"thread_id":"<thread-id>","status":"accepted"}`. Acceptance means the root and its immutable recipient work were stored; delivery to each selected member proceeds independently and may be partial. Repeating the same creator key with the same normalized topic and participant set, in any participant order, returns the original receipt. Use these public errors without relying on diagnostic details:

| Error | Meaning |
| --- | --- |
| `unauthorized` | The caller is not an active granted creator, or the same creator/key belongs to an earlier seat incarnation. |
| `invalid_request` | The command object or one of its bounded fields does not match the advertised schema. |
| `invalid_members` | A selected ID is duplicate, unknown, inactive, or does not include the creator. |
| `idempotency_conflict` | The creator reused a key with a different normalized topic or participant set. |
| `reply_target_unavailable` | A reply target is missing, invalid, expired, ambiguous, foreign to the sender, or no longer authorized. The content is rejected and is never broadcast. |
| `thread_files_unsupported` | A file targets a scoped root or descendant; version one scoped threads carry messages only. |

Invalid scoped replies and scoped file attempts are durably rejected before their inbox item is acknowledged. Cowork makes one best-effort attempt to send the submitting member a private, fixed error-code notice; that notice can be lost, and a restart does not repeat it. The rejected content, target, and routing details are not included in the notice. If Cowork cannot prove a selected recipient's local parent copy during relay or restart, that recipient's delivery ends with a terminal unavailable result; private content is not sent without its reply link.

Membership changes are deliberately independent operator actions. Add a participant by issuing an invite for the intended role and admitting that identity; remove a participant with `ours-cowork room remove <room-id> <participant>`. To preserve coverage, add and confirm the new participant before removing the old one. To remove a dead participant first, remove it and issue a new invite afterward. Cowork does not combine these actions into a replacement operation or infer successor lineage.

Participant removal has no durable intent or result phase. Cowork asks the shared daemon to remove the contact, treats an already-absent exact contact as completion, and then records the seat as removed. If the daemon completed removal but its response or the following metadata save was lost, repeat the same remove command; the retry observes the absent contact and finishes the local update. Old prerelease `membership_intent` and `membership_result` history records remain readable but are inert: reconciliation, rebind, messaging, close, and deletion never replay them.

Close with `ours-cowork room close <room-id>`. Close is forward-only and removes the live standard SDK room identity while retaining the local archive. Archive deletion is a separate explicit operation described in the limitations topic.

If the shared daemon restarts or a room SDK lease is lost, Cowork automatically attempts a non-force rebind of the room's exact persisted identity name and verifies its pinned CID before resuming the rejected operation. Concurrent recovery joins one attempt; transient connection failures use bounded exponential backoff. A live competing session, missing identity, or CID mismatch fails closed and is never force-bound or recreated. Startup isolates rooms that cannot be safely restored, releases their local leases, and continues serving healthy rooms.

Use `ours-cowork room rebind <room-id>` for explicit recovery. This canonical operation applies the same name-and-CID proof, refreshes SDK contact/invite state, reconciles the room, and resumes durable pending fanout before reporting success. It refuses closing or closed rooms. Structured daemon logs emit `identity_rebind_*` and `startup_room_recovery_failed` events for diagnosis.

Every web action has an equivalent CLI fallback in the room commands above and in the invites and messaging topics.

## Shared ours command calls

Room-scoped operations also appear in the room identity's ours catalog with their RPC names: `room.settings`, `room.briefing.role.set`, `room.briefing.role.delete`, `room.invite`, `room.participant.remove`, `room.revoke`, `room.recover`, `room.recover.confirm`, `room.show`, `room.participants`, `room.command.grants`, `room.command.role.grants`, `room.command.role.set`, `room.command.grant`, `room.command.revoke`, `room.history`, `room.message`, `room.say`, `room.role.rest.add`, `room.role.rest.remove`, `room.accept`, `room.rebind`, `room.close`, and `room.delete`.

Use the RPC arguments without `room_id`; the receiving room fixes the target. For example, an operator grants `ours-cowork room command-grant <room-id> <caller-cid> room.settings`, then that active member calls `room.settings` with `{"status":"review"}` using ours command transport. A grant for one name grants none of the other names. The SDK returns a correlated result containing `{ok:true,result:<service value>}` or `{ok:false,error:<code>}`. History returns one page; follow `seq` with `after` to fetch more.

`start_thread`, `list-members`, and `remove-member` are dedicated runtime commands rather than shared management routes. `list-members` retains its contact-safe roster. `remove-member` retains its epoch, confirm and no-self-removal gates. The separate `room.participant.remove` command instead grants the full operator removal behavior. `room.show` returns only public room settings and mission content; `room.participants` returns participant IDs, roles, and states. Runtime `room.history` returns only messages visible to the authenticated active seat, with viewer-local cursors, and rejects operator view. Runtime `room.message` and `room.say` return only an accepted message-ID receipt. Host management routes retain their full operator results. Policy-administration commands can delegate more privileges; `room.message` and `room.say` authorize room/role authorship. Assign these permissions deliberately. Command results may include invite material; do not relay them into chat.

Host lifecycle and global room creation/listing are excluded. `room.accept` accepts invitation input through its separate grant and remains unavailable through REST. Ours close/delete return a durable accepted receipt before closing the reply channel; verify completion through management. Close retains archive/files; delete requires `confirm:true`, closes first, and erases local room data. Pending lifecycle requests resume after restart; failed requests remain visible in room metadata for explicit management retry. Missing replies do not prove a mutation failed.

The SDK owns command reply delivery and its size limits. Large history pages or a single large file record may exceed that transport's capacity; use CLI/REST for those results. No additional result-omission contract is introduced.
