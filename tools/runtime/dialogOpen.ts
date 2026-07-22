import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

export const dialogOpenTool: SharedToolModule = {
  definition: {
    name: "dialog.open",
    description: "Open a persistent private dialog with a collaborator. Choose a bird-species name and send the first message. The collaborator replies asynchronously in the thread.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", maxLength: 40 }, message: { type: "string" } },
      required: ["name", "message"],
      additionalProperties: false,
    },
    capability: { freshnessClass: "runtime", latencyClass: "low", costClass: "free", executionClass: "sandboxed_only", capabilityClasses: ["runtime.dialog"] },
    presentation: { displayName: "Open Dialog", aliases: ["open collaborator dialog"], keywords: ["dialog", "collaborator"], provider: "kestrel", toolFamily: "runtime" },
  },
  createHandler(context) {
    if (context.dialogService === undefined || context.runtime === undefined) {
      throw createRuntimeFailure("TOOL_CONTEXT_INVALID", "dialog.open requires an active dialog runtime.", { subsystem: "tooling", toolName: "dialog.open", classification: "configuration", recoverable: false });
    }
    return async (input) => {
      const body = parseObjectInput("dialog.open", input);
      const runtime = context.runtime!;
      if (runtime.delegationId !== undefined || (runtime.delegationDepth ?? 0) > 0) {
        throw createRuntimeFailure("DIALOG_NESTING_FORBIDDEN", "Only Kestrel can open collaborator dialogs.", { dialogId: runtime.delegationId });
      }
      return context.dialogService!.open({
        parentSessionId: runtime.threadId ?? runtime.sessionId,
        parentRunId: runtime.runId,
        name: requireStringField("dialog.open", body, "name"),
        message: requireStringField("dialog.open", body, "message"),
      });
    };
  },
};
