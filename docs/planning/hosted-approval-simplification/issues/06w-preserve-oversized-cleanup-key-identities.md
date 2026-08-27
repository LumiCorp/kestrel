# Preserve bounded identities for oversized cleanup evidence keys

## Failed behavior

Cleanup normalization slices object keys to 256 code units before storing or
hashing them. Distinct oversized keys with a common prefix can collide and
overwrite one another while the audit reports no source or shape truncation.

## Affected work

[Normalize cleanup quarantine values across stores](06t-normalize-cleanup-quarantine-values.md),
commit `b4500d627`, especially object-key normalization and bounded evidence
projection.

## Repair requirements

Represent oversized keys with a bounded collision-resistant identity that
retains canonical comparison evidence without retaining raw secret content.
Signal key truncation in the audit and prevent normalized-key overwrites.

## Done when

- Distinct oversized keys sharing a prefix remain distinct in canonical audit
  evidence.
- Oversized keys cannot overwrite each other during normalization.
- Audit truncation diagnostics truthfully report the bounded key projection.

## Depends on

[Normalize cleanup quarantine values across stores](06t-normalize-cleanup-quarantine-values.md).
