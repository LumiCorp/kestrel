# Desktop Developer Shell Store Binding Change Design

## Executive Summary

The fix should separate Kestrel's developer-shell control store from the environment inherited by workspace commands.

Local Core already opens the authoritative persistence store. It should derive an explicit developer-shell store binding from that handle and carry the binding through runtime construction to `LocalDevShellService`. The detached service should bootstrap from that exact binding, not infer a driver from a generic `DATABASE_URL`.

The service must also expose an opaque binding revision in health. A client may reuse the service only when protocol, capabilities, and store binding revision match. This closes the full lifecycle gap, including stale healthy services created under an older database mode.

The repair preserves both supported modes:

- PGlite Local Core uses the local developer-shell PGlite store even when the workspace environment contains `DATABASE_URL`.
- External-Postgres Local Core uses its exact configured database.

Failure shaping should then state when service bootstrap failed before the command ran. It should direct the model to repair storage connectivity instead of trying a different command.

## Requested Outcome

The reported static-site flow should work without special cleanup:

- Desktop opens a workspace under a PGlite Local Core.
- A stale or application-specific `DATABASE_URL` may exist in the inherited workspace environment.
- `python3 -m http.server 8000` starts through `exec_command`.
- Kestrel's internal developer-shell store remains PGlite-backed.
- If the command environment uses `envMode: inherit`, the workspace receives the environment allowed by that policy without gaining authority over Kestrel's internal store choice.

The design must also preserve external Postgres, deterministic service reuse, safe diagnostics, and the current recovery path for a corrupt local store.

## Relevant Current Behavior

### The first wrong state is created before developer-shell bootstrap

