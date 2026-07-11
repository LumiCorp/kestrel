---
id: kestrel-suite-v0.5-release-roadmap
domain: release
status: draft
owner: kestrel-suite
last_verified_at: 2026-06-16
depends_on:
  - ../../README.md
  - ../../apps/desktop/README.md
  - ../../docs/plans/2026-06-17-kestrel-local-core-shell-model.md
  - ../../docs/analysis/2026-06-17-kestrel-local-core-state-inventory.md
  - ../../docs/runbooks/2026-06-17-local-core-beta-migration-evidence.md
  - ../../docs/analysis/2026-06-16-kestrel-suite-v0.5-codebase-inventory.md
  - ../../packages/sdk/PUBLISHING.md
  - ../../packages/next/PUBLISHING.md
  - ../../packages/observability/PUBLISHING.md
---

# Kestrel Suite v0.5 Release Roadmap

See also: [Local Core shell model](2026-06-17-kestrel-local-core-shell-model.md), [Local Core state inventory](../analysis/2026-06-17-kestrel-local-core-state-inventory.md), [Local Core migration evidence](../runbooks/2026-06-17-local-core-beta-migration-evidence.md), [v0.5 codebase inventory](../analysis/2026-06-16-kestrel-suite-v0.5-codebase-inventory.md), [Desktop README](../../apps/desktop/README.md), and [SDK publishing checklist](../../packages/sdk/PUBLISHING.md).

## Release Promise

Kestrel Suite v0.5 is the first coherent local Kestrel release. The release now depends on the Local Core architecture: Kestrel Local Core is the single local source of truth, while Desktop, CLI/TUI, and `kcron` are shells over that Core.

The release promise is:

> Kestrel runs durable local agent sessions through Desktop and CLI shells over one shared Local Core, with workspace awareness, recovery and replay evidence, local automation, and server-side SDK packages for teams embedding the runner.

This release is not "everything Kestrel can do." It is the first externally understandable suite boundary around Desktop, the local runtime, CLI, and package integrations.

## Local Core Release Gate

Shared Local Core is now a blocker before real clean-machine Desktop plus CLI smoke:

- Desktop and CLI/TUI must default to the same local Kestrel source of truth.
- Packaged defaults must not depend on host Postgres, Docker, Homebrew Postgres, inherited `DATABASE_URL`, or repo checkout state.
- Legacy Desktop-managed Postgres paths and CLI `~/.kestrel` / PGlite fallback behavior are explicit legacy or isolated/dev concerns, not the packaged v0.5 product default.
- External Postgres remains Advanced mode and isolated/dev stores remain explicit.
- Clean-machine smoke must prove Desktop-first and CLI-first launch orders see the same sessions, workspaces, settings, and diagnostics.
- Legacy Desktop `@kestrel/desktop` and CLI `~/.kestrel` state must be detected and reported without destructive moves before any migration/import behavior is attempted.
- The v0.5 process model is a shell-started child daemon that serves the Local Core API on `core/api.sock` with bearer-token auth from `core/api.token`; launchd installation is out of this beta.
- Durable shell control-plane state must go through the Local Core API in default packaged mode; direct filesystem stores are reserved for the Core daemon and explicit isolated/dev modes.

## Current Evidence

As of the local `0.5.0-beta.0` readiness pass:

- `pnpm run desktop:package` and `pnpm run desktop:release-check` pass for the unsigned macOS Desktop artifact.
- `pnpm run cli:package` and `pnpm run cli:release-check` pass for `kestrel-cli-0.5.0-beta.0-darwin-arm64.tar.gz`; the extracted top-level launchers are `kestrel`, `ks`, and beta `kcron`.
- `pnpm run sdk:release-check`, `pnpm run next:release-check`, `pnpm run observability:release-check`, and `pnpm run ecosystem:release-check` pass.
- `pnpm run web:test` and `pnpm run web:typecheck` pass.
- `pnpm run check:docs` passes after stale-doc re-verification.
- Focused CLI prompt-smoke evidence passes for `simple-newsletter` and `vite-csv-reconciliation`.
- Resolved pre-smoke concern: Desktop package-stage dependency install no longer reports the `next@15.5.3` / CVE-2025-66478 warning. The 15.5.x Next apps now use `next@15.5.19`, Desktop preserves a package-stage `postcss@8.5.15` npm override, and `pnpm run desktop:package` reports `found 0 vulnerabilities`.
- Updated pre-smoke blocker: the child-daemon Local Core API slice now exists and release checks require Local Core daemon/API resources plus smoke coverage for shared-state launch orders, stale lock repair, and inherited `DATABASE_URL` rejection. Deep review and clean-machine proof are still required before distribution.
- New pre-clean-machine evidence gate: `pnpm run local-core:release-smoke` exercises temp-home Core attach, shared workspace/session stores, inherited `DATABASE_URL` rejection, stale lock classification, support-bundle redaction, and Core-owned `kcron` duplicate lease decisions.

