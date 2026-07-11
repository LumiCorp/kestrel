---
id: heuristic-hotspots
domain: docs
status: active
owner: kestrel-agent
last_verified_at: 2026-06-30
depends_on: [../index.md, ../../agents/reference-react/src/followUpSourceGrounding.ts, ../../agents/reference-react/src/steps/planner.ts, ../../tools/runtime/UnifiedToolRegistry.ts, ../../src/runtime/recoveryVerdict.ts]
---

# Heuristic Hotspot Inventory

Heuristic changes are the last resort in this codebase. When a behavior issue appears, first tighten prompt instructions, structured outputs, and explicit runtime contracts; only after those options are evaluated should threshold or fallback heuristics be proposed.

## Removed In This Pass

- [`agents/reference-react/src/steps/route.ts`](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/route.ts)
  Route-family overrides were removed and replaced with model-backed route classification plus policy checks.
- [`agents/reference-react/src/steps/planner.ts`](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/planner.ts)
  Planner-side weather/time/fx parsing heuristics were removed. Concrete tool promotion now requires extractor-provided `inputHints` and fails with `DECISION_SCHEMA_FAILED` when hints are missing.
- [`agents/reference-react/src/followUpSourceGrounding.ts`](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/followUpSourceGrounding.ts)
  Follow-up grounding no longer token-scores, fuzzy-matches, or ranks prior sources locally. The extractor must now emit an explicit `followUpSourceSelection` with a stable prior-source candidate ID or an explicit search pivot.
- [`agents/reference-react/src/steps/planner.ts`](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/planner.ts)
  File-write authorization is no longer inferred from lexical phrases or path-like strings. `fs.write_text` now requires extractor-provided `persistenceIntent.kind = "write_file"` and otherwise fails closed.
- [`tools/catalog.ts`](https://github.com/LumiCorp/kestrel/blob/main/tools/catalog.ts)
  Capability and execution metadata are no longer inferred from tool names. Missing built-in metadata now fails catalog construction.
- [`tools/toolMetadata.ts`](https://github.com/LumiCorp/kestrel/blob/main/tools/toolMetadata.ts)
  Presentation metadata inference was removed. Display name, aliases, keywords, provider, and family are now explicit required fields for built-in tools.
- [`src/engine/ExecutionEngine.ts`](https://github.com/LumiCorp/kestrel/blob/main/src/engine/ExecutionEngine.ts)
  Wait kind is no longer inferred from `eventType`. Wait producers must set `waitFor.kind` explicitly.
- [`tools/runtime/UnifiedToolRegistry.ts`](https://github.com/LumiCorp/kestrel/blob/main/tools/runtime/UnifiedToolRegistry.ts)
  External MCP tools no longer synthesize public presentation metadata from tool names or server IDs. They are exposed only when explicit `toolMetadata` descriptors are configured.
- [`src/orchestration/ContextAdaptationEvaluator.ts`](https://github.com/LumiCorp/kestrel/blob/main/src/orchestration/ContextAdaptationEvaluator.ts)
  Adaptation decisions no longer recompute low-signal thresholds locally. Shared recovery/adaptation verdicts now centralize low-signal exhaustion, low-yield cluster stalls, research-stall activation, and thrash thresholds.
- [`src/engine/ExecutionEngine.ts`](https://github.com/LumiCorp/kestrel/blob/main/src/engine/ExecutionEngine.ts)
  Research-stall detection no longer reinterprets evidence-recovery and web-extraction counters inline. It now consumes the same shared recovery/adaptation verdict layer as orchestration.
- [`agents/reference-react/src/steps/acter.ts`](https://github.com/LumiCorp/kestrel/blob/main/agents/reference-react/src/steps/acter.ts)
  Code artifact fallback promotion was removed. Missing or invalid `KCHAT_ARTIFACT_MANIFEST` now fails finalize.
- [`src/engine/RegionScheduler.ts`](https://github.com/LumiCorp/kestrel/blob/main/src/engine/RegionScheduler.ts)
  Normal-step fallback from `event.stepAgent` was removed. Only first-turn explicit entry may use the event override.

## Remaining Non-Contract Fallbacks To Watch

- [`src/runtime/continuationIntent.ts`](https://github.com/LumiCorp/kestrel/blob/main/src/runtime/continuationIntent.ts)
  Continuation-intent parsing still uses lexical phrase matching and edit-distance normalization to detect user requests for more time or deeper work. That behavior is isolated, but it remains heuristic.
- [`src/runtime/webExtraction.ts`](https://github.com/LumiCorp/kestrel/blob/main/src/runtime/webExtraction.ts)
  Content-quality diagnostics still use deterministic thresholding for extraction quality and low-yield classification. That is acceptable operational policy, but any expansion should stay inside the shared recovery verdict layer rather than spreading to new callers.
- [`src/runtime/evidenceQuality.ts`](https://github.com/LumiCorp/kestrel/blob/main/src/runtime/evidenceQuality.ts)
  Evidence-quality diagnostics still classify low-signal research attempts with deterministic thresholds. Those thresholds are now consumed centrally, and future changes should modify the shared policy layer rather than downstream consumers.

## Non-Issues

- Provider failover in tools such as weather/time/search is operational resiliency and should stay. The issue class in this review is reasoning and routing heuristics, not network/provider fallback.
