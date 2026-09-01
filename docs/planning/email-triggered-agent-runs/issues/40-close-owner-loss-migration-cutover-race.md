# Close the owner-loss migration cutover race

## Failed behavior

Migration 0086 reconciles stale enabled Trigger owners and installs the future `member` deletion trigger in separate statements. The reconciliation read does not exclude concurrent membership deletion. A deletion can therefore commit after reconciliation sees the member but before the trigger exists, leaving an enabled Trigger with no Organization member, no revision transition, and no owner-loss audit.

## Affected work

This repairs [Reconcile stale Trigger owners during migration](38-reconcile-stale-trigger-owners-during-migration.md) in change `9c02e44d5..2376e98d8`, specifically continuous coverage between upgrade reconciliation and the live deletion boundary. It also blocks [Disable Triggers on Organization owner loss](34-disable-triggers-on-organization-owner-loss.md) and [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md).

## Repair requirements

Make reconciliation and future deletion protection continuous for the entire migration transaction. Acquire the narrow PostgreSQL table lock needed to exclude `member` writes before taking the reconciliation snapshot and hold it through trigger creation; do not depend on statement ordering or default isolation alone. Preserve the existing reconciliation, redacted audit, and live trigger behavior. Add a coordinated two-connection PostgreSQL regression that begins the migration, proves a concurrent generic member deletion is waiting on the migration authority, installs the trigger and commits, then proves the deletion resumes through the new trigger and disables the Trigger exactly once. Observe lock blocking through PostgreSQL state rather than a timing-only assertion. Update the migration checksum.

## Done when

- Migration 0086 excludes concurrent membership deletion before reconciliation starts and until the live deletion trigger exists.
- A deterministic two-connection regression proves the concurrent delete waits, resumes after migration commit, and executes the installed trigger.
- The raced Trigger ends disabled with `execution_owner_access_lost`, exactly one revision increment, and one address-free audit event.
- Existing stale reconciliation, disabled/deleted preservation, former-user deletion, and ordinary live concurrency regressions remain green.
- Migration history, `pnpm validate:postgres`, and `pnpm validate` pass.
- The affected issues' original outcomes and constraints still hold.

## Depends on

None.
