import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import type { DesktopWorkspaceGitAction, DesktopWorkspaceGitSnapshot } from "./contracts.js";
import { createDesktopError } from "./errors.js";

type ControlAdapter = Pick<WebRunnerAdapter, "sendControl">;

export async function runDesktopWorkspaceGit(input: { adapter: ControlAdapter; request: unknown; operation: "inspect" | "action"; context: WebRunnerRequestContext }): Promise<DesktopWorkspaceGitSnapshot> {
  const request = objectInput(input.request); const sessionId = text(request.sessionId, "sessionId", 256); const threadId = text(request.threadId, "threadId", 256);
  const command = input.operation === "inspect"
    ? { type: "workspace.git.inspect" as const, sessionId, threadId }
    : { type: "workspace.git.action" as const, sessionId, threadId, candidateFingerprint: fingerprint(request.candidateFingerprint), ...(request.expectedHeadSha !== undefined ? { expectedHeadSha: text(request.expectedHeadSha, "expectedHeadSha", 256) } : {}), action: gitAction(request.action) };
  const event = await input.adapter.sendControl(command, input.context);
  if (event.type !== "workspace.git" || event.payload.sessionId !== sessionId || event.payload.threadId !== threadId || event.payload.operation !== input.operation) throw error("DESKTOP_WORKSPACE_GIT_RESPONSE_INVALID", "Local Core returned invalid workspace Git data.");
  return event.payload.snapshot;
}

function gitAction(value: unknown): DesktopWorkspaceGitAction {
  const action = objectInput(value); const kind = action.kind; const string = (key: string, max = 16_384) => text(action[key], key, max);
  if (kind === "branch_create") return { kind, branchName: string("branchName", 512) };
  if (kind === "fetch") return { kind, remote: string("remote", 256) };
  if (kind === "commit") { if (!Array.isArray(action.paths) || action.paths.length === 0 || action.paths.length > 1000) throw error("DESKTOP_WORKSPACE_GIT_INPUT_INVALID", "Commit paths are invalid."); return { kind, message: string("message"), paths: action.paths.map((entry) => text(entry, "path", 4096)) }; }
  if (kind === "push") { if (typeof action.setUpstream !== "boolean") throw error("DESKTOP_WORKSPACE_GIT_INPUT_INVALID", "setUpstream is invalid."); return { kind, remote: string("remote", 256), branch: string("branch", 512), setUpstream: action.setUpstream }; }
  if (kind === "pr_create") { if (typeof action.body !== "string" || action.body.length > 65_536 || typeof action.draft !== "boolean") throw error("DESKTOP_WORKSPACE_GIT_INPUT_INVALID", "Pull request input is invalid."); return { kind, title: string("title", 512), body: action.body, baseBranch: string("baseBranch", 512), draft: action.draft }; }
  if (kind === "pr_ready") return { kind, number: integer(action.number, "number") };
  if (kind === "pr_comment") { if (action.side !== undefined && action.side !== "LEFT" && action.side !== "RIGHT") throw error("DESKTOP_WORKSPACE_GIT_INPUT_INVALID", "Comment side is invalid."); return { kind, number: integer(action.number, "number"), body: string("body"), ...(action.path !== undefined ? { path: string("path", 4096) } : {}), ...(action.line !== undefined ? { line: integer(action.line, "line") } : {}), ...(action.side ? { side: action.side } : {}) }; }
  throw error("DESKTOP_WORKSPACE_GIT_INPUT_INVALID", "Git action is invalid.");
}
function objectInput(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw error("DESKTOP_WORKSPACE_GIT_INPUT_INVALID", "Git request must be an object."); return value as Record<string, unknown>; }
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw error("DESKTOP_WORKSPACE_GIT_INPUT_INVALID", `${label} is invalid.`); return value.trim(); }
function integer(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw error("DESKTOP_WORKSPACE_GIT_INPUT_INVALID", `${label} is invalid.`); return value; }
function fingerprint(value: unknown): string { const parsed = text(value, "candidateFingerprint", 256); if (!/^sha256:[a-f0-9]{64}$/u.test(parsed)) throw error("DESKTOP_WORKSPACE_GIT_INPUT_INVALID", "candidateFingerprint is invalid."); return parsed; }
function error(code: string, message: string): Error { return createDesktopError({ code, message }); }
