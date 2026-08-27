# Hosted Approval Simplification Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free
frontier. Move issues between states as implementation and review change the
graph.

Remaining implementation must start from the current deployed production
source or a verified descendant. Revalidate the named seams before applying
changes. The Done issues below remain evidence of completed behavior and review
work; this queue does not reopen them.

## Ready

- [Preserve completed model telemetry when a run is canceled](07-preserve-cancellation-telemetry.md)
- [Order the V4 compatibility rollout](06d-order-v4-compatibility-rollout.md)

## In progress

- [Generalize prepared approval cleanup](06c-generalize-prepared-approval-cleanup.md)

## Blocked

- [Prove the hosted rollout and remove legacy approval paths](05-contract-legacy-approval-paths.md) — rollout proof and compatibility controls are already implemented; final production qualification, drain evidence, and cleanup are blocked by [the effective hosted tool decision](06-unify-hosted-tool-decision.md) and [truthful cancellation telemetry](07-preserve-cancellation-telemetry.md).

## Implemented

- [Release a Web-rejected prepared approval](06b-release-web-rejected-prepared-approval.md)
- [Version trusted hosted approval timing](06a-version-trusted-hosted-approval-timing.md)
- [Make hosted tool availability and approval one truthful decision](06-unify-hosted-tool-decision.md)

## Done

- [Remember Ask First approval for the thread](03-remember-thread-tool-approval.md)
- [Make the thread interaction the approval decision owner](04-canonicalize-approval-lifecycle.md)
- [Resume the exact prepared invocation after approval](02-resume-prepared-invocation.md)
- [Persist the exact tool invocation before approval](01-persist-prepared-invocation.md)
- [Reject contradictory V2 approval authority](01a-enforce-v2-authority-consistency.md)
- [Bind persisted V2 approval to current hosted authority](01a1-bind-v2-to-current-host-authority.md)
- [Reject downgraded V2 pending approval state](01a2-reject-downgraded-v2-pending-state.md)
- [Use one canonical persisted invocation for card and approval](01b-canonical-prepared-invocation-state.md)
- [Bind the approval card to the canonical prepared invocation](01b1-bind-card-to-canonical-invocation.md)
- [Release prepared execution resources when approval will not execute](01c-release-abandoned-prepared-executions.md)
- [Complete prepared execution ownership and shutdown safety](01c1-complete-prepared-resource-ownership.md)
- [Close replay and snapshot-creation races](01c2-close-replay-and-snapshot-races.md)
- [Make production MCP cleanup retryable](01c3-make-mcp-cleanup-retryable.md)
- [Serialize MCP retain, release, and retire](01c4-serialize-mcp-retain-and-retire.md)
- [Clean up the prepared run owner after continuation](01c5-clean-up-the-prepared-run-owner.md)
- [Terminate expired V2 approvals without reusing expired authority](01d-terminate-expired-v2-approvals.md)
- [Align the V2 approval prompt with its strict decisions](01e-align-v2-prompt-decisions.md)
- [Carry strict V2 decisions through hosted clients](01e1-carry-v2-decisions-end-to-end.md)
- [Bind remembered records to the exact atomic remember decision](01f-bind-remembered-record-to-decision.md)
- [Derive remembered identity from the locked source interaction](01f1-derive-remembered-identity-from-source.md)
- [Preserve canonical turn lock order for remembered approval](01f2-preserve-turn-lock-order.md)
