import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { DbThread, DbThreadMessage } from "@/lib/knowledge/db-types";
import {
  getProjectAccess,
  type ProjectRole,
  projectRoleAllows,
  requireProjectRole,
} from "@/lib/projects/access";

export type ThreadAccess = {
  thread: DbThread;
  projectRole: ProjectRole | null;
  canManage: boolean;
  canPublish: boolean;
};

export async function listThreadsForUser(
  userId: string,
  organizationId: string,
  options?: {
    limit?: number;
    endingBefore?: string | null;
    projectId?: string | null;
    includeArchived?: boolean;
  }
): Promise<DbThread[]> {
  const limit = options?.limit ?? 50;
  const anchor = options?.endingBefore
    ? await getThreadForUser(options.endingBefore, userId, organizationId, true)
    : null;
  if (options?.projectId) {
    await requireProjectRole({
      projectId: options.projectId,
      organizationId,
      userId,
      includeArchived: options.includeArchived,
    });
  }

  const accessibleProjectIds = knowledgeDb
    .select({ projectId: schema.projectMembers.projectId })
    .from(schema.projectMembers)
    .innerJoin(
      schema.projects,
      eq(schema.projects.id, schema.projectMembers.projectId)
    )
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.id, schema.projectMembers.organizationMemberId),
        eq(schema.members.organizationId, organizationId),
        eq(schema.members.userId, userId)
      )
    )
    .where(
      options?.includeArchived ? undefined : isNull(schema.projects.archivedAt)
    );
  const scopeFilter =
    options?.projectId === null
      ? and(
          isNull(schema.threads.projectId),
          eq(schema.threads.createdByUserId, userId)
        )
      : options?.projectId
        ? eq(schema.threads.projectId, options.projectId)
        : or(
            and(
              isNull(schema.threads.projectId),
              eq(schema.threads.createdByUserId, userId)
            ),
            inArray(schema.threads.projectId, accessibleProjectIds)
          );
  const cursorFilter = anchor
    ? or(
        lt(schema.threads.updatedAt, anchor.updatedAt),
        and(
          eq(schema.threads.updatedAt, anchor.updatedAt),
          lt(schema.threads.id, anchor.id)
        )
      )
    : undefined;

  return knowledgeDb
    .select()
    .from(schema.threads)
    .where(
      and(
        eq(schema.threads.organizationId, organizationId),
        options?.includeArchived
          ? undefined
          : isNull(schema.threads.archivedAt),
        scopeFilter,
        cursorFilter
      )
    )
    .orderBy(desc(schema.threads.updatedAt), desc(schema.threads.id))
    .limit(limit);
}

export async function getThreadAccessForUser(
  id: string,
  userId: string,
  organizationId: string,
  includeArchived = false
): Promise<ThreadAccess | null> {
  const thread = await knowledgeDb.query.threads.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.id, id), eq(table.organizationId, organizationId)),
  });
  if (!thread || (!includeArchived && thread.archivedAt)) {
    return null;
  }
  if (!thread.projectId) {
    return thread.createdByUserId === userId
      ? {
          thread,
          projectRole: null,
          canManage: true,
          canPublish: true,
        }
      : null;
  }

  const projectAccess = await getProjectAccess({
    projectId: thread.projectId,
    organizationId,
    userId,
    includeArchived,
  });
  if (!projectAccess) {
    return null;
  }
  return {
    thread,
    projectRole: projectAccess.role,
    canManage:
      thread.createdByUserId === userId ||
      projectRoleAllows(projectAccess.role, "editor"),
    canPublish: projectRoleAllows(projectAccess.role, "editor"),
  };
}

export async function getThreadForUser(
  id: string,
  userId: string,
  organizationId: string,
  includeArchived = false
) {
  return (
    await getThreadAccessForUser(id, userId, organizationId, includeArchived)
  )?.thread;
}

