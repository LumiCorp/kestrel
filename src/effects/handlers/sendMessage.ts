import type { PersistedEffect } from "../../kestrel/contracts/store.js";
import type { EffectExecutionContext } from "../EffectRegistry.js";
import { createEffectPayloadError } from "../errors.js";

export async function sendMessageHandler(
  effect: PersistedEffect,
  context: EffectExecutionContext,
): Promise<Record<string, unknown>> {
  const payload =
    typeof effect.payload === "object" && effect.payload !== null && Array.isArray(effect.payload) === false
      ? (effect.payload as Record<string, unknown>)
      : undefined;
  const recipient = resolveMessageRecipient(effect.type, payload);
  const body = resolveMessageBody(payload);

  if (typeof recipient !== "string" || typeof body !== "string") {
    throw createEffectPayloadError(
      effect.type,
      "message effects require a string message/body and optional string recipient.",
      {
        recipientType: typeof recipient,
        bodyType: typeof body,
      },
    );
  }

  return {
    provider: "mock-messenger",
    messageId: `${context.runId}:${effect.idempotencyKey}`,
    recipient,
    bodyLength: body.length,
  };
}

function resolveMessageRecipient(
  effectType: string,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (typeof payload?.recipient === "string" && payload.recipient.trim().length > 0) {
    return payload.recipient;
  }
  if (effectType === "assistant.respond") {
    return "operator";
  }
  return ;
}

function resolveMessageBody(payload: Record<string, unknown> | undefined): string | undefined {
  if (typeof payload?.body === "string" && payload.body.trim().length > 0) {
    return payload.body;
  }
  if (typeof payload?.message === "string" && payload.message.trim().length > 0) {
    return payload.message;
  }
  if (typeof payload?.content === "string" && payload.content.trim().length > 0) {
    return payload.content;
  }
  return ;
}
