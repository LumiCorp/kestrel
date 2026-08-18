# ADR 0002: Manual production delivery

- Status: accepted
- Date: 2026-08-15
- Supersedes: ADR 0001 for hosted production delivery

## Context

Earlier implementations made GitHub Actions a release controller. Workflows
coordinated provider revisions, database state, signatures, configuration,
canaries, and rollback. That control plane was larger than the requirement and
failed before it ever established a dependable production path.

The actual requirement is smaller: let Vercel deploy from the protected
`production` branch, then let an authenticated operator publish and move each
selected Fly, RunPod, or tenant runtime target independently.

## Decision

GitHub does not build or deploy production images. An authenticated operator
publishes one selected role and changes one selected provider target at a time.
Platform images use the provider-native Fly Machine update after the operator
reviews the current record and confirms the exact target. Runtime pairs reuse
the existing Environment Runtime Version, channel, canary, and
`environment.update` lifecycle.

Vercel's production build owns ordered database migration. Worker and platform
configuration remains at its provider and is never synchronized by an image
command. Production image identity is the operator-selected tag and provider
record.

## Consequences

- There is no rollout controller, deployment queue, cross-provider revision
  condition, or automatic fleet promotion.
- GitHub has no Machine or database mutation logic.
- One platform failure affects only that explicitly selected component.
- Runtime canary success uses the product's existing durable lifecycle proof.
- Runtime promotion changes the default for new Environments and never updates
  the remaining fleet automatically.
- Fly and RunPod changes remain manual until another ADR explicitly replaces
  this decision.
- Existing release tables remain only for the already-agreed rollback window
  and are removed in the later cleanup migration.
