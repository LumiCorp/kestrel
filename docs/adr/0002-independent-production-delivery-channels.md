---
id: adr-0002-independent-production-delivery-channels
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-20
depends_on: [../index.md, 0001-stable-runtime-bundle-authority.md]
---

# ADR 0002: Application-owned production delivery

- Status: accepted
- Date: 2026-08-15
- Supersedes: ADR 0001 for hosted production delivery

## Context

Earlier implementations made GitHub Actions a release controller. Workflows
coordinated provider revisions, database state, signatures, configuration,
canaries, and rollback. That control plane was larger than the requirement and
failed before it ever established a dependable production path.

The actual requirement is smaller: build changed images after the protected
`production` decision, deploy each platform component safely, and advance the
default tenant runtime pair only after the existing tenant lifecycle proves it.

## Decision

GitHub builds, smokes, and publishes images. Kestrel deploys them.

One authenticated application endpoint accepts either one platform role image
or one Workspace Runtime/Router pair. Platform images are applied directly
through the Fly Machines API after establishing an active Machine, a stopped
standby, and the role's named readiness check from the existing app.
Runtime pairs reuse the existing Environment Runtime Version, channel, canary,
and `environment.update` lifecycle; the channel adds only a nullable desired
pointer.

Vercel's production build owns ordered database migration. Worker and platform
configuration remains at its provider and is never synchronized by an image
workflow. Production image identity is the fixed GitHub run-number tag.

## Consequences

- There is no release candidate, rollout controller, deployment queue, lease,
  heartbeat, cross-provider SHA condition, signature gate, or custom rollback.
- GitHub has no Machine or database mutation logic.
- One platform failure affects only that platform component.
- Runtime canary success uses the product's existing durable lifecycle proof.
- Runtime promotion changes the default for new Environments and never updates
  the remaining fleet automatically.
- Existing release tables remain only for the already-agreed rollback window
  and are removed in the later cleanup migration.
