import {
  appendEvidenceLedgerEntries,
  buildEvidenceLedgerContext,
  buildPolicyCorrectionEvidenceEntry,
  buildToolEvidenceEntries,
  parseEvidenceLedger,
} from "./evidenceLedger.js";
import { appendToolResultToTranscript } from "../../../src/runtime/modelTranscript.js";
import { isAgentToolResult, unwrapAgentToolOutput } from "../../../tools/toolResult.js";
import type { ReactAction } from "./types.js";

export type ReactStateEvent =
  | {
      type: "tool_result_observed";
      stepIndex: number;
      toolName: string;
      toolInput: Record<string, unknown>;
      toolOutput: unknown;
      toolCallId?: string | undefined;
      inputHash?: string | undefined;
      contextPreviewBytes?: number | undefined;
      reused?: boolean | undefined;
      workspaceRoot?: string | undefined;
    }
  | {
      type: "policy_correction_observed";
      stepIndex: number;
      reason: string;
      message: string;
      facts?: Record<string, unknown> | undefined;
    }
  | {
      type: "thinker_action_compiled";
      stepIndex: number;
      action: ReactAction;
    };

export interface ReactStateTransition {
  eventType: ReactStateEvent["type"];
  reason: string;
  kind: "tool_result" | "policy_correction" | "control";
  toolName?: string | undefined;
  resultIdentity?: string | undefined;
  producedEvidenceIds: string[];
  novelEvidenceIds: string[];
  duplicateOfEvidenceIds: string[];
  newFactsCount: number;
  consumedEvidenceIds: string[];
  blockedEvidenceIds: string[];
}

export interface ReactStateReducerResult {
  reactState: Record<string, unknown>;
  transition: ReactStateTransition;
}

export function applyReactStateEvent(input: {
  reactState: Record<string, unknown>;
  event: ReactStateEvent;
}): ReactStateReducerResult {
  if (input.event.type === "tool_result_observed") {
    return applyToolResultEvent(input.reactState, input.event);
  }
  if (input.event.type === "policy_correction_observed") {
    const entry = buildPolicyCorrectionEvidenceEntry({
      stepIndex: input.event.stepIndex,
      reason: input.event.reason,
      summary: input.event.message,
      facts: input.event.facts,
    });
    const evidenceLedger = appendEvidenceLedgerEntries(input.reactState, [entry]);
    return buildResult({
      reactState: {
        ...stripLegacyProgressFields(input.reactState),
        evidenceLedger,
        workItem: undefined,
        workItemTransition: undefined,
      },
      eventType: input.event.type,
      reason: input.event.reason,
      kind: "policy_correction",
      producedEvidenceIds: [entry.id],
      novelEvidenceIds: [entry.id],
      duplicateOfEvidenceIds: [],
      newFactsCount: 1,
      consumedEvidenceIds: [],
      blockedEvidenceIds: [entry.id],
    });
  }

  return buildResult({
    reactState: {
      ...stripLegacyProgressFields(input.reactState),
      workItem: undefined,
      workItemTransition: undefined,
    },
    eventType: input.event.type,
    reason: "thinker_action_compiled_no_state_change",
    kind: "control",
    producedEvidenceIds: [],
    novelEvidenceIds: [],
    duplicateOfEvidenceIds: [],
    newFactsCount: 0,
    consumedEvidenceIds: [],
    blockedEvidenceIds: collectBlockingEvidenceIds(parseEvidenceLedger(input.reactState.evidenceLedger)),
  });
}

function applyToolResultEvent(
  reactState: Record<string, unknown>,
  event: Extract<ReactStateEvent, { type: "tool_result_observed" }>,
): ReactStateReducerResult {
  const toolOutput = unwrapAgentToolOutput(event.toolOutput);
  const adapterEvidenceIdentity = isAgentToolResult(event.toolOutput)
    ? event.toolOutput.evidenceIdentity
    : undefined;
  const priorLedger = parseEvidenceLedger(reactState.evidenceLedger);
  const priorIdentityHistory = parseEvidenceIdentityHistory(
    reactState.evidenceIdentityHistory,
    priorLedger,
  );
  const evidenceEntries = buildToolEvidenceEntries({
    stepIndex: event.stepIndex,
    toolName: event.toolName,
    toolInput: event.toolInput,
    toolOutput,
    inputHash: event.inputHash,
    contextPreviewBytes: event.contextPreviewBytes,
    reused: event.reused,
    evidenceIdentity: adapterEvidenceIdentity,
  });
  const novelty = classifyEvidenceNovelty(
    new Set(priorIdentityHistory.map((entry) => entry.resultIdentity)),
    priorLedger,
    evidenceEntries,
    event.reused === true,
  );
  const evidenceLedger = appendEvidenceLedgerEntries(reactState, evidenceEntries);
  const evidenceIdentityHistory = updateEvidenceIdentityHistory(
    priorIdentityHistory,
    evidenceEntries,
  );
  const modelTranscript = appendToolResultToTranscript({
    transcript: reactState.modelTranscript,
    toolName: event.toolName,
    toolInput: event.toolInput,
    toolOutput: event.toolOutput,
    toolCallId: event.toolCallId,
    stepIndex: event.stepIndex,
  });
  return buildResult({
    reactState: {
      ...stripLegacyProgressFields(reactState),
      evidenceLedger,
      evidenceIdentityHistory,
      modelTranscript,
      workItem: undefined,
      workItemTransition: undefined,
    },
    eventType: event.type,
    reason: `tool_result_observed:${event.toolName}`,
    kind: "tool_result",
    toolName: event.toolName,
    resultIdentity: evidenceEntries[0]?.resultIdentity,
    producedEvidenceIds: evidenceEntries.map((entry) => entry.id),
    novelEvidenceIds: novelty.novelEvidenceIds,
    duplicateOfEvidenceIds: novelty.duplicateOfEvidenceIds,
    newFactsCount: novelty.newFactsCount,
    consumedEvidenceIds: [],
    blockedEvidenceIds: collectBlockingEvidenceIds(evidenceLedger),
  });
}

