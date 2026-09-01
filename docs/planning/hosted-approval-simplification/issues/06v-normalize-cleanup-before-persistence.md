# Normalize cleanup evidence before store-specific persistence

## Failed behavior

PostgreSQL serializes cleanup DONE output before the cleanup normalizer sees it,
while the in-memory store retains the raw value until quarantine. Cycles and
objects with `toJSON` therefore produce different durable representations and
different audit hashes by store. The PostgreSQL regression test masks this by
pre-normalizing a directly inserted value instead of using the public store API.

## Affected work

[Normalize cleanup quarantine values across stores](06t-normalize-cleanup-quarantine-values.md),
commit `b4500d627`, especially cleanup-result persistence in both stores and the
PostgreSQL parity regression.

## Repair requirements

Apply the same total cleanup-only normalization before any store-specific
serialization changes the value. Do not change persistence behavior for
ordinary effects. Exercise raw equivalent values through public in-memory and
PostgreSQL store APIs.

## Done when

- Equivalent raw cycles and `toJSON` values produce the same durable cleanup
  audit hash and shape in both stores.
- The PostgreSQL proof uses public effect-result persistence rather than a
  pre-normalized direct insert.
- Ordinary effect-result persistence remains unchanged.

## Depends on

[Normalize cleanup quarantine values across stores](06t-normalize-cleanup-quarantine-values.md).
