# TUI Execution Environment Selection Product Brief

## Product Narrative

Kestrel TUI users open local workspaces to implement, install, build, test, and validate software. Today the TUI silently resolves those sessions through `cli_safe_local`. That environment offers isolated code execution but no project shell. A normal development task can therefore report that Node, npm, or pnpm is unavailable even when those tools are installed on the user's machine.

The TUI also exposes internal environment preset IDs as though they were different agent profiles. Users must interpret names such as `cli_safe_local` and `cli_dev_local` even though both use the same Kestrel agent.

Kestrel must present one agent and a separate execution environment. An execution environment states where commands run and what workspace authority the session has.

A new local session bound to a workspace must default to **Developer workspace**. Kestrel can then use the governed project shell and the tools installed on that machine. A hosted workspace uses the same product concept through its hosted environment binding.

**Safe sandbox** remains an explicit restricted mode. It supports detached investigation, review of unfamiliar files without project execution, and isolated snippets or data transformations. It is not the normal environment for implementation, dependency installation, builds, tests, or workspace validation.

The selected environment must remain stable after the session starts. Kestrel must preserve that choice across turns, restart, session switching, background work, and resume. A user who chooses another environment after work starts must create a new session in that environment. Kestrel must not silently rewrite the active runtime assembly or infer greater authority from the task.

## Outcomes and Delivery Boundary

This initiative must produce these outcomes:

- Local workspace-bound TUI sessions default to Developer workspace.
- Detached TUI sessions default to Safe sandbox.
- Hosted workspaces use the Developer workspace product concept through `workspace_hosted` without changing hosted policy ownership.
- Normal TUI surfaces show **Agent: Kestrel** and **Environment: Developer workspace** or **Environment: Safe sandbox** as separate values.
- Users do not need to understand internal environment preset IDs to start or resume ordinary development work.
- The TUI persists one exact environment identity before the first turn.
- Every TUI-owned profile resolution carries the session's exact environment.
- A session's resolved execution profile and active runtime assembly agree on the environment.
- Started sessions retain their environment. A different environment starts a new session in the same workspace.
- Operator-launched background sessions inherit the parent session's environment.
- Model-delegated threads continue to inherit the parent runtime assembly.
- Existing started sessions recover missing environment identity from exact runtime evidence.
- Ambiguous or conflicting legacy identity fails closed instead of being guessed.
- Safe sandbox clearly identifies isolated scratch execution and does not claim to inspect the host workspace's installed tools.
- Raw preset, resolved-profile, fingerprint, and assembly IDs remain available in diagnostics and durable evidence.

The delivery boundary includes local TUI session creation, pre-start environment selection, session persistence, resume and switching, TUI profile resolution, operator-launched background work, MCP status and refresh, runtime identity projection, normal TUI labels, model-visible code-tool guidance, compatibility behavior, tests, and CLI documentation.

This initiative does not:

- Create separate safe and developer Kestrel agent profiles.
- Add Node, npm, pnpm, or a project mount to `code.execute`.
- Change the Docker sandbox's isolation contract.
- Change the development-shell runner or its approval policy.
- Change hosted Environment or Project policy.
- Change Desktop or web environment selection.
- Repair legacy Job V1 environment omission.
- Let a model, task classifier, failed command, or keyword rule increase session authority.
- Rebind the runtime tree of a started session to another environment.
- Copy active waits, runtime threads, assembly records, or execution history into a new environment boundary.

## Defining Scenarios

### A developer starts a local workspace session

The user selects a local workspace and starts a TUI session. The start journey shows Kestrel as the agent and Developer workspace as the selected environment. The confirmation states that Kestrel can run commands against the exact local workspace using tools installed on the machine.

The TUI persists `cli_dev_local` before the first turn. Local Core composes the canonical Kestrel profile with that environment. The runtime exposes the governed project shell. Kestrel can run the workspace's package manager, build, tests, and validation without the user selecting an internal profile.

The `/environment` command opens the environment chooser and identifies the current selection. `/environment developer` and `/environment safe` provide exact keyboard paths. The command palette exposes the same actions with product labels and consequence descriptions.

### A user deliberately chooses restricted execution

Before the first turn, the user selects Safe sandbox. The TUI explains that snippets run in isolated containers and that project commands and workspace package managers are unavailable.

The TUI persists `cli_safe_local`. Kestrel can inspect permitted files and use isolated code execution, but it cannot use the host project shell. The model-visible `code.execute` contract prevents Kestrel from describing the sandbox's installed programs as the host workspace's environment.

### A user starts a detached session

The user starts a session without a workspace. Safe sandbox is selected by default because no project exists for the development shell to target. The TUI persists the restricted environment before the first turn.

