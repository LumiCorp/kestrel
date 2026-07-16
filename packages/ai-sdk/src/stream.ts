import type {
  RunnerRunStreamEvent,
  RunnerRunTerminalEvent,
} from "@kestrel-agents/sdk";
import type { UIMessageStreamWriter } from "ai";
import { createKestrelPresentationAccumulator } from "./accumulator.js";
import type {
  KestrelPresentationPart,
  KestrelPresentationSnapshot,
  KestrelUIMessage,
} from "./contracts.js";

export async function writeKestrelRunnerStreamToUIMessage(input: {
  writer: UIMessageStreamWriter<KestrelUIMessage>;
  events: AsyncIterable<RunnerRunStreamEvent>;
  terminalEvent: Promise<RunnerRunTerminalEvent>;
  assistantMessageId: string;
  textPartId: string;
  turnId?: string | undefined;
  onPart?: ((part: KestrelPresentationPart) => void) | undefined;
  onEvent?: ((event: RunnerRunStreamEvent) => void) | undefined;
}): Promise<KestrelPresentationSnapshot> {
  const accumulator = createKestrelPresentationAccumulator({
    assistantMessageId: input.assistantMessageId,
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
  });
  input.writer.write({ type: "start", messageId: input.assistantMessageId });
  input.writer.write({ type: "text-start", id: input.textPartId });
  const emittedPartIds = new Set<string>();

  const writeParts = (parts: KestrelPresentationPart[]) => {
    for (const part of parts) {
      if ("id" in part && typeof part.id === "string") {
        if (emittedPartIds.has(part.id)) {
          continue;
        }
        emittedPartIds.add(part.id);
      }
      input.onPart?.(part);
      if (part.type.startsWith("data-")) {
        const chunk = part.type === "data-kestrel-provider-reasoning"
          ? { ...part, transient: true }
          : part;
        input.writer.write(chunk as Parameters<typeof input.writer.write>[0]);
      }
    }
  };

  try {
    for await (const event of input.events) {
      input.onEvent?.(event);
      writeParts(accumulator.append(event));
    }
  } catch (error) {
    writeParts(accumulator.fail(error));
  }

  let snapshot: KestrelPresentationSnapshot;
  try {
    snapshot = accumulator.finish(await input.terminalEvent);
  } catch (error) {
    writeParts(accumulator.fail(error));
    snapshot = accumulator.snapshot();
  }

  for (const part of snapshot.message.parts) {
    if (part.type.startsWith("data-")) {
      writeParts([part]);
    }
  }
  if (snapshot.assistantText !== null) {
    input.writer.write({
      type: "text-delta",
      id: input.textPartId,
      delta: snapshot.assistantText,
    });
  }
  input.writer.write({ type: "text-end", id: input.textPartId });
  input.writer.write({
    type: "message-metadata",
    messageMetadata: snapshot.message.metadata ?? {
      kestrelTerminalStatus: snapshot.terminalStatus,
    },
  });
  return snapshot;
}

export function writeKestrelFailureToUIMessage(input: {
  writer: UIMessageStreamWriter<KestrelUIMessage>;
  error: unknown;
  assistantMessageId: string;
  textPartId: string;
  turnId?: string | undefined;
  onPart?: ((part: KestrelPresentationPart) => void) | undefined;
}): Promise<KestrelPresentationSnapshot> {
  return writeKestrelRunnerStreamToUIMessage({
    writer: input.writer,
    events: failingEvents(input.error),
    terminalEvent: Promise.reject(input.error),
    assistantMessageId: input.assistantMessageId,
    textPartId: input.textPartId,
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.onPart !== undefined ? { onPart: input.onPart } : {}),
  });
}

async function* failingEvents(error: unknown): AsyncIterable<RunnerRunStreamEvent> {
  throw error;
}
