import type { ModelMessage } from "../../kestrel/contracts/model-io.js";
import type {
  HarnessEconomicsPolicyV1,
  ModelEconomicsProfileV1,
} from "../../economics/contracts.js";
import {
  countTextTokens,
  type ExactTokenCounter,
} from "../../economics/tokenCounting.js";
import {
  compactModelTranscript,
  estimateModelTranscriptChars,
  normalizeModelTranscript,
  planModelTranscriptCompaction,
  projectModelTranscriptToolInput,
  readActiveTaskItemIdFromTranscript,
  type ModelTranscript,
  type ModelTranscriptCompactionPlan,
  type ModelTranscriptItem,
} from "../modelTranscript.js";
import { createRuntimeFailure } from "../RuntimeFailure.js";

export interface KestrelAgentCompactionBuildInput {
  sourceItems: ModelTranscriptItem[];
  correction?: KestrelAgentCompactionCorrectionV1 | undefined;
}

export interface KestrelAgentCompactionCorrectionV1 {
  source: "summary_validation" | "semantic_verifier";
  reason: string;
  verifierCategories?:
    | KestrelCompactionSufficiencyVerdictV1["categories"]
    | undefined;
}

export interface KestrelAgentCompactionPlan {
  transcript: ModelTranscript;
  plan: ModelTranscriptCompactionPlan;
  activeTaskItemId?: string | undefined;
  retainedItemIds: string[];
  replacedItemIds: string[];
}

export interface KestrelAgentCompactionPolicyInput {
  transcript: unknown;
  policy?: HarnessEconomicsPolicyV1 | undefined;
  modelProfile?: ModelEconomicsProfileV1 | undefined;
  contextTokens?: number | undefined;
  toolSchemaTokens?: number | undefined;
  providerOverheadTokens?: number | undefined;
}

export interface KestrelAgentCompactedTranscriptInput {
  transcript: unknown;
  summary: unknown;
  plan?: ModelTranscriptCompactionPlan | undefined;
  summarySource?: "model" | "runtime_fallback" | undefined;
  failureCode?: string | undefined;
}

export interface KestrelCompactionSummaryV2 {
  decisions: string[];
  constraints: string[];
  evidence: string[];
  fileState: string[];
  blockers: string[];
  nextActions: string[];
}

export interface KestrelCompactionSufficiencyVerdictV1 {
  version: 1;
  sufficient: boolean;
  categories: {
    decisions: boolean;
    constraints: boolean;
    evidence: boolean;
    fileState: boolean;
    blockers: boolean;
    nextActions: boolean;
  };
  reason: string;
}

export interface KestrelTerminalBenchRepairPromptInput {
  failurePacketPath: string;
  failurePacket: string;
  adapter: string;
  dataset: string;
  taskId?: string | undefined;
}

export type KestrelCompactionSourceUnit =
  | {
      kind:
        | "user"
        | "assistant_text"
        | "correction"
        | "todo_update"
        | "compaction_summary";
      content: string;
    }
  | {
      kind: "tool";
      toolName: string;
      input?: Record<string, unknown> | undefined;
      output?: unknown;
      rawOutputRef?: string | undefined;
      truncated?: boolean | undefined;
    };

const MODEL_TRANSCRIPT_COMPACTION_THRESHOLD_CHARS = 120_000;
const MODEL_TRANSCRIPT_RETAINED_TAIL_ITEMS = 24;
const COMPACTION_FIELDS = new Set([
  "decisions",
  "constraints",
  "evidence",
  "fileState",
  "blockers",
  "nextActions",
]);
const SUFFICIENCY_FIELDS = new Set([
  "version",
  "sufficient",
  "categories",
  "reason",
]);
const SUFFICIENCY_CATEGORY_FIELDS = new Set([
  "decisions",
  "constraints",
  "evidence",
  "fileState",
  "blockers",
  "nextActions",
]);

export const KESTREL_COMPACTION_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: stringArraySchema(),
    constraints: stringArraySchema(),
    evidence: stringArraySchema(),
    fileState: stringArraySchema(),
    blockers: stringArraySchema(),
    nextActions: stringArraySchema(),
  },
  required: [
    "decisions",
    "constraints",
    "evidence",
    "fileState",
    "blockers",
    "nextActions",
  ],
} as const;

export function buildKestrelCompactionSummarySchema(): Record<string, unknown> {
  return KESTREL_COMPACTION_SUMMARY_SCHEMA;
}

