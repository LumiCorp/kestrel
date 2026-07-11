# `reference-react` Current System

## Bottom line

`reference-react` is a disciplined, contract-heavy general tool agent with some coding affordances. It is not yet a serious software-engineering agent.

Its strongest properties are mechanical:

- explicit step graph
- typed structured outputs
- schema-checked action compilation
- explicit execution/wait/finalize states
- runtime policy gates for mode, approval, and autonomy
- replayable state and operator-visible traces

Its coding support is partial and mostly structural, not doctrinal. The runtime can expose coding-capable tools and the planner can route some coding-shaped intents, but the prompts and output contracts are still mostly generic decision machinery plus research-oriented recovery logic.

## Step graph and responsibilities

The live graph is explicit in [graph.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/graph.ts). Registration and step contracts live in [register.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/register.ts).

The path is:

1. `react.route`
   Decides chat vs tooling lane. It persists `react.routeDecision` and respects interaction mode and allowed tool classes. If the current mode blocks the required tool class, it emits `ask_user` and moves to `react.exec.wait_user`.

2. `react.chat`
   Handles purely conversational turns. It produces a small JSON payload and finalizes immediately via `FinalizeAnswer`.

3. `react.extractor`
   Converts the user turn into structured tool intent, candidate tools, hints, follow-up grounding, persistence intent, and execution preference. It can ask for clarification, otherwise it hands off to planner.

4. `react.planner`
   First pass of the act lane. It tries to promote extracted tool intent directly into an executable action or `resolve_tool` without another model round-trip. If promotion fails, it falls back to thinker.

5. `react.thinker`
   Produces a full decision envelope: plan, required capabilities, next action, confidence, and verification. It cannot emit `ask_user` or `cannot_satisfy`.

6. `react.resolve`
   Repairs or concretizes `resolve_tool` into schema-valid `tool` or `tool_batch` input.

7. `react.exec.dispatch`
   Executes already-compiled actions, or routes into explicit wait/finalize substates.

8. `react.exec.wait_effect`
   Waits for durable tool/effect completion.

9. `react.exec.wait_approval`
   Waits for operator approval when approval or autonomy policy requires it.

10. `react.exec.wait_user`
    Waits for user clarification or a mode-switch reply.

11. `react.exec.collect`
    Advances batch execution or hands off to observer.

12. `react.observer`
    Judges convergence, compiles the next control action, and either loops back into execution/deliberation or routes to finalize.

13. `react.exec.finalize`
    Finalizes the caller-facing payload and emits `react.completed`.

The step graph is a real strength. It keeps routing, extraction, planning, decision compilation, execution, observation, waiting, and finalization separate.

## Prompt locations and composition

The live prompts are step-local:

- route prompt: [route.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/route.ts)
- chat prompt: [chat.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/chat.ts)
- extractor prompt: [extractor.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/extractor.ts)
- thinker prompt: [thinker.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/thinker.ts)
- resolver prompt: [resolver.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/resolver.ts)
- observer prompt: [observer.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/observer.ts)

Shared prompt assembly lives in:

- [DecisionPromptTemplate.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/prompt/DecisionPromptTemplate.ts)
- [workspace.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/prompt/workspace.ts)
- [skillPack.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/prompt/skillPack.ts)
- [filesystem.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/prompt/filesystem.ts)

The composition model is:

- base step prompt
- workspace system overlays
- optional skill-pack overlay
- JSON-serialized model input

This is Kestrel-native: prompts are per-step, typed, and composable instead of being collapsed into a single monolithic system prompt.

## Tool intent flow from route to execution

The end-to-end flow is:

1. Route classification in [route.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/route.ts)
   The route model returns `executionLane`, `needsTools`, `requiredToolClasses`, `reasonCode`, and `confidence`.

2. Extracted tool intent in [extractor.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/extractor.ts) and [toolIntent.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/toolIntent.ts)
   Extractor emits `toolUseIntent`, `candidateTools`, `inputHints`, `executionPreference`, `command`, `commandMode`, `persistenceIntent`, and `followUpSourceSelection`.

3. Planner promotion in [planner.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/planner.ts)
   Planner promotes concrete extracted intent directly into:
   - `tool`
   - `resolve_tool`
   - mode-blocked `ask_user`
   - thinker fallback

4. Decision compilation in [thinker.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/thinker.ts), [resolver.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/resolver.ts), and [compileIntent.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/compileIntent.ts)
   Model output is ingested, canonicalized, schema-validated, policy-validated, and normalized before execution.

