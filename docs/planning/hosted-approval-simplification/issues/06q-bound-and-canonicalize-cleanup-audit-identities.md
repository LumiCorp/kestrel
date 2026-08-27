# Bound and canonicalize cleanup audit identities

## Failed behavior

Cleanup quarantine selects the first 16 object properties before sorting, so
equivalent malformed evidence can hash differently after JSONB reorders keys.
The audit also copies durable effect and result identifiers verbatim. A secret
embedded in a valid identifier becomes append-only audit data, while an
oversized identifier makes the metadata bound throw and prevents quarantine.

## Affected work

[Redact cleanup quarantine audit](06p-redact-cleanup-quarantine-audit.md),
commit `d1319b52b`, especially
`src/runtime/preparedApprovalCleanupAudit.ts` and its shared in-memory and
PostgreSQL callers.

## Repair requirements

Choose every bounded object-property subset with deterministic canonical
ordering before projection. Do not use locale-dependent ordering. Project all
untrusted or merely non-empty identifiers into bounded, non-sensitive evidence
that remains useful for exact comparison without storing their raw values.
The metadata bound must fail closed without throwing or preventing quarantine.
Preserve the trusted run-event coordinates needed to append the event.

## Done when

- Equivalent objects with different insertion order produce the same bounded
  hash and shape evidence, including after a JSONB-style key reorder.
- Secret-bearing identifiers are absent from append-only audit and replay.
- Oversized valid identifiers cannot exceed the metadata bound or abort
  quarantine.
- Focused tests cover reordered keys, secret identifiers, oversized
  identifiers, and both stores' shared projection.

## Depends on

[Redact cleanup quarantine audit](06p-redact-cleanup-quarantine-audit.md).
