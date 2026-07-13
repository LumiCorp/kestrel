import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { getProjectEnvironmentBinding } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

const inputSchema = z.object({
  providerKey: z.string().trim().min(1),
  capabilityKey: z.string().trim().min(1),
  resourceId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  approvalMode: z.enum(["auto", "ask", "deny"]),
});

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
    return NextResponse.json({
      restrictions:
        await knowledgeDb.query.projectCapabilityRestrictions.findMany({
          where: (table, { eq }) => eq(table.projectId, id),
        }),
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