function stripLegacyProgressFields(state: Record<string, unknown>): Record<string, unknown> {
  const {
    workPlan: _workPlan,
    executionLedger: _executionLedger,
    progress: _progress,
    ...rest
  } = state;
  return rest;
}

function collectBlockingEvidenceIds(ledger: ReturnType<typeof parseEvidenceLedger>): string[] {
  return buildEvidenceLedgerContext({ ledger }).successBlockers
    .map((entry) => entry.id)
    .slice(-12);
}

function buildResult(input: {
  reactState: Record<string, unknown>;
  eventType: ReactStateEvent["type"];
  reason: string;
  kind: ReactStateTransition["kind"];
  toolName?: string | undefined;
  resultIdentity?: string | undefined;
  producedEvidenceIds: string[];
  novelEvidenceIds: string[];
  duplicateOfEvidenceIds: string[];
  newFactsCount: number;
  consumedEvidenceIds: string[];
  blockedEvidenceIds: string[];
}): ReactStateReducerResult {
  return {
    reactState: input.reactState,
    transition: {
      eventType: input.eventType,
      reason: input.reason,
      kind: input.kind,
      ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
      ...(input.resultIdentity !== undefined ? { resultIdentity: input.resultIdentity } : {}),
      producedEvidenceIds: input.producedEvidenceIds,
      novelEvidenceIds: input.novelEvidenceIds,
      duplicateOfEvidenceIds: input.duplicateOfEvidenceIds,
      newFactsCount: input.newFactsCount,
      consumedEvidenceIds: input.consumedEvidenceIds,
      blockedEvidenceIds: input.blockedEvidenceIds,
    },
  };
}

function classifyEvidenceNovelty(
  priorIdentities: ReadonlySet<string>,
  priorEntries: ReturnType<typeof parseEvidenceLedger>,
  produced: ReturnType<typeof parseEvidenceLedger>,
  knownDuplicate: boolean,
): {
  novelEvidenceIds: string[];
  duplicateOfEvidenceIds: string[];
  newFactsCount: number;
} {
  const evidenceIdsByIdentity = new Map<string, string[]>();
  for (const entry of priorEntries) {
    if (entry.resultIdentity === undefined) {
      continue;
    }
    const ids = evidenceIdsByIdentity.get(entry.resultIdentity) ?? [];
    ids.push(entry.id);
    evidenceIdsByIdentity.set(entry.resultIdentity, ids);
  }
  const novelEvidenceIds: string[] = [];
  const duplicateOfEvidenceIds = new Set<string>();
  const novelIdentities = new Set<string>();
  for (const entry of produced) {
    const identity = entry.resultIdentity;
    if (identity === undefined) {
      if (knownDuplicate === false) {
        novelEvidenceIds.push(entry.id);
      }
      continue;
    }
    if (
      knownDuplicate === false &&
      priorIdentities.has(identity) === false &&
      novelIdentities.has(identity) === false
    ) {
      novelIdentities.add(identity);
      novelEvidenceIds.push(entry.id);
    } else {
      for (const evidenceId of evidenceIdsByIdentity.get(identity) ?? []) {
        duplicateOfEvidenceIds.add(evidenceId);
      }
    }
    const ids = evidenceIdsByIdentity.get(identity) ?? [];
    ids.push(entry.id);
    evidenceIdsByIdentity.set(identity, ids);
  }
  return {
    novelEvidenceIds,
    duplicateOfEvidenceIds: [...duplicateOfEvidenceIds],
    newFactsCount: novelIdentities.size +
      (knownDuplicate === false
        ? produced.filter((entry) => entry.resultIdentity === undefined).length
        : 0),
  };
}

