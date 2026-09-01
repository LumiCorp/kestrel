# Eliminate caller-asserted cleanup marker provenance

## Failed behavior

Quarantine labels every loaded cleanup result as normalized and trusts
payload-shaped marker keys. Rows written by an older runner have no durable
normalization provenance, so raw marker-like keys or generated-key prefixes can
forge diagnostics or collide after a rolling upgrade.

## Affected work

[Prevent forged cleanup evidence normalization markers](06x-prevent-forged-cleanup-evidence-markers.md),
commit `5d9eebaa3`, especially the caller-provided representation option and both
store quarantine read paths.

## Repair requirements

Remove caller-asserted trust in payload-shaped markers. Treat unproven legacy
rows as raw and make new writes/quarantine converge without inferring
provenance from user-controlled JSON. Do not add a schema migration without
explicit escalation.

## Done when

- Old-writer/new-reader raw marker and generated-key-prefix values cannot forge
  diagnostics or overwrite evidence.
- New cleanup results remain equivalent across in-memory and PostgreSQL paths.
- No payload shape alone grants trusted internal-marker semantics.

## Depends on

[Prevent forged cleanup evidence normalization markers](06x-prevent-forged-cleanup-evidence-markers.md).
