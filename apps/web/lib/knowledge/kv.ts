import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export const KV_KEYS = {
  CURRENT_SNAPSHOT: "snapshot:current",
  SNAPSHOT_STATUS_CACHE: "snapshot:status-cache",
  SNAPSHOT_REPO_CONFIG: "snapshot:repo-config",
  LAST_SOURCE_SYNC: "sources:last-sync",
  AGENT_CONFIG_CACHE: "agent:config-cache",
  session: (sessionId: string) => `session:${sessionId}`,
  ACTIVE_SANDBOX_SESSION: "sandbox:active-session",
} as const;

export async function kvGet<T>(
  key: string,
  organizationId: string
): Promise<T | null> {
  const row = await knowledgeDb.query.knowledgeKv.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.key, key), eq(table.organizationId, organizationId)),
  });
  return (row?.value as T | undefined) ?? null;
}

export async function kvSet(
  key: string,
  value: unknown,
  organizationId: string
): Promise<void> {
  if (value === null) {
    await knowledgeDb
      .delete(schema.knowledgeKv)
      .where(
        and(
          eq(schema.knowledgeKv.key, key),
          eq(schema.knowledgeKv.organizationId, organizationId)
        )
      );
    return;
  }

  await knowledgeDb
    .insert(schema.knowledgeKv)
    .values({
      key,
      organizationId,
      value,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.knowledgeKv.key,
      set: { value, organizationId, updatedAt: new Date() },
    });
}
