# Bind persisted V2 approval to current hosted authority

## Failed behavior

Self-consistent persisted V2 state can substitute a different organization,
Environment, Project, or actor tenant and pass restart validation because the
expected binding is loaded from that same state. Persisted V2 state with its
external binding removed is also accepted and given a fresh binding instead of
failing closed.

## Affected work

[Reject contradictory V2 approval authority](01a-enforce-v2-authority-consistency.md),
commit `57dcf643c`, especially `src/kestrel/contracts/tool-invocation.ts` and
`agents/reference-react/src/steps/acter/policyGates.ts`.

## Repair requirements

Persisted V2 replay must require a complete V2 binding and compare stable actor,
tenant, organization, Environment, Project, and thread authority with the
current trusted hosted context. The parser must reject actor-tenant and
organization contradictions. Initial in-memory preparation may remain
temporarily unbound only until the gate creates the first durable wait.

## Done when

- Deleted bindings and self-consistent cross-tenant/project substitutions fail
  closed on restart.
- Focused tests distinguish transient first preparation from persisted replay.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
