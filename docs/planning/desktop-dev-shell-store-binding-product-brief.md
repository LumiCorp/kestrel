# Desktop Developer Shell Store Binding Product Brief

## Product Narrative

Kestrel Desktop users rely on the developer shell to run builds, tests, preview servers, and other commands in a selected workspace. Today, the detached developer-shell service can treat a workspace or launcher `DATABASE_URL` as Kestrel's internal storage configuration. This can redirect service startup to an unrelated or unavailable Postgres endpoint.

When this happens, the service fails before the requested command starts. The user sees `DEV_SHELL_SERVICE_UNAVAILABLE` with `migration_failed`, but the result does not explain that changing the command cannot help. In the reported incident, both Python static-server commands failed even though Python and the static site were valid.

Kestrel must separate two responsibilities:

- The workspace command environment supplies variables that commands may inherit under the active developer-shell policy.
- The developer-shell control store persists Kestrel-owned process records, output cursors, write guards, and retention leases.

Local Core must choose the control store from its successfully opened store handle. It must pass that choice as an explicit developer-shell store binding. A workspace variable must never select the control store.

The result is a reliable developer-shell startup path that preserves PGlite, external Postgres, workspace environment behavior, and safe recovery guidance.

## Outcomes and Delivery Boundary

This initiative must produce these outcomes:

- A PGlite Local Core starts the developer shell even when the inherited workspace environment contains an unrelated or stale `DATABASE_URL`.
- An external-Postgres Local Core binds the developer-shell control store to its exact configured database.
- Workspace commands continue to receive variables allowed by their `inherit` or `allowlist` policy without controlling Kestrel storage.
- A client reuses a running developer-shell service only when its protocol, capabilities, and store binding revision match.
- A storage bootstrap failure tells the user and model that the command did not start and provides the correct recovery action.
- Existing local developer-shell data, external tables, and local-store recovery behavior remain compatible.

The delivery boundary includes:

- Local Core derivation of developer-shell store authority.
- Host-only propagation of that authority through runtime construction.
- Developer-shell service bootstrap and health compatibility.
- Separation of internal store values from workspace command environments.
- Safe failure projection and regression coverage.

This initiative does not:

- Change the static site, Python, command syntax, or workspace path.
- Change the selected developer-shell environment policy or approval policy.
- Remove external Postgres support.
- Force all developer-shell stores to PGlite.
- Remove application-facing `DATABASE_URL` from inherited workspace commands.
- Change the developer-shell SQL schema or migration contents.
- Add automatic migration retries or heuristic database selection.
- Add a user-facing database setting or a public API field.

## Defining Scenarios

### Desktop user starts a local preview under PGlite

A Desktop user asks Kestrel to serve a static workspace. Local Core is using PGlite, but the workspace environment contains a dead or application-specific `DATABASE_URL`.

Local Core derives a SQLite/PGlite developer-shell store binding from its opened store handle. The detached service opens the existing local developer-shell store and becomes healthy. The command starts, the local endpoint becomes reachable, and Kestrel reports the running process.

If the command uses `envMode: inherit`, the command may still receive the application-facing `DATABASE_URL`. That value does not affect the developer-shell control store.

### Desktop user runs a command under external Postgres

An administrator has configured Local Core to use external Postgres. Local Core opens the exact configured database and derives a Postgres developer-shell store binding from that handle.

The developer-shell service uses that exact database for its process records and applies the existing migrations before becoming healthy. Workspace command environment policy remains independent of this internal binding.

If the external database is unavailable, the service reports a storage bootstrap failure. The requested workspace command does not start.

### A healthy service has an old store binding

A developer-shell service is already listening on the shared socket, but it was created by another Local Core lifetime or under another database binding.

The client reads health and compares the service's protocol, required capabilities, store driver, and opaque binding revision with the expected values. A missing or different revision makes the service incompatible. The client uses the existing safe incompatible-service shutdown and restart path.

The replacement service opens the current binding before accepting commands. Kestrel never silently reuses the old service.

### Developer-shell storage cannot initialize

A user submits a valid workspace command, but the explicitly bound control store cannot initialize or migrate.

Kestrel records the detailed local diagnostic evidence and returns a safe structured failure. The failure identifies `service_bootstrap` as the phase, states that the command did not run, and directs the caller to repair storage connectivity or configuration before retrying the original command.

Changing `python3` to `python`, changing the command text, or automatically repeating the same migration is not presented as recovery.