export async function getThreadByExternalThreadId(
  organizationId: string,
  origin: "github" | "discord",
  externalThreadId: string
) {
  return knowledgeDb.query.threads.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, organizationId),
        eq(table.origin, origin),
        eq(table.externalThreadId, externalThreadId)
      ),
  });
}

export async function getThreadMessageByExternalMessageId(
  threadId: string,
  externalMessageId: string
) {
  return knowledgeDb.query.threadMessages.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.threadId, threadId),
        eq(table.externalMessageId, externalMessageId)
      ),
  });
}

export async function getThreadWithMessagesForUser(
  id: string,
  userId: string,
  organizationId: string,
  includeArchived = false
) {
  const access = await getThreadAccessForUser(
    id,
    userId,
    organizationId,
    includeArchived
  );
  if (!access) {
    return null;
  }
  const messages = await knowledgeDb.query.threadMessages.findMany({
    where: (table, { eq }) => eq(table.threadId, id),
    orderBy: (table) => [asc(table.createdAt), asc(table.id)],
  });
  const authorIds = [
    ...new Set(
      messages
        .map((message) => message.authorUserId)
        .filter((authorId): authorId is string => Boolean(authorId))
    ),
  ];
  const authors =
    authorIds.length > 0
      ? await knowledgeDb
          .select({
            id: schema.users.id,
            name: schema.users.name,
            email: schema.users.email,
          })
          .from(schema.users)
          .where(inArray(schema.users.id, authorIds))
      : [];
  const authorsById = new Map(authors.map((author) => [author.id, author]));
  return {
    ...access.thread,
    messages: messages.map((message) => ({
      ...message,
      authorName: message.authorUserId
        ? (authorsById.get(message.authorUserId)?.name ?? null)
        : null,
      authorEmail: message.authorUserId
        ? (authorsById.get(message.authorUserId)?.email ?? null)
        : null,
    })),
    access,
  };
}

export async function getPublicThreadByShareToken(token: string) {
  const thread = await knowledgeDb.query.threads.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.shareToken, token),
        eq(table.isPublic, true),
        isNull(table.archivedAt)
      ),
  });
  if (!thread) {
    return null;
  }
  const messages = await knowledgeDb.query.threadMessages.findMany({
    where: (table, { eq }) => eq(table.threadId, thread.id),
    orderBy: (table) => [asc(table.createdAt), asc(table.id)],
    columns: {
      id: true,
      threadId: true,
      role: true,
      parts: true,
      feedback: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      durationMs: true,
      externalMessageId: true,
      source: true,
      createdAt: true,
      searchText: true,
      projectContextRevisionId: true,
      authorUserId: false,
    },
  });
  return { ...thread, messages };
}

export async function createThreadForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
  projectId?: string | null;
  mode?: "chat" | "admin";
  origin?: "web" | "mobile" | "github" | "discord" | "api";
  externalThreadId?: string | null;
  title?: string | null;
}) {
  const mode = input.mode ?? "chat";
  const origin = input.origin ?? "web";
  const projectId =
    mode === "admin" || !["web", "mobile"].includes(origin)
      ? null
      : input.projectId;
  if (projectId) {
    await requireProjectRole({
      projectId,
      organizationId: input.organizationId,
      userId: input.userId,
    });
  }
  const now = new Date();
  const [thread] = await knowledgeDb
    .insert(schema.threads)
    .values({
      id: input.id,
      createdByUserId: input.userId,
      organizationId: input.organizationId,
      projectId: projectId ?? null,
      mode,
      origin,
      externalThreadId: input.externalThreadId ?? null,
      activeStreamId: null,
      title: input.title ?? "",
      isPublic: false,
      shareToken: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (thread?.projectId) {
    await recordProjectAuditEvent({
      projectId: thread.projectId,
      actorUserId: input.userId,
      action: "thread.created",
      targetId: thread.id,
    });
  }
  return thread;
}

export async function updateThreadTitleForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
  title: string;
}) {
  const access = await getThreadAccessForUser(
    input.id,
    input.userId,
    input.organizationId
  );
  if (!access?.canManage) {
    return null;
  }
  const [thread] = await knowledgeDb
    .update(schema.threads)
    .set({ title: input.title, updatedAt: new Date() })
    .where(eq(schema.threads.id, input.id))
    .returning();
  return thread ?? null;
}

