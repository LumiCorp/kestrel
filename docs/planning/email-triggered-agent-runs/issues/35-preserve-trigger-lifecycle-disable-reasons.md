# Preserve Trigger lifecycle disable reasons

## Failed behavior

PATCHing `enabled:false` against an already disabled Trigger unconditionally writes `disabled_reason='manual'`. Because the enabled boolean does not change, the revision stays unchanged while the stable `project_archived` or `execution_owner_access_lost` reason is erased and a misleading audit event is added at the old revision.

## Affected work

This repairs [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md) in change `73c5375f3..049c82bef`, specifically `updateProjectEmailTrigger` disable semantics and lifecycle evidence.

## Repair requirements

Treat a repeated disable of an already disabled Trigger as a state-preserving operation: retain its lifecycle reason and revision and do not emit a new manual-disable audit event. A transition from enabled to disabled must still set `manual`, increment revision once, and audit that exact revision. Keep optimistic revision conflicts and all enablement checks unchanged.

## Done when

- Re-disabling `project_archived` and `execution_owner_access_lost` Triggers preserves the reason and revision.
- A repeated manual disable also leaves revision and audit history unchanged.
- An enabled-to-disabled transition still records `manual` with one revision increment and one audit event.
- API/store PostgreSQL regressions cover all three cases.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
