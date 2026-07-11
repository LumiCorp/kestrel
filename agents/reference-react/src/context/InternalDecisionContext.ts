import { normalizeRuntimePlanState } from "../../../../src/runtime/planDocument.js";
import { normalizeVisibleTodoState } from "../../../../src/runtime/visibleTodos.js";
import { asArray, asRecord, asString } from "../../../shared/valueAccess.js";
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
  repetitionSignals: undefined;
  recoveryVerdict: undefined;
  evidenceRecoverySummary: Record<string, unknown> | undefined;
}

export function buildInternalDecisionContext(input: {
  reactState: Record<string, unknown>;
  eventPayload: Record<string, unknown>;
}): InternalDecisionContext {
  const evidenceLedger = parseEvidenceLedger(input.reactState.evidenceLedger);
  return {
    devShellProcesses: buildDevShellProcessContext(asRecord(asRecord(input.reactState.exec)?.devShell)),
    managedEntrypoints: [],
    evidenceContext: buildEvidenceLedgerContext({ ledger: evidenceLedger }),
    evidenceLedger,
    visibleTodos: normalizeVisibleTodoState(input.reactState.visibleTodos),
    plan: normalizeRuntimePlanState(input.reactState.plan),
    filesystemInventory: undefined,
    repetitionSignals: undefined,
    recoveryVerdict: undefined,
    evidenceRecoverySummary: asRecord(asRecord(input.reactState.postToolVerification)?.evidenceRecoverySummary),
  };
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
