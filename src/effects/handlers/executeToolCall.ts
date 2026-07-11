import { randomUUID } from "node:crypto";

import type { AgentToolResult, ToolGateway } from "../../kestrel/contracts/model-io.js";
import type {
  PersistedEffect,
  SessionRecord,
} from "../../kestrel/contracts/store.js";
import type { EffectExecutionContext } from "../EffectRegistry.js";
import { createEffectPayloadError } from "../errors.js";
import { applyExternalDeadlineToolBudget } from "../../engine/ExecutionEngineSupport.js";

export function createExecuteToolCallHandler(toolGateway: ToolGateway) {
  return async function executeToolCallHandler(
    effect: PersistedEffect,
    context: EffectExecutionContext,
  ): Promise<AgentToolResult> {
    const payload =
      typeof effect.payload === "object" && effect.payload !== null && Array.isArray(effect.payload) === false
        ? (effect.payload as Record<string, unknown>)
        : undefined;
    const toolName = typeof payload?.toolName === "string" ? payload.toolName : undefined;
    const toolInput =
      typeof payload?.toolInput === "object" && payload.toolInput !== null && Array.isArray(payload.toolInput) === false
        ? (payload.toolInput as Record<string, unknown>)
        : undefined;
    const runtimePayload =
      typeof payload?.runtimePayload === "object" && payload.runtimePayload !== null && Array.isArray(payload.runtimePayload) === false
        ? (payload.runtimePayload as Record<string, unknown>)
        : undefined;

    if (toolName === undefined || toolInput === undefined) {
      throw createEffectPayloadError(
        effect.type,
        "execute_tool_call requires payload.toolName and payload.toolInput object fields.",
        {
          payloadKeys: payload === undefined ? [] : Object.keys(payload),
          toolNamePresent: toolName !== undefined,
          toolInputPresent: toolInput !== undefined,
        },
      );
    }

    if (toolGateway.preRun !== undefined) {
      const session: SessionRecord = context.session ?? {
        sessionId: context.sessionId,
        version: 0,
        state: {},
        updatedAt: new Date().toISOString(),
      };
      await toolGateway.preRun({
        runId: context.runId,
        event: {
          id: `effect-tool-execute:${context.runId}:${randomUUID()}`,
          type: effect.type,
          sessionId: context.sessionId,
          payload: runtimePayload ?? {},
          ...(session.currentStepAgent !== undefined ? { stepAgent: session.currentStepAgent } : {}),
        },
        session,
      });
    }

    const runContext = {
      runId: context.runId,
      sessionId: context.sessionId,
      payload: runtimePayload ?? {},
      sessionState: context.session?.state ?? {},
    };
    const validatedToolInput = toolGateway.validateInput === undefined
      ? toolInput
      : await toolGateway.validateInput(toolName, toolInput, {
          signal: context.signal,
          runContext,
        });
    const budgetedToolInput = context.runtimeBudgetRemainingMs === undefined
      ? { input: validatedToolInput, shortCircuitResult: undefined }
      : applyExternalDeadlineToolBudget({
          toolName,
          input: validatedToolInput,
          runtimeBudgetRemainingMs: context.runtimeBudgetRemainingMs,
        });
    if (budgetedToolInput.shortCircuitResult !== undefined) {
      const { buildAgentToolSuccessResult } = await import("../../../tools/toolResult.js");
      return buildAgentToolSuccessResult({
        toolName,
        input: budgetedToolInput.input,
        output: budgetedToolInput.shortCircuitResult,
      });
    }

    return toolGateway.call(toolName, budgetedToolInput.input, {
      signal: context.signal,
      runContext,
    });
  };
}
