"use client";

import {
  HttpChatTransport,
  type HttpChatTransportInitOptions,
  parseJsonEventStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { z } from "zod";
import {
  createChatResumeWarningChunk,
  createChatStreamResumedChunk,
  createChatStreamWarningChunk,
  normalizeChatStreamChunk,
} from "./stream-protocol";

const rawStreamEventSchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough();

export class CompatibleChatTransport<
  UI_MESSAGE extends UIMessage,
> extends HttpChatTransport<UI_MESSAGE> {
  constructor(options: HttpChatTransportInitOptions<UI_MESSAGE> = {}) {
    super(options);
  }

  protected processResponseStream(
    stream: ReadableStream<Uint8Array<ArrayBufferLike>>
  ) {
    let droppedChunkCount = 0;

    return parseJsonEventStream({
      stream,
      schema: rawStreamEventSchema,
    }).pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (!chunk.success) {
            droppedChunkCount += 1;
            return;
          }

          const normalizedChunk = normalizeChatStreamChunk(chunk.value);
          if (!normalizedChunk) {
            droppedChunkCount += 1;
            return;
          }

          controller.enqueue(normalizedChunk);
        },
        flush(controller) {
          if (droppedChunkCount > 0) {
            controller.enqueue(createChatStreamWarningChunk(droppedChunkCount));
          }
        },
      })
    );
  }

  async reconnectToStream(
    options: Parameters<HttpChatTransport<UI_MESSAGE>["reconnectToStream"]>[0]
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    let stream: ReadableStream<UIMessageChunk> | null;

    try {
      stream = await super.reconnectToStream(options);
    } catch {
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue(
            createChatResumeWarningChunk(
              "Response recovery is temporarily unavailable."
            )
          );
          controller.close();
        },
      });
    }

    if (!stream) {
      return null;
    }

    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        controller.enqueue(createChatStreamResumedChunk());

        const reader = stream.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            controller.enqueue(value);
          }
          controller.close();
        } catch {
          controller.enqueue(
            createChatResumeWarningChunk(
              "Response recovery stopped before the response finished."
            )
          );
          controller.close();
        } finally {
          reader.releaseLock();
        }
      },
    });
  }
}