If the user later binds a workspace before work starts, the start journey applies the workspace-bound Developer workspace default unless the user explicitly keeps Safe sandbox.

### A user resumes a session

The TUI loads the session's exact persisted environment and asks Local Core to resolve that same environment. The runtime projection confirms the active thread's environment. The resolved profile, session record, and runtime assembly agree before the turn resumes.

Kestrel does not apply the current new-session default to an existing started session.

### A legacy started session has no persisted environment

The TUI reads the exact environment from the runtime thread or active assembly. It backfills the session record and resumes with the same authority.

If runtime identity is unavailable, the TUI shows **Environment unknown** and does not resume. If persisted and runtime identities conflict, the TUI reports a consistency failure. It does not infer identity from an assembly label, bundle ID, or tool list.

The existing `default-tmp-3` session therefore remains Safe sandbox because its runtime assembly records `cli_safe_local`. A new session in the same workspace uses Developer workspace by default.

### The user requests another environment after work starts

The TUI explains that the current environment belongs to the started session. It offers to create a new session with the same workspace and agent in the requested environment.

The current session, transcript, waits, threads, and runtime assembly remain unchanged. The new session receives a new environment-bound runtime identity before its first turn.

### Kestrel launches background work

An operator-launched background session inherits the parent session's exact environment. Local Core resolves that environment explicitly for the child session.

A model-delegated thread continues to inherit the parent's active runtime assembly. Neither path independently falls back to Safe sandbox or gains broader authority.

### A user or support engineer inspects status

Normal status, session lists, guided journeys, palette actions, and history messages show the product label. `/profiles` describes agent profiles and does not present environment presets as separate agents.

Verbose diagnostics and durable runtime evidence include the exact environment preset, resolved profile, fingerprint, and effective assembly identifiers needed for support and replay analysis.

## Business and Process Requirements

- Selecting a local workspace must select Developer workspace by default for a new session.
- Starting without a workspace must select Safe sandbox by default.
- Safe sandbox must remain available as a deliberate pre-start restriction for workspace-bound sessions.
- The start journey must state the selected environment and its command consequence before session creation.
- The environment must be changeable in place until the session starts.
- The environment must be immutable after the session starts or receives a runtime thread or assembly.
- A post-start environment change must create a new session. It must not mutate the existing runtime history.
- `/environment` must show the current environment and open the chooser.
- `/environment developer` and `/environment safe` must provide exact command paths for each choice.
- The command palette must expose the same choices with product labels and consequence descriptions.
- Independent workspace-bound sessions must apply their developer environment default even when seeded from recent session metadata.
- Operator-launched background sessions must inherit the parent environment.
- Resumed sessions must use their existing environment, not the current default for new sessions.
- A started legacy session must use exact runtime identity when its session record lacks environment identity.
- The product must block resume when a started session's environment is unknown or conflicts with runtime evidence.
- Normal UI must use Developer workspace and Safe sandbox consistently.
- Normal UI must not require raw preset IDs for environment selection, status, or recovery.
- Safe sandbox guidance must state that project commands, builds, tests, dependency installation, and host package managers are unavailable.
- Developer workspace guidance must state the exact target workspace and that commands use tools installed in that environment.
- A failed sandbox command must not trigger an automatic retry or migration to Developer workspace.
- The TUI must give the user a direct recovery path from an old Safe sandbox session to a new Developer workspace session in the same workspace.

## Technology Requirements

### Environment identity and composition

- `environmentPresetId` must remain the stable authority value for profile resolution, fingerprints, replay, validation, and diagnostics.
- The TUI must derive product labels from one exhaustive mapping. It must not persist display text as authority.
- `cli_dev_local` must map to local Developer workspace.
- `workspace_hosted` must map to hosted Developer workspace wherever shared identity is presented.
- `cli_safe_local` must map to Safe sandbox.
- Local Core must remain the only component that composes the canonical Kestrel profile with an environment binding.
- The TUI must not construct capability packs, tool allowlists, or approval policy.
- Resolved execution profile identity must continue to include the exact environment and fingerprint.

### Session state and callers

- TUI session creation must populate the existing environment and resolved-runtime identity fields on `TuiSessionMeta`.
- `SessionStore` must validate and preserve all declared agent, environment, capability-pack, and effective-assembly identity fields.
- Normal turns, replies, blocked-run resume, MCP status and refresh, operator-launched background work, and TUI capability preflight must pass the session's exact environment to Local Core.
- TUI callers must not rely on Local Core's omitted-value safe fallback for a workspace-bound session.
- Session switching must restore the selected session's environment with its authoring profile and workspace.
- Background TUI sessions must persist the inherited environment before execution starts.

### Runtime identity and session lifetime

