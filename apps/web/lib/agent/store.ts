import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { DbChat, DbMessage } from "@/lib/knowledge/db-types";

export async function listChatsForUser(
  userId: string,
  organizationId: string,
  options?: {
    limit?: number;
    endingBefore?: string | null;
  }
): Promise<DbChat[]> {
  const limit = options?.limit ?? 50;
  const anchor = options?.endingBefore
    ? await getChatForUser(options.endingBefore, userId, organizationId)
    : null;

  return knowledgeDb.query.knowledgeChats.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.userId, userId),
        eq(table.organizationId, organizationId),
        anchor ? lt(table.createdAt, anchor.createdAt) : undefined
      ),
    orderBy: (table) => [desc(table.createdAt)],
    limit,
  });
}

export async function getChatForUser(
  id: string,
  userId: string,
  organizationId: string
) {
  return knowledgeDb.query.knowledgeChats.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, id),
        eq(table.userId, userId),
        eq(table.organizationId, organizationId)
      ),
  });
}

export async function getChatByExternalThreadId(
  organizationId: string,
  origin: "github" | "discord",
  externalThreadId: string
) {
  return knowledgeDb.query.knowledgeChats.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, organizationId),
        eq(table.origin, origin),
        eq(table.externalThreadId, externalThreadId)
      ),
  });
}

export async function getKnowledgeMessageByExternalMessageId(
  chatId: string,
  externalMessageId: string
) {
  return knowledgeDb.query.knowledgeMessages.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.chatId, chatId),
        eq(table.externalMessageId, externalMessageId)
      ),
  });
}

export async function getChatWithMessagesForUser(
  id: string,
  userId: string,
  organizationId: string
) {
  const chat = await getChatForUser(id, userId, organizationId);
  if (!chat) {
    return null;
  }

  const messages = await knowledgeDb.query.knowledgeMessages.findMany({
    where: (table, { eq }) => eq(table.chatId, id),
    orderBy: (table) => [asc(table.createdAt)],
  });

  return {
    ...chat,
    messages,
  };
}

export async function getPublicChatByShareToken(token: string) {
  const chat = await knowledgeDb.query.knowledgeChats.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.shareToken, token), eq(table.isPublic, true)),
  });

  if (!chat) {
    return null;
  }

  const [messages, author] = await Promise.all([
    knowledgeDb.query.knowledgeMessages.findMany({
      where: (table, { eq }) => eq(table.chatId, chat.id),
      orderBy: (table) => [asc(table.createdAt)],
    }),
    knowledgeDb.query.users.findFirst({
      where: (table, { eq }) => eq(table.id, chat.userId),
      columns: {
        name: true,
        image: true,
      },
    }),
  ]);

  return {
    ...chat,
    messages,
    author: {
      name: author?.name ?? "Unknown",
      image: author?.image ?? null,
    },
  };
}

export async function createChatForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
  mode?: "chat" | "admin";
  origin?: "web" | "github" | "discord" | "api";
  externalThreadId?: string | null;
  title?: string | null;
}) {
  const [chat] = await knowledgeDb
    .insert(schema.knowledgeChats)
    .values({
      id: input.id,
      userId: input.userId,
      organizationId: input.organizationId,
      mode: input.mode ?? "chat",
      origin: input.origin ?? "web",
      externalThreadId: input.externalThreadId ?? null,
      activeStreamId: null,
      title: input.title ?? "",
      isPublic: false,
      shareToken: null,
      createdAt: new Date(),
    })
    .returning();

  return chat;
}

export async function updateChatTitleForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
  title: string;
}) {
  const [chat] = await knowledgeDb
    .update(schema.knowledgeChats)
    .set({ title: input.title })
    .where(
      and(
        eq(schema.knowledgeChats.id, input.id),
        eq(schema.knowledgeChats.userId, input.userId),
        eq(schema.knowledgeChats.organizationId, input.organizationId)
      )
    )
    .returning();

  return chat;
}

