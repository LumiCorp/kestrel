# Reject non-durable prepared invocation identifiers

## Failed behavior

Prepared invocation IDs accept lone UTF-16 surrogates. PostgreSQL JSON
persistence replaces them, while the runtime registry retains the original
key. Cleanup can then release the sanitized key, report success, and leave the
actual prepared handle retained.

## Affected work

[Preserve exact cleanup success before evidence normalization](06y-preserve-exact-cleanup-success.md),
commit `8f4cdedb9`, plus the prepared invocation identity parser and registration
boundary.

## Repair requirements

Reject non-durable invalid-Unicode prepared invocation IDs before registration
or persistence so every accepted identity round-trips through the existing JSON
and PostgreSQL contract unchanged. This is boundary validation, not heuristic
classification. Keep valid long Unicode identifiers supported.

## Done when

- Lone-surrogate IDs fail before any prepared handle is retained.
- Every accepted prepared ID round-trips through JSON persistence unchanged.
- Valid long identifiers still validate, persist, and complete exactly once.

## Depends on

[Preserve exact cleanup success before evidence normalization](06y-preserve-exact-cleanup-success.md).
