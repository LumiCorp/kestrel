import "server-only";

import type { RunnerEvent, RunnerEventEnvelope } from "@kestrel-agents/sdk";
import { eq, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export type RuntimeDialogMessage = NonNullable<
  RunnerEventEnvelope<"task.updated">["payload"]["dialogMessage"]
>;

export function readRuntimeDialogMessage(
  event: RunnerEvent,
): RuntimeDialogMessage | null {
  if (event.type !== "task.updated") return null;
  return event.payload.dialogMessage ?? null;
}

export async function persistRuntimeDialogMessage(input: {
  threadId: string;
  message: RuntimeDialogMessage;
}): Promise<void> {
  const createdAt = new Date(input.message.createdAt);
  const safeCreatedAt = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;
  const closed = input.message.dialogStatus === "closed";
  const part = {
    type: "data-kestrel-dialog-message",
    id: input.message.messageId,
    data: { version: "v1", ...input.message },
  };
  await knowledgeDb.transaction(async (tx) => {
    await tx.insert(schema.threadDialogs).values({
      id: input.message.dialogId,
      threadId: input.threadId,
      runtimeChildThreadId: input.message.childSessionId,
      name: input.message.name,
      status: closed ? "closed" : "open",
      createdAt: safeCreatedAt,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: schema.threadDialogs.id,
      set: {
        name: input.message.name,
        status: closed ? "closed" : "open",
        updatedAt: new Date(),
      },
    });
    await tx.insert(schema.threadMessages).values({
      id: input.message.messageId,
      threadId: input.threadId,
      turnId: null,
      role: "assistant",
      authorUserId: null,
      parts: [part],
      searchText: input.message.text,
      source: "api",
      dialogId: input.message.dialogId,
      dialogMessageId: input.message.messageId,
      dialogName: input.message.name,
      dialogSender: input.message.sender,
      createdAt: safeCreatedAt,
    }).onConflictDoUpdate({
      target: schema.threadMessages.id,
      set: { parts: [part], searchText: input.message.text },
    });
    await tx.update(schema.threads).set({ updatedAt: sql`GREATEST(${schema.threads.updatedAt}, ${safeCreatedAt})` }).where(eq(schema.threads.id, input.threadId));
  });
}
