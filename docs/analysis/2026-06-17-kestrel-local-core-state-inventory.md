---
id: kestrel-local-core-state-inventory
domain: analysis
status: draft
owner: kestrel-suite
last_verified_at: 2026-06-17
depends_on:
  - ../plans/2026-06-17-kestrel-local-core-shell-model.md
  - ../../apps/desktop/src/config.ts
  - ../../apps/desktop/src/settingsStore.ts
  - ../../apps/desktop/src/postgresSupervisor.ts
  - ../../apps/desktop/src/databaseController.ts
  - ../../apps/desktop/src/databaseMigrations.ts
  - ../../cli/app/TuiBootstrap.ts
  - ../../src/store/createSessionStore.ts
  - ../../src/runtime/kestrelHome.ts
  - ../../scripts/check-cli-release.ts
  - ../../scripts/check-desktop-release.ts
  - ../../scripts/local-core-legacy-state.ts
  - ../runbooks/2026-06-17-local-core-beta-migration-evidence.md
---

# Kestrel Local Core State Inventory

See also: [Local Core shell model](../plans/2026-06-17-kestrel-local-core-shell-model.md), [v0.5 roadmap](../plans/2026-06-16-kestrel-suite-v0.5-release-roadmap.md), and [Desktop readiness gap analysis](2026-06-16-kestrel-desktop-v0.5-readiness-gap-analysis.md).

## Purpose

This inventory maps release-surface state ownership against the new Local Core architecture:

> Kestrel Local Core is the single local source of truth. Desktop, CLI/TUI, and `kcron` are shells.

It intentionally covers release surfaces only. It is not a whole-repo persistence audit.

## Summary

The current stack routes packaged default shells through Kestrel Local Core:

- `resolveKestrelCoreHome` makes `~/Library/Application Support/Kestrel` the macOS product root unless an explicit Core home or isolated/dev home is set.
- Desktop resolves its runtime, settings, workspaces, diagnostics, managed Postgres, and project-run ledger paths from that Core home.
- The Core daemon owns the status contract, API socket, bearer token, manifest, lock, heartbeat, managed database lifecycle, and Core migration lock.
- CLI/TUI and beta `kcron` start or attach to the same Core daemon before constructing shell stores.
- Profiles, runtime settings, workspaces, sessions, history, UI state, diagnostics, Desktop settings/model policy, Desktop project runs, and `kcron` lease state are exposed through the Local Core API.
- Legacy Desktop `@kestrel/desktop` and CLI `~/.kestrel` roots are detected report-only and are not moved, merged, or deleted in v0.5 beta.

The remaining release blocker is proof, not architecture: a real clean-machine macOS smoke must show Desktop-first, CLI-first, concurrent launch, stale lock/socket recovery, hostile `DATABASE_URL` rejection, support-bundle redaction, and no repo checkout dependency.

## Release-Surface Inventory

