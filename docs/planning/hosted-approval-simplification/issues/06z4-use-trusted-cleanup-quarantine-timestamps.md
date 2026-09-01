# Use trusted timestamps for quarantined cleanup results

## Failed behavior

PostgreSQL reuses an arbitrary malformed result timestamp for a `timestamptz`
insert, rolling back the audit and retry reset. In-memory quarantine carries a
hostile timestamp into `structuredClone`, so non-cloneable values can remain
permanently unquarantinable.

## Affected work

[Bound cleanup quarantine audit timestamp](06u-bound-cleanup-audit-timestamp.md)
and [Preserve exact cleanup success before evidence normalization](06y-preserve-exact-cleanup-success.md),
especially invalid-result replacement in both stores.

## Repair requirements

Use one trusted store-owned occurrence timestamp for the quarantine event and
FAILED replacement. Retain the original timestamp only as bounded redacted
audit evidence. Never clone, parse, or persist the hostile raw timestamp after
projection.

## Done when

- Malformed, oversized, secret-bearing, and non-cloneable timestamps quarantine
  and converge in both production stores.
- Durable audit and FAILED result timestamps are valid trusted timestamps.
- Original timestamp content is absent from audit and replay except bounded
  hash/type/size evidence.

## Depends on

[Bound cleanup quarantine audit timestamp](06u-bound-cleanup-audit-timestamp.md)
and [Preserve exact cleanup success before evidence normalization](06y-preserve-exact-cleanup-success.md).
