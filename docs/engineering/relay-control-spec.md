# Relay control-progress follow-up

Gates2–3 reviewed by independent Critic at #68; spec committed before red tests/implementation. PR59 remains d1aaf7b until successor review. Original numbered contract remains unchanged:

# Original acceptance criteria

1. Publish a redacted incident issue in the verified Cowork source repository and update the self-contained HTML report with delayed STOP, onboarding failure, and confidence limits.
2. Sustained incoming traffic cannot require the unread queue to reach zero before forwarding receives a bounded scheduling turn; queued work remains durable and shutdown remains tracked.
3. Management reports recovery progress while fanout is blocked, rejects unsafe room commands until prerequisites hold, and recovery fanout in one room does not delay starting another recovered room.
4. Preserve per-recipient ordering, reply dependencies, membership/privacy checks, durable queues and existing unknown-outcome handling; do not add blind timeout retries or mutate live identities/runtime.
5. Provide focused read-only RPC-path analysis and isolated fault-injection evidence, distinguishing demonstrated structural amplification from any still-untraced underlying transport latency.
6. Deliver a tested, independently reviewed PR referencing the issue, with exact-head evidence and gate ledger; hand off merge/deployment and human QA to the Owner without claiming live repair.


## Demonstration and scope

Actual OursClient injected fetch, SdkRoomPacket, durable CoworkStore, RoomService and IntakePump show: dispatched send pending; STOP source unarchived; same-room invite/removal receipts pending; separate room advances; no duplicate dispatch/result. Gate release makes all tracked controls succeed and STOP archive. Critic independently reproduced it. The next change removes this lock/reader scheduling amplifier. It retains one serial relay effect per room; a stalled recipient still delays that room's outbound fanout, and no transport deadline/retry is introduced. SDK typed-command result waits are a separate transport boundary; no false wall-clock guarantee.

## Smallest concrete design

One tracked ingress worker and one tracked serial relay worker per room; both use existing durable journal/intents, no new schema/dependency/lane framework. notify always wakes/coalesces ingress even when relay is pending. Explicit pump waits ingress and the relevant relay work for compatibility; resumePending schedules work and returns immediately when either worker is already active, including command callback reentry. Automatic bounded ingress turns never create a second relay worker or internally retry a failed/unknown intent. Existing explicit recovery/notification retry boundaries stay explicit; a rejected pass ends and propagates its error rather than immediately looping on dirty backlog.

Each relay effect: under mutex query next unresolved intent, reload current room and complete source/read-mark/privacy/thread/reply eligibility, construct canonical body, synchronously invoke packet effect, attach rejection handler and return plain object containing Promise. Async mutex must never assimilate that Promise. Await response outside mutex; append/fsync observed result under mutex; only then advance serial worker. Storage failure before dispatch means no send; result commit failure blocks later effects. No in-flight result is inferred from elapsed time.

SDK known NOT_BOUND/BINDING_REASSIGNED recovery: relay sends opt out of packet's transparent rebind/replay. Worker performs existing bounded rebind outside room mutex only after a definite binding refusal, then prepares eligibility/body again under mutex before redispatch. Limit to existing recovery allowance; ambiguous thrown effects are result-less and not retried by internal scheduling. Each actual dispatch is linearized under the room mutex against removals. Existing already-dispatched effect cannot be recalled; after removal no newly prepared effect may target departed seat.

File notice and binary are separate prepared effects: successful notice observed, latest membership/thread/reply checks run again before binary; removal during notice skips binary and appends appropriate terminal skip. No attachment accepted when unread source/read-mark is unknown. A stale unread snapshot may defer safely; failed metadata never permits dispatch. Do not claim stronger crash exactly-once: a crash between existing file phases can repeat notice as today.

Private rejection and removed-seat bounce: keep durable one-time claims (intake_rejection.notification_attempt_claimed and seat.bounced_at) before consuming/acknowledging source, but enqueue their content-free notices onto tracked serial effect work instead of awaiting them in the ingestion mutex. No retries after claim, even lost response/crash. Thus a notice cannot hold the ingestion mutex. Private payload/anonymous author funnel stays single.

Service receipts: removeParticipant and admission/role/post callers use non-self-awaiting resumePending scheduling so a pending unrelated relay does not delay an already committed control result. Test returned Promise completion, not only saved seat state. Avoid duplicate completion/journal mutation from concurrent notifier and service calls.

