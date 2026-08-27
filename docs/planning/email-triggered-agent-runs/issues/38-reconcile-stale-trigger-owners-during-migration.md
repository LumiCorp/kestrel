# Reconcile stale Trigger owners during migration

## Failed behavior

Migration 0086 protects future Organization-member deletions, but it does not repair an enabled Trigger whose Execution Owner had already lost Organization membership under migration 0085. Because that former member row no longer exists, the new deletion trigger can never fire for the stale row, and later user deletion can still fail when the enabled owner reference is set null.

## Affected work

This repairs [Disable Triggers on Organization owner loss](34-disable-triggers-on-organization-owner-loss.md) in change `ef076fa69..32d0f6fe9`, specifically its migration and former-user deletion completion conditions.

## Repair requirements

Extend the unapplied additive owner-loss migration to reconcile every enabled, non-deleted Trigger whose Execution Owner no longer has Organization membership before installing the future deletion trigger. Disable the Trigger with the stable `execution_owner_access_lost` reason, increment revision exactly once, and record the same redacted Project audit evidence as the live deletion path. Preserve already-disabled and deleted rows. Add migration-level regression proof that begins from the pre-0086 schema and stale data state, applies the migration, verifies the one-time transition, and then proves the former user can be deleted without violating the enabled-owner invariant. Update the migration history checksum.

## Done when

- Applying migration 0086 disables existing stale enabled Trigger owners before future deletes are handled.
- The migration transition records the stable reason, exactly one revision increment, and address-free audit evidence.
- Already-disabled and deleted Trigger rows retain their reason and revision.
- Deleting the already-removed former user succeeds after migration and preserves the historical Trigger row with nullable references.
- Migration history, PostgreSQL upgrade regression, and the original live owner-loss tests pass.
- The affected issues' original outcomes and constraints still hold.

## Depends on

None.