export async function saveThreadMessages(
  messages: Array<Partial<DbThreadMessage>>
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
  const result = await knowledgeDb
    .insert(schema.threadMessages)
    .values(
      dedupedMessages.map((message) => ({
        id: message.id ?? crypto.randomUUID(),
        threadId: message.threadId!,
        turnId: message.turnId ?? null,
        role: message.role as "user" | "assistant" | "system",
        authorUserId: message.authorUserId ?? null,
        projectContextRevisionId: message.projectContextRevisionId ?? null,
        parts: message.parts ?? [],
        searchText: message.searchText || extractSearchText(message.parts),
        feedback: message.feedback ?? null,
        model: message.model ?? null,
        inputTokens: message.inputTokens ?? null,
        outputTokens: message.outputTokens ?? null,
        durationMs: message.durationMs ?? null,
        externalMessageId: message.externalMessageId ?? null,
        source:
          (message.source as
            | "web"
            | "mobile"
            | "api"
            | "github"
            | "discord") ?? "web",
        createdAt: message.createdAt ?? new Date(),
      }))
    )
    .onConflictDoUpdate({
      target: schema.threadMessages.id,
      set: {
        parts: sql`excluded.parts`,
        searchText: sql`excluded.search_text`,
        feedback: sql`excluded.feedback`,
        model: sql`excluded.model`,
        inputTokens: sql`excluded.input_tokens`,
        outputTokens: sql`excluded.output_tokens`,
        durationMs: sql`excluded.duration_ms`,
        externalMessageId: sql`excluded.external_message_id`,
        source: sql`excluded.source`,
        projectContextRevisionId: sql`excluded.project_context_revision_id`,
        turnId: sql`excluded.turn_id`,
      },
    })
    .returning();
  const threadIds = [...new Set(result.map((message) => message.threadId))];
  if (threadIds.length > 0) {
    await knowledgeDb
      .update(schema.threads)
      .set({ updatedAt: new Date() })
      .where(inArray(schema.threads.id, threadIds));
  }
  return result;
}

export async function getThreadActiveStreamIdForUser(
  id: string,
  userId: string,
  organizationId: string
) {
  return (
    (await getThreadForUser(id, userId, organizationId))?.activeStreamId ?? null
  );
}

export async function setThreadActiveStreamIdForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
  activeStreamId: string | null;
}) {
  const access = await getThreadAccessForUser(
    input.id,
    input.userId,
    input.organizationId
  );
  if (!access) {
    return null;
  }
  const [thread] = await knowledgeDb
    .update(schema.threads)
    .set({ activeStreamId: input.activeStreamId, updatedAt: new Date() })
    .where(eq(schema.threads.id, input.id))
    .returning();
  return thread ?? null;
}

export async function clearThreadActiveStreamIdForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
}) {
  return setThreadActiveStreamIdForUser({ ...input, activeStreamId: null });
}

export async function updateThreadMessageFeedback(
  id: string,
  threadId: string,
  feedback: "positive" | "negative" | null
) {
  const [message] = await knowledgeDb
    .update(schema.threadMessages)
    .set({ feedback })
    .where(
      and(
        eq(schema.threadMessages.id, id),
        eq(schema.threadMessages.threadId, threadId)
      )
    )
    .returning();
  return message ?? null;
}

