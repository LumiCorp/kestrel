import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

export const dialogReadTool: SharedToolModule = {
  definition: {
    name: "dialog.read",
    description: "Check a collaborator's saved status, messages, and results without sending a message or starting more work. Use this when you need to review the private conversation or check what has arrived since an earlier read.",
    inputSchema: { type: "object", properties: { dialogId: { type: "string", description: "The collaborator to read." }, afterCursor: { type: "string", description: "Return only messages after this opaque cursor." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "The maximum messages to return." } }, required: ["dialogId"], additionalProperties: false },
    capability: { freshnessClass: "runtime", latencyClass: "low", costClass: "free", executionClass: "sandboxed_only", capabilityClasses: ["runtime.dialog"] },
    presentation: { displayName: "Read Dialog", aliases: ["read collaborator dialog"], keywords: ["dialog", "read"], provider: "kestrel", toolFamily: "runtime" },
  },
  createHandler(context) {
    if (context.dialogService === undefined || context.runtime === undefined) throw createRuntimeFailure("TOOL_CONTEXT_INVALID", "dialog.read requires an active dialog runtime.", { subsystem: "tooling", toolName: "dialog.read", classification: "configuration", recoverable: false });
    return async (input) => {
      const body = parseObjectInput("dialog.read", input);
      const afterCursor = optionalNonemptyString("dialog.read", body, "afterCursor");
      return context.dialogService!.read({ parentSessionId: context.runtime!.threadId ?? context.runtime!.sessionId, dialogId: requireStringField("dialog.read", body, "dialogId"), ...(afterCursor === undefined ? {} : { afterCursor }), ...(typeof body.limit === "number" ? { limit: body.limit } : {}) });
    };
  },
};

function optionalNonemptyString(toolName: string, body: Record<string, unknown>, field: string): string | undefined {
  if (body[field] === undefined) return undefined;
  const value = requireStringField(toolName, body, field);
  if (value.trim().length === 0) throw createRuntimeFailure("TOOL_INPUT_INVALID", `${toolName}.${field} must be nonempty.`);
  return value;
}