export async function saveKnowledgeMessages(
  messages: Array<Partial<DbMessage>>
) {
  if (messages.length === 0) {
    return [];
  }

  const dedupedMessages = Array.from(
    new Map(
      messages.map((message, index) => [
        message.id ?? `__generated__${index}`,
        message,
      ])
    ).values()
  );

  return knowledgeDb
    .insert(schema.knowledgeMessages)
    .values(
      dedupedMessages.map((message) => ({
        id: message.id ?? crypto.randomUUID(),
        chatId: message.chatId!,
        role: message.role as "user" | "assistant" | "system",
        parts: message.parts ?? [],
        feedback: message.feedback ?? null,
        model: message.model ?? null,
        inputTokens: message.inputTokens ?? null,
        outputTokens: message.outputTokens ?? null,
        durationMs: message.durationMs ?? null,
        externalMessageId: message.externalMessageId ?? null,
        source:
          (message.source as "web" | "api" | "github" | "discord") ?? "web",
        createdAt: message.createdAt ?? new Date(),
      }))
    )
    .onConflictDoUpdate({
      target: schema.knowledgeMessages.id,
      set: {
        parts: sql`excluded.parts`,
        feedback: sql`excluded.feedback`,
        model: sql`excluded.model`,
        inputTokens: sql`excluded.input_tokens`,
        outputTokens: sql`excluded.output_tokens`,
        durationMs: sql`excluded.duration_ms`,
        externalMessageId: sql`excluded.external_message_id`,
        source: sql`excluded.source`,
      },
    })
    .returning();
}

export async function getChatActiveStreamIdForUser(
  id: string,
  userId: string,
  organizationId: string
) {
  const chat = await getChatForUser(id, userId, organizationId);
  return chat?.activeStreamId ?? null;
}

export async function setChatActiveStreamIdForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
  activeStreamId: string | null;
}) {
  const [chat] = await knowledgeDb
    .update(schema.knowledgeChats)
    .set({ activeStreamId: input.activeStreamId })
    .where(
      and(
        eq(schema.knowledgeChats.id, input.id),
        eq(schema.knowledgeChats.userId, input.userId),
        eq(schema.knowledgeChats.organizationId, input.organizationId)
      )
    )
    .returning();

  return chat ?? null;
}

export async function clearChatActiveStreamIdForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
}) {
  return setChatActiveStreamIdForUser({
    ...input,
    activeStreamId: null,
  });
}

export async function updateKnowledgeMessageFeedback(
  id: string,
  chatId: string,
  feedback: "positive" | "negative" | null
) {
  const [message] = await knowledgeDb
    .update(schema.knowledgeMessages)
    .set({ feedback })
    .where(
      and(
        eq(schema.knowledgeMessages.id, id),
        eq(schema.knowledgeMessages.chatId, chatId)
      )
    )
    .returning();

  return message;
}

export async function updateChatSharingForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
  isPublic: boolean;
}) {
  const [chat] = await knowledgeDb
    .update(schema.knowledgeChats)
    .set({
      isPublic: input.isPublic,
      shareToken: input.isPublic ? crypto.randomUUID() : null,
    })
    .where(
      and(
        eq(schema.knowledgeChats.id, input.id),
        eq(schema.knowledgeChats.userId, input.userId),
        eq(schema.knowledgeChats.organizationId, input.organizationId)
      )
    )
    .returning();

  return chat;
}

export async function getKnowledgeMessageByIdForUser(
  id: string,
  userId: string,
  organizationId: string
) {
  const message = await knowledgeDb.query.knowledgeMessages.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });

  if (!message) {
    return null;
  }

  const chat = await getChatForUser(message.chatId, userId, organizationId);
  if (!chat) {
    return null;
  }

  return message;
}

export async function deleteKnowledgeMessagesByChatIdAfterTimestamp(input: {
  chatId: string;
  timestamp: Date;
  userId: string;
  organizationId: string;
}) {
  const chat = await getChatForUser(
    input.chatId,
    input.userId,
    input.organizationId
  );

  if (!chat) {
    return;
  }

  await knowledgeDb
    .delete(schema.knowledgeMessages)
    .where(
      and(
        eq(schema.knowledgeMessages.chatId, input.chatId),
        gte(schema.knowledgeMessages.createdAt, input.timestamp)
      )
    );
}

export async function deleteChatForUser(
  id: string,
  userId: string,
  organizationId: string
) {
  const [chat] = await knowledgeDb
    .delete(schema.knowledgeChats)
    .where(
      and(
        eq(schema.knowledgeChats.id, id),
        eq(schema.knowledgeChats.userId, userId),
        eq(schema.knowledgeChats.organizationId, organizationId)
      )
    )
    .returning();

  return chat;
}

export async function deleteAllChatsForUser(
  userId: string,
  organizationId: string
) {
  return knowledgeDb
    .delete(schema.knowledgeChats)
    .where(
      and(
        eq(schema.knowledgeChats.userId, userId),
        eq(schema.knowledgeChats.organizationId, organizationId)
      )
    )
    .returning();
}
