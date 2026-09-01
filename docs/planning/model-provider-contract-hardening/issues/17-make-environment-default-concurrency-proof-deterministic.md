# Make Environment default concurrency proof deterministic

## Failed behavior

Issue 16 adds a PostgreSQL concurrency regression, but it releases the credential rotation after a scheduler yield rather than proving that default selection reached the contended gateway row. The test can pass if selection starts after the rotation commits, including against the prior non-locking implementation. Its cleanup also leaves the test user in the shared database.

## Affected work

[Prove Environment default admission behavior](16-prove-environment-default-admission-behavior.md) was implemented in `013f6db99`. The production locking boundary is correct; this issue makes its behavioral proof reliable and leak-free.

## Repair requirements

- Use PostgreSQL lock/activity state from an independent observer connection to prove `setEnvironmentDefaultModel` is blocked on the rotation-held gateway row before releasing the rotation.
- Keep a bounded test timeout with a diagnostic failure if that contention never occurs.
- Delete the synthetic user after its organization cleanup.
- Preserve the existing exact qualified, unreachable, stale, and no-default assertions.

## Done when

- The concurrency regression fails against a non-locking selection path and passes only after the contested row lock serializes the rotation.
- The test cleanup leaves no organization or user fixture behind.
- Existing Issue 16 behavior remains green and its review finding is closed.

## Depends on

- [Prove Environment default admission behavior](16-prove-environment-default-admission-behavior.md) (implemented; review pending)
