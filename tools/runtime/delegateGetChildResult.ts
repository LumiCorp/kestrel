import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

export const delegateGetChildResultTool: SharedToolModule = {
  definition: {
    name: "delegate.get_child_result",
    description: "Fetch the latest result summary for a child session task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "runtime",
      latencyClass: "low",
      costClass: "free",
      executionClass: "sandboxed_only",
      capabilityClasses: ["runtime.delegation.result"],
    },
    presentation: {
      displayName: "Get Child Result",
      aliases: ["child result", "subagent result", "task result"],
      keywords: ["delegate", "subagent", "task", "result"],
      provider: "kestrel",
      toolFamily: "runtime",
    },
  },
  createHandler(context) {
    if (context.delegationService === undefined) {
      throw createRuntimeFailure(
        "TOOL_CONTEXT_INVALID",
        "delegate.get_child_result requires tool context.delegationService.",
        {
          subsystem: "tooling",
          toolName: "delegate.get_child_result",
          classification: "configuration",
          recoverable: false,
        },
      );
    }

    return async (input: unknown) => {
      const body = parseObjectInput("delegate.get_child_result", input);
      return context.delegationService!.getTaskResult(
        requireStringField("delegate.get_child_result", body, "taskId"),
      );
    };
  },
};
