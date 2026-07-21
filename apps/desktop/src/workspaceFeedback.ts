import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import type { DesktopWorkspaceFeedbackSnapshot, DesktopWorkspaceFeedbackSubmitResult } from "./contracts.js";
import { createDesktopError } from "./errors.js";

type ControlAdapter = Pick<WebRunnerAdapter, "sendControl">;
type Operation = "add" | "list" | "remove" | "submit";

export async function runDesktopWorkspaceFeedback(input: { adapter: ControlAdapter; request: unknown; operation: Operation; context: WebRunnerRequestContext }): Promise<DesktopWorkspaceFeedbackSnapshot | DesktopWorkspaceFeedbackSubmitResult> {
  const request = objectInput(input.request);
  const sessionId = stringInput(request.sessionId, "sessionId", 256);
  const threadId = stringInput(request.threadId, "threadId", 256);
  const base = { sessionId, threadId };
  const command = input.operation === "list"
    ? { type: "workspace.feedback.list" as const, ...base }
    : input.operation === "add"
      ? { type: "workspace.feedback.add" as const, ...base, candidateFingerprint: fingerprint(request.candidateFingerprint), path: stringInput(request.path, "path", 4096), line: positiveInteger(request.line, "line"), side: request.side === "LEFT" ? "LEFT" as const : "RIGHT" as const, body: stringInput(request.body, "body", 16 * 1024) }
      : input.operation === "remove"
        ? { type: "workspace.feedback.remove" as const, ...base, candidateFingerprint: fingerprint(request.candidateFingerprint), commentId: stringInput(request.commentId, "commentId", 256) }
        : { type: "workspace.feedback.submit" as const, ...base, candidateFingerprint: fingerprint(request.candidateFingerprint), commentIds: stringArray(request.commentIds) };
  const event = await input.adapter.sendControl(command, input.context);
  if (event.type !== "workspace.feedback" || event.payload.sessionId !== sessionId || event.payload.threadId !== threadId || event.payload.operation !== input.operation) throw error("DESKTOP_WORKSPACE_FEEDBACK_RESPONSE_INVALID", "Local Core returned invalid workspace feedback.");
  return input.operation === "submit" ? { snapshot: event.payload.snapshot, ...(event.payload.submissionRunId ? { submissionRunId: event.payload.submissionRunId } : {}) } : event.payload.snapshot;
}

function objectInput(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw error("DESKTOP_WORKSPACE_FEEDBACK_INPUT_INVALID", "Feedback request must be an object."); return value as Record<string, unknown>; }
function stringInput(value: unknown, label: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw error("DESKTOP_WORKSPACE_FEEDBACK_INPUT_INVALID", `${label} is invalid.`); return value.trim(); }
function fingerprint(value: unknown): string { const parsed = stringInput(value, "candidateFingerprint", 256); if (!/^sha256:[a-f0-9]{64}$/u.test(parsed)) throw error("DESKTOP_WORKSPACE_FEEDBACK_INPUT_INVALID", "candidateFingerprint is invalid."); return parsed; }
function positiveInteger(value: unknown, label: string): number { if (!Number.isInteger(value) || Number(value) <= 0) throw error("DESKTOP_WORKSPACE_FEEDBACK_INPUT_INVALID", `${label} is invalid.`); return Number(value); }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw error("DESKTOP_WORKSPACE_FEEDBACK_INPUT_INVALID", "commentIds is invalid."); return value.map((entry) => stringInput(entry, "commentId", 256)); }
function error(code: string, message: string): Error { return createDesktopError({ code, message }); }
