---
id: docs-index
domain: docs
status: active
owner: kestrel-quality
last_verified_at: 2026-07-17
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
| Root project docs | External technical readers or contributors, as stated by each document | Current architecture, design, reliability, security, and quality policy |
| `docs/` working record | Maintainers and reviewers | Current delivery plans and retained reference material |

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
- [CI contract-proof audit](ci-contract-proof-audit.md)
- [Contributor guardrails](../AGENTS.md)

## Root Truth Docs

These files describe the current system and are checked for freshness:

- [README](../README.md) — public GitHub entry point
- [Architecture](../ARCHITECTURE.md) — external technical explanation of local and remote execution, data flow, runtime guarantees, and trust boundaries
- [Design principles](../DESIGN.md) — decision rules across runtime and product work
- [Reliability](../RELIABILITY.md) — verification, evidence, incidents, and recovery
- [Security](../SECURITY.md) — trust boundaries and disclosure
- [Quality score](../QUALITY_SCORE.md) — health signal and interpretation

## Working Record

### Active plans

Use the [Plans index](PLANS.md) as the canonical current delivery inventory.

### Reference material

- [Architecture rules](references/architecture-rules.json)
- [Heuristic hotspots](references/heuristic-hotspots.md)

## Documentation Ownership

- Public pages must be registered by
  [`apps/docs/lib/content-registry.ts`](../apps/docs/lib/content-registry.ts)
  before they can enter routes, navigation, search, related links, or static
  generation.
- Public editorial rules live in
  [`apps/docs/EDITORIAL.md`](../apps/docs/EDITORIAL.md).
- Internal plans and reference material stay in the repository but do not enter
  the public docs automatically.
- Release-sensitive examples must match
  [`apps/docs/lib/release.ts`](../apps/docs/lib/release.ts) and exported code.

Validate documentation changes with:

```bash
pnpm run check:docs
pnpm run docs:test
pnpm run docs:build
pnpm run governance:check
```
