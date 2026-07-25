import type { UIMessage } from "ai";
import { findSubmittedToolApproval } from "./tool-approval-response";

/**
 * The server owns durable Thread history. A turn submission carries exactly one
 * client action instead of replaying server-authored messages.
 */
function selectCurrentThreadTurnAction<T extends UIMessage>(messages: T[]) {
  const currentMessage = messages.at(-1);
  if (currentMessage?.role === "user") {
    return { message: currentMessage };
  }
  const approvalResponse = findSubmittedToolApproval(
    currentMessage ? [currentMessage] : []
  );
  return approvalResponse ? { approvalResponse } : {};
}

export function buildThreadTurnRequestBody<T extends UIMessage>(input: {
  messages: T[];
  model: string;
  interactionMode: string;
  body?: Record<string, unknown>;
}) {
  const {
    message: _message,
    messages: _messages,
    approvalResponse: _approvalResponse,
    model: _model,
    interactionMode: _interactionMode,
    ...additionalBody
  } = input.body ?? {};
  const hasInteractionResponse =
    additionalBody.interactionResponse !== undefined;

  return {
    ...additionalBody,
    model: input.model,
    interactionMode: input.interactionMode,
    ...(hasInteractionResponse
      ? {}
      : selectCurrentThreadTurnAction(input.messages)),
  };
}
