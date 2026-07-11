---
id: runtime-agent-complexity-audit-2026-06-12
domain: runtime
status: draft
owner: kestrel-runtime
last_verified_at: 2026-06-12
depends_on:
  - ../../AGENTS.md
  - ../../DESIGN.md
  - ./2026-06-08-runtime-simplification-baseline.md
  - ../adr/0004-runtime-simplification-boundaries.md
  - ../../agents/reference-react/src/steps/deliberator.ts
  - ../../agents/reference-react/src/decision/compileIntent.ts
  - ../../agents/reference-react/src/steps/acter.ts
  - ../../agents/reference-react/src/modelToolCallActions.ts
  - ../../agents/reference-react/src/deliberatorToolSurface.ts
  - ../../src/runtime/modelTranscript.ts
  - ../../src/runtime/state.ts
---

# Runtime and Agent Complexity Audit

## Thesis

Kestrel has accumulated low-value complexity in the agent/runtime loop. The issue is not a missing SWE-specific lane, a weaker benchmark prompt, or a need for more finalization policy. The issue is that the general runtime asks the model to operate inside too many Kestrel-specific concepts before it can make progress on the user's actual task.

The recurring failure shape is:

1. A user asks for work.
2. Runtime converts that into mode, context, transcript, visible todos, tool aliases, hidden tool availability, retry corrections, capability requirements, validation rules, evidence ledgers, and step-state transitions.
3. The model must satisfy this protocol while also solving the task.
4. When it fails, the runtime adds more corrective protocol text.
5. The next model turn has less room and less clarity for the actual task.

This is not a SWE-only problem. SWE-bench exposed it because the benchmark has a brutally simple success artifact: edit files in a repo and produce `git diff`. The contrast with `mini-SWE-agent` is useful because it shows that a simple shell-first scaffold can perform well without making the model comply with a rich agent protocol.

## Source-Grounded Trace

### 1. Context assembly already exposes runtime protocol

[ContextRequestBuilder.ts](../../agents/reference-react/src/context/ContextRequestBuilder.ts) appends user input, retry corrections, visible todos, workspace context, skill pack context, active waits, and prompt variants into the request before the model sees the task.

The model-facing runtime context includes:

- `Task`
- `Event`
- `Mode`
- `Prompt variant`
- workspace context
- skill pack context
- visible todos
- correction text
- active wait state

Evidence: [ContextRequestBuilder.ts](../../agents/reference-react/src/context/ContextRequestBuilder.ts) builds this at lines 32-78, and [modelTranscript.ts](../../src/runtime/modelTranscript.ts) renders the runtime context at lines 287-325.

This is useful for continuity, but it means even a simple task is framed as a Kestrel runtime event, not just as a task in a workspace.

### 2. The prompt is carrying product workflow policy

[modePrompts.ts](../../agents/reference-react/src/prompt/modePrompts.ts) gives the model separate chat, plan, and build roles. Plan mode alone includes handoff rules, plan document requirements, implementation prohibitions, and invalid behavior lists. Build mode contains task-execution guidance plus finalization reporting rules.

Evidence: [modePrompts.ts](../../agents/reference-react/src/prompt/modePrompts.ts) lines 13-39 and 41-69.

This helps product UX, but it also means the model has to reason about Kestrel workflow concepts before task concepts. In practice, "plan document", "handoff_to_build", "visible checklist", "finalize", and "mode" become part of the problem space.

### 3. The tool surface is not just tools

[modelToolCallActions.ts](../../agents/reference-react/src/modelToolCallActions.ts) adds provider aliases and Kestrel control tools. The model must call `kestrel_finalize`, `kestrel_ask_user`, `kestrel_cannot_satisfy`, sometimes `kestrel_handoff_to_build`, and sometimes `kestrel_todo_update`, with schema-specific payloads.

Evidence: [modelToolCallActions.ts](../../agents/reference-react/src/modelToolCallActions.ts) lines 54-138.

This gives us clean structured control, but it is not free. It turns "answer the user" into a protocol action with status enums and optional data. It also turns progress tracking into model-authored state updates.

### 4. Tool filtering is a policy layer with model-facing corrections

[deliberatorToolSurface.ts](../../agents/reference-react/src/deliberatorToolSurface.ts) filters tools based on live process state and returns hidden-tool corrections. For example, it hides `dev.process.start` unless a managed entrypoint needs it and tells the model to use `dev.shell.run` instead.

Evidence: [deliberatorToolSurface.ts](../../agents/reference-react/src/deliberatorToolSurface.ts) lines 40-70 and 86-101.

Some filtering is good safety. But tool filtering also becomes dynamic coaching. The model can end up solving "which Kestrel tool is currently allowed?" instead of "what is the next useful task action?"

### 5. The deliberator has retry loops that turn validation into instruction

[deliberator.ts](../../agents/reference-react/src/steps/deliberator.ts) runs the model, compiles the response, retries schema/policy failures, builds retry context from the previous response, tool availability, evidence context, post-tool verification, execution intent, and then re-asks the model.

