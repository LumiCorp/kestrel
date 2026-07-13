"use server";

import { generateText, type UIMessage } from "ai";
import { titlePrompt } from "@/lib/ai/prompts";
import { resolveRequiredLanguageModel } from "@/lib/ai/providers";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  deleteThreadMessagesAfterTimestamp,
  getThreadMessageByIdForUser,
} from "@/lib/threads/store";
import { getTextFromMessage } from "@/lib/utils";

export async function generateTitleFromUserMessage({
  message,
  modelId,
}: {
  message: UIMessage;
  modelId?: string | null;
}) {
  const { organizationId } = await requireActiveOrganization();
  const resolvedTitleModel = await resolveRequiredLanguageModel({
    modelId,
    surface: "title",
    organizationId,
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
  const message = await getThreadMessageByIdForUser(
    id,
    session.user.id,
    organizationId
  );

  if (!message) {
    return;
  }

  await deleteThreadMessagesAfterTimestamp({
    threadId: message.threadId,
    timestamp: message.createdAt,
    userId: session.user.id,
    organizationId,
  });
}
