# Prove Environment default admission behavior

## Failed behavior

Issue 15 correctly makes hosted default admission transactional, but its regression test only inspects source shape. It does not demonstrate that the selector and mutation reject stale or unreachable registrations, or that a credential rotation interleaved with default selection cannot persist a default based on the old qualification.

## Affected work

[Make Environment default admission current and atomic](15-make-environment-default-admission-current-and-atomic.md) was implemented in `99f1e3de7`. Its implementation uses a joined `FOR UPDATE` transaction; this issue supplies behavioral proof for that existing boundary rather than altering the product contract.

## Repair requirements

- Add a PostgreSQL-backed regression that seeds a current, qualified hosted model and verifies the Environment selector exposes it.
- Verify an unreachable gateway and a credential-revision mismatch remain visible but are excluded from selection and rejected by the default mutation.
- Interleave a credential rotation with `setEnvironmentDefaultModel` using independent database connections. The mutation must observe the new revision, reject the stale registration, and leave no Environment default behind.
- Keep historical model registration metadata intact. Do not add a fallback, capability inference, or provider substitution.

## Done when

- The focused PostgreSQL test proves the selector and mutation outcomes for current, unreachable, and stale registrations.
- The concurrent credential-rotation test proves no stale default persists.
- Existing Issue 15 behavior remains green and its review finding is closed.

## Depends on

- [Make Environment default admission current and atomic](15-make-environment-default-admission-current-and-atomic.md) (implemented; review pending)
