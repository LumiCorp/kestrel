import { normalizeRuntimePlanState } from "../../../../src/runtime/planDocument.js";
import { normalizeVisibleTodoState } from "../../../../src/runtime/visibleTodos.js";
import { asArray, asRecord, asString } from "../../../shared/valueAccess.js";
import type { DecisionRepetitionSignals } from "../types.js";
import {
  buildEvidenceLedgerContext,
  parseEvidenceLedger,
} from "../evidenceLedger.js";

export interface InternalDecisionContext {
  devShellProcesses: Record<string, unknown>[];
  managedEntrypoints: [];
  evidenceContext: ReturnType<typeof buildEvidenceLedgerContext>;
  evidenceLedger: ReturnType<typeof parseEvidenceLedger>;
  visibleTodos: ReturnType<typeof normalizeVisibleTodoState>;
  plan: ReturnType<typeof normalizeRuntimePlanState>;
  filesystemInventory: undefined;
  repetitionSignals: DecisionRepetitionSignals | undefined;
  recoveryVerdict: undefined;
  evidenceRecoverySummary: Record<string, unknown> | undefined;
}

export function buildInternalDecisionContext(input: {
  reactState: Record<string, unknown>;
  eventPayload: Record<string, unknown>;
}): InternalDecisionContext {
  const evidenceLedger = parseEvidenceLedger(input.reactState.evidenceLedger);
  const repetitionSignals = buildDecisionRepetitionSignals(input.reactState);
  return {
    devShellProcesses: buildDevShellProcessContext(asRecord(asRecord(input.reactState.exec)?.devShell)),
    managedEntrypoints: [],
    evidenceContext: buildEvidenceLedgerContext({ ledger: evidenceLedger }),
    evidenceLedger,
    visibleTodos: normalizeVisibleTodoState(input.reactState.visibleTodos),
    plan: normalizeRuntimePlanState(input.reactState.plan),
    filesystemInventory: undefined,
    repetitionSignals,
    recoveryVerdict: undefined,
    evidenceRecoverySummary: asRecord(asRecord(input.reactState.postToolVerification)?.evidenceRecoverySummary),
  };
}

function buildDecisionRepetitionSignals(
  reactState: Record<string, unknown>,
): DecisionRepetitionSignals | undefined {
  const lastActionResult = asRecord(reactState.lastActionResult);
  const postToolVerification = asRecord(reactState.postToolVerification);
  const latestEvidenceDelta = asRecord(reactState.latestEvidenceDelta);
  const duplicateResult = asRecord(postToolVerification?.duplicateResult);
  const lastToolName = asString(lastActionResult?.toolName) ?? asString(lastActionResult?.name);
  const lastToolInputHash = asString(lastActionResult?.inputHash);
  const duplicateKind = asString(duplicateResult?.kind);
  const duplicateToolName = asString(duplicateResult?.toolName);
  const duplicateFingerprint = asString(duplicateResult?.fingerprint);
  const duplicateFamily = asString(duplicateResult?.family);
  const duplicateCount = readFiniteNumber(duplicateResult?.duplicateCount);
  const matchedPriorStep = readFiniteNumber(duplicateResult?.matchedPriorStep);
  const lastResultReused = asString(latestEvidenceDelta?.kind) === "duplicate_executed_result" ||
    duplicateKind === "duplicate_executed_result";
  if (
    lastToolName === undefined &&
    lastToolInputHash === undefined &&
    lastResultReused === false &&
    duplicateKind === undefined
  ) {
    return ;
  }
  return {
    ...(lastToolName !== undefined ? { lastToolName } : {}),
    ...(lastToolInputHash !== undefined ? { lastToolInputHash } : {}),
    ...(lastResultReused ? { lastResultReused: true } : {}),
    ...(duplicateKind !== undefined
      ? {
          latestDuplicateResult: {
            kind: duplicateKind,
            ...(duplicateFamily !== undefined ? { family: duplicateFamily } : {}),
            ...(duplicateToolName !== undefined ? { toolName: duplicateToolName } : {}),
            ...(duplicateFingerprint !== undefined ? { fingerprint: duplicateFingerprint } : {}),
            ...(duplicateCount !== undefined ? { duplicateCount } : {}),
            ...(matchedPriorStep !== undefined ? { matchedPriorStep } : {}),
            nonRepeatConstraint: "do_not_repeat_same_tool_input_or_payload",
          },
        }
      : {}),
  };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildDevShellProcessContext(value: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return asArray(value?.processes)
    .map(asRecord)
    .filter((process): process is Record<string, unknown> => process !== undefined)
    .map((process) => {
      const processId = asString(process.processId);
      return {
        ...(processId !== undefined ? { processId } : {}),
        ...(asString(process.status) !== undefined ? { status: asString(process.status) } : {}),
        ...(typeof process.live === "boolean" ? { live: process.live } : {}),
      };
    });
}
