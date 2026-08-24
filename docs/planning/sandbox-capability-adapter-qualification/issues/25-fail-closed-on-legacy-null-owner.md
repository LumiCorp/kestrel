# Fail closed on legacy null prestarted ownership

## Wrong behavior

Validation currently assigns a tenant-null historical run and effects to whichever tenant-bound store reaches them first. Locks serialize the wrong claimant instead of proving ownership.

## Completion

- Never derive a legacy owner from the current store tenant alone.
- Generic tenant-null prestarted runs fail closed without mutation.
- Capability ownership may be reconstructed only from one exact, consistent durable lease authority.
- Wrong-first and mixed-owner memory/PGlite/PostgreSQL tests prove all rows remain unchanged.
