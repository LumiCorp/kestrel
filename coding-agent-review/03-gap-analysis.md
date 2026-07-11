# Gap Analysis

## Bottom line

The gap is not “can `reference-react` call coding tools?” It can.

The gap is that it still behaves like a disciplined general tool agent, with most of its strongest convergence logic optimized for research retrieval and some dev-shell settlement, not for software engineering work inside a real repository.

## Autonomy

### Current state

Autonomy is structurally present.

- execution can proceed end-to-end
- mode gating exists
- autonomy policy exists
- approvals can be triggered automatically

Evidence:

- [acter.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/acter.ts)
- [src/governance/autonomy.ts](https://github.com/LumiCorp/kestrel/blob/main/src/governance/autonomy.ts)

### Gap

The autonomy model is generic, not coding-aware.

It knows when a tool class is allowed, but not when a coding task is sufficiently grounded to mutate code, when it should inspect repo state first, or when it should stop and report a blocker instead of continuing with low-confidence edits.

### Impact on coding tasks

For real engineering work, autonomy without coding-specific grounding rules can produce one of two failures:

- over-eagerness: mutate before sufficient repo inspection
- under-completion: stop after one partial action because the generic convergence model thinks enough happened

## Completion discipline

### Current state

Completion is explicit in the runtime.

- there is a real finalize step
- observer produces convergence
- finalization is a first-class state

### Gap

Completion discipline is still oriented toward “answerable” rather than “implemented and verified”.

There is no explicit contract that a coding task is complete only when:

- the requested change is implemented or explicitly blocked
- relevant verification has run or been consciously skipped
- residual risks are surfaced
- final output states done vs blocked vs deferred clearly

### Impact on coding tasks

The agent can finalize a coding task with a plausible message but without the work being engineering-complete. That is acceptable for research chat, but not for serious repo work.

## Codebase exploration patterns

### Current state

The runtime exposes good exploration tools:

- `fs.list`
- `fs.read_text`
- `fs.search_text`
- `code.execute`
- `dev.shell.*`

### Gap

There is no explicit repo exploration doctrine in the prompts or schemas.

The system does not currently encode high-value coding-agent habits such as:

- inspect workspace boundaries before changing files
- use search/list to map the area before reading files deeply
- batch context gathering rather than serial file thrash
- prefer repo truth over speculative reasoning

### Impact on coding tasks

Without an exploration hierarchy, the agent can take inefficient or risky paths:

- jump straight to a shell command
- read a single file in isolation and miss the surrounding contract
- overuse `code.execute` where static inspection would have been safer

## Tool hierarchy and batching

### Current state

Planner can directly promote some concrete intents and there is explicit `tool_batch` support.

### Gap

The hierarchy is only partial and mostly inferred from specific planner cases.

There is no coding-wide doctrine that says:

- prefer filesystem search/list before code execution
- prefer sandboxed inspection before host-shell mutation
- prefer host-shell only for workflows that truly need repo environment or persistent processes

### Impact on coding tasks

The agent has the tools, but not a strong preference stack. That reduces efficiency and increases the chance of unnecessary side effects.

## Planning and reconciliation

### Current state

Thinker and observer use `plan.intent` and `successCriteria`.

### Gap

This is not enough for engineering work.

Missing:

- a durable work artifact
- status per subtask
- explicit implementation vs verification tracking
- reconciliation against the original request before finalize

### Impact on coding tasks

Coding work often has multiple phases: inspect, edit, validate, summarize. A single lightweight plan object is too thin to prevent vague partial exits.

## Code quality and repo safety rules

### Current state

There are repo-level human instructions in [AGENTS.md](https://github.com/LumiCorp/kestrel/blob/main/AGENTS.md), but those are not encoded inside `reference-react` itself.

### Gap

The agent lacks built-in coding discipline such as:

- preserve unrelated changes
- keep changes small and reversible
- prefer non-destructive edits
- avoid heuristics in policy behavior
- report when validation could not run

### Impact on coding tasks

This is a major gap. The runtime can safely call tools, but it does not yet teach the model how to act like a careful repo engineer.

## Execution verification

### Current state

There is strong schema validation for tool inputs and some output-specific logic:

- dev-shell settlement rules
- code-artifact finalize guards
- repeated-action checks

### Gap

There is no generic code-change verification contract.

Missing:

- expectation to run relevant tests/lint/build checks
- expectation to compare repo state before/after
- expectation to explicitly state which validation was attempted and what failed

### Impact on coding tasks

The agent may make a change and then finalize without verification, or with only partial verification, because the runtime does not yet define that as incomplete.

## Observer convergence for engineering tasks

### Current state

Observer is sophisticated, but its strongest examples and heuristics are research-oriented.

Evidence:

- low-signal research recovery
- web retrieval repetition
- news/tool-unavailable partial finalize
- dev-shell settlement

### Gap

Observer does not yet have an engineering-specific convergence model.

It does not explicitly judge:

- whether the intended code change landed
- whether targeted files were updated coherently
- whether validation results are sufficient
- whether failure is due to implementation blocker vs missing evidence

### Impact on coding tasks

This is one of the highest-leverage gaps. A coding agent lives or dies by observer quality. Right now observer is much better at “should I retrieve more evidence?” than “is this code task actually complete?”

## Output contract for coding work

### Current state

`FinalizeAnswer` is generic and caller-facing. It is intentionally loose.

### Gap

The final contract does not require coding-task fields such as:

- summary of changes
- changed files
- checks run
- check results
- blockers
- residual risks

### Impact on coding tasks

Even when the agent does the work correctly, operator readability is weak. The system does not force a high-signal engineering handoff.

## Highest-impact gaps

The most important gaps are:

1. observer convergence for engineering work
2. coding-specific prompt doctrine in thinker/planner/extractor
3. durable planning/reconciliation artifact
4. explicit verification expectations
5. coding-shaped final output contract

Those five gaps matter more than adding new tools. The tool surface is already broad enough to support a stronger coding agent.
