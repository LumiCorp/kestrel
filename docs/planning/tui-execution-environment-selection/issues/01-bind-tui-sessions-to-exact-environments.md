# Bind every TUI session to one exact execution environment

## Useful outcome

A new local TUI session can build and validate its selected workspace without an internal profile choice. Workspace-bound sessions use Developer workspace by default. Detached sessions use Safe sandbox. Every later turn, resume, and background run keeps the same exact environment.

This slice establishes the durable session and runtime contract required by every scenario in the [TUI Execution Environment Selection Product Brief](../../tui-execution-environment-selection-product-brief.md).

## What changes

- Select `cli_dev_local` when the TUI creates a session bound to a local workspace. Select `cli_safe_local` when it creates a detached session.
- Persist the exact environment before the first turn. Populate the agent, environment, capability-pack, and effective-assembly identity fields already declared on `TuiSessionMeta` when those values become available.
- Make `SessionStore` validate and preserve those identity fields. Loading and saving a session must not discard them.
- Pass the active session's exact `environmentPresetId` to Local Core for ordinary turns, replies, blocked-run resume, MCP status and refresh, and every TUI preflight that describes effective tools.
- Restore the session's environment with its authoring profile and workspace when the user switches or resumes a session.
- Make operator-launched background sessions inherit and persist the parent's environment before Local Core resolves their profile. Keep model-delegated threads on the existing runtime assembly inheritance path.
- Extend `OperatorAssemblySummary` with the exact `environmentPresetId`. Populate it from the active thread or assembly and validate it through the protocol boundary.
- Hydrate a started legacy session with no persisted environment from `OperatorAssemblySummary.environmentPresetId`. Backfill the exact value after successful recovery.
- Compare persisted and runtime environment identity before resume. Report a stable **Environment unknown** failure when neither source can establish the identity. Report a consistency failure when the values conflict.
- Keep the environment immutable after the session starts or receives a runtime thread or assembly. Do not recompose or migrate an existing runtime tree when a different profile is resolved.
- Preserve the current environment of `default-tmp-3` and other started sessions. The new Developer workspace default applies only to new or unstarted workspace-bound sessions.

## Requirements and delivery context

The TUI currently omits the environment in [`TuiRunController`](../../../../cli/app/TuiRunController.ts), background and MCP resolution in [`App`](../../../../cli/app/App.ts), and both session constructors. Local Core therefore applies its optional CLI fallback, `cli_safe_local`.

`TuiSessionMeta` already declares the required identity fields in [`cli/contracts.ts`](../../../../cli/contracts.ts). `SessionStore.validateSession` currently drops them. Use this existing state contract rather than adding a second product-level environment enum.

Local Core must remain the only component that composes Kestrel agent policy with an environment binding. The TUI must pass the exact preset ID but must not construct capability packs, tool allowlists, or approval policy.

Preserve these contracts:

- `environmentPresetId` remains the stable value for resolution, fingerprints, replay, validation, and diagnostics.
- `cli_dev_local` is the local Developer workspace binding. `cli_safe_local` is Safe sandbox.
- The execution-profile registry continues to issue immutable environment-bound profile IDs.
- `RuntimeComposer` continues to retain a started thread's active assembly. Do not add automatic profile-mismatch migration at turn start.
- Started legacy sessions preserve runtime authority even when it differs from the new-session default.
- Legacy identity must come from an exact projected field. Do not infer it from labels, bundle IDs, workspace paths, or tool names.
- Missing or conflicting identity fails closed and produces diagnostic evidence.
- Environment selection does not bypass the active execution approval policy.
- Desktop, web, hosted policy, the sandbox executor, the development-shell runner, and legacy Job V1 remain outside this issue.

Update focused coverage in the existing session-store, run-controller, app-command, Local Core profile-resolution, operator projection, protocol, and orchestration tests. Include the relevant compatibility cases. Run the repository's full required validation gate after the focused tests pass.

## Done when

- A newly created local workspace session persists `cli_dev_local`, resolves a profile that exposes `dev.shell.run`, and can observe the workspace's installed Node, npm, and pnpm when policy permits execution.
- A newly created detached session persists `cli_safe_local` and does not expose the development shell.
- Ordinary turns, blocked-run resume, MCP inspection, session switching, restart, and operator-launched background work all use the session's exact environment.
- An operator-launched background session inherits the parent environment, while model-delegated threads retain assembly inheritance.
- Session serialization and Local Core session storage round-trip all declared runtime identity fields without loss.
- `OperatorAssemblySummary.environmentPresetId` is populated and validated as an exact supported preset.
- A started legacy session backfills exact runtime identity and resumes without applying the new-session default.
- Unknown or conflicting legacy identity prevents resume with a stable user-facing error and exact diagnostics.
- No code path infers or automatically widens environment authority.
- Focused tests and `pnpm validate` pass.
