# Coding-Agent Lessons Map

This maps stronger coding-agent lessons onto the current `reference-react` design and separates what is enforced by runtime, encouraged by prompts, implied by surrounding product surfaces, or absent.

## Already present

### Explicit multi-step decomposition

Present and enforced.

- State graph is explicit in [graph.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/graph.ts).
- Registration and step contracts are enforced in [register.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/register.ts).

This is better than a monolithic agent loop for inspectability and replay.

### Typed action compilation before execution

Present and enforced.

- Decision envelopes and schemas: [DecisionEnvelope.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/DecisionEnvelope.ts)
- Ingest/canonicalization: [DecisionIngestPipeline.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/DecisionIngestPipeline.ts)
- Schema and policy validation: [compileIntent.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/compileIntent.ts)

This is one of the strongest parts of the design.

### Controlled execution with explicit waiting and approval

Present and enforced.

- Execution substates: [execStates.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/execStates.ts)
- Approval and autonomy gating: [acter.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/acter.ts), [src/governance/autonomy.ts](https://github.com/LumiCorp/kestrel/blob/main/src/governance/autonomy.ts), [src/mode/contracts.ts](https://github.com/LumiCorp/kestrel/blob/main/src/mode/contracts.ts)

### Read-only dedupe and anti-repeat mechanics

Present and enforced.

- Read-only reuse and dedupe in `acter`
- repeated-action verification requirements in [DecisionPolicyV2.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/policy/DecisionPolicyV2.ts) and [compileIntent.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/compileIntent.ts)

### Replayability and operator evidence

Present and enforced at runtime.

- repo-level architecture and reliability docs: [ARCHITECTURE.md](https://github.com/LumiCorp/kestrel/blob/main/ARCHITECTURE.md), [RELIABILITY.md](https://github.com/LumiCorp/kestrel/blob/main/RELIABILITY.md)
- finalization and replay normalization live in runtime and engine layers

## Partially present

### Autonomous end-to-end execution

Partially present in runtime and policy, but not strongly specialized for coding.

- The agent can continue through route, planning, execution, observation, and finalize without user intervention.
- `acter` can execute tools autonomously within mode and approval constraints.
- But the coding-specific completion model is weak. The agent knows how to continue, not how to finish engineering work well.

Evidence:

- [acter.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/acter.ts)
- [observer.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/observer.ts)

### Strong tool preferences and hierarchy

Partially present.

- Extractor can express `executionPreference`, `command`, and `commandMode`.
- Planner promotes some host-shell workflows to `dev.shell.exec` and some code tasks to `code.execute`.
- Tool metadata is explicit.

But there is no general coding exploration hierarchy like list/search before read, or workspace inspection before mutation.

Evidence:

- [extractor.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/extractor.ts)
- [planner.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/planner.ts)
- [tools/catalog.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/catalog.ts)

### Plan lifecycle

Partially present.

- `plan.intent` and `plan.successCriteria` exist in thinker and observer envelopes.
- Planner may also persist a simple `react.plan`.

But there is no durable implementation checklist, reconciliation status, or completed/blocked/deferred lifecycle for coding tasks.

Evidence:

- [DecisionEnvelope.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/DecisionEnvelope.ts)
- [thinker.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/thinker.ts)
- [observer.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/observer.ts)

### Completion discipline

Partially present.

- Finalization is explicit and mechanically separate.
- Observer uses convergence and verification fields.

But completion is mostly framed as “enough evidence to answer” or “stop retrying”, not “implementation finished and verified”.

Evidence:

- [observer.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/observer.ts)
- [tools/runtime/finalizeAnswer.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/runtime/finalizeAnswer.ts)

## Present in runtime but missing in prompt

### Coding-capable tool surface

Runtime-present, prompt-underexpressed.

- CLI profiles expose filesystem, `code.execute`, and `dev.shell.*` by default: [cli/config/ProfileStore.ts](https://github.com/LumiCorp/kestrel/blob/main/cli/config/ProfileStore.ts)
- Runtime injects the active allowlist into thinker/capability providers: [cli/runtime/KestrelChatRuntime.ts](https://github.com/LumiCorp/kestrel/blob/main/cli/runtime/KestrelChatRuntime.ts)

But step prompts still mostly read as generic decision prompts, not as coding prompts.

### Mode, approval, and autonomy boundaries

Runtime-present, prompt-light.

- Execution legality is enforced in runtime.
- Prompts mention some restrictions, but the strong semantics live below the prompt layer.

Evidence:

- [src/mode/contracts.ts](https://github.com/LumiCorp/kestrel/blob/main/src/mode/contracts.ts)
- [src/governance/autonomy.ts](https://github.com/LumiCorp/kestrel/blob/main/src/governance/autonomy.ts)
- [acter.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/acter.ts)

### Finalization and replay guarantees

Runtime-present, prompt-light.

- `exec.finalize` is contract-enforced.
- `react.completed` emission is required.

Evidence:

- [register.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/register.ts)
- [tools/runtime/finalizeAnswer.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/runtime/finalizeAnswer.ts)

## Present in prompt but weakly enforced

### Host-shell vs sandbox hints

Prompt-present, weakly enforced.

- Extractor prompt explicitly mentions `host_shell` vs `sandbox_snippet`.
- Planner uses that information when promotion is concrete.

But there is no stronger contract requiring structured coding-task classification, workspace targeting, or validation intent.

Evidence:

- [extractor.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/extractor.ts)
- [planner.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/planner.ts)

### Anti-repeat behavior

Prompt-present and partially enforced.

- Thinker and observer prompts discuss repetition, evidence delta, and retries.
- Compiler enforces some repeated-action verification semantics.

This is strong for research churn, weaker for engineering churn like repeated lint/test/edit loops.

Evidence:

- [thinker.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/thinker.ts)
- [observer.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/observer.ts)
- [compileIntent.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/compileIntent.ts)

### Filesystem completion semantics

Prompt-present and tested, but narrow.

- Silent filesystem mutation completion rule exists and is tested.
- This is good, but it only covers one narrow coding-related behavior.

Evidence:

- [filesystem.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/prompt/filesystem.ts)
- [tests/unit/reference-react-prompt-rules.test.ts](https://github.com/LumiCorp/kestrel/blob/main/tests/unit/reference-react-prompt-rules.test.ts)

## Absent

### Dirty worktree discipline

Absent.

There is no step prompt, decision schema, or runtime contract that tells the agent to inspect or preserve a dirty repo state before making changes.

### Non-destructive edit doctrine

Absent.

No layer tells the agent to avoid destructive changes, preserve unrelated edits, or prefer reversible changes during coding work.

### Explicit validation expectations

Absent.

There is no coding-specific contract that says implementation is not complete until relevant tests, build checks, or validation commands have run or been explicitly skipped.

### Durable plan reconciliation

Absent.

`plan.intent` is not a durable coding work artifact. There is no checklist, no status ledger, and no required reconciliation against the requested task before finalize.

### Repo exploration hierarchy

Absent.

The agent has filesystem and shell tools, but no explicit doctrine like:

- inspect workspace first
- batch search/list before reading many files
- prefer read/search over execution when grounding context
- avoid mutation until the target area is understood

### Review-mode findings contract

Absent.

There is no built-in review-specific output requirement such as findings-first, severity ordering, or file/line references.

### Coding-style final reporting

Absent.

The final output contract does not require changed files, checks run, failures, blockers, residual risk, or next actions.

### Code-quality or repo-safety policy

Absent.

There is no runtime-enforced policy for coding work comparable to the current research and dev-shell convergence rules.

## Summary

`reference-react` already has the architecture needed for a serious coding agent. What is missing is not primarily more runtime machinery. What is missing is a coding-specialized behavior layer distributed across prompts, schemas, observer logic, and final-report contracts.
