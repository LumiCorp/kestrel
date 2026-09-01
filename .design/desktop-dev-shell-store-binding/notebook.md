# Desktop Developer Shell Store Binding Design Notebook

## Current Position

The developer-shell service must not infer its internal control-store driver from the environment inherited by workspace commands. Local Core must pass an explicit developer-shell store binding that follows Local Core's own database mode. The service must publish the binding's opaque revision in health so a client cannot reuse a healthy service connected to the wrong store.

This position changed after tracing service reuse. Correct launch configuration alone is insufficient because the shared service can outlive the runtime that selected its store.

## Requested Change

Repair the Desktop failure in which both static-server commands failed before execution with `DEV_SHELL_SERVICE_UNAVAILABLE` and `migration_failed`.

Changed scenarios:

- A PGlite Local Core starts the developer shell even if its launcher environment contains an unrelated or stale `DATABASE_URL`.
- An external-Postgres Local Core continues to bind the developer-shell control store to its exact configured database.
- A workspace command with `envMode: inherit` retains its intended workspace environment without allowing that environment to select Kestrel's internal store.
- A client restarts an otherwise healthy developer-shell service when its store binding does not match.
- A bootstrap failure tells the model that the command never started and that changing the command cannot repair storage initialization.

## Starting Sources

- Repository: the current Kestrel checkout root
- Branch worktree: an isolated feature worktree
- Exact Desktop run `481d5074-8db9-4d37-b62d-0f6a39328351`
- Canonical Local Core state under `~/Library/Application Support/Kestrel/state/0.6`
- Repository architecture, design, reliability, and `AGENTS.md` guardrails
- Node.js child-process documentation

## Relevant Current Behavior

1. `spawnDaemon` copies the launch environment into the detached Local Core daemon while adding a database-mode marker (`src/localCore/daemon.ts`).
2. `createExecutionBundle` gives that raw environment to `createLocalCoreRuntimeEnvironmentResolver` (`src/localCore/api.ts`).
3. The runtime environment copier removes managed model/tool configuration, but not database controls (`src/localCore/runtimeEnvironment.ts`).
4. `KestrelChatRuntime` gives `runtimeEnv` to `LocalDevShellService` (`cli/runtime/KestrelChatRuntime.ts`).
5. `LocalDevShellService` correctly uses its injected environment for bootstrap and for the detached service process (`src/devshell/LocalDevShellService.ts`).
6. `createInitializedDevShellRuntime` calls `createSqlExecutorFromEnv`; its `auto` mode selects Postgres whenever `DATABASE_URL` is present (`src/devshell/DevShellRuntimeBootstrap.ts`, `src/store/createSessionStore.ts`).
7. The service runs Postgres migrations before binding its socket (`cli/dev-shell/service.ts`). A dead inherited URL therefore fails before the requested command starts.
8. Health compatibility checks only protocol capabilities. They do not identify the bound store (`src/devshell/contracts.ts`, `src/devshell/LocalDevShellService.ts`).

Runtime evidence showed the canonical Core was PGlite-owned while its detached process retained `DATABASE_URL=...127.0.0.1:55432/kestrel`. Nothing listened on that port. Six bootstrap attempts over two days failed with `ECONNREFUSED`. An isolated reproduction failed with that URL and passed when the URL was absent.

Existing tests establish two intended contracts:

- `LocalDevShellService` uses its injected environment rather than global `process.env`.
- Explicit Postgres developer-shell configuration remains supported.

The missing contract is the component that owns the injected store choice.

## Affected Surface

- Local Core store creation and runner-runtime factory options
- Runtime construction of `LocalDevShellService`
- Developer-shell service launch contract
- Developer-shell runtime bootstrap
- Developer-shell health compatibility
- Workspace command environment inheritance
- Safe bootstrap failure projection to the model
- PGlite and external-Postgres qualification tests

No schema migration or stored-data rewrite is required.

## External Research

Question: Does Node isolate or reinterpret an environment passed to `spawn`?

Finding: Node passes the supplied `env` entries to the child; if omitted, `process.env` is the default. `undefined` entries are ignored. The current spread is therefore a direct configuration channel, not incidental process behavior.

Source: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options

Design effect: construct the service environment deliberately and do not expect the child-process boundary to remove an unrelated `DATABASE_URL`.

## Candidate Seams and Options

### Scrub database variables when Local Core starts

This is early and small, but it changes the daemon's whole inherited environment. It also cannot represent both an internal store URL and an independent workspace `DATABASE_URL`.

Not chosen as the owning fix.

### Rewrite the general runtime environment from Local Core's database mode

This aligns the developer shell with Core, but `runtimeEnv` also supplies workspace commands. Removing or replacing `DATABASE_URL` there conflates Kestrel storage with the application-under-test environment.

Not chosen as the owning fix. A narrow defense-in-depth scrub is acceptable only for Kestrel-specific store-control variables.

### Force the developer shell to PGlite

This fixes the incident but removes an intentionally tested external-Postgres path and changes durability behavior for external Core installations.

Rejected.

### Pass an explicit developer-shell store binding

