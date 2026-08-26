# Terminate expired V2 approvals without reusing expired authority

## Failed behavior

When V2 approval validation detects expiry, the gate falls through to another
wait while reusing the same expired embedded binding and publishing a fresh
top-level expiry. Every subsequent approval fails the same way, creating a
permanent re-approval loop.

## Affected work

[Persist the exact tool invocation before approval](01-persist-prepared-invocation.md),
commit `20f1c39fe`, especially the V2 validation and wait paths in
`agents/reference-react/src/steps/acter/policyGates.ts`.

## Repair requirements

Expiry must produce one explicit terminal expired outcome or a genuinely new
prepared invocation with fresh approval authority. It must never present an
expired binding as newly approvable, and it must release abandoned prepared
execution resources.

## Done when

- Responding after expiry cannot re-emit a wait backed by the expired binding.
- A focused clock-controlled regression check covers expiry and restart.
- The affected issue's original outcome and constraints still hold.

## Depends on

[Release prepared execution resources when approval will not execute](01c-release-abandoned-prepared-executions.md).
