# Bound cleanup quarantine audit timestamp

## Failed behavior

Cleanup audit hashes and bounds identifiers but copies the malformed result
timestamp verbatim into normal and fallback metadata. The in-memory store
accepts any timestamp string. A secret-bearing timestamp becomes append-only
audit data, and an oversized timestamp can produce metadata larger than the
declared 4 KiB limit because fallback is not checked again.

## Affected work

[Bound and canonicalize cleanup audit identities](06q-bound-and-canonicalize-cleanup-audit-identities.md),
commit `86cd2bec7`, especially `resultIdentity.originalTimestamp` and the
metadata-bound fallback in `src/runtime/preparedApprovalCleanupAudit.ts`.

## Repair requirements

Retain exact timestamp diagnostics only when the value satisfies the trusted
canonical timestamp contract. Otherwise store bounded hash/size/type evidence,
never the raw value. Enforce the metadata limit on the final event projection;
fallback must also remain within the bound and must not throw.

## Done when

- Canonical trusted timestamps remain directly diagnosable.
- Secret-bearing, malformed, and oversized timestamps are absent from audit
  and replay while retaining bounded comparison evidence.
- Normal and fallback metadata are both at most 4 KiB.
- Focused in-memory and PostgreSQL-path tests cover canonical, secret,
  malformed, and oversized timestamp inputs.

## Depends on

[Bound and canonicalize cleanup audit identities](06q-bound-and-canonicalize-cleanup-audit-identities.md).
