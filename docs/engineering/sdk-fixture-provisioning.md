# Isolated SDK test fixture provisioning

Follow-up to issue58 and draft PR59; original six acceptance criteria in relay-fairness-spec.md remain authoritative. This repair unblocks named required real-SDK classes for AC4; it does not resolve SDK concurrent provisioning or live relay latency.

Fast-lane eligibility: only test fixture setup in e2e.test.mjs and reply-relay-e2e.test.mjs; no production behavior, API, schema, dependencies, credentials or live runtime changes; no new attack surface. Preserve every behavioral assertion and concurrent messaging/admission activity.

Acceptance:
1. Both required real SDK classes run to their existing success markers, with every behavioral assertion preserved. Map: node --import tsx --test tests/e2e.test.mjs tests/reply-relay-e2e.test.mjs; counts and exit recorded.
2. Synthetic peer provisioning is serial and every created lease is registered immediately for cleanup. Map: exact setup diff and existing after cleanup; failed concurrent fixture reproductions already recorded.
3. Evidence distinguishes fixture readiness from actual removal/reply validation and does not claim a native SDK fix. Map: independent Critic review and AC4 ledger update only after full class pass.

Design/usage simulation: pinned SDK simultaneous createIdentity calls encounter ECONNRESET while daemon stays alive. Four serial identities succeed. First root then remaining three concurrently still fails, disproving bootstrap-only hypothesis. Sequential creates are setup prerequisites, not target behavior. Keep concurrent addContact/message tests and all checks. No retries, increased timeouts, skips, relaxed assertions or daemon state rewrites. Register leases immediately after attach, before createIdentity, so subsequent failure cannot leak them.

Threat baseline: independent temporary state and explicit isolated configuration/broker; synthetic identities only; no ambient host or runtime mutation. Critic #47 approved expanded setup-only design.

Red evidence: untouched baseline20fb8d2 required classes0/2fail; concurrent diagnostic0/1 ECONNRESET; root-first concurrent0/1 ECONNRESET; serial setup1/1pass. Last proves readiness only. Prove: reverting serialization recovered observed reset in isolated diagnostic; behavioral assertions remain unchanged.

## Reviewed removal chronology correction (AC4)

The setup-only repair exposed a separate timing-dependent E2E expectation. With identical serialized provisioning, baseline20fb8d2 passed the old ACTIVE/unchanged-epoch expectation; first mitigation failed it after authoritative fresh contact absence. Preserve both observations. Isolated actual-SDK evidence shows an uncertain response alone preserves authorization, whereas fresh confirmed absence must remove the seat exactly once with contact_absent and revoke grants. A baseline native target-send probe observed absent before send dispatch/present after response; native contact reintroduction is distinct from Cowork authorization and must not restore a removed seat. No production reconciliation policy is changed to satisfy the old assertion.

Replace only the ambiguous chronology's assertions with stronger deterministic checks: known caller grant before removal; after the real core accepted removal and lost response, wait for observed authoritative contact_absent seat removal, epoch+1 and revoked grant; restart and explicit replay leave that removal/epoch unchanged with no fabricated membership intent/result. Preserve the pre-command source archive/order assertion. The message queued after the command but BEFORE authoritative absence is concurrent with an unknown operation; its archiving is not a deterministic removal barrier. Instead send a uniquely named late source AFTER observed removal, follow it with an authorized sentinel, and verify no archive or fanout to healthy peers, while the sentinel is archived and reaches a healthy peer. Restart/replay cannot resurrect authorization. Keep all ordinary/scoped reply, privacy, self-removal refusal, concurrent messaging/admission, close/delete and daemon cleanup checks.

Review authority: independent Critic #57 permits correction only with this explicit authority evidence; #85 permits captured-state notice compatibility correction. Final exact test diff and running real class remain required; fixture readiness does not discharge AC4.
