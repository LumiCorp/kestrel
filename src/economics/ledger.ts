import { createHash, randomUUID } from "node:crypto";

import type { RunEventLevel, RunEventType } from "../kestrel/contracts/base.js";
import type { RunEvent } from "../kestrel/contracts/events.js";
import type {
  EconomicsAttemptProjectionV1,
  EconomicsCallProjectionV1,
  EconomicsLedgerEventV1,
  EconomicsLedgerProjectionV1,
  EconomicsToolResultProjectionV1,
} from "./contracts.js";
import { parseToolExposureSelectionV1 } from "./toolExposure.js";

type EconomicsLedgerEventDraftV1 = EconomicsLedgerEventV1 extends infer Event
  ? Event extends EconomicsLedgerEventV1
    ? Omit<Event, "version" | "eventId" | "payloadHash">
    : never
  : never;

const EVENT_TYPE_BY_KIND: Record<EconomicsLedgerEventV1["kind"], RunEventType> = {
  "model_call.requested": "economics.model_call.requested",
  "model_attempt.started": "economics.model_attempt.started",
  "model_attempt.completed": "economics.model_attempt.completed",
  "model_attempt.failed": "economics.model_attempt.failed",
  "model_call.completed": "economics.model_call.completed",
  "model_call.failed": "economics.model_call.failed",
  "tool_result.recorded": "economics.tool_result.recorded",
  "outcome.evaluated": "economics.outcome.evaluated",
  "run_outcome.evaluated": "economics.run_outcome.evaluated",
};

const ECONOMICS_EVENT_TYPES = new Set<RunEventType>(Object.values(EVENT_TYPE_BY_KIND));
const BASE_FIELDS = ["version", "eventId", "payloadHash", "callId", "kind"] as const;
const RUN_BASE_FIELDS = ["version", "eventId", "payloadHash", "runId", "kind"] as const;
const FIELDS_BY_KIND: Record<EconomicsLedgerEventV1["kind"], ReadonlySet<string>> = {
  "model_call.requested": new Set([...BASE_FIELDS, "providerPayloadHash", "componentHash", "toolManifestHash", "provider", "model", "modelBudgetClass", "phase", "assemblyId", "contextPolicyId", "requestManifest"]),
  "model_attempt.started": new Set([...BASE_FIELDS, "attempt", "maxAttempts", "provider", "model"]),
  "model_attempt.completed": new Set([...BASE_FIELDS, "attempt", "latencyMs"]),
  "model_attempt.failed": new Set([...BASE_FIELDS, "attempt", "latencyMs", "failureCode", "failureClass", "retryable", "willRetry", "visibleOutputStarted", "retryDelayMs"]),
  "model_call.completed": new Set([...BASE_FIELDS, "provider", "model", "latencyMs", "usage", "pricing"]),
  "model_call.failed": new Set([...BASE_FIELDS, "latencyMs", "failureCode", "failureClass"]),
  "tool_result.recorded": new Set([...BASE_FIELDS, "toolCallId", "toolName", "status", "latencyMs", "resultManifest"]),
  "outcome.evaluated": new Set([...BASE_FIELDS, "evaluatorId", "evaluatorVersion", "acceptance", "independentlyEvaluated", "failureClass"]),
  "run_outcome.evaluated": new Set([...RUN_BASE_FIELDS, "evaluatorId", "evaluatorVersion", "acceptance", "independentlyEvaluated", "failureClass"]),
};
const USAGE_FIELDS = new Set(["version", "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens"]);
const PRICING_FIELDS = new Set(["version", "status", "currency", "priceVersion", "sourceUrl", "totalCostUsd", "components", "reason"]);
const PRICE_COMPONENT_FIELDS = new Set(["category", "tokens", "ratePerMillionTokens", "costUsd"]);
const TOOL_RESULT_MANIFEST_FIELDS = new Set(["version", "storedOutputHash", "storedOutput", "modelVisibleHash", "modelVisible", "reductionTokens", "truncated", "rawOutputRef"]);
const TOKEN_COUNT_FIELDS = new Set(["version", "tokens", "bytes", "method", "confidence", "counter", "counterVersion"]);
const REQUEST_MANIFEST_FIELDS = new Set(["version", "requestCount", "contextSections", "toolSurface", "toolExposure", "providerOverhead", "unattributedContextTokens", "decision"]);
const CONTEXT_CANDIDATE_FIELDS = new Set(["id", "origin", "revision", "contentHash", "count", "duplicateOf"]);
const TOOL_SURFACE_FIELDS = new Set(["version", "surfaceHash", "count", "tools"]);
const TOOL_SURFACE_ENTRY_FIELDS = new Set(["name", "schemaHash", "count"]);
const TOOL_EXPOSURE_FIELDS = new Set(["version", "policyId", "policyMode", "exposure", "phase", "selectionStatus", "selection", "modelVisibleToolNames", "modelVisibleSurfaceHash", "modelVisibleSchema", "modelContextMaxTokens", "schemaBudgetEnforceable", "schemaBudgetExceeded", "wouldBlock", "blockReasons"]);
const DECISION_FIELDS = new Set(["version", "manifest", "admittedSectionIds", "droppedSectionIds", "blockedSectionIds"]);
const CONTEXT_MANIFEST_FIELDS = new Set(["version", "policyId", "policyMode", "provider", "model", "modelProfileId", "contextWindowTokens", "outputReserveTokens", "safetyReserveTokens", "toolSchema", "providerOverhead", "availableContextTokens", "proposedContextTokens", "policyContextTokens", "effectiveContextTokens", "countMethods", "enforceable", "wouldBlock", "sections"]);
const CONTEXT_SECTION_MANIFEST_FIELDS = new Set(["id", "origin", "revision", "contentHash", "priority", "proposed", "policyAdmission", "policyReason", "policyTokens", "effectiveAdmission", "effectiveTokens", "duplicateOf"]);