interface EvidenceIdentityHistoryEntry {
  resultIdentity: string;
  kind: string;
  status: string;
  target?: {
    type: string;
    value: string;
  } | undefined;
  revision?: string | undefined;
  claimImpact?: {
    success: string;
    scope: string;
    target?: string | undefined;
    requirementIds: string[];
  } | undefined;
}

function parseEvidenceIdentityHistory(
  value: unknown,
  legacyLedger: ReturnType<typeof parseEvidenceLedger>,
): EvidenceIdentityHistoryEntry[] {
  const byIdentity = new Map<string, EvidenceIdentityHistoryEntry>();
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseEvidenceIdentityHistoryEntry(item);
      if (parsed !== undefined) {
        byIdentity.set(parsed.resultIdentity, parsed);
      }
    }
  }
  for (const entry of legacyLedger) {
    const parsed = buildEvidenceIdentityHistoryEntry(entry);
    if (parsed !== undefined && byIdentity.has(parsed.resultIdentity) === false) {
      byIdentity.set(parsed.resultIdentity, parsed);
    }
  }
  return [...byIdentity.values()]
    .sort((left, right) => left.resultIdentity.localeCompare(right.resultIdentity));
}

function updateEvidenceIdentityHistory(
  prior: EvidenceIdentityHistoryEntry[],
  produced: ReturnType<typeof parseEvidenceLedger>,
): EvidenceIdentityHistoryEntry[] {
  const byIdentity = new Map(prior.map((entry) => [entry.resultIdentity, entry]));
  for (const entry of produced) {
    const semantic = buildEvidenceIdentityHistoryEntry(entry);
    if (semantic !== undefined) {
      byIdentity.set(semantic.resultIdentity, semantic);
    }
  }
  return [...byIdentity.values()]
    .sort((left, right) => left.resultIdentity.localeCompare(right.resultIdentity));
}

function buildEvidenceIdentityHistoryEntry(
  entry: ReturnType<typeof parseEvidenceLedger>[number],
): EvidenceIdentityHistoryEntry | undefined {
  if (entry.resultIdentity === undefined) {
    return undefined;
  }
  const revision = firstString(
    entry.facts.revision,
    entry.facts.contentRevision,
    entry.facts.expectedRevision,
  );
  return {
    resultIdentity: entry.resultIdentity,
    kind: entry.kind,
    status: entry.status,
    ...(entry.target !== undefined
      ? {
          target: {
            type: entry.target.type,
            value: entry.target.normalizedValue ?? entry.target.value,
          },
        }
      : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(entry.claimImpact !== undefined
      ? {
          claimImpact: {
            success: entry.claimImpact.success,
            scope: entry.claimImpact.scope,
            ...(entry.claimImpact.target !== undefined
              ? { target: entry.claimImpact.target }
              : {}),
            requirementIds: [...(entry.claimImpact.requirementIds ?? [])].sort(),
          },
        }
      : {}),
  };
}

function parseEvidenceIdentityHistoryEntry(
  value: unknown,
): EvidenceIdentityHistoryEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const resultIdentity = firstString(record.resultIdentity);
  const kind = firstString(record.kind);
  const status = firstString(record.status);
  if (resultIdentity === undefined || kind === undefined || status === undefined) {
    return undefined;
  }
  const targetRecord = typeof record.target === "object" &&
      record.target !== null &&
      !Array.isArray(record.target)
    ? record.target as Record<string, unknown>
    : undefined;
  const targetType = firstString(targetRecord?.type);
  const targetValue = firstString(targetRecord?.value);
  const impactRecord = typeof record.claimImpact === "object" &&
      record.claimImpact !== null &&
      !Array.isArray(record.claimImpact)
    ? record.claimImpact as Record<string, unknown>
    : undefined;
  const impactSuccess = firstString(impactRecord?.success);
  const impactScope = firstString(impactRecord?.scope);
  return {
    resultIdentity,
    kind,
    status,
    ...(targetType !== undefined && targetValue !== undefined
      ? { target: { type: targetType, value: targetValue } }
      : {}),
    ...(firstString(record.revision) !== undefined
      ? { revision: firstString(record.revision) }
      : {}),
    ...(impactSuccess !== undefined && impactScope !== undefined
      ? {
          claimImpact: {
            success: impactSuccess,
            scope: impactScope,
            ...(firstString(impactRecord?.target) !== undefined
              ? { target: firstString(impactRecord?.target) }
              : {}),
            requirementIds: Array.isArray(impactRecord?.requirementIds)
              ? impactRecord.requirementIds
                  .map((item) => firstString(item))
                  .filter((item): item is string => item !== undefined)
                  .sort()
              : [],
          },
        }
      : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
