# Derive remembered identity from the locked source interaction

## Failed behavior

The dormant remembered writer compares two caller-provided identity objects but
does not derive stable tool identity from the locked source interaction. Any
legitimate `remember_approval` source can therefore be paired with an arbitrary
tool identity supplied consistently in both arguments.

## Affected work

[Bind remembered records to the exact atomic remember decision](01f-bind-remembered-record-to-decision.md),
commit `57dcf643c`, especially `apps/web/lib/turns/store.ts` and the hosted V2
interaction request contract.

## Repair requirements

The server-owned hosted interaction request must persist the stable tool
identity associated with its prepared invocation. The writer must derive and
validate remembered identity from that locked request plus authenticated table
authority, never from a second caller assertion. Keep the seam dormant and do
not activate remembered policy behavior.

## Done when

- A remembered identity absent from or different from the locked source request
  cannot be inserted even when caller values agree with each other.
- Exact source identity can be inserted atomically with a processing remember
  decision.
- Focused strict-protocol and PostgreSQL tests cover arbitrary identity
  injection.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
