# Preserve canonical turn lock order for remembered approval

## Failed behavior

Remembered-approval insertion locks the source interaction before its Thread,
while the canonical response transaction locks the Thread before the
interaction. Concurrent decision work can deadlock and cause PostgreSQL to
abort one transaction.

## Affected work

[Derive remembered identity from the locked source interaction](01f1-derive-remembered-identity-from-source.md),
commit `d693036b6`, especially `apps/web/lib/turns/store.ts` and
`apps/web/lib/turns/remembered-tool-approvals.postgres.test.ts`.

## Repair requirements

Use the established Thread-before-interaction lock order while continuing to
derive every remembered-record authority field from the locked source. Do not
weaken the atomic source-decision check.

## Done when

- Remembered insertion and canonical response handling acquire shared locks in
  the same order.
- A concurrent PostgreSQL regression test completes without deadlock and
  preserves one exact remembered record.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
