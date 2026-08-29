# TUI Execution Environment Selection Change Design

## Executive Summary

Keep one Kestrel agent profile and make its command environment an explicit, plain-language session choice: **Developer workspace** or **Safe sandbox**.

New local TUI sessions bound to a workspace default to Developer workspace, which exposes the existing governed host-shell tools and therefore the workspace's installed Node, npm, and pnpm. Safe sandbox is an explicit restricted mode, and remains the default only for detached sessions with no workspace. The TUI persists the exact existing `environmentPresetId` and passes it through every session-owned profile resolution.

Hosted execution uses the same product concept: `workspace_hosted` is the hosted Developer workspace binding, while `cli_dev_local` is the local-host binding.

Safe sandbox remains useful for detached investigation, reviewing unfamiliar files without executing project code, and isolated snippets or data transformations. It is not the normal environment for implementation, dependency installation, builds, tests, or workspace validation.

The environment becomes immutable once a session starts. Choosing another environment then creates a new session in the same workspace. This boundary is deliberate: existing runtime threads pin their active assembly, and child threads inherit it. An in-place switch would be an authority migration across a runtime tree, not a preference change.

This repairs the component that first made the observed behavior wrong. The TUI omitted its environment choice, Local Core correctly applied the safe default, and `default-tmp-3` received isolated `code.execute` rather than workspace-bound `dev.shell.run`. The design does not add package managers to the sandbox or infer greater authority from task wording.

## Requested Outcome

A local TUI user should be able to answer two separate questions without understanding Kestrel's internal preset system:

- Which agent am I using? **Kestrel**.
- Where can it run commands? **Developer workspace** or **Safe sandbox**.

The desired behavior is:

- New workspace-bound sessions explicitly record Developer workspace by default.
- The session creation journey states that commands will run against the selected workspace and offers Safe sandbox as a restricted choice.
- Safe sandbox states that code runs in isolated scratch containers, not in the project shell.
- The chosen environment is stable across turns, restart, session switching, and resume.
- Operator-launched child sessions inherit the parent's environment; independent workspace sessions default to their developer binding.
- Normal UI uses human labels. Exact preset IDs remain in persisted evidence and verbose diagnostics.
- Existing started sessions recover their environment from runtime truth rather than being guessed or silently changed.
- A model, failed command, or task classifier cannot elevate a session from sandbox to host workspace.

## Relevant Current Behavior

### The domain split already exists

