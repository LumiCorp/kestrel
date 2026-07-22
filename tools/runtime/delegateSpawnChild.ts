import type { SharedToolModule } from "../contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { parseObjectInput, requireStringField } from "../helpers.js";

export const delegateSpawnChildTool: SharedToolModule = {
  definition: {
    name: "delegate.spawn_child",
    description: "Spawn a background child session to work on a scoped task.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        prompt: { type: "string" },
        profileId: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        resultContract: { type: "string" },
        parentSessionId: { type: "string" },
        parentRunId: { type: "string" },
        parentStepIndex: { type: "integer" },
      },
      required: ["title", "prompt", "parentSessionId"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "runtime",
      latencyClass: "low",
      costClass: "free",
      executionClass: "sandboxed_only",
      capabilityClasses: ["runtime.delegation.spawn"],
    },
    presentation: {
      displayName: "Spawn Child Session",
      aliases: ["spawn child", "delegate task", "subagent"],
      keywords: ["delegate", "subagent", "task", "background"],
      provider: "kestrel",
      toolFamily: "runtime",
    },
  },
  createHandler(context) {
    if (context.delegationService === undefined) {
      throw createRuntimeFailure(
        "TOOL_CONTEXT_INVALID",
        "delegate.spawn_child requires tool context.delegationService.",
        {
          subsystem: "tooling",
          toolName: "delegate.spawn_child",
          classification: "configuration",
          recoverable: false,
        },
      );
    }

    return async (input: unknown) => {
      const body = parseObjectInput("delegate.spawn_child", input);
      const task = await context.delegationService!.spawnTask({
        title: requireStringField("delegate.spawn_child", body, "title"),
        prompt: requireStringField("delegate.spawn_child", body, "prompt"),
        parentSessionId: requireStringField("delegate.spawn_child", body, "parentSessionId"),
        ...(typeof body.parentRunId === "string" ? { parentRunId: body.parentRunId } : {}),
        ...(typeof body.parentStepIndex === "number"
          ? { parentStepIndex: Math.trunc(body.parentStepIndex) }
          : {}),
        ...(typeof body.profileId === "string" ? { profileId: body.profileId } : {}),
        ...(typeof body.provider === "string"
          ? { provider: body.provider as "openrouter" | "openai" | "anthropic" }
          : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(typeof body.resultContract === "string" ? { resultContract: body.resultContract } : {}),
        launchedBy: "agent",
      });

      return task;
    };
  },
};
