import { createHash } from "node:crypto";
import { readKestrelTerminalInteraction } from "@kestrel-agents/ai-sdk";
import type { RunnerRunTerminalEvent } from "@kestrel-agents/sdk";

export const githubMutationOperations = [
  "issue.create",
  "pull_request.create",
  "pull_request.merge",
  "release.create",
  "workflow.dispatch",
] as const;

export type GitHubMutationOperation = (typeof githubMutationOperations)[number];

export function readGitHubApprovalRequest(event: RunnerRunTerminalEvent) {
  const interaction = readKestrelTerminalInteraction(event);
  const approval = interaction?.approval;
  if (!(interaction?.kind === "approval" && approval)) return null;
  const operation = operationForToolName(approval.toolName);
  if (!operation) return null;
  const input = asRecord(approval.input);
  if (!input) return null;
  const repository = readString(input.repository);
  if (!repository) return null;
  return {
    runtimeApprovalId: interaction.requestId,
    toolName: approval.toolName,
    toolInput: input,
    operation,
    repository,
  };
}

export function hashGitHubActionPayload(payload: Record<string, unknown>) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function operationForToolName(
  toolName: string
): GitHubMutationOperation | null {
  if (toolName === "kestrel_one.github_issue_create") return "issue.create";
  if (toolName === "kestrel_one.github_pull_request_create") {
    return "pull_request.create";
  }
  if (toolName === "kestrel_one.github_pull_request_merge") {
    return "pull_request.merge";
  }
  if (toolName === "kestrel_one.github_release_create") {
    return "release.create";
  }
  if (toolName === "kestrel_one.github_workflow_dispatch") {
    return "workflow.dispatch";
  }
  return null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