| Surface | Current owner and evidence | Current root / env | Current persistence behavior | Remaining release proof | Migration concern | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| Core home | `src/localCore/home.ts` | Default macOS product root; `KESTREL_CORE_HOME` explicit override; `KESTREL_HOME` isolated/dev override | One packaged default Core home per user account | Clean profile must show Desktop and CLI report the same home | Old Desktop/CLI roots stay report-only | Medium |
| Desktop shell | `apps/desktop/src/main.ts`, `apps/desktop/src/config.ts` | Desktop passes resolved Core home into path config and runner env | Desktop starts or attaches to Core, then uses Core API for settings, project runs, and status | Desktop-first launch must create/attach Core without repo checkout or app-private product state | Existing beta Desktop state may live under `@kestrel/desktop` | Medium |
| Desktop managed database | `src/localCore/postgres.ts`, `apps/desktop/src/databaseController.ts` | `core/postgres/data`, `core/postgres/socket`, `core/postgres/metadata.json`, `core/logs/desktop-postgres.log` | Core owns bundled Postgres startup, pid/socket identity checks, and status shaping; Desktop adapts that status | Clean-machine smoke must prove missing bundle, stale pid/socket, and orphaned DB statuses are clear | Old Desktop Postgres data is detected only | High |
| Migrations | `src/localCore/migrations.ts`, `src/localCore/ready.ts` | Core migration lock at `core/migration.lock.json`; `DATABASE_URL` injected only for migration process | Core runs migrations once under a Core migration lock when shell readiness asks for migrations | Concurrent Desktop/CLI launch must not race migrations | No automatic migration/import of legacy shell state | Medium |
| Desktop settings/model policy | `src/localCore/api.ts`, `apps/desktop/src/main.ts` | `settings/local-core-settings.json` plus model policy under Core home | Desktop reads/writes settings and model policy through Core API | OpenRouter and Ollama setup must persist after Desktop restart | Secret redaction and future keychain policy remain separate follow-up | Medium |
| Shell stores | `src/localCore/api.ts`, CLI store adapters | Core API endpoints for runtime settings, profiles, workspaces, sessions, history, UI state, diagnostics | CLI/TUI stores use Core API in default packaged mode; direct filesystem writes are for Core daemon or explicit isolated/dev mode | CLI must see Desktop-created settings/workspaces/sessions without manual env wiring | Preserve `KESTREL_HOME` isolated/dev behavior intentionally | High |
| Desktop project runs | `src/localCore/desktopProjectRuns.ts`, `src/localCore/api.ts` | `workspaces/desktop-project-runs.json` under Core home | Core owns project-run ledger, launcher discovery, run lifecycle, and event stream | Add workspace and first session smoke must not create Desktop-private durable stores | Existing Desktop project records are report-only | Medium |
| `kcron` service | `cli/kcron.ts`, `src/localCore/api.ts` | Core-backed `kcron` state and lease endpoints; service install carries Core home when not isolated/dev | `kcron` status/start use Core state and duplicate lease prevention; `kcron` remains beta | Smoke must show beta labeling and Core-backed lease behavior | Prevent stale LaunchAgent homes from silently becoming product truth | Medium |
| External DB mode | `src/localCore/ready.ts`, `src/localCore/api.ts`, Desktop settings | Explicit Core setting/database URL only; inherited host `DATABASE_URL` ignored unless explicitly allowed | Missing external URL blocks with `LOCAL_CORE_EXTERNAL_DATABASE_URL_REQUIRED` | Hostile inherited `DATABASE_URL` smoke must prove default mode is not redirected | External DB import/migration policy is out of scope | High |
| Diagnostics/support bundle | `src/localCore/api.ts`, `src/diagnostics/supportBundle.ts`, `apps/desktop/src/supportBundle.ts` | Core logs/diagnostics plus Desktop wrapper bundle | Bundles include Core home, status, lock, DB, logs, legacy-state report, and recursive redaction | Smoke must inspect bundle for key redaction and required Core fields | Keep token values out of evidence | Medium |
| Release checks | `scripts/check-desktop-release.ts`, `scripts/check-cli-release.ts`, `scripts/local-core-release-smoke.ts` | Packaged Desktop resources and CLI libexec tree | Checks validate Local Core resources, `.env` exclusion, extracted CLI launchers, hostile env smoke, and temp-home Core behavior | Required gates plus clean-machine smoke must pass before distribution | Generated artifacts must not be staged | Medium |
| Legacy-state detection | `scripts/local-core-legacy-state.ts` | Active Core home plus Desktop `@kestrel/desktop` and CLI `~/.kestrel` paths | Reports present/absent state and evidence paths only | Handoff must capture report without moving or overwriting state | Import/merge/reset policy remains deferred | Medium |

## Remaining Release Proof

1. Run the full validation gate locally after review fixes.
2. Package Desktop and CLI artifacts from the reviewed stack.
3. Record checksums for both artifacts.
4. Run the clean-machine macOS smoke on a clean user profile or machine.
5. Capture evidence for Desktop-first, CLI-first, concurrent launch, stale lock/socket recovery, provider setup, support-bundle redaction, and hostile `DATABASE_URL` rejection.

## Validation Evidence To Preserve

- `DATABASE_URL` current paths: `src/store/createSessionStore.ts`, `apps/desktop/src/settingsStore.ts`, `apps/desktop/src/databaseMigrations.ts`, `cli/app/TuiBootstrap.ts`.
- `KESTREL_HOME` current paths: `src/runtime/kestrelHome.ts`, `apps/desktop/src/settingsStore.ts`, `cli/app/TuiBootstrap.ts`, `cli/kcron/service.ts`.
- Desktop `runtime-home` and Postgres paths: `apps/desktop/src/config.ts`.
- CLI PGlite fallback: `src/store/createSessionStore.ts`.
- CLI artifact isolated smoke: `scripts/check-cli-release.ts`.
- Desktop package/resource checks: `scripts/check-desktop-release.ts`.
- Legacy-state report-only detection: `scripts/local-core-legacy-state.ts`.