export function planKestrelAgentCompaction(
  transcriptInput: unknown,
  activeTaskItemId?: string | undefined,
): KestrelAgentCompactionPlan {
  const transcript = normalizeModelTranscript(transcriptInput);
  if (transcript === undefined) {
    throw createRuntimeFailure(
      "HARNESS_ECONOMICS_COMPACTION_TRANSCRIPT_INVALID",
      "Compaction requires a valid model transcript.",
    );
  }
  const plan = planModelTranscriptCompaction({
    transcript,
    retainedTailItems: MODEL_TRANSCRIPT_RETAINED_TAIL_ITEMS,
    ...(activeTaskItemId !== undefined ? { activeTaskItemId } : {}),
  });
  return {
    transcript,
    plan,
    ...(readActiveTaskItemIdFromTranscript(transcript, activeTaskItemId) !== undefined
      ? {
          activeTaskItemId: readActiveTaskItemIdFromTranscript(transcript, activeTaskItemId),
        }
      : {}),
    retainedItemIds: plan.retainedItems.map((item) => item.id),
    replacedItemIds: plan.replacedItems.map((item) => item.id),
  };
}

export const KESTREL_COMPACTION_SUFFICIENCY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "integer", enum: [1] },
    sufficient: { type: "boolean" },
    categories: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        [...SUFFICIENCY_CATEGORY_FIELDS].map((field) => [
          field,
          { type: "boolean" },
        ]),
      ),
      required: [...SUFFICIENCY_CATEGORY_FIELDS],
    },
    reason: { type: "string" },
  },
  required: ["version", "sufficient", "categories", "reason"],
} as const;

export function buildKestrelAgentCompactionMessages(
  input: KestrelAgentCompactionBuildInput,
): ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: [
        "Summarize the supplied older transcript units for continuation.",
        "Return semantic content only. Kestrel owns task identity, transcript coverage, provenance hashes, and retained history.",
        "Preserve durable user intent, decisions, constraints, completed work, exact current file and result state, evidence, open blockers, and the next useful actions.",
        "Preserve zero-result searches, the chronologically latest successful or failed tool outcomes, exact mutation summaries, and unresolved work.",
        "Do not invent evidence, hidden state, transcript ids, or bookkeeping fields.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Write the complete compact continuation summary now.",
        "Source units:",
        JSON.stringify(buildKestrelCompactionSourceUnits(input.sourceItems)),
      ].join("\n"),
    },
  ];
  if (input.correction !== undefined) {
    messages.push({
      role: "user",
      content: [
        "The previous summary was rejected.",
        "Regenerate a complete replacement from the source units above.",
        `Rejection source: ${input.correction.source}`,
        `Rejection reason: ${input.correction.reason}`,
        ...(input.correction.verifierCategories !== undefined
          ? [
              `Verifier categories: ${JSON.stringify(
                input.correction.verifierCategories,
              )}`,
            ]
          : []),
      ].join("\n"),
    });
  }
  return messages;
}

export function buildKestrelCompactionSourceUnits(
  sourceItems: readonly ModelTranscriptItem[],
): KestrelCompactionSourceUnit[] {
  const toolItemsByCallId = new Map<string, ModelTranscriptItem[]>();
  for (const item of sourceItems) {
    const toolCallId =
      item.kind === "tool_call"
        ? (item.toolCallId ?? item.id)
        : item.kind === "tool_result"
          ? item.toolCallId
          : undefined;
    if (toolCallId === undefined) {
      continue;
    }
    toolItemsByCallId.set(toolCallId, [
      ...(toolItemsByCallId.get(toolCallId) ?? []),
      item,
    ]);
  }

  const emittedToolCallIds = new Set<string>();
  const units: KestrelCompactionSourceUnit[] = [];
  for (const item of sourceItems) {
    const toolCallId =
      item.kind === "tool_call"
        ? (item.toolCallId ?? item.id)
        : item.kind === "tool_result"
          ? item.toolCallId
          : undefined;
    if (toolCallId === undefined) {
      if (item.kind === "tool_result") {
        const compactInput = projectModelTranscriptToolInput(item);
        units.push({
          kind: "tool",
          toolName: item.toolName ?? "unknown",
          ...(compactInput !== undefined ? { input: compactInput } : {}),
          ...(item.toolOutput !== undefined
            ? { output: item.toolOutput }
            : {}),
          ...(item.rawOutputRef !== undefined
            ? { rawOutputRef: item.rawOutputRef }
            : {}),
          ...(item.truncated !== undefined
            ? { truncated: item.truncated }
            : {}),
        });
        continue;
      }
      if (
        item.kind !== "tool_call" &&
        item.content !== undefined
      ) {
        units.push({ kind: item.kind, content: item.content });
      }
      continue;
    }
    if (emittedToolCallIds.has(toolCallId)) {
      continue;
    }
    emittedToolCallIds.add(toolCallId);
    const pair = toolItemsByCallId.get(toolCallId) ?? [item];
    const call = pair.find((candidate) => candidate.kind === "tool_call");
    const result = [...pair]
      .reverse()
      .find((candidate) => candidate.kind === "tool_result");
    const inputItem = call ?? result;
    const compactInput =
      inputItem !== undefined
        ? projectModelTranscriptToolInput(inputItem)
        : undefined;
    units.push({
      kind: "tool",
      toolName: call?.toolName ?? result?.toolName ?? "unknown",
      ...(compactInput !== undefined ? { input: compactInput } : {}),
      ...(result?.toolOutput !== undefined
        ? { output: result.toolOutput }
        : {}),
      ...(result?.rawOutputRef !== undefined
        ? { rawOutputRef: result.rawOutputRef }
        : {}),
      ...(result?.truncated !== undefined
        ? { truncated: result.truncated }
        : {}),
    });
  }
  return units;
}

