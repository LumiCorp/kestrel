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

For a Kestrel One turn-worker or gateway-keyring change, add this release note:

```text
Production release owner: run `pnpm --dir apps/web release:turn-worker` after approval.
```

Do not run that command in PR CI: it synchronizes production keyring secrets
from Vercel to Fly before deploying the worker.

For a Kestrel One release-controller or lifecycle-queue change, add this release
note:

```text
Production release owner: run `pnpm --dir apps/web release:control-worker` after migration verification and before queue ownership changes.
```

The controller release command refuses to proceed unless legacy lifecycle queues
are idle, and verifies both the deployed readiness contract and database
heartbeat.

## Notes

Anything reviewers should pay attention to.
