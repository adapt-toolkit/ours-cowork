# Relay fairness and recovery visibility — issue #58

Base: main 20fb8d2. Dedicated isolated checkout, no AGENTS.md present.

# Original acceptance criteria

1. Publish a redacted incident issue in the verified Cowork source repository and update the self-contained HTML report with delayed STOP, onboarding failure, and confidence limits.
2. Sustained incoming traffic cannot require the unread queue to reach zero before forwarding receives a bounded scheduling turn; queued work remains durable and shutdown remains tracked.
3. Management reports recovery progress while fanout is blocked, rejects unsafe room commands until prerequisites hold, and recovery fanout in one room does not delay starting another recovered room.
4. Preserve per-recipient ordering, reply dependencies, membership/privacy checks, durable queues and existing unknown-outcome handling; do not add blind timeout retries or mutate live identities/runtime.
5. Provide focused read-only RPC-path analysis and isolated fault-injection evidence, distinguishing demonstrated structural amplification from any still-untraced underlying transport latency.
6. Deliver a tested, independently reviewed PR referencing the issue, with exact-head evidence and gate ledger; hand off merge/deployment and human QA to the Owner without claiming live repair.

## Validated design (gates 2–3)

Independent Critic challenged typed-command/ack starvation, premature relay before consume, startup flush blocking readiness, cleanup tracking, authorization gates, and existing at-least-once replay. Preserve serial recipient sends under room mutex; no new dependencies, cancellation deadlines, retry policy or identity operations.

Each intake turn drains at most 32 leading typed SDK rows and snapshots at most 32 ordinary messages +32 files, then completes durable snapshot intents and attempts existing fanout. SDK acknowledgement consumes at most32 rows, returning an explicit deferred flag; unexpected read rows still archive durably. Obtain unread source metadata (no message bodies) before fanout; defer unread source intents and later work in their recipient lane, so a bounded turn/recovery cannot send before consumption. Pending intake/typed/deferred work requests another tracked pump turn after setImmediate. Keep finite local intent completion and existing full relay pass: count bound applies to intake before fanout, not room-lock hold duration or RPC wall time.

Expose aggregate daemon.recovery on the owner-only Unix socket and existing unauthenticated loopback HTTP with Host/Origin restrictions after host initialization and before room restore. Aggregate phase/room counters only, no identifiers, bodies, credentials or raw errors. Wrap ALL public/private service routes: reject until restore/lifecycle/reconcile/close prerequisites complete, also reject on shutdown. Existing supervisor controls retain the private socket boundary and session-bound shutdown protection. Start each healthy recovered room’s fanout independently using existing per-room pump; track startup promises alongside notification work, attach error handlers immediately. Boot/notification flush must not await backlog. PID/ready proceeds after prerequisites. Cleanup stops intake/transports then drains startup/notification work before service.drain/unhost/host shutdown/lock release. No timeout racing underlying sends.

A blocked send STILL holds the same-room mutex and can block invites/removal/intake in that room. This PR does not universally repair onboarding or STOP latency, prove exactly-once, or trace live RPC latency. Management visibility and other recovered rooms improve without weakening data safety.

## Threat baseline

Assets: durable room journal, source read-before-send barrier, scoped/private messages, membership, identity ownership, supervisor capability. Entry points: owner-only Unix RPC and unauthenticated loopback HTTP RPC with existing Host/Origin restrictions and SDK packet notifications. Abuse cases: service mutation during restore/shutdown, recovery status exposing body/CID/invite/raw errors, deferred source relay/privacy breach, reply parent ordering, crash-before-result duplicate/retry divergence. Keep existing socket permissions and HTTP Host/Origin restrictions; recovery route auth:true is a declaration, not request authentication; status exposes aggregate enum/counts only. No credentials/runtime edits or network redesign. Existing at-least-once result-less retry unchanged.

## Usage simulation

Operator starts with A backlogged and B ready: locally accessible aggregate recovery phase visible while restore runs; room commands reject. After structural recovery, A and B fanout start independently, ready/PID not blocked by A. B progresses while A awaits send. Stop begins existing shutdown, stops management intake, waits tracked work before unhosting; supervisor retains bounded forced-exit fallback. Under continuous text/typed arrivals, consumed sources forward between bounded snapshots. Deferred unread source blocks its recipient lane, not unrelated consumed lanes.

## DoD → evidence map

1. Manual: issue URL/body redaction, updated HTML parser and Critic report audit.
2. intake.test.mjs sustained traffic relay-before-empty + deferred-source/lane ordering + SDK runtime bounded typed drain/ack. Existing journal/coalescing/shutdown tests.
3. daemon.test.mjs blocked restore recovery RPC + public/private mutation rejection; blocked room A/B fanout + ready/PID + cleanup ordering/cancellation. Isolated owner-only Unix TransportServer RPC exercised.
4. Existing intake privacy/removal/file/replay, reply-relay-e2e and threads suites; deferred-source regression; no timeout retry sites added; Critic security/test audit.
5. docs incident RPC path: readonly source examination + named synthetic fault tests, no claim of observed live call duration.
6. Manual exact-head Critic review + PR URL/commit/commands/counts and gate ledger. Owner human QA/merge/deploy pending, not performed.

## Gate ledger

0 dedicated clone branch from freshly fetched main: done.
1 scope/numbered criteria/threat baseline: done.
2 simplification Critic challenge: done, serial sends/local intent completion retained.
3 usage simulation/independent design challenge: done with limitations above.
4 spec commit: ef1824b before red tests c5b6143; supplemental readiness red test45962a8.
5 TDD: primary red regressions committed before implementation; supplemental CLI readiness red0!=3. New7/7 and focused14files512 tests:510passed/2docwording failures, corrected release gate12/12passed/0failed/0skipped exit0; Prove3faults caught6tests. Cleanup reviewed; meaningful safety metadata/lane/file tests added. Real reply/removal E2E2/2 fail in peer creation on unchanged main; BLOCKED, not waived.
6 exact-head code/test/security Critic review: pending.
7 lifecycle/limitations docs updated; nested spec preserves package artifact boundary; RPC analysis and explicit unresolved same-room experiment documented.
8 implementation candidate commit follows with exact-head review.
9 per-criterion evidence in review packet; Critic audit pending, real reply/removal E2E blocked; human QA awaiting Owner.
10 draft PR publication authorized after review packet; merge blocked on required real SDK checks and Owner authority. No merge/deploy performed.
11 deploy: not authorized, Owner-owned.
12 production security/canary: gated on Owner deployment.
Human QA: awaiting Owner QA in an authorized isolated/production release environment.