### A standalone caller has not adopted explicit binding

A supported standalone caller creates `LocalDevShellService` without an explicit binding. The service resolves the caller's injected store configuration once at construction and converts it to the same explicit internal contract.

This compatibility path preserves current standalone behavior while Local Core always uses the host-owned binding. The fallback must not regain authority in Local Core.

### A local developer-shell store is corrupt

A PGlite developer-shell store fails with the existing recoverable `STORE_SQLITE_INIT_FAILED` condition.

Kestrel uses the existing quarantine-and-retry behavior. The new store binding does not broaden recovery to Postgres failures, migration failures, or unknown initialization failures.

## Business and Process Requirements

- Kestrel must report a workspace command as started only after the developer-shell service has opened the expected control store and passed health compatibility.
- A workspace environment variable must not select or change Kestrel's developer-shell control store.
- The Local Core database mode must determine the developer-shell control-store mode.
- PGlite Local Core must use the local developer-shell PGlite store.
- External-Postgres Local Core must use its exact configured database for developer-shell control records.
- A running service with missing or mismatched store identity must be treated as incompatible.
- Incompatible service replacement must use the existing controlled shutdown and restart process.
- A service bootstrap failure must be distinguishable from a workspace command failure.
- Failure guidance must tell the caller whether the command started.
- `migration_failed` guidance must direct the caller to storage configuration or connectivity. It must state that changing the command cannot repair bootstrap.
- Kestrel must not automatically retry a deterministic migration failure without an explicit database readiness signal.
- Detailed migration output must remain available to local operators without being exposed to the model.
- Existing local data must remain in place unless the existing PGlite corruption contract authorizes quarantine.
- Delivery must not require a schema migration, destructive reset, or manual cleanup of the static workspace.

## Technology Requirements

### Store authority and runtime construction

- The developer-shell store binding must be a discriminated internal contract with only these valid states:
  - an opaque revision and `driver: "sqlite"`
  - an opaque revision, `driver: "postgres"`, and an exact `databaseUrl`
- Local Core must derive the binding from `LocalCoreStoreHandle` after the store opens successfully.
- Local Core must not derive the binding from daemon `process.env`, workspace `runtimeEnv`, or command input.
- Local Core must mint one binding revision for the immutable runner-runtime factory binding.
- Every profile runtime owned by that factory must use the same revision.
- A changed driver or store location must receive a new revision.
- The runner-runtime factory must carry the binding as host-only construction data.
- `KestrelChatRuntime` must pass the binding to `LocalDevShellService` separately from the workspace environment.
- The binding must not become a user setting, tool field, persisted session field, or public Local Core request field.

### Service bootstrap

- `LocalDevShellService` must hold one immutable store binding for its lifetime.
- A supported caller that omits the binding must resolve its injected legacy store environment once at construction.
- The detached service must receive the explicit internal driver, binding revision, and Postgres URL when required.
- Developer-shell runtime bootstrap must pass explicit `driver`, `sqlitePath`, and `databaseUrl` options to the existing SQL-executor factory.
- Generic `DATABASE_URL` must not select the internal driver after the explicit binding exists.
- SQLite mode must continue using the existing developer-shell `store.db` location.
- Postgres mode must continue using the existing developer-shell migration runner.
- Explicit Postgres mode without a URL must fail before service spawn with the existing safe missing-database reason.
- The PGlite quarantine retry must remain limited to `STORE_SQLITE_INIT_FAILED`.

### Workspace environment separation

- The service must keep its internal binding values separate from the workspace command environment.
- Purpose-specific internal driver, URL, and revision values must not reach commands spawned by `DevShellSupervisor`.
- An application-facing `DATABASE_URL` must continue to follow the selected `inherit` or `allowlist` policy.
- Kestrel-specific store-control variables may be scrubbed as defense in depth, but that scrub must not replace explicit binding.
- The implementation must not infer store authority from command text, workspace paths, URLs, environment names, or retry history.

### Service identity and compatibility

- Developer-shell health must include the store driver and opaque binding revision.
- Health must not include the PGlite path, Postgres URL, credentials, or a raw hash derived from credentials.
- The binding revision must be an identity marker, not an authorization token.
- `DEV_SHELL_SERVICE_PROTOCOL_VERSION` must increase for the health contract change.
- Health compatibility must require the current protocol, all existing required capabilities, the expected driver, and the expected binding revision.
- Health without a binding identity must be incompatible.
- A same-protocol service with a different revision must be incompatible.
- A matching service must remain reusable without restart.

