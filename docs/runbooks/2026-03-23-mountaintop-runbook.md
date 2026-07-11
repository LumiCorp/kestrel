---
id: runbook-mountaintop-2026-03-23
domain: ops
status: active
owner: kestrel-ops
last_verified_at: 2026-06-30
depends_on: [../index.md]
---

# Mountain Top Runbook (On-Demand)

## Purpose

Mountain Top runs are long-running, high-impact, real shell journeys. They are intentionally **not part of default CI** and are run on demand.

The scenario suite validates full Next.js build journeys across both shells:

- CLI/TUI (`kchat`)
- Web shell (Playwright-driven chat surface)

Current scenario set:

- `nextjs-template-dual-shell`
- `nextjs-template-multi-package-shared-package`
- `nextjs-template-full-stack-task-board`
- `nextjs-template-auth-settings-admin`
- `nextjs-template-staged-stateful-workflow`
- `nextjs-template-long-running-stateful-workflow`

## Commands

- List scenarios:
  - `pnpm run mountaintop:list`
- Run a scenario:
  - `pnpm run mountaintop:run -- --scenario <scenario-id>`
- Run CLI only:
  - `pnpm run mountaintop:cli -- --scenario <scenario-id>`
- Continue both engines even if one fails:
  - `pnpm run mountaintop:run -- --scenario <scenario-id> --continue-on-failure`
- Run only the web engine:
  - `pnpm run mountaintop:run -- --scenario <scenario-id> --engine web`
- Auto-start postgres if DB preflight fails:
  - `pnpm run mountaintop:run -- --scenario <scenario-id> --auto-db`
- Override the OpenRouter model (openrouter scenarios only):
  - `pnpm run mountaintop:newsletter -- --openrouter-model <openrouter-model-id>`

## Prerequisites

- `.env` contains `OPENROUTER_API_KEY`
- Postgres reachable through `DATABASE_URL` or local default
- Playwright browsers installed (Chromium for adapter run; webkit available if your local policy requires it)
- `pnpm` available on path

## Output and Artifacts

Each run writes to:

- `tmp/mountaintop/<timestamp>-<scenario-id>/report.json`
- `tmp/mountaintop/<timestamp>-<scenario-id>/logs/*`
- `tmp/mountaintop/<timestamp>-<scenario-id>/workspaces/cli`
- `tmp/mountaintop/<timestamp>-<scenario-id>/workspaces/web`

Retention defaults to keeping the newest 10 run directories.

## Report Semantics

Status classes:

- `passed`
- `failed`
- `infra_failed`
- `build_failed`

Scenario pass requires:

- both CLI and web engines `passed`
- completion marker detected in both
- required artifact manifest present in both
- lint/typecheck/build/smoke checks passing in both

When running in single-engine mode (`--engine cli` or `--engine web`), parity checks are skipped and the report only reflects the selected engine.

## Failure Triage

- `infra_failed`: missing provider key, DB not reachable, server boot/connectivity issues
- `build_failed`: compile/type/script failures during quality gates
- `failed`: prompt flow did not complete, marker missing, parity/smoke assertion mismatch

When debugging, start with:

- engine transcript logs
- quality gate logs
- smoke server logs
- parity section in `report.json`

## Read Next

- [Reliability](RELIABILITY.md)
- [Evaluation operations guide](apps/docs/content/operations/evaluations.mdx)
- [Quality gates](apps/docs/content/operations/quality-gates.mdx)
