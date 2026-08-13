import {
  writeKestrelRunnerStreamToUIMessage,
  type KestrelUIMessage,
} from "@kestrel-agents/ai-sdk";
import {
  parseRunnerEventV2,
  type RunnerConversationMessage,
  type RunnerRunStreamEvent,
  type RunnerRunTerminalEvent,
} from "@kestrel-agents/sdk";
import type { InferUIMessageChunk, UIMessageStreamWriter } from "ai";
import type { ChatMessage } from "@/lib/types";

interface KestrelUiStreamWriter {
  write(chunk: InferUIMessageChunk<ChatMessage>): void;
}

export function createRecoveredKestrelOneCompletion(input: {
  runtimeRunId: string;
  sessionId: string;
  terminalEventId: string;
  completedAt: string;
  messages: RunnerConversationMessage[];
}): RunnerRunTerminalEvent {
  const message = input.messages.find(
    (candidate) => candidate.runId === input.runtimeRunId,
  );
  if (!message) {
    throw new Error("The completed agent message is unavailable for recovery.");
  }
  const event = parseRunnerEventV2({
    id: input.terminalEventId,
    type: "run.completed",
    ts: input.completedAt,
    runId: input.runtimeRunId,
    sessionId: input.sessionId,
    threadId: input.sessionId,
    payload: { result: message.result },
  });
  if (event.type !== "run.completed") {
    throw new Error("Recovered runner completion was invalid.");
  }
  return event;
}

export async function writeKestrelReconnectStreamToUi(input: {
  writer: KestrelUiStreamWriter;
  events: AsyncIterable<RunnerRunStreamEvent>;
  assistantMessageId: string;
  textPartId: string;
  reasoningPartId: string;
}) {
  const replayed: RunnerRunStreamEvent[] = [];
  let terminal: RunnerRunTerminalEvent | undefined;
  for await (const event of input.events) {
    replayed.push(event);
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      terminal = event;
    }
  }
  const result = await writeKestrelRunnerStreamToUIMessage({
    writer: input.writer as UIMessageStreamWriter<KestrelUIMessage>,
    events: streamEvents(replayed),
    terminalEvent:
      terminal !== undefined
        ? Promise.resolve(terminal)
        : Promise.reject(
            new Error("Reconnected Kestrel stream ended without a terminal event."),
          ),
    assistantMessageId: input.assistantMessageId,
    textPartId: input.textPartId,
  });
  input.writer.write({ type: "finish", finishReason: "stop" });
  return { ...result, finalText: result.assistantText ?? "" };
}

async function* streamEvents(events: RunnerRunStreamEvent[]) {
  for (const event of events) {
    yield event;
  }
}