Kestrel already has one canonical agent policy and separate environment presets. `cli_safe_local` composes the balanced, filesystem, and sandbox-code capability packs; `cli_dev_local` replaces sandbox-code with the development shell ([`runtimeProfile.ts`](../../src/profile/runtimeProfile.ts#L80)). CLI omission defaults to the safe preset ([`runtimeProfile.ts`](../../src/profile/runtimeProfile.ts#L94)).

Local Core accepts an optional CLI `environmentPresetId`, and omission becomes `cli_safe_local` ([`contracts.ts`](../../src/localCore/contracts.ts#L99), [`profileProvider.ts`](../../src/localCore/profileProvider.ts#L120)). It then registers an immutable resolved profile whose ID and fingerprint include the selected environment ([`profileProvider.ts`](../../src/localCore/profileProvider.ts#L163), [`executionProfileRegistry.ts`](../../src/localCore/executionProfileRegistry.ts#L65)). That is the correct internal authority contract.

### The TUI loses the environment choice

A normal TUI turn resolves the active profile with `client: "cli"` and the authoring profile ID, but omits the environment ([`TuiRunController.ts`](../../cli/app/TuiRunController.ts#L339)). Operator-launched background sessions and MCP status/refresh repeat the same omission ([`App.ts`](../../cli/app/App.ts#L3084), [`App.ts`](../../cli/app/App.ts#L3521)).

The session type already declares `agentProfileId`, `environmentPresetId`, capability packs, and effective assembly identity ([`contracts.ts`](../../cli/contracts.ts#L374)). Both session constructors omit those fields ([`TuiBootstrap.ts`](../../cli/app/TuiBootstrap.ts#L743), [`App.ts`](../../cli/app/App.ts#L4335)). The file parser also reconstructs profile, workspace, mode, and status while dropping every agent/environment/assembly field ([`SessionStore.ts`](../../cli/session/SessionStore.ts#L220)).

This means the TUI has neither an explicit selection for new sessions nor durable identity for resumed ones.

### The two command surfaces have different contracts

`code.execute` is an isolated Docker operation ([`execute.ts`](../../tools/code/execute.ts#L20)). The executor stages declared inputs into a new tmpfs workspace, disables networking, mounts no project directory, and uses a language image such as `bash:5.2` with a staged `main.sh` ([`DockerSandboxExecutor.ts`](../../src/code/DockerSandboxExecutor.ts#L36), [`DockerSandboxExecutor.ts`](../../src/code/DockerSandboxExecutor.ts#L380)). Its tool availability says nothing about programs installed on the user's Mac or in the selected project.

`dev.shell.run` is the existing workspace operation for scaffolding, installs, builds, tests, inspections, and smoke checks ([`run.ts`](../../tools/devshell/run.ts#L20)). The runtime does not need a new shell tool; the TUI needs to select the environment that already exposes it.

### Existing runtime assemblies prevent a preference-style switch

At each accepted turn, the runtime composes the thread assembly before execution ([`ThreadRuntime.ts`](../../src/orchestration/ThreadRuntime.ts#L762)). If an active assembly already exists, `RuntimeComposer` returns it unchanged at turn start except for one narrow legacy Desktop migration ([`RuntimeComposer.ts`](../../src/orchestration/RuntimeComposer.ts#L37)). New child threads inherit their parent's active bundle ([`RuntimeComposer.ts`](../../src/orchestration/RuntimeComposer.ts#L69)).

Therefore, resolving a developer profile and passing its immutable profile ID to an already-started safe session does not reliably change the tools active in that session. The persisted assembly remains the authority.

### Exact incident

`default-tmp-3` is bound to `/Users/gregasher/Projects/tmp` and stores the Kestrel authoring profile, but no environment identity. Its runtime history records the safe CLI assembly, `code.execute`, and no `dev.shell.run`. The agent ran Bash in the isolated container and reported that Node package managers were absent.

The first wrong component was the TUI selection flow. Local Core's safe default and the Docker executor behaved as specified. The agent's explanation was also wrong because the model-visible code-tool contract did not make the project-shell distinction strong enough.

Current Job V2 does not share this gap: it requires an exact environment and binds it into preflight evidence. A legacy Job V1 omission exists nearby, but it is outside this TUI change.

## Affected Surface

| Surface | Current responsibility | Proposed responsibility |
| --- | --- | --- |
| Guided start | Choose title, workspace, profile, and mode | Also choose a plainly labeled execution environment before session creation |
| TUI session metadata | Store authoring profile and workspace | Preserve exact environment and resolved runtime identity already declared by the contract |
| Session resume | Restore authoring profile and transcript | Restore the exact environment; hydrate legacy identity from runtime truth |
| TUI profile resolution | Rely on Local Core's omitted-value default | Pass the active session's exact environment every time |
| Background task launch | Create a child TUI session that independently defaults safe | Inherit the parent session's exact environment |
| Runtime projection | Summarize an active assembly without exact environment identity | Expose exact runtime environment identity for legacy hydration and consistency checks |
| TUI presentation | Mix agent profiles, preset IDs, and assembly labels | Show Agent and Environment as separate product concepts |
| `code.execute` model contract | Say only that code runs in Docker | State that it is isolated scratch execution and not the project workspace shell |

Desktop, hosted workspaces, web profiles, the sandbox executor, the development-shell runner, and approval policy packs retain their current authority ownership.

## External Findings That Shaped the Design

VS Code opens unfamiliar folders in Restricted Mode, blocks terminal and task execution, and keeps the restricted state visible. This supports retaining an explicit restricted environment for unfamiliar code. Kestrel's primary TUI scenario is different: the user deliberately binds a session to a development workspace in order to build and validate it, so the workspace-bound default is Developer workspace. [VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust)

JetBrains presents consequence-oriented choices: preview in Safe Mode, trust the project, or do not open. Trusting explicitly enables initialization, plugins, dependencies, and full features. This supports describing capabilities and consequences rather than asking users to choose an internal policy name. [JetBrains Project Security](https://www.jetbrains.com/help/idea/project-security.html)

Kestrel's scope differs from both products: this design grants an environment to one session, not permanent trust to a folder. The TUI must state that narrower scope and must not borrow folder-trust language that overclaims persistence.

Inquirer's choice contract separates the internal returned `value` from the visible `name`, description, and post-selection text. Google's API guidance similarly separates stable identifiers from human-readable display names. Together they support retaining `cli_safe_local` and `cli_dev_local` as contract values while translating them at the UI boundary. [Inquirer Select choices](https://github.com/SBoudrias/Inquirer.js/blob/main/packages/select/README.md#choice-object), [Google AIP-148](https://google.aip.dev/148#other-names)

No external source establishes a universal rule that CLIs must hide internal execution IDs. The decision here follows Kestrel's existing separation of agent policy and environment authority and the observed user confusion.

## Options and Candidate Seams

### Add package managers to `code.execute`

This is the smallest apparent executor patch and the wrong seam. A Node-enabled container still would not be the selected workspace. Mounting the project would convert scratch execution into workspace authority and weaken the existing isolation boundary.

Rejected.

### Select one global CLI environment at launch

A flag or configuration default could pass one preset to all profile resolutions. It cannot keep authority stable for multiple resumable sessions, and relaunching the TUI with a different flag could silently change an old session.

This remains credible only as a future default for newly created sessions. It is rejected as the session authority owner.

### Persist a session environment and rebind active assemblies

This preserves one conversation while changing authority. It also requires a dedicated runtime transition: reject active and waiting work, replace the canonical thread's assembly, define behavior for every resumable descendant, protect operator-approved custom assemblies, record durable evidence, and commit TUI state only after runtime success.

The current assembly-proposal machinery proves that runtime changes can be recorded, but it does not make this a small preference update. The user request does not establish that cross-environment transcript continuity is worth this new authority-migration protocol.

Deferred, with a clear reopen condition.

### Select an environment before start and freeze it for the session

This uses the existing session fields and Local Core resolution contract. It gives each runtime tree one stable environment, preserves replay meaning, and keeps the elevation visible and operator-owned. A user who needs another environment after start creates a new session against the same workspace.

Chosen.

### Infer or automatically elevate when package managers are needed

Prompt keywords, a missing executable, a tool failure, or model judgment would become authority decisions. This conflicts with Kestrel's explicit execution boundary and would be heuristic policy behavior.

Rejected.

## Proposed Delta

### Product language and presentation mapping

Normal TUI surfaces display independent Agent and Environment fields. One exhaustive mapping owns local CLI environment language:

| Stable value | Display label | Display description |
| --- | --- | --- |
| `cli_dev_local` | Developer workspace | Commands run against the selected local workspace using tools installed on this machine, subject to the active execution policy. |
| `workspace_hosted` | Developer workspace (hosted) | Commands run against the selected hosted workspace under hosted environment policy. |
| `cli_safe_local` | Safe sandbox | Code snippets run in isolated containers. Project commands and workspace package managers are unavailable. |

The guided start journey, command palette, session list, status output, and relevant history messages use these labels. Assembly labels become forms such as `Kestrel on Developer workspace`, not `Kestrel One on cli:cli_dev_local`.

`/profiles` remains an agent-profile surface. It stops printing `preset=<raw-id>` as though environment bindings were additional agents. Raw values remain appropriate in persisted JSON, runtime events, validation errors, and verbose diagnostics.

### Session creation and lifetime

The guided start journey adds Environment after workspace selection and before confirmation. Developer workspace is selected by default when a local workspace is bound. Safe sandbox is selected by default only for a detached session. The confirmation shows the exact workspace path and a short consequence statement:

> Kestrel can run commands against this workspace using tools installed on this machine. This applies to this new session.

Choosing Safe sandbox deliberately removes workspace command execution from the new session. Cancel preserves the environment already selected in the journey.

The exact `environmentPresetId` is persisted on `TuiSessionMeta` before the first turn. The display label is always derived. An unstarted session can change its choice in place.

Once `started` is true or a runtime thread/assembly exists, the environment is frozen. A different choice offers to create a new session with the same workspace and agent profile. The new session does not inherit active waits, runtime threads, assembly records, or execution history across the authority boundary.

### Exact propagation

Every TUI-owned call that claims to resolve the active session's effective capabilities passes its exact `environmentPresetId` to Local Core:

- ordinary fresh turns
- replies and blocked-run resume
- MCP status and refresh
- operator-launched background work
- any profile preflight or status calculation added to the TUI

The TUI does not build capability packs or tool allowlists. Local Core remains the composition owner and returns the immutable resolved profile.

Operator-launched background sessions inherit the parent's environment because the operator starts them inside the current session boundary. Model-delegated threads continue inheriting the parent's assembly. Independent workspace-bound sessions, including starts seeded from recent metadata, default to their developer binding. Detached sessions default to Safe sandbox.

### Legacy hydration and consistency

`SessionStore` preserves the environment and assembly fields already declared by `TuiSessionMeta`.

For a started legacy session without persisted environment identity, runtime state is authoritative. The session projection exposes the exact `environmentPresetId` from the thread/active assembly so the TUI can backfill it. The TUI never parses the assembly label or bundle ID and never classifies the tool allowlist.

If a started legacy session has no persisted identity and no recoverable runtime identity, the TUI reports **Environment unknown** and refuses to resume under a guessed profile. This is fail-closed behavior, not a migration default. An unstarted legacy session has no prior runtime authority and uses the new default: Developer workspace when workspace-bound, Safe sandbox when detached.

The TUI compares persisted and runtime environment identity on resume. A mismatch is a consistency failure that must be surfaced; neither side silently wins and no automatic assembly change occurs.

For `default-tmp-3`, the runtime identity is `cli_safe_local`. It remains a Safe sandbox session. The immediate product path to npm and pnpm is a new Developer workspace session in `/Users/gregasher/Projects/tmp`.

### Model-visible tool distinction

The `code.execute` description explicitly says:

- execution occurs in a fresh isolated scratch container
- declared files are staged inputs, not the selected project workspace
- host-installed tools and project package managers are not implied
- the tool must not be used to report what is installed in the host workspace

`dev.shell.run` continues to own project installs, builds, tests, inspections, and smoke checks. This supporting contract change prevents the observed explanation from recurring when Safe sandbox is intentionally selected.

## Transition and Coexistence

| State | Source of truth | Result |
| --- | --- | --- |
| New local workspace session | Developer workspace default | Persist `cli_dev_local` before first turn |
| New hosted workspace session | Hosted developer binding | Persist `workspace_hosted` before first turn |
| New detached session | Safe sandbox default | Persist restricted environment before first turn |
| Existing unstarted session with no environment | Default from workspace binding | Materialize exact default; allow pre-start change |
| Existing started session with persisted identity | Session and matching runtime identity | Resume exactly |
| Existing started session with runtime identity only | Runtime thread/assembly | Backfill exact identity, then resume |
| Existing started session with neither identity | None | Show Environment unknown and fail closed |
| Existing started session with identity mismatch | Conflicting evidence | Surface consistency error; do not guess or rebind |
| User requests a different environment after start | New positive choice | Create a new session in the same workspace |

The session fields are already optional, so old files remain structurally readable. The compatibility hydration can be removed only when every supported started session persists exact environment identity and the runtime projection is universally available for audit and consistency checking.

## Decisions

### One agent, separate environment

Do not create safe and developer Kestrel profiles. The agent policy is stable; only execution authority changes. This directly addresses the confusing profile list.

Confidence is high. Reopen only if environments need different agent behavior rather than different tools and authority.

### Persist the stable preset ID and derive the label

Use the existing `environmentPresetId` as durable authority. It already participates in profile resolution, registry identity, fingerprints, Job V2 evidence, and replay. Adding a second product enum would duplicate the same distinction and introduce another mapping contract.

Confidence is high. Reopen if one product environment must select among multiple presets through an independent trusted policy.

### Developer workspace is the workspace-bound default

Choosing a workspace is the defining context for normal development work. The session should be able to install, build, test, and inspect that workspace without requiring the user to understand an internal execution preset. Safe sandbox remains an explicit restricted option and the detached-session default.

Confidence is high. Reopen if Kestrel later adds a separate workspace-trust decision that must occur before workspace command execution.

### Freeze the environment after start

A different environment creates a new session. Existing runtime assemblies and child inheritance make an in-place change a dedicated migration feature. Stable authority per session produces clearer audit and replay semantics.

Confidence is high for this repair. Reopen if users demonstrate that preserving one transcript across environment changes is materially more important than the runtime migration and atomicity cost.

### Runtime truth hydrates legacy sessions

A started session may already have developer authority even if the TUI parser discarded its identity fields. Recover the exact value from runtime records; never infer from labels, IDs, or tools, and never default an ambiguous started session.

Confidence is high. Reopen only if supported legacy runtimes cannot project their exact environment identity.

### No heuristic or model-selected elevation

Package-manager intent does not grant host command access. A failed sandbox call does not trigger automatic retry in Developer workspace. The operator remains the authority owner.

Confidence is high and follows Kestrel's existing execution-boundary rules.

## Research and Prototype Findings

No prototype was required. The repository already establishes that:

- Local Core accepts exact CLI environment selection.
- The execution-profile registry produces immutable environment-bound identities.
- Job V2 already carries and evidences the exact preset.
- TUI session metadata already declares the required identity fields.
- Runtime thread and assembly records already persist environment identity.

The decisive code finding was that `RuntimeComposer` intentionally retains an existing thread assembly. That disproved a simple in-place TUI switch and moved the design to an immutable-per-started-session boundary.

## Remaining Design Questions

No product or authority question blocks this design.

Two implementation details remain for planning:

- the exact slash-command spelling and chooser layout for starting another environment
- whether exact runtime environment identity is added directly to `OperatorAssemblySummary` or to a sibling runtime-identity projection

Both choices must preserve the design invariants: exact values, no inference, no silent rebind, and one visible environment per started session.
