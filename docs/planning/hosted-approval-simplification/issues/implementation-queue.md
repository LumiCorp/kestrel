# Hosted Approval Simplification Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free
frontier. Move issues between states as implementation and review change the
graph.

Implementation must start from deployed-source revision
`b36756002321b7a7e942d9a08799e7b01fa387f3` or a verified descendant.

## Ready

None.

## In progress

None.

## Blocked

- [Terminate expired V2 approvals without reusing expired authority](01d-terminate-expired-v2-approvals.md) — blocked by [Release prepared execution resources when approval will not execute](01c-release-abandoned-prepared-executions.md)
- [Resume the exact prepared invocation after approval](02-resume-prepared-invocation.md) — blocked by [Persist the exact tool invocation before approval](01-persist-prepared-invocation.md)
- [Make the thread interaction the approval decision owner](04-canonicalize-approval-lifecycle.md) — blocked by [Resume the exact prepared invocation after approval](02-resume-prepared-invocation.md)
- [Remember Ask First approval for the thread](03-remember-thread-tool-approval.md) — blocked by [Make the thread interaction the approval decision owner](04-canonicalize-approval-lifecycle.md)
- [Prove the hosted rollout and remove legacy approval paths](05-contract-legacy-approval-paths.md) — blocked by [Remember Ask First approval for the thread](03-remember-thread-tool-approval.md) and [Make the thread interaction the approval decision owner](04-canonicalize-approval-lifecycle.md)

## Implemented

- [Persist the exact tool invocation before approval](01-persist-prepared-invocation.md)
  — review blocked by [Use one canonical persisted invocation for card and approval](01b-canonical-prepared-invocation-state.md), [Release prepared execution resources when approval will not execute](01c-release-abandoned-prepared-executions.md), [Terminate expired V2 approvals without reusing expired authority](01d-terminate-expired-v2-approvals.md), and [Align the V2 approval prompt with its strict decisions](01e-align-v2-prompt-decisions.md)
- [Release prepared execution resources when approval will not execute](01c-release-abandoned-prepared-executions.md)
  — review blocked by [Complete prepared execution ownership and shutdown safety](01c1-complete-prepared-resource-ownership.md)
- [Complete prepared execution ownership and shutdown safety](01c1-complete-prepared-resource-ownership.md)
  — review blocked by [Close replay and snapshot-creation races](01c2-close-replay-and-snapshot-races.md) and [Make production MCP cleanup retryable](01c3-make-mcp-cleanup-retryable.md)
- [Use one canonical persisted invocation for card and approval](01b-canonical-prepared-invocation-state.md)
  — review blocked by [Bind the approval card to the canonical prepared invocation](01b1-bind-card-to-canonical-invocation.md)
- [Align the V2 approval prompt with its strict decisions](01e-align-v2-prompt-decisions.md)
  — review blocked by [Carry strict V2 decisions through hosted clients](01e1-carry-v2-decisions-end-to-end.md)
- [Close replay and snapshot-creation races](01c2-close-replay-and-snapshot-races.md)
  — review blocked by [Clean up the prepared run owner after continuation](01c5-clean-up-the-prepared-run-owner.md)
- [Make production MCP cleanup retryable](01c3-make-mcp-cleanup-retryable.md)
  — review blocked by [Serialize MCP retain, release, and retire](01c4-serialize-mcp-retain-and-retire.md)
- [Bind the approval card to the canonical prepared invocation](01b1-bind-card-to-canonical-invocation.md)
- [Carry strict V2 decisions through hosted clients](01e1-carry-v2-decisions-end-to-end.md)
- [Serialize MCP retain, release, and retire](01c4-serialize-mcp-retain-and-retire.md)
- [Clean up the prepared run owner after continuation](01c5-clean-up-the-prepared-run-owner.md)

## Done

- [Reject contradictory V2 approval authority](01a-enforce-v2-authority-consistency.md)
- [Bind persisted V2 approval to current hosted authority](01a1-bind-v2-to-current-host-authority.md)
- [Reject downgraded V2 pending approval state](01a2-reject-downgraded-v2-pending-state.md)
- [Bind remembered records to the exact atomic remember decision](01f-bind-remembered-record-to-decision.md)
- [Derive remembered identity from the locked source interaction](01f1-derive-remembered-identity-from-source.md)
- [Preserve canonical turn lock order for remembered approval](01f2-preserve-turn-lock-order.md)
