---
id: kestrel-agent-context-builder-inventory-2026-07-03
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-03
depends_on:
  - ../../AGENTS.md
  - ../../src/runtime/KestrelAgentContextBuilder.ts
  - ../../src/runtime/agent-context/assembleContext.ts
  - ../../agents/reference-react/src/context/ContextRequestBuilder.ts
---

# Kestrel Model-Visible Context Reference Map

This is the current reference map for Kestrel's model-visible agent context surfaces after the semantic ownership refactor. The target is a small set of semantic homes rather than a prompt framework.

Primary files: [KestrelAgentContextBuilder.ts](../../src/runtime/KestrelAgentContextBuilder.ts), [assembleContext.ts](../../src/runtime/agent-context/assembleContext.ts), [runtimeContext.ts](../../src/runtime/agent-context/runtimeContext.ts), and [ContextRequestBuilder.ts](../../agents/reference-react/src/context/ContextRequestBuilder.ts).

## Implemented Reference Map

| Semantic surface | Primary owner | Notes |
| --- | --- | --- |
| Durable agent identity and mode prompts | [systemPrompts.ts](../../src/runtime/agent-context/systemPrompts.ts) | Owns shared persona plus chat, plan, and build mode prompts. |
| Current task, mode, workspace, skill pack, todos, waits, recovery | [runtimeContext.ts](../../src/runtime/agent-context/runtimeContext.ts) | Owns the sectioned `<runtime_context>` body. |
| Observed recent filesystem and task-queue facts | [evidenceContext.ts](../../src/runtime/agent-context/evidenceContext.ts) | Owns transcript-facing runtime evidence summaries. |
| Tool descriptions, aliases, summaries, and model context | [toolContext.ts](../../src/runtime/agent-context/toolContext.ts) | Owns control tool contracts and tool-result model-visible rendering. |
| Validation rejection and retry correction rendering | [retryContext.ts](../../src/runtime/agent-context/retryContext.ts) | Owns validation feedback and structured correction text. |
| SWE Verified and Terminal-Bench task contracts | [benchmarkContext.ts](../../src/runtime/agent-context/benchmarkContext.ts) | Owns Kestrel-added benchmark guidance; adapters pass structured benchmark facts. |
| Compaction and repair prompts | [maintenancePrompts.ts](../../src/runtime/agent-context/maintenancePrompts.ts) | Owns compaction messages, compaction thresholds, and Terminal-Bench repair prompt text. |
| Assembly order and compatibility metadata | [assembleContext.ts](../../src/runtime/agent-context/assembleContext.ts) | Orchestrates semantic renderers and returns messages, model input, transcript, and section metadata. |

## Current Assembly Center

| Surface | Current location | Role | Ownership note |
| --- | --- | --- | --- |
| Public Kestrel context entrypoint | `src/runtime/KestrelAgentContextBuilder.ts` | Compatibility export to `src/runtime/agent-context/assembleContext.ts`. | Stable public import path for runtime callers. |
| Context assembly | `src/runtime/agent-context/assembleContext.ts` | Assembles task instruction, runtime context, transcript messages, system prompt, and metadata. | Orchestration layer; semantic prose lives in sibling context modules. |
| Legacy context facade | `agents/reference-react/src/context/ContextRequestBuilder.ts` | Delegates `buildContextRequest()` to `buildKestrelAgentContext()`. | Compatibility boundary; should stay thin. |
| Transcript rendering | `src/runtime/modelTranscript.ts` | Converts normalized transcript items into provider messages and wraps runtime context in `<runtime_context>`. | Lower-level transcript renderer used by the assembly layer. |

## Prompt And Context Locations