export function createEconomicsLedgerEventMetadata(
  draft: EconomicsLedgerEventDraftV1,
  eventId: string = randomUUID(),
): EconomicsLedgerEventV1 {
  const unhashed = { version: 1 as const, eventId, ...draft };
  return { ...unhashed, payloadHash: hashCanonical(unhashed) } as EconomicsLedgerEventV1;
}

export function createEconomicsRunEvent(input: {
  runId: string;
  sessionId: string;
  stepIndex?: number | undefined;
  timestamp: string;
  level?: RunEventLevel | undefined;
  event: EconomicsLedgerEventDraftV1;
  eventId?: string | undefined;
}): RunEvent {
  const metadata = createEconomicsLedgerEventMetadata(input.event, input.eventId);
  if (metadata.kind === "run_outcome.evaluated" && metadata.runId !== input.runId) {
    throw new Error("Economics run outcome runId must match its run event.");
  }
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    type: EVENT_TYPE_BY_KIND[metadata.kind],
    level: input.level ?? (metadata.kind.endsWith("failed") ? "WARN" : "INFO"),
    timestamp: input.timestamp,
    metadata: { ...metadata },
  };
}

export function economicsRunEventType(kind: EconomicsLedgerEventV1["kind"]): RunEventType {
  return EVENT_TYPE_BY_KIND[kind];
}

export function parseEconomicsLedgerEvent(event: RunEvent): EconomicsLedgerEventV1 | undefined {
  if (ECONOMICS_EVENT_TYPES.has(event.type) === false) return undefined;
  const metadata = requireRecord(event.metadata, "metadata");
  if (metadata.version !== 1) throw new Error("Economics ledger event version must be 1.");
  const eventId = requireString(metadata.eventId, "eventId");
  const payloadHash = requireHash(metadata.payloadHash, "payloadHash");
  const kind = requireString(metadata.kind, "kind") as EconomicsLedgerEventV1["kind"];
  if (EVENT_TYPE_BY_KIND[kind] !== event.type) {
    throw new Error(`Economics ledger event kind '${kind}' does not match '${event.type}'.`);
  }
  const unhashed = { ...metadata };
  delete unhashed.payloadHash;
  if (hashCanonical(unhashed) !== payloadHash) {
    throw new Error(`Economics ledger event '${eventId}' payload hash does not match.`);
  }
  requireEventFields(metadata, kind);
  if (kind === "run_outcome.evaluated") {
    return {
      ...metadata,
      version: 1,
      eventId,
      payloadHash,
      runId: requireString(metadata.runId, "runId"),
      kind,
    } as EconomicsLedgerEventV1;
  }
  return {
    ...metadata,
    version: 1,
    eventId,
    payloadHash,
    callId: requireString(metadata.callId, "callId"),
    kind,
  } as EconomicsLedgerEventV1;
}

