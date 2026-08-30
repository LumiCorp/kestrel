# Stabilize standalone binding revisions

## Failed behavior

Every omitted-binding standalone construction mints a fresh revision. Two otherwise identical supported instances therefore classify one another as incompatible and replace the shared daemon, interrupting live processes.

## Repair requirements

- Reuse one opaque revision for identical legacy store authority within the hosting process.
- Mint a different revision when the resolved driver or exact Postgres authority changes.
- Never expose a raw database URL or a raw hash of it as identity.
- Keep explicit Local Core bindings authoritative and unchanged.

## Done when

- Identical standalone instances share a daemon and preserve an active process.
- A changed legacy store authority receives a distinct opaque revision.

## Depends on

None.
