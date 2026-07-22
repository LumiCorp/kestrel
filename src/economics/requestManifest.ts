import { createHash } from "node:crypto";

import type { AgentToolResult, ModelMessage, ModelRequest, ModelToolSpec } from "../kestrel/contracts/model-io.js";
import type {
  ContextSectionCandidateV1,
  HarnessEconomicsPolicyV1,
  ModelEconomicsProfileV1,
  ModelRequestEconomicsManifestV1,
  TokenCountV1,
  ToolExposureDecisionV1,
  ToolExposureSelectionV1,
  ToolSurfaceEntryManifestV1,
  ToolResultEconomicsManifestV1,
} from "./contracts.js";
import { HarnessEconomicsController } from "./HarnessEconomicsController.js";
import { countTextTokens } from "./tokenCounting.js";

export function buildModelRequestEconomicsManifest(input: {
  request: ModelRequest;
  contextSections?: ContextSectionCandidateV1[] | undefined;
  policy?: HarnessEconomicsPolicyV1 | undefined;
  modelProfile?: ModelEconomicsProfileV1 | undefined;
  phase?: string | undefined;
  toolExposureSelection?: ToolExposureSelectionV1 | undefined;
}): ModelRequestEconomicsManifestV1 {
  const messages = input.request.messages ?? [];
  const modelVisibleMessages = serialize(messages);
  const messageCount = countTextTokens(modelVisibleMessages);
  const contextSections = input.contextSections ?? messages.map((message, index) =>
    contextSectionFromMessage(message, index)
  );
  const accountedContext = sumCounts(contextSections.map((section) => section.count));
  const requestControl = countTextTokens(serialize({
    model: input.request.model,
    ...(messages.length === 0 ? { input: input.request.input } : {}),
    responseSchema: input.request.responseSchema,
    responseFormat: input.request.responseFormat,
    providerOptions: input.request.providerOptions,
    reasoning: input.request.reasoning === undefined
      ? undefined
      : { ...input.request.reasoning, continuation: input.request.reasoning.continuation?.map(() => "[opaque]") },
  }));
  const toolSurface = buildToolSurfaceManifest(input.request.tools ?? []);
  const unattributedContextTokens = Math.max(0, messageCount.tokens - accountedContext.tokens);
  const providerOverhead = combineCounts([
    subtractCount(messageCount, accountedContext),
    requestControl,
  ], "request-boundary-overhead:v1");
  const requestCount = combineCounts([
    accountedContext,
    toolSurface.count,
    providerOverhead,
  ], "request-boundary-total:v1");
  const decision = input.policy !== undefined && input.modelProfile !== undefined
    ? new HarnessEconomicsController().decide({
        policy: input.policy,
        modelProfile: input.modelProfile,
        sections: contextSections,
        toolSchema: toolSurface.count,
        providerOverhead,
      })
    : undefined;
  const toolExposure = input.policy === undefined
    ? undefined
    : buildToolExposureDecision({
        policy: input.policy,
        phase: input.phase,
        toolSurface,
        selection: input.toolExposureSelection,
      });
  return {
    version: 1,
    requestCount,
    contextSections,
    toolSurface,
    ...(toolExposure !== undefined ? { toolExposure } : {}),
    providerOverhead,
    unattributedContextTokens,
    ...(decision !== undefined ? { decision } : {}),
  };
}

