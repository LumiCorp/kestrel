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

## Delivery Slice: Unified `exec_command` Lifecycle

This delivery keeps the broader detector-to-model recovery contract above and
hardens the terminal path that produces much of its runtime evidence.

- `exec_command` is the model's only terminal surface. A command starts one
  managed process and uses `yieldTimeMs` only as its first observation window.
  A live process returns `running` with a reusable `sessionId`; later calls
  read unread output, send stdin, or stop it.
- The supervisor owns unread-output cursors and absolute `timeoutMs` deadlines.
  Omitted timeouts do not create a wall-clock deadline. Runtime closeout keeps
  enough budget to stop run-owned processes, flush final output, run the
  source-write guard, measure final workspace changes, and release process
  leases.
- Internal `dev.shell.*` and `dev.process.*` tools stay registered for replay
  and internal execution but are removed from provider-facing tool surfaces.
  Dispatched terminal work is never retried automatically.
- Workspace checkpoints are captured around each returned observation. The
  canonical result is rebuilt after checkpoint enrichment so model context,
  audit output, raw-output references, transcript evidence, replay, console,
  and telemetry describe the same result. Newly observed changed files make
  prior validation stale, including changes from failed commands.
- `WorkspaceFreshnessSummary` is derived from the ordered evidence ledger and
  is not persisted as a second state machine. Later-step passed checks,
  verification, or file read-back can make the workspace fresh; same-step
  evidence, a mutating process's own result, and missing legacy step identity
  cannot.
- Runtime context carries live-process and stale/unresolved workspace status
  until it is settled. Finalization rejects live sessions and stale work.
  Attempted unresolved validation requires no actionable todo plus an explicit
  `openGap` or `knownWarnings` report.
- Visible todos remain the agent-owned planning and progress surface. They are
  never rewritten by the runtime and no longer count as execution evidence.

Implementation owners are `DevShellSupervisor`, `exec_command`, execution
budgeting and checkpoint result shaping in `ExecutionEngine`/`RuntimeIO`, the
evidence ledger and `WorkspaceFreshnessSummary`, runtime context assembly, and
the reference-agent decision policy. This slice adds no database migration,
workspace revision counter, command classifier, semantic verifier, finalize
status, or lexical heuristic.

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
- `pnpm run governance:check`, `pnpm run test`, and `pnpm run test-proofs:check`.

### 2026-07-17 implementation evidence

The first SWE Verified pass found three execution-lifecycle ownership defects
that unit coverage alone did not expose:

- Live-session recovery named the policy but did not show the agent the full
  valid continuation and stop calls, including required `assistantProgress`.
- A concurrent transcript observation could overwrite a terminal supervisor
  record with an older `RUNNING` record. Process-record writes are now ordered,
  terminal state cannot regress, and a recorded running process missing from
  the live supervisor is recovered as lost instead of remaining permanently
  live.
- Initial observation returned on the first output chunk instead of observing
  through `yieldTimeMs` for process exit. Quick commands now return their
  terminal result inside the initial window; only processes still alive at the
  end of that window return `running`.

Five selected SWE Verified patches resolved officially: pytest-10051,
scikit-learn-14141, django-14089, xarray-4629, and astropy-14995. Four Kestrel
runs reached normal completion; Django exposed the stale-running-record race
and hit the no-progress loop guard even though its patch resolved. The final
Astropy run included both supervisor repairs and completed normally.

This establishes functional recovery, not acceptable efficiency. The final
Astropy run used 66 runtime steps, 21 model calls, and 425,491 tokens. Reducing
repeated context and action turns remains explicit simplification debt and
requires a separate evidence-led design; this delivery does not add heuristic
retry or ranking behavior to hide that cost.
