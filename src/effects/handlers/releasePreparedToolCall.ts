import type { ToolGateway } from "../../kestrel/contracts/model-io.js";
import { parsePreparedToolCallV1 } from "../../kestrel/contracts/tool-invocation.js";
import type { PersistedEffect } from "../../kestrel/contracts/store.js";
import { createEffectPayloadError } from "../errors.js";

export function createReleasePreparedToolCallHandler(toolGateway: ToolGateway) {
  return async function releasePreparedToolCallHandler(
    effect: PersistedEffect,
  ): Promise<{ releasedPreparedInvocationId: string }> {
    let preparedToolCall;
    try {
      preparedToolCall = parsePreparedToolCallV1(
        effect.payload.preparedToolCall,
      );
    } catch (error) {
      throw createEffectPayloadError(
        effect.type,
        "release_prepared_tool_call requires exact preparedToolCall V1 evidence.",
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (toolGateway.releasePreparedToolCall === undefined) {
      throw createEffectPayloadError(
        effect.type,
        "The tool gateway cannot release prepared invocations.",
        { preparedInvocationId: preparedToolCall.callId },
      );
    }
    await toolGateway.releasePreparedToolCall(preparedToolCall);
    return { releasedPreparedInvocationId: preparedToolCall.callId };
  };
}
