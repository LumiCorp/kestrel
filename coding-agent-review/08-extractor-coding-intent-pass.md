# Extractor Coding Intent Pass

## Why this pass

The current highest-value unfinished gap is still extractor-side coding intent.

`reference-react` now has some coding-aware observer and thinker guardrails, but extractor output is still too generic for repository work. Downstream steps do not get a structured statement of whether the turn is an implementation task, a validation task, a read-only inspection, or a command-driven workflow.

## Scope for this pass

Keep the change additive and runtime-first.

Do not change step topology.
Do not add heuristic planner behavior.
Do not require new fields everywhere immediately.

This pass only adds a minimal coding-intent contract at extractor/tool-intent boundaries:

- `taskKind`
- `repoScope`
- `mutationIntent`
- `verificationIntent`
- `workspaceTargets`
- `hostWorkflowKind`

## What changed

- Extended extractor prompt guidance so repo work can emit coding-specific task metadata when it is grounded.
- Extended extractor response schema with additive optional coding-intent fields.
- Extended tool-intent parsing and decision-context propagation so downstream steps can see the new fields.
- Added unit coverage for prompt contract text, extractor parsing, and decision-context propagation.

## Validation

Ran `pnpm test -- --runInBand tests/unit/extractor-tool-intent.test.ts`.

The project test script expands to the full Node test suite, so this pass received broader validation than the narrow target.

Result:

- 911 tests passed
- 0 failed

## Risks and limits

- Planner, thinker, and observer do not consume these fields yet for stronger promotion or convergence policy. This pass makes the contract available first.
- `repoScope` remains intentionally lightweight and grounded to explicit path/workspace evidence. It does not try to infer deep repo topology.
- `hostWorkflowKind` is intentionally narrow to avoid heuristic task classification drift.
- No implementation blockers in this pass.

## Next recommended to-do

Use the new extractor contract in planner promotion and thinker prompts.

The next pass should stay small:

- prefer repo-grounding actions when `taskKind=implement` and scope is broad
- preserve explicit validation expectations when `verificationIntent.requested=true`
- avoid mutation promotion when extractor marks the turn `read_only`
