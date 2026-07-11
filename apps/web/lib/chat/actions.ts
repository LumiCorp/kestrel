"use server";

import { generateText, type UIMessage } from "ai";
import {
  deleteKnowledgeMessagesByChatIdAfterTimestamp,
  getKnowledgeMessageByIdForUser,
} from "@/lib/agent/store";
import { titlePrompt } from "@/lib/ai/prompts";
import { resolveRequiredLanguageModel } from "@/lib/ai/providers";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getTextFromMessage } from "@/lib/utils";

export async function generateTitleFromUserMessage({
  message,
  modelId,
}: {
  message: UIMessage;
  modelId?: string | null;
}) {
  const resolvedTitleModel = await resolveRequiredLanguageModel({
    modelId,
    surface: "title",
  });
  const { text } = await generateText({
    model: resolvedTitleModel.model,
    system: titlePrompt,
    prompt: getTextFromMessage(message),
  });

  return text
    .replace(/^[#*"\s]+/, "")
    .replace(/["]+$/, "")
    .trim();
}

export async function deleteTrailingMessages({ id }: { id: string }) {
  const { session, organizationId } = await requireActiveOrganization();
  const message = await getKnowledgeMessageByIdForUser(
    id,
    session.user.id,
    organizationId
  );

  if (!message) {
    return;
  }

  await deleteKnowledgeMessagesByChatIdAfterTimestamp({
    chatId: message.chatId,
    timestamp: message.createdAt,
    userId: session.user.id,
    organizationId,
  });
}
