# Prevent forged cleanup evidence normalization markers

## Failed behavior

Raw malformed output can contain the reserved `$kestrelCleanupEvidence` key.
Projection interprets its string value as an internal normalization marker, so
user data can forge circular, BigInt, array-truncation, or object-truncation
diagnostics.

## Affected work

[Normalize cleanup quarantine values across stores](06t-normalize-cleanup-quarantine-values.md),
commit `b4500d627`, especially the JSON-persistable marker representation and
its idempotent projection.

## Repair requirements

Separate raw user keys from trusted internal markers while retaining a
JSON-persistable, idempotent normalized representation for store parity. Avoid
heuristic marker recognition and preserve bounded secret-free evidence.

## Done when

- Raw marker-like keys cannot set internal truncation or value-kind signals.
- Genuine normalization markers survive JSON persistence and repeat
  normalization without changing audit hash or shape.
- Regression tests cover forged marker values and normalized replay.

## Depends on

[Normalize cleanup quarantine values across stores](06t-normalize-cleanup-quarantine-values.md).
