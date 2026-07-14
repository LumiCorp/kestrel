"use server";

import type { UIMessage } from "ai";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  deleteThreadMessagesAfterTimestamp,
  getThreadMessageByIdForUser,
} from "@/lib/threads/store";
import { generateTitleForOrganization } from "./title";

export async function generateTitleFromUserMessage({
  message,
  modelId,
}: {
  message: UIMessage;
  modelId?: string | null;
}) {
  const { organizationId } = await requireActiveOrganization();
  return generateTitleForOrganization({ message, modelId, organizationId });
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
