# Incident #58: focused RPC analysis and remaining experiment

Read-only source inspection of installed @ours.network/cowork
1.3.3-nightly.20260926.ceab465 and its private installed SDK
3.8.1-nightly.14 confirms:

- Intake metadata is `listIncomingMessages` followed by per-message
  `getHistoryItem` in a Promise.all body slice. Files similarly list metadata and
  fetch each file before forwarding. One slow body/history/file operation delays
  the whole snapshot.
- Leading typed drain and acknowledgement call SDK `getMessages({limit:1})`.
  SDK dispatches command handlers and awaits `sendCommandResult` before that
  read returns. Limiting reads does not cancel a slow handler/result RPC.
- `sendRoomBody` -> `SdkRoomPacket.send` -> SDK `sendMessage` -> HTTP
  `post('sendMessage', args)` -> shared daemon. File metadata and binary sends
  are sequential. Native shared-daemon internals below that HTTP request were
  not instrumented in the incident.
- Installed SDK ordinary `post` does not attach its special 5-second signal
  unless its optional bounded flag is set; `sendMessage` calls ordinary `post`.
  Request-scoped signals may exist when the attaching caller supplies one.
  Cowork createClient does not supply one. This is a source observation, not a
  measured explanation of the 9–31 minute incident delays. Cancellation also
  would not prove that a send had not been accepted.
- SDK metadata lists have no paging arguments and return the full incoming
  metadata array; the source barrier intentionally does not use a 32-body slice.

Current main pins SDK3.7.2/CLI2.7.2, while the installed incident stack used newer
nightlies. Tests target repository dependencies. No installed package or live
runtime was changed, and no real-room fault injection occurred.

Isolated evidence: intake continued-arrivals and pre-consume >32 text/file tests;
SDK 70-entry unread metadata/typed barrier; real Unix management RPC during a
blocked restore; A blocked fanout + B started + ready/PID + tracked cleanup;
privacy/removal/reply/crash tests. The actual SDK HTTP client with an injected fetch
transport shows one sendMessage request remains pending until its synthetic
response is released, and a lost response throws without a newly added retry. Deliberate faults revert intake to its old
implementation, remove source read barriers, and omit management startup; named
regressions fail, then restoration passes. These demonstrate structural behavior,
not live per-RPC timing attribution.

## Still unresolved: stalled send in the same room

The first PR deliberately retains the room mutex during network fanout. It must
not close incident #58. Next isolated experiment: use the actual RoomService,
IntakePump, journal and SdkRoomPacket with a fake SDK send paused after dispatch.
While paused, inject a synthetic STOP source and request an invitation/removal;
measure whether source archival and management mutation finish before release.
The expected current failure is lock/head-of-line blocking. Then test a minimal
split: claim one durable per-recipient operation under the lock, dispatch outside
it, and commit its outcome under the lock. Preserve one in-flight operation per
recipient; keep file metadata+binary in the same lane; deliver a recorded reply
parent before its child. Revalidate current membership/privacy immediately before
dispatch and specify that removal cannot retract an already-dispatched operation.
Crash before/after dispatch, after acceptance, and before result fsync must retain
existing replay semantics or use a separately demonstrated transport operation
key/reconciliation contract. Do not race a timeout and start a second send.

This experiment is an isolated next step, not a promise that live STOP delivery
or invitation responsiveness is repaired. Production adoption and human QA remain
Owner-owned. No live investigation mutation, merge or deployment is authorized.
