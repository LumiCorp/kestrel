import { randomUUID } from "node:crypto";

import type { AgentToolResult, ToolGateway } from "../../kestrel/contracts/model-io.js";
import type {
  PersistedEffect,
  SessionRecord,
} from "../../kestrel/contracts/store.js";
import type { EffectExecutionContext } from "../EffectRegistry.js";
import { createEffectPayloadError } from "../errors.js";
import { applyExternalDeadlineToolBudget } from "../../engine/ExecutionEngineSupport.js";
import type { RecoveryToolAdapterRegistry } from "../../engine/recovery/RecoveryRegistries.js";

export function createExecuteToolCallHandler(
  toolGateway: ToolGateway,
  recoveryToolAdapterRegistry?: RecoveryToolAdapterRegistry,
) {
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
    let result: AgentToolResult;
    if (budgetedToolInput.shortCircuitResult !== undefined) {
      const { buildAgentToolSuccessResult } = await import("../../../tools/toolResult.js");
      result = buildAgentToolSuccessResult({
        toolName,
        input: budgetedToolInput.input,
        output: budgetedToolInput.shortCircuitResult,
      });
    } else {
      result = await toolGateway.call(toolName, budgetedToolInput.input, {
        signal: context.signal,
        runContext,
      });
    }
    const recoveryAdapterId = typeof payload?.recoveryAdapterId === "string"
      ? payload.recoveryAdapterId
      : undefined;
    if (recoveryAdapterId === undefined) return result;
    const recoverySourceToolId = typeof payload?.recoverySourceToolId === "string"
      ? payload.recoverySourceToolId
      : undefined;
    if (recoveryToolAdapterRegistry === undefined || recoverySourceToolId === undefined) {
      throw createEffectPayloadError(
        effect.type,
        "Recovery tool effect is missing its exact adapter registry or source tool identity.",
      );
    }
    const adapter = recoveryToolAdapterRegistry.resolve({
      adapterId: recoveryAdapterId,
      sourceToolId: recoverySourceToolId,
      targetToolId: toolName,
    });
    if (adapter === undefined) {
      throw createEffectPayloadError(
        effect.type,
        `Recovery tool adapter '${recoveryAdapterId}' is not registered for the exact source and target.`,
      );
    }
    const decision = typeof payload?.recoveryDecision === "object" && payload.recoveryDecision !== null
      ? payload.recoveryDecision as Record<string, unknown>
      : undefined;
    return adapter.normalizeResult(result, {
      runId: context.runId,
      sessionId: context.sessionId,
      sourceToolId: recoverySourceToolId,
      targetToolId: toolName,
      ...(typeof decision?.callId === "string" ? { sourceCallId: decision.callId } : {}),
    });
  };
}
