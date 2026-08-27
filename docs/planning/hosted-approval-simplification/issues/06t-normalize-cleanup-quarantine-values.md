# Normalize cleanup quarantine values across stores

## Failed behavior

The production in-memory store accepts arbitrary `EffectResult.output` values,
but quarantine prepares its replacement with a serializer that throws on
BigInt, throwing getters, and similar values. Every retry fails before mutation,
the immutable result remains DONE, and cleanup never reaches release. The audit
also hashes raw in-memory cycles/functions/symbols while PostgreSQL hashes their
JSON-persisted representation, so equivalent durable evidence differs by store.

## Affected work

[Make in-memory cleanup quarantine atomic](06r-make-in-memory-quarantine-atomic.md)
and [Bound and canonicalize cleanup audit identities](06q-bound-and-canonicalize-cleanup-audit-identities.md),
commit `86cd2bec7`, especially in-memory result persistence/quarantine, the
cleanup audit projector, and PostgreSQL JSON persistence.

## Repair requirements

Define one total, bounded cleanup-evidence normalization that cannot invoke an
uncaught getter, `toJSON`, enumeration, clone, or JSON serialization failure.
Use the same normalized durable representation before audit projection in both
stores and before the in-memory replacement mutation. Preserve useful bounded
shape/hash evidence without retaining raw secrets or unbounded content. Keep
ordinary effect behavior unchanged.

## Done when

- BigInt, throwing getters, throwing `toJSON`, proxies, functions, symbols,
  undefined, cycles, and invalid Unicode all quarantine through public store
  APIs and converge to one exact release retry.
- A failed or unusual value cannot append duplicate audit or leave a permanent
  unquarantinable DONE result.
- Equivalent in-memory and PostgreSQL-persisted malformed evidence produces the
  same audit hash and shape.
- Focused tests use public APIs and do not replace private store maps.

## Depends on

[Make in-memory cleanup quarantine atomic](06r-make-in-memory-quarantine-atomic.md)
and [Bound and canonicalize cleanup audit identities](06q-bound-and-canonicalize-cleanup-audit-identities.md).