## Product Shape

### Official In-Scope Surfaces

- Kestrel Desktop as the primary product surface.
- Durable local runtime for sessions, runs, tools, model IO, persistence, wait/resume, cancellation, evidence, and recovery.
- Local workspace operation with explicit provider setup and project selection.
- CLI companion workflows through `kestrel`, `ks`, `kestrel web`, and core command mode.
- Public server-side packages:
  - `@kestrel-agents/sdk`
  - `@kestrel-agents/next`
  - `@kestrel-agents/observability`
- Kestrel One as a starter/reference app for embedded runner usage.
- the former in-repository evaluator, governance checks, prompt suite, and replay checks as validation infrastructure.
- Docs for installation, provider setup, local workspace use, CLI use, SDK embedding, and known limitations.

### Beta In-Scope Surfaces

These can ship in v0.5, but should be labeled as beta or experimental:

- `kcron` local automation.
- Local providers through Ollama and LM Studio.
- Code/dev-shell workflows.
- the former in-repository evaluation UI.
- Current Core-managed packaged Postgres path, pending clean-machine proof.
- Desktop packaged builds on platforms without signed installer coverage.

### Out Of Scope

- Hosted multi-tenant Kestrel Cloud.
- Team admin, org billing, shared workspaces, and RBAC.
- Marketplace or plugin store as a product.
- Enterprise policy fleet management.
- Automatic background updates, unless the installer/update path is already stable and signed.
- Polished Windows/Linux desktop promise unless those builds are packaged, signed where needed, and tested on clean machines.
- Browser or edge runtime SDK support.
- Mobile.
- Studio as an official public product surface.
- Unattended long-running autonomy as a default promise.
- Marketplace-style MCP/tool installation UX.

## Release Tracks

### Track 1: Version And Release Contract

Goal: make v0.5 a single suite identity instead of a loose set of packages.

Deliverables:

- Set the suite version to `0.5.0-beta.0` across root package, publishable packages, and private app packages.
- Add a suite version check that fails when version-bearing package manifests drift.
- Make Desktop packaging read `appVersion` from `apps/desktop/package.json` instead of a hardcoded value.
- Add a v0.5 release manifest or notes page with official surfaces, beta surfaces, unsupported surfaces, and package versions.
- Keep the first public artifact explicitly labeled `0.5.0-beta.0`.

Exit criteria:

- A clean checkout can prove every suite manifest agrees on the v0.5 version.
- Desktop packaged metadata reports the same suite version as the package manifests.

### Track 2: Desktop Fresh Install

Goal: make Desktop the default first-run path for a local user.

Deliverables:

- Verify packaged Desktop first-run on a clean machine profile.
- Verify Desktop starts or connects to shared Local Core instead of owning private product state.
- Confirm provider-first setup for OpenRouter, OpenAI, Anthropic, Ollama, and LM Studio.
- Confirm hosted provider key entry and local provider no-key flows.
- Confirm project/workspace selection from first run.
- Confirm runtime health, recovery, diagnostics, and database-mode failures are understandable.
- Confirm packaged app does not depend on repo checkout state or local `.env` files.
- Confirm legacy Desktop and CLI state is reported, not moved or overwritten.
- Document supported platform and packaging limits explicitly.

Exit criteria:

- A new user can install or unpack Desktop, choose a provider, choose a workspace, and run a first local session without reading contributor setup docs.
- Known packaged limitations are documented in user-facing language.

### Track 3: Durable Local Runtime

Goal: make the runtime contract credible for local agent work.

Deliverables:

- Keep session/run/event/artifact persistence stable.
- Keep wait/resume, stop/cancel, steer, and recovery flows tested.
- Preserve deterministic replay and evidence-oriented diagnostics.
- Keep tool surfaces bounded and contract-carrying.
- Keep local database and external Postgres modes covered by smoke tests.

Exit criteria:

- Runtime/core validation gates pass or have explicitly documented unrelated blockers.
- Replay and evaluation checks cover the 0.5 product promise.

### Track 4: CLI Companion

Goal: make CLI usable as a companion shell over the same Local Core without presenting it as the main product.

Deliverables:

