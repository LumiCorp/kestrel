import { createHash } from "node:crypto";
import { getKestrelToolApprovalRequest } from "@/lib/agent/kestrel-stream-events";

export const githubMutationOperations = [
  "issue.create",
  "pull_request.create",
  "pull_request.merge",
  "release.create",
  "workflow.dispatch",
] as const;

export type GitHubMutationOperation = (typeof githubMutationOperations)[number];

export function readGitHubApprovalRequest(event: {
  type: string;
  payload?: unknown;
}) {
  const approval = getKestrelToolApprovalRequest(event);
  if (!approval) return null;
  const operation = operationForToolName(approval.toolName);
  const expiresAt = readExpiry(approval.expiresAt);
  if (!(expiresAt && operation)) return null;
  const repository = readString(approval.input.repository);
  if (!repository) return null;
  return {
    runtimeApprovalId: approval.approvalId,
    toolName: approval.toolName,
    toolInput: approval.input,
    operation,
    repository,
    expiresAt,
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

function readExpiry(value: unknown) {
  const raw = readString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now()
    ? date
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
