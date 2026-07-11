# Improvement Plan

## Priority 1: Add coding-specialized prompt decomposition

### Problem

Current step prompts are mostly generic decision prompts plus research-heavy observer guidance.

### Why it matters

The runtime already has the architecture and tools needed for coding work. The main missing layer is behavioral doctrine distributed across the existing steps.

### Where it should live

- extractor
- planner
- thinker
- observer
- final reporting guidance

### Work type

Prompt work, with some schema alignment.

### Likely files

- [agents/reference-react/src/steps/extractor.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/extractor.ts)
- [agents/reference-react/src/steps/planner.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/planner.ts)
- [agents/reference-react/src/steps/thinker.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/thinker.ts)
- [agents/reference-react/src/steps/observer.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/observer.ts)
- [agents/reference-react/src/prompt/DecisionPromptTemplate.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/prompt/DecisionPromptTemplate.ts)

### Implementation sketch

- keep the current step graph
- add coding-specific rules to the existing steps instead of creating a monolithic prompt
- encode repo exploration ordering, non-destructive behavior, validation expectations, and clear completion/blocker language in the step where each decision belongs

### Risks and tradeoffs

- risk of overloading prompts with too much cross-step responsibility
- risk of reintroducing heuristics if coding behavior is expressed vaguely

### Validation

- prompt-suite cases for repo exploration ordering
- prompt-suite cases for validation-before-finalize
- prompt-suite cases for blocked vs done reporting

## Priority 2: Extend tool-intent and decision contracts for coding work

### Problem

Current extracted tool intent is useful but too thin for engineering tasks.

### Why it matters

Coding work needs explicit structured fields for mutation, validation, workspace scope, and workflow type.

### Where it should live

- extractor schema
- tool intent context
- decision envelope verification fields

### Work type

Schema and step-logic work.

### Likely files

- [agents/reference-react/src/steps/extractor.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/extractor.ts)
- [agents/reference-react/src/toolIntent.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/toolIntent.ts)
- [agents/reference-react/src/types.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/types.ts)
- [agents/reference-react/src/decision/DecisionEnvelope.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/DecisionEnvelope.ts)
- [agents/reference-react/src/decision/compileIntent.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/compileIntent.ts)

### Implementation sketch

- add extracted coding fields such as `taskKind`, `repoScope`, `mutationIntent`, `verificationIntent`, `workspaceTargets`, `hostWorkflowKind`
- add decision verification fields such as `verificationSteps`, `expectedRepoDelta`, `blockedBy`
- keep compatibility by making rollout additive and versioned

### Risks and tradeoffs

- schema growth can make prompts brittle if too many new fields are required at once
- additive rollout is safer than a single hard cutover

### Validation

- unit tests for extractor parsing
- planner/resolver tests for coding-intent promotion
- schema compatibility tests

## Priority 3: Add a durable coding work artifact

### Problem

`plan.intent` and `successCriteria` are not enough for implementation workflows.

### Why it matters

A serious coding agent needs explicit progress and reconciliation, not just a transient plan summary.

### Where it should live

- react state
- planner
- thinker
- observer

### Work type

State and step-logic work.

### Likely files

- [agents/reference-react/src/types.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/types.ts)
- [agents/reference-react/src/steps/planner.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/planner.ts)
- [agents/reference-react/src/steps/thinker.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/thinker.ts)
- [agents/reference-react/src/steps/observer.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/observer.ts)
- [agents/reference-react/src/context/ContextBuilder.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/context/ContextBuilder.ts)

### Implementation sketch

- add `react.workPlan` with checklist items and states such as `pending`, `in_progress`, `done`, `blocked`, `skipped`
- planner seeds it
- observer reconciles it
- finalization can require either all required items done or an explicit blocker record

### Risks and tradeoffs

- too much rigidity can hurt simple tasks
- keep the artifact compact and optional for low-complexity turns

### Validation

- unit tests for work-plan persistence
- observer tests for reconciliation and finalize denial when required items remain open

## Priority 4: Strengthen observer and finalize contracts for engineering convergence

### Problem

Observer is stronger at research stall judgment than engineering completion judgment.

### Why it matters

This is the core gap between a general tool agent and a serious coding agent.

### Where it should live

- observer prompt
- compile-time observer validation
- finalize payload contract

### Work type

Prompt, schema, and step-logic work.

### Likely files

- [agents/reference-react/src/steps/observer.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/observer.ts)
- [agents/reference-react/src/decision/compileIntent.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/compileIntent.ts)
- [tools/runtime/finalizeAnswer.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/runtime/finalizeAnswer.ts)
- [cli/runner/finalizedOutput.ts](https://github.com/LumiCorp/kestrel/blob/main/cli/runner/finalizedOutput.ts)

### Implementation sketch

- add observer rules for:
  - implementation landed vs not landed
  - validation complete vs missing
  - blocked vs deferred vs done
- add coding finalize guidance with fields such as `summary`, `changedFiles`, `checksRun`, `checksFailed`, `blockers`, `residualRisks`
- keep `FinalizeAnswer` generic at the tool boundary but require richer shape from `reference-react` when the task is coding-shaped

### Risks and tradeoffs

- final payload requirements must not break chat/research turns
- coding-specific finalize shape should be conditional on task type

### Validation

- prompt-suite cases for coding summary shape
- observer unit tests for finalize refusal without verification
- integration tests for small edit plus explicit validation reporting

## Priority 5: Fix operator preset and skill-pack posture for coding tasks

### Problem

The runtime has a coding preset and a code skill pack, but the skill pack is underpowered for real repo work because it omits `dev.shell.*`.

### Why it matters

Many software tasks require host-shell workflows, persistent processes, and command-based validation.

### Where it should live

- skill-pack definitions
- operator preset alignment
- profile/tool allowlist composition

### Work type

Policy and product-surface work.

### Likely files

- [cli/runtime/skillPacks.ts](https://github.com/LumiCorp/kestrel/blob/main/cli/runtime/skillPacks.ts)
- [src/operatorShell.ts](https://github.com/LumiCorp/kestrel/blob/main/src/operatorShell.ts)
- [cli/config/ProfileStore.ts](https://github.com/LumiCorp/kestrel/blob/main/cli/config/ProfileStore.ts)

### Implementation sketch

- expand the code posture to allow `dev.shell.*` when the active profile already permits those tools
- keep skill-pack narrowing behavior, but do not narrow coding tasks away from the host-shell family
- align coding preset copy with actual coding behavior expectations

### Risks and tradeoffs

- broader coding posture increases side-effect potential
- must remain compatible with interaction mode and approval policies

### Validation

- tests for skill-pack allowlist narrowing
- tests for coding preset with host-shell allowed and blocked variants

## Recommendation on sequencing

Do the work in this order:

1. prompt decomposition
2. schema and contract extension
3. observer/finalize upgrade
4. durable work artifact
5. preset and skill-pack alignment

This order keeps the first gains high-leverage and low-risk while preserving the existing runtime-first architecture.
