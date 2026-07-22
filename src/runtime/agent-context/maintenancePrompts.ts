import type { ModelMessage } from "../../kestrel/contracts/model-io.js";
import {
  compactModelTranscript,
  estimateModelTranscriptChars,
  normalizeModelTranscript,
  planModelTranscriptCompaction,
  type ModelTranscriptItem,
  type ModelTranscript,
} from "../modelTranscript.js";
import { createRuntimeFailure } from "../RuntimeFailure.js";
import type { HarnessEconomicsPolicyV1, ModelEconomicsProfileV1 } from "../../economics/contracts.js";

export interface KestrelAgentCompactionBuildInput {
  contextMessages: ModelMessage[];
  sourceItems?: ModelTranscriptItem[] | undefined;
}

export interface KestrelAgentCompactionPolicyInput {
  transcript: unknown;
  policy?: HarnessEconomicsPolicyV1 | undefined;
  modelProfile?: ModelEconomicsProfileV1 | undefined;
  contextTokens?: number | undefined;
  toolSchemaTokens?: number | undefined;
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
        "Return the required JSON object. Every replaced transcript item id must appear in coveredItemIds and in at least one semantic anchor sourceItemIds list.",
        "Do not invent evidence or hidden state.",
      ].join("\n"),
    },
    ...input.contextMessages,
    {
      role: "user",
      content: input.sourceItems === undefined || input.sourceItems.length === 0
        ? "Write the compact continuation summary now."
        : [
            "Write the compact continuation summary now.",
            "Source transcript items:",
            JSON.stringify(input.sourceItems.map((item) => ({ id: item.id, kind: item.kind, toolName: item.toolName }))),
          ].join("\n"),
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
    const availableContextTokens = Math.max(
      0,
      input.modelProfile.contextWindowTokens
        - input.policy.context.outputReserveTokens
        - input.policy.context.safetyReserveTokens
        - Math.max(input.policy.tools.modelContextMaxTokens, input.toolSchemaTokens ?? 0),
    );
    return input.contextTokens >= availableContextTokens;
  }
  return estimateModelTranscriptChars(input.transcript) >= MODEL_TRANSCRIPT_COMPACTION_THRESHOLD_CHARS;
}

export function buildKestrelAgentCompactedTranscript(
  input: KestrelAgentCompactedTranscriptInput,
): ModelTranscript {
  const transcript = normalizeModelTranscript(input.transcript);
  if (transcript === undefined) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_COMPACTION_TRANSCRIPT_INVALID", "Compaction requires a valid model transcript.");
  }
  const plan = planModelTranscriptCompaction({
    transcript,
    retainedTailItems: MODEL_TRANSCRIPT_RETAINED_TAIL_ITEMS,
  });
  const summary = parseKestrelCompactionSummaryV1(input.summary);
  validateCompactionSufficiency(transcript, plan, summary);
  return compactModelTranscript({
    transcript,
    summary: JSON.stringify(summary),
    retainedTailItems: MODEL_TRANSCRIPT_RETAINED_TAIL_ITEMS,
  });
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
  const activeTask = transcript.items.find((item) => item.kind === "user" && item.content?.trim());
  if (activeTask === undefined || summary.activeTaskItemId !== activeTask.id) {
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