5. Execution control in [execStates.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/execStates.ts) and [acter.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/acter.ts)
   Dispatch handles:
   - mode gating
   - autonomy escalation
   - per-call approval
   - read-only dedupe/reuse
   - durable effect waiting
   - tool batch continuation

6. Observation and convergence in [observer.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/observer.ts)
   Observer compiles the next control action and decides whether to continue, redirect, or finalize.

## Runtime and policy constraints

Several runtime layers constrain behavior mechanically.

### Step contracts

[register.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/register.ts) enforces transition shape and required state patches for each step. This is a real strength. Behavior is not only prompt-desired; many parts are mechanically required.

### Decision schemas and compilation

[DecisionEnvelope.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/DecisionEnvelope.ts), [DecisionIngestPipeline.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/DecisionIngestPipeline.ts), and [compileIntent.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/decision/compileIntent.ts) force:

- JSON output
- envelope shape
- action canonicalization
- tool input schema validation
- policy validation

### Interaction mode and approval

[src/mode/contracts.ts](https://github.com/LumiCorp/kestrel/blob/main/src/mode/contracts.ts) enforces:

- `chat` = no tools
- `plan` = read-only tools only
- `act.safe` = read-only plus sandboxed tools
- `act.full_auto` = read-only plus sandboxed plus external side-effect tools

[acter.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/acter.ts) enforces these mode boundaries at execution time.

### Autonomy policy

[src/governance/autonomy.ts](https://github.com/LumiCorp/kestrel/blob/main/src/governance/autonomy.ts) defines autonomy levels and required evidence. `acter` can escalate to approval if the evidence required by autonomy policy is missing.

### Tool legality and capability manifests

Tool exposure is explicit through [tools/catalog.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/catalog.ts). Tools carry:

- capability classes
- execution class
- freshness/latency/cost classes
- presentation metadata

This is another strong point. Tool legality is not inferred ad hoc from tool names anymore.

## Context, evidence, replay, and observation loops

[ContextBuilder.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/context/ContextBuilder.ts) builds the model context. It includes:

- user message
- recent conversation
- rolling summary
- observations digest
- last action preview
- structured last action result
- pending batch preview
- tool intent
- memory recall
- evidence pack
- tool outcome cache
- prior sources and follow-up grounding
- recovery verdicts and repetition signals
- client capabilities
- context telemetry

This gives thinker and observer a decent operational view of what happened previously.

Replayability and operator evidence are runtime-level properties described in [ARCHITECTURE.md](https://github.com/LumiCorp/kestrel/blob/main/ARCHITECTURE.md), [RELIABILITY.md](https://github.com/LumiCorp/kestrel/blob/main/RELIABILITY.md), and enforced through the engine/runtime stack rather than agent-local prompt text.

## What is already coding-friendly

Several coding-friendly behaviors already exist.

- The CLI profile injects a broader tool allowlist than the research-heavy constant default. See [cli/config/ProfileStore.ts](https://github.com/LumiCorp/kestrel/blob/main/cli/config/ProfileStore.ts) and [cli/runtime/KestrelChatRuntime.ts](https://github.com/LumiCorp/kestrel/blob/main/cli/runtime/KestrelChatRuntime.ts).
- Planner can promote coding-shaped requests into `fs.write_text`, `code.execute`, and `dev.shell.*` paths. See [planner.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/planner.ts) and [tests/unit/planner-tool-intent.test.ts](https://github.com/LumiCorp/kestrel/blob/main/tests/unit/planner-tool-intent.test.ts).
- Acter enforces approval, autonomy, mode, and dedupe rather than relying on prompts alone. See [acter.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/acter.ts).
- Observer contains explicit settlement logic for dev-shell polling and code-artifact finalize constraints. See [observer.ts](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/observer.ts).
- Filesystem and code tools are typed and bounded. See [tools/filesystem/readText.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/filesystem/readText.ts), [tools/filesystem/searchText.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/filesystem/searchText.ts), [tools/filesystem/writeText.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/filesystem/writeText.ts), and [tools/code/execute.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/code/execute.ts).

## Why it still falls short as a serious coding agent

The agent can touch coding tasks, but it is not yet coding-specialized.

- The prompts do not define a repo exploration hierarchy.
- There is no explicit dirty-worktree or non-destructive edit doctrine.
- There is no durable implementation checklist or reconciliation artifact.
- Observer convergence is still mostly framed around evidence sufficiency and research stall avoidance.
- Final output has no coding-shaped contract for changed files, checks run, blockers, or residual risks.

The result is a strong general runtime agent that can perform some coding work, but not one that yet expresses a mature software-engineering behavior model.
