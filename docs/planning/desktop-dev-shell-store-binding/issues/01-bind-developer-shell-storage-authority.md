# Bind the developer shell to Local Core storage authority

## Useful outcome

A Kestrel Desktop user can start a workspace command under PGlite even when the inherited workspace environment contains an unrelated or dead `DATABASE_URL`. External-Postgres installations continue to use their exact configured database.

The developer-shell service either opens the Local Core-owned control store and runs the command, or returns a safe failure that says the command did not start. A healthy service created under another store binding is not silently reused.

This issue delivers the complete repair defined by the [Desktop Developer Shell Store Binding Product Brief](../../desktop-dev-shell-store-binding-product-brief.md).

## What changes

Introduce one internal developer-shell store binding with an opaque revision and either:

- `driver: "sqlite"`; or
- `driver: "postgres"` with the exact `databaseUrl`.

After Local Core opens its store, derive the binding from `LocalCoreStoreHandle`. Mint one revision for the immutable runner-runtime factory binding. Carry the binding through runtime construction to `LocalDevShellService` separately from `runtimeEnv`.

Make developer-shell bootstrap use the explicit driver, database URL, and local `store.db` path. A generic workspace `DATABASE_URL` must not select Kestrel's internal store. Purpose-specific internal binding values must not reach commands spawned by `DevShellSupervisor`. An application-facing `DATABASE_URL` must continue to follow the command's `inherit` or `allowlist` policy.

Preserve supported standalone callers that omit the new binding. Resolve their injected legacy store configuration once when `LocalDevShellService` is constructed. Local Core must always supply the explicit binding and must never use this fallback.

Extend developer-shell health with the store driver and opaque binding revision. Increment the service protocol version. Accept a running service only when its protocol, required capabilities, driver, and revision match. Treat missing or mismatched identity as incompatible and use the existing controlled shutdown and restart path.

Make persisted bootstrap failures distinguish service startup from command execution. Model-visible failures must include `failurePhase: "service_bootstrap"`, the safe reason, and an actionable `nextSuggestedAction`. For `migration_failed`, state that the command did not run and that storage connectivity or configuration must be repaired before retrying the original command. Do not suggest another command or automatically retry the migration.

## Requirements and delivery context

The first wrong state currently appears when Local Core passes its raw launch environment into runtime construction. `LocalDevShellService` then passes that environment to the detached service, and `createInitializedDevShellRuntime` lets `createSqlExecutorFromEnv` select Postgres from `DATABASE_URL`. The service runs migrations before binding its socket, so an unrelated dead URL prevents every workspace command from starting.

Use the existing ownership seams:

- `ensureLocalCoreStore` and `LocalCoreStoreHandle` own the successfully opened Local Core store.
- The Local Core runner-runtime factory owns host-only construction data shared by its profile runtimes.
- `LocalDevShellService` owns detached service launch and compatibility checks.
- `createInitializedDevShellRuntime` owns explicit control-store initialization and existing PGlite recovery.
- The developer-shell health contract owns reusable-service compatibility.
- Existing safe tool-result fields own model-visible failure guidance.

Preserve these contracts:

- PGlite Local Core uses the existing local developer-shell `store.db`.
- External-Postgres Local Core uses the exact URL from its opened store handle and the existing migration runner.
- Explicit Postgres without a URL fails before spawn with the existing safe missing-database reason.
- PGlite quarantine and one retry remain limited to `STORE_SQLITE_INIT_FAILED`.
- Existing local data, external tables, migration SQL, approval policy, and command environment policy remain unchanged.
- Old health without store identity is incompatible. Matching new health remains reusable.
- Store URLs and credentials never appear in health, bootstrap status, model-visible output, or logs. Do not use a raw hash of a connection string as identity.
- Raw migration output and `logTail` remain local diagnostic evidence.
- `DEV_SHELL_SERVICE_UNAVAILABLE` remains the machine-readable outer failure for existing consumers.
- Do not add a schema migration, public API field, user setting, automatic retry, keyword rule, URL classifier, or other heuristic store selection.

Use focused regression tests at the owning seams. Include a real smoke path for the reported static-server behavior. Run `pnpm validate` and `pnpm validate:postgres` because the change crosses the portable runtime and external database boundaries.

## Done when

- A PGlite Local Core with a dead ambient `DATABASE_URL` starts and completes a developer-shell command without running external Postgres migration.
- Under `envMode: inherit`, a workspace command can still observe its allowed application `DATABASE_URL` while the control store remains PGlite-backed.
- External-Postgres bootstrap receives the exact URL from the Local Core store handle and runs the existing migrations.
- Explicit Postgres with no URL still returns the safe missing-database prerequisite failure before service spawn.
- A service with matching protocol, capabilities, driver, and revision is reused.
- A service with missing or mismatched binding identity is stopped and replaced before command execution.
- Purpose-specific binding values and store credentials are absent from command environments, health, bootstrap status, model-visible failures, and logs.
- `migration_failed` reports `service_bootstrap`, states that the command did not run, and directs the caller to repair storage before retrying the original command.
- A smoke test starts `python3 -m http.server` on an available local port, reaches the endpoint, and stops the process through the normal developer-shell lifecycle.
- Existing PGlite corruption recovery and external migration tests remain green.
- Focused developer-shell, Local Core, runtime-environment, migration, and tool-result tests pass.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Review repair issues

- [Preserve standalone developer-shell store resolution](02-preserve-standalone-store-resolution.md)
- [Make incompatible developer-shell replacement exclusive](03-make-incompatible-service-replacement-exclusive.md)
- [Serialize developer-shell service bootstrap](04-serialize-service-bootstrap.md)
- [Refuse unproven legacy service termination](05-refuse-unproven-legacy-service-termination.md)
- [Assert store binding at command dispatch](06-assert-binding-at-command-dispatch.md)
- [Make bootstrap authority crash-safe and child-owned](07-make-bootstrap-authority-crash-safe.md)
- [Use cooperative service shutdown instead of numeric PID signaling](08-use-cooperative-service-shutdown.md)
- [Parse bootstrap authority evidence strictly](09-parse-authority-evidence-strictly.md)
- [Serialize same-client bootstrap attempts](10-serialize-same-client-bootstrap-attempts.md)
