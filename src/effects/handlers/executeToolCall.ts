import type { AgentToolResult, ToolGateway } from "../../kestrel/contracts/model-io.js";
import { parsePreparedToolCallV1 } from "../../kestrel/contracts/tool-invocation.js";
import type { PersistedEffect } from "../../kestrel/contracts/store.js";
import type { EffectExecutionContext } from "../EffectRegistry.js";
import { createEffectPayloadError } from "../errors.js";

export function createExecuteToolCallHandler(
  toolGateway: ToolGateway,
) {
  return async function executeToolCallHandler(
    effect: PersistedEffect,
    context: EffectExecutionContext,
  ): Promise<AgentToolResult> {
    const payload =
      typeof effect.payload === "object" && effect.payload !== null && Array.isArray(effect.payload) === false
        ? (effect.payload as Record<string, unknown>)
        : undefined;
    let preparedToolCall;
    try {
      preparedToolCall = parsePreparedToolCallV1(payload?.preparedToolCall);
    } catch (error) {
      throw createEffectPayloadError(
        effect.type,
        "execute_tool_call requires payload.preparedToolCall V1 evidence.",
        {
          payloadKeys: payload === undefined ? [] : Object.keys(payload),
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    const runtimePayload =
      typeof payload?.runtimePayload === "object" && payload.runtimePayload !== null && Array.isArray(payload.runtimePayload) === false
        ? (payload.runtimePayload as Record<string, unknown>)
        : undefined;

    const runContext = {
      runId: context.runId,
      sessionId: context.sessionId,
      payload: runtimePayload ?? {},
      sessionState: context.session?.state ?? {},
    };
    const result = await toolGateway.executePreparedToolCall(
      preparedToolCall,
      {
        signal: context.signal,
        runContext,
        persistCompletedCapabilityResult: context.persistCompletedCapabilityResult,
        acknowledgeExternalEffect: context.acknowledgeExternalEffect,
      },
    );
    return result;
  };
}
