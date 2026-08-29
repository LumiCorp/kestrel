# TUI Execution Environment Selection Design Notebook

## Current Position

Keep one canonical `Kestrel` agent profile and present execution authority as a separate session choice.

The local TUI choices are **Developer workspace** and **Safe sandbox**. Their exact contract values remain `cli_dev_local` and `cli_safe_local`; normal UI does not expose those IDs. A session bound to a local workspace defaults to Developer workspace. A detached session with no workspace defaults to Safe sandbox. The environment may change before the first turn. After work starts it is immutable, so selecting another environment starts a new session in the same workspace.

Developer workspace is one product concept with different placements. `cli_dev_local` is the local-host binding; `workspace_hosted` is the hosted binding. Safe sandbox is an explicit restricted mode for work that should not execute project code.

Safe sandbox is useful for detached investigation, reviewing unfamiliar files without running the project, and isolated snippets or data transformations. It is not the normal environment for implementation, dependency installation, builds, tests, or workspace validation.

This position changed after tracing persisted runtime assemblies. Passing a different environment to Local Core is not enough for an existing session: the runtime retains the thread's active assembly and inherited child assemblies. An in-place switch would be a multi-thread authority migration, not a TUI preference update.

## Requested Change

- Show one Kestrel agent and a plain description of where commands can run.
- Explicitly record Developer workspace for a new workspace-bound local session by default.
- Let the user choose Safe sandbox when they want restricted inspection or isolated snippets.
- Carry the exact choice through turns, resumes, background tasks, and environment-sensitive lookups.
- Explain that Safe sandbox is isolated scratch execution, not a project shell.
- Explain that Developer workspace runs commands against the selected host workspace and can use installed tools such as Node, npm, and pnpm.
- Use product labels in normal UI and raw IDs only in diagnostics and evidence.
- Start a new session when a user wants a different environment after work has begun.

## Starting Sources

- Runtime records for `default-tmp-3`
- `src/profile/runtimeProfile.ts`
- `src/localCore/profileProvider.ts`
- `src/localCore/executionProfileRegistry.ts`
- `cli/app/TuiRunController.ts`
- `cli/app/App.ts`
- `cli/app/TuiBootstrap.ts`
- `cli/app/SessionController.ts`
- `cli/session/SessionStore.ts`
- `cli/contracts.ts`
- `src/orchestration/RuntimeComposer.ts`
- `src/orchestration/ThreadRuntime.ts`
- `tools/code/execute.ts`
- `tools/devshell/run.ts`
- `src/code/DockerSandboxExecutor.ts`
- `docs/cli/kchat.md`
- Prior retained Kestrel build-validation incident summarized in memory

## Relevant Current Behavior

1. Kestrel already separates one canonical agent policy from environment bindings. `cli_safe_local` supplies `sandbox_code`; `cli_dev_local` supplies `dev_shell`.
2. Local Core accepts an optional CLI `environmentPresetId`; omission deliberately becomes `cli_safe_local`.
3. The execution-profile registry creates an immutable ID from policy, environment preset, and fingerprint.
4. Normal TUI turns, TUI background runs, and MCP status/refresh omit `environmentPresetId`.
5. `TuiSessionMeta` already declares agent, environment, and assembly identity fields. Session constructors leave them empty, and `SessionStore.validateSession` drops them on load.
6. `default-tmp-3` has profile and workspace identity but no environment identity. Runtime history records a `cli_safe_local` assembly with `code.execute` and without `dev.shell.run`.
7. `code.execute` stages inputs into a fresh Docker tmpfs with no project mount or network. Bash uses a staged `main.sh`; it is not the project shell.
8. `dev.shell.run` owns project installs, builds, tests, inspections, and smoke checks.
9. At turn start, `RuntimeComposer` preserves an existing active assembly except for a narrow legacy Desktop migration. A newly resolved developer profile therefore cannot replace a safe assembly by itself.
10. Model-delegated child threads inherit the parent's assembly. Operator-launched background tasks create separate TUI sessions and currently fall back independently to safe.
11. Job V2 already requires and evidences an exact environment. Desktop, hosted, and web use separate authoritative inputs.

The first component that made workspace validation unavailable was the TUI caller omitting its environment choice. The model compounded the error by treating `code.execute` as a project shell. Local Core and Docker behaved according to their current contracts.

## Affected Surface