export async function updateThreadSharingForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
  isPublic: boolean;
}) {
  const access = await getThreadAccessForUser(
    input.id,
    input.userId,
    input.organizationId
  );
  if (!access?.canPublish) {
    return null;
  }
  const [thread] = await knowledgeDb
    .update(schema.threads)
    .set({
      isPublic: input.isPublic,
      shareToken: input.isPublic ? crypto.randomUUID() : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.threads.id, input.id))
    .returning();
  if (thread?.projectId) {
    await recordProjectAuditEvent({
      projectId: thread.projectId,
      actorUserId: input.userId,
      action: input.isPublic ? "thread.published" : "thread.unpublished",
      targetId: thread.id,
    });
  }
  return thread ?? null;
}

export async function getThreadMessageByIdForUser(
  id: string,
  userId: string,
  organizationId: string
) {
  const message = await knowledgeDb.query.threadMessages.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });
  if (!message) {
    return null;
  }
  return (await getThreadForUser(message.threadId, userId, organizationId))
    ? message
    : null;
}

export async function deleteThreadMessagesAfterTimestamp(input: {
  threadId: string;
  timestamp: Date;
  userId: string;
  organizationId: string;
}) {
  if (
    !(await getThreadForUser(
      input.threadId,
      input.userId,
      input.organizationId
    ))
  ) {
    return;
  }
  await knowledgeDb
    .delete(schema.threadMessages)
    .where(
      and(
        eq(schema.threadMessages.threadId, input.threadId),
        gte(schema.threadMessages.createdAt, input.timestamp)
      )
    );
}

export async function archiveThreadForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
  archived: boolean;
}) {
  const access = await getThreadAccessForUser(
    input.id,
    input.userId,
    input.organizationId,
    true
  );
  if (!access?.canManage) {
    return null;
  }
  const [thread] = await knowledgeDb
    .update(schema.threads)
    .set({
      archivedAt: input.archived ? new Date() : null,
      updatedAt: new Date(),
      ...(input.archived ? { activeStreamId: null } : {}),
    })
    .where(eq(schema.threads.id, input.id))
    .returning();
  return thread ?? null;
}

export async function permanentlyDeleteThreadForUser(input: {
  id: string;
  userId: string;
  organizationId: string;
}) {
  const access = await getThreadAccessForUser(
    input.id,
    input.userId,
    input.organizationId,
    true
  );
  if (!(access?.canManage && access.thread.archivedAt)) {
    return null;
  }
  const [thread] = await knowledgeDb
    .delete(schema.threads)
    .where(eq(schema.threads.id, input.id))
    .returning();
  return thread ?? null;
}

export async function assignStandaloneThreadToProject(input: {
  id: string;
  projectId: string;
  userId: string;
  organizationId: string;
  disclosureAccepted: boolean;
}) {
  if (!input.disclosureAccepted) {
    throw new Error("Shared visibility disclosure must be accepted.");
  }
  const access = await getThreadAccessForUser(
    input.id,
    input.userId,
    input.organizationId
  );
  if (
    !access ||
    access.thread.projectId ||
    access.thread.createdByUserId !== input.userId ||
    access.thread.mode === "admin" ||
    access.thread.origin !== "web"
  ) {
    return null;
  }
  await requireProjectRole({
    projectId: input.projectId,
    organizationId: input.organizationId,
    userId: input.userId,
  });
  const [thread] = await knowledgeDb
    .update(schema.threads)
    .set({
      projectId: input.projectId,
      isPublic: false,
      shareToken: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.threads.id, input.id))
    .returning();
  if (thread) {
    await recordProjectAuditEvent({
      projectId: input.projectId,
      actorUserId: input.userId,
      action: "thread.assigned",
      targetId: input.id,
    });
  }
  return thread ?? null;
}

function extractSearchText(parts: unknown) {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .flatMap((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }
      return [];
    })
    .join("\n")
    .trim();
}

async function recordProjectAuditEvent(input: {
  projectId: string;
  actorUserId: string;
  action: string;
  targetId: string;
}) {
  await knowledgeDb.insert(schema.projectAuditEvents).values({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: "thread",
    targetId: input.targetId,
    createdAt: new Date(),
  });
}
