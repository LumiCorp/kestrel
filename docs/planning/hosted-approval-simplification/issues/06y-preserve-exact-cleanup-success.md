# Preserve exact cleanup success before evidence normalization

## Failed behavior

Cleanup-only normalization runs before exact DONE validation. It can replace a
valid long release identifier and reject real success, or omit malformed
undefined/function/symbol properties and upgrade invalid evidence into a valid
one-key release proof. Either direction violates exact-once cleanup.

## Affected work

[Normalize cleanup evidence before store-specific persistence](06v-normalize-cleanup-before-persistence.md),
commit `5d9eebaa3`, especially public result persistence and exact cleanup DONE
validation.

## Repair requirements

Decide exact cleanup success against the original result before any lossy
evidence projection. Preserve a valid exact result byte-for-byte at the value
level, including long and invalid-Unicode identifiers. Preserve invalidity for
extra undefined/function/symbol properties so malformed evidence can never
terminalize cleanup without release.

## Done when

- Exact long and invalid-Unicode prepared invocation IDs remain valid and do
  not trigger another release.
- Extra enumerable undefined/function/symbol properties remain invalid and
  converge through quarantine to one release retry.
- Both public production store paths cover these cases.

## Depends on

[Normalize cleanup evidence before store-specific persistence](06v-normalize-cleanup-before-persistence.md).
