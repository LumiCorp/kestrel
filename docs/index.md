---
id: docs-index
domain: docs
status: active
owner: kestrel-quality
last_verified_at: 2026-07-13
depends_on:
  - ../AGENTS.md
  - ../ARCHITECTURE.md
  - ./PLANS.md
---

# Documentation Index

This index maps the repo-level source-of-truth docs. Use it to find the canonical root docs, the supporting technical references under `docs/`, and the richer published docs site in `apps/docs`.

## Root Truth Docs

- [README.md](README.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [DESIGN.md](DESIGN.md)
- [RELIABILITY.md](RELIABILITY.md)
- [SECURITY.md](SECURITY.md)
- [QUALITY_SCORE.md](QUALITY_SCORE.md)

## Published Docs Site

- [Docs landing page](apps/docs/content/docs/index.mdx)
- [Architecture overview](apps/docs/content/docs/architecture-overview.mdx)
- [Quality gates](apps/docs/content/operations/quality-gates.mdx)
- [Runtime reference](apps/docs/content/runtime/index.mdx)

## Supporting Repo References

- [Plans Index](docs/PLANS.md)
- [Kestrel One app README](apps/web/README.md)
- [Kestrel-One production readiness evidence](docs/references/kestrel-one-production-readiness-evidence.md)
- [Kestrel One Environment canary evidence](docs/references/kestrel-one-environment-canary-evidence.md)
- [Kestrel One Environment cutover](docs/runbooks/2026-07-13-kestrel-one-environment-cutover.md)
- [Packaged desktop first-run capability audit](docs/analysis/2026-06-03-packaged-desktop-first-run-capability-audit.md)
- [Kestrel Local Core shell model](docs/plans/2026-06-17-kestrel-local-core-shell-model.md)
- [Kestrel local platform architecture](docs/plans/2026-07-13-kestrel-local-platform-architecture.md)
- [Kestrel Local Core beta migration evidence](docs/runbooks/2026-06-17-local-core-beta-migration-evidence.md)
- [CLI terminal client](docs/cli/kchat.md)
- [Kestrel Workspaces](docs/cli/workspaces.md)
- [CLI runner protocol](docs/cli/kchat-protocol.md)
- [Provider reasoning and agent progress](docs/references/provider-reasoning-and-agent-progress.md)
- [Next.js runner service integration](docs/integrations/nextjs-runner-service.md)
- [Runner SDK installation](docs/integrations/sdk-installation.md)

## External App Evaluations

- [Hermes Desktop feature inventory](docs/references/hermes-desktop/feature-inventory.md)
- [Hermes Desktop UI map](docs/references/hermes-desktop/ui-map.md)
- [Hermes Desktop UX review](docs/references/hermes-desktop/ux-review.md)
- [Hermes Desktop fit for Kestrel](docs/references/hermes-desktop/kestrel-fit.md)

## Reference Contracts

- [Runtime simplification boundaries ADR](docs/adr/0004-runtime-simplification-boundaries.md)
- [Managed RunPod Serverless control plane ADR](adr/0005-managed-runpod-serverless-control-plane.md)
- [Architecture rules](docs/references/architecture-rules.json)
- [Artifact evidence recovery contract](docs/references/artifact-evidence-recovery-contract.md)
- [Heuristic hotspots](docs/references/heuristic-hotspots.md)
- [Lint invariants](docs/references/lint-invariants.md)
- [Workspace checkpoint thread ID contract](docs/references/workspace-checkpoint-thread-id-contract.md)
- [Release tracks](docs/references/release-tracks.json)

## Historical Material

- [Plans Index](docs/PLANS.md)
- [v3 migration runbook](docs/runbooks/2026-02-26-v3-migration-runbook.md)
