# Reject downgraded V2 pending approval state

## Failed behavior

Durable V2 parsing is selected only when the outer pending-approval version is
present. Removing or changing that discriminator while retaining a V2 prepared
call bypasses current-host authority validation and permits the gate to prepare
a replacement invocation against the old approval response.

## Affected work

[Bind persisted V2 approval to current hosted authority](01a1-bind-v2-to-current-host-authority.md),
commit `d693036b6`, especially
`agents/reference-react/src/steps/acter/policyGates.ts`.

## Repair requirements

Any pending approval containing V2-only prepared state or binding fields must
either satisfy the complete V2 envelope or fail closed. Missing, altered, and
legacy discriminators must not downgrade, reconstruct, or replace durable V2
authority.

## Done when

- Removing or changing the outer V2 discriminator rejects the persisted state.
- No replacement invocation is prepared for malformed mixed-version state.
- Focused tests cover restart and an otherwise valid approval response.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