- Guided session creation and pre-start editing
- Session persistence and legacy hydration
- Session resume and switching
- Normal turns and operator-launched background sessions
- MCP status and refresh
- Runtime projection of exact environment identity
- TUI status, palette, session lists, history, and profile display
- The model-visible `code.execute` description
- Focused contract and regression tests
- CLI documentation

The Docker sandbox, host-shell runner, approval packs, Desktop settings, hosted workspace policy, and web profile need no new authority mechanism. Legacy Job V1 has a similar omission but is outside this TUI change; Job V2 is already explicit.

## External Research

VS Code starts unfamiliar folders in Restricted Mode, blocks terminals and tasks, prompts before execution, leaves the folder restricted on cancel, and keeps the state visible. JetBrains similarly distinguishes Safe Mode from Trust Project and explains that trusting enables initialization, dependencies, and full features.

- https://code.visualstudio.com/docs/editing/workspaces/workspace-trust
- https://www.jetbrains.com/help/idea/project-security.html

Design effect: keep the environment visible and describe the consequence of both choices. Unlike an unfamiliar folder opened for inspection, a Kestrel session deliberately bound to a development workspace is expected to build and validate that workspace, so Developer workspace is the default. Safe sandbox is the explicit restricted choice. Kestrel's environment remains session-scoped; it must not be described as permanent folder trust.

Inquirer separates a choice's returned value from its displayed name and description. Google API guidance similarly distinguishes stable identifiers from display names.

- https://github.com/SBoudrias/Inquirer.js/blob/main/packages/select/README.md#choice-object
- https://google.aip.dev/148#other-names

Design effect: preserve `environmentPresetId` for resolution, fingerprints, replay, and diagnostics. Add one exhaustive TUI presentation mapping instead of renaming the identifiers.

## Candidate Seams and Options

### Add Node to `code.execute`

Rejected. The project is not mounted, so this still would not validate the workspace. Mounting it would change the isolation contract.

### Choose one global CLI environment

Rejected as the authority owner. Resumed and concurrent sessions need stable, different choices. A process flag could only seed a future new-session default.

### Persist and switch the session environment in place

Necessary persistence, wrong transition. A correct switch must rebind the canonical thread and every resumable child, reject active or waiting work, preserve custom or approved assemblies, and atomically commit session state after runtime success. Defer until transcript continuity across authority changes is a proven requirement.

### Explicit environment, immutable after start

Chosen. Select at guided session creation, persist through the existing fields, and pass it through every TUI-owned resolution. A different post-start selection creates a new session in the same workspace, leaving runtime evidence coherent.

### Infer or auto-upgrade for build tasks

Rejected. Task text, a failed call, or a model choice cannot increase host command authority.

## Proposed Delta

Normal TUI surfaces show independent values:

- **Agent:** Kestrel
- **Environment:** Safe sandbox or Developer workspace

Use one exhaustive mapping:

| Contract value | Product label | Consequence |
| --- | --- | --- |
| `cli_dev_local` | Developer workspace | Commands run against the selected local workspace using tools installed on this machine, subject to the active execution policy. |
| `workspace_hosted` | Developer workspace (hosted) | Commands run against the selected hosted workspace under hosted environment policy. |
| `cli_safe_local` | Safe sandbox | Code snippets run in isolated containers. Project commands and workspace package managers are unavailable. |

`/profiles` remains about agent profiles and stops presenting presets as profiles. Assembly labels use product language. Verbose diagnostics retain exact preset, resolved profile, fingerprint, and assembly IDs.

The guided start journey includes an Environment step after workspace selection and before confirmation. Developer workspace is preselected when a local workspace is bound. Safe sandbox is preselected only for detached sessions and remains available as an explicit restricted choice. The confirmation displays the exact workspace path and consequence.

Persist the exact `environmentPresetId` already supported by `TuiSessionMeta`; derive the label. An unstarted session can change in place. Once `started` is true or a runtime assembly exists, a different choice creates a new session with the same workspace and agent profile. It does not copy waits, runtime threads, assembly records, or execution history into the new authority boundary.

Pass the active session's exact environment to ordinary turns, blocked-run resume, MCP status/refresh, operator-launched background resolution, and any TUI preflight that claims to describe effective tools. Operator-launched background sessions inherit the parent's environment. Model-delegated children continue inheriting the active assembly. Independent new workspace sessions default to their developer binding; detached sessions default to Safe sandbox.

