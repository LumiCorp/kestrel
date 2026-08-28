import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

export const dialogOpenTool: SharedToolModule = {
  definition: {
    name: "dialog.open",
    description: "Start a private conversation with a named collaborator and send the first message. Use this when another collaborator can research, review, investigate, compare choices, or work on a different part of the task while you continue. Their reply will come back to you later. If that name already exists, this returns the saved collaborator without sending the message again. The name cannot be changed or reused in this task, even after you close the collaborator.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", maxLength: 40, description: "A short, memorable, immutable name. An existing name returns that collaborator instead of creating another one." }, message: { type: "string", description: "The work or question, with needed context. It is sent only when this call creates the collaborator." } },
      required: ["name", "message"],
      additionalProperties: false,
    },
    capability: { freshnessClass: "runtime", latencyClass: "low", costClass: "free", executionClass: "external_side_effect", allowedInteractionModes: ["chat", "plan", "build"], capabilityClasses: ["runtime.dialog"], approvalCapabilities: ["delegation.control"] },
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
        throw createRuntimeFailure("DIALOG_NESTING_FORBIDDEN", "Only Kestrel in the main conversation can open collaborators. Continue without opening another collaborator.", { dialogId: runtime.delegationId });
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