- `OperatorAssemblySummary` must expose the exact `environmentPresetId` from the active thread or assembly.
- The protocol parser must validate the projected value as a supported environment preset.
- Legacy hydration must consume that exact field. It must not parse human labels, bundle identifiers, paths, or tool names.
- Resume must compare persisted and runtime environment identity before starting another turn.
- Missing or conflicting identity for a started session must produce a stable, user-visible failure and diagnostic evidence.
- Runtime assembly composition must continue to preserve the existing active assembly for a started session.
- This initiative must not add an automatic profile-mismatch migration at turn start.
- Creating a session in another environment must create a new runtime boundary rather than reuse the old thread tree.

### Tool contracts and authority

- `code.execute` must describe a fresh isolated scratch container with staged inputs and no selected project workspace.
- `code.execute` must state that its installed programs do not represent host or hosted workspace tools.
- `dev.shell.run` must remain the operation for project installs, builds, tests, inspections, and smoke checks.
- Environment selection must not bypass the active execution approval policy.
- Model output, task wording, command failure, and heuristic classification must never increase environment authority.

### Compatibility, diagnostics, and verification

- Existing session-file versions must remain readable.
- Unstarted legacy sessions must materialize the new default from workspace binding: Developer workspace when bound and Safe sandbox when detached.
- Started legacy sessions must preserve their recorded runtime authority even when it differs from the new-session default.
- Compatibility hydration may be removed only after every supported started session persists exact environment identity and runtime identity remains available for consistency checks.
- Normal UI must hide raw environment IDs. Verbose diagnostics and durable evidence must retain them.
- Focused verification must prove the default, explicit restricted selection, persistence, resume, background inheritance, legacy hydration, mismatch failure, caller propagation, and product labels.
- A workspace-bound acceptance scenario must prove that Kestrel can observe and use the workspace's installed Node, npm, and pnpm through the development shell.
- A Safe sandbox acceptance scenario must prove that the development shell is unavailable and that Kestrel describes the restriction accurately.
- Command tests must prove `/environment`, `/environment developer`, `/environment safe`, and their command-palette actions.
- Protocol and session tests must prove that `OperatorAssemblySummary.environmentPresetId` hydrates exact legacy session identity.
- Delivery must pass `pnpm validate` before it is considered ready.

## People and Operating Requirements

- The TUI user owns the pre-start choice between Developer workspace and Safe sandbox.
- The product owns the workspace-bound Developer workspace default. Users must not need to configure or author an economics, capability, or execution profile for ordinary development.
- The model cannot choose, infer, or widen the environment.
- Local Core owns composition of agent policy and environment authority.
- The runtime owns durable assembly and environment evidence for started sessions.
- Support engineers must be able to inspect exact environment, resolved-profile, fingerprint, and assembly identity without exposing those IDs in ordinary user flows.
- User-facing help must explain when to use Safe sandbox and why it cannot validate a workspace.
- User-facing help must explain that local and hosted Developer workspace are placements of the same product environment, with different policy owners.
- Recovery guidance for an old Safe sandbox session must direct the user to a new Developer workspace session instead of suggesting that npm or pnpm is missing from the machine.
- No new administrator workflow, global trust list, or profile-authoring responsibility is introduced.

## Success and Readiness

This Product Brief is **Ready for issue creation**.

Delivery is successful when all of the following are observable:

- A new local workspace-bound TUI session starts with Developer workspace without requiring a profile choice.
- The session receives `dev.shell.run` through Local Core's existing `cli_dev_local` binding.
- Kestrel can run the workspace's package manager and validation commands when policy permits them.
- A new detached session starts with Safe sandbox.
- A workspace-bound user can deliberately choose Safe sandbox before the first turn.
- Restart, switching, resume, MCP inspection, and operator-launched background work retain the exact session environment.
- A started legacy session resumes with its exact runtime environment or fails closed when identity cannot be established.
- Changing the environment after start creates a new session and leaves the old runtime evidence unchanged.
- Standard TUI output contains the product labels rather than `cli_safe_local`, `cli_dev_local`, or `workspace_hosted`.
- Verbose diagnostics retain the exact identifiers needed to explain the effective environment.
- Safe sandbox never reports its container tools as proof of the selected workspace's installed tools.
- The repository's required validation gate passes.

No unresolved product, architecture, or ownership decision blocks issue creation. The brief fixes the user command as `/environment` and the runtime hydration field as `OperatorAssemblySummary.environmentPresetId`, so issue authors do not need to invent either behavior or structure.

## Source Artifacts

- [TUI Execution Environment Selection Change Design](../design/tui-execution-environment-selection-change-design.md)
- [TUI Execution Environment Selection Design Notebook](../../.design/tui-execution-environment-selection/notebook.md)
