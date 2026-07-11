# Proposed Prompt Decomposition

## Goal

Do not replace `reference-react` with a monolithic coding-agent prompt.

Instead, distribute coding-agent behavior across Kestrel-native layers so each step owns the decisions it is already architecturally responsible for.

## Route

### Purpose

Decide whether the turn is:

- conversational only
- read-only planning/exploration
- mutation-capable execution work

### Coding-specific instructions that belong here

- classify whether the user needs tooling at all
- classify minimum required tool class
- distinguish read-only repo exploration from mutation-bearing engineering work

### What should not belong here

- no repo exploration strategy
- no implementation planning
- no code quality doctrine
- no final reporting instructions

### Schema changes needed

Prefer additive route metadata such as:

- `taskSurface: "conversation" | "repo_read" | "repo_mutation" | "runtime_command"`

Keep `executionLane` and `requiredToolClasses` as the hard control outputs.

### Interaction with adjacent layers

Route should only constrain the lane and tool-class floor. Extractor should decide the engineering task shape.

## Extractor

### Purpose

Turn the user request into structured engineering intent.

### Coding-specific instructions that belong here

- infer task kind such as inspect, implement, review, validate, run, debug
- infer repo scope and workspace targets when available from the user turn
- infer mutation intent: read-only vs edit vs command execution
- infer verification intent: tests, lint, build, smoke check, or none stated
- infer host-shell vs sandbox preference
- keep explicit structured command capture when the user gave a command
- request clarification only when the engineering objective is actually ambiguous

### What should not belong here

- no tool batching strategy
- no convergence judgment
- no finalization behavior
- no repair of malformed tool payloads

### Structured outputs or schema changes

Extend extracted tool intent with fields such as:

- `taskKind`
- `repoScope`
- `mutationIntent`
- `verificationIntent`
- `workspaceTargets`
- `hostWorkflowKind`

### Interaction with adjacent layers

Extractor should tell planner what kind of engineering task this is. Planner then decides whether intent is concrete enough to promote directly.

## Planner

### Purpose

Promote clear extracted engineering intent into concrete execution or a narrowed `resolve_tool`.

### Coding-specific instructions that belong here

- prefer repo exploration actions before mutation when the target is not yet grounded
- prefer search/list before deep file reads when the scope is broad
- promote explicit write/run requests when the extractor provided enough structure
- create a durable work-plan artifact for multi-step engineering work
- convert explicit host workflows to `dev.shell.*` when appropriate
- keep fixed-tool cases pinned and send only payload repair to resolver

### What should not belong here

- no open-ended reasoning about whether the task is done
- no broad final answer drafting
- no tool schema repair beyond simple direct promotion

### Structured outputs or schema changes

Add or persist a work artifact such as:

- `react.workPlan`
- checklist entries with status
- optional `verificationPlan`

### Interaction with adjacent layers

Planner should give thinker less to invent by promoting obvious coding actions and by seeding a durable plan state.

## Thinker

### Purpose

Choose one next engineering action when planning cannot be directly promoted.

### Coding-specific instructions that belong here

- use repo-aware exploration hierarchy
- prefer information-gathering over mutation when scope is unclear
- prefer the cheapest action that meaningfully reduces uncertainty
- respect non-destructive change discipline
- encode whether the next step is exploration, implementation, validation, or blocker surfacing
- when repeating an engineering action, name the concrete new evidence expected

### What should not belong here

- no `ask_user`
- no final-report formatting rules beyond action payload shape
- no schema repair for a pinned tool

### Structured outputs or schema changes

Extend verification payload with coding-specific fields:

- `verificationSteps`
- `expectedRepoDelta`
- `blockedBy`

### Interaction with adjacent layers

Thinker should produce one actionable next step. Resolver repairs payloads; observer judges convergence later.

## Resolver

### Purpose

Translate a narrowed engineering intent into a schema-valid concrete tool call.

### Coding-specific instructions that belong here

- keep pinned tool fixed
- repair payloads without re-deciding the task
- ensure command/file/code payloads satisfy tool schemas
- preserve coding-specific constraints such as required language or workspace root