### Security and diagnostics

- Postgres credentials must not appear in health, bootstrap status, model-visible tool output, or logs.
- Raw migration output and the local log tail must remain outside model-visible failure shaping.
- Persisted bootstrap failures must expose the existing safe reason code.
- Model-visible failures must include `failurePhase: "service_bootstrap"`, the safe failure reason, and an actionable `nextSuggestedAction`.
- Failure shaping must preserve machine-readable `DEV_SHELL_SERVICE_UNAVAILABLE` behavior for existing consumers.
- Structured diagnostics must distinguish missing database configuration, migration failure, local-store initialization failure, socket binding failure, and health timeout.

### Data, migration, and compatibility

- The initiative must not change the developer-shell process schema or migration SQL.
- Existing local `store.db` data must remain readable.
- Existing external developer-shell tables must remain usable after current migrations complete.
- An old running service must be replaced because it lacks the new binding identity.
- The standalone environment fallback may remain only while supported callers still omit explicit binding.
- Local Core must never use the fallback after this change.
- Removing the fallback later requires proof that every supported production caller supplies a binding.

### Verification and reliability

- Regression coverage must prove that PGlite Local Core ignores a dead ambient `DATABASE_URL` for developer-shell storage.
- The same coverage must prove that an inherited workspace command can still observe its allowed application `DATABASE_URL`.
- Coverage must prove that PGlite mode opens the local developer-shell store and does not run external Postgres migration.
- External-Postgres coverage must prove that bootstrap receives the exact Local Core URL and runs the existing migrations.
- Coverage must preserve the safe missing-URL prerequisite failure for explicit Postgres mode.
- Health tests must cover matching revision, mismatched revision, missing identity, and old protocol behavior.
- Failure-projection tests must prove that `migration_failed` reports bootstrap phase and safe recovery guidance without raw diagnostics.
- A smoke test must start `python3 -m http.server` on an available local port, confirm that the endpoint is reachable, and stop the process through the normal lifecycle.
- The focused developer-shell, runtime-environment, Local Core, migration, and tool-result tests must pass.
- `pnpm validate` must pass before the change is ready to publish.
- `pnpm validate:postgres` must pass because external database binding behavior changes.

## People and Operating Requirements

- Desktop users own the workspace command they request. They do not choose or maintain the developer-shell control store separately.
- Administrators continue to own the existing Local Core database-mode choice and external database configuration.
- Local Core owns developer-shell store selection and propagation.
- The developer-shell service owns explicit store initialization, migrations, health identity, and process-record persistence.
- Workspace environment policy continues to own which application variables a command may receive.
- Operators own repair of an unavailable explicitly configured external database.
- Support staff must be able to distinguish service bootstrap failure from command failure using safe structured fields and local diagnostic paths.
- Support guidance must not direct users to rename a command, delete workspace files, or reset local state when storage bootstrap failed.
- No new user permission, administrator workflow, training program, or ongoing manual store-maintenance role is introduced.

## Success and Readiness

Success is observable when:

- The reported static site starts from Desktop with `python3 -m http.server 8000` while Local Core uses PGlite and a dead ambient database URL exists.
- The local endpoint is created and can be reached.
- The developer-shell control store remains PGlite-backed in that scenario.
- An inherited workspace command retains its allowed application database URL.
- External-Postgres mode initializes against the exact configured Local Core database.
- A healthy service created under another binding is replaced before command execution.
- A matching service is reused.
- Storage bootstrap failures state that the command did not run and provide the correct recovery action.
- No store credential or raw migration detail appears in model-visible output.
- Existing PGlite corruption recovery and external migration behavior remain intact.
- Focused tests, `pnpm validate`, and `pnpm validate:postgres` pass.

**Readiness: Ready for issue creation.**

The product behavior, architecture seam, data ownership, service compatibility, failure behavior, transition, and operating responsibilities are settled. The private transport used to carry the host-only binding remains a non-blocking implementation choice. It cannot change the explicit-authority, redaction, or workspace-environment requirements.

## Source Artifacts

- [Desktop Developer Shell Store Binding Change Design](../design/desktop-dev-shell-store-binding-change-design.md)
- [Desktop Developer Shell Store Binding Design Notebook](../../.design/desktop-dev-shell-store-binding/notebook.md)
