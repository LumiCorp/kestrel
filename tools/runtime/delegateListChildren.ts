import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

export const delegateListChildrenTool: SharedToolModule = {
  definition: {
    name: "delegate.list_children",
    description: "List child sessions linked to a parent session.",
    inputSchema: {
      type: "object",
      properties: {
        parentSessionId: { type: "string" },
      },
      required: ["parentSessionId"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "runtime",
      latencyClass: "low",
      costClass: "free",
      executionClass: "sandboxed_only",
      capabilityClasses: ["runtime.delegation.list"],
    },
    presentation: {
      displayName: "List Child Sessions",
      aliases: ["list children", "list subagents", "task list"],
      keywords: ["delegate", "subagent", "task", "list"],
      provider: "kestrel",
      toolFamily: "runtime",
    },
  },
  createHandler(context) {
    if (context.delegationService === undefined) {
      throw createRuntimeFailure(
        "TOOL_CONTEXT_INVALID",
        "delegate.list_children requires tool context.delegationService.",
        {
          subsystem: "tooling",
          toolName: "delegate.list_children",
          classification: "configuration",
          recoverable: false,
        },
      );
    }

    return async (input: unknown) => {
      const body = parseObjectInput("delegate.list_children", input);
      return context.delegationService!.listTasks(
        requireStringField("delegate.list_children", body, "parentSessionId"),
      );
    };
  },
};
