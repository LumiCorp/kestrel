import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

export const dialogCloseTool: SharedToolModule = {
  definition: {
    name: "dialog.close",
    description: "Stop an open collaborator and end this private conversation for the current task. You can still read its messages and results. You cannot send another message, reopen the collaborator, or reuse its name. This cannot be undone.",
    inputSchema: { type: "object", properties: { dialogId: { type: "string", description: "The collaborator to stop." } }, required: ["dialogId"], additionalProperties: false },
    capability: { freshnessClass: "runtime", latencyClass: "low", costClass: "free", executionClass: "external_side_effect", allowedInteractionModes: ["chat", "plan", "build"], capabilityClasses: ["runtime.dialog"], approvalCapabilities: ["delegation.control"] },
    presentation: { displayName: "Close Dialog", aliases: ["finish collaborator dialog"], keywords: ["dialog", "close"], provider: "kestrel", toolFamily: "runtime" },
  },
  createHandler(context) {
    if (context.dialogService === undefined || context.runtime === undefined) {
      throw createRuntimeFailure("TOOL_CONTEXT_INVALID", "dialog.close requires an active dialog runtime.", { subsystem: "tooling", toolName: "dialog.close", classification: "configuration", recoverable: false });
    }
    return async (input) => {
      const body = parseObjectInput("dialog.close", input);
      const runtime = context.runtime!;
      return context.dialogService!.close({ parentSessionId: runtime.threadId ?? runtime.sessionId, parentRunId: runtime.runId, dialogId: requireStringField("dialog.close", body, "dialogId") });
    };
  },
};
