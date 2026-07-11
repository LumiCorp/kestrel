import type { FinishReason, ProviderMetadata, UIMessageChunk } from "ai";
import type { CustomUIDataTypes, MessageMetadata } from "@/lib/types";

export type ChatStreamChunk = UIMessageChunk<
  MessageMetadata,
  CustomUIDataTypes
>;

export type ChatStreamWarningData = CustomUIDataTypes["stream-warning"];
export type ChatResumeWarningData = CustomUIDataTypes["resume-warning"];

const allowedDataChunkTypes = new Set([
  "data-appendMessage",
  "data-chat-title",
  "data-clear",
  "data-codeDelta",
  "data-finish",
  "data-id",
  "data-imageDelta",
  "data-kind",
  "data-resume-warning",
  "data-sheetDelta",
  "data-stream-resumed",
  "data-stream-warning",
  "data-suggestion",
  "data-textDelta",
  "data-title",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptionalBoolean(
  value: Record<string, unknown>,
  key: string
): boolean | undefined {
  return typeof value[key] === "boolean" ? (value[key] as boolean) : undefined;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  return typeof value[key] === "string" ? (value[key] as string) : undefined;
}

function readOptionalProviderMetadata(
  value: Record<string, unknown>
): ProviderMetadata | undefined {
  return isRecord(value.providerMetadata)
    ? (value.providerMetadata as ProviderMetadata)
    : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.hasOwn(value, key);
}

function createBaseChunk(
  type: ChatStreamChunk["type"]
): Pick<ChatStreamChunk, "type"> {
  return { type };
}

export function createChatStreamWarningChunk(
  droppedChunkCount: number
): ChatStreamChunk {
  return {
    type: "data-stream-warning",
    data: { droppedChunkCount },
    transient: true,
  };
}

export function createChatResumeWarningChunk(message: string): ChatStreamChunk {
  return {
    type: "data-resume-warning",
    data: { message },
    transient: true,
  };
}

export function createChatStreamResumedChunk(): ChatStreamChunk {
  return {
    type: "data-stream-resumed",
    data: null,
    transient: true,
  };
}

export function normalizeChatStreamChunk(raw: unknown): ChatStreamChunk | null {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return null;
  }

  switch (raw.type) {
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end": {
      const id = readOptionalString(raw, "id");
      if (!id) {
        return null;
      }

      return {
        ...createBaseChunk(raw.type),
        id,
        ...(readOptionalProviderMetadata(raw)
          ? { providerMetadata: readOptionalProviderMetadata(raw) }
          : {}),
      } as ChatStreamChunk;
    }

    case "text-delta":
    case "reasoning-delta": {
      const id = readOptionalString(raw, "id");
      const delta = readOptionalString(raw, "delta");

      if (!id || delta === undefined) {
        return null;
      }

      return {
        ...createBaseChunk(raw.type),
        id,
        delta,
        ...(readOptionalProviderMetadata(raw)
          ? { providerMetadata: readOptionalProviderMetadata(raw) }
          : {}),
      } as ChatStreamChunk;
    }

    case "error": {
      const errorText = readOptionalString(raw, "errorText");
      return errorText ? { type: "error", errorText } : null;
    }

    case "tool-input-start": {
      const toolCallId = readOptionalString(raw, "toolCallId");
      const toolName = readOptionalString(raw, "toolName");

      if (!(toolCallId && toolName)) {
        return null;
      }

      return {
        type: "tool-input-start",
        toolCallId,
        toolName,
        ...(readOptionalBoolean(raw, "providerExecuted") !== undefined
          ? { providerExecuted: readOptionalBoolean(raw, "providerExecuted") }
          : {}),
        ...(readOptionalBoolean(raw, "dynamic") !== undefined
          ? { dynamic: readOptionalBoolean(raw, "dynamic") }
          : {}),
        ...(readOptionalString(raw, "title")
          ? { title: readOptionalString(raw, "title") }
          : {}),
      };
    }

    case "tool-input-delta": {
      const toolCallId = readOptionalString(raw, "toolCallId");
      const inputTextDelta = readOptionalString(raw, "inputTextDelta");

      return toolCallId && inputTextDelta !== undefined
        ? { type: "tool-input-delta", toolCallId, inputTextDelta }
        : null;
    }

    case "tool-input-available":
    case "tool-input-error": {
      const toolCallId = readOptionalString(raw, "toolCallId");
      const toolName = readOptionalString(raw, "toolName");

      if (!(toolCallId && toolName && hasOwn(raw, "input"))) {
        return null;
      }

      if (raw.type === "tool-input-error") {
        const errorText = readOptionalString(raw, "errorText");
        if (!errorText) {
          return null;
        }

        return {
          type: "tool-input-error",
          toolCallId,
          toolName,
          input: raw.input,
          errorText,
          ...(readOptionalBoolean(raw, "providerExecuted") !== undefined
            ? { providerExecuted: readOptionalBoolean(raw, "providerExecuted") }
            : {}),
          ...(readOptionalProviderMetadata(raw)
            ? { providerMetadata: readOptionalProviderMetadata(raw) }
            : {}),
          ...(readOptionalBoolean(raw, "dynamic") !== undefined
            ? { dynamic: readOptionalBoolean(raw, "dynamic") }
            : {}),
          ...(readOptionalString(raw, "title")
            ? { title: readOptionalString(raw, "title") }
            : {}),
        };
      }

      return {
        type: "tool-input-available",
        toolCallId,
        toolName,
        input: raw.input,
        ...(readOptionalBoolean(raw, "providerExecuted") !== undefined
          ? { providerExecuted: readOptionalBoolean(raw, "providerExecuted") }
          : {}),
        ...(readOptionalProviderMetadata(raw)
          ? { providerMetadata: readOptionalProviderMetadata(raw) }
          : {}),
        ...(readOptionalBoolean(raw, "dynamic") !== undefined
          ? { dynamic: readOptionalBoolean(raw, "dynamic") }
          : {}),
        ...(readOptionalString(raw, "title")
          ? { title: readOptionalString(raw, "title") }
          : {}),
      };
    }

    case "tool-approval-request": {
      const approvalId = readOptionalString(raw, "approvalId");
      const toolCallId = readOptionalString(raw, "toolCallId");
      return approvalId && toolCallId
        ? { type: "tool-approval-request", approvalId, toolCallId }
        : null;
    }

    case "tool-output-available": {
      const toolCallId = readOptionalString(raw, "toolCallId");
      if (!(toolCallId && hasOwn(raw, "output"))) {
        return null;
      }

      return {
        type: "tool-output-available",
        toolCallId,
        output: raw.output,
        ...(readOptionalBoolean(raw, "providerExecuted") !== undefined
          ? { providerExecuted: readOptionalBoolean(raw, "providerExecuted") }
          : {}),
        ...(readOptionalBoolean(raw, "dynamic") !== undefined
          ? { dynamic: readOptionalBoolean(raw, "dynamic") }
          : {}),
        ...(readOptionalBoolean(raw, "preliminary") !== undefined
          ? { preliminary: readOptionalBoolean(raw, "preliminary") }
          : {}),
      };
    }

    case "tool-output-error": {
      const toolCallId = readOptionalString(raw, "toolCallId");
      const errorText = readOptionalString(raw, "errorText");
      return toolCallId && errorText
        ? {
            type: "tool-output-error",
            toolCallId,
            errorText,
            ...(readOptionalBoolean(raw, "providerExecuted") !== undefined
              ? {
                  providerExecuted: readOptionalBoolean(
                    raw,
                    "providerExecuted"
                  ),
                }
              : {}),
            ...(readOptionalBoolean(raw, "dynamic") !== undefined
              ? { dynamic: readOptionalBoolean(raw, "dynamic") }
              : {}),
          }
        : null;
    }

    case "tool-output-denied": {
      const toolCallId = readOptionalString(raw, "toolCallId");
      return toolCallId ? { type: "tool-output-denied", toolCallId } : null;
    }

    case "source-url": {
      const sourceId = readOptionalString(raw, "sourceId");
      const url = readOptionalString(raw, "url");

      if (!(sourceId && url)) {
        return null;
      }

      return {
        type: "source-url",
        sourceId,
        url,
        ...(readOptionalString(raw, "title")
          ? { title: readOptionalString(raw, "title") }
          : {}),
        ...(readOptionalProviderMetadata(raw)
          ? { providerMetadata: readOptionalProviderMetadata(raw) }
          : {}),
      };
    }

    case "source-document": {
      const sourceId = readOptionalString(raw, "sourceId");
      const mediaType = readOptionalString(raw, "mediaType");
      const title = readOptionalString(raw, "title");

      if (!(sourceId && mediaType && title)) {
        return null;
      }

      return {
        type: "source-document",
        sourceId,
        mediaType,
        title,
        ...(readOptionalString(raw, "filename")
          ? { filename: readOptionalString(raw, "filename") }
          : {}),
        ...(readOptionalProviderMetadata(raw)
          ? { providerMetadata: readOptionalProviderMetadata(raw) }
          : {}),
      };
    }

    case "file": {
      const url = readOptionalString(raw, "url");
      const mediaType = readOptionalString(raw, "mediaType");

      if (!(url && mediaType)) {
        return null;
      }

      return {
        type: "file",
        url,
        mediaType,
        ...(readOptionalProviderMetadata(raw)
          ? { providerMetadata: readOptionalProviderMetadata(raw) }
          : {}),
      };
    }

    case "start-step":
    case "finish-step":
      return { type: raw.type };

    case "start":
      return {
        type: "start",
        ...(readOptionalString(raw, "messageId")
          ? { messageId: readOptionalString(raw, "messageId") }
          : {}),
        ...(hasOwn(raw, "messageMetadata")
          ? { messageMetadata: raw.messageMetadata as MessageMetadata }
          : {}),
      };

    case "finish":
      return {
        type: "finish",
        ...(readOptionalString(raw, "finishReason")
          ? {
              finishReason: readOptionalString(
                raw,
                "finishReason"
              ) as FinishReason,
            }
          : {}),
        ...(hasOwn(raw, "messageMetadata")
          ? { messageMetadata: raw.messageMetadata as MessageMetadata }
          : {}),
      };

    case "abort":
      return {
        type: "abort",
        ...(readOptionalString(raw, "reason")
          ? { reason: readOptionalString(raw, "reason") }
          : {}),
      };

    case "message-metadata":
      return hasOwn(raw, "messageMetadata")
        ? {
            type: "message-metadata",
            messageMetadata: raw.messageMetadata as MessageMetadata,
          }
        : null;

    default: {
      if (
        !(raw.type.startsWith("data-") && allowedDataChunkTypes.has(raw.type))
      ) {
        return null;
      }

      if (!hasOwn(raw, "data")) {
        return null;
      }

      if (raw.type === "data-stream-warning") {
        const data = raw.data;
        if (
          !isRecord(data) ||
          typeof data.droppedChunkCount !== "number" ||
          !Number.isFinite(data.droppedChunkCount) ||
          data.droppedChunkCount < 1
        ) {
          return null;
        }
      }

      if (raw.type === "data-resume-warning") {
        const data = raw.data;
        if (
          !isRecord(data) ||
          typeof data.message !== "string" ||
          !data.message
        ) {
          return null;
        }
      }

      if (raw.type === "data-stream-resumed" && raw.data !== null) {
        return null;
      }

      return {
        type: raw.type as ChatStreamChunk["type"],
        data: raw.data as ChatStreamChunk extends { data: infer T } ? T : never,
        ...(readOptionalString(raw, "id")
          ? { id: readOptionalString(raw, "id") }
          : {}),
        ...(readOptionalBoolean(raw, "transient") !== undefined
          ? { transient: readOptionalBoolean(raw, "transient") }
          : {}),
      } as ChatStreamChunk;
    }
  }
}

