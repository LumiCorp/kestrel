import { eq } from "drizzle-orm";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export const environmentGrantInputSchema = z.object({
  providerKey: z.string().trim().min(1).max(120),
  capabilityKey: z.string().trim().min(1).max(120),
  resourceId: z.string().uuid().nullable(),
  approvalMode: z.enum(["auto", "ask", "deny"]),
  loggingMode: z.enum(["full", "metadata_only", "minimal"]).default("full"),
  rateLimitMode: z.enum(["default", "strict", "off"]).default("default"),
});

export const environmentSubjectRestrictionInputSchema = z.object({
  subjectType: z.enum(["actor", "agent"]),
  subjectId: z.string().trim().min(1).max(255),
  providerKey: z.string().trim().min(1).max(120),
  capabilityKey: z.string().trim().min(1).max(120),
  resourceId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  approvalMode: z.enum(["auto", "ask", "deny"]),
});

export async function listAdminEnvironmentAccess(input: {
  organizationId: string;
  environmentId?: string;
}) {
  const [resources, grants, subjectRestrictions] = await Promise.all([
    knowledgeDb.query.toolConnectionResources.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.enabled, true)
        ),
      orderBy: (table, { asc }) => [asc(table.providerKey), asc(table.label)],
    }),
    input.environmentId
      ? knowledgeDb.query.environmentCapabilityGrants.findMany({
          where: (table, { eq }) =>
            eq(table.environmentId, input.environmentId!),
        })
      : Promise.resolve([]),
    input.environmentId
      ? knowledgeDb.query.environmentCapabilitySubjectRestrictions.findMany({
          where: (table, { and, eq }) =>
            and(
              eq(table.organizationId, input.organizationId),
              eq(table.environmentId, input.environmentId!)
            ),
        })
      : Promise.resolve([]),
  ]);
  return { resources, grants, subjectRestrictions };
}

export async function saveAdminEnvironmentSubjectRestriction(input: {
  organizationId: string;
  environmentId: string;
  actorUserId: string;
  restriction: z.infer<typeof environmentSubjectRestrictionInputSchema>;
}) {
  const environment = await getOrganizationEnvironment({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  if (!environment) throw new Error("Environment not found.");
  if (input.restriction.subjectType === "actor") {
    const member = await knowledgeDb.query.members.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.userId, input.restriction.subjectId)
        ),
      columns: { id: true },
    });
    if (!member) throw new Error("Actor is not an organization member.");
  }
  if (input.restriction.resourceId) {
    const resource = await knowledgeDb.query.toolConnectionResources.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.restriction.resourceId!),
          eq(table.organizationId, input.organizationId),
          eq(table.providerKey, input.restriction.providerKey),
          eq(table.enabled, true)
        ),
      columns: { id: true },
    });
    if (!resource) throw new Error("Tool resource is unavailable.");
  }
  const existing =
    await knowledgeDb.query.environmentCapabilitySubjectRestrictions.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
          eq(table.subjectType, input.restriction.subjectType),
          eq(table.subjectId, input.restriction.subjectId),
          eq(table.providerKey, input.restriction.providerKey),
          eq(table.capabilityKey, input.restriction.capabilityKey),
          input.restriction.resourceId
            ? eq(table.resourceId, input.restriction.resourceId)
            : isNull(table.resourceId)
        ),
    });
  const now = new Date();
  const values = {
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    ...input.restriction,
    updatedAt: now,
  };
  const [restriction] = existing
    ? await knowledgeDb
        .update(schema.environmentCapabilitySubjectRestrictions)
        .set({
          enabled: input.restriction.enabled,
          approvalMode: input.restriction.approvalMode,
          updatedAt: now,
        })
        .where(
          eq(schema.environmentCapabilitySubjectRestrictions.id, existing.id)
        )
        .returning()
    : await knowledgeDb
        .insert(schema.environmentCapabilitySubjectRestrictions)
        .values({ id: crypto.randomUUID(), ...values })
        .returning();
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "environment.capability.subject.updated",
    targetType: "environment",
    targetId: input.environmentId,
    message: `Updated ${input.restriction.subjectType} capability narrowing.`,
    metadata: input.restriction,
  });
  return restriction;
}

export async function saveAdminEnvironmentGrant(input: {
  organizationId: string;
  environmentId: string;
  actorUserId: string;
  grant: z.infer<typeof environmentGrantInputSchema>;
}) {
  const environment = await getOrganizationEnvironment({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  if (!environment) throw new Error("Environment not found.");
  if (input.grant.resourceId) {
    const resource = await knowledgeDb.query.toolConnectionResources.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.grant.resourceId!),
          eq(table.organizationId, input.organizationId),
          eq(table.providerKey, input.grant.providerKey),
          eq(table.enabled, true)
        ),
    });
    if (!resource) throw new Error("Tool resource is unavailable.");
  }
  const now = new Date();
  const existing =
    await knowledgeDb.query.environmentCapabilityGrants.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.environmentId, input.environmentId),
          eq(table.providerKey, input.grant.providerKey),
          eq(table.capabilityKey, input.grant.capabilityKey),
          input.grant.resourceId
            ? eq(table.resourceId, input.grant.resourceId)
            : isNull(table.resourceId)
        ),
    });
  const [grant] = existing
    ? await knowledgeDb
        .update(schema.environmentCapabilityGrants)
        .set({
          approvalMode: input.grant.approvalMode,
          loggingMode: input.grant.loggingMode,
          rateLimitMode: input.grant.rateLimitMode,
          updatedAt: now,
        })
        .where(eq(schema.environmentCapabilityGrants.id, existing.id))
        .returning()
    : await knowledgeDb
        .insert(schema.environmentCapabilityGrants)
        .values({
          id: crypto.randomUUID(),
          environmentId: input.environmentId,
          ...input.grant,
          updatedAt: now,
        })
        .returning();
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "environment.capability.updated",
    targetType: "environment",
    targetId: input.environmentId,
    message: `Updated ${input.grant.providerKey}.${input.grant.capabilityKey} Environment access.`,
    metadata: {
      resourceId: input.grant.resourceId,
      approvalMode: input.grant.approvalMode,
      loggingMode: input.grant.loggingMode,
      rateLimitMode: input.grant.rateLimitMode,
    },
  });
  return grant;
}
