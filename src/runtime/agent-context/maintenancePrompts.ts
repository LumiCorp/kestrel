import type { ModelMessage } from "../../kestrel/contracts/model-io.js";
import {
  compactModelTranscript,
  estimateModelTranscriptChars,
  type ModelTranscript,
} from "../modelTranscript.js";

export interface KestrelAgentCompactionBuildInput {
  contextMessages: ModelMessage[];
}

export interface KestrelAgentCompactionPolicyInput {
  transcript: unknown;
}

export interface KestrelAgentCompactedTranscriptInput {
  transcript: unknown;
  summary?: string | undefined;
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
const DEFAULT_COMPACTION_SUMMARY = "Earlier transcript was compacted; continue from the retained recent turns.";

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
        "Do not invent evidence or hidden state.",
      ].join("\n"),
    },
    ...input.contextMessages,
    {
      role: "user",
      content: "Write the compact continuation summary now.",
    },
  ];
}

export function shouldCompactKestrelAgentContext(
  input: KestrelAgentCompactionPolicyInput,
): boolean {
  return estimateModelTranscriptChars(input.transcript) >= MODEL_TRANSCRIPT_COMPACTION_THRESHOLD_CHARS;
}

export function buildKestrelAgentCompactedTranscript(
  input: KestrelAgentCompactedTranscriptInput,
): ModelTranscript {
  const summary = input.summary?.trim() || DEFAULT_COMPACTION_SUMMARY;
  return compactModelTranscript({
    transcript: input.transcript,
    summary,
    retainedTailItems: MODEL_TRANSCRIPT_RETAINED_TAIL_ITEMS,
  });
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