Lifecycle: mark room quiescing before waiting outside mutex for tracked relay/notice effects; no new relay dispatch during quiescence, preserve queued intents. Wait for in-flight response and result fsync BEFORE close removes contacts/unhosts or delete erases archive. close/delete must not await relay while owning mutex that completion needs. Coalesce concurrent lifecycle requests; failure resumes eligible work only when room metadata permits. Global shutdown stops intake, then waits both worker classes before packet/host/lock release. No force timeout/unhosting an unknown operation.

## Threat and usage simulation

Assets: private room/thread contents, anonymous identities, SDK unread sources and durable journal; entry points: existing local RPC, SDK notifications and room commands. No new authority/API. Abuse: removed recipient during held send/file notice/rebind; malicious replay/scoped-parent spoof; metadata failure; competing notification/service calls; shutdown/delete racing response; callback self-await. Work stays in isolated worktree, explicit synthetic SDK fetch only for fault injection.

User sends STOP during another response delay: source is archived/consumed by ingress, pending relay is tracked; invite and removal committed receipts return; existing dispatched effect may complete later; next effect checks new membership. Owner sees remaining outbound transport delay accurately. User closes/deletes during held response: lifecycle remains pending, no journal/unhost deletion until observed completion and durable result, management remains responsive.

## Additional scenarios mapped to original AC (no replacement criteria)

AC2: gated real SDK send allows later synthetic STOP archive/consume while response pending; source remains durable if shutdown begins; callback/bounce gate does not stop subsequent ordinary intake.
AC3: actual returned invite/removal Promise completes while old relay response pending; second room positive control; management status remains responsive; unsafe closed/quiescing commands fail closed.
AC4: one serial worker/effect and journal result-before-next-send; duplicate notify/resume no overlapping dispatch; parent linkage after commit; scoped privacy; remove during file notice suppresses binary; remove while known-binding recovery suppresses redispatch; failed metadata/storage never leaks; unknown response remains result-less with no internal retry; close/delete/shutdown await result commit outside mutex and retain queues.
AC5: extend actual-SDK injection diagnostic from baseline blocking to named red/green scenarios, include after-release positive controls and bounded test timeout that only fails test, never cancels/retries effect.
AC6: red tests commit before production changes; typecheck/build/focused unit + isolated SDK E2E + required real classes, Prove faults, exact-head independent code/test/security review, docs and criterion audit, Owner QA pending. Broader change uses full gates, no inherited PR59 approval.

## Current gates

Gates2–4 reviewed and committed; test-first gate5 active. Focused control+intake150/150 and nine-file safety412/412 passed, no skips; deliberate faults catch reader-error waiting, file membership and close quiescence, restored14/14. Exact committed source code/test/security review at gate6 and criterion audit at gate9 remain pending. Required real removal chronology correction is documented in sdk-fixture-provisioning.md and independently reviewed; the real classes still require successful execution.

## Concrete API and scheduling decisions after Critic review

- IntakePump keeps ingress `pumps` and new `relays` maps. `notify/pump/resumePending` are external requests and advance a per-room request epoch; automatic ingress snapshot continuation does not. `scheduleRelay` coalesces one worker and plain boxed effect; on rejection consume the latest already-requested epoch, propagate error, and do not relaunch until a fresh explicit external request/recovery. Test `unknown relay failure with forty-item automatic ingress backlog attempts once`.
- `sendRoomBody` and RoomPacket.send/sendFile accept optional internal `{recoverBinding:false}`. Default packet callers retain current rebind behavior; serial relay opts out, catches ONLY definite NOT_BOUND/BINDING_REASSIGNED, invokes packet.rebind outside mutex once, then re-prepares current eligibility/body under mutex. `prepareEffect` returns `{work}` from mutex, invokes effect synchronously and attaches rejection handler before return. No direct client transport calls outside packet adapter/funnel.
- `enqueueNotice` receives fixed immutable body, exact recipient and claimed participant/lifecycle eligibility, synchronously under claim mutex before acknowledgement. Serial relay owns the FIFO through shutdown; claim survives crash, queued notice may be lost as existing at-most-once. Rejections require the exact captured known seat and room state/epoch at notice dispatch (including historical content-free refusals for removed seats or already-closed hosted snapshots); removed bounce requires same removed seat, no active replacement. Both stop on durable closing/quiesce.
- Lifecycle authority is DURABLE: under mutex save state=closing before any wait, alongside existing lifecycle_request when present. Intake pause also observes closing/closed metadata. `quiesceRelay(roomId)` prevents future relay/notice dispatch and awaits only in-flight relay/notice work, never the calling ingress reader. Existing dispatched effect may append its result during closing; subsequent effects remain durable, unattempted.
- RoomService has a per-room lifecycle promise tail, no generic task framework. Public closeRoom/deleteRoom enqueue onto that tail; neither holds an outer room mutex while awaiting completion. A private close-and-drain path saves closing under mutex, waits quiesce outside, then closes/unhosts under mutex. Delete calls this private path, never public closeRoom while holding mutex, then erases archive under mutex. Duplicate close reads closed snapshot and honors fsync; delete-after-close chains; close-after-delete gets missing-room failure and never creates metadata. Rejected lifecycle tail allows a subsequent explicit retry using durable closing metadata.
- SDK room.close/room.delete handler returns existing accepted receipt before deferred afterPump lifecycle work. afterPump can wait relay quiescence because relay no longer depends on ingress reader. Global shutdown waits both classes before unhosting; operator close waits only current room relay/notice class. Test actual command-result accepted receipt while effect held, lifecycle pending, no self-wait, then response/result fsync before close/delete completion.

