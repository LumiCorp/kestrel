import {
  createKestrelStreamUiUpdateFilter,
  getKestrelStreamUiUpdate,
  getKestrelToolApprovalRequest,
  type KestrelStreamEventForUi,
  type KestrelTerminalStatus,
} from "@/lib/agent/kestrel-stream-events";

export type KestrelUiStreamChunk =
  | { type: "start"; messageId: string }
  | { type: "text-start"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      dynamic: true;
    }
  | { type: "tool-approval-request"; approvalId: string; toolCallId: string }
  | {
      type: "message-metadata";
      messageMetadata: { kestrelTerminalStatus: KestrelTerminalStatus };
    }
  | {
      type: "data-chat-title";
      data: { title: string };
      transient: true;
    }
  | { type: "finish"; finishReason: "stop" };

export type KestrelUiStreamWriter = {
  write(chunk: KestrelUiStreamChunk): void;
};

export type KestrelUiStreamResult = {
  finalText: string;
  errorMessage: string | null;
  terminalStatus: KestrelTerminalStatus;
  failureVisible: boolean;
  approvalRequests: Array<{
    approvalId: string;
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }>;
};

export async function writeKestrelRunnerEventsToUi(input: {
  writer: KestrelUiStreamWriter;
  events: AsyncIterable<KestrelStreamEventForUi>;
  terminalEvent?: Promise<KestrelStreamEventForUi>;
  assistantMessageId: string;
  textPartId: string;
  reasoningPartId: string;
}): Promise<KestrelUiStreamResult> {
  const updateFilter = createKestrelStreamUiUpdateFilter();
  let reasoningStarted = false;
  let finalText = "";
  let errorMessage: string | null = null;
  let terminalStatus: KestrelTerminalStatus | null = null;
  let runnerErrorFallback = "";
  let terminalEventSeen = false;
  const approvalRequests = new Map<
    string,
    {
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  >();

  const writeReasoningLine = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    if (!reasoningStarted) {
      input.writer.write({
        type: "reasoning-start",
        id: input.reasoningPartId,
      });
      reasoningStarted = true;
    }

    input.writer.write({
      type: "reasoning-delta",
      id: input.reasoningPartId,
      delta: `${trimmed}\n`,
    });
  };

  const recordRunnerErrorFallback = (message: string) => {
    const fallback = message.trim();
    if (!fallback) {
      return;
    }
    runnerErrorFallback = fallback;
    errorMessage = fallback;
    terminalStatus = "runner_error";
  };

  const applyTerminalEvent = (event: KestrelStreamEventForUi) => {
    const terminalUpdate = getKestrelStreamUiUpdate(event);
    if (terminalUpdate?.kind !== "terminal") {
      return false;
    }

    terminalEventSeen = true;
    terminalStatus = terminalUpdate.terminalStatus;
    errorMessage = terminalUpdate.errorMessage;

    if (terminalUpdate.terminalStatus === "completed") {
      finalText = terminalUpdate.text;
      errorMessage = null;
      return true;
    }

    if (terminalUpdate.terminalStatus === "empty") {
      finalText = "";
      return true;
    }

    finalText = terminalUpdate.text;
    return true;
  };

  input.writer.write({ type: "start", messageId: input.assistantMessageId });
  input.writer.write({ type: "text-start", id: input.textPartId });

  try {
    for await (const event of input.events) {
      const approval = getKestrelToolApprovalRequest(event);
      if (approval && !approvalRequests.has(approval.approvalId)) {
        approvalRequests.set(approval.approvalId, {
          approvalId: approval.approvalId,
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          input: approval.input,
        });
        input.writer.write({
          type: "tool-input-available",
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          input: approval.input,
          dynamic: true,
        });
        input.writer.write({
          type: "tool-approval-request",
          approvalId: approval.approvalId,
          toolCallId: approval.toolCallId,
        });
      }
      const update = updateFilter.read(event);
      if (!update) {
        continue;
      }

      if (update.kind === "progress") {
        writeReasoningLine(update.text);
        if (update.severity === "error" && update.errorMessage) {
          recordRunnerErrorFallback(update.errorMessage);
        }
        continue;
      }

      terminalEventSeen = true;
      terminalStatus = update.terminalStatus;
      errorMessage = update.errorMessage;
      if (update.terminalStatus === "completed") {
        errorMessage = null;
      }
      finalText = update.text;
      break;
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The Kestrel runtime stream failed.";
    writeReasoningLine(message);
    recordRunnerErrorFallback(message);
  }

  if (!(terminalEventSeen || finalText) && input.terminalEvent) {
    try {
      applyTerminalEvent(await input.terminalEvent);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The Kestrel runtime stream failed.";
      writeReasoningLine(message);
      recordRunnerErrorFallback(message);
    }
  }

  if (!finalText) {
    terminalStatus = terminalStatus ?? (runnerErrorFallback ? "runner_error" : "empty");
  }

  terminalStatus = terminalStatus ?? "empty";
  const failureVisible = isVisibleFailureStatus(terminalStatus);

  if (reasoningStarted) {
    input.writer.write({ type: "reasoning-end", id: input.reasoningPartId });
  }
  if (finalText) {
    input.writer.write({
      type: "text-delta",
      id: input.textPartId,
      delta: finalText,
    });
  }
  input.writer.write({ type: "text-end", id: input.textPartId });
  input.writer.write({
    type: "message-metadata",
    messageMetadata: { kestrelTerminalStatus: terminalStatus },
  });

  return {
    finalText,
    errorMessage,
    terminalStatus,
    failureVisible,
    approvalRequests: [...approvalRequests.values()],
  };
}

function isVisibleFailureStatus(status: KestrelTerminalStatus) {
  return (
    status === "failed" || status === "cancelled" || status === "runner_error"
  );
}
