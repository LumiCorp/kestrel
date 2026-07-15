---
id: runbook-mvp-operator-2026-02-25
domain: ops
status: active
owner: kestrel-ops
last_verified_at: 2026-06-30
depends_on: [../index.md]
---

# Kestrel MVP Operator Runbook

Date: 2026-02-25

## Purpose

Operate and troubleshoot the Kestrel runtime kernel in MVP mode.

## Core Commands

- Install dependencies: `pnpm install`
- Start local Postgres: `pnpm run db:up`
- Apply migrations: `set -a; source .env; set +a; pnpm run db:migrate`
- Stop local Postgres: `pnpm run db:down`
- Typecheck: `pnpm run typecheck`
- Build: `pnpm run build`
- Test: `pnpm run test`
- Operator surface automation: `pnpm run test:ops`

## Runtime Invariants

1. State commit occurs before effect execution.
2. Effect results are durably recorded before any subsequent step executes.
3. Mutations are represented as effects only.
4. Runtime events are persisted to outbox before dispatch attempts.

## Failure Handling

1. `STOP` effect policy:
Run transitions to `FAILED`; no subsequent step executes.
2. `WAIT` effect policy:
Run transitions to `WAITING`; execution halts for external recovery/retry.
3. `CONTINUE` effect policy:
Failure is recorded and execution continues.

## Resume and Replay

1. Pending effects are scanned and resumed at run start.
2. Undelivered outbox events can be replayed via `replayUndeliveredOutbox()`.

## Operator Control Actions

1. Use `operator.control` actions for `approve`, `reject`, `reply`, `steer`, `retry`, `focus_thread`, `resolve_context_checkpoint`, `approve_assembly_change`, `reject_assembly_change`, `spawn_child_thread`, `supersede_child_thread`, and `resolve_fan_in_checkpoint`.
2. Treat thread focus as explicit runtime state: the focused thread drives session wait/blocker summaries.
3. Resolve context checkpoints through explicit `pending` -> `accepted|deferred` transitions; do not mutate checkpoint state ad hoc.
4. Treat fan-in review and child supersede as first-class operator actions; do not infer reconciliation or stale-child resolution from surface-local state.
5. Prefer shared operator views (`OperatorThreadView`, replay, doctor, `/status`, ops views) over raw session internals when diagnosing blockers or next action.

## Reasoning and Evidence Guardrails

1. Provider-returned reasoning summaries or visible thinking are non-authoritative, live-only diagnostics and must never fail the run.
2. Keep provider formats and attempts explicit. Do not render encrypted continuation state or expose historical internal `reasoning.update` records as public reasoning.
3. Evidence recovery must terminate via explicit outcomes (broaden, targeted fetch, handoff/finalize fallback, low-signal stop) rather than silent loops.
4. News fetch heuristics now strip nav/menu boilerplate before rating quality so truncated headers no longer trigger `low_signal_mix`; the operator is looking at cleaned article bodies when reviewing evidence diagnostics.

## Troubleshooting Checklist

1. Validate schema is applied (`db/migrations/*.sql`).
2. Check `run_logs` for run/step/effect sequence.
3. Confirm `effect_results` has row per effect idempotency key.
4. Inspect `runtime_events_outbox` for `FAILED` rows and attempt counts.
5. Verify session version conflicts when concurrent events are expected.

## Known MVP Deferrals

1. Deterministic replay engine.
2. Distributed effect workers.
3. Global saga/compensation orchestration.
4. Automated schema migrations beyond manual SQL migrations.

## CI

- Workflow: `.github/workflows/ci.yml`
- Gates: `typecheck`, `test`, `prompt-suite`, `evals:release-check`, `test:ops`, `build`

## Current References

This runbook captures the MVP operating posture and should be read as historical context alongside the current operations material.

- [Reliability](RELIABILITY.md)
- [Quality gates](apps/docs/content/operations/quality-gates.mdx)
- [Operator control workflows](apps/docs/content/operations/operator-control-workflows.mdx)
