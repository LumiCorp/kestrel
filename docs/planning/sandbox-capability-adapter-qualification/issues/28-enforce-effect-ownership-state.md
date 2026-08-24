# Enforce effect ownership state

Status: repaired

## Defect

Prestarted-run validation enforced the new ownership state, but generic effect result and status mutations still trusted a null tenant ID by itself. An explicitly unbound store could therefore mutate a legacy-unknown generic effect.

## Repair

All generic effect mutation checks now consume the locked effect ownership state. Explicitly unbound effects remain compatible only in an unbound store, tenant-bound effects require the exact configured tenant, and legacy-unknown generic effects fail closed. Capability-backed legacy recovery retains its separate exact lease-evidence path.

## Evidence

In-memory and PGlite tests prove explicitly unbound mutations succeed and legacy-unknown result/status mutation is rejected without changing durable state.

