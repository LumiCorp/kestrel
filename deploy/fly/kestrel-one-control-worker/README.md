# Kestrel One release controller

This private, non-HTTP Fly process owns coordinated releases, hosted Environment
operations, lifecycle reconciliation and deletion, and Workspace backups. It is
outside the managed five-image release bundle, so deploying a bundle never
depends on first upgrading one of its own targets.

The controller consumes only revision-fenced queues declared in
`apps/web/lib/releases/controller-contract.ts`. Candidate registration requires
a fresh database heartbeat at the manifest's controller contract revision.
Legacy turn workers remain isolated on the unversioned queue names until they
are upgraded to the turn-only process.

## Production release gate

After additive migrations are verified, release a clean committed revision with:

```bash
pnpm --dir apps/web release:control-worker
```

The command pulls production configuration from the canonical
`lumi-kestrel/one` Vercel project, rejects missing required values, and imports
only the explicit allowlist through standard input. It requires all legacy
lifecycle queues to be idle before creating or updating
`kestrel-one-control-worker`, then verifies its readiness file and a heartbeat
newer than 90 seconds.

The main-branch image release workflow redeploys this worker at the exact commit
being published. It waits until Kestrel One production reports that same commit
before registering a candidate.
