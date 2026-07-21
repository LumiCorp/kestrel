# Contributing to Kestrel

Kestrel is a contract-heavy runtime and product monorepo. Contributions are
welcome when they keep behavior explicit, changes attributable, and validation
proportional to risk.

## Before You Start

Choose the owner that matches your change:

| Change | Start with |
| --- | --- |
| Runtime, orchestration, persistence, tools, or Local Core | [Architecture](ARCHITECTURE.md) and [Design principles](DESIGN.md) |
| Desktop | [Desktop README](apps/desktop/README.md) |
| Kestrel One | [Kestrel One README](apps/web/README.md) and its route-ownership manifest |
| SDK or framework package | The package README under [`packages/`](packages) and exported contracts |
| Public documentation | [Docs app README](apps/docs/README.md) and [editorial model](apps/docs/EDITORIAL.md) |
| Reliability, replay, or evaluation | [Reliability](RELIABILITY.md) and [`evals/README.md`](evals/README.md) |
| Security-sensitive boundary | [Security](SECURITY.md) |

For runtime fixes, identify the observed wrong behavior, the component that
first made it wrong, and the existing surface that owns the repair. A
downstream rejection does not automatically transfer ownership downstream.

## Development Setup

Kestrel uses Node.js 22 in CI and pnpm 9.

```bash
git clone https://github.com/LumiCorp/kestrel.git
cd kestrel
corepack enable
pnpm install
```

Copy the environment template only when the surface you are running needs it:

```bash
cp .env.example .env
```

Common development entry points:

```bash
pnpm run desktop:dev
pnpm run web:dev
pnpm run docs:dev
pnpm run tui
```

Offline builds and tests do not require model-provider credentials. Live model
flows do.

## Make the Change

- Keep the patch small, reversible, and inside the owning surface.
- Reuse existing shared contracts and utilities before adding an abstraction.
- Parse unknown boundary input before use.
- Preserve run lifecycle, replay, evidence, and terminal-result invariants.
- Prefer prompts, schemas, field descriptions, examples, validators, retries,
  and result shaping before heuristic policy.
- Do not introduce keyword rules, scoring thresholds, fallback ranking,
  classification, path matching, or other heuristic decisions without explicit
  approval.
- Add a regression proof where the behavior first became wrong.
- Update public or root documentation when a user-visible contract changes.

Schema migrations, irreversible data moves, autonomy-policy changes, and new
heuristic runtime behavior require escalation before implementation or release.

## Validate the Change

Run the narrowest useful test while iterating, then widen according to the
surface and risk.

Pull-request readiness:

```bash
pnpm validate
```

GitHub Actions runs this exact command. The runner uses the same fixed DAG,
initialization, environment, cleanup, execution, and structured reporting
locally and remotely, independent of which files changed. It builds shared
artifacts once and runs production builds, hermetic groups, and process groups
sequentially with Node test concurrency capped at four. It records durations
without using elapsed time as a blocking correctness gate; GitHub's 15-minute
job timeout remains the operational hang watchdog. Focused commands use the
same runner lifecycle for iteration, but do not establish pull-request
readiness. `pnpm validate` includes the critical mutation audit.

Docs work:

```bash
pnpm run check:docs
pnpm run docs:test
pnpm run docs:build
pnpm run governance:check
```

Desktop work:

```bash
pnpm --filter @kestrel/desktop test
pnpm --filter @kestrel/desktop test:integration
pnpm --filter @kestrel/desktop build
```

Kestrel One work:

```bash
pnpm --filter @kestrel/kestrel-one test:unit
pnpm --filter @kestrel/kestrel-one typecheck:self
pnpm --filter @kestrel/kestrel-one build:self
```

Public package work should run the owning package tests and release check. See
[Reliability](RELIABILITY.md) for the complete verification ladder.

macOS CLI and Desktop package validation is release preparation rather than a
pull-request gate:

```bash
pnpm run validate:release:macos
```

If governance fails at `check:desktop-resources` after a source change that is
mirrored into Desktop, refresh the resources and rerun governance:

```bash
pnpm --filter @kestrel/desktop prepare:resources
pnpm run governance:check
```

## Pull Requests

A useful pull request explains:

- the user-visible or contract-level problem
- the component that owned the problem
- the chosen repair and any deliberately excluded work
- migrations, compatibility, security, or recovery implications
- the exact validation commands and results

Keep unrelated cleanup out of the patch. If a failure is transient or unrelated,
record how you isolated it and whether the owning gate passed on rerun.

## Documentation Changes

Public docs begin with a reader goal and observable success state. Maintainer
docs keep ownership, contracts, and evidence precise. Do not expose internal
plans or archives by linking them into public navigation without registering
and reviewing them against the public content boundary.

See the [documentation map](docs/index.md) for source-of-truth locations.

## Report Problems

- [Open a bug](https://github.com/LumiCorp/kestrel/issues/new?template=bug_report.md)
- [Request a feature](https://github.com/LumiCorp/kestrel/issues/new?template=feature_request.md)
- [Browse existing issues](https://github.com/LumiCorp/kestrel/issues)
- Report vulnerabilities privately through [Security](SECURITY.md)

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
