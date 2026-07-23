import { and, eq, isNull, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { workspaceLifecycleLockKey } from "./lifecycle-lock";
import { findActiveWorkspaceLifecycleOperation } from "./lifecycle-operations";

export async function recordWorkspaceReconciliationStatus(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  status: "ready" | "stopped";
  reconciledAt: Date;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLifecycleLockKey(input.workspaceId)}, 0))`,
    );
    const active = await findActiveWorkspaceLifecycleOperation(transaction, {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
    });
    if (active) return false;
    const [updated] = await transaction
      .update(schema.environmentWorkspaces)
      .set({
        status: input.status,
        lastHealthAt:
          input.status === "ready" ? input.reconciledAt : undefined,
        failureCode: null,
        failureMessage: null,
        updatedAt: input.reconciledAt,
      })
      .where(
        and(
          eq(schema.environmentWorkspaces.id, input.workspaceId),
          eq(
            schema.environmentWorkspaces.organizationId,
            input.organizationId,
          ),
          eq(
            schema.environmentWorkspaces.environmentId,
            input.environmentId,
          ),
          isNull(schema.environmentWorkspaces.deletedAt),
        ),
      )
      .returning({ id: schema.environmentWorkspaces.id });
    return Boolean(updated);
  });
}
