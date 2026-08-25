import type {
  AgentToolAuditRecord,
  AgentToolPresentation,
  AgentToolResult,
} from "./model-io.js";
import type { RunToolPhase } from "./events.js";
import {
  canonicalJson,
  parseToolActivationRefV1,
  type ToolActivationRefV1,
} from "./tool-contract.js";
import { parseRunnerExternalApprovalBindingV1, type RunnerExternalApprovalBindingV1 } from "@kestrel-agents/protocol";

export const PREPARED_TOOL_CALL_VERSION = "v1" as const;
export const TOOL_EXECUTION_OUTCOME_VERSION = "v1" as const;
export const AGENT_TOOL_RESULT_VERSION = "v2" as const;
export const RUN_TOOL_UPDATE_VERSION = "v2" as const;

export interface ResolvedModelToolIntentV1 {
  version: "v1";
  modelToolCallId: string;
  snapshotId: string;
  activation: ToolActivationRefV1;
  rawInput: Record<string, unknown>;
}

export type PreparedToolCallOriginV1 =
  | {
      kind: "model";
      snapshotId: string;
      modelToolCallId: string;
    }
  | {
      kind: "trusted_runtime";
      producerId: string;
      adapterId: string;
    };

export interface PreparedToolPolicyDispositionV1 {
  decision: "allow" | "deny" | "approval_required";
  policyRevision: string;
  reasonCode?: string | undefined;
}

export interface PreparedToolApprovalAuthorityV1 {
  authorityRevision: string;
  approvalId?: string | undefined;
  externalApprovalBinding?: RunnerExternalApprovalBindingV1 | undefined;
}

export interface PreparedToolInputAdapterV1 {
  adapterId: string;
  metadata: Record<string, unknown>;
}

export interface PreparedToolCallV1 {
  version: typeof PREPARED_TOOL_CALL_VERSION;
  runId: string;
  sessionId: string;
  callId: string;
  activation: ToolActivationRefV1;
  origin: PreparedToolCallOriginV1;
  effectiveInput: Record<string, unknown>;
  inputAdapters: PreparedToolInputAdapterV1[];
  policy: PreparedToolPolicyDispositionV1;
  approval?: PreparedToolApprovalAuthorityV1 | undefined;
  preparedAt: string;
}

export type ToolExternalEffectStateV1 =
  | "not_applicable"
  | "not_started"
  | "committed"
  | "unknown";

interface ToolExecutionOutcomeBaseV1 {
  version: typeof TOOL_EXECUTION_OUTCOME_VERSION;
  callId: string;
  activation: ToolActivationRefV1;
  startedAt: string;
  completedAt: string;
  effectState: ToolExternalEffectStateV1;
}

export type ToolExecutionOutcomeV1 =
  | (ToolExecutionOutcomeBaseV1 & {
      kind: "success";
      rawOutput: unknown;
    })
  | (ToolExecutionOutcomeBaseV1 & {
      kind: "partial";
      rawOutput: unknown;
      normalizedFailureCode: string;
      retryable: boolean;
    })
  | (ToolExecutionOutcomeBaseV1 & {
      kind: "failure";
      normalizedFailureCode: string;
      retryable: boolean;
      error: { message: string; details?: Record<string, unknown> | undefined };
    })
  | (ToolExecutionOutcomeBaseV1 & {
      kind: "cancellation";
      normalizedFailureCode: "TOOL_CANCELLED";
      retryable: false;
    });

export interface AgentToolResultV2 extends AgentToolResult {
  version: typeof AGENT_TOOL_RESULT_VERSION;
  toolCallId: string;
  activation: ToolActivationRefV1;
  outcome: ToolExecutionOutcomeV1;
}

export interface RunToolUpdateV2 {
  version: typeof RUN_TOOL_UPDATE_VERSION;
  runId: string;
  sessionId: string;
  ts: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  activation: ToolActivationRefV1;
  phase: RunToolPhase;
  stepIndex?: number | undefined;
  stepAgent?: string | undefined;
  displayName?: string | undefined;
  toolFamily?: string | undefined;
  provider?: string | undefined;
  outcome?: ToolExecutionOutcomeV1 | undefined;
  input?: unknown;
  output?: unknown;
  error?: {
    code?: string | undefined;
    message: string;
    details?: Record<string, unknown> | undefined;
  } | undefined;
  durationMs?: number | undefined;
  presentation?: AgentToolPresentation | undefined;
}

