import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import type { DesktopWorkspaceChangeMutation, DesktopWorkspaceChangeMutationResult, DesktopWorkspaceChangeSnapshot, DesktopWorkspaceDiffOptions } from "./contracts.js";
import { createDesktopError } from "./errors.js";

type ControlAdapter = Pick<WebRunnerAdapter, "sendControl">;

export async function inspectDesktopWorkspaceChanges(input: { adapter: ControlAdapter; request: unknown; context: WebRunnerRequestContext }): Promise<DesktopWorkspaceChangeSnapshot> {
  const request = objectInput(input.request);
  const sessionId = stringInput(request.sessionId, "sessionId");
  const threadId = stringInput(request.threadId, "threadId");
  const scope = scopeInput(request.scope);
  const options = request.options === undefined ? undefined : optionsInput(request.options);
  const event = await input.adapter.sendControl({ type: "workspace.changes.inspect", sessionId, threadId, scope, ...(options ? { options } : {}) }, input.context);
  return snapshotFromEvent(event, sessionId, threadId, "inspect");
}

export async function mutateDesktopWorkspaceChanges(input: { adapter: ControlAdapter; request: unknown; context: WebRunnerRequestContext }): Promise<DesktopWorkspaceChangeMutationResult> {
  const request = objectInput(input.request);
  const sessionId = stringInput(request.sessionId, "sessionId");
  const threadId = stringInput(request.threadId, "threadId");
  const expectedFingerprint = stringInput(request.expectedFingerprint, "expectedFingerprint");
  const mutationRecord = objectInput(request.mutation);
  const operation = mutationRecord.operation;
  const filePath = stringInput(mutationRecord.path, "mutation.path");
  let mutation: DesktopWorkspaceChangeMutation;
  if (operation === "stage_file") mutation = { operation: "stage_file", path: filePath };
  else if (operation === "unstage_file") mutation = { operation: "unstage_file", path: filePath };
  else if (operation === "revert_file" && mutationRecord.confirmation === "revert_file") mutation = { operation: "revert_file", path: filePath, confirmation: "revert_file" };
  else if (operation === "stage_hunk" || operation === "unstage_hunk") mutation = { operation, path: filePath, hunkId: stringInput(mutationRecord.hunkId, "mutation.hunkId") };
  else if (operation === "revert_hunk" && mutationRecord.confirmation === "revert_hunk") mutation = { operation: "revert_hunk", path: filePath, hunkId: stringInput(mutationRecord.hunkId, "mutation.hunkId"), confirmation: "revert_hunk" };
  else throw error("DESKTOP_WORKSPACE_CHANGE_INPUT_INVALID", "Workspace change mutation is invalid.");
  const scope = request.scope === undefined ? undefined : scopeInput(request.scope);
  const options = request.options === undefined ? undefined : optionsInput(request.options);
  const event = await input.adapter.sendControl({ type: "workspace.changes.mutate", sessionId, threadId, expectedFingerprint, ...(scope ? { scope } : {}), ...(options ? { options } : {}), mutation }, input.context);
  const snapshot = snapshotFromEvent(event, sessionId, threadId, "mutate");
  if (event.type !== "workspace.changes" || typeof event.payload.previousFingerprint !== "string" || event.payload.mutationOperation !== mutation.operation) {
    throw error("DESKTOP_WORKSPACE_CHANGE_RESPONSE_INVALID", "Local Core returned invalid mutation evidence.");
  }
  return { operation: mutation.operation, previousFingerprint: event.payload.previousFingerprint, snapshot };
}

function snapshotFromEvent(event: Awaited<ReturnType<ControlAdapter["sendControl"]>>, sessionId: string, threadId: string, operation: "inspect" | "mutate"): DesktopWorkspaceChangeSnapshot {
  if (event.type !== "workspace.changes" || event.payload.sessionId !== sessionId || event.payload.threadId !== threadId || event.payload.operation !== operation) {
    throw error("DESKTOP_WORKSPACE_CHANGE_RESPONSE_INVALID", "Local Core returned an invalid workspace change response.");
  }
  return event.payload.snapshot;
}

function scopeInput(value: unknown) {
  const record = objectInput(value);
  if (record.kind === "unstaged" || record.kind === "staged" || record.kind === "uncommitted") return { kind: record.kind } as const;
  if (record.kind === "branch") return { kind: "branch" as const, baseRef: stringInput(record.baseRef, "scope.baseRef") };
  if (record.kind === "commit") return { kind: "commit" as const, commitSha: stringInput(record.commitSha, "scope.commitSha") };
  if (record.kind === "pull_request") { const number = record.number === undefined ? undefined : Number(record.number); if (number !== undefined && (!Number.isInteger(number) || number <= 0)) throw error("DESKTOP_WORKSPACE_CHANGE_INPUT_INVALID", "Pull request number is invalid."); return { kind: "pull_request" as const, ...(number !== undefined ? { number } : {}) }; }
  if (record.kind === "latest_run") return { kind: "latest_run" as const, ...(record.runId !== undefined ? { runId: stringInput(record.runId, "scope.runId") } : {}) };
  if (record.kind === "latest_turn") return { kind: "latest_turn" as const, ...(record.turnId !== undefined ? { turnId: stringInput(record.turnId, "scope.turnId") } : {}) };
  if (record.kind === "promotion") return { kind: "promotion" as const, promotionId: stringInput(record.promotionId, "scope.promotionId") };
  throw error("DESKTOP_WORKSPACE_CHANGE_INPUT_INVALID", "Workspace change scope is invalid.");
}

function optionsInput(value: unknown): Partial<DesktopWorkspaceDiffOptions> {
  const record = objectInput(value);
  const contextLines = record.contextLines === undefined ? undefined : Number(record.contextLines);
  if (contextLines !== undefined && (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 100)) throw error("DESKTOP_WORKSPACE_CHANGE_INPUT_INVALID", "Diff context must be an integer between 0 and 100.");
  const whitespace = record.whitespace as DesktopWorkspaceDiffOptions["whitespace"] | undefined;
  if (whitespace !== undefined && whitespace !== "show" && whitespace !== "ignore_all" && whitespace !== "ignore_eol") throw error("DESKTOP_WORKSPACE_CHANGE_INPUT_INVALID", "Diff whitespace mode is invalid.");
  return { ...(contextLines !== undefined ? { contextLines } : {}), ...(whitespace !== undefined ? { whitespace } : {}) };
}

function objectInput(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw error("DESKTOP_WORKSPACE_CHANGE_INPUT_INVALID", "Workspace change request must be an object."); return value as Record<string, unknown>; }
function stringInput(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw error("DESKTOP_WORKSPACE_CHANGE_INPUT_INVALID", `${label} must be a non-empty string.`); return value.trim(); }
function error(code: string, message: string): Error { return createDesktopError({ code, message }); }