- Keep `kestrel` usable for local terminal sessions, with `ks` as the only short alias.
- Keep `kestrel web` usable as a local runner service for SDK consumers.
- Ship a separate macOS ARM64 `kestrel-cli` beta tarball shaped for future Homebrew installation.
- Make packaged CLI default to shared Local Core state, with isolated/dev stores explicit.
- Keep source-backed shims as contributor tooling, not the release install path.
- Label `kcron` beta inside the CLI artifact unless its daemon lifecycle and uninstall path are proven enough for official docs.

Exit criteria:

- The CLI docs distinguish contributor checkout, source-backed dogfood shims, and the Homebrew-shaped beta tarball.
- `pnpm run cli:package` and `pnpm run cli:release-check` prove the tarball works without a repo checkout or repo `.env`.
- `pnpm run cli:release-check` proves the packaged default path uses `KESTREL_CORE_HOME` with an inherited `DATABASE_URL` present and still reports Local Core status.
- `kestrel web` produces copy/paste-ready SDK configuration and has a stable auth-token story.

### Track 5: Public Integration Packages

Goal: publish the server-side embedding layer with a stable v0.5 contract.

Deliverables:

- Publish `@kestrel-agents/sdk`.
- Publish `@kestrel-agents/next`.
- Publish `@kestrel-agents/observability`.
- Align package examples with current exported APIs.
- Preserve Node.js 20+ server-side support language.
- Document that browser and edge runtimes are not supported in v0.5.

Exit criteria:

- Package release checks validate packed tarballs.
- Installed-output smoke imports pass.
- Docs show the runner-service boundary and the intended package chooser.

### Track 6: Starter And Validation Surfaces

Goal: include Kestrel One and the former evaluation UI without over-marketing them.

Deliverables:

- Keep Kestrel One positioned as a starter/reference app, not the flagship product.
- Keep the former evaluation UI positioned as validation/replay infrastructure.
- Ensure docs explain when a user should start with Desktop, CLI, SDK, or Kestrel One.

Exit criteria:

- Kestrel One and evaluation docs do not compete with Desktop as the main first-run path.
- Validation surfaces are part of the release confidence story.

### Track 7: Docs And Known Limits

Goal: make v0.5 legible to someone outside the repo.

Deliverables:

- Add a v0.5 overview page.
- Add fresh-install Desktop docs.
- Add provider setup docs.
- Add local workspace docs.
- Add CLI companion docs.
- Add SDK package chooser docs.
- Add known limitations:
  - no hosted team product
  - no browser/edge SDK
  - no enterprise fleet management
  - no marketplace/plugin store
  - beta labels for local automation, local providers, code/dev shell, the former evaluation UI, and any unsigned platform builds

Exit criteria:

- A new evaluator can understand what v0.5 is, what it is not, and which entrypoint to use.

## Suggested Milestones

### M1: Scope Freeze

- Approve this roadmap.
- Approve the codebase inventory.
- Use `0.5.0-beta.0` for the first public artifact.
- Mark each surface as official, beta, internal, or out of scope.

### M2: Release Contract

- Implement suite version alignment.
- Add version drift checks.
- Add v0.5 release manifest.
- Fix Desktop package version source.

### M3: Fresh Install Proof

- Implement and prove shared Local Core before real Desktop plus CLI smoke.
- Package Desktop.
- Run Desktop-first then CLI and CLI-first then Desktop clean-machine smoke.
- Run concurrent launch, stale lock repair, inherited `DATABASE_URL` rejection, and legacy-state detection smoke.
- Run provider setup smoke.
- Run project/workspace smoke.
- Document blockers and limitations.

### M4: Package Proof

- Run release checks for SDK, Next, and Observability.
- Validate examples against installed package output.
- Decide whether package publishing blocks on CLI packaging.

### M5: CLI Artifact Proof

- Ship the separate macOS ARM64 Homebrew-shaped Node tarball.
- Keep source-backed shims as contributor tooling.
- Keep public CLI command names to `kestrel`, `ks`, and beta `kcron`.
- Keep Homebrew formula, bundled Node, native single binary, and non-macOS CLI artifacts out of this pass.

### M6: Release Candidate

- Run required gates.
- Build Desktop artifact.
- Pack or publish npm packages.
- Publish v0.5 docs.
- Create the release notes with official/beta/out-of-scope boundaries.

## Release Readiness Principles

- Desktop is the default entrypoint.
- Local runtime behavior is more important than breadth of surfaces.
- Package APIs should be smaller and more stable than app internals.
- Beta labels are acceptable; ambiguous product promises are not.
- Validation infrastructure can be in the release without being marketed as the product.
- Gaps should be documented in v0.5 language, not hidden behind contributor setup details.
