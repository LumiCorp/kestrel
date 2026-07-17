---
id: runtime-evidence-reliability
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-17
depends_on:
  - ../../src/runtime/agent-context/assembleContext.ts
  - ../../src/runtime/agent-context/runtimeContext.ts
  - ../../src/runtime/agent-context/toolContext.ts
  - ../../src/engine/ExecutionEngine.ts
---

# Runtime Evidence And Recovery Reliability

## Outcome

When the runtime has durable evidence, a failed action, a validation rejection,
or an unresolved wait, the next deliberator turn receives a fresh structured
fact and can recover without asking the user for internally available input.
A final-answer request synthesizes from existing evidence before it retrieves
again.

## Contract

Every recoverable condition follows one path:

```text
detector -> durable state/evidence -> context assembly -> model input -> tested recovery
```

The semantic owners are deliberately small: runtime context owns task, mode,
work state, waits, and recovery; tool context owns model-visible tool results;
retry context owns rejected-action guidance; context assembly only composes
them. Compatibility shims must not become independent prompt owners.

## Work

1. **Evidence rehydration and synthesis.** Treat persisted artifact identifiers
   as loadable evidence handles. A compacted session can recover source facts
   and synthesize a substantive answer without broad reretrieval. Artifact-read
   failures are precise internal failures, not requests for pasted content.
2. **Final-answer and stall semantics.** Explicit final-answer requests route
   to synthesis when relevant evidence exists. Meta replies, known-next-step
   prompts, and repeated retrieval do not satisfy the request.
3. **Recovery continuity.** Preserve partial tool-batch diagnostics, active
   wait precedence, validation feedback, finalization blockers, and resume
   diagnostics until the first post-resume deliberator turn.
4. **Ownership discipline.** Decide and document the boundary for non-agent
   model calls, original tool descriptions, completion-policy layers, and
   user-visible versus model-visible wait text. New semantic surfaces require
   one owner and a guard test.

## Acceptance Criteria

- Compacted evidence is usable for final synthesis with no extra user action.
- Final-answer completion contains answer substance or an exact evidence-access
  failure.
- Partial failures, validation rejections, waits, and resumes survive into the
  next model input with fresh precedence.
- Tests assert the full detector-to-model-input path, not only a terminal
  status.
- The user transcript exposes useful answer and recovery state, not internal
  completion narration.

## Non-Goals

- Do not add lexical heuristics, ranking, or wider retrieval loops.
- Do not make user-visible copy implicitly model-visible.
- Do not split prompt ownership into another framework.

## Validation

- Focused artifact, context, final-answer, wait/resume, and partial-batch tests.
- `pnpm run governance:check`, `pnpm run test`, `pnpm run prompt-suite`, and
  `pnpm run evals:release-check`.
