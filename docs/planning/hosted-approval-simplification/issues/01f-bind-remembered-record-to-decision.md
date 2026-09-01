# Bind remembered records to the exact atomic remember decision

## Failed behavior

The dormant remembered-approval writer requires a source interaction already
marked resolved, so it cannot join the transaction that records the decision.
It also does not prove that the source decision is `remember_approval` or that
the stored stable tool identity matches the source prepared invocation. A
resolved decline can be cited to persist an arbitrary identity.

## Affected work

[Persist the exact tool invocation before approval](01-persist-prepared-invocation.md),
commit `20f1c39fe`, especially `apps/web/lib/turns/store.ts` and
`apps/web/lib/turns/remembered-tool-approvals.postgres.test.ts`.

## Repair requirements

The dormant storage seam must be usable in the same transaction that records a
future canonical `remember_approval` decision. It must require that exact
decision, actor, organization, thread, source interaction, and stable tool
identity. It must remain dormant: this repair does not add a response writer or
make remembered evidence affect policy.

## Done when

- Decline, approve-once, wrong actor/thread, and mismatched tool identity cannot
  create a remembered record.
- A focused PostgreSQL regression check proves exact validation can occur in
  the decision transaction without activating product behavior.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
