# Use one canonical persisted invocation for card and approval

## Failed behavior

The full prepared invocation is copied into wait metadata, global pending
approval state, and region pending approval state. Approval-card projection and
approval validation read different copies without proving equality, so replay
or partial state drift can display action A while authorizing action B.

## Affected work

[Persist the exact tool invocation before approval](01-persist-prepared-invocation.md),
commit `20f1c39fe`, especially
`agents/reference-react/src/steps/acter/policyGates.ts` and
`src/runtime/assistantResponseContract.ts`.

## Repair requirements

Restore one canonical durable prepared invocation, or one canonical reference,
as the authority for both card projection and approval validation. Existing
state/replay contracts must not permit independently mutable full copies.
Preserve generic non-tool waits and old-version interactions.

## Done when

- Card projection and approval validation resolve the same canonical prepared
  invocation after codec round-trip and process restart.
- A focused regression check demonstrates that divergent duplicate state is
  impossible or rejected.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
