import { desc, eq } from "drizzle-orm";
import { logAdminEvent } from "@/lib/admin/logs";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export async function listAdminUsers() {
  const [users, chats, messages] = await Promise.all([
    knowledgeDb
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        image: schema.users.image,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt)),
    knowledgeDb
      .select({
        id: schema.threads.id,
        userId: schema.threads.createdByUserId,
        createdAt: schema.threads.createdAt,
      })
      .from(schema.threads),
    knowledgeDb
      .select({
        threadId: schema.threadMessages.threadId,
        createdAt: schema.threadMessages.createdAt,
      })
      .from(schema.threadMessages),
  ]);

  const chatOwnerById = new Map<string, string>();
  const chatCountByUserId = new Map<string, number>();
  const lastSeenByUserId = new Map<string, Date>();

  for (const chat of chats) {
    if (chat.userId === null) {
      continue;
    }
    chatOwnerById.set(chat.id, chat.userId);
    chatCountByUserId.set(
      chat.userId,
      (chatCountByUserId.get(chat.userId) ?? 0) + 1
    );

    const previousLastSeen = lastSeenByUserId.get(chat.userId);
    if (!previousLastSeen || previousLastSeen < chat.createdAt) {
      lastSeenByUserId.set(chat.userId, chat.createdAt);
    }
  }

  const messageCountByUserId = new Map<string, number>();

  for (const message of messages) {
    const userId = chatOwnerById.get(message.threadId);
    if (!userId) {
      continue;
    }

    messageCountByUserId.set(
      userId,
      (messageCountByUserId.get(userId) ?? 0) + 1
    );

    const previousLastSeen = lastSeenByUserId.get(userId);
    if (!previousLastSeen || previousLastSeen < message.createdAt) {
      lastSeenByUserId.set(userId, message.createdAt);
    }
  }

  return users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    role: user.role ?? "user",
    createdAt: user.createdAt,
    chatCount: chatCountByUserId.get(user.id) ?? 0,
    messageCount: messageCountByUserId.get(user.id) ?? 0,
    lastSeenAt: lastSeenByUserId.get(user.id) ?? null,
  }));
}

export async function updateAdminUserRole(input: {
  actorUserId: string;
  organizationId?: string | null;
  role: "admin" | "user";
  userId: string;
}) {
  if (input.actorUserId === input.userId && input.role !== "admin") {
    throw new Error("You cannot demote your own admin account.");
  }

  const [updated] = await knowledgeDb
    .update(schema.users)
    .set({
      role: input.role,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, input.userId))
    .returning({
      id: schema.users.id,
      role: schema.users.role,
    });

  if (!updated) {
    throw new Error("User not found");
  }

  await logAdminEvent({
    organizationId: input.organizationId ?? null,
    actorUserId: input.actorUserId,
    category: "users",
    action: "update-role",
    targetType: "user",
    targetId: input.userId,
    message: `Updated user role to ${input.role}.`,
    metadata: { role: input.role },
  });

  return updated;
}

export async function deleteAdminUser(input: {
  actorUserId: string;
  organizationId?: string | null;
  userId: string;
}) {
  if (input.actorUserId === input.userId) {
    throw new Error("You cannot delete your own account.");
  }

  const [deleted] = await knowledgeDb
    .delete(schema.users)
    .where(eq(schema.users.id, input.userId))
    .returning({
      id: schema.users.id,
      email: schema.users.email,
    });

  if (!deleted) {
    throw new Error("User not found");
  }

  await logAdminEvent({
    organizationId: input.organizationId ?? null,
    actorUserId: input.actorUserId,
    level: "warn",
    category: "users",
    action: "delete",
    targetType: "user",
    targetId: input.userId,
    message: `Deleted user ${deleted.email}.`,
    metadata: { email: deleted.email },
  });

  return deleted;
}
