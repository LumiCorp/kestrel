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
import { countTextTokens, resolveModelTokenCounter, type ExactTokenCounter } from "./tokenCounting.js";

export function buildModelRequestEconomicsManifest(input: {
  request: ModelRequest;
  contextSections?: ContextSectionCandidateV1[] | undefined;
  policy?: HarnessEconomicsPolicyV1 | undefined;
  modelProfile?: ModelEconomicsProfileV1 | undefined;
  phase?: string | undefined;
  toolExposureSelection?: ToolExposureSelectionV1 | undefined;
}): ModelRequestEconomicsManifestV1 {
  const counter = counterForProfile(input.modelProfile);
  const messages = input.request.messages ?? [];
  const modelVisibleMessages = serialize(messages);
  const messageCount = countTextTokens(modelVisibleMessages, counter);
  const contextSections = input.contextSections ?? messages.map((message, index) =>
    contextSectionFromMessage(message, index, counter)
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
  }), counter);
  const toolSurface = buildToolSurfaceManifest(input.request.tools ?? [], counter);
  const unattributedContextTokens = messageCount.tokens - accountedContext.tokens;
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
    reconciliation: {
      componentSumToCanonicalRequestTokens: unattributedContextTokens,
      canonicalRequestToProviderPayloadTokens: 0,
    },
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
  const schemaBudgetEnforceable = input.toolSurface.count.method !== "conservative_estimate" || input.policy.counting.allowEstimatedEnforcement;
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

export function buildToolSurfaceManifest(
  tools: ModelToolSpec[],
  counter?: ExactTokenCounter | undefined,
): ModelRequestEconomicsManifestV1["toolSurface"] {
  const entries: ToolSurfaceEntryManifestV1[] = tools.map((tool) => {
    const serialized = serialize(tool);
    return {
      name: tool.name,
      schemaHash: sha256(serialized),
      count: countTextTokens(serialized, counter),
    };
  });
  const serializedSurface = serialize(tools);
  return {
    version: 1,
    surfaceHash: sha256(serializedSurface),
    count: countTextTokens(serializedSurface, counter),
    tools: entries,
  };
}

export function buildToolResultEconomicsManifest(result: AgentToolResult): ToolResultEconomicsManifestV1 {
  const rawSerialized = serialize(result.auditRecord.output);
  const persistedSerialized = serialize(result.projections?.persistedOutput ?? result.auditRecord.output);
  const verificationSerialized = serialize(result.projections?.verificationOutput ?? result.auditRecord.output);
  const modelVisibleSerialized = serialize(result.modelContext);
  const rawReceived = result.projections === undefined
    ? countTextTokens(rawSerialized)
    : {
        version: 1 as const,
        tokens: result.projections.rawReceived.tokens,
        bytes: result.projections.rawReceived.bytes,
        method: "conservative_estimate" as const,
        confidence: "conservative" as const,
        counter: "tool-result-raw-received:v1",
        counterVersion: "1",
      };
  const persistedOutput = countTextTokens(persistedSerialized);
  const verificationVisible = countTextTokens(verificationSerialized);
  const modelVisible = countTextTokens(modelVisibleSerialized);
  return {
    version: 1,
    rawReceivedHash: result.projections?.rawReceived.sha256 ?? sha256(rawSerialized),
    rawReceived,
    ...(result.projections?.durableRawArtifactRef !== undefined
      ? { durableRawArtifactRef: result.projections.durableRawArtifactRef }
      : {}),
    persistedOutputHash: sha256(persistedSerialized),
    persistedOutput,
    verificationVisibleHash: sha256(verificationSerialized),
    verificationVisible,
    modelVisibleHash: sha256(modelVisibleSerialized),
    modelVisible,
    reductions: {
      rawToPersistedTokens: Math.max(0, rawReceived.tokens - persistedOutput.tokens),
      persistedToModelVisibleTokens: Math.max(0, persistedOutput.tokens - modelVisible.tokens),
      rawToModelVisibleTokens: Math.max(0, rawReceived.tokens - modelVisible.tokens),
    },
    truncated: result.modelContext.truncated === true,
  };
}

function contextSectionFromMessage(
  message: ModelMessage,
  index: number,
  counter?: ExactTokenCounter | undefined,
): ContextSectionCandidateV1 {
  const serialized = serialize(message);
  return {
    id: `message:${index}`,
    origin: `model-message:${message.role}`,
    contentHash: sha256(serialized),
    count: countTextTokens(serialized, counter),
  };
}

function sumCounts(counts: TokenCountV1[]): TokenCountV1 {
  return combineCounts(counts, "section-sum:v1");
}

function combineCounts(counts: TokenCountV1[], counter: string): TokenCountV1 {
  const providerExact = counts.every((count) => count.method === "provider_reported");
  const tokenizerCompatible = counts.every((count) => count.method !== "conservative_estimate");
  return {
    version: 1,
    tokens: counts.reduce((total, count) => total + count.tokens, 0),
    bytes: counts.reduce((total, count) => total + count.bytes, 0),
    method: providerExact ? "provider_reported" : tokenizerCompatible ? "model_tokenizer" : "conservative_estimate",
    confidence: providerExact ? "provider_exact" : tokenizerCompatible ? "model_compatible" : "conservative",
    counter,
    counterVersion: "1",
  };
}

function subtractCount(total: TokenCountV1, accounted: TokenCountV1): TokenCountV1 {
  return {
    version: 1,
    tokens: Math.max(0, total.tokens - accounted.tokens),
    bytes: Math.max(0, total.bytes - accounted.bytes),
    method: total.method === "provider_reported" && accounted.method === "provider_reported"
      ? "provider_reported"
      : total.method !== "conservative_estimate" && accounted.method !== "conservative_estimate"
        ? "model_tokenizer"
        : "conservative_estimate",
    confidence: total.confidence === "provider_exact" && accounted.confidence === "provider_exact"
      ? "provider_exact"
      : total.confidence !== "conservative" && accounted.confidence !== "conservative"
        ? "model_compatible"
        : "conservative",
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

function counterForProfile(profile: ModelEconomicsProfileV1 | undefined): ExactTokenCounter | undefined {
  if (profile?.counting.method !== "model_tokenizer") return undefined;
  const counter = resolveModelTokenCounter(profile.counting.counter, profile.counting.counterVersion);
  if (counter === undefined) {
    throw new Error(`Configured model token counter '${profile.counting.counter}' is unavailable.`);
  }
  return counter;
}
