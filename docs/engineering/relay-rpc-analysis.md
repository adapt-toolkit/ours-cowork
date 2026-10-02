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

## Demonstrated and addressed: stalled-send scheduling amplifier

The initial draft PR retained the room mutex while awaiting fanout. An isolated
actual-SDK injected-fetch experiment confirmed a dispatched pending send blocked
later synthetic STOP archival and same-room invitation/removal receipts while a
second room advanced. The independent Critic reproduced that diagnostic.

The successor splits one ingress reader from one serial relay worker per room.
It prepares authorization and synchronously invokes each effect under the room
mutex, returns a boxed promise, awaits the response outside the mutex, and commits
its result under the mutex before advancing. File notice and binary, and definite
binding-refusal recovery, recheck authorization before another effect. Closing
is durably marked before waiting outside the mutex for tracked response/result
completion. Unknown effects are never canceled or retried by automatic backlog
turns. Existing explicit/restart at-least-once recovery remains unchanged.

Named actual-SDK fault tests demonstrate STOP archive/consume and committed
invite/removal receipts during a held response, original ACK-error visibility
without retaining the reader, removal during file/rebind, and close/delete/shutdown
tracking. Deliberately restoring a reader wait, bypassing file membership, and
omitting close quiescence each fails its named guard; restored control14/14passes.
This evidence demonstrates scheduling behavior in isolated fixtures, not a live
repair or a universal RPC deadline. Each room still has serial outbound fanout;
a stalled recipient can delay later outbound STOP. Slow unread/body fetches,
typed-command result sends and native control RPCs remain transport boundaries.

## Real SDK fixture and contact-authority observations

Concurrent synthetic identity provisioning reproduced ECONNRESET on untouched
main and the draft. Serial provisioning ran the required ordinary/scoped reply
and restart class successfully. Test leases are registered immediately for cleanup;
no native SDK identity algorithm was changed. The removal class then exposed a
timing-dependent ACTIVE expectation after an accepted remove response was lost.
Untouched main with serialized provisioning passed that old test. A native target
send probe observed contact absent before send dispatch and present after its
response; that before/after association does not trace every native actor.

Actual-SDK authority controls distinguish uncertainty from confirmed absence:
an uncertain removal alone preserves active authorization; a subsequent fresh
snapshot showing contact absent removes the seat with contact_absent, revokes
its grants and advances its epoch exactly once. Native contact reintroduction
does not reauthorize that removed seat. The real E2E chronology correction is
explicit in sdk-fixture-provisioning.md: post-observation late source consume,
no archive/fanout, positive sentinel, stable restart/replay and raw mutation counts.
The first successor real run reached the late negative but its global-epoch
assertion incorrectly included a separate legitimate successor admission. That
unchanged admission is now after the negative; no production policy or assertion
was weakened. Final real-class and exact-head review results belong in the PR
ledger, rather than being assumed here.

The live incident's exact underlying RPC latency remains untraced. No installed
package/live runtime, identity/session or room was mutated. Merge, deployment and
human QA remain Owner-owned; issue58 remains open.
