---
id: reliability-root
domain: ops
status: active
owner: kestrel-ops
last_verified_at: 2026-07-16
depends_on:
  - ARCHITECTURE.md
  - docs/generated/quality-scorecard.json
  - apps/docs/content/operations/quality-gates.mdx
---

# Kestrel Reliability

Kestrel treats reliability as the ability to prevent invalid behavior, detect
drift quickly, preserve enough evidence to diagnose it, and recover without
discarding the work that already happened.

This model applies across the runtime, Local Core, CLI/TUI, Desktop, Kestrel
One, public packages, and declarative evaluation specifications.

## Reliability Contract

A reliable Kestrel run has:

- a stable run and session identity
- validated transitions and explicit terminal state
- request-scoped live events plus persisted evidence
- human-facing and structured output kept separate
- typed tool and effect outcomes
- operator-visible waiting, steering, cancellation, retry, and recovery
- enough logs, artifacts, and checkpoints to explain what happened

A request returning HTTP 200 is not, by itself, proof of successful agent work.

## Layers of Protection

| Layer | Protects | Primary gate or evidence |
| --- | --- | --- |
| Architecture and governance | Ownership, dependency, release, docs, and public boundaries | `pnpm run governance:check` |
| Deterministic behavior | Runtime, application, package, and replay contracts | `pnpm run test` |
| Model-visible behavior | Reference-agent prompts, schemas, tool use, and completion contracts | `pnpm run prompt-suite` |
| Evaluation ownership | Declarative scenario validity and released Ruhroh compatibility | `pnpm run evals:release-check` |
| Benchmark adapters | Offline Terminal-Bench and SWE adapter shape | `pnpm run bench:smoke` |
| Operational evidence | Individual run diagnosis and recovery | events, logs, artifacts, checkpoints, support bundles |
| Domain health | Accumulating quality risk | [generated quality scorecard](docs/generated/quality-scorecard.json) |

## Verification Ladder

Start narrow so failures are attributable, then widen in proportion to risk.

1. Run the closest unit, contract, or app test while iterating.
2. Run the owning package or application suite.
3. Run `pnpm run governance:check` for boundaries and documentation.
4. Run `pnpm run test` for the full deterministic suite.
5. Run `pnpm run prompt-suite` for model-facing behavior.
6. For runtime/core work, run `pnpm run evals:release-check`.
7. Add packaging, browser, live-provider, or benchmark checks only when the
   changed surface requires them.

Documentation changes should run at least:

```bash
pnpm run check:docs
pnpm run docs:test
pnpm run docs:build
pnpm run governance:check
```

Do not hide an unrelated or transient failure. Isolate the exact failing test,
record whether it reproduces, and rerun the owning gate before declaring the
change clean.

## Failure Signals and First Response

| Signal | Likely ownership | First response |
| --- | --- | --- |
| Architecture, docs, or public-boundary check | Governance or the changed boundary | Run the named check directly and inspect its owning rule |
| Replay baseline regression | Runtime contract, persistence, or nondeterminism | Compare the recorded transition/evidence change before updating a baseline |
| Prompt-suite regression | Model-visible prompt, schema, tool, or result contract | Inspect the failed scenario and recent model-facing changes |
| Ruhroh release-check failure | Evaluation specification, adapter compatibility, or release ownership | Run the named scenario/validation and confirm the pinned released dependency |
| SDK/protocol mismatch | Cross-package release or terminal parsing | Compare reported contract versions and use exact compatible package lines |
| Waiting that appears hung | State projection or operator UX | Inspect persisted run state and waiting reason before restarting anything |
| Missing or contradictory terminal text | Finalization owner or protocol translation | Inspect canonical `assistantText` and `finalizedPayload` at the first wrong boundary |
| Desktop degraded state | Local Core health, provider setup, database, or IPC projection | Use Desktop recovery/diagnostics and preserve the support bundle |

## Incident Workflow

1. **Preserve evidence.** Capture run/session identifiers, timestamps, terminal
   state, recent events, logs, artifacts, checkpoints, and the exact command or
   user action.
2. **Name the observed wrong behavior.** Avoid diagnosing from a generic error
   banner alone.
3. **Find the first wrong owner.** Trace the request and contract upstream from
   the rejection or bad projection.
4. **Contain safely.** Stop new work, disable a feature gate, or cancel the
   affected run only when the owning procedure supports it. Do not delete state
   as a first diagnostic step.
5. **Repair narrowly.** Change the existing owning surface and add a regression
   proof at that boundary.
6. **Re-run the verification ladder.** Start with the exact proof, then the
   broader gates required by the change.
7. **Record recovery.** Preserve the evidence that shows the unhealthy state,
   action, and verified result.

## Recovery Rules

- Resume or retry the original run/session when the contract allows it.
- Treat cancellation, waiting, and failure as distinct states.
- Never infer success from disconnected streaming or partial UI text.
- Prefer non-destructive inspection before reset or state deletion.
- Preserve deterministic replay inputs when changing recovery behavior.
- Do not update baselines merely to make a regression disappear.
- Keep operator actions attributable to the actor and affected work.

## Release Readiness

A release candidate is not ready until its exact revision passes the required
gates and product-specific checks. Promote verified artifacts when the deploy
system supports promotion; do not silently rebuild a different revision.

The `0.6` line also requires compatible runtime, protocol, SDK, Next.js,
observability, CLI, Desktop resources, and Kestrel One dependencies. See
[compatibility](apps/docs/content/reference/compatibility.mdx).

## Operational References

- [Operations overview](apps/docs/content/operations/index.mdx)
- [Quality gates](apps/docs/content/operations/quality-gates.mdx)
- [Reliability guide](apps/docs/content/operations/reliability.mdx)
- [Artifact inspection](apps/docs/content/operations/artifact-inspection.mdx)
- [Evaluations with Ruhroh](apps/docs/content/operations/evaluations.mdx)
- [Deployment troubleshooting](apps/docs/content/deploy/deployment-troubleshooting.mdx)
- [Quality score](QUALITY_SCORE.md)
- [Security](SECURITY.md)