export function projectEconomicsLedger(events: RunEvent[]): EconomicsLedgerProjectionV1 {
  const calls = new Map<string, EconomicsCallProjectionV1>();
  const toolResults = new Map<string, EconomicsToolResultProjectionV1>();
  const runOutcomes: EconomicsLedgerProjectionV1["runOutcomes"] = [];
  const eventIds = new Set<string>();
  const invalidEvents: EconomicsLedgerProjectionV1["invalidEvents"] = [];
  for (const runEvent of events) {
    let event: EconomicsLedgerEventV1 | undefined;
    try {
      event = parseEconomicsLedgerEvent(runEvent);
    } catch (error) {
      invalidEvents.push({
        ...(typeof runEvent.metadata?.eventId === "string" ? { eventId: runEvent.metadata.eventId } : {}),
        type: runEvent.type,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (event === undefined) continue;
    if (eventIds.has(event.eventId)) {
      invalidEvents.push({ eventId: event.eventId, type: runEvent.type, reason: `Duplicate economics event id '${event.eventId}'.` });
      continue;
    }
    eventIds.add(event.eventId);
    if (event.kind === "run_outcome.evaluated") {
      if (event.runId !== runEvent.runId) {
        invalidEvents.push({ eventId: event.eventId, type: runEvent.type, reason: `Run outcome '${event.eventId}' runId does not match its run event.` });
        continue;
      }
      runOutcomes.push({ recordedAt: runEvent.timestamp, event });
      continue;
    }
    if (event.kind === "tool_result.recorded") {
      if (toolResults.has(event.toolCallId)) {
        invalidEvents.push({ eventId: event.eventId, type: runEvent.type, reason: `Tool call '${event.toolCallId}' has multiple economics result events.` });
        continue;
      }
      toolResults.set(event.toolCallId, { toolCallId: event.toolCallId, recordedAt: runEvent.timestamp, event });
      continue;
    }
    const call = calls.get(event.callId) ?? { callId: event.callId, attempts: [], outcomes: [] };
    try {
      applyEvent(call, event, runEvent.timestamp);
    } catch (error) {
      invalidEvents.push({
        eventId: event.eventId,
        type: runEvent.type,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    calls.set(event.callId, call);
  }
  const projectedCalls = [...calls.values()]
    .map((call) => ({ ...call, attempts: [...call.attempts].sort((left, right) => left.attempt - right.attempt) }))
    .sort((left, right) => (left.requestedAt ?? left.callId).localeCompare(right.requestedAt ?? right.callId));
  const projectedToolResults = [...toolResults.values()].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  return {
    version: 1,
    calls: projectedCalls,
    toolResults: projectedToolResults,
    runOutcomes: runOutcomes.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt)),
    totals: summarize(projectedCalls, projectedToolResults),
    invalidEvents,
  };
}

function applyEvent(call: EconomicsCallProjectionV1, event: EconomicsLedgerEventV1, timestamp: string): void {
  switch (event.kind) {
    case "model_call.requested":
      if (call.request !== undefined) throw new Error(`Call '${call.callId}' has multiple request events.`);
      call.requestedAt = timestamp;
      call.request = event;
      return;
    case "model_attempt.started":
      if (attempt(call, event.attempt).startedAt !== undefined) throw new Error(`Call '${call.callId}' attempt ${event.attempt} started more than once.`);
      Object.assign(attempt(call, event.attempt), { startedAt: timestamp });
      return;
    case "model_attempt.completed":
      if (attempt(call, event.attempt).completedAt !== undefined || attempt(call, event.attempt).failedAt !== undefined) throw new Error(`Call '${call.callId}' attempt ${event.attempt} has multiple terminal events.`);
      Object.assign(attempt(call, event.attempt), { completedAt: timestamp, latencyMs: event.latencyMs });
      return;
    case "model_attempt.failed":
      if (attempt(call, event.attempt).completedAt !== undefined || attempt(call, event.attempt).failedAt !== undefined) throw new Error(`Call '${call.callId}' attempt ${event.attempt} has multiple terminal events.`);
      Object.assign(attempt(call, event.attempt), {
        failedAt: timestamp,
        latencyMs: event.latencyMs,
        failureCode: event.failureCode,
        failureClass: event.failureClass,
        retryable: event.retryable,
        willRetry: event.willRetry,
        retryDelayMs: event.retryDelayMs,
      });
      return;
    case "model_call.completed":
      if (call.completion !== undefined || call.failure !== undefined) throw new Error(`Call '${call.callId}' has multiple terminal events.`);
      call.completedAt = timestamp;
      call.completion = event;
      return;
    case "model_call.failed":
      if (call.completion !== undefined || call.failure !== undefined) throw new Error(`Call '${call.callId}' has multiple terminal events.`);
      call.failedAt = timestamp;
      call.failure = event;
      return;
    case "tool_result.recorded":
      return;
    case "outcome.evaluated":
      call.outcomes.push(event);
      return;
    case "run_outcome.evaluated":
      return;
  }
}

function attempt(call: EconomicsCallProjectionV1, attemptNumber: number): EconomicsAttemptProjectionV1 {
  let record = call.attempts.find((entry) => entry.attempt === attemptNumber);
  if (record === undefined) {
    record = { attempt: attemptNumber };
    call.attempts.push(record);
  }
  return record;
}

function summarize(
  calls: EconomicsCallProjectionV1[],
  toolResults: EconomicsToolResultProjectionV1[],
): EconomicsLedgerProjectionV1["totals"] {
  const totals = calls.reduce<EconomicsLedgerProjectionV1["totals"]>((totals, call) => {
    const usage = call.completion?.usage;
    totals.calls += 1;
    totals.completedCalls += call.completion === undefined ? 0 : 1;
    totals.failedCalls += call.failure === undefined ? 0 : 1;
    totals.attempts += call.attempts.length;
    totals.retries += Math.max(0, call.attempts.length - 1);
    totals.inputTokens += usage?.inputTokens ?? 0;
    totals.outputTokens += usage?.outputTokens ?? 0;
    totals.cachedInputTokens += usage?.cachedInputTokens ?? 0;
    totals.cacheWriteInputTokens += usage?.cacheWriteInputTokens ?? 0;
    totals.reasoningTokens += usage?.reasoningTokens ?? 0;
    if (call.completion?.pricing.status === "priced") totals.pricedCostUsd += call.completion.pricing.totalCostUsd;
    else if (call.completion !== undefined) totals.unpricedCalls += 1;
    if (call.outcomes.some((outcome) => outcome.independentlyEvaluated && outcome.acceptance === "accepted")) {
      totals.independentlyAcceptedCalls += 1;
    }
    return totals;
  }, {
    calls: 0,
    completedCalls: 0,
    failedCalls: 0,
    attempts: 0,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    pricedCostUsd: 0,
    unpricedCalls: 0,
    independentlyAcceptedCalls: 0,
    toolResults: toolResults.length,
    storedToolResultTokens: 0,
    modelVisibleToolResultTokens: 0,
    reducedToolResultTokens: 0,
  });
  for (const toolResult of toolResults) {
    totals.storedToolResultTokens += toolResult.event.resultManifest.storedOutput.tokens;
    totals.modelVisibleToolResultTokens += toolResult.event.resultManifest.modelVisible.tokens;
    totals.reducedToolResultTokens += toolResult.event.resultManifest.reductionTokens;
  }
  return totals;
}

function requireEventFields(metadata: Record<string, unknown>, kind: EconomicsLedgerEventV1["kind"]): void {
  rejectUnknownFields(metadata, FIELDS_BY_KIND[kind], kind);
  switch (kind) {
    case "model_call.requested":
      requireString(metadata.providerPayloadHash, "providerPayloadHash");
      requireString(metadata.componentHash, "componentHash");
      requireString(metadata.phase, "phase");
      requireRequestManifest(metadata.requestManifest);
      if (metadata.modelBudgetClass !== "action" && metadata.modelBudgetClass !== "maintenance") {
        throw new Error("Economics model call modelBudgetClass is invalid.");
      }
      return;
    case "model_attempt.started":
      requirePositiveInteger(metadata.attempt, "attempt");
      requirePositiveInteger(metadata.maxAttempts, "maxAttempts");
      return;
    case "model_attempt.completed":
      requirePositiveInteger(metadata.attempt, "attempt");
      requireNonNegativeInteger(metadata.latencyMs, "latencyMs");
      return;
    case "model_attempt.failed":
      requirePositiveInteger(metadata.attempt, "attempt");
      requireNonNegativeInteger(metadata.latencyMs, "latencyMs");
      if (typeof metadata.retryable !== "boolean" || typeof metadata.willRetry !== "boolean" || typeof metadata.visibleOutputStarted !== "boolean") {
        throw new Error("Economics model attempt failure retry fields are invalid.");
      }
      requireString(metadata.failureClass, "failureClass");
      return;
    case "model_call.completed":
      requireNonNegativeInteger(metadata.latencyMs, "latencyMs");
      requireUsage(metadata.usage);
      requirePricing(metadata.pricing);
      return;
    case "model_call.failed":
      requireNonNegativeInteger(metadata.latencyMs, "latencyMs");
      requireString(metadata.failureCode, "failureCode");
      requireString(metadata.failureClass, "failureClass");
      return;
    case "tool_result.recorded":
      if (requireString(metadata.toolCallId, "toolCallId") !== metadata.callId) {
        throw new Error("Economics tool result toolCallId must match callId.");
      }
      requireString(metadata.toolName, "toolName");
      if (metadata.status !== "OK" && metadata.status !== "FAILED") {
        throw new Error("Economics tool result status is invalid.");
      }
      requireNonNegativeInteger(metadata.latencyMs, "latencyMs");
      requireToolResultManifest(metadata.resultManifest);
      return;
    case "outcome.evaluated":
      requireString(metadata.evaluatorId, "evaluatorId");
      requireString(metadata.evaluatorVersion, "evaluatorVersion");
      if (typeof metadata.independentlyEvaluated !== "boolean") {
        throw new Error("Economics outcome independentlyEvaluated must be boolean.");
      }
      if (metadata.acceptance !== "accepted" && metadata.acceptance !== "rejected" && metadata.acceptance !== "not_evaluated") {
        throw new Error("Economics outcome acceptance is invalid.");
      }
      return;
    case "run_outcome.evaluated":
      requireString(metadata.runId, "runId");
      requireString(metadata.evaluatorId, "evaluatorId");
      requireString(metadata.evaluatorVersion, "evaluatorVersion");
      requireString(metadata.failureClass, "failureClass");
      if (typeof metadata.independentlyEvaluated !== "boolean") {
        throw new Error("Economics run outcome independentlyEvaluated must be boolean.");
      }
      if (metadata.acceptance !== "accepted" && metadata.acceptance !== "rejected" && metadata.acceptance !== "not_evaluated") {
        throw new Error("Economics run outcome acceptance is invalid.");
      }
      if ((metadata.acceptance === "not_evaluated") === metadata.independentlyEvaluated) {
        throw new Error("Economics run outcome evaluation state is inconsistent.");
      }
  }
}

function requireRequestManifest(value: unknown): void {
  const manifest = requireRecord(value, "requestManifest");
  rejectUnknownFields(manifest, REQUEST_MANIFEST_FIELDS, "requestManifest");
  if (manifest.version !== 1) throw new Error("Economics request manifest version must be 1.");
  requireTokenCount(manifest.requestCount, "requestManifest.requestCount");
  requireTokenCount(manifest.providerOverhead, "requestManifest.providerOverhead");
  requireNonNegativeInteger(manifest.unattributedContextTokens, "requestManifest.unattributedContextTokens");
  if (Array.isArray(manifest.contextSections) === false) throw new Error("Economics request manifest contextSections must be an array.");
  manifest.contextSections.forEach((section, index) => requireContextCandidate(section, `requestManifest.contextSections[${index}]`));
  requireToolSurface(manifest.toolSurface);
  if (manifest.toolExposure !== undefined) requireToolExposure(manifest.toolExposure, manifest.toolSurface);
  if (manifest.decision !== undefined) requireEconomicsDecision(manifest.decision);
}

function requireToolExposure(value: unknown, toolSurfaceValue: unknown): void {
  const exposure = requireRecord(value, "requestManifest.toolExposure");
  rejectUnknownFields(exposure, TOOL_EXPOSURE_FIELDS, "requestManifest.toolExposure");
  if (exposure.version !== 1) throw new Error("Economics tool exposure version must be 1.");
  requireString(exposure.policyId, "requestManifest.toolExposure.policyId");
  if (exposure.policyMode !== "observe" && exposure.policyMode !== "enforce") throw new Error("Economics tool exposure policyMode is invalid.");
  if (exposure.exposure !== "assembly_allowlist" && exposure.exposure !== "phase_scoped") throw new Error("Economics tool exposure strategy is invalid.");
  requireString(exposure.phase, "requestManifest.toolExposure.phase");
  if (exposure.selectionStatus !== "provided" && exposure.selectionStatus !== "not_required" && exposure.selectionStatus !== "missing") {
    throw new Error("Economics tool exposure selectionStatus is invalid.");
  }
  const selection = exposure.selection === undefined ? undefined : parseToolExposureSelectionV1(exposure.selection);
  if ((exposure.selectionStatus === "provided") !== (selection !== undefined)) {
    throw new Error("Economics tool exposure selectionStatus does not match selection presence.");
  }
  if (selection !== undefined && (
    selection.policyId !== exposure.policyId ||
    selection.policyMode !== exposure.policyMode ||
    selection.exposure !== exposure.exposure ||
    selection.phase !== exposure.phase
  )) {
    throw new Error("Economics tool exposure selection does not match its boundary decision.");
  }
  const visibleNames = requireUniqueStringArray(exposure.modelVisibleToolNames, "requestManifest.toolExposure.modelVisibleToolNames");
  requireHash(exposure.modelVisibleSurfaceHash, "requestManifest.toolExposure.modelVisibleSurfaceHash");
  requireTokenCount(exposure.modelVisibleSchema, "requestManifest.toolExposure.modelVisibleSchema");
  const modelContextMaxTokens = requireNonNegativeInteger(exposure.modelContextMaxTokens, "requestManifest.toolExposure.modelContextMaxTokens");
  if (typeof exposure.schemaBudgetEnforceable !== "boolean" || typeof exposure.schemaBudgetExceeded !== "boolean" || typeof exposure.wouldBlock !== "boolean") {
    throw new Error("Economics tool exposure budget decision booleans are invalid.");
  }
  const blockReasons = requireUniqueStringArray(exposure.blockReasons, "requestManifest.toolExposure.blockReasons");
  if (blockReasons.some((reason) => reason !== "selection_missing" && reason !== "tool_schema_budget_exceeded")) {
    throw new Error("Economics tool exposure blockReasons is invalid.");
  }
  const surface = requireRecord(toolSurfaceValue, "requestManifest.toolSurface");
  const surfaceTools = surface.tools as Array<Record<string, unknown>>;
  const surfaceNames = surfaceTools.map((tool) => requireString(tool.name, "requestManifest.toolSurface.tool.name"));
  const schema = requireRecord(exposure.modelVisibleSchema, "requestManifest.toolExposure.modelVisibleSchema");
  const surfaceCount = requireRecord(surface.count, "requestManifest.toolSurface.count");
  if (
    arraysEqual(visibleNames, surfaceNames) === false ||
    exposure.modelVisibleSurfaceHash !== surface.surfaceHash ||
    hashCanonical(schema) !== hashCanonical(surfaceCount)
  ) {
    throw new Error("Economics tool exposure model-visible surface does not match the request tool surface.");
  }
  if (schema.method === "exact" && exposure.schemaBudgetEnforceable !== true) {
    throw new Error("Economics tool exposure exact schema counts must be enforceable.");
  }
  const expectedReasons: string[] = [];
  if (exposure.selectionStatus === "missing") expectedReasons.push("selection_missing");
  const expectedExceeded = (schema.tokens as number) > modelContextMaxTokens;
  if (exposure.schemaBudgetExceeded !== expectedExceeded) {
    throw new Error("Economics tool exposure schemaBudgetExceeded is inconsistent with its token evidence.");
  }
  if (exposure.schemaBudgetEnforceable && expectedExceeded) expectedReasons.push("tool_schema_budget_exceeded");
  if (arraysEqual(blockReasons, expectedReasons) === false || exposure.wouldBlock !== (expectedReasons.length > 0)) {
    throw new Error("Economics tool exposure blocking decision is inconsistent with its evidence.");
  }
}

function requireContextCandidate(value: unknown, field: string): void {
  const section = requireRecord(value, field);
  rejectUnknownFields(section, CONTEXT_CANDIDATE_FIELDS, field);
  requireString(section.id, `${field}.id`);
  requireString(section.origin, `${field}.origin`);
  if (section.revision !== undefined) requireString(section.revision, `${field}.revision`);
  requireHash(section.contentHash, `${field}.contentHash`);
  requireTokenCount(section.count, `${field}.count`);
  if (section.duplicateOf !== undefined) requireStringArray(section.duplicateOf, `${field}.duplicateOf`);
}

function requireToolSurface(value: unknown): void {
  const surface = requireRecord(value, "requestManifest.toolSurface");
  rejectUnknownFields(surface, TOOL_SURFACE_FIELDS, "requestManifest.toolSurface");
  if (surface.version !== 1) throw new Error("Economics tool surface manifest version must be 1.");
  requireHash(surface.surfaceHash, "requestManifest.toolSurface.surfaceHash");
  requireTokenCount(surface.count, "requestManifest.toolSurface.count");
  if (Array.isArray(surface.tools) === false) throw new Error("Economics tool surface tools must be an array.");
  surface.tools.forEach((value, index) => {
    const tool = requireRecord(value, `requestManifest.toolSurface.tools[${index}]`);
    rejectUnknownFields(tool, TOOL_SURFACE_ENTRY_FIELDS, `requestManifest.toolSurface.tools[${index}]`);
    requireString(tool.name, `requestManifest.toolSurface.tools[${index}].name`);
    requireHash(tool.schemaHash, `requestManifest.toolSurface.tools[${index}].schemaHash`);
    requireTokenCount(tool.count, `requestManifest.toolSurface.tools[${index}].count`);
  });
}

function requireEconomicsDecision(value: unknown): void {
  const decision = requireRecord(value, "requestManifest.decision");
  rejectUnknownFields(decision, DECISION_FIELDS, "requestManifest.decision");
  if (decision.version !== 1) throw new Error("Economics decision version must be 1.");
  requireStringArray(decision.admittedSectionIds, "requestManifest.decision.admittedSectionIds");
  requireStringArray(decision.droppedSectionIds, "requestManifest.decision.droppedSectionIds");
  requireStringArray(decision.blockedSectionIds, "requestManifest.decision.blockedSectionIds");
  requireContextManifest(decision.manifest);
}

function requireContextManifest(value: unknown): void {
  const manifest = requireRecord(value, "requestManifest.decision.manifest");
  rejectUnknownFields(manifest, CONTEXT_MANIFEST_FIELDS, "requestManifest.decision.manifest");
  if (manifest.version !== 1) throw new Error("Economics context manifest version must be 1.");
  for (const field of ["policyId", "provider", "model", "modelProfileId"] as const) requireString(manifest[field], `requestManifest.decision.manifest.${field}`);
  if (manifest.policyMode !== "observe" && manifest.policyMode !== "enforce") throw new Error("Economics context manifest policyMode is invalid.");
  for (const field of ["contextWindowTokens", "outputReserveTokens", "safetyReserveTokens", "availableContextTokens", "proposedContextTokens", "policyContextTokens", "effectiveContextTokens"] as const) requireNonNegativeInteger(manifest[field], `requestManifest.decision.manifest.${field}`);
  requireTokenCount(manifest.toolSchema, "requestManifest.decision.manifest.toolSchema");
  requireTokenCount(manifest.providerOverhead, "requestManifest.decision.manifest.providerOverhead");
  if (typeof manifest.enforceable !== "boolean" || typeof manifest.wouldBlock !== "boolean") throw new Error("Economics context manifest boolean fields are invalid.");
  if (Array.isArray(manifest.countMethods) === false || manifest.countMethods.some((method) => method !== "exact" && method !== "estimated")) throw new Error("Economics context manifest countMethods is invalid.");
  if (Array.isArray(manifest.sections) === false) throw new Error("Economics context manifest sections must be an array.");
  manifest.sections.forEach((value, index) => {
    const field = `requestManifest.decision.manifest.sections[${index}]`;
    const section = requireRecord(value, field);
    rejectUnknownFields(section, CONTEXT_SECTION_MANIFEST_FIELDS, field);
    requireString(section.id, `${field}.id`);
    requireString(section.origin, `${field}.origin`);
    if (section.revision !== undefined) requireString(section.revision, `${field}.revision`);
    requireHash(section.contentHash, `${field}.contentHash`);
    if (section.priority !== undefined && section.priority !== "required" && section.priority !== "elastic" && section.priority !== "optional") throw new Error(`Economics ${field}.priority is invalid.`);
    requireTokenCount(section.proposed, `${field}.proposed`);
    requireAdmission(section.policyAdmission, `${field}.policyAdmission`);
    requireString(section.policyReason, `${field}.policyReason`);
    requireNonNegativeInteger(section.policyTokens, `${field}.policyTokens`);
    requireAdmission(section.effectiveAdmission, `${field}.effectiveAdmission`);
    requireNonNegativeInteger(section.effectiveTokens, `${field}.effectiveTokens`);
    requireStringArray(section.duplicateOf, `${field}.duplicateOf`);
  });
}

function requireAdmission(value: unknown, field: string): void {
  if (value !== "admitted" && value !== "truncated" && value !== "dropped" && value !== "blocked") throw new Error(`Economics ${field} is invalid.`);
}

function requireStringArray(value: unknown, field: string): void {
  if (Array.isArray(value) === false || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) throw new Error(`Economics ${field} must be an array of non-empty strings.`);
}

function requireUniqueStringArray(value: unknown, field: string): string[] {
  requireStringArray(value, field);
  const parsed = value as string[];
  if (new Set(parsed).size !== parsed.length) throw new Error(`Economics ${field} must not contain duplicates.`);
  return parsed;
}

function requireToolResultManifest(value: unknown): void {
  const manifest = requireRecord(value, "resultManifest");
  rejectUnknownFields(manifest, TOOL_RESULT_MANIFEST_FIELDS, "resultManifest");
  if (manifest.version !== 1) throw new Error("Economics tool result manifest version must be 1.");
  requireHash(manifest.storedOutputHash, "resultManifest.storedOutputHash");
  requireTokenCount(manifest.storedOutput, "resultManifest.storedOutput");
  requireHash(manifest.modelVisibleHash, "resultManifest.modelVisibleHash");
  requireTokenCount(manifest.modelVisible, "resultManifest.modelVisible");
  requireNonNegativeInteger(manifest.reductionTokens, "resultManifest.reductionTokens");
  if (typeof manifest.truncated !== "boolean") throw new Error("Economics tool result manifest truncated must be boolean.");
  if (manifest.rawOutputRef !== undefined) requireString(manifest.rawOutputRef, "resultManifest.rawOutputRef");
}

function requireTokenCount(value: unknown, field: string): void {
  const count = requireRecord(value, field);
  rejectUnknownFields(count, TOKEN_COUNT_FIELDS, field);
  if (count.version !== 1) throw new Error(`Economics ledger event ${field}.version must be 1.`);
  requireNonNegativeInteger(count.tokens, `${field}.tokens`);
  requireNonNegativeInteger(count.bytes, `${field}.bytes`);
  if (count.method !== "exact" && count.method !== "estimated") throw new Error(`Economics ledger event ${field}.method is invalid.`);
  if (count.confidence !== "exact" && count.confidence !== "conservative") throw new Error(`Economics ledger event ${field}.confidence is invalid.`);
  requireString(count.counter, `${field}.counter`);
  requireString(count.counterVersion, `${field}.counterVersion`);
}

function requireUsage(value: unknown): void {
  const usage = requireRecord(value, "usage");
  rejectUnknownFields(usage, USAGE_FIELDS, "usage");
  if (usage.version !== 1) throw new Error("Economics ledger usage version must be 1.");
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens"] as const) {
    requireNonNegativeInteger(usage[field], `usage.${field}`);
  }
}

function requirePricing(value: unknown): void {
  const pricing = requireRecord(value, "pricing");
  rejectUnknownFields(pricing, PRICING_FIELDS, "pricing");
  if (pricing.version !== 1) throw new Error("Economics ledger pricing version must be 1.");
  if (pricing.status === "unpriced") {
    if (pricing.reason !== "model_profile_unavailable" && pricing.reason !== "model_profile_mismatch" && pricing.reason !== "price_unavailable") {
      throw new Error("Economics ledger unpriced reason is invalid.");
    }
    return;
  }
  if (pricing.status !== "priced" || pricing.currency !== "USD") {
    throw new Error("Economics ledger pricing status or currency is invalid.");
  }
  requireString(pricing.priceVersion, "pricing.priceVersion");
  requireString(pricing.sourceUrl, "pricing.sourceUrl");
  requireNonNegativeNumber(pricing.totalCostUsd, "pricing.totalCostUsd");
  if (Array.isArray(pricing.components) === false) throw new Error("Economics ledger pricing.components must be an array.");
  for (const [index, value] of pricing.components.entries()) {
    const component = requireRecord(value, `pricing.components[${index}]`);
    rejectUnknownFields(component, PRICE_COMPONENT_FIELDS, `pricing.components[${index}]`);
    if (component.category !== "input" && component.category !== "output" && component.category !== "cached_input" && component.category !== "cache_write" && component.category !== "reasoning") {
      throw new Error(`Economics ledger pricing.components[${index}].category is invalid.`);
    }
    requireNonNegativeInteger(component.tokens, `pricing.components[${index}].tokens`);
    requireNonNegativeNumber(component.ratePerMillionTokens, `pricing.components[${index}].ratePerMillionTokens`);
    requireNonNegativeNumber(component.costUsd, `pricing.components[${index}].costUsd`);
  }
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((field) => allowed.has(field) === false);
  if (unknown !== undefined) throw new Error(`Economics ledger ${label} contains unknown field '${unknown}'.`);
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortValue(record[key])]));
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Economics ledger event ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Economics ledger event ${field} must be a non-empty string.`);
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (/^[a-f0-9]{64}$/u.test(parsed) === false) {
    throw new Error(`Economics ledger event ${field} must be a SHA-256 digest.`);
  }
  return parsed;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = requireNonNegativeInteger(value, field);
  if (parsed === 0) throw new Error(`Economics ledger event ${field} must be positive.`);
  return parsed;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isSafeInteger(value) === false || value < 0) {
    throw new Error(`Economics ledger event ${field} must be a non-negative safe integer.`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isFinite(value) === false || value < 0) {
    throw new Error(`Economics ledger event ${field} must be a non-negative finite number.`);
  }
  return value;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
