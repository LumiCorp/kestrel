# Parse bootstrap authority evidence strictly

## Failed behavior

Authority PID parsing uses `Number.parseInt`, so malformed values such as `2147483647junk` are accepted as a numeric PID prefix. A malformed authority can therefore be treated as dead-owner proof and removed instead of failing safely.

## Affected flow

This blocks [Serialize developer-shell service bootstrap](04-serialize-service-bootstrap.md) and [Make bootstrap authority crash-safe and child-owned](07-make-bootstrap-authority-crash-safe.md).

## Repair requirements

- Accept only the canonical versioned authority evidence emitted by the writer.
- Require a canonical positive safe-integer PID with no sign, whitespace, suffix, decimal, or exponent form.
- Require the complete opaque token and reject missing or extra fields.
- Treat malformed evidence as `invalid_owner_evidence` without removing it.

## Done when

- Canonical evidence still acquires, waits, transfers, releases, and recovers correctly.
- PID suffixes, signs, whitespace, decimals, exponents, missing fields, and extra fields all fail safely.
- Focused tests prove malformed evidence is preserved rather than reclaimed.

## Depends on

None.
