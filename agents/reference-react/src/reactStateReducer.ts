import {
  appendEvidenceLedgerEntries,
  buildEvidenceLedgerContext,
  buildPolicyCorrectionEvidenceEntry,
  buildToolEvidenceEntries,
  parseEvidenceLedger,
} from "./evidenceLedger.js";
import { appendToolResultToTranscript } from "../../../src/runtime/modelTranscript.js";
import { unwrapAgentToolOutput } from "../../../tools/toolResult.js";
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
  producedEvidenceIds: string[];
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
      producedEvidenceIds: [entry.id],
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
    producedEvidenceIds: [],
    consumedEvidenceIds: [],
    blockedEvidenceIds: collectBlockingEvidenceIds(parseEvidenceLedger(input.reactState.evidenceLedger)),
  });
}

function applyToolResultEvent(
  reactState: Record<string, unknown>,
  event: Extract<ReactStateEvent, { type: "tool_result_observed" }>,
): ReactStateReducerResult {
  const toolOutput = unwrapAgentToolOutput(event.toolOutput);
  const evidenceEntries = buildToolEvidenceEntries({
    stepIndex: event.stepIndex,
    toolName: event.toolName,
    toolInput: event.toolInput,
    toolOutput,
    inputHash: event.inputHash,
    contextPreviewBytes: event.contextPreviewBytes,
    reused: event.reused,
  });
  const evidenceLedger = appendEvidenceLedgerEntries(reactState, evidenceEntries);
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
      modelTranscript,
      workItem: undefined,
      workItemTransition: undefined,
    },
    eventType: event.type,
    reason: `tool_result_observed:${event.toolName}`,
    producedEvidenceIds: evidenceEntries.map((entry) => entry.id),
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
  producedEvidenceIds: string[];
  consumedEvidenceIds: string[];
  blockedEvidenceIds: string[];
}): ReactStateReducerResult {
  return {
    reactState: input.reactState,
    transition: {
      eventType: input.eventType,
      reason: input.reason,
      producedEvidenceIds: input.producedEvidenceIds,
      consumedEvidenceIds: input.consumedEvidenceIds,
      blockedEvidenceIds: input.blockedEvidenceIds,
    },
  };
}
