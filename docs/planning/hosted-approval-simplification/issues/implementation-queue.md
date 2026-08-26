# Hosted Approval Simplification Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free
frontier. Move issues between states as implementation and review change the
graph.

Implementation must start from deployed-source revision
`b36756002321b7a7e942d9a08799e7b01fa387f3` or a verified descendant.

## Ready

- [Bind persisted V2 approval to current hosted authority](01a1-bind-v2-to-current-host-authority.md)
- [Complete prepared execution ownership and shutdown safety](01c1-complete-prepared-resource-ownership.md)
- [Derive remembered identity from the locked source interaction](01f1-derive-remembered-identity-from-source.md)
- [Use one canonical persisted invocation for card and approval](01b-canonical-prepared-invocation-state.md)
- [Align the V2 approval prompt with its strict decisions](01e-align-v2-prompt-decisions.md)

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
  — review blocked by [Reject contradictory V2 approval authority](01a-enforce-v2-authority-consistency.md), [Use one canonical persisted invocation for card and approval](01b-canonical-prepared-invocation-state.md), [Release prepared execution resources when approval will not execute](01c-release-abandoned-prepared-executions.md), [Terminate expired V2 approvals without reusing expired authority](01d-terminate-expired-v2-approvals.md), [Align the V2 approval prompt with its strict decisions](01e-align-v2-prompt-decisions.md), and [Bind remembered records to the exact atomic remember decision](01f-bind-remembered-record-to-decision.md)
- [Reject contradictory V2 approval authority](01a-enforce-v2-authority-consistency.md)
  — review blocked by [Bind persisted V2 approval to current hosted authority](01a1-bind-v2-to-current-host-authority.md)
- [Release prepared execution resources when approval will not execute](01c-release-abandoned-prepared-executions.md)
  — review blocked by [Complete prepared execution ownership and shutdown safety](01c1-complete-prepared-resource-ownership.md)
- [Bind remembered records to the exact atomic remember decision](01f-bind-remembered-record-to-decision.md)
  — review blocked by [Derive remembered identity from the locked source interaction](01f1-derive-remembered-identity-from-source.md)

## Done

None.
