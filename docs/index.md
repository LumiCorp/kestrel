---
id: docs-index
domain: docs
status: active
owner: kestrel-quality
last_verified_at: 2026-08-13
depends_on:
  - ../AGENTS.md
  - ../ARCHITECTURE.md
  - ./PLANS.md
  - ./developer-onboarding/README.md
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
- [Workspace skills](workspace-skills.md)
- [0.8 release status](../apps/docs/content/start/release-status.mdx)

### Build an Integration

- [Build your first agent](../apps/docs/content/build/building-your-first-agent.mdx)
- [SDK](../packages/sdk/README.md)
- [Next.js helpers](../packages/next/README.md)
- [AI SDK adapter](../packages/ai-sdk/README.md)
- [Conversation kernel](../packages/conversation/README.md)
- [Observability](../packages/observability/README.md)
- [Protocol and terminal results](../apps/docs/content/build/protocol-and-results.mdx)
- [Sandbox capability adapters](../apps/docs/content/reference/sandbox-capability-adapters.mdx)

### Operate Kestrel

- [Operations overview](../apps/docs/content/operations/index.mdx)
- [Reliability](../RELIABILITY.md)
- [Security](../SECURITY.md)
- [Quality gates](../apps/docs/content/operations/quality-gates.mdx)
- [Deployment troubleshooting](../apps/docs/content/deploy/deployment-troubleshooting.mdx)
- [Production release runbook](production-delivery-channels.md)
- [Sandbox capability black-box qualification](operations/sandbox-capability-qualification.md)
- [Hosted Workspace runtime recovery](hosted-workspace-runtime-recovery.md)
- [Operations glossary](glossary.md)
- [Evaluations with Ruhroh](../apps/docs/content/operations/evaluations.mdx)

### Change the Repository

- [Developer onboarding reader](developer-onboarding/README.md)
- [Contributing](../CONTRIBUTING.md)
- [Architecture](../ARCHITECTURE.md)
- [Design principles](../DESIGN.md)
- [Plans index](PLANS.md)
- [Architecture decisions](decisions/0001-unified-suite-version-and-release-channels.md)
  - [Confined Docker capability transport](decisions/0003-confined-docker-capability-transport.md)
  - [Tavily sandbox read capability](decisions/0004-tavily-sandbox-read-capability.md)
- [Stable Runtime Bundle authority](adr/0001-stable-runtime-bundle-authority.md)
- [Independent production delivery channels](adr/0002-independent-production-delivery-channels.md)
- [CI validation](ci-validation.md)
- [Contributor guardrails](../AGENTS.md)

## Developer Onboarding

The [developer onboarding reader](developer-onboarding/README.md) is the
detailed internal path for engineers and agents that are new to the monorepo.
Its 110 source-linked units explain the product nouns, architecture decisions,
deployment forms, package flow, execution paths, persistence boundaries,
security model, reliability contracts, and expected repository workflow.

The reader is stored as portable HTML under `docs/developer-onboarding/`. It is
designed to be read and searched rather than presented, and individual units
can be opened in focused mode. It is an orientation and architecture-navigation
artifact; linked owning sources remain authoritative.

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

- [Developer onboarding reader](developer-onboarding/README.md)
- [Architecture rules](references/architecture-rules.json)
- [Heuristic hotspots](references/heuristic-hotspots.md)
- [Tool Gateway 0.7 registration migration](references/tool-gateway-0.7-migration.md)
- [Hosted model economics-profile rollout](references/model-economics-profile-rollout.md)

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
