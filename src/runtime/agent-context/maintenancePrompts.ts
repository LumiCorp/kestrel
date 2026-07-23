import type { ModelMessage } from "../../kestrel/contracts/model-io.js";
import {
  compactModelTranscript,
  estimateModelTranscriptChars,
  normalizeModelTranscript,
  planModelTranscriptCompaction,
  readActiveTaskItemIdFromTranscript,
  type ModelTranscriptItem,
  type ModelTranscript,
} from "../modelTranscript.js";
import { createRuntimeFailure } from "../RuntimeFailure.js";
import type { HarnessEconomicsPolicyV1, ModelEconomicsProfileV1 } from "../../economics/contracts.js";

export interface KestrelAgentCompactionBuildInput {
  contextMessages: ModelMessage[];
  activeTaskItemId: string;
  replacedItemIds: string[];
  sourceItems?: ModelTranscriptItem[] | undefined;
}

export interface KestrelAgentCompactionPlan {
  transcript: ModelTranscript;
  activeTaskItemId: string;
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
}

export interface KestrelCompactionAnchorV1 {
  text: string;
  sourceItemIds: string[];
}

export interface KestrelCompactionSummaryV1 {
  version: 1;
  activeTaskItemId: string;
  decisions: KestrelCompactionAnchorV1[];
  constraints: KestrelCompactionAnchorV1[];
  evidence: KestrelCompactionAnchorV1[];
  fileState: KestrelCompactionAnchorV1[];
  blockers: KestrelCompactionAnchorV1[];
  nextActions: KestrelCompactionAnchorV1[];
  coveredItemIds: string[];
}

export interface KestrelCompactionSufficiencyVerdictV1 {
  version: 1;
  sufficient: boolean;
  categories: {
    activeTask: boolean;
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

const MODEL_TRANSCRIPT_COMPACTION_THRESHOLD_CHARS = 120_000;
const MODEL_TRANSCRIPT_RETAINED_TAIL_ITEMS = 24;
const COMPACTION_FIELDS = new Set(["version", "activeTaskItemId", "decisions", "constraints", "evidence", "fileState", "blockers", "nextActions", "coveredItemIds"]);
const COMPACTION_ANCHOR_FIELDS = new Set(["text", "sourceItemIds"]);
const SUFFICIENCY_FIELDS = new Set(["version", "sufficient", "categories", "reason"]);
const SUFFICIENCY_CATEGORY_FIELDS = new Set(["activeTask", "decisions", "constraints", "evidence", "fileState", "blockers", "nextActions"]);

export const KESTREL_COMPACTION_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "integer", enum: [1] },
    activeTaskItemId: { type: "string" },
    decisions: anchorArraySchema(),
    constraints: anchorArraySchema(),
    evidence: anchorArraySchema(),
    fileState: anchorArraySchema(),
    blockers: anchorArraySchema(),
    nextActions: anchorArraySchema(),
    coveredItemIds: { type: "array", items: { type: "string" } },
  },
  required: ["version", "activeTaskItemId", "decisions", "constraints", "evidence", "fileState", "blockers", "nextActions", "coveredItemIds"],
} as const;
export function buildKestrelCompactionSummarySchema(
  activeTaskItemId: string,
  replacedItemIds: string[],
): Record<string, unknown> {
  const exactCoveredItemsSchema = replacedItemIds.length === 0
    ? { type: "array", items: { type: "string" }, maxItems: 0 }
    : {
        type: "array",
        items: { type: "string", enum: replacedItemIds },
        minItems: replacedItemIds.length,
        maxItems: replacedItemIds.length,
        uniqueItems: true,
      };
  return {
    ...KESTREL_COMPACTION_SUMMARY_SCHEMA,
    properties: {
      ...KESTREL_COMPACTION_SUMMARY_SCHEMA.properties,
      activeTaskItemId: { type: "string", enum: [activeTaskItemId] },
      coveredItemIds: exactCoveredItemsSchema,
    },
  };
}

