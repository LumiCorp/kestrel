## Summary

- what changed
- why it changed

## Surface

- Desktop
- Web / Kestrel One
- CLI
- Evaluations / Ruhroh definitions
- SDK / package layer
- Runtime / shared contracts
- Docs only

## Validation

Confirm the canonical pull-request validation:

```bash
pnpm validate
```

List any focused process, PostgreSQL, Chromium, mutation, documentation,
Desktop, Ruhroh, or release checks separately when the change touches those
surfaces.

For the initial application-owned production-delivery cutover, add this note:

```text
Production owner: run `pnpm --filter @kestrel/kestrel-one production-delivery:prepare`, review the exact blockers and changes, then run the same command with `-- --apply` before advancing `production`.
```

Do not run apply mode in PR CI. It stages production worker configuration and
installs the shared notification token but does not deploy Machines or advance
the production branch.

## Notes

Anything reviewers should pay attention to.
