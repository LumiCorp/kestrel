import { parseRunnerEventV2, type RunnerEvent } from "@kestrel-agents/protocol";

import { parseAgentToolResultV2, type AgentToolResultV2 } from "../../src/kestrel/contracts/tool-invocation.js";

export interface ParsedQualificationRun {
  events: RunnerEvent[];
  runId: string;
  idempotencyKey?: string | undefined;
  codeResults: AgentToolResultV2[];
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
  for (const block of stream.split(/\r?\n\r?\n/u)) {
    const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
    if (data === "" || data === "[DONE]") continue;
    events.push(parseRunnerEventV2(JSON.parse(data)));
  }
  const codeResults = events.flatMap((event) => {
    if (event.type !== "run.tool.completed") return [];
    const update = event.payload.update as unknown as Record<string, unknown>;
    if (update.toolName !== "code.execute" || update.output === undefined) return [];
    try { return [parseAgentToolResultV2(update.output)]; } catch { return []; }
  });
  const runId = events.find((event) => typeof event.runId === "string")?.runId ?? "";
  const idempotencyKey = codeResults.map((result) => readCapabilityReplayEvidence(result)?.toolCallId).find((value): value is string => typeof value === "string");
  return { events, runId, codeResults, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
}

export function hasTerminalEvent(run: ParsedQualificationRun, type: "run.completed" | "run.cancelled" | "run.failed"): boolean {
  return run.events.some((event) => event.type === type);
}

export function readCapabilityReplayEvidence(result: AgentToolResultV2): { leaseId: string; bindingDigest: string; toolCallId: string } | undefined {
  const raw = readRawOutput(result);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const evidence = (raw as Record<string, unknown>).capabilityReplayEvidence;
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return undefined;
  const record = evidence as Record<string, unknown>;
  return typeof record.leaseId === "string" && typeof record.bindingDigest === "string" && typeof record.toolCallId === "string"
    ? { leaseId: record.leaseId, bindingDigest: record.bindingDigest, toolCallId: record.toolCallId }
    : undefined;
}

export function readCodeStdout(result: AgentToolResultV2): string {
  const raw = readRawOutput(result);
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).stdout === "string"
    ? (raw as Record<string, unknown>).stdout as string
    : "";
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

function readRawOutput(result: AgentToolResultV2): unknown {
  return result.outcome.kind === "success" || result.outcome.kind === "partial" ? result.outcome.rawOutput : undefined;
}