export function planKestrelAgentCompaction(transcriptInput: unknown): KestrelAgentCompactionPlan {
  const transcript = normalizeModelTranscript(transcriptInput);
  if (transcript === undefined) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_COMPACTION_TRANSCRIPT_INVALID", "Compaction requires a valid model transcript.");
  }
  const plan = planModelTranscriptCompaction({
    transcript,
    retainedTailItems: MODEL_TRANSCRIPT_RETAINED_TAIL_ITEMS,
  });
  const activeTaskItemId = readActiveTaskItemIdFromTranscript(transcript);
  if (activeTaskItemId === undefined) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_COMPACTION_TRANSCRIPT_INVALID", "Compaction requires a retained active task item.");
  }
  return {
    transcript,
    activeTaskItemId,
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
      properties: Object.fromEntries([...SUFFICIENCY_CATEGORY_FIELDS].map((field) => [field, { type: "boolean" }])),
      required: [...SUFFICIENCY_CATEGORY_FIELDS],
    },
    reason: { type: "string" },
  },
  required: ["version", "sufficient", "categories", "reason"],
} as const;

export function buildKestrelAgentCompactionMessages(
  input: KestrelAgentCompactionBuildInput,
): ModelMessage[] {
  return [
    {
      role: "system",
      content: [
        "Summarize the older transcript for continuation.",
        "Preserve durable user intent, completed work, current files/results known from the transcript, open todos or blockers, and the next useful handoff.",
        "Preserve constraint facts, zero-result searches, the chronologically latest successful or failed tool results, exact mutation summaries, open todos, and current blockers.",
        "Set activeTaskItemId to the exact retained active task item id supplied below. Do not select a newer follow-up user item.",
        "Set coveredItemIds to exactly the supplied replaced item ids. Do not include retained item ids.",
        "Every replaced semantic item must appear in at least one semantic anchor sourceItemIds list.",
        "A matched tool_call and tool_result are one semantic unit: cite either item id in the relevant anchor and Kestrel will preserve provenance for the complete pair.",
        "Do not invent evidence or hidden state.",
      ].join("\n"),
    },
    ...input.contextMessages,
    {
      role: "user",
      content: input.sourceItems === undefined || input.sourceItems.length === 0
        ? [
            "Write the compact continuation summary now.",
            `Retained active task item id: ${JSON.stringify(input.activeTaskItemId)}`,
            `Exact replaced item ids: ${JSON.stringify(input.replacedItemIds)}`,
          ].join("\n")
        : [
            "Write the compact continuation summary now.",
            `Retained active task item id: ${JSON.stringify(input.activeTaskItemId)}`,
            `Exact replaced item ids: ${JSON.stringify(input.replacedItemIds)}`,
            "Source transcript items:",
            JSON.stringify(input.sourceItems.map((item) => ({
              id: item.id,
              kind: item.kind,
              toolName: item.toolName,
              toolCallId: item.toolCallId,
              disposition: input.replacedItemIds.includes(item.id) ? "replaced" : "retained",
            }))),
          ].join("\n"),
    },
  ];
}

