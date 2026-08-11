import type { ChatMessage } from "@/lib/types";

type ChatMessagePart = ChatMessage["parts"][number];

export function hasEditedMessageContent(
  parts: ChatMessagePart[],
  draftContent: string
) {
  return (
    draftContent.trim().length > 0 ||
    parts.some((part) => part.type !== "text")
  );
}

export function buildEditedMessageParts(
  parts: ChatMessagePart[],
  draftContent: string
): ChatMessagePart[] {
  const firstTextIndex = parts.findIndex((part) => part.type === "text");

  if (firstTextIndex === -1) {
    return [...parts, { type: "text", text: draftContent }];
  }

  const editedParts: ChatMessagePart[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.type !== "text") {
      editedParts.push(part);
    } else if (index === firstTextIndex) {
      editedParts.push({ ...part, text: draftContent });
    }
  }
  return editedParts;
}
