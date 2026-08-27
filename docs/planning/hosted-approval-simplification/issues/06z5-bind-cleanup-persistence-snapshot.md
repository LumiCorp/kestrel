# Bind cleanup persistence to one pre-await evidence snapshot

## Failed behavior

Both stores read top-level result properties before descriptor snapshotting, so
a Proxy can mutate invalid evidence into valid proof or throw before the total
path. PostgreSQL also snapshots every DONE result before learning the effect
type, adding an observable extra inspection to ordinary effects, while its
invalid audit result still retains mutable raw references across the first
await. A throwing top-level error accessor is omitted from diagnostics.

## Affected work

[Snapshot exact cleanup evidence once before validation and persistence](06z2-snapshot-exact-cleanup-evidence.md),
commit `39d333fc7`, especially public cleanup result persistence and snapshot
construction.

## Repair requirements

Carry explicit cleanup persistence intent through the owning caller/store
contract so cleanup results can be safely materialized before any raw property
read or await without inspecting ordinary results. Derive lookup identity,
status, exact proof, and bounded immutable audit evidence from that single
materialization. Confirm the durable effect identity after locking it; fail
closed if the hint disagrees. Preserve unreadable output, error, and timestamp
diagnostics without invoking accessors.

## Done when

- Stateful or revoked top-level result proxies cannot bypass or abort cleanup
  quarantine.
- Mutation after the call cannot change invalid audit hash or shape.
- Throwing top-level error accessors produce truthful truncation evidence.
- Ordinary DONE results receive no cleanup-specific extra inspection.
- Public in-memory and PostgreSQL regressions cover the explicit cleanup path.

## Depends on

[Snapshot exact cleanup evidence once before validation and persistence](06z2-snapshot-exact-cleanup-evidence.md).
