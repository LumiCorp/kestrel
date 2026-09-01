# Reject contradictory V2 approval authority

## Failed behavior

Strict V2 parsers validate authority fields independently but do not prove that
the persisted prepared call, stable authority, stable tool identity, and
external binding describe one actor, thread, tool, capability set, descriptor,
authority revision, and normalized action. Contradictory persisted authority
can therefore survive restart instead of failing closed.

## Affected work

[Persist the exact tool invocation before approval](01-persist-prepared-invocation.md),
commit `20f1c39fe`, especially `packages/protocol/src/approvals.ts`,
`src/kestrel/contracts/tool-invocation.ts`, and
`agents/reference-react/src/steps/acter/policyGates.ts`.

## Repair requirements

Restore one internally consistent V2 authority identity. Parsing and replay
validation must reject mismatches among the activation descriptor, effective
input, stable authority and its recomputed fingerprint, stable tool identity,
and external binding. Keep V1 parsing unchanged and exclude renewable
execution credentials from stable authority.

## Done when

- Contradictory actor, thread, tool, descriptor, capability, authority-revision,
  normalized-action, or fingerprint fields fail closed.
- A focused regression check covers malformed persisted state after restart.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
