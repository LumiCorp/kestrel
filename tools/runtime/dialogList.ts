import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput } from "../helpers.js";

export const dialogListTool: SharedToolModule = {
  definition: {
    name: "dialog.list",
    description: "See the named collaborators in this task and what each one is doing. Omit cursor on the first call. To continue, copy the non-empty nextCursor returned by the same dialog.list filter; never invent a cursor or send an empty value. This does not send a message or start work.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "closed", "all"], default: "all", description: "Open, closed, or all collaborators." }, cursor: { type: "string", minLength: 1, description: "The exact nextCursor returned by a prior dialog.list call with the same status filter." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "The maximum collaborators to return." } }, additionalProperties: false },
    capability: { freshnessClass: "runtime", latencyClass: "low", costClass: "free", executionClass: "external_side_effect", allowedInteractionModes: ["chat", "plan", "build"], capabilityClasses: ["runtime.dialog"], approvalCapabilities: ["delegation.control"] },
    presentation: { displayName: "List Dialogs", aliases: ["list collaborators"], keywords: ["dialog", "list"], provider: "kestrel", toolFamily: "runtime" },
  },
  createHandler(context) {
    if (context.dialogService === undefined || context.runtime === undefined) throw createRuntimeFailure("TOOL_CONTEXT_INVALID", "dialog.list requires an active dialog runtime.", { subsystem: "tooling", toolName: "dialog.list", classification: "configuration", recoverable: false });
    return async (input) => {
      const body = parseObjectInput("dialog.list", input);
      if (body.cursor !== undefined && (typeof body.cursor !== "string" || body.cursor.trim().length === 0)) throw createRuntimeFailure("TOOL_INPUT_INVALID", "dialog.list.cursor must be nonempty.");
      if (body.status !== undefined && body.status !== "open" && body.status !== "closed" && body.status !== "all") throw createRuntimeFailure("TOOL_INPUT_INVALID", "dialog.list.status must be open, closed, or all.");
      return context.dialogService!.list({ parentSessionId: context.runtime!.threadId ?? context.runtime!.sessionId, ...(body.status === undefined ? {} : { status: body.status }), ...(typeof body.cursor === "string" ? { cursor: body.cursor } : {}), ...(typeof body.limit === "number" ? { limit: body.limit } : {}) });
    };
  },
};
