import type { AgentToolResult, ToolGateway } from "../../kestrel/contracts/model-io.js";
import {
  parseAgentToolResultV2,
  parsePreparedToolCallV1,
  type AgentToolResultV2,
} from "../../kestrel/contracts/tool-invocation.js";
import type { PersistedEffect } from "../../kestrel/contracts/store.js";
import type { EffectExecutionContext } from "../EffectRegistry.js";
import { createEffectPayloadError } from "../errors.js";
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
    const result: AgentToolResultV2 = await toolGateway.executePreparedToolCall(
      preparedToolCall,
      {
        signal: context.signal,
        runContext,
      },
    );
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
      targetToolId: preparedToolCall.activation.descriptor.toolId,
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
    const normalized = adapter.normalizeResult(result, {
      runId: context.runId,
      sessionId: context.sessionId,
      sourceToolId: recoverySourceToolId,
      targetToolId: preparedToolCall.activation.descriptor.toolId,
      ...(typeof decision?.callId === "string" ? { sourceCallId: decision.callId } : {}),
    });
    if (
      normalized.toolName !== result.toolName ||
      normalized.status !== result.status
    ) {
      throw createEffectPayloadError(
        effect.type,
        `Recovery tool adapter '${recoveryAdapterId}' attempted to replace gateway-owned result identity.`,
      );
    }
    return parseAgentToolResultV2({
      ...normalized,
      version: result.version,
      toolCallId: result.toolCallId,
      activation: result.activation,
      outcome: result.outcome,
    });
  };
}