Evidence: [deliberator.ts](../../agents/reference-react/src/steps/deliberator.ts) lines 292-443.

This is defensible as a recovery mechanism, but it compounds protocol load. A failed action does not just fail. It injects a correction turn, filtered tool availability, prior output, policy signatures, and terminal-control retry behavior into the next model call.

### 6. The compile layer is a policy stack, not a compiler

[compileIntent.ts](../../agents/reference-react/src/decision/compileIntent.ts) is doing far more than parsing and validating tool-call shape. The hot path runs:

- tool schema validation
- URL tool contract checks
- single-loop action checks
- dev-shell command contract checks
- root app scaffold checks
- repeated cached file-read policy
- workspace-root mutation policy
- dev-shell process batch policy
- stdin/write policy
- active process policy
- coding finalize verification normalization
- verified artifact preservation policy
- finalization policy
- dev-shell target checks
- live process replay checks
- settled command polling checks
- no-progress polling checks
- coding closeout policy
- mode-scoped terminal action policy
- capability policy

Evidence: [compileIntent.ts](../../agents/reference-react/src/decision/compileIntent.ts) lines 168-274.

This is the clearest over-engineering hotspot. A compiler should make invalid model output executable or reject invalid boundary input. This layer also coaches, reroutes, blocks, infers capability requirements, and enforces product workflow semantics.

### 7. Runtime state has too many model-adjacent concepts

[state.ts](../../src/runtime/state.ts) persists a rich agent state: observations, exec, waitingFor, terminal, lastAction, lastActionResult, retryContext, plan, planDocument, visibleTodos, modelTranscript, evidenceLedger, region, memory, and stateNode.

Evidence: [state.ts](../../src/runtime/state.ts) lines 67-88.

Rich state is useful for replay and UI, but any field that influences model context or validation is part of the agent's cognitive environment. Today, model-visible or compile-visible state includes transcript, retry context, visible todos, plan, evidence ledger, dev-shell process facts, post-tool verification, and interaction mode.

### 8. We are testing orchestration ceremony more than task effectiveness

[runtime-simplification-characterization.test.ts](../../tests/unit/runtime-simplification-characterization.test.ts) pins lifecycle ordering, wait resume targets, model/tool events, commits, progress, and event ordering.

That is valuable for deterministic runtime behavior, but it does not ask whether the model-facing task surface got simpler, whether retry corrections improved success, or whether a smaller tool/control surface performs better.

## Findings

### Finding 1: Kestrel makes the model solve two problems

The model is solving the user's task and the Kestrel protocol. The protocol includes mode selection, control tool schema, finalization semantics, visible todo state, hidden tool availability, evidence formatting, and validation recovery.

This likely impairs performance because failed model behavior often gets wrapped in more Kestrel-specific correction text instead of making the next task action more obvious.

### Finding 2: Validation boundaries have become behavioral policy

Boundary validation is appropriate for malformed action input, unsafe mutations, unavailable tools, and replay-breaking state. But compile-time validators now also enforce workflow habits, tool strategy, artifact preservation semantics, repeated-read behavior, process-polling strategy, finalization style, and closeout evidence.

That means model mistakes are often answered by policy feedback rather than by a simpler model surface.

### Finding 3: Product workflow concepts leak into the hot loop

Plan/build/chat modes, handoff tools, plan documents, visible todos, and terminal control tools are product-facing workflow concepts. They may be useful in the app, but they are expensive in the agent loop.

The most damaging pattern is when workflow concepts become required model actions rather than runtime-owned UI/projection state.

### Finding 4: We have too many equivalent ways to express progress

Kestrel can represent progress as:

- transcript items
- visible todos
- plan document state
- evidence ledger entries
- last action result
- post-tool verification
- decision trace
- runtime events
- progress events
- finalization data

Each representation was likely added for a reason. Together they create ambiguity about what the model should trust and what the runtime should enforce.

### Finding 5: Retry recovery adds context instead of removing ambiguity

The retry path sends the previous response, failure, post-tool verification, evidence context, tool availability, and extracted execution intent. When the model is already confused, this can make the next turn worse.

The better recovery shape is usually a smaller surface: "That action was invalid because X. Available next actions are Y. Continue with one." Today the retry path often carries the whole diagnostic environment.

### Finding 6: The agent-facing tool surface is less boring than it should be

For many tasks, the model needs:

- inspect files
- edit files
- run commands
- answer or ask

Kestrel exposes more nuanced primitives, especially around process lifecycle, terminal controls, planning handoff, visible todos, and finalization schemas. Some nuance belongs in runtime internals, not the model interface.

## Classification

### Keep as hard runtime value

- Deterministic replay.
- Persisted runtime events.
- Atomic step commits.
- Tool input schema validation.
- Tool allowlist enforcement.
- Approval and destructive-action boundaries.
- Workspace root and sandbox boundaries.
- Terminal output capture.
- Final patch or artifact capture owned by runtime.

