import type { RunEvent } from "../kestrel/contracts/events.js";

import type {
  FailureDiagnosticsSummary,
  InternetReliabilitySignal,
  RunDiagnosticsView,
} from "./contracts.js";

export function buildRunDiagnosticsView(input: {
  runId: string;
  sessionId?: string | undefined;
  terminalStatus?: string | undefined;
  events: RunEvent[];
}): RunDiagnosticsView {
  const stepMap = new Map<string, { stepIndex: number; events: number; errors: number; waits: number }>();
  const toolCounter = new Map<string, number>();
  const errorCounter = new Map<string, number>();
  const internetSignals = new Map<string, InternetReliabilitySignal>();
  let interactionMode: string | undefined;
  let executionLane: string | undefined;
  let routeReason: string | undefined;
  let routeConfidence: number | undefined;
  let allowedToolClasses: string[] = [];
  let requiredToolClasses: string[] = [];
  let blockedByMode = false;
  let toolUseIntent: string | undefined;
  let toolIntentObjective: string | undefined;
  let candidateTools: Array<{ name: string; allowlisted: boolean }> = [];
  let plannerAction: string | undefined;
  let plannerToolName: string | undefined;
  let requiredCapabilities: string[] = [];
  let finalizeBlocked = false;
  let failureSummary: FailureDiagnosticsSummary | undefined;

  for (const event of input.events) {
    const stepFromMeta = asString(event.metadata?.step) ?? asString(event.metadata?.stepAgent);
    const step = stepFromMeta ?? "unknown";
    const stepIndex = typeof event.stepIndex === "number" ? event.stepIndex : -1;
    const state = stepMap.get(step) ?? { stepIndex, events: 0, errors: 0, waits: 0 };
    state.events += 1;
    if (event.level === "ERROR") {
      state.errors += 1;
      errorCounter.set(event.type, (errorCounter.get(event.type) ?? 0) + 1);
    }
    if (event.type.includes("wait")) {
      state.waits += 1;
    }
    stepMap.set(step, state);

    const toolName = asString(event.metadata?.toolName);
    if (toolName !== undefined) {
      toolCounter.set(toolName, (toolCounter.get(toolName) ?? 0) + 1);
    }

    if (event.type === "route.decision") {
      interactionMode = asString(event.metadata?.interactionMode) ?? interactionMode;
      executionLane =
        asString(event.metadata?.executionLane) ??
        asString(event.metadata?.selectedLane) ??
        executionLane;
      routeReason = asString(event.metadata?.reasonCode) ?? routeReason;
      routeConfidence =
        typeof event.metadata?.confidence === "number" ? event.metadata.confidence : routeConfidence;
      allowedToolClasses = readStringArray(event.metadata?.allowedToolClasses);
      requiredToolClasses = readStringArray(event.metadata?.requiredToolClasses);
      blockedByMode = event.metadata?.blockedByMode === true || blockedByMode;
    }

    if (event.type === "planner.tool_intent_promoted") {
      toolUseIntent = asString(event.metadata?.toolUseIntent) ?? toolUseIntent;
      toolIntentObjective = asString(event.metadata?.objective) ?? toolIntentObjective;
      plannerAction = asString(event.metadata?.chosenActionKind) ?? plannerAction;
      plannerToolName = asString(event.metadata?.chosenToolName) ?? plannerToolName;
      requiredCapabilities = readStringArray(event.metadata?.requiredCapabilities);
      candidateTools = readCandidateTools(event.metadata?.candidateTools);
    }

    if (event.type === "planner.finalize_blocked") {
      finalizeBlocked = true;
      if (requiredCapabilities.length === 0) {
        requiredCapabilities = readStringArray(event.metadata?.missingEvidenceFor);
      }
      if (candidateTools.length === 0) {
        candidateTools = readStringArray(event.metadata?.candidateTools).map((name) => ({
          name,
          allowlisted: true,
        }));
      }
    }

    if (event.type === "tool.retry") {
      const retryToolName = asString(event.metadata?.tool) ?? asString(event.metadata?.toolName);
      const retryAttempt =
        typeof event.metadata?.attempt === "number" && Number.isFinite(event.metadata.attempt)
          ? event.metadata.attempt
          : undefined;
      if (retryToolName !== undefined && retryToolName.startsWith("internet.")) {
        mergeInternetSignal(internetSignals, {
          toolName: retryToolName,
          status: "ok",
          attempts: retryAttempt ?? 2,
        });
      }
    }

    if (event.type === "tool.result_summarized") {
      const signal = parseInternetSignal(event.metadata);
      if (signal !== undefined) {
        mergeInternetSignal(internetSignals, signal);
      }
    }

    if (event.type === "run.failed") {
      const code = asString(event.metadata?.code);
      const message = asString(event.metadata?.message);
      const details = asRecord(event.metadata?.details);
      if (code !== undefined && message !== undefined) {
        failureSummary = {
          code,
          message,
          ...(details !== undefined ? { details } : {}),
          subsystem: resolveFailureSubsystem(code, details),
          classification: resolveFailureClassification(code, details),
        };
      }
    }
  }

  const stepDiagnostics = [...stepMap.entries()]
    .map(([step, item]) => ({
      step,
      stepIndex: item.stepIndex,
      eventCount: item.events,
      errorCount: item.errors,
      waitCount: item.waits,
    }))
    .sort((a, b) => b.eventCount - a.eventCount);

  return {
    runId: input.runId,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.terminalStatus !== undefined ? { terminalStatus: input.terminalStatus } : {}),
    totalEvents: input.events.length,
    ...(stepDiagnostics[0] !== undefined ? { slowestStep: stepDiagnostics[0].step } : {}),
    ...(failureSummary !== undefined ? { failureSummary } : {}),
    ...((interactionMode !== undefined ||
      executionLane !== undefined ||
      routeReason !== undefined ||
      routeConfidence !== undefined ||
      allowedToolClasses.length > 0 ||
      toolUseIntent !== undefined ||
      toolIntentObjective !== undefined ||
      candidateTools.length > 0 ||
      plannerAction !== undefined ||
      plannerToolName !== undefined ||
      requiredCapabilities.length > 0 ||
      requiredToolClasses.length > 0 ||
      blockedByMode ||
      finalizeBlocked)
      ? {
          decisionSummary: {
            ...(interactionMode !== undefined ? { interactionMode } : {}),
            allowedToolClasses,
            ...(executionLane !== undefined ? { executionLane } : {}),
            ...(routeReason !== undefined ? { routeReason } : {}),
            ...(routeConfidence !== undefined ? { routeConfidence } : {}),
            ...(toolUseIntent !== undefined ? { toolUseIntent } : {}),
            ...(toolIntentObjective !== undefined ? { toolIntentObjective } : {}),
            candidateTools,
            ...(plannerAction !== undefined ? { plannerAction } : {}),
            ...(plannerToolName !== undefined ? { plannerToolName } : {}),
            requiredCapabilities,
            requiredToolClasses,
            blockedByMode,
            finalizeBlocked,
          },
        }
      : {}),
    stepDiagnostics,
    errorClusters: [...errorCounter.entries()]
      .map(([eventType, count]) => ({ eventType, count }))
      .sort((a, b) => b.count - a.count),
    toolHotspots: [...toolCounter.entries()]
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((a, b) => b.count - a.count),
    internetSignals: [...internetSignals.values()].sort((a, b) => a.toolName.localeCompare(b.toolName)),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function readCandidateTools(value: unknown): Array<{ name: string; allowlisted: boolean }> {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return ;
      }
      const record = entry as Record<string, unknown>;
      const name = asString(record.name);
      if (name === undefined) {
        return ;
      }
      return {
        name,
        allowlisted: record.allowlisted === true,
      };
    })
    .filter((entry): entry is { name: string; allowlisted: boolean } => entry !== undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function parseInternetSignal(
  metadata: Record<string, unknown> | undefined,
): InternetReliabilitySignal | undefined {
  const record = asRecord(metadata);
  const toolName = asString(record?.toolName);
  if (toolName === undefined || toolName.startsWith("internet.") === false) {
    return ;
  }

  const status = readInternetStatus(record?.status);
  const attempts = readAttempts(record?.attempts);
  const degradedCode = asString(record?.degradedCode);
  const degradedMessage = asString(record?.degradedMessage);
  const retryAfterSeconds = readPositiveNumber(record?.retryAfterSeconds);
  const provider = asString(record?.provider);

  return {
    toolName,
    status: status ?? (degradedCode !== undefined ? "degraded" : "ok"),
    attempts,
    ...(provider !== undefined ? { provider } : {}),
    ...(degradedCode !== undefined ? { degradedCode } : {}),
    ...(degradedMessage !== undefined ? { degradedMessage } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function mergeInternetSignal(
  registry: Map<string, InternetReliabilitySignal>,
  candidate: InternetReliabilitySignal,
): void {
  const existing = registry.get(candidate.toolName);
  if (existing === undefined) {
    registry.set(candidate.toolName, candidate);
    return;
  }

  registry.set(candidate.toolName, {
    toolName: candidate.toolName,
    status: candidate.status === "degraded" || existing.status === "degraded" ? "degraded" : "ok",
    attempts: Math.max(existing.attempts, candidate.attempts),
    provider: candidate.provider ?? existing.provider,
    degradedCode: candidate.degradedCode ?? existing.degradedCode,
    degradedMessage: candidate.degradedMessage ?? existing.degradedMessage,
    retryAfterSeconds: candidate.retryAfterSeconds ?? existing.retryAfterSeconds,
  });
}

function readInternetStatus(value: unknown): "ok" | "degraded" | undefined {
  return value === "ok" || value === "degraded" ? value : undefined;
}

function readAttempts(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return value;
  }
  return 1;
}

function readPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false || value < 0) {
    return ;
  }
  return value;
}

function resolveFailureSubsystem(
  code: string,
  details: Record<string, unknown> | undefined,
): FailureDiagnosticsSummary["subsystem"] {
  const explicitSubsystem = asString(details?.subsystem);
  if (
    explicitSubsystem === "react" ||
    explicitSubsystem === "tooling" ||
    explicitSubsystem === "decision" ||
    explicitSubsystem === "runtime"
  ) {
    return explicitSubsystem;
  }
  if (code.startsWith("REACT_")) {
    return "react";
  }
  if (code.startsWith("TOOL_")) {
    return "tooling";
  }
  if (code.startsWith("DECISION_")) {
    return "decision";
  }
  if (code.startsWith("RUN_") || code.startsWith("REGION_") || code.startsWith("EFFECT_")) {
    return "runtime";
  }
  return "unknown";
}

function resolveFailureClassification(
  code: string,
  details: Record<string, unknown> | undefined,
): FailureDiagnosticsSummary["classification"] {
  const explicit = asString(details?.classification);
  if (
    explicit === "recoverable" ||
    explicit === "configuration" ||
    explicit === "determinism" ||
    explicit === "policy" ||
    explicit === "schema" ||
    explicit === "runtime"
  ) {
    return explicit;
  }
  if (code.includes("DETERMINISM")) {
    return "determinism";
  }
  if (code.includes("POLICY")) {
    return "policy";
  }
  if (code.includes("SCHEMA") || code.includes("PARSE")) {
    return "schema";
  }
  if (code.startsWith("TOOL_") || code === "SESSION_BUSY") {
    return "configuration";
  }
  if (code.startsWith("DECISION_")) {
    return "recoverable";
  }
  if (code.startsWith("REACT_") || code.startsWith("STORE_") || code.startsWith("RUN_")) {
    return "runtime";
  }
  return "unknown";
}
