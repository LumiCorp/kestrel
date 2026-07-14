---
id: architecture-root
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-13
depends_on:
  - docs/index.md
  - docs/references/architecture-rules.json
  - apps/docs/content/docs/architecture-overview.mdx
---

# Kestrel Architecture

Kestrel is a durable runtime platform with product and integration surfaces
around one execution model. Runtime behavior, persistence, operator controls,
and public package contracts must not drift by surface.

## Current Shape

- `src/kestrel/contracts/` owns canonical runtime contract families.
- `src/engine/` owns step execution, transition validation, scheduling, and
  guardrails.
- `src/orchestration/` owns thread runtime, supervision, operator control, and
  assembly policy.
- `src/io/` owns model and tool gateway boundaries.
- `src/store/` and `src/replay/` own persistence and replay material.
- `src/localCore/` owns the local execution service, 0.6 state epoch, and
  PGlite or explicit external-Postgres persistence boundary.
- `cli/` owns the CLI/TUI and runner-service entry points.
- `apps/desktop/` owns the independent local GUI and bundled data runtime.
- `apps/web/` owns canonical Kestrel One hosted behavior.
- `packages/` owns public protocol, SDK, Next.js, and observability packages.
- `evals/` owns declarative evaluation inputs; released Ruhroh owns their
  execution.

## Runtime Boundaries

### Inbound requests

Requests enter through the shared runner-service host. Hosted deployments mount
that host directly; Local Core mounts it under its authenticated Unix-socket
API. External payloads are parsed and validated before runtime mutation or tool
execution. CLI and Desktop migration from their legacy runner subprocesses is a
required follow-up before the local execution-authority milestone is complete.

### Execution core

The runtime owns run lifecycle, step progression, model and tool calls, effect
handling, logs, artifacts, and final output normalization. Canonical contracts
live under `src/kestrel/contracts/` and are split by ownership.

### Persistence and replay

Runs, logs, artifacts, checkpoints, and operator evidence are persisted so
failures can be inspected and replayed. Replay is runtime evidence, not a
second evaluator embedded in this repository.

### Tool and workspace effects

Filesystem, development shell, internet, and code-execution capabilities are
exposed as typed tool families. Workspace mutation and checkpoint behavior are
operator-visible actions.

## Product Boundaries

- Local Core is the target sole authority for local execution and durable
  protocol events. PGlite is the default 0.6 local store; external Postgres is
  an explicit advanced mode.
- Desktop is a client of Local Core. It contains no Kestrel One source, Next.js
  runtime, hosted credentials, or hosted configuration. Bundled-Postgres removal
  belongs to the platform-lifecycle milestone.
- Kestrel One consumes public Kestrel package boundaries and owns hosted auth,
  data, streaming, artifacts, knowledge, bots, administration, and billing.
- Studio is a separate private repository and consumes exact released public
  packages without workspace links or source imports.
- Ruhroh is a separate repository and owns evaluator execution, reports,
  comparison, and the maintained Kestrel adapter.

## Control Boundaries

- Parse unknown external input before use.
- Keep guardrails and transition validation inside runtime control flow.
- Keep runner credentials on trusted app servers, not in browsers.
- Expose machine-readable outcomes from tools and effects.
- Preserve request-scoped streaming and deterministic replay semantics.
- Release cross-repository contracts before downstream products consume them.

## References

- [Architecture rules](docs/references/architecture-rules.json)
- [Local platform architecture](docs/plans/2026-07-13-kestrel-local-platform-architecture.md)
- [Published architecture overview](apps/docs/content/docs/architecture-overview.mdx)
- [Runtime docs](apps/docs/content/runtime/index.mdx)
- [Reliability](RELIABILITY.md)
- [Security](SECURITY.md)
