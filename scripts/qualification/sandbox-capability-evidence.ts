import { createHash } from "node:crypto";

import { parseRunnerEventV2, type RunnerEvent } from "@kestrel-agents/protocol";

import { parseAgentToolResultV2, type AgentToolResultV2 } from "../../src/kestrel/contracts/tool-invocation.js";

export interface ParsedQualificationRun {
  events: RunnerEvent[];
  runId: string;
  idempotencyKey?: string | undefined;
  codeResults: QualificationCodeResult[];
}

export interface QualificationCodeResult {
  output: Record<string, unknown>;
  stdout: string;
  capabilityReplayEvidence?: { leaseId: string; bindingDigest: string; toolCallId: string } | undefined;
}

export interface NetworkObservation {
  outcome: "blocked" | "unexpected";
  url: string;
  status?: number | undefined;
  finalUrl?: string | undefined;
  error?: string | undefined;
}

export function parseQualificationRunStream(stream: string): ParsedQualificationRun {
  const events: RunnerEvent[] = [];
  for (const block of completeSseBlocks(stream)) {
    const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
    if (data === "" || data === "[DONE]") continue;
    events.push(parseRunnerEventV2(JSON.parse(data)));
  }
  const codeResults = events.flatMap((event) => {
    if (event.type !== "run.tool.completed") return [];
    const update = event.payload.update as unknown as Record<string, unknown>;
    if (update.toolName !== "code.execute" || update.output === undefined) return [];
    return parseQualificationCodeResult(update.output);
  });
  const runId = events.find((event) => typeof event.runId === "string")?.runId ?? "";
  const idempotencyKey = codeResults.map((result) => readCapabilityReplayEvidence(result)?.toolCallId).find((value): value is string => typeof value === "string");
  return { events, runId, codeResults, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
}

function completeSseBlocks(stream: string): string[] {
  const blocks: string[] = [];
  const separator = /\r?\n\r?\n/gu;
  let start = 0;
  for (const match of stream.matchAll(separator)) {
    blocks.push(stream.slice(start, match.index));
    start = match.index + match[0].length;
  }
  return blocks;
}

export function hasTerminalEvent(run: ParsedQualificationRun, type: "run.completed" | "run.cancelled" | "run.failed"): boolean {
  return run.events.some((event) => event.type === type);
}

export function readCapabilityReplayEvidence(result: QualificationCodeResult): { leaseId: string; bindingDigest: string; toolCallId: string } | undefined {
  return result.capabilityReplayEvidence;
}

export function readCodeStdout(result: QualificationCodeResult): string {
  return result.stdout;
}

export function parseExactAgentToolResult(value: unknown): AgentToolResultV2 {
  return parseAgentToolResultV2(value);
}

function parseQualificationCodeResult(value: unknown): QualificationCodeResult[] {
  const output = asRecord(value);
  if (output === undefined) return [];
  const stdout = typeof output.stdout === "string" ? output.stdout : "";
  const evidence = parseReplayEvidence(output.capabilityReplayEvidence);
  return [{ output, stdout, ...(evidence === undefined ? {} : { capabilityReplayEvidence: evidence }) }];
}

function parseReplayEvidence(evidence: unknown): { leaseId: string; bindingDigest: string; toolCallId: string } | undefined {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return undefined;
  const record = evidence as Record<string, unknown>;
  return typeof record.leaseId === "string" && typeof record.bindingDigest === "string" && typeof record.toolCallId === "string"
    ? { leaseId: record.leaseId, bindingDigest: record.bindingDigest, toolCallId: record.toolCallId }
    : undefined;
}

export function parseNetworkObservations(stdout: string): NetworkObservation[] {
  const observations: NetworkObservation[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(DIRECT_NETWORK_BLOCKED|DIRECT_NETWORK_UNEXPECTED):(\{.*\})$/u.exec(line.trim());
    if (match === null) continue;
    const value = JSON.parse(match[2]!) as Record<string, unknown>;
    if (typeof value.url !== "string") throw new Error("Network observation omitted its URL");
    observations.push({
      outcome: match[1] === "DIRECT_NETWORK_BLOCKED" ? "blocked" : "unexpected",
      url: value.url,
      ...(typeof value.status === "number" ? { status: value.status } : {}),
      ...(typeof value.finalUrl === "string" ? { finalUrl: value.finalUrl } : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    });
  }
  return observations;
}

export function qualificationEvidenceLabels(mode: "live" | "controlled" | "all"): string[] {
  return [
    "hosted_runner_black_box",
    ...(mode === "live" || mode === "all" ? ["live_provider"] : []),
    ...(mode === "controlled" || mode === "all" ? ["controlled_provider"] : []),
  ];
}

export function renderSha256Sidecar(fileName: string, bytes: string | Buffer): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${digest}  ${fileName}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