### What should not belong here

- no task reprioritization
- no plan updates
- no convergence logic
- no final answer logic

### Structured outputs or schema changes

No major conceptual change beyond supporting richer coding intent hints.

### Interaction with adjacent layers

Resolver should stay narrow. It is a payload repair/compiler step, not a second thinker.

## Execution controller

### Purpose

Execute compiled actions under mode, autonomy, approval, and runtime safety rules.

### Coding-specific instructions that belong here

At the prompt layer, almost none. This layer should stay mostly mechanical.

At the policy/runtime layer:

- enforce plan/read-only vs mutation boundaries
- require approval/autonomy escalation where needed
- preserve explicit waits and resumptions
- retain dedupe and settle-on-ack behavior for safe mutation tools

### What should not belong here

- no broad coding strategy
- no model-side repo doctrine

### Structured outputs or schema changes

Potentially persist more coding execution evidence:

- command settlement markers
- validation outcome summaries
- repo delta summaries if later added by tools

### Interaction with adjacent layers

Execution should enforce the rules that prompts can only encourage.

## Observer

### Purpose

Judge whether the engineering task should continue, change course, or finalize.

### Coding-specific instructions that belong here

- decide whether the requested code change is actually implemented
- decide whether required verification is complete
- distinguish blocked vs deferred vs done
- avoid repeated low-yield edit/validate loops without concrete remediation evidence
- prefer finalize only when implementation state and verification state justify it
- allow partial finalize only with explicit blockers and residual risk

### What should not belong here

- no initial task classification
- no payload repair
- no raw tool legality decisions already enforced by runtime

### Structured outputs or schema changes

Observer should consume and possibly require:

- work-plan status
- validation results
- coding verification fields
- blocker fields

### Interaction with adjacent layers

Observer is the main place where a serious coding agent differs from a research agent. It should read the engineering work state and decide convergence accordingly.

## Final answer and reporting layer

### Purpose

Emit a concise operator-readable engineering result.

### Coding-specific instructions that belong here

- summarize what changed
- report what was verified
- state blockers and residual risks
- distinguish implemented vs blocked vs not verified

### What should not belong here

- no reasoning loop control
- no tool selection logic

### Structured outputs or schema changes

For coding-shaped turns, recommend a final payload structure with fields such as:

- `summary`
- `changedFiles`
- `checksRun`
- `checksFailed`
- `blockers`
- `residualRisks`

### Interaction with adjacent layers

Observer and finalization should work together: observer decides whether finalize is allowed; final reporting determines how the outcome is communicated.

## Capability manifest and tool metadata

### Purpose

Expose tool suitability to the model and runtime.

### Coding-specific instructions that belong here

Not prompt text. This should be encoded as metadata.

Useful additions:

- exploration suitability
- mutation risk
- validation suitability
- host-environment requirement
- persistent-session requirement

### What should not belong here

- no task-specific strategy prose

### Structured outputs or schema changes

Potential metadata additions:

- `codingRole`
- `mutationRisk`
- `requiresRepoContext`
- `bestFor`

### Interaction with adjacent layers

Extractor, planner, thinker, and observer can all reason better if tool metadata says more than execution class.

## Runtime policy and interaction model

### Purpose

Keep the hard safety model explicit.

### Coding-specific instructions that belong here

- `plan` remains read-only
- `act.safe` remains sandboxed plus read-only
- `act.full_auto` remains the only path for external side effects unless policy overrides allow otherwise
- coding-specific expectations should be tied to those modes, not replace them

### What should not belong here

- no task-specific prompt prose
- no heuristics for code quality

### Structured outputs or schema changes

Potentially support coding-specific policy toggles later, but keep the current mode model intact.

### Interaction with adjacent layers

Policy should enforce the boundaries that coding prompts rely on.

## New step or artifact

No new major step is required.

The smallest Kestrel-native change is to add a durable work artifact, not a new free-form coding loop. A `react.workPlan` or equivalent is the highest-value addition without breaking the current architecture.
