import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import type { DesktopWorkspaceValidationSnapshot } from "./contracts.js";
import { createDesktopError } from "./errors.js";

type ControlAdapter = Pick<WebRunnerAdapter, "sendControl">;
type Operation = "inspect" | "run" | "cancel" | "submit";

export async function runDesktopWorkspaceValidation(input: {
  adapter: ControlAdapter;
  request: unknown;
  operation: Operation;
  context: WebRunnerRequestContext;
}): Promise<DesktopWorkspaceValidationSnapshot | { snapshot: DesktopWorkspaceValidationSnapshot; runId: string }> {
  const request = objectInput(input.request);
  const sessionId = text(request.sessionId, "sessionId");
  const threadId = text(request.threadId, "threadId");
  const base = { sessionId, threadId };
  const command = input.operation === "inspect"
    ? { type: "workspace.validation.inspect" as const, ...base }
    : input.operation === "run"
      ? validationRunCommand(request, base)
      : input.operation === "cancel"
        ? { type: "workspace.validation.cancel" as const, ...base, resultId: text(request.resultId, "resultId") }
        : { type: "workspace.validation.submit" as const, ...base, resultIds: stringArray(request.resultIds) };
  const event = await input.adapter.sendControl(command, input.context);
  if (event.type !== "workspace.validation" || event.payload.sessionId !== sessionId || event.payload.threadId !== threadId || event.payload.operation !== input.operation)
    throw error("DESKTOP_WORKSPACE_VALIDATION_RESPONSE_INVALID", "Local Core returned invalid workspace validation data.");
  if (input.operation === "submit") {
    if (!event.payload.runId) throw error("DESKTOP_WORKSPACE_VALIDATION_RESPONSE_INVALID", "Local Core omitted the validation follow-up run id.");
    return { snapshot: event.payload.snapshot, runId: event.payload.runId };
  }
  return event.payload.snapshot;
}

function validationRunCommand(request: Record<string, unknown>, base: { sessionId: string; threadId: string }) {
  const actionId = request.actionId === undefined ? undefined : text(request.actionId, "actionId");
  const suiteId = request.suiteId === undefined ? undefined : text(request.suiteId, "suiteId");
  if ((actionId === undefined) === (suiteId === undefined)) throw error("DESKTOP_WORKSPACE_VALIDATION_INPUT_INVALID", "Select exactly one validation action or suite.");
  return { type: "workspace.validation.run" as const, ...base, candidateFingerprint: fingerprint(request.candidateFingerprint), ...(actionId ? { actionId } : {}), ...(suiteId ? { suiteId } : {}) };
}
function objectInput(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw error("DESKTOP_WORKSPACE_VALIDATION_INPUT_INVALID", "Validation request must be an object."); return value as Record<string, unknown>; }
function text(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim() || value.length > 512) throw error("DESKTOP_WORKSPACE_VALIDATION_INPUT_INVALID", `${label} is invalid.`); return value.trim(); }
function fingerprint(value: unknown): string { const parsed = text(value, "candidateFingerprint"); if (!/^sha256:[a-f0-9]{64}$/u.test(parsed)) throw error("DESKTOP_WORKSPACE_VALIDATION_INPUT_INVALID", "candidateFingerprint is invalid."); return parsed; }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw error("DESKTOP_WORKSPACE_VALIDATION_INPUT_INVALID", "resultIds is invalid."); return value.map((entry) => text(entry, "resultId")); }
function error(code: string, message: string): Error { return createDesktopError({ code, message }); }