These protect correctness, safety, or debuggability without needing to be model-facing.

### Demote from model-facing to runtime/internal

- Evidence ledger details.
- Post-tool verification summaries.
- Retry diagnostics beyond the one concrete correction.
- Visible todo state unless the user explicitly asks for a checklist.
- Plan document requirements as model obligations.
- Tool hidden/unavailable diagnostics beyond the next valid action.
- Finalization `data` requirements.
- Decision traces and capability accounting.

These can remain available for logs, replay, UI, and debugging, but should stop steering the main model loop by default.

### Delete or merge if not proven valuable

- Separate model-authored visible todo updates as a normal hot-loop control tool.
- Handoff-to-build as a model tool when mode switching can be runtime/user-owned.
- Coding closeout policy as a compile-time validation layer.
- Strategy validators that enforce "use X tool rather than Y tool" when both are safe.
- Repeated-read policy that blocks the model instead of letting runtime reuse cached results or annotate duplicate output.

These should survive only if we can show they improve task success rather than just reduce undesirable traces.

## Design Direction

The simplification target is not a new lane. It is a smaller general contract.

### Model contract

The default model contract should be:

1. Here is the user task.
2. Here is the current workspace/runtime context only if it directly matters.
3. Here are the available actions.
4. Choose one action or answer.

The model should not need to know about step agents, runtime variants, hidden tool corrections, plan handoff internals, evidence ledger schemas, retry signatures, or finalization data conventions.

### Runtime contract

The runtime should own:

1. Which mode the UI is in.
2. Which tools are allowed.
3. Whether an action is safe to run.
4. How outputs are recorded.
5. How state is replayed.
6. How patches/artifacts are collected.
7. How terminal output and progress are projected.

The runtime should not make the model repeatedly prove it understands Kestrel's internal workflow state.

### Validation contract

Validators should answer only:

- Is this input parseable?
- Is this tool/action available?
- Is this action safe?
- Would this break replay or state integrity?
- Is this user-visible text structurally valid?

Validators should not answer:

- Is this the best next strategy?
- Did the model validate enough?
- Should it use one safe tool instead of another safe tool?
- Is its closeout sufficiently formatted?
- Did it update our preferred progress object?

Those belong in simple prompt guidance, runtime-owned output shaping, or offline eval.

## Proposed Implementation Sequence

### Slice 1: Measure the model-facing surface

Add characterization that snapshots:

- system prompt text by mode
- model-visible runtime context keys
- requested tool names
- control tool schemas
- retry correction payload shape

This creates a diffable budget for complexity. The goal is not to freeze current behavior; it is to make reductions visible.

### Slice 2: Collapse finalization

Make finalization model-facing schema as small as possible:

- `message`
- optional `status`

Move closeout evidence, changed files, validation summaries, and artifacts to runtime-derived summaries where possible. Keep only generic contradiction checks that prevent impossible user-visible claims.

### Slice 3: Remove visible todo from the default hot loop

Keep visible todos as an explicit user/product feature, not a default model control tool. The runtime can still project progress from actions and final output. The model should not have to close checklist state before finalizing unless the user explicitly asked for checklist management.

### Slice 4: Demote plan handoff protocol

Treat plan/build mode transitions as runtime and UI state. Stop requiring the model to emit a rich `handoff_to_build` payload when the user has already approved implementation. The model can produce a normal answer or the runtime can switch modes based on operator action.

### Slice 5: Split compile validation into boundary and coaching

Refactor [compileIntent.ts](../../agents/reference-react/src/decision/compileIntent.ts) into:

- hard boundary validators
- runtime-owned normalization
- optional advisory diagnostics

Only hard boundary validators should block the model turn. Advisory diagnostics can be logged or surfaced after failure, but should not create retry loops by default.

### Slice 6: Make retry smaller

Replace rich retry context with one plain correction and the currently valid tool surface. Do not include previous response, evidence context, post-tool verification, filesystem inventory, and execution intent unless a focused test proves they help.

### Slice 7: Shell/edit/action simplicity pass

Review every model-visible tool for whether it can be hidden behind fewer primitives. The target is not "bash only" as dogma. The target is fewer choices that map to obvious task operations.

## Immediate Recommendation

Do not add any new benchmark-specific policy, workflow lane, finalization contract, or recovery heuristic.

The next implementation PR should be Slice 1 plus one deletion-oriented change from Slice 2 or Slice 3. That keeps the work honest: first make model-facing complexity measurable, then delete one high-cost obligation and compare traces.

## Non-Goals

- No SWE-specific agent behavior.
- No new runtime profile fields.
- No new capability pack abstraction.
- No new heuristic routing or fallback policy.
- No new model-review pass.
- No benchmark-specific finalization validation.

The point is to make the general runtime less burdensome, not to add another layer that hides the burden.
