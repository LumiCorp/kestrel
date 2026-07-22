import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

export const dialogSendTool: SharedToolModule = {
  definition: {
    name: "dialog.send",
    description: "Send another message in an open collaborator dialog. The reply arrives asynchronously in the thread.",
    inputSchema: { type: "object", properties: { dialogId: { type: "string" }, message: { type: "string" } }, required: ["dialogId", "message"], additionalProperties: false },
    capability: { freshnessClass: "runtime", latencyClass: "low", costClass: "free", executionClass: "sandboxed_only", capabilityClasses: ["runtime.dialog"] },
    presentation: { displayName: "Send Dialog Message", aliases: ["reply to collaborator"], keywords: ["dialog", "reply"], provider: "kestrel", toolFamily: "runtime" },
  },
  createHandler(context) {
    if (context.dialogService === undefined || context.runtime === undefined) {
      throw createRuntimeFailure("TOOL_CONTEXT_INVALID", "dialog.send requires an active dialog runtime.", { subsystem: "tooling", toolName: "dialog.send", classification: "configuration", recoverable: false });
    }
    return async (input) => {
      const body = parseObjectInput("dialog.send", input);
      const runtime = context.runtime!;
      return context.dialogService!.send({ parentSessionId: runtime.threadId ?? runtime.sessionId, parentRunId: runtime.runId, dialogId: requireStringField("dialog.send", body, "dialogId"), message: requireStringField("dialog.send", body, "message") });
    };
  },
};