const PREPARED_KEYS = new Set([
  "version",
  "runId",
  "sessionId",
  "callId",
  "activation",
  "origin",
  "effectiveInput",
  "inputAdapters",
  "policy",
  "approval",
  "preparedAt",
]);
const ORIGIN_KEYS = new Set([
  "kind",
  "snapshotId",
  "modelToolCallId",
  "producerId",
  "adapterId",
]);
const POLICY_KEYS = new Set([
  "decision",
  "policyRevision",
  "reasonCode",
]);
const APPROVAL_KEYS = new Set([
  "authorityRevision",
  "approvalId",
  "externalApprovalBinding",
]);
const INPUT_ADAPTER_KEYS = new Set(["adapterId", "metadata"]);
const OUTCOME_KEYS = new Set([
  "version",
  "callId",
  "activation",
  "kind",
  "startedAt",
  "completedAt",
  "effectState",
  "rawOutput",
  "normalizedFailureCode",
  "retryable",
  "error",
]);
const ERROR_KEYS = new Set(["message", "details"]);
const AGENT_RESULT_KEYS = new Set([
  "version",
  "toolName",
  "status",
  "toolCallId",
  "activation",
  "outcome",
  "modelContext",
  "auditRecord",
  "projections",
  "presentation",
]);
const MODEL_CONTEXT_KEYS = new Set(["text", "rawOutputRef", "truncated"]);
const AUDIT_KEYS = new Set([
  "toolName",
  "input",
  "output",
  "error",
  "startedAt",
  "completedAt",
  "durationMs",
  "status",
]);
const RUN_UPDATE_KEYS = new Set([
  "version",
  "runId",
  "sessionId",
  "ts",
  "seq",
  "toolCallId",
  "toolName",
  "activation",
  "phase",
  "stepIndex",
  "stepAgent",
  "displayName",
  "toolFamily",
  "provider",
  "outcome",
  "input",
  "output",
  "error",
  "durationMs",
  "presentation",
]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function parsePreparedToolCallV1(value: unknown): PreparedToolCallV1 {
  const input = record(value, "prepared tool call");
  rejectUnknown(input, PREPARED_KEYS, "prepared tool call");
  if (input.version !== PREPARED_TOOL_CALL_VERSION) {
    throw new Error("prepared tool call.version must be 'v1'");
  }
  const originInput = record(input.origin, "prepared tool call.origin");
  rejectUnknown(originInput, ORIGIN_KEYS, "prepared tool call.origin");
  const origin: PreparedToolCallOriginV1 =
    originInput.kind === "model"
      ? {
          kind: "model",
          snapshotId: hash(originInput.snapshotId, "prepared tool call.origin.snapshotId"),
          modelToolCallId: stringValue(
            originInput.modelToolCallId,
            "prepared tool call.origin.modelToolCallId",
          ),
        }
      : originInput.kind === "trusted_runtime"
        ? {
            kind: "trusted_runtime",
            producerId: stringValue(
              originInput.producerId,
              "prepared tool call.origin.producerId",
            ),
            adapterId: stringValue(
              originInput.adapterId,
              "prepared tool call.origin.adapterId",
            ),
          }
        : (() => {
            throw new Error("prepared tool call.origin.kind is invalid");
          })();
  const policyInput = record(input.policy, "prepared tool call.policy");
  rejectUnknown(policyInput, POLICY_KEYS, "prepared tool call.policy");
  if (
    policyInput.decision !== "allow" &&
    policyInput.decision !== "deny" &&
    policyInput.decision !== "approval_required"
  ) {
    throw new Error("prepared tool call.policy.decision is invalid");
  }
  const policy: PreparedToolPolicyDispositionV1 = {
    decision: policyInput.decision,
    policyRevision: hash(
      policyInput.policyRevision,
      "prepared tool call.policy.policyRevision",
    ),
    ...(policyInput.reasonCode === undefined
      ? {}
      : {
          reasonCode: stringValue(
            policyInput.reasonCode,
            "prepared tool call.policy.reasonCode",
          ),
        }),
  };
  const approval = input.approval === undefined
    ? undefined
    : parseApproval(input.approval);
  if (input.inputAdapters !== undefined && !Array.isArray(input.inputAdapters)) {
    throw new Error("prepared tool call.inputAdapters must be an array");
  }
  const seenAdapterIds = new Set<string>();
  const inputAdapters = (input.inputAdapters ?? []).map((value, index) => {
    const adapter = record(value, `prepared tool call.inputAdapters[${index}]`);
    rejectUnknown(
      adapter,
      INPUT_ADAPTER_KEYS,
      `prepared tool call.inputAdapters[${index}]`,
    );
    const adapterId = stringValue(
      adapter.adapterId,
      `prepared tool call.inputAdapters[${index}].adapterId`,
    );
    if (seenAdapterIds.has(adapterId)) {
      throw new Error(`prepared tool call.inputAdapters contains duplicate adapter '${adapterId}'`);
    }
    seenAdapterIds.add(adapterId);
    return {
      adapterId,
      metadata: jsonRecord(
        adapter.metadata,
        `prepared tool call.inputAdapters[${index}].metadata`,
      ),
    };
  });
  return freeze({
    version: PREPARED_TOOL_CALL_VERSION,
    runId: stringValue(input.runId, "prepared tool call.runId"),
    sessionId: stringValue(input.sessionId, "prepared tool call.sessionId"),
    callId: stringValue(input.callId, "prepared tool call.callId"),
    activation: parseToolActivationRefV1(input.activation),
    origin,
    effectiveInput: jsonRecord(
      input.effectiveInput,
      "prepared tool call.effectiveInput",
    ),
    inputAdapters,
    policy,
    ...(approval === undefined ? {} : { approval }),
    preparedAt: timestamp(input.preparedAt, "prepared tool call.preparedAt"),
  });
}

export function parseToolExecutionOutcomeV1(
  value: unknown,
): ToolExecutionOutcomeV1 {
  const input = record(value, "tool execution outcome");
  rejectUnknown(input, OUTCOME_KEYS, "tool execution outcome");
  if (input.version !== TOOL_EXECUTION_OUTCOME_VERSION) {
    throw new Error("tool execution outcome.version must be 'v1'");
  }
  const effectState = input.effectState;
  if (
    effectState !== "not_applicable" &&
    effectState !== "not_started" &&
    effectState !== "committed" &&
    effectState !== "unknown"
  ) {
    throw new Error("tool execution outcome.effectState is invalid");
  }
  const base: ToolExecutionOutcomeBaseV1 = {
    version: TOOL_EXECUTION_OUTCOME_VERSION,
    callId: stringValue(input.callId, "tool execution outcome.callId"),
    activation: parseToolActivationRefV1(input.activation),
    startedAt: timestamp(input.startedAt, "tool execution outcome.startedAt"),
    completedAt: timestamp(
      input.completedAt,
      "tool execution outcome.completedAt",
    ),
    effectState,
  };
  if (input.kind === "success") {
    requirePresent(input, "rawOutput", "tool execution outcome");
    return freeze({ ...base, kind: "success", rawOutput: json(input.rawOutput) });
  }
  if (input.kind === "partial") {
    requirePresent(input, "rawOutput", "tool execution outcome");
    const retryable = booleanValue(
      input.retryable,
      "tool execution outcome.retryable",
    );
    rejectCommittedRetry(effectState, retryable);
    return freeze({
      ...base,
      kind: "partial",
      rawOutput: json(input.rawOutput),
      normalizedFailureCode: stringValue(
        input.normalizedFailureCode,
        "tool execution outcome.normalizedFailureCode",
      ),
      retryable,
    });
  }
  if (input.kind === "failure") {
    const error = record(input.error, "tool execution outcome.error");
    rejectUnknown(error, ERROR_KEYS, "tool execution outcome.error");
    const retryable = booleanValue(
      input.retryable,
      "tool execution outcome.retryable",
    );
    rejectCommittedRetry(effectState, retryable);
    return freeze({
      ...base,
      kind: "failure",
      normalizedFailureCode: stringValue(
        input.normalizedFailureCode,
        "tool execution outcome.normalizedFailureCode",
      ),
      retryable,
      error: {
        message: stringValue(error.message, "tool execution outcome.error.message"),
        ...(error.details === undefined
          ? {}
          : { details: jsonRecord(error.details, "tool execution outcome.error.details") }),
      },
    });
  }
  if (input.kind === "cancellation") {
    if (input.normalizedFailureCode !== "TOOL_CANCELLED" || input.retryable !== false) {
      throw new Error("tool execution cancellation must be TOOL_CANCELLED and terminal");
    }
    return freeze({
      ...base,
      kind: "cancellation",
      normalizedFailureCode: "TOOL_CANCELLED",
      retryable: false,
    });
  }
  throw new Error("tool execution outcome.kind is invalid");
}

export function parseAgentToolResultV2(value: unknown): AgentToolResultV2 {
  const input = record(value, "agent tool result v2");
  rejectUnknown(input, AGENT_RESULT_KEYS, "agent tool result v2");
  if (input.version !== AGENT_TOOL_RESULT_VERSION) {
    throw new Error("agent tool result v2.version must be 'v2'");
  }
  const toolName = stringValue(input.toolName, "agent tool result v2.toolName");
  const toolCallId = stringValue(
    input.toolCallId,
    "agent tool result v2.toolCallId",
  );
  const activation = parseToolActivationRefV1(input.activation);
  const outcome = parseToolExecutionOutcomeV1(input.outcome);
  if (
    activation.descriptor.toolId !== toolName ||
    outcome.activation.descriptor.contractRevision !==
      activation.descriptor.contractRevision ||
    outcome.callId !== toolCallId
  ) {
    throw new Error("agent tool result v2 evidence identities do not agree");
  }
  const modelContextInput = record(
    input.modelContext,
    "agent tool result v2.modelContext",
  );
  rejectUnknown(
    modelContextInput,
    MODEL_CONTEXT_KEYS,
    "agent tool result v2.modelContext",
  );
  const auditInput = record(input.auditRecord, "agent tool result v2.auditRecord");
  rejectUnknown(auditInput, AUDIT_KEYS, "agent tool result v2.auditRecord");
  if (auditInput.toolName !== toolName) {
    throw new Error("agent tool result v2.auditRecord.toolName does not agree");
  }
  if (auditInput.status !== "OK" && auditInput.status !== "FAILED") {
    throw new Error("agent tool result v2.auditRecord.status is invalid");
  }
  if (input.status !== auditInput.status) {
    throw new Error("agent tool result v2.status does not agree");
  }
  const status = auditInput.status;
  const result = {
    version: AGENT_TOOL_RESULT_VERSION,
    toolName,
    status,
    toolCallId,
    activation,
    outcome,
    modelContext: {
      text: stringValue(modelContextInput.text, "agent tool result v2.modelContext.text"),
      rawOutputRef: stringValue(
        modelContextInput.rawOutputRef,
        "agent tool result v2.modelContext.rawOutputRef",
      ),
      truncated: booleanValue(
        modelContextInput.truncated,
        "agent tool result v2.modelContext.truncated",
      ),
    },
    auditRecord: jsonRecord(auditInput, "agent tool result v2.auditRecord") as unknown as AgentToolAuditRecord,
    ...(input.projections === undefined
      ? {}
      : { projections: jsonRecord(input.projections, "agent tool result v2.projections") as AgentToolResultV2["projections"] }),
    ...(input.presentation === undefined
      ? {}
      : { presentation: jsonRecord(input.presentation, "agent tool result v2.presentation") as AgentToolPresentation }),
  } satisfies AgentToolResultV2;
  return freeze(result);
}

export function parseRunToolUpdateV2(value: unknown): RunToolUpdateV2 {
  const input = record(value, "run tool update v2");
  rejectUnknown(input, RUN_UPDATE_KEYS, "run tool update v2");
  if (input.version !== RUN_TOOL_UPDATE_VERSION) {
    throw new Error("run tool update v2.version must be 'v2'");
  }
  if (
    input.phase !== "started" &&
    input.phase !== "completed" &&
    input.phase !== "failed"
  ) {
    throw new Error("run tool update v2.phase is invalid");
  }
  const activation = parseToolActivationRefV1(input.activation);
  const toolName = stringValue(input.toolName, "run tool update v2.toolName");
  const toolCallId = stringValue(input.toolCallId, "run tool update v2.toolCallId");
  if (activation.descriptor.toolId !== toolName) {
    throw new Error("run tool update v2 activation does not match toolName");
  }
  const outcome = input.outcome === undefined
    ? undefined
    : parseToolExecutionOutcomeV1(input.outcome);
  if (outcome !== undefined && outcome.callId !== toolCallId) {
    throw new Error("run tool update v2 outcome does not match toolCallId");
  }
  if (input.phase !== "started" && outcome === undefined) {
    throw new Error("terminal run tool update v2 requires an outcome");
  }
  return freeze({
    version: RUN_TOOL_UPDATE_VERSION,
    runId: stringValue(input.runId, "run tool update v2.runId"),
    sessionId: stringValue(input.sessionId, "run tool update v2.sessionId"),
    ts: timestamp(input.ts, "run tool update v2.ts"),
    seq: nonNegativeInteger(input.seq, "run tool update v2.seq"),
    toolCallId,
    toolName,
    activation,
    phase: input.phase,
    ...(input.stepIndex === undefined
      ? {}
      : { stepIndex: nonNegativeInteger(input.stepIndex, "run tool update v2.stepIndex") }),
    ...(input.stepAgent === undefined
      ? {}
      : { stepAgent: stringValue(input.stepAgent, "run tool update v2.stepAgent") }),
    ...(input.displayName === undefined
      ? {}
      : { displayName: stringValue(input.displayName, "run tool update v2.displayName") }),
    ...(input.toolFamily === undefined
      ? {}
      : { toolFamily: stringValue(input.toolFamily, "run tool update v2.toolFamily") }),
    ...(input.provider === undefined
      ? {}
      : { provider: stringValue(input.provider, "run tool update v2.provider") }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(Object.hasOwn(input, "input") ? { input: json(input.input) } : {}),
    ...(Object.hasOwn(input, "output") ? { output: json(input.output) } : {}),
    ...(input.error === undefined
      ? {}
      : { error: jsonRecord(input.error, "run tool update v2.error") as RunToolUpdateV2["error"] }),
    ...(input.durationMs === undefined
      ? {}
      : { durationMs: nonNegativeNumber(input.durationMs, "run tool update v2.durationMs") }),
    ...(input.presentation === undefined
      ? {}
      : { presentation: jsonRecord(input.presentation, "run tool update v2.presentation") as AgentToolPresentation }),
  });
}

function parseApproval(value: unknown): PreparedToolApprovalAuthorityV1 {
  const input = record(value, "prepared tool call.approval");
  rejectUnknown(input, APPROVAL_KEYS, "prepared tool call.approval");
  return {
    authorityRevision: hash(
      input.authorityRevision,
      "prepared tool call.approval.authorityRevision",
    ),
    ...(input.approvalId === undefined
      ? {}
      : { approvalId: stringValue(input.approvalId, "prepared tool call.approval.approvalId") }),
    ...(input.externalApprovalBinding === undefined
      ? {}
      : { externalApprovalBinding: parseRunnerExternalApprovalBindingV1(input.externalApprovalBinding) }),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function jsonRecord(value: unknown, path: string): Record<string, unknown> {
  record(value, path);
  return json(value) as Record<string, unknown>;
}

function json(value: unknown): unknown {
  canonicalJson(value);
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function hash(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (!HASH_PATTERN.test(parsed)) throw new Error(`${path} must be a canonical sha256 digest`);
  return parsed;
}

function timestamp(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${path} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  return value;
}

function rejectCommittedRetry(
  effectState: ToolExternalEffectStateV1,
  retryable: boolean,
): void {
  if (effectState === "committed" && retryable) {
    throw new Error("a committed external effect cannot be retryable");
  }
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown[0] !== undefined) throw new Error(`${path} contains unknown field '${unknown[0]}'`);
}

function requirePresent(
  value: Record<string, unknown>,
  field: string,
  path: string,
): void {
  if (!Object.hasOwn(value, field)) throw new Error(`${path}.${field} is required`);
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}