export function sanitizeChatStream(
  stream: ReadableStream<unknown>,
  options: { emitWarnings?: boolean } = {}
): ReadableStream<ChatStreamChunk> {
  const { emitWarnings = true } = options;
  let droppedChunkCount = 0;

  return stream.pipeThrough(
    new TransformStream<unknown, ChatStreamChunk>({
      transform(chunk, controller) {
        const normalizedChunk = normalizeChatStreamChunk(chunk);

        if (!normalizedChunk) {
          droppedChunkCount += 1;
          return;
        }

        controller.enqueue(normalizedChunk);
      },
      flush(controller) {
        if (emitWarnings && droppedChunkCount > 0) {
          controller.enqueue(createChatStreamWarningChunk(droppedChunkCount));
        }
      },
    })
  );
}

const toolInvocationStartChunkTypes = new Set<ChatStreamChunk["type"]>([
  "tool-input-start",
  "tool-input-available",
  "tool-input-error",
]);

const toolInvocationDependentChunkTypes = new Set<ChatStreamChunk["type"]>([
  "tool-input-delta",
  "tool-approval-request",
  "tool-output-denied",
  "tool-output-available",
  "tool-output-error",
]);

const toolInvocationErrorChunkTypes = new Set<ChatStreamChunk["type"]>([
  "tool-input-error",
  "tool-output-error",
]);