function buildToolExposureDecision(input: {
  policy: HarnessEconomicsPolicyV1;
  phase?: string | undefined;
  toolSurface: ModelRequestEconomicsManifestV1["toolSurface"];
  selection?: ToolExposureSelectionV1 | undefined;
}): ToolExposureDecisionV1 {
  const phase = input.phase?.trim();
  if (phase === undefined || phase.length === 0) {
    throw new Error("Harness economics tool exposure requires a model request phase.");
  }
  const selection = input.selection;
  if (selection !== undefined) {
    if (
      selection.policyId !== input.policy.policyId ||
      selection.policyMode !== input.policy.mode ||
      selection.exposure !== input.policy.tools.exposure ||
      selection.phase !== phase
    ) {
      throw new Error("Harness economics tool exposure selection does not match the active assembly policy and phase.");
    }
    const visibleNames = new Set(input.toolSurface.tools.map((tool) => tool.name));
    const leaked = selection.excludedToolNames.find((name) => visibleNames.has(name));
    if (leaked !== undefined) {
      throw new Error(`Harness economics excluded tool '${leaked}' is present in the model-visible surface.`);
    }
  }
  const selectionStatus = selection !== undefined
    ? "provided"
    : input.policy.tools.exposure === "assembly_allowlist" || input.toolSurface.tools.length === 0
      ? "not_required"
      : "missing";
  const blockReasons: ToolExposureDecisionV1["blockReasons"] = [];
  if (selectionStatus === "missing") blockReasons.push("selection_missing");
  const schemaBudgetEnforceable = input.toolSurface.count.method === "exact" || input.policy.counting.allowEstimatedEnforcement;
  const schemaBudgetExceeded = input.toolSurface.count.tokens > input.policy.tools.modelContextMaxTokens;
  if (schemaBudgetExceeded && schemaBudgetEnforceable) {
    blockReasons.push("tool_schema_budget_exceeded");
  }
  return {
    version: 1,
    policyId: input.policy.policyId,
    policyMode: input.policy.mode,
    exposure: input.policy.tools.exposure,
    phase,
    selectionStatus,
    ...(selection !== undefined ? { selection } : {}),
    modelVisibleToolNames: input.toolSurface.tools.map((tool) => tool.name),
    modelVisibleSurfaceHash: input.toolSurface.surfaceHash,
    modelVisibleSchema: input.toolSurface.count,
    modelContextMaxTokens: input.policy.tools.modelContextMaxTokens,
    schemaBudgetEnforceable,
    schemaBudgetExceeded,
    wouldBlock: blockReasons.length > 0,
    blockReasons,
  };
}

export function buildToolSurfaceManifest(tools: ModelToolSpec[]): ModelRequestEconomicsManifestV1["toolSurface"] {
  const entries: ToolSurfaceEntryManifestV1[] = tools.map((tool) => {
    const serialized = serialize(tool);
    return {
      name: tool.name,
      schemaHash: sha256(serialized),
      count: countTextTokens(serialized),
    };
  });
  const serializedSurface = serialize(tools);
  return {
    version: 1,
    surfaceHash: sha256(serializedSurface),
    count: countTextTokens(serializedSurface),
    tools: entries,
  };
}

export function buildToolResultEconomicsManifest(result: AgentToolResult): ToolResultEconomicsManifestV1 {
  const storedSerialized = serialize(result.auditRecord.output);
  const modelVisibleSerialized = serialize(result.modelContext);
  const storedOutput = countTextTokens(storedSerialized);
  const modelVisible = countTextTokens(modelVisibleSerialized);
  return {
    version: 1,
    storedOutputHash: sha256(storedSerialized),
    storedOutput,
    modelVisibleHash: sha256(modelVisibleSerialized),
    modelVisible,
    reductionTokens: Math.max(0, storedOutput.tokens - modelVisible.tokens),
    truncated: result.modelContext.truncated === true,
    ...(typeof result.modelContext.rawOutputRef === "string" && result.modelContext.rawOutputRef.trim().length > 0
      ? { rawOutputRef: result.modelContext.rawOutputRef }
      : {}),
  };
}

function contextSectionFromMessage(message: ModelMessage, index: number): ContextSectionCandidateV1 {
  const serialized = serialize(message);
  return {
    id: `message:${index}`,
    origin: `model-message:${message.role}`,
    contentHash: sha256(serialized),
    count: countTextTokens(serialized),
  };
}

function sumCounts(counts: TokenCountV1[]): TokenCountV1 {
  return combineCounts(counts, "section-sum:v1");
}

function combineCounts(counts: TokenCountV1[], counter: string): TokenCountV1 {
  const exact = counts.every((count) => count.method === "exact");
  return {
    version: 1,
    tokens: counts.reduce((total, count) => total + count.tokens, 0),
    bytes: counts.reduce((total, count) => total + count.bytes, 0),
    method: exact ? "exact" : "estimated",
    confidence: exact ? "exact" : "conservative",
    counter,
    counterVersion: "1",
  };
}

function subtractCount(total: TokenCountV1, accounted: TokenCountV1): TokenCountV1 {
  return {
    version: 1,
    tokens: Math.max(0, total.tokens - accounted.tokens),
    bytes: Math.max(0, total.bytes - accounted.bytes),
    method: total.method === "exact" && accounted.method === "exact" ? "exact" : "estimated",
    confidence: total.confidence === "exact" && accounted.confidence === "exact" ? "exact" : "conservative",
    counter: "unattributed-message-overhead:v1",
    counterVersion: "1",
  };
}

function serialize(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "undefined";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortValue(record[key])]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