export function estimateKestrelCompactionSourceTokens(
  sourceItems: readonly ModelTranscriptItem[],
  tokenCounter?: ExactTokenCounter | undefined,
): number {
  return countTextTokens(
    JSON.stringify(buildKestrelCompactionSourceUnits(sourceItems)),
    tokenCounter,
  ).tokens;
}

export function buildKestrelCompactionSufficiencyMessages(input: {
  sourceItems: ModelTranscriptItem[];
  proposedSummary: KestrelCompactionSummaryV2;
}): ModelMessage[] {
  return [
    {
      role: "system",
      content: [
        "Judge whether the proposed compact summary is sufficient to replace the supplied bounded source units.",
        "Check decisions, constraints, evidence, file/workspace state, unresolved blockers, and next actions independently.",
        "Reject invented, weakened, or omitted durable facts. Return only the required JSON verdict.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        sourceUnits: buildKestrelCompactionSourceUnits(input.sourceItems),
        proposedSummary: input.proposedSummary,
      }),
    },
  ];
}

export function shouldCompactKestrelAgentContext(
  input: KestrelAgentCompactionPolicyInput,
): boolean {
  if (
    input.policy !== undefined &&
    input.modelProfile !== undefined &&
    input.contextTokens !== undefined
  ) {
    const availableContextTokens = Math.max(
      0,
      input.modelProfile.contextWindowTokens -
        input.policy.context.outputReserveTokens -
        input.policy.context.safetyReserveTokens -
        Math.max(0, input.toolSchemaTokens ?? 0) -
        Math.max(0, input.providerOverheadTokens ?? 0),
    );
    return input.contextTokens >= availableContextTokens;
  }
  return (
    estimateModelTranscriptChars(input.transcript) >=
    MODEL_TRANSCRIPT_COMPACTION_THRESHOLD_CHARS
  );
}

export function buildKestrelAgentCompactedTranscript(
  input: KestrelAgentCompactedTranscriptInput,
): ModelTranscript {
  const transcript = normalizeModelTranscript(input.transcript);
  if (transcript === undefined) {
    throw createRuntimeFailure(
      "HARNESS_ECONOMICS_COMPACTION_TRANSCRIPT_INVALID",
      "Compaction requires a valid model transcript.",
    );
  }
  const plan =
    input.plan ??
    planModelTranscriptCompaction({
      transcript,
      retainedTailItems: MODEL_TRANSCRIPT_RETAINED_TAIL_ITEMS,
    });
  const summary = parseKestrelCompactionSummaryV2(input.summary);
  return compactModelTranscript({
    transcript,
    plan,
    summary: renderModelVisibleCompactionSummary(summary),
    categoryCoverage: categoryCoverage(summary),
    summarySource: input.summarySource ?? "model",
    ...(input.failureCode !== undefined
      ? { failureCode: input.failureCode }
      : {}),
  });
}