| Context category | Current location | Model-visible text? | Current shape |
| --- | --- | --- | --- |
| Shared, plan, build, chat deliberator prompts | `src/runtime/agent-context/systemPrompts.ts` | Yes | Durable system prompt text plus mode-specific prompt variants. |
| Prompt registry shims | `src/runtime/deliberatorPrompt.ts`, `src/runtime/deliberatorPrompts.ts`, `agents/reference-react/src/prompt/modePromptRegistry.ts`, `agents/reference-react/src/prompt/modePrompts.ts` | Re-export only | Compatibility paths; no independent text. |
| Runtime task/mode/work state/evidence/recovery/correction block | `src/runtime/agent-context/runtimeContext.ts` | Yes | Renders `Task`, `Mode`, `Work state`, `Evidence`, `Recovery`, and `Correction needed`. |
| Benchmark task instructions | `src/runtime/agent-context/benchmarkContext.ts` | Yes | Renders SWE Verified guidance and Terminal-Bench execution contract from structured benchmark context. |
| Tool descriptions and aliases | `src/runtime/agent-context/toolContext.ts` | Yes | Renders control tool descriptions, provider aliases, schemas, and model-visible tool specs. |
| Tool result summaries/model context | `src/runtime/agent-context/toolContext.ts`; caller in `tools/toolResult.ts` | Yes | `tools/toolResult.ts` still builds audit envelopes and delegates model context text to the context module. |
| Validation feedback and retry correction text | `src/runtime/agent-context/retryContext.ts` plus retry object builders in `agents/reference-react/src/steps/deliberator.ts` | Yes | Rendering is split: retry context renders structured correction objects, but deliberator still defines many correction kinds and fallback strings. |
| Compaction prompt and policy | `src/runtime/agent-context/maintenancePrompts.ts`; caller in `agents/reference-react/src/steps/deliberator.ts` | Yes | Builder-adjacent module owns compaction prompt text and thresholds; deliberator still decides when to call the model. |
| Terminal-Bench repair prompt | `src/runtime/agent-context/maintenancePrompts.ts`; caller in `scripts/terminal-bench.ts` | Yes | Repair prompt text is centralized in runtime context module; script wrapper still names the local helper. |
| Recent filesystem evidence and Mission Control queue context | `src/runtime/agent-context/evidenceContext.ts` | Yes | Renders compact evidence from runtime state and project snapshot. |
| Workspace model/system messages | `src/runtime/agent-context/runtimeContext.ts`; shim at `agents/reference-react/src/prompt/workspace.ts` | Yes | Runtime context owns workspace rendering; old Reference ReAct path re-exports for compatibility. |
| Skill pack system message | `src/runtime/agent-context/runtimeContext.ts`; shim at `agents/reference-react/src/prompt/skillPack.ts` | Yes | Runtime context owns skill-pack rendering; old Reference ReAct path re-exports for compatibility. |
| Mode blocked approval/wait prompts | `agents/reference-react/src/steps/modeBlockedPrompt.ts`; `agents/reference-react/src/steps/acter/policyGates.ts` | User-visible, sometimes runtime-visible | Needs classification: not all user-visible wait prompts belong in model input, but some resume/approval text can affect later context. |
| User reply intent classifier prompt | `src/runtime/userReplyIntent.ts` | Yes, different model role | Separate model call, not agent-loop context. Decide whether "single context builder" includes classifier prompts. |
| Mountaintop scenario and simulated user prompts | `scripts/mountaintop-e2e.ts` | Yes, eval/simulation model calls | Separate evaluation model surfaces; probably inventory-only unless the refactor scope includes all model calls. |
| CLI prompt smoke fixtures | `tests/cli-prompts/*.md` | Yes, operator prompt fixtures | Test inputs, not builder-owned prompt policy. |
| Web child mission prompt | `apps/web/app/_components/ChatPageClient.tsx` | Yes, task prompt text | UI-created child-agent prompt surface; needs ownership decision before migration. |

## Known Compatibility And Adapter Paths

| Path | Current behavior | Inventory note |
| --- | --- | --- |
| `scripts/swe-verified-bench.ts` | Builds job input with a short message plus structured benchmark context. | Adapter still has a model-facing seed message; detailed SWE guidance is now rendered by `benchmarkContext.ts`. |
| `benchmarks/terminal_bench/job_input.py` | Rejects already-rendered Kestrel Terminal-Bench contract in Python-side message. | Python side is becoming structured-only, but still guards against duplicate text. |
| `benchmarks/terminal_bench/agents.py` and `harbor_agents.py` | Build benchmark execution commands and environment. | Should remain adapter/transport, not prompt owner. |
| `tools/catalog.ts` and runtime tool registries | Emit structured tool specs. | Tool description strings originate in tool definitions, then `toolContext.ts` aliases and passes them through. Need decide whether original tool descriptions count as context-builder-owned text. |
| `agents/reference-react/src/modelToolCallActions.ts` | Calls `buildKestrelAgentToolSurface()`. | Compatibility caller and model tool-call parser, not current text owner. |

## Duplicates Or Split Ownership To Discuss

1. Completion and validation rules exist in both the build system prompt and `kestrel.finalize` tool description. This may be intentional layering, but the exact division should be explicit.
2. Visible todo rules exist in the build system prompt and `kestrel.todo_update` description. Current split is "when to create todo" in system prompt, "tool schema/meaning" in tool description.
3. Retry correction ownership is not fully centralized. `retryContext.ts` renders structured correction messages, while `agents/reference-react/src/steps/deliberator.ts` still defines many correction categories and residual text fields.
4. Transcript message layout is still owned by `modelTranscript.ts`, not by `assembleContext.ts`. This may be acceptable if `modelTranscript.ts` is a renderer dependency, but it is not literally a single rendering file.
5. Workspace and skill-pack prompt helpers are compatibility shims. Runtime context now owns the model-visible rendering and no longer emits raw JSON blocks for those surfaces.
6. Non-agent model calls remain outside the agent context modules: user-reply intent, compaction model call, mountaintop simulated user/eval prompts, and browser/UI child mission prompt generation.
7. Benchmark guidance is partly centralized, but benchmark adapters still seed task messages and contain guard strings for duplicate prompt contracts.
8. User-visible wait/approval text is not the same as model-visible agent context. We should decide whether to keep it out of the builder or treat any text later reintroduced into context as builder-owned.

## Remaining Boundary Questions

1. Non-agent model prompts, such as reply intent classification and mountaintop simulated-user prompts, remain outside this agent-loop context refactor.
2. Original workspace-tool descriptions still originate in tool modules and are passed through the tool-context surface; control tool descriptions live directly in `toolContext.ts`.
3. Completion policy is intentionally layered: system prompt carries the general operating loop, `kestrel.finalize` carries the exact closeout contract, and retry context carries specific rejected-action guidance.
4. User-visible wait/approval prompts are not automatically agent context. If any of that text is reintroduced into model input later, route it through the relevant semantic owner.

## Follow-Up Checklist

- Keep compatibility shims thin.
- Add guard tests when new semantic surfaces are introduced.
- Update this reference map before future prompt wording changes.