export function reorderToolInvocationChunks(
  stream: ReadableStream<ChatStreamChunk>
) {
  const seenToolCallIds = new Set<string>();
  const pendingChunks = new Map<string, ChatStreamChunk[]>();

  const emitChunk = (
    chunk: ChatStreamChunk,
    controller: TransformStreamDefaultController<ChatStreamChunk>
  ) => {
    controller.enqueue(chunk);

    if (toolInvocationErrorChunkTypes.has(chunk.type)) {
      controller.enqueue({
        type: "error",
        errorText:
          "errorText" in chunk
            ? chunk.errorText
            : "The agent failed before it could finish the response.",
      });
      controller.terminate();
      return true;
    }

    return false;
  };

  return stream.pipeThrough(
    new TransformStream<ChatStreamChunk, ChatStreamChunk>({
      transform(chunk, controller) {
        const toolCallId = "toolCallId" in chunk ? chunk.toolCallId : undefined;

        if (!toolCallId) {
          emitChunk(chunk, controller);
          return;
        }

        if (toolInvocationStartChunkTypes.has(chunk.type)) {
          seenToolCallIds.add(toolCallId);

          if (emitChunk(chunk, controller)) {
            return;
          }

          const queuedChunks = pendingChunks.get(toolCallId);
          if (queuedChunks) {
            for (const queuedChunk of queuedChunks) {
              if (emitChunk(queuedChunk, controller)) {
                return;
              }
            }
            pendingChunks.delete(toolCallId);
          }

          return;
        }

        if (
          toolInvocationDependentChunkTypes.has(chunk.type) &&
          !seenToolCallIds.has(toolCallId)
        ) {
          const queuedChunks = pendingChunks.get(toolCallId) ?? [];
          queuedChunks.push(chunk);
          pendingChunks.set(toolCallId, queuedChunks);
          return;
        }

        emitChunk(chunk, controller);
      },
      flush(controller) {
        for (const queuedChunks of pendingChunks.values()) {
          for (const queuedChunk of queuedChunks) {
            if (emitChunk(queuedChunk, controller)) {
              return;
            }
          }
        }
      },
    })
  );
}
