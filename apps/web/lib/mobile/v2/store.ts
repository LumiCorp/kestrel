import "server-only";

import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getThreadAccessForUser } from "@/lib/threads/store";

type MessageCursor = { createdAt: string; id: string };

function encodeCursor(cursor: MessageCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null | undefined): MessageCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    return typeof decoded.createdAt === "string" && typeof decoded.id === "string"
      ? { createdAt: decoded.createdAt, id: decoded.id }
      : null;
  } catch {
    return null;
  }
}

async function requireThread(input: {
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  const access = await getThreadAccessForUser(
    input.threadId,
    input.userId,
    input.organizationId
  );
  if (!access || access.thread.mode !== "chat") return null;
  return access;
}

function cursorFor(message: typeof schema.threadMessages.$inferSelect | undefined) {
  return message
    ? encodeCursor({ createdAt: message.createdAt.toISOString(), id: message.id })
    : null;
}

export async function getMobileV2MessageWindow(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  before?: string | null;
  around?: string | null;
  limit?: number;
}) {
  const access = await requireThread(input);
  if (!access) return null;
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);
  if (input.around) {
    const anchor = await knowledgeDb.query.threadMessages.findFirst({
      where: and(
        eq(schema.threadMessages.id, input.around),
        eq(schema.threadMessages.threadId, input.threadId)
      ),
    });
    if (!anchor) return null;
    const beforeCount = Math.floor(limit / 2);
    const afterCount = limit - beforeCount;
    const [older, newer] = await Promise.all([
      knowledgeDb
        .select()
        .from(schema.threadMessages)
        .where(
          and(
            eq(schema.threadMessages.threadId, input.threadId),
            or(
              lt(schema.threadMessages.createdAt, anchor.createdAt),
              and(
                eq(schema.threadMessages.createdAt, anchor.createdAt),
                lt(schema.threadMessages.id, anchor.id)
              )
            )
          )
        )
        .orderBy(desc(schema.threadMessages.createdAt), desc(schema.threadMessages.id))
        .limit(beforeCount),
      knowledgeDb
        .select()
        .from(schema.threadMessages)
        .where(
          and(
            eq(schema.threadMessages.threadId, input.threadId),
            or(
              gt(schema.threadMessages.createdAt, anchor.createdAt),
              and(
                eq(schema.threadMessages.createdAt, anchor.createdAt),
                gt(schema.threadMessages.id, anchor.id)
              )
            )
          )
        )
        .orderBy(asc(schema.threadMessages.createdAt), asc(schema.threadMessages.id))
        .limit(afterCount)
    ]);
    const messages = [...older.reverse(), anchor, ...newer];
    return {
      messages,
      nextCursor: older.length === beforeCount ? cursorFor(messages[0]) : null,
    };
  }

  const cursor = decodeCursor(input.before);
  if (input.before && !cursor) return null;
  const rows = await knowledgeDb
    .select()
    .from(schema.threadMessages)
    .where(
      and(
        eq(schema.threadMessages.threadId, input.threadId),
        cursor
          ? or(
              lt(schema.threadMessages.createdAt, new Date(cursor.createdAt)),
              and(
                eq(schema.threadMessages.createdAt, new Date(cursor.createdAt)),
                lt(schema.threadMessages.id, cursor.id)
              )
            )
          : undefined
      )
    )
    .orderBy(desc(schema.threadMessages.createdAt), desc(schema.threadMessages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).reverse();
  return {
    messages: page,
    nextCursor: rows.length > limit ? cursorFor(page[0]) : null,
  };
}

export async function getMobileV2OutlinePage(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  before?: string | null;
  limit?: number;
}) {
  const access = await requireThread(input);
  if (!access) return null;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  const cursor = decodeCursor(input.before);
  if (input.before && !cursor) return null;
  const rows = await knowledgeDb
    .select({
      message: schema.threadMessages,
      outputMessageId: schema.threadTurns.outputMessageId,
      status: schema.threadTurns.status,
    })
    .from(schema.threadMessages)
    .leftJoin(
      schema.threadTurns,
      eq(schema.threadTurns.inputMessageId, schema.threadMessages.id)
    )
    .where(
      and(
        eq(schema.threadMessages.threadId, input.threadId),
        eq(schema.threadMessages.role, "user"),
        cursor
          ? or(
              lt(schema.threadMessages.createdAt, new Date(cursor.createdAt)),
              and(
                eq(schema.threadMessages.createdAt, new Date(cursor.createdAt)),
                lt(schema.threadMessages.id, cursor.id)
              )
            )
          : undefined
      )
    )
    .orderBy(desc(schema.threadMessages.createdAt), desc(schema.threadMessages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    entries: page.map(({ message, outputMessageId, status }) => ({
      messageId: message.id,
      outputMessageId: outputMessageId ?? null,
      label: message.searchText.trim().slice(0, 120) || "Message",
      status: status ?? null,
      createdAt: message.createdAt.toISOString(),
    })),
    nextCursor:
      rows.length > limit ? cursorFor(page.at(-1)?.message) : null,
  };
}

export async function getMobileV2ReadState(input: {
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  const access = await requireThread(input);
  if (!access) return null;
  const state = await knowledgeDb.query.threadReadStates.findFirst({
    where: and(
      eq(schema.threadReadStates.threadId, input.threadId),
      eq(schema.threadReadStates.userId, input.userId)
    ),
  });
  const lastRead = state?.lastReadMessageId
    ? await knowledgeDb.query.threadMessages.findFirst({
        where: eq(schema.threadMessages.id, state.lastReadMessageId),
      })
    : null;
  const [unread] = await knowledgeDb
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.threadMessages)
    .where(
      and(
        eq(schema.threadMessages.threadId, input.threadId),
        eq(schema.threadMessages.role, "assistant"),
        lastRead
          ? or(
              gt(schema.threadMessages.createdAt, lastRead.createdAt),
              and(
                eq(schema.threadMessages.createdAt, lastRead.createdAt),
                gt(schema.threadMessages.id, lastRead.id)
              )
            )
          : undefined
      )
    );
  return {
    lastReadMessageId: state?.lastReadMessageId ?? null,
    unreadAnswerCount: unread?.count ?? 0,
    updatedAt: state?.updatedAt.toISOString() ?? null,
  };
}

export async function markMobileV2ThreadRead(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  messageId: string;
}) {
  const access = await requireThread(input);
  if (!access) return null;
  const target = await knowledgeDb.query.threadMessages.findFirst({
    where: and(
      eq(schema.threadMessages.id, input.messageId),
      eq(schema.threadMessages.threadId, input.threadId)
    ),
  });
  if (!target) return null;
  const existing = await knowledgeDb.query.threadReadStates.findFirst({
    where: and(
      eq(schema.threadReadStates.userId, input.userId),
      eq(schema.threadReadStates.threadId, input.threadId)
    ),
  });
  const current = existing?.lastReadMessageId
    ? await knowledgeDb.query.threadMessages.findFirst({
        where: eq(schema.threadMessages.id, existing.lastReadMessageId),
      })
    : null;
  const isNewer =
    !current ||
    target.createdAt > current.createdAt ||
    (target.createdAt.getTime() === current.createdAt.getTime() && target.id > current.id);
  if (isNewer) {
    await knowledgeDb
      .insert(schema.threadReadStates)
      .values({
        userId: input.userId,
        organizationId: input.organizationId,
        threadId: input.threadId,
        lastReadMessageId: target.id,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.threadReadStates.userId, schema.threadReadStates.threadId],
        set: { lastReadMessageId: target.id, updatedAt: new Date() },
      });
  }
  return getMobileV2ReadState(input);
}
