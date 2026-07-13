import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { getProjectEnvironmentBinding } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

const inputSchema = z.union([
  z.object({
    providerKey: z.string().trim().min(1),
    capabilityKey: z.string().trim().min(1),
    resourceId: z.string().uuid().nullable(),
    enabled: z.boolean(),
    approvalMode: z.enum(["auto", "ask", "deny"]),
  }),
  z.object({
    mcpCapabilityId: z.string().uuid(),
    enabled: z.boolean(),
    approvalMode: z.enum(["auto", "ask", "deny"]),
  }),
]);

const APPROVAL_LEVEL = { deny: 0, ask: 1, auto: 2 } as const;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
    });
    const binding = await getProjectEnvironmentBinding({
      organizationId,
      projectId: id,
    });
    if (!binding) throw new Error("Project Environment is not configured.");
    const mcpCapabilities = await knowledgeDb
      .select({
        id: schema.mcpCapabilities.id,
        capabilityKey: schema.mcpCapabilities.capabilityKey,
        displayName: schema.mcpCapabilities.displayName,
        description: schema.mcpCapabilities.description,
        kind: schema.mcpCapabilities.kind,
        approvalMode: schema.mcpCapabilities.approvalMode,
        serverName: schema.mcpServers.name,
      })
      .from(schema.mcpCapabilities)
      .innerJoin(
        schema.mcpCapabilitySnapshots,
        eq(schema.mcpCapabilitySnapshots.id, schema.mcpCapabilities.snapshotId)
      )
      .innerJoin(
        schema.mcpServers,
        eq(schema.mcpServers.id, schema.mcpCapabilitySnapshots.serverId)
      )
      .where(
        and(
          eq(schema.mcpCapabilities.environmentEnabled, true),
          eq(schema.mcpCapabilitySnapshots.status, "approved"),
          eq(schema.mcpServers.status, "ready"),
          eq(schema.mcpServers.organizationId, organizationId),
          eq(schema.mcpServers.environmentId, binding.environmentId)
        )
      );
    return NextResponse.json({
      restrictions:
        await knowledgeDb.query.projectCapabilityRestrictions.findMany({
          where: (table, { eq }) => eq(table.projectId, id),
        }),
      mcpRestrictions:
        await knowledgeDb.query.mcpProjectCapabilityRestrictions.findMany({
          where: (table, { eq }) => eq(table.projectId, id),
        }),
      mcpCapabilities,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
      minimumRole: "editor",
    });
    const input = inputSchema.parse(await request.json());
    const binding = await getProjectEnvironmentBinding({
      organizationId,
      projectId: id,
    });
    if (!binding) throw new Error("Project Environment is not configured.");
    if ("mcpCapabilityId" in input) {
      const rows = await knowledgeDb
        .select({ capability: schema.mcpCapabilities })
        .from(schema.mcpCapabilities)
        .innerJoin(
          schema.mcpCapabilitySnapshots,
          eq(
            schema.mcpCapabilitySnapshots.id,
            schema.mcpCapabilities.snapshotId
          )
        )
        .innerJoin(
          schema.mcpServers,
          eq(schema.mcpServers.id, schema.mcpCapabilitySnapshots.serverId)
        )
        .where(
          and(
            eq(schema.mcpCapabilities.id, input.mcpCapabilityId),
            eq(schema.mcpCapabilities.environmentEnabled, true),
            eq(schema.mcpCapabilitySnapshots.status, "approved"),
            eq(schema.mcpServers.organizationId, organizationId),
            eq(schema.mcpServers.environmentId, binding.environmentId)
          )
        )
        .limit(1);
      const capability = rows[0]?.capability;
      if (!capability) {
        throw new Error("Environment MCP capability is unavailable.");
      }
      if (
        input.enabled &&
        APPROVAL_LEVEL[input.approvalMode] >
          APPROVAL_LEVEL[capability.approvalMode]
      ) {
        throw new Error(
          "Project restrictions cannot broaden Environment access."
        );
      }
      const now = new Date();
      const [restriction] = await knowledgeDb.transaction(
        async (transaction) => {
          const existing =
            await transaction.query.mcpProjectCapabilityRestrictions.findFirst({
              where: (table, { and, eq }) =>
                and(
                  eq(table.projectId, id),
                  eq(table.capabilityId, capability.id)
                ),
            });
          const [saved] = existing
            ? await transaction
                .update(schema.mcpProjectCapabilityRestrictions)
                .set({
                  enabled: input.enabled,
                  approvalMode: input.approvalMode,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(schema.mcpProjectCapabilityRestrictions.projectId, id),
                    eq(
                      schema.mcpProjectCapabilityRestrictions.capabilityId,
                      capability.id
                    )
                  )
                )
                .returning()
            : await transaction
                .insert(schema.mcpProjectCapabilityRestrictions)
                .values({
                  projectId: id,
                  capabilityId: capability.id,
                  enabled: input.enabled,
                  approvalMode: input.approvalMode,
                  createdAt: now,
                  updatedAt: now,
                })
                .returning();
          if (capability.kind === "tool" && capability.toolCapabilityKey) {
            const projected =
              await transaction.query.projectCapabilityRestrictions.findFirst({
                where: (table, { and, eq, isNull }) =>
                  and(
                    eq(table.projectId, id),
                    eq(table.providerKey, capability.providerKey),
                    eq(table.capabilityKey, capability.toolCapabilityKey!),
                    isNull(table.resourceId)
                  ),
              });
            if (projected) {
              await transaction
                .update(schema.projectCapabilityRestrictions)
                .set({
                  enabled: input.enabled,
                  approvalMode: input.approvalMode,
                  updatedAt: now,
                })
                .where(
                  eq(schema.projectCapabilityRestrictions.id, projected.id)
                );
            } else {
              await transaction
                .insert(schema.projectCapabilityRestrictions)
                .values({
                  id: crypto.randomUUID(),
                  projectId: id,
                  providerKey: capability.providerKey,
                  capabilityKey: capability.toolCapabilityKey,
                  resourceId: null,
                  enabled: input.enabled,
                  approvalMode: input.approvalMode,
                  createdAt: now,
                  updatedAt: now,
                });
            }
          }
          return [saved];
        }
      );
      await logAdminEvent({
        organizationId,
        actorUserId: session.user.id,
        category: "projects",
        action: "project.mcp_capability.restricted",
        targetType: "project",
        targetId: id,
        message: `Updated Project MCP restriction for ${capability.capabilityKey}.`,
        metadata: {
          mcpCapabilityId: capability.id,
          enabled: input.enabled,
          approvalMode: input.approvalMode,
        },
      });
      return NextResponse.json({ mcpRestriction: restriction });
    }
    const grant = await knowledgeDb.query.environmentCapabilityGrants.findFirst(
      {
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.environmentId, binding.environmentId),
            eq(table.providerKey, input.providerKey),
            eq(table.capabilityKey, input.capabilityKey),
            input.resourceId
              ? eq(table.resourceId, input.resourceId)
              : isNull(table.resourceId)
          ),
      }
    );
    if (!grant) throw new Error("Environment capability grant is unavailable.");
    if (
      input.enabled &&
      APPROVAL_LEVEL[input.approvalMode] > APPROVAL_LEVEL[grant.approvalMode]
    ) {
      throw new Error(
        "Project restrictions cannot broaden Environment access."
      );
    }
    const existing =
      await knowledgeDb.query.projectCapabilityRestrictions.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.projectId, id),
            eq(table.providerKey, input.providerKey),
            eq(table.capabilityKey, input.capabilityKey),
            input.resourceId
              ? eq(table.resourceId, input.resourceId)
              : isNull(table.resourceId)
          ),
      });
    const now = new Date();
    const [restriction] = existing
      ? await knowledgeDb
          .update(schema.projectCapabilityRestrictions)
          .set({
            enabled: input.enabled,
            approvalMode: input.approvalMode,
            updatedAt: now,
          })
          .where(eq(schema.projectCapabilityRestrictions.id, existing.id))
          .returning()
      : await knowledgeDb
          .insert(schema.projectCapabilityRestrictions)
          .values({
            id: crypto.randomUUID(),
            projectId: id,
            ...input,
            updatedAt: now,
          })
          .returning();
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "projects",
      action: "project.capability.restricted",
      targetType: "project",
      targetId: id,
      message: `Updated Project restriction for ${input.providerKey}.${input.capabilityKey}.`,
      metadata: input,
    });
    return NextResponse.json({ restriction });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