export function buildKestrelCompactionSufficiencyMessages(input: {
  sourceItems: ModelTranscriptItem[];
  proposedSummary: KestrelCompactionSummaryV1;
}): ModelMessage[] {
  return [
    {
      role: "system",
      content: [
        "Judge whether the proposed compact summary is sufficient to replace the supplied source transcript.",
        "Check active task, decisions, constraints, evidence and provenance, file/workspace state, unresolved blockers, and next actions independently.",
        "Reject invented, weakened, or omitted facts. Return only the required JSON verdict.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({ sourceItems: input.sourceItems, proposedSummary: input.proposedSummary }),
    },
  ];
}

export function shouldCompactKestrelAgentContext(
  input: KestrelAgentCompactionPolicyInput,
): boolean {
  if (
    input.policy?.mode === "enforce" &&
    input.modelProfile !== undefined &&
    input.contextTokens !== undefined
  ) {
    if (
      input.modelProfile.counting.method === "conservative_estimate" &&
      input.policy.counting.allowEstimatedEnforcement === false
    ) {
      return false;
    }
    const availableContextTokens = Math.max(
      0,
      input.modelProfile.contextWindowTokens
        - input.policy.context.outputReserveTokens
        - input.policy.context.safetyReserveTokens
        - Math.max(0, input.toolSchemaTokens ?? 0)
        - Math.max(0, input.providerOverheadTokens ?? 0),
    );
    return input.contextTokens >= availableContextTokens;
  }
  return estimateModelTranscriptChars(input.transcript) >= MODEL_TRANSCRIPT_COMPACTION_THRESHOLD_CHARS;
}

export function buildKestrelAgentCompactedTranscript(
  input: KestrelAgentCompactedTranscriptInput,
): ModelTranscript {
  const compactionPlan = planKestrelAgentCompaction(input.transcript);
  const transcript = compactionPlan.transcript;
  const plan = planModelTranscriptCompaction({
    transcript,
    retainedTailItems: MODEL_TRANSCRIPT_RETAINED_TAIL_ITEMS,
  });
  const summary = normalizeToolPairAnchorProvenance({
    transcript,
    plan,
    summary: parseKestrelCompactionSummaryV1(input.summary),
  });
  validateCompactionSufficiency(transcript, plan, summary);
  return compactModelTranscript({
    transcript,
    summary: renderModelVisibleCompactionSummary(summary),
    retainedTailItems: MODEL_TRANSCRIPT_RETAINED_TAIL_ITEMS,
    categoryCoverage: categoryCoverage(summary),
  });
}

function normalizeToolPairAnchorProvenance(input: {
  transcript: ModelTranscript;
  plan: ReturnType<typeof planModelTranscriptCompaction>;
  summary: KestrelCompactionSummaryV1;
}): KestrelCompactionSummaryV1 {
  const replacedIds = new Set(input.plan.replacedItems.map((item) => item.id));
  const itemsById = new Map(input.transcript.items.map((item) => [item.id, item]));
  const pairIdsByToolCallId = new Map<string, string[]>();
  for (const item of input.transcript.items) {
    const toolCallId = item.kind === "tool_call"
      ? item.toolCallId ?? item.id
      : item.kind === "tool_result"
        ? item.toolCallId
        : undefined;
    if (toolCallId === undefined || replacedIds.has(item.id) === false) {
      continue;
    }
    pairIdsByToolCallId.set(toolCallId, [
      ...(pairIdsByToolCallId.get(toolCallId) ?? []),
      item.id,
    ]);
  }

  const normalizeAnchors = (anchors: KestrelCompactionAnchorV1[]): KestrelCompactionAnchorV1[] => anchors.map((anchor) => {
    const sourceItemIds = new Set(anchor.sourceItemIds);
    for (const sourceItemId of anchor.sourceItemIds) {
      const item = itemsById.get(sourceItemId);
      const toolCallId = item?.kind === "tool_call"
        ? item.toolCallId ?? item.id
        : item?.kind === "tool_result"
          ? item.toolCallId
          : undefined;
      if (toolCallId === undefined) {
        continue;
      }
      for (const pairItemId of pairIdsByToolCallId.get(toolCallId) ?? []) {
        sourceItemIds.add(pairItemId);
      }
    }
    return { ...anchor, sourceItemIds: [...sourceItemIds] };
  });

  return {
    ...input.summary,
    decisions: normalizeAnchors(input.summary.decisions),
    constraints: normalizeAnchors(input.summary.constraints),
    evidence: normalizeAnchors(input.summary.evidence),
    fileState: normalizeAnchors(input.summary.fileState),
    blockers: normalizeAnchors(input.summary.blockers),
    nextActions: normalizeAnchors(input.summary.nextActions),
  };
}

export function parseKestrelCompactionSufficiencyVerdictV1(value: unknown): KestrelCompactionSufficiencyVerdictV1 {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  const record = requireRecord(parsed, "compaction sufficiency verdict");
  rejectUnknown(record, SUFFICIENCY_FIELDS, "compaction sufficiency verdict");
  if (record.version !== 1 || typeof record.sufficient !== "boolean") throw compactionFailure("Compaction sufficiency verdict is invalid.");
  const categoriesRecord = requireRecord(record.categories, "compaction sufficiency verdict categories");
  rejectUnknown(categoriesRecord, SUFFICIENCY_CATEGORY_FIELDS, "compaction sufficiency verdict categories");
  const categories = Object.fromEntries([...SUFFICIENCY_CATEGORY_FIELDS].map((field) => {
    if (typeof categoriesRecord[field] !== "boolean") throw compactionFailure(`Compaction sufficiency category '${field}' must be boolean.`);
    return [field, categoriesRecord[field]];
  })) as KestrelCompactionSufficiencyVerdictV1["categories"];
  const verdict = { version: 1 as const, sufficient: record.sufficient, categories, reason: requireString(record.reason, "reason") };
  if (!verdict.sufficient || Object.values(verdict.categories).some((covered) => !covered)) {
    throw compactionFailure(`Maintenance verifier rejected compaction: ${verdict.reason}`);
  }
  return verdict;
}

export function parseKestrelCompactionSummaryV1(value: unknown): KestrelCompactionSummaryV1 {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  const record = requireRecord(parsed, "compaction summary");
  rejectUnknown(record, COMPACTION_FIELDS, "compaction summary");
  if (record.version !== 1) throw compactionFailure("Compaction summary version must be 1.");
  const activeTaskItemId = requireString(record.activeTaskItemId, "activeTaskItemId");
  return {
    version: 1,
    activeTaskItemId,
    decisions: parseAnchors(record.decisions, "decisions"),
    constraints: parseAnchors(record.constraints, "constraints"),
    evidence: parseAnchors(record.evidence, "evidence"),
    fileState: parseAnchors(record.fileState, "fileState"),
    blockers: parseAnchors(record.blockers, "blockers"),
    nextActions: parseAnchors(record.nextActions, "nextActions"),
    coveredItemIds: parseStringArray(record.coveredItemIds, "coveredItemIds"),
  };
}

function validateCompactionSufficiency(
  transcript: ModelTranscript,
  plan: ReturnType<typeof planModelTranscriptCompaction>,
  summary: KestrelCompactionSummaryV1,
): void {
  const activeTaskItemId = readActiveTaskItemIdFromTranscript(transcript);
  if (activeTaskItemId === undefined || summary.activeTaskItemId !== activeTaskItemId) {
    throw compactionFailure("Compaction summary does not identify the retained active task item.");
  }
  const knownIds = new Set(transcript.items.map((item) => item.id));
  const replacedIds = new Set(plan.replacedItems.map((item) => item.id));
  const coveredIds = new Set(summary.coveredItemIds);
  const anchorIds = new Set(allAnchors(summary).flatMap((anchor) => anchor.sourceItemIds));
  for (const id of coveredIds) {
    if (knownIds.has(id) === false) throw compactionFailure(`Compaction summary references unknown item '${id}'.`);
    if (anchorIds.has(id) === false) throw compactionFailure(`Compaction summary covers '${id}' without a semantic anchor.`);
  }
  for (const id of replacedIds) {
    if (coveredIds.has(id) === false || anchorIds.has(id) === false) {
      throw compactionFailure(`Compaction summary does not preserve replaced item '${id}'.`);
    }
  }
}

function allAnchors(summary: KestrelCompactionSummaryV1): KestrelCompactionAnchorV1[] {
  return [...summary.decisions, ...summary.constraints, ...summary.evidence, ...summary.fileState, ...summary.blockers, ...summary.nextActions];
}

function renderModelVisibleCompactionSummary(summary: KestrelCompactionSummaryV1): string {
  return JSON.stringify({
    version: 1,
    decisions: summary.decisions.map((anchor) => anchor.text),
    constraints: summary.constraints.map((anchor) => anchor.text),
    evidence: summary.evidence.map((anchor) => anchor.text),
    fileState: summary.fileState.map((anchor) => anchor.text),
    blockers: summary.blockers.map((anchor) => anchor.text),
    nextActions: summary.nextActions.map((anchor) => anchor.text),
  });
}

function categoryCoverage(summary: KestrelCompactionSummaryV1): Record<string, number> {
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

function parseAnchors(value: unknown, field: string): KestrelCompactionAnchorV1[] {
  if (Array.isArray(value) === false) throw compactionFailure(`Compaction summary ${field} must be an array.`);
  return value.map((entry, index) => {
    const record = requireRecord(entry, `${field}[${index}]`);
    rejectUnknown(record, COMPACTION_ANCHOR_FIELDS, `${field}[${index}]`);
    return {
      text: requireString(record.text, `${field}[${index}].text`),
      sourceItemIds: parseStringArray(record.sourceItemIds, `${field}[${index}].sourceItemIds`),
    };
  });
}

function parseStringArray(value: unknown, field: string): string[] {
  if (Array.isArray(value) === false) throw compactionFailure(`Compaction summary ${field} must be an array.`);
  return [...new Set(value.map((entry) => requireString(entry, `${field} item`)))];
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
    throw compactionFailure(`Compaction summary ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function rejectUnknown(record: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(record).find((field) => fields.has(field) === false);
  if (unknown !== undefined) throw compactionFailure(`Compaction summary ${label} contains unknown field '${unknown}'.`);
}

function compactionFailure(message: string): Error {
  return createRuntimeFailure("HARNESS_ECONOMICS_COMPACTION_INSUFFICIENT", message);
}

function anchorArraySchema() {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        sourceItemIds: { type: "array", items: { type: "string" } },
      },
      required: ["text", "sourceItemIds"],
    },
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
