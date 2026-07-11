import type { RunnerActorMetadata } from "@kestrel-agents/sdk";
import { generateKestrelOneExternalReply } from "@/lib/agent/kestrel-runtime";
import {
  createChatForUser,
  getChatByExternalThreadId,
  getKnowledgeMessageByExternalMessageId,
  saveKnowledgeMessages,
} from "@/lib/agent/store";
import type { BotThreadContext } from "@/lib/bots/context";
import { knowledgeDb } from "@/lib/knowledge/db";
import { getActiveKnowledgeSnapshot } from "@/lib/knowledge/snapshot-store";

export const NO_SNAPSHOT_MESSAGE =
  "No active knowledge snapshot is available for this organization yet. Run a sync and activate a snapshot from the admin workspace before using bot integrations.";

function buildContextualPrompt(prompt: string, context?: BotThreadContext) {
  if (!context) {
    return prompt;
  }

  const parts: string[] = [
    `Platform: ${context.platform}`,
    `Source: ${context.source}`,
    `Thread: ${context.title}`,
  ];

  if (context.number) {
    parts.push(`Number: ${context.number}`);
  }

  if (context.state) {
    parts.push(`State: ${context.state}`);
  }

  if (context.labels.length) {
    parts.push(`Labels: ${context.labels.join(", ")}`);
  }

  if (context.body) {
    parts.push(`Body:\n${context.body.slice(0, 3000)}`);
  }

  if (context.previousComments?.length) {
    parts.push(
      [
        "Recent discussion:",
        ...context.previousComments.slice(-8).map((comment) => {
          const author = comment.isBot
            ? `${comment.author} [bot]`
            : comment.author;
          return `${author}: ${comment.body}`;
        }),
      ].join("\n"),
    );
  }

  parts.push(`User message:\n${prompt}`);
  return parts.join("\n\n");
}

export async function getBotActorUserId(organizationId: string) {
  const preferredAdmin = await knowledgeDb.query.members.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.organizationId, organizationId), eq(table.role, "admin")),
    columns: {
      userId: true,
    },
  });

  if (preferredAdmin?.userId) {
    return preferredAdmin.userId;
  }

  const member = await knowledgeDb.query.members.findFirst({
    where: (table, { eq }) => eq(table.organizationId, organizationId),
    columns: {
      userId: true,
    },
  });

  if (!member?.userId) {
    throw new Error("No organization member is available for bot-owned chats");
  }

  return member.userId;
}

export async function getOrCreateExternalThreadChat(input: {
  organizationId: string;
  origin: "github" | "discord";
  externalThreadId: string;
  title: string;
  legacyExternalThreadIds?: string[];
}) {
  for (const externalThreadId of [
    input.externalThreadId,
    ...(input.legacyExternalThreadIds ?? []),
  ]) {
    const existingChat = await getChatByExternalThreadId(
      input.organizationId,
      input.origin,
      externalThreadId,
    );

    if (existingChat) {
      return existingChat;
    }
  }

  return createChatForUser({
    id: crypto.randomUUID(),
    userId: await getBotActorUserId(input.organizationId),
    organizationId: input.organizationId,
    origin: input.origin,
    externalThreadId: input.externalThreadId,
    title: input.title,
    mode: "chat",
  });
}

export async function hasProcessedExternalMessage(
  chatId: string,
  externalMessageId: string,
) {
  const existing = await getKnowledgeMessageByExternalMessageId(
    chatId,
    externalMessageId,
  );
  return Boolean(existing);
}

export async function generateExternalReply(input: {
  organizationId: string;
  apiUrl: string;
  chatId: string;
  prompt: string;
  context?: BotThreadContext;
  actor: RunnerActorMetadata;
}) {
  const snapshot = await getActiveKnowledgeSnapshot(input.organizationId);
  if (!snapshot) {
    return {
      userMessage: {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [{ type: "text" as const, text: input.prompt }],
      },
      text: NO_SNAPSHOT_MESSAGE,
      usage: undefined,
      usedSnapshot: false,
    };
  }

  const generated = await generateKestrelOneExternalReply({
    organizationId: input.organizationId,
    apiUrl: input.apiUrl,
    sessionId: input.chatId,
    prompt: buildContextualPrompt(input.prompt, input.context),
    actor: input.actor,
  });
  return {
    ...generated,
    usedSnapshot: true,
  };
}

export async function saveExternalConversationTurn(input: {
  chatId: string;
  origin: "github" | "discord";
  inboundText: string;
  inboundExternalMessageId: string;
  replyText: string;
  replyExternalMessageId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}) {
  await saveKnowledgeMessages([
    {
      id: crypto.randomUUID(),
      chatId: input.chatId,
      role: "user",
      parts: [{ type: "text", text: input.inboundText }],
      externalMessageId: input.inboundExternalMessageId,
      source: input.origin,
    },
    {
      id: crypto.randomUUID(),
      chatId: input.chatId,
      role: "assistant",
      parts: [{ type: "text", text: input.replyText }],
      externalMessageId: input.replyExternalMessageId ?? null,
      source: input.origin,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
    },
  ]);
}