Session parsing must preserve the existing environment and assembly fields. For a started legacy session without them, hydrate from exact runtime thread/assembly identity and backfill. The runtime projection must expose the exact field; do not infer from labels, bundle IDs, or tools. If neither session nor runtime can supply it, fail closed with unknown environment rather than guessing. An unstarted legacy session uses the new default: Developer workspace when workspace-bound, Safe sandbox when detached.

For `default-tmp-3`, runtime truth is `cli_safe_local`, so it remains a Safe sandbox session. Project package managers require a new Developer workspace session.

The model-visible `code.execute` description must say it runs declared code in an isolated scratch container, not inside the project workspace, and cannot determine host-installed tools. `dev.shell.run` remains the project install/build/test owner.

## Domain Model

- **Agent profile:** Kestrel behavior, model, reasoning, and agent contract.
- **Execution environment:** The session-bound place and authority for command execution.
- **Safe sandbox:** Docker-backed scratch execution with no host workspace shell.
- **Developer workspace:** Governed command execution against one selected local or hosted workspace.
- **Environment binding:** Internal policy and capabilities realizing an environment for a client.
- **Resolved execution profile:** Immutable composition of agent policy, environment, model configuration, integrations, and fingerprint.
- **Runtime assembly:** Persisted tools and policies active for a runtime thread.
- **Client:** CLI, Desktop, Web, or hosted runtime; not an authority choice.

Invariants:

- One local TUI session has one exact environment after start.
- Resolved profile and active assembly agree on environment identity.
- Only the operator or existing trusted host policy can choose greater authority.
- Models and task classifiers cannot elevate it.
- Resume preserves it; new workspace-bound sessions default to the applicable developer binding.
- Safe sandbox is the explicit restricted mode and the detached-session default.
- Runtime evidence is authoritative for legacy started sessions.
- Raw preset IDs remain exact contracts, not normal product language.

## Transition States

| Session state | Environment source | Behavior |
| --- | --- | --- |
| New, local workspace-bound | Developer workspace default | Persist `cli_dev_local` before first turn |
| New, hosted workspace-bound | Hosted developer binding | Persist `workspace_hosted` before first turn |
| New, detached | Safe sandbox default | Persist restricted environment before first turn |
| Existing unstarted, missing identity | Default from workspace binding | Backfill; may change before start |
| Existing started, persisted identity | Session plus matching runtime | Resume exactly |
| Existing started, runtime identity only | Runtime thread/assembly | Backfill, then resume |
| Existing started, no recoverable identity | Unknown | Fail closed; do not resume by guess |
| Different environment requested after start | Operator choice | Create a new session in same workspace |

## Decisions

### One agent profile

Do not create safe and developer agent profiles. Confidence: high. Reopen only if they require different agent behavior, not merely different authority.

### Exact ID, derived label

Persist `environmentPresetId`; derive product labels. Confidence: high because the ID already owns resolution, fingerprints, job evidence, and replay.

### Developer workspace is the workspace-bound default

A session deliberately attached to a development workspace defaults to that workspace's developer environment. Safe sandbox remains available for restricted work and is the default only when there is no workspace. Confidence: high. Reopen only if Kestrel introduces a separate workspace-trust signal that must precede command execution.

### Freeze after start

A different environment creates a new session. Confidence: high for this repair. Reopen if continuity across authority changes justifies a dedicated atomic assembly-migration protocol.

### Recover from runtime truth

Hydrate legacy identity from exact runtime data, never labels or tool-list heuristics. Confidence: high.

### No automatic elevation

Task interpretation never grants host command authority. Confidence: high.

## Research and Prototypes

No prototype was needed. Existing code proves exact environment resolution, immutable profile registration, Job V2 evidence, session identity fields, and runtime identity persistence. The consequential discovery was that `RuntimeComposer` deliberately pins the existing assembly, disproving a simple in-place switch.

## Active Change Frontier

No product question blocks the design. Later planning can settle the exact chooser/command spelling and runtime projection shape without changing the authority model.

## Decision Map

- Status: not needed
- Path: none
- Destination: coherent TUI session environment contract
- Return condition: not applicable

## Best Next Move

Publish the change design, then plan the smallest coherent implementation slice across session creation, persistence, caller propagation, runtime projection, and product-language cleanup.
