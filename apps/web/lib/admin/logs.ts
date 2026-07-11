import { and, count, eq, lt, max, min, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export type AdminLogLevel = "info" | "warn" | "error" | "debug";

export type AdminLogInput = {
  organizationId?: string | null;
  actorUserId?: string | null;
  level?: AdminLogLevel;
  category: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  message: string;
  metadata?: Record<string, unknown> | null;
};

const ALLOWED_LEVELS = new Set<AdminLogLevel>([
  "info",
  "warn",
  "error",
  "debug",
]);

export function isAdminLogLevel(
  value: string | null | undefined
): value is AdminLogLevel {
  return Boolean(value && ALLOWED_LEVELS.has(value as AdminLogLevel));
}

export function parseAdminLogLevel(value: string | null | undefined) {
  if (!value) {
    return;
  }

  if (!isAdminLogLevel(value)) {
    throw new Error("Invalid log level");
  }

  return value;
}

export async function logAdminEvent(input: AdminLogInput) {
  await knowledgeDb.insert(schema.adminEventLogs).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId ?? null,
    actorUserId: input.actorUserId ?? null,
    level: input.level ?? "info",
    category: input.category,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    message: input.message,
    metadata: input.metadata ?? null,
    createdAt: new Date(),
  });
}

export async function getAdminLogStats(organizationId: string) {
  const e = schema.adminEventLogs;
  const dayExpr = sql<string>`to_char(${e.createdAt}, 'YYYY-MM-DD')`;

  const [levelRows, dailyRows, meta] = await Promise.all([
    knowledgeDb
      .select({
        level: e.level,
        count: count(),
      })
      .from(e)
      .where(eq(e.organizationId, organizationId))
      .groupBy(e.level),
    knowledgeDb
      .select({
        day: dayExpr,
        count: count(),
      })
      .from(e)
      .where(eq(e.organizationId, organizationId))
      .groupBy(dayExpr)
      .orderBy(dayExpr),
    knowledgeDb
      .select({
        total: count(),
        oldest: min(e.createdAt),
        newest: max(e.createdAt),
      })
      .from(e)
      .where(eq(e.organizationId, organizationId)),
  ]);

  return {
    totalCount: Number(meta[0]?.total ?? 0),
    oldestLog: meta[0]?.oldest ?? null,
    newestLog: meta[0]?.newest ?? null,
    levelBreakdown: levelRows.map((row) => ({
      level: row.level,
      count: Number(row.count),
    })),
    dailyVolume: dailyRows.map((row) => ({
      day: row.day,
      count: Number(row.count),
    })),
  };
}

export async function countAdminLogsBefore(
  organizationId: string,
  before: Date,
  level?: AdminLogLevel
) {
  const conditions = [eq(schema.adminEventLogs.organizationId, organizationId)];
  conditions.push(lt(schema.adminEventLogs.createdAt, before));

  if (level) {
    conditions.push(eq(schema.adminEventLogs.level, level));
  }

  const [result] = await knowledgeDb
    .select({ count: count() })
    .from(schema.adminEventLogs)
    .where(and(...conditions));

  return Number(result?.count ?? 0);
}

export async function deleteAdminLogsBefore(
  organizationId: string,
  before: Date,
  level?: AdminLogLevel
) {
  const conditions = [eq(schema.adminEventLogs.organizationId, organizationId)];
  conditions.push(lt(schema.adminEventLogs.createdAt, before));

  if (level) {
    conditions.push(eq(schema.adminEventLogs.level, level));
  }

  const matchingCount = await countAdminLogsBefore(
    organizationId,
    before,
    level
  );

  if (matchingCount > 0) {
    await knowledgeDb.delete(schema.adminEventLogs).where(and(...conditions));
  }

  return matchingCount;
}

export async function listRecentAdminEvents(
  organizationId: string,
  limit = 20
) {
  return knowledgeDb.query.adminEventLogs.findMany({
    where: (table, { eq }) => eq(table.organizationId, organizationId),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    limit,
  });
}
