import type {
  AssistantModelMessage,
  ToolModelMessage,
  UIMessage,
  UIMessagePart,
} from "ai";
import { type ClassValue, clsx } from "clsx";
import { formatISO } from "date-fns";
import { twMerge } from "tailwind-merge";
import { ChatbotError, type ErrorCode } from "./errors";
import type {
  ArtifactDocument,
  ChatMessage,
  ChatTools,
  CustomUIDataTypes,
} from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    const { code, cause } = await response.json();
    throw new ChatbotError(code as ErrorCode, cause);
  }

  return response.json();
};

export async function fetchWithErrorHandlers(
  input: RequestInfo | URL,
  init?: RequestInit
) {
  try {
    const response = await fetch(input, init);

    if (!response.ok) {
      const { code, cause } = await response.json();
      throw new ChatbotError(code as ErrorCode, cause);
    }

    return response;
  } catch (error: unknown) {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      throw new ChatbotError("offline:chat");
    }

    throw error;
  }
}

export function getLocalStorage(key: string) {
  if (typeof window !== "undefined") {
    return JSON.parse(localStorage.getItem(key) || "[]");
  }
  return [];
}

export function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const ASSISTANT_FAILURE_PREFIX =
  "The previous response failed before completion.";

function normalizeAssistantFailureReason(errorMessage: string) {
  const compact = errorMessage.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

export function createAssistantFailureText(errorMessage?: string | null) {
  if (!errorMessage?.trim()) {
    return `${ASSISTANT_FAILURE_PREFIX} You can retry the request.`;
  }

  return `${ASSISTANT_FAILURE_PREFIX} Reason: ${normalizeAssistantFailureReason(
    errorMessage
  )} You can retry the request.`;
}

export function isAssistantFailureText(text: string) {
  return text.startsWith(ASSISTANT_FAILURE_PREFIX);
}

export function ensureAssistantFailureVisibility<T extends UIMessage>(
  messages: T[],
  errorMessage: string
): T[] {
  const failureText = createAssistantFailureText(errorMessage);

  if (
    messages.some((message) =>
      message.role === "assistant"
        ? message.parts.some(
            (part) =>
              part.type === "text" && isAssistantFailureText(part.text ?? "")
          )
        : false
    )
  ) {
    return messages;
  }

  const lastAssistantIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "assistant")?.index;

  if (lastAssistantIndex === undefined) {
    return [
      ...messages,
      {
        id: generateUUID(),
        role: "assistant",
        parts: [{ type: "text", text: failureText }],
      } as T,
    ];
  }

  return messages.map((message, index) =>
    index === lastAssistantIndex
      ? ({
          ...message,
          parts: [...message.parts, { type: "text", text: failureText }],
        } as T)
      : message
  );
}

type ResponseMessageWithoutId = ToolModelMessage | AssistantModelMessage;
type ResponseMessage = ResponseMessageWithoutId & { id: string };

export function getMostRecentUserMessage(messages: UIMessage[]) {
  const userMessages = messages.filter((message) => message.role === "user");
  return userMessages.at(-1);
}

export function getDocumentTimestampByIndex(
  documents: ArtifactDocument[],
  index: number
) {
  if (!documents) {
    return new Date();
  }
  if (index > documents.length) {
    return new Date();
  }

  return documents[index].createdAt;
}

export function getTrailingMessageId({
  messages,
}: {
  messages: ResponseMessage[];
}): string | null {
  const trailingMessage = messages.at(-1);

  if (!trailingMessage) {
    return null;
  }

  return trailingMessage.id;
}

export function sanitizeText(text: string) {
  return text.replace("<has_function_call>", "");
}

export function convertToUIMessages(
  messages: Array<{
    id: string;
    role: string;
    parts: unknown;
    createdAt: Date;
    feedback?: "positive" | "negative" | null;
    authorUserId?: string | null;
    authorName?: string | null;
    authorEmail?: string | null;
    turnId?: string | null;
  }>
): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role as "user" | "assistant" | "system",
    parts: message.parts as UIMessagePart<CustomUIDataTypes, ChatTools>[],
    metadata: {
      createdAt: formatISO(message.createdAt),
      feedback: message.feedback ?? null,
      authorUserId: message.authorUserId ?? undefined,
      authorName: message.authorName ?? undefined,
      authorEmail: message.authorEmail ?? undefined,
      kestrelTurnId: message.turnId ?? undefined,
    },
  }));
}

export function getTextFromMessage(message: ChatMessage | UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

export function hasMeaningfulAssistantPart(
  part: UIMessagePart<CustomUIDataTypes, ChatTools>
) {
  if (part.type === "text") {
    return Boolean(part.text?.trim());
  }

  if (!(part.type.startsWith("tool-") || part.type === "dynamic-tool")) {
    return false;
  }

  if ("state" in part && typeof part.state === "string") {
    return true;
  }

  return "input" in part || "output" in part || "errorText" in part;
}

export function isPersistableAssistantMessage(message: UIMessage) {
  if (message.role !== "assistant") {
    return true;
  }

  return (
    message.parts?.some((part) =>
      hasMeaningfulAssistantPart(
        part as UIMessagePart<CustomUIDataTypes, ChatTools>
      )
    ) ?? false
  );
}

export function sanitizeMessagesForModelInput<T extends UIMessage>(
  messages: T[]
): T[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") {
      return [message];
    }

    const parts = message.parts.filter((part) => {
      if (
        part.type === "text" &&
        isAssistantFailureText((part as { text?: string }).text ?? "")
      ) {
        return false;
      }

      if (!("state" in part)) {
        return true;
      }

      const isToolPart =
        part.type === "dynamic-tool" || part.type.startsWith("tool-");

      if (!isToolPart) {
        return true;
      }

      return (
        part.state !== "input-streaming" &&
        part.state !== "input-available" &&
        part.state !== "approval-requested"
      );
    });

    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
}
