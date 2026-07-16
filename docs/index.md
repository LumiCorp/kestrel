---
id: docs-index
domain: docs
status: active
owner: kestrel-quality
last_verified_at: 2026-07-16
depends_on:
  - ../AGENTS.md
  - ../ARCHITECTURE.md
  - ./PLANS.md
---

# Kestrel Documentation Map

Kestrel documentation has three layers. Choose the layer that matches your
task instead of reading the repository as one long manual.

| Layer | Audience | Purpose |
| --- | --- | --- |
| [Public docs site](https://docs.kestrelagents.dev) | People using, adopting, or operating Kestrel | Task-oriented product guides, tutorials, operations, and reference |
| Root truth docs | Contributors and maintainers | Current product boundaries, architecture, design, reliability, security, and quality policy |
| `docs/` working record | Maintainers and reviewers | ADRs, plans, runbooks, references, analysis, and historical evidence |

## Start by Goal

### Use Kestrel

- [Choose a first journey](../apps/docs/content/docs/quickstart.mdx)
- [Kestrel Desktop](../apps/docs/content/apps/desktop.mdx)
- [Kestrel One](../apps/docs/content/apps/web.mdx)
- [CLI and TUI](../apps/docs/content/cli/index.mdx)
- [0.6 Beta release status](../apps/docs/content/start/release-status.mdx)

### Build an Integration

- [Build your first agent](../apps/docs/content/build/building-your-first-agent.mdx)
- [SDK](../packages/sdk/README.md)
- [Next.js helpers](../packages/next/README.md)
- [AI SDK adapter](../packages/ai-sdk/README.md)
- [Observability](../packages/observability/README.md)
- [Protocol and terminal results](../apps/docs/content/build/protocol-and-results.mdx)

### Operate Kestrel

- [Operations overview](../apps/docs/content/operations/index.mdx)
- [Reliability](../RELIABILITY.md)
- [Security](../SECURITY.md)
- [Quality gates](../apps/docs/content/operations/quality-gates.mdx)
- [Deployment troubleshooting](../apps/docs/content/deploy/deployment-troubleshooting.mdx)
- [Evaluations with Ruhroh](../apps/docs/content/operations/evaluations.mdx)

### Change the Repository

- [Contributing](../CONTRIBUTING.md)
- [Architecture](../ARCHITECTURE.md)
- [Design principles](../DESIGN.md)
- [Plans index](PLANS.md)
- [Contributor guardrails](../AGENTS.md)

## Root Truth Docs

These files describe the current system and are checked for freshness:

- [README](../README.md) — public GitHub entry point
- [Architecture](../ARCHITECTURE.md) — ownership, authority, data flow, and invariants
- [Design principles](../DESIGN.md) — decision rules across runtime and product work
- [Reliability](../RELIABILITY.md) — verification, evidence, incidents, and recovery
- [Security](../SECURITY.md) — trust boundaries and disclosure
- [Quality score](../QUALITY_SCORE.md) — health signal and interpretation

## Working Record

### Architecture decisions

ADRs record decisions that should remain understandable after their
implementation plan is complete.

- [Runtime simplification boundaries](adr/0004-runtime-simplification-boundaries.md)
- [Managed RunPod Serverless control plane](adr/0005-managed-runpod-serverless-control-plane.md)
- [Workspace checkpoints](adr/0002-git-backed-workspace-checkpoints.md)
- [Project-scoped full-auto threads](adr/0003-project-scoped-full-auto-card-threads.md)

### Active plans

Use the [Plans index](PLANS.md) as the canonical plan inventory. High-signal
platform plans include:

- [Local platform architecture](plans/2026-07-13-kestrel-local-platform-architecture.md)
- [Kestrel One Threads and Projects](plans/2026-07-12-kestrel-one-threads-projects.md)
- [Transcript-first agent runtime](plans/2026-07-06-transcript-first-agent-runtime.md)
- [Runtime simplification baseline](plans/2026-06-08-runtime-simplification-baseline.md)

### Runbooks

Runbooks are operational procedures tied to a release, migration, or deployment
shape. Begin with the runbook that matches the exact version and surface.

- [Desktop 0.6 macOS release](runbooks/2026-07-13-desktop-v0.6-macos-release.md)
- [Kestrel One Environment cutover](runbooks/2026-07-13-kestrel-one-environment-cutover.md)
- [Gateway authority rollout](runbooks/2026-07-12-kestrel-one-gateway-authority-rollout.md)
- [MVP operator runbook](runbooks/2026-02-25-kestrel-mvp-operator-runbook.md)

### Reference contracts

- [Architecture rules](references/architecture-rules.json)
- [Artifact evidence recovery](references/artifact-evidence-recovery-contract.md)
- [Heuristic hotspots](references/heuristic-hotspots.md)
- [Lint invariants](references/lint-invariants.md)
- [Provider reasoning and agent progress](references/provider-reasoning-and-agent-progress.md)
- [Release tracks](references/release-tracks.json)
- [Workspace checkpoint thread identity](references/workspace-checkpoint-thread-id-contract.md)

### Evidence and analysis

Files under [`analysis/`](analysis) and [`references/`](references) may capture
point-in-time findings. Check their `last_verified_at`, linked revision, and
superseding plan before treating them as current product guidance.

## Documentation Ownership

- Public pages must be registered by
  [`apps/docs/lib/content-registry.ts`](../apps/docs/lib/content-registry.ts)
  before they can enter routes, navigation, search, related links, or static
  generation.
- Public editorial rules live in
  [`apps/docs/EDITORIAL.md`](../apps/docs/EDITORIAL.md).
- Internal plans, analysis, and archive material stay in the repository but do
  not enter the public docs automatically.
- Release-sensitive examples must match
  [`apps/docs/lib/release.ts`](../apps/docs/lib/release.ts) and exported code.

Validate documentation changes with:

```bash
pnpm run check:docs
pnpm run docs:test
pnpm run docs:build
pnpm run governance:check
```
