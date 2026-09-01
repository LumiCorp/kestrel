# Bind the approval card to the canonical prepared invocation

## Failed behavior

Runtime-state validation compares the approval interaction and canonical
prepared call only by prepared invocation ID. A forged but internally
consistent interaction can describe a different tool identity and presentation
while policy validation later executes the original prepared tool.

## Affected work

[Use one canonical persisted invocation for card and approval](01b-canonical-prepared-invocation-state.md),
commit `addc425e1`, especially `src/runtime/state.ts`,
`src/runtime/assistantResponseContract.ts`, and codec tests.

## Repair requirements

Validate every card identity and canonical presentation field against the
prepared invocation from which it must be projected. The interaction must not
be independently mutable into a different displayed action while retaining the
same request or prepared invocation ID.

## Done when

- Changed card tool identity, stable identity, or presentation is rejected.
- The valid projected card survives codec round trip and restart.
- The card and consuming policy resolve the same canonical prepared call.

## Depends on

None.