export function parseKestrelCompactionSufficiencyVerdictV1(
  value: unknown,
): KestrelCompactionSufficiencyVerdictV1 {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  const record = requireRecord(parsed, "compaction sufficiency verdict");
  rejectUnknown(record, SUFFICIENCY_FIELDS, "compaction sufficiency verdict");
  if (record.version !== 1 || typeof record.sufficient !== "boolean") {
    throw compactionFailure("Compaction sufficiency verdict is invalid.", {
      reason: "verifier_response_invalid",
    });
  }
  const categoriesRecord = requireRecord(
    record.categories,
    "compaction sufficiency verdict categories",
  );
  rejectUnknown(
    categoriesRecord,
    SUFFICIENCY_CATEGORY_FIELDS,
    "compaction sufficiency verdict categories",
  );
  const categories = Object.fromEntries(
    [...SUFFICIENCY_CATEGORY_FIELDS].map((field) => {
      if (typeof categoriesRecord[field] !== "boolean") {
        throw compactionFailure(
          `Compaction sufficiency category '${field}' must be boolean.`,
          { reason: "verifier_response_invalid" },
        );
      }
      return [field, categoriesRecord[field]];
    }),
  ) as KestrelCompactionSufficiencyVerdictV1["categories"];
  const verdict = {
    version: 1 as const,
    sufficient: record.sufficient,
    categories,
    reason: requireString(record.reason, "reason"),
  };
  if (
    !verdict.sufficient ||
    Object.values(verdict.categories).some((covered) => !covered)
  ) {
    throw compactionFailure(
      `Maintenance verifier rejected compaction: ${verdict.reason}`,
      {
        reason: "semantic_verifier_rejected",
        verifierReason: verdict.reason,
        verifierCategories: verdict.categories,
      },
    );
  }
  return verdict;
}

export function parseKestrelCompactionSummaryV2(
  value: unknown,
): KestrelCompactionSummaryV2 {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  const record = requireRecord(parsed, "compaction summary");
  rejectUnknown(record, COMPACTION_FIELDS, "compaction summary");
  return {
    decisions: parseStringArray(record.decisions, "decisions"),
    constraints: parseStringArray(record.constraints, "constraints"),
    evidence: parseStringArray(record.evidence, "evidence"),
    fileState: parseStringArray(record.fileState, "fileState"),
    blockers: parseStringArray(record.blockers, "blockers"),
    nextActions: parseStringArray(record.nextActions, "nextActions"),
  };
}

function renderModelVisibleCompactionSummary(
  summary: KestrelCompactionSummaryV2,
): string {
  return JSON.stringify(summary);
}

function categoryCoverage(
  summary: KestrelCompactionSummaryV2,
): Record<string, number> {
  return {
    activeTask: 1,
    decisions: summary.decisions.length,
    constraints: summary.constraints.length,
    evidence: summary.evidence.length,
    fileState: summary.fileState.length,
    blockers: summary.blockers.length,
    nextActions: summary.nextActions.length,
  };
}

function parseStringArray(value: unknown, field: string): string[] {
  if (Array.isArray(value) === false) {
    throw compactionFailure(`Compaction summary ${field} must be an array.`);
  }
  return [
    ...new Set(value.map((entry) => requireString(entry, `${field} item`))),
  ];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw compactionFailure("Compaction summary must be valid JSON.");
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw compactionFailure(`Compaction summary ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw compactionFailure(
      `Compaction summary ${field} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function rejectUnknown(
  record: Record<string, unknown>,
  fields: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).find(
    (field) => fields.has(field) === false,
  );
  if (unknown !== undefined) {
    throw compactionFailure(
      `Compaction summary ${label} contains unknown field '${unknown}'.`,
    );
  }
}

function compactionFailure(
  message: string,
  details?: Record<string, unknown>,
): Error {
  return createRuntimeFailure(
    "HARNESS_ECONOMICS_COMPACTION_SUMMARY_INVALID",
    message,
    details,
  );
}

function stringArraySchema() {
  return {
    type: "array",
    items: { type: "string" },
  } as const;
}

export function buildKestrelTerminalBenchRepairPrompt(
  input: KestrelTerminalBenchRepairPromptInput,
): string {
  return [
    "You are repairing Kestrel based on a Terminal-Bench failure.",
    "",
    "Rules:",
    "- Inspect the evidence packet first.",
    "- Identify the evidence-backed root cause before editing.",
    "- Patch all related benchmark-backed issues in this iteration.",
    "- Add or update targeted tests for the changed behavior.",
    "- Avoid unrelated refactors, prompt-policy tuning, score tuning, retry-cap changes, or benchmark-specific shortcuts.",
    "- Do not modify Terminal-Bench task data, cached dataset files, result artifacts, run artifacts, verifier output, or benchmark run notes.",
    "- Do not add task-name-specific behavior or special-case a Terminal-Bench task id.",
    "- If the evidence points to Docker, Terminal-Bench infrastructure, or host setup failure, stop and report that classification instead of patching runtime behavior.",
    "- Do not introduce lexical keyword rules, score thresholds, retry caps, fallback rankings, or policy heuristics without explicit user approval.",
    "- Preserve runtime contract invariants and deterministic replay semantics.",
    "",
    `Evidence packet path: ${input.failurePacketPath}`,
    `Benchmark target: adapter=${input.adapter} dataset=${input.dataset} task=${input.taskId ?? "full"}`,
    "",
    input.failurePacket,
  ].join("\n");
}