Local Core already has an authoritative `LocalCoreStoreHandle`. It can derive an exact developer-shell binding from that handle and pass it through the runtime factory to `LocalDevShellService`. Standalone callers can resolve their legacy environment once at construction for compatibility.

Chosen.

### Improve only the failure message or add retries

This would make the failure easier to understand but would not repair the wrong store selection. Repeating the same migration against a refused endpoint is not recovery.

Rejected as a primary fix. Safe action guidance is included as a supporting change.

## Proposed Delta

Define a discriminated internal binding:

- `{ revision: string, driver: "sqlite" }`
- `{ revision: string, driver: "postgres", databaseUrl: string }`

Local Core derives it from the successfully opened `LocalCoreStoreHandle`, not from the launch environment, and mints one revision for the resulting immutable binding. `createLocalCoreRunnerRuntimeFactory` carries it as host-only runtime construction data. `KestrelChatRuntime` passes it to `LocalDevShellService` separately from the workspace environment.

`LocalDevShellService` resolves one immutable binding at construction. Local Core callers supply it. Standalone callers without it retain current behavior by resolving `KESTREL_STORE_DRIVER` and `DATABASE_URL` once from their injected environment.

The detached service receives dedicated internal store values. `createInitializedDevShellRuntime` passes explicit `driver`, `databaseUrl`, and `sqlitePath` options to the existing SQL-executor factory. It no longer lets generic `DATABASE_URL` choose the driver. Dedicated internal values are removed from the environment used to spawn workspace commands.

The host mints one opaque revision with the immutable binding. A changed driver or location receives a new revision. Health exposes only driver plus revision, never the database URL. `LocalDevShellService` requires protocol capabilities and the expected revision. A mismatch uses the existing incompatible-service shutdown and restart path. The protocol version increments so older health payloads cannot be accepted.

For `migration_failed`, the model-visible failure states that service bootstrap failed before command execution. `nextSuggestedAction` directs the caller to repair database connectivity and retry the original command; it says changing the command cannot help. Raw migration output remains in local diagnostics only.

## Domain Model

- **Workspace command environment:** variables that a command may inherit under the selected developer-shell environment policy.
- **Developer-shell control store:** Kestrel-owned persistence for process records, cursors, guards, and retention leases.
- **Store binding:** the exact driver and location selected by the host for the control store.
- **Binding revision:** an opaque, non-secret identifier minted with an immutable binding. A changed driver or location must receive a new revision.

Invariants:

- A workspace variable never selects the developer-shell control store.
- Local Core's opened store handle, not ambient process state, owns the developer-shell store choice.
- PGlite Core binds a local PGlite developer-shell store.
- External Core binds the developer-shell store to its exact external database.
- Store credentials never appear in health, bootstrap status, tool output, or logs.
- A service is reusable only when protocol, capabilities, and binding revision match.
- A bootstrap failure is distinguishable from a command failure.

## Transition States

- New Local Core runtimes always provide an explicit binding.
- Standalone callers without one use the existing environment behavior during compatibility transition.
- An old running service lacks the new health identity and is restarted through the existing incompatible-service path.
- Existing `store.db` data remains in place. No quarantine or migration occurs unless normal PGlite initialization reports the existing recoverable corruption code.

## Decisions

### Separate control-store authority from workspace environment

Choice: explicit binding outside `runtimeEnv`.

Rationale: the two environments have different owners and can legitimately contain different database locations.

Confidence: high. Reopen only if workspace commands are formally prohibited from receiving any `DATABASE_URL`.

### Preserve external Postgres support

Choice: follow the already-opened Local Core store mode.

Rationale: repository tests explicitly preserve Postgres prerequisites, and the shared schema contains developer-shell process tables.

Confidence: high. Reopen only if product policy changes developer-shell process persistence to local-only.

### Include store identity in health

Choice: driver plus an opaque binding revision, with a protocol bump.

Rationale: process lifetime makes launch configuration insufficient evidence of compatibility.

Confidence: high. Reopen if each binding receives a distinct socket/base directory instead.

### Do not auto-retry migration failures

Choice: action guidance without automatic retry.

Rationale: the observed refusal was stable across six attempts. Retry would delay the same deterministic failure.

Confidence: high. Reopen only if the database owner supplies an explicit bounded readiness transition.

## Research and Prototypes

- PGlite + dead ambient `DATABASE_URL`: reproduced `migration_failed` before command execution.
- Same isolated service with no URL: initialized and completed the command.
- Focused existing suite: 47 tests passed, proving a coverage gap rather than a known failing contract.
- No prototype code was needed; current constructors and factory options provide the required seams.

## Active Change Frontier

No consequential design question remains. Exact internal type and environment-key names are implementation details, provided they preserve the invariants above.

## Decision Map

- Status: not needed
- Path: none
- Destination: explicit store authority and compatible service reuse
- Return condition: complete

## Best Next Move

Translate this design into one coherent implementation slice with regression coverage for PGlite, external Postgres, workspace environment preservation, service mismatch, and model-visible bootstrap guidance.