The Local Core daemon copies its launch environment while adding the configured database mode ([`daemon.ts`](../../src/localCore/daemon.ts#L454)). When it creates an execution bundle, it passes that environment directly into the runtime environment resolver ([`api.ts`](../../src/localCore/api.ts#L916)). The resolver copies unmanaged values, including `DATABASE_URL` and `KESTREL_STORE_DRIVER`, into `runtimeEnv` ([`runtimeEnvironment.ts`](../../src/localCore/runtimeEnvironment.ts#L173), [`runtimeEnvironment.ts`](../../src/localCore/runtimeEnvironment.ts#L378)).

`KestrelChatRuntime` passes `runtimeEnv` into `LocalDevShellService` ([`KestrelChatRuntime.ts`](../../cli/runtime/KestrelChatRuntime.ts#L3375), [`KestrelChatRuntime.ts`](../../cli/runtime/KestrelChatRuntime.ts#L4106)). This injection is intentional and tested. The missing decision is which component owns the internal store values in that environment.

### A generic workspace variable currently selects Kestrel storage

On its first request, `LocalDevShellService` starts the detached service with its injected environment ([`LocalDevShellService.ts`](../../src/devshell/LocalDevShellService.ts#L361), [`LocalDevShellService.ts`](../../src/devshell/LocalDevShellService.ts#L490)). The child initializes storage before it binds the socket ([`service.ts`](../../cli/dev-shell/service.ts#L35)).

Developer-shell bootstrap calls `createSqlExecutorFromEnv` without an explicit driver ([`DevShellRuntimeBootstrap.ts`](../../src/devshell/DevShellRuntimeBootstrap.ts#L130)). That factory's `auto` mode chooses Postgres whenever `DATABASE_URL` exists ([`createSessionStore.ts`](../../src/store/createSessionStore.ts#L71)). The service then runs developer-shell migrations against that URL ([`DevShellDatabaseMigrations.ts`](../../src/devshell/DevShellDatabaseMigrations.ts#L22)).

The exact failed Desktop run had a PGlite Local Core but a detached daemon environment containing `DATABASE_URL` for `127.0.0.1:55432`. No process listened there. Both Python commands failed during migration with `ECONNREFUSED`; neither command started. The same failure occurred on six bootstrap attempts across August 28–29, 2026. An isolated reproduction failed with the ambient URL and completed when the URL was absent.

### Service reuse lacks store identity

Developer-shell health identifies protocol and process capabilities ([`contracts.ts`](../../src/devshell/contracts.ts#L10)). Compatibility accepts any health response with the current version and required capabilities ([`LocalDevShellService.ts`](../../src/devshell/LocalDevShellService.ts#L696)). It does not prove which store the service opened.

This means a launch-only fix can still reuse a healthy service bound under old configuration. Store identity must participate in compatibility or the binding is not authoritative across process lifetime.

### Diagnostics preserve evidence but do not guide recovery

The service records a safe `migration_failed` bootstrap reason and keeps detailed migration output in the local log ([`service.ts`](../../cli/dev-shell/service.ts#L312), [`bootstrapFailure.ts`](../../src/devshell/bootstrapFailure.ts#L1)). `LocalDevShellService` wraps that as `DEV_SHELL_SERVICE_UNAVAILABLE` ([`LocalDevShellService.ts`](../../src/devshell/LocalDevShellService.ts#L557)). Model-visible shaping exposes the safe reason and suggested-action field but not the raw log tail ([`toolResult.ts`](../../tools/toolResult.ts#L274)).

`migration_failed` does not currently supply a suggested action. The model therefore changed `python3` to `python`, even though the command had not executed.

## Affected Surface

| Surface                     | Current responsibility                           | Proposed responsibility                                                     |
| --------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Local Core store handle     | Own runtime persistence                          | Also derive the developer-shell control-store binding                       |
| Runner runtime factory      | Supply shared store and resolved environments    | Carry host-only developer-shell store authority                             |
| `runtimeEnv`                | Supply the general runtime/workspace environment | Stop acting as the developer-shell store selector                           |
| `LocalDevShellService`      | Start and reuse the detached service             | Hold an immutable explicit store binding and require its revision in health |
| Service bootstrap           | Infer store from process environment             | Open the explicitly supplied driver and location                            |
| Service health              | Prove protocol capabilities                      | Also prove a non-secret binding identity                                    |
| Workspace shell environment | Follow `inherit` or `allowlist` policy           | Remain independent of control-store selection                               |
| Tool failure projection     | Expose a safe bootstrap reason                   | Also state the failure phase and useful next action                         |

The SQL schema, migration contents, static-site files, Python runtime, approval policy, and socket transport do not own this repair.

## External Findings That Shaped the Design

Node documents that `spawn` passes the supplied `env` to the child, defaults to `process.env`, and ignores properties whose values are `undefined`. The detached-service environment is therefore an explicit configuration boundary; Node will not distinguish internal store variables from workspace variables for Kestrel. [Node.js child process documentation](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)

This supports an explicit, purpose-specific binding at the service boundary. It also means the implementation must overlay or remove values deliberately rather than rely on `undefined` entries after object spreading.

## Options and Candidate Seams

### 1. Scrub the daemon launch environment

Removing `DATABASE_URL` in [`daemon.ts`](../../src/localCore/daemon.ts) would prevent this exact PGlite failure. It is too early and too broad. The daemon environment also feeds model tools, workspace commands, MCP processes, and other runtime services. A workspace can legitimately need a database URL unrelated to Kestrel persistence.

This is useful defense in depth for Kestrel-specific control variables, but it is not the owning repair.

### 2. Canonicalize database variables in `runtimeEnv`

[`api.ts`](../../src/localCore/api.ts) could remove database controls for PGlite or inject the external URL before creating the runtime environment resolver. This is smaller than a new binding path and would make current bootstrap choose the right driver.

It still leaves one map serving two owners. In PGlite mode, deleting `DATABASE_URL` can break the application under test. In external mode, replacing it can expose Kestrel's control database to a command that expected its application database.

Rejected as the authority design.

### 3. Make the developer shell always local

Forcing `{ driver: "sqlite" }` inside [`DevShellRuntimeBootstrap.ts`](../../src/devshell/DevShellRuntimeBootstrap.ts) removes the migration failure and reduces configuration.

The repository explicitly tests a Postgres developer-shell prerequisite, and the shared migration set owns `dev_shell_processes`. Removing that path would be a product-policy change rather than a bug repair.

Rejected.

### 4. Bind the developer-shell store explicitly

[`ensureLocalCoreStore`](../../src/localCore/store.ts#L45) already returns the successfully opened mode and exact location. That handle is the closest existing authority. Passing a small discriminated binding through the existing runtime-factory seam preserves both drivers without adding a persisted setting or public protocol.

Chosen.

### 5. Add retries or improve diagnostics only

A retry cannot make a refused endpoint authoritative or reachable. Better diagnostics are valuable, but downstream explanation cannot repair upstream store selection.

Rejected as the primary repair. Safe recovery guidance remains part of the final design.

## Proposed Delta

### 1. Add one internal store-binding contract

Use a discriminated union with only valid states:

```ts
type DevShellStoreBinding =
  | { revision: string; driver: "sqlite" }
  | { revision: string; driver: "postgres"; databaseUrl: string };
```

This is host-only construction data. It is not a user setting, tool input, persisted session field, or API request field.

Local Core derives the binding from `LocalCoreStoreHandle` after the store opens successfully:

- `mode: "pglite"` becomes a revision plus `{ driver: "sqlite" }`.
- `mode: "external"` becomes a revision plus `{ driver: "postgres", databaseUrl: handle.databaseUrl }`.

The runner-runtime factory carries the binding separately from `runtimeEnvironmentResolver`. Runtime construction passes it to `LocalDevShellService` alongside, but not inside, the workspace environment.

Standalone `LocalDevShellService` callers may omit the binding during compatibility transition. The constructor resolves their injected `KESTREL_STORE_DRIVER` and `DATABASE_URL` once into the same union. After construction, all bootstrap logic uses the union rather than reading mutable ambient state.

### 2. Bootstrap from explicit values

The detached service receives purpose-specific internal values for its store binding. `createInitializedDevShellRuntime` accepts the parsed binding and calls the existing SQL-executor factory with explicit options:

- SQLite: explicit `driver: "sqlite"` and the existing `dev-shell/store.db` path.
- Postgres: explicit `driver: "postgres"` and the exact bound URL.

The current migration runner remains the Postgres initialization owner. The existing PGlite corruption quarantine remains limited to `STORE_SQLITE_INIT_FAILED`.

Purpose-specific internal variables must not flow into `buildShellEnv`. The service removes them after bootstrap or the shell-environment builder strips them before command spawn. The application-facing `DATABASE_URL`, if any, continues to follow `envMode` policy and does not select the control store.

The Postgres URL must not appear in logs, bootstrap status, health, or tool results.

### 3. Make service reuse store-aware

Mint an opaque revision when the host constructs an immutable binding. A changed driver or store location must receive a new revision. Local Core should mint the revision once for the runner-runtime factory so every profile runtime owned by that factory agrees on service compatibility.

Health returns the driver and revision, not the store location. The revision is an identity marker, not an authorization token. Increment `DEV_SHELL_SERVICE_PROTOCOL_VERSION` because the health compatibility contract changes.

`LocalDevShellService` accepts a running service only when:

- `ok` is true
- protocol version matches
- required capabilities are true
- store driver matches
- binding revision matches

A missing or mismatched identity follows the existing incompatible-service shutdown and restart path. No heuristic comparison, URL parsing, or fallback ranking is needed.

### 4. State the failure phase and recovery action

For persisted bootstrap failures, `LocalDevShellService` adds safe structured details already supported by tool-result projection:

- `failurePhase: "service_bootstrap"`
- `failureReason: <reasonCode>`
- `nextSuggestedAction`

For `migration_failed`, the action should say that the command did not start, database connectivity or configuration must be repaired, and the original command can then be retried. It should explicitly say that changing the command cannot repair bootstrap.

Raw `migrationOutput` and `logTail` stay local. The model does not receive connection strings, stack traces, or migration output.

### 5. Prove separation, not only successful startup

The regression contract must establish all of these behaviors:

- PGlite Local Core plus a dead ambient `DATABASE_URL` starts and completes a developer-shell command.
- The developer-shell control store is SQLite/PGlite in that scenario.
- An inherited workspace command can still observe its application `DATABASE_URL` when policy allows it.
- External Local Core supplies the exact external URL to developer-shell initialization.
- Missing external credentials fail before spawn with the existing safe reason.
- Same-protocol health with a different binding revision is rejected and restarted.
- Old health without a binding identity is incompatible.
- `migration_failed` projects a safe bootstrap phase and action while omitting raw diagnostics.
- The reported static-server command reaches a local endpoint in a smoke test and is then stopped through the normal process lifecycle.

The change touches database-mode behavior, so implementation validation should include the focused unit/smoke tests, `pnpm validate`, and `pnpm validate:postgres`.

## Transition and Coexistence

No stored-data migration is required.

| State                                          | Behavior                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| New Local Core runtime                         | Supplies an explicit binding from its opened store handle                |
| Standalone caller without a binding            | Resolves the existing injected environment once for compatibility        |
| Old running service                            | Lacks the new health identity and is restarted                           |
| Matching new running service                   | Reused without restart                                                   |
| Service under a different database mode or URL | Rejected and restarted                                                   |
| Existing local `store.db`                      | Reused normally; quarantined only under the existing corruption contract |
| Existing external tables                       | Reused after the current migration runner succeeds                       |

The compatibility fallback can be removed when every supported production caller supplies an explicit binding. It must not become the Local Core path again.

## Decisions

### The developer-shell control store is not the workspace environment

Use an explicit host-owned binding outside `runtimeEnv`. This preserves application variables while removing their unintended authority over Kestrel storage.

Confidence is high. Reopen only if product policy prohibits all workspace database environment inheritance.

### External Postgres remains supported

Follow the already-opened Local Core store mode. This preserves current tested behavior and keeps process records in the external Kestrel database when that mode is selected.

Confidence is high. Reopen only for an explicit local-only persistence policy change.

### Service compatibility includes exact store identity

Use an opaque binding revision and protocol bump. Driver alone is insufficient because two external URLs are different authorities. A raw hash of a connection string is not used because it would expose a verifier derived from credentials.

Confidence is high. Reopen if store-specific sockets replace the shared service endpoint.

### Migration failures do not auto-retry

Return safe, phase-specific action guidance. The observed endpoint refusal was deterministic across repeated launches, so another automatic retry adds delay without recovery evidence.

Confidence is high. Reopen if the database lifecycle gains an explicit readiness signal with a bounded transition.

## Research and Prototype Findings

The differential reproduction established causality: the same isolated developer-shell path failed with a dead ambient `DATABASE_URL` and passed without it. Existing focused tests all passed, confirming that current coverage validates environment injection but not Local Core's ownership of the injected store choice.

No implementation prototype is needed. The existing Local Core store handle, runtime-factory options, `LocalDevShellService` options, explicit SQL-executor options, health endpoint, and safe tool-result fields provide the required seams.

## Remaining Design Questions

No consequential design question remains. Internal symbol names and whether dedicated launch values are represented as private environment keys or another private child-process channel are implementation choices. Either mechanism must preserve the explicit binding, secret-redaction, and workspace-environment invariants above.
