# Order legacy forks from complete runtime evidence

## Failed behavior

Issue 22 stopped treating reservation array order as submission authority, but exact evidence for one sibling is still used to assume every unresolved sibling is newer. That can reverse a stale sibling, while accepted-active state without a tombstone remains unrepaired. Direct terminal output uses ownership computed before durable graph normalization, multi-terminal restart views discard ordering, and dangling roots can still be extended when legacy accepted identity is absent.

## Affected flow

This repairs [Resolve legacy queue forks from exact authority](22-resolve-legacy-queue-forks-from-authority.md) as implemented by commit `d14477b37`.

The owning repair surface is authoritative conversation-turn and route reconciliation plus post-settlement lifecycle ownership. A collection's order, timestamps, or the arrival of one sibling alone cannot establish sibling order.

## Repair requirements

- Rewire an unresolved legacy fork only when complete exact runtime evidence determines the relevant sibling ordering. Use correlated session/thread/run/message identity and authoritative conversation turn sequence or route state; never array order, timestamps, or one sibling's arrival alone.
- If Q2 authority arrives while Q1 remains unresolved and runtime evidence cannot determine whether Q1 is older or newer, preserve ambiguity and fail closed. A delayed Q1 terminal cannot be fabricated as a successor of Q2 or overwrite Q2.
- Repair accepted-active Q1 plus sibling Q2 without requiring a Q1 tombstone when an authoritative view or duplicate exact start proves Q1 current and Q2 queued after it. Persist the repaired Q2->Q1 relationship before accepting Q2.
- Reconcile a one-shot restart view containing multiple exact terminal fork candidates in authoritative turn-sequence order. Advance accepted authority and tombstones through each exact candidate once; if sequence or correlation is missing/ambiguous, retain a durable fail-closed ambiguity that blocks Q3.
- After queued terminal synchronization, recompute whether the exact terminal owns current lifecycle from the resulting durable session state. Apply assistant/failure/cancel output and history once when Q2 was promoted by normalization; do not rely on a stale pre-settlement flag.
- Reject active chains with a missing/dangling root even when `acceptedRunId` is absent. A legacy record may be read for diagnosis/settlement, but no new queue may prepare or dispatch until exact authority repairs it.
- Preserve serialized settlement, pending pre-route events, checkpoint retry identity, independent tombstones, and exact environment authority.

## Done when

- Exact Q2 evidence with unresolved Q1 does not guess Q1's order; delayed Q1 terminal cannot overwrite Q2, and Q3 remains blocked until full authority resolves the fork.
- Accepted-active Q1 with no tombstone plus queued sibling Q2 repairs live and after restart from exact view/start evidence, then Q2 promotes normally.
- Direct completed/failed/cancelled Q2 terminals from accepted-Q1/tombstone-Q1/active-Q2 state emit their terminal output/history exactly once after durable promotion.
- A one-shot restart view with both terminal Q1 and Q2 orders and settles them from correlated authoritative turn sequence, or fails closed when that order is not exact; it never silently allows Q3 behind stale R0.
- `acceptedRunId`-absent dangling graphs block Q3 before preparation and dispatch.
- Existing graph, controller, app-command, session-store, restart, terminal-output, checkpoint, event-ordering, environment, and lifecycle focused files remain green.

## Depends on

None.