Named additional red tests (proposed files intake.test.mjs/sdk-runtime.test.mjs/service.test.mjs and isolated relay-control E2E):
1. `pending relay response permits STOP archive and invite/removal receipts` (actual SDK injection; prove observer/control promises, unrelated-room and after-release controls).
2. `duplicate notify and service resume keep one dispatched effect and ordered parent result`.
3. `removed recipient during file notice gets no binary or subsequent room body`.
4. `removed recipient during definite binding rebind gets no redispatch`.
5. `unknown relay failure with forty-item automatic ingress backlog attempts once`.
6. `missing unread metadata and source archive fsync failure never dispatch`.
7. `result fsync failure prevents later ordered effect`.
8. `private rejection and removed bounce claims permit later STOP intake while notice response held`.
9. `accepted SDK lifecycle command waits response commit without self-await or erased journal`.
10. `concurrent close/delete/shutdown retain in-flight result and never recreate deleted room`.
11. Existing scoped reply/file/anonymous privacy and mandatory real reply/removal classes, plus wrong immutable CID contact lifecycle test, rerun on exact successor.

The concrete design/spec gate passed before production implementation. Serial outbound residual remains explicit; existing RPC no-deadline/typed-command wait dependency stays external to this improvement.

Final design precision: immutable notice eligibility pins participant_id plus exact claimed membership/removal epoch and lifecycle version; removal→rejoin→removal must not revive an older bounce claim. Gate2–3 PASS artifact critic/DESIGN-RELAY-CONTROL.md.

## Implementation reconciliation and exact validation map

The actual reader method is drainIngress, with ACK outside the journal mutex after source/intents durability. No dead alternate ACK path remains. Claimed notice scheduling is immediate after durability; exact room/seat states and membership/removal epochs prevent a later lifecycle from reviving a claim. Actively closing/quiescing blocks dispatch. A reader error clears the sole-reader entry; pumpWork may await the already-tracked notice outside the reader and then propagates the original error. No fresh ordinary relay pass is launched solely because ingress failed. The fallback archive query implements intentRecordId identically to the indexed store.

AC2/4 named control suite:14 tests in relay-control.test.mjs, including fresh STOP after ACK failure with held relay, unknown response plus40-item backlog, file notice/rebind removal, result fsync ordering, metadata/source fsync fail-closed, shutdown retained unread, stale bounce, and lifecycle close/delete. Existing real archive/body notify tests exercise final-consume microtask wakeups and explicit recovery after ingress failure; existing reply/intake/thread/history/storage/service suites cover per-recipient ordering, parent copies and anonymous/scoped boundaries. AC3 retains daemon/CLI recovery tests plus returned invite/removal/close-state receipts in control suite. AC5 actual SDK injected fetch uses inert localhost only; failure deadlines fail tests without canceling effects. Prove logs preserve3named failing mutations and restored14/14.

Real SDK removal now uses an observed authoritative absence barrier, not the position of a source queued behind an uncertain operation. The baseline oldtest pass remains evidence, not a regression claim. Raw mutation requests and accepted effects are counted separately; before-removal grant is positively established, later source SDK consume and authorized sentinel archive/delivery prove the negative was exercised. No remaining old behavioral check is silently waived; concrete chronology correction is disclosed. Human QA/merge/deploy remain Owner-owned, and exact live RPC latency remains untraced.
