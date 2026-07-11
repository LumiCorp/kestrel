import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

const MAX_TITLE_LENGTH = 80;

export const agentSpawnTool: SharedToolModule = {
  definition: {
    name: "agent.spawn",
    description: "Spawn a runtime-native subagent for a scoped task.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
      },
      required: ["task"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "runtime",
      latencyClass: "low",
      costClass: "free",
      executionClass: "sandboxed_only",
      capabilityClasses: ["runtime.agent.spawn"],
    },
    presentation: {
      displayName: "Spawn Agent",
      aliases: ["spawn agent", "subagent", "delegate task"],
      keywords: ["agent", "spawn", "subagent", "delegate", "task"],
      provider: "kestrel",
      toolFamily: "runtime",
    },
  },
  createHandler(context) {
    if (context.delegationService === undefined) {
      throw createRuntimeFailure(
        "TOOL_CONTEXT_INVALID",
        "agent.spawn requires tool context.delegationService.",
        {
          subsystem: "tooling",
          toolName: "agent.spawn",
          classification: "configuration",
          recoverable: false,
        },
      );
    }
    if (context.runtime === undefined) {
      throw createRuntimeFailure(
        "TOOL_CONTEXT_INVALID",
        "agent.spawn requires tool context.runtime.",
        {
          subsystem: "tooling",
          toolName: "agent.spawn",
          classification: "configuration",
          recoverable: false,
        },
      );
    }

    return async (input: unknown) => {
      const body = parseObjectInput("agent.spawn", input);
      const task = requireStringField("agent.spawn", body, "task");
      const runtime = context.runtime!;
      return context.delegationService!.spawnTask({
        parentSessionId: runtime.threadId ?? runtime.sessionId,
        parentRunId: runtime.runId,
        title: titleFromTask(task),
        prompt: task,
        launchedBy: "agent",
        ...(runtime.activeTaskId !== undefined
          ? {
              taskId: runtime.activeTaskId,
              parentTaskId: runtime.activeTaskId,
            }
          : {}),
        ...(runtime.delegationDepth !== undefined ? { delegationDepth: runtime.delegationDepth } : {}),
        ...(runtime.rootDelegationId !== undefined || runtime.delegationId !== undefined
          ? { rootDelegationId: runtime.rootDelegationId ?? runtime.delegationId }
          : {}),
      });
    };
  },
};

function titleFromTask(task: string): string {
  const firstLine = task.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = firstLine.length > 0 ? firstLine : "Delegated task";
  if (title.length <= MAX_TITLE_LENGTH) {
    return title;
  }
  return `${title.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
}
