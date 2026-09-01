import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

export const dialogReadTool: SharedToolModule = {
  definition: {
    name: "dialog.read",
    description: "Check a collaborator's saved status, messages, and results without sending a message or starting more work. On the first read, omit both cursor fields. For pagination, copy exactly one cursor returned by dialog.read for this same collaborator: afterCursor for newer messages or beforeCursor for older history. Never invent a cursor or send an empty value.",
    inputSchema: {
      type: "object",
      properties: {
        dialogId: { type: "string", minLength: 1, description: "The collaborator to read." },
        afterCursor: { type: "string", minLength: 1, description: "The exact nextCursor returned by an earlier read of this collaborator." },
        beforeCursor: { type: "string", minLength: 1, description: "The exact previousCursor returned by an earlier read of this collaborator." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "The maximum messages to return." },
      },
      required: ["dialogId"],
      additionalProperties: false,
      oneOf: [
        { type: "object", properties: { dialogId: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, required: ["dialogId"], additionalProperties: false },
        { type: "object", properties: { dialogId: { type: "string", minLength: 1 }, afterCursor: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, required: ["dialogId", "afterCursor"], additionalProperties: false },
        { type: "object", properties: { dialogId: { type: "string", minLength: 1 }, beforeCursor: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, required: ["dialogId", "beforeCursor"], additionalProperties: false },
      ],
    },
    capability: { freshnessClass: "runtime", latencyClass: "low", costClass: "free", executionClass: "external_side_effect", allowedInteractionModes: ["chat", "plan", "build"], capabilityClasses: ["runtime.dialog"], approvalCapabilities: ["delegation.control"] },
    presentation: { displayName: "Read Dialog", aliases: ["read collaborator dialog"], keywords: ["dialog", "read"], provider: "kestrel", toolFamily: "runtime" },
  },
  createHandler(context) {
    if (context.dialogService === undefined || context.runtime === undefined) throw createRuntimeFailure("TOOL_CONTEXT_INVALID", "dialog.read requires an active dialog runtime.", { subsystem: "tooling", toolName: "dialog.read", classification: "configuration", recoverable: false });
    return async (input) => {
      const body = parseObjectInput("dialog.read", input);
      const afterCursor = optionalNonemptyString("dialog.read", body, "afterCursor");
      const beforeCursor = optionalNonemptyString("dialog.read", body, "beforeCursor");
      if (afterCursor !== undefined && beforeCursor !== undefined) throw createRuntimeFailure("TOOL_INPUT_INVALID", "dialog.read accepts either afterCursor or beforeCursor, not both.");
      return context.dialogService!.read({ parentSessionId: context.runtime!.threadId ?? context.runtime!.sessionId, dialogId: requireStringField("dialog.read", body, "dialogId"), ...(afterCursor === undefined ? {} : { afterCursor }), ...(beforeCursor === undefined ? {} : { beforeCursor }), ...(typeof body.limit === "number" ? { limit: body.limit } : {}) });
    };
  },
};

function optionalNonemptyString(toolName: string, body: Record<string, unknown>, field: string): string | undefined {
  if (body[field] === undefined) return undefined;
  const value = requireStringField(toolName, body, field);
  if (value.trim().length === 0) throw createRuntimeFailure("TOOL_INPUT_INVALID", `${toolName}.${field} must be nonempty.`);
  return value;
}
