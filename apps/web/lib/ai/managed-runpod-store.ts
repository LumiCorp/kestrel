import "server-only";

import { and, count, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  hashManagedRunPodProfile,
  type ManagedRunPodProfileInput,
  type ManagedRunPodSpecSnapshot,
  managedRunPodProfileInputSchema,
  parseManagedRunPodSpecSnapshot,
  sanitizeManagedRunPodEndpointSpec,
  sanitizeManagedRunPodSpecSnapshot,
  sanitizeManagedRunPodTemplateSpec,
} from "./managed-runpod-contracts";

const ACTIVE_DEPLOYMENT_STATUSES = [
  "requested",
  "provisioning_template",
  "provisioning_endpoint",
  "waiting_for_capacity",
  "validating",
  "ready",
  "failed",
  "deleting",
  "delete_failed",
] as const;

export async function listManagedRunPodProfiles(input: {
  organizationId: string;
  includeInactive?: boolean;
}) {
  return knowledgeDb.query.aiDeploymentProfiles.findMany({
    where: and(
      eq(schema.aiDeploymentProfiles.organizationId, input.organizationId),
      input.includeInactive
        ? undefined
        : eq(schema.aiDeploymentProfiles.status, "active")
    ),
    orderBy: [
      schema.aiDeploymentProfiles.displayName,
      desc(schema.aiDeploymentProfiles.version),
    ],
  });
}

export function sanitizeManagedRunPodProfile(
  profile: typeof schema.aiDeploymentProfiles.$inferSelect
) {
  return {
    id: profile.id,
    profileKey: profile.profileKey,
    version: profile.version,
    displayName: profile.displayName,
    description: profile.description,
    status: profile.status,
    imageRef: profile.imageRef,
    expectedModelId: profile.expectedModelId,
    endpointSpec: sanitizeManagedRunPodEndpointSpec(profile.endpointSpec),
    templateSpec: sanitizeManagedRunPodTemplateSpec(profile.templateSpec),
    costLimitUsdPerHour: profile.costLimitUsdPerHour,
    qualifiedAt: profile.qualifiedAt,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function sanitizeManagedRunPodDeployment(
  deployment: typeof schema.aiDeployments.$inferSelect
) {
  return {
    ...deployment,
    specSnapshot: sanitizeManagedRunPodSpecSnapshot(deployment.specSnapshot),
  };
}

export async function createManagedRunPodProfile(input: {
  organizationId: string;
  actorUserId: string;
  profile: ManagedRunPodProfileInput;
}) {
  const profile = managedRunPodProfileInputSchema.parse(input.profile);
  const latest = await knowledgeDb.query.aiDeploymentProfiles.findFirst({
    where: and(
      eq(schema.aiDeploymentProfiles.organizationId, input.organizationId),
      eq(schema.aiDeploymentProfiles.profileKey, profile.profileKey)
    ),
    orderBy: [desc(schema.aiDeploymentProfiles.version)],
    columns: { version: true },
  });
  const [created] = await knowledgeDb
    .insert(schema.aiDeploymentProfiles)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      ...profile,
      version: (latest?.version ?? 0) + 1,
      provider: "runpod",
      status: "draft",
      specHash: hashManagedRunPodProfile(profile),
      createdByUserId: input.actorUserId,
      updatedAt: new Date(),
    })
    .returning();
  return created;
}

export async function queueManagedRunPodQualification(input: {
  organizationId: string;
  profileId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(schema.aiDeploymentProfiles)
      .where(
        and(
          eq(schema.aiDeploymentProfiles.id, input.profileId),
          eq(schema.aiDeploymentProfiles.organizationId, input.organizationId)
        )
      )
      .limit(1)
      .for("update");
    if (!profile || profile.status !== "draft") {
      throw new Error("Only a draft deployment profile can be qualified.");
    }
    const [run] = await tx
      .insert(schema.aiDeploymentRuns)
      .values({
        id: crypto.randomUUID(),
        kind: "qualification",
        profileId: profile.id,
        status: "queued",
        updatedAt: new Date(),
      })
      .returning();
    await tx
      .update(schema.aiDeploymentProfiles)
      .set({ status: "qualifying", updatedAt: new Date() })
      .where(eq(schema.aiDeploymentProfiles.id, profile.id));
    return run;
  });
}

export async function activateManagedRunPodProfile(input: {
  organizationId: string;
  profileId: string;
  actorUserId: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(schema.aiDeploymentProfiles)
      .where(
        and(
          eq(schema.aiDeploymentProfiles.id, input.profileId),
          eq(schema.aiDeploymentProfiles.organizationId, input.organizationId)
        )
      )
      .limit(1)
      .for("update");
    const evidence = profile?.qualificationEvidence as Record<
      string,
      unknown
    > | null;
    if (
      profile?.status !== "draft" ||
      !profile.qualifiedAt ||
      evidence?.specHash !== profile.specHash
    ) {
      throw new Error(
        "Deployment profile qualification is required before activation."
      );
    }
    await tx
      .update(schema.aiDeploymentProfiles)
      .set({ status: "deprecated", updatedAt: new Date() })
      .where(
        and(
          eq(schema.aiDeploymentProfiles.profileKey, profile.profileKey),
          eq(schema.aiDeploymentProfiles.organizationId, input.organizationId),
          eq(schema.aiDeploymentProfiles.status, "active"),
          ne(schema.aiDeploymentProfiles.id, profile.id)
        )
      );
    const [updated] = await tx
      .update(schema.aiDeploymentProfiles)
      .set({
        status: "active",
        activatedByUserId: input.actorUserId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.aiDeploymentProfiles.id, input.profileId),
          eq(schema.aiDeploymentProfiles.organizationId, input.organizationId)
        )
      )
      .returning();
    return updated;
  });
}

export async function deprecateManagedRunPodProfile(input: {
  organizationId: string;
  profileId: string;
}) {
  const [updated] = await knowledgeDb
    .update(schema.aiDeploymentProfiles)
    .set({ status: "deprecated", updatedAt: new Date() })
    .where(
      and(
        eq(schema.aiDeploymentProfiles.id, input.profileId),
        eq(schema.aiDeploymentProfiles.organizationId, input.organizationId)
      )
    )
    .returning();
  return updated;
}

export async function upsertManagedRunPodOrganizationPolicy(input: {
  organizationId: string;
  actorUserId: string;
  enabled: boolean;
  maxActiveDeployments: number;
}) {
  const [policy] = await knowledgeDb
    .insert(schema.organizationAiDeploymentPolicies)
    .values({
      organizationId: input.organizationId,
      enabled: input.enabled,
      maxActiveDeployments: input.maxActiveDeployments,
      updatedByUserId: input.actorUserId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.organizationAiDeploymentPolicies.organizationId,
      set: {
        enabled: input.enabled,
        maxActiveDeployments: input.maxActiveDeployments,
        updatedByUserId: input.actorUserId,
        updatedAt: new Date(),
      },
    })
    .returning();
  return policy;
}

export async function setManagedRunPodEntitlement(input: {
  organizationId: string;
  userId: string;
  actorUserId: string;
  entitled: boolean;
}) {
  const member = await knowledgeDb.query.members.findFirst({
    where: and(
      eq(schema.members.organizationId, input.organizationId),
      eq(schema.members.userId, input.userId)
    ),
    columns: { id: true },
  });
  if (!member) {
    throw new Error(
      "Deployment entitlement user is not an organization member."
    );
  }
  if (!input.entitled) {
    await knowledgeDb
      .delete(schema.organizationAiDeploymentEntitlements)
      .where(
        and(
          eq(
            schema.organizationAiDeploymentEntitlements.organizationId,
            input.organizationId
          ),
          eq(schema.organizationAiDeploymentEntitlements.userId, input.userId)
        )
      );
    return null;
  }
  const [entitlement] = await knowledgeDb
    .insert(schema.organizationAiDeploymentEntitlements)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      grantedByUserId: input.actorUserId,
    })
    .onConflictDoUpdate({
      target: [
        schema.organizationAiDeploymentEntitlements.organizationId,
        schema.organizationAiDeploymentEntitlements.userId,
      ],
      set: { grantedByUserId: input.actorUserId, updatedAt: new Date() },
    })
    .returning();
  return entitlement;
}

export async function listManagedRunPodOrganizationAccess(
  organizationId: string
) {
  const [policy, members, entitlements] = await Promise.all([
    knowledgeDb.query.organizationAiDeploymentPolicies.findFirst({
      where: eq(
        schema.organizationAiDeploymentPolicies.organizationId,
        organizationId
      ),
    }),
    knowledgeDb
      .select({ member: schema.members, user: schema.users })
      .from(schema.members)
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(eq(schema.members.organizationId, organizationId)),
    knowledgeDb.query.organizationAiDeploymentEntitlements.findMany({
      where: eq(
        schema.organizationAiDeploymentEntitlements.organizationId,
        organizationId
      ),
    }),
  ]);
  const entitledUserIds = new Set(entitlements.map((row) => row.userId));
  return {
    policy: policy ?? {
      organizationId,
      enabled: false,
      maxActiveDeployments: 0,
    },
    members: members.map(({ member, user }) => ({
      userId: member.userId,
      name: user.name,
      email: user.email,
      role: member.role,
      entitled:
        entitledUserIds.has(member.userId) ||
        member.role === "owner" ||
        member.role === "admin",
    })),
  };
}

function toSpecSnapshot(
  profile: typeof schema.aiDeploymentProfiles.$inferSelect
): ManagedRunPodSpecSnapshot {
  return parseManagedRunPodSpecSnapshot({
    profileId: profile.id,
    profileVersion: profile.version,
    specHash: profile.specHash,
    profileKey: profile.profileKey,
    displayName: profile.displayName,
    description: profile.description,
    imageRef: profile.imageRef,
    expectedModelId: profile.expectedModelId,
    templateSpec: profile.templateSpec,
    endpointSpec: profile.endpointSpec,
    costLimitUsdPerHour: profile.costLimitUsdPerHour,
  });
}

export async function createManagedRunPodDeployment(input: {
  organizationId: string;
  environmentId: string;
  actorUserId: string;
  profileId: string;
  displayName: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const environment = await tx.query.environments.findFirst({
      where: and(
        eq(schema.environments.id, input.environmentId),
        eq(schema.environments.organizationId, input.organizationId),
        isNull(schema.environments.archivedAt)
      ),
      columns: { id: true },
    });
    if (!environment) {
      throw new Error("Environment not found or unavailable.");
    }
    const [policy] = await tx
      .select()
      .from(schema.organizationAiDeploymentPolicies)
      .where(
        eq(
          schema.organizationAiDeploymentPolicies.organizationId,
          input.organizationId
        )
      )
      .limit(1)
      .for("update");
    if (!(policy?.enabled && policy.maxActiveDeployments > 0)) {
      throw new Error(
        "Managed RunPod deployments are not enabled for this organization."
      );
    }
    const profile = await tx.query.aiDeploymentProfiles.findFirst({
      where: and(
        eq(schema.aiDeploymentProfiles.id, input.profileId),
        eq(schema.aiDeploymentProfiles.organizationId, input.organizationId),
        eq(schema.aiDeploymentProfiles.status, "active")
      ),
    });
    if (!profile) {
      throw new Error("Active deployment profile not found.");
    }
    const existingDeployment = await tx.query.aiDeployments.findFirst({
      where: and(
        eq(schema.aiDeployments.environmentId, input.environmentId),
        eq(schema.aiDeployments.profileId, input.profileId),
        isNull(schema.aiDeployments.deletedAt)
      ),
      columns: { id: true },
    });
    if (existingDeployment) {
      throw new Error(
        "This Environment already has an active deployment for this profile."
      );
    }
    const [aggregate] = await tx
      .select({ value: count() })
      .from(schema.aiDeployments)
      .where(
        and(
          eq(schema.aiDeployments.organizationId, input.organizationId),
          isNull(schema.aiDeployments.deletedAt),
          inArray(schema.aiDeployments.status, [...ACTIVE_DEPLOYMENT_STATUSES])
        )
      );
    if ((aggregate?.value ?? 0) >= policy.maxActiveDeployments) {
      throw new Error("Managed RunPod deployment quota is exhausted.");
    }
    const deploymentId = crypto.randomUUID();
    const [deployment] = await tx
      .insert(schema.aiDeployments)
      .values({
        id: deploymentId,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        createdByUserId: input.actorUserId,
        profileId: profile.id,
        displayName: input.displayName,
        status: "requested",
        specSnapshot: toSpecSnapshot(profile),
        reconciliationDeadline: new Date(Date.now() + 30 * 60 * 1000),
        updatedAt: new Date(),
      })
      .returning();
    const [run] = await tx
      .insert(schema.aiDeploymentRuns)
      .values({
        id: crypto.randomUUID(),
        kind: "provision",
        profileId: profile.id,
        deploymentId,
        status: "queued",
        updatedAt: new Date(),
      })
      .returning();
    return { deployment, run };
  });
}

export async function listManagedRunPodDeployments(
  organizationId: string,
  environmentId?: string
) {
  const rows = await knowledgeDb
    .select({
      deployment: schema.aiDeployments,
      profile: schema.aiDeploymentProfiles,
    })
    .from(schema.aiDeployments)
    .innerJoin(
      schema.aiDeploymentProfiles,
      eq(schema.aiDeploymentProfiles.id, schema.aiDeployments.profileId)
    )
    .where(
      and(
        eq(schema.aiDeployments.organizationId, organizationId),
        environmentId
          ? eq(schema.aiDeployments.environmentId, environmentId)
          : undefined,
        ne(schema.aiDeployments.status, "deleted")
      )
    )
    .orderBy(desc(schema.aiDeployments.createdAt));
  return rows.map(({ deployment, profile }) => ({
    deployment: sanitizeManagedRunPodDeployment(deployment),
    profile: sanitizeManagedRunPodProfile(profile),
  }));
}

export async function listManagedRunPodFleet(organizationId: string) {
  const [deployments, usage] = await Promise.all([
    knowledgeDb
      .select({
        deployment: schema.aiDeployments,
        profile: schema.aiDeploymentProfiles,
        organization: schema.organizations,
      })
      .from(schema.aiDeployments)
      .innerJoin(
        schema.aiDeploymentProfiles,
        eq(schema.aiDeploymentProfiles.id, schema.aiDeployments.profileId)
      )
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.aiDeployments.organizationId)
      )
      .where(eq(schema.aiDeployments.organizationId, organizationId))
      .orderBy(desc(schema.aiDeployments.createdAt)),
    knowledgeDb
      .select({ usage: schema.aiDeploymentUsage })
      .from(schema.aiDeploymentUsage)
      .innerJoin(
        schema.aiDeployments,
        eq(schema.aiDeployments.id, schema.aiDeploymentUsage.deploymentId)
      )
      .where(eq(schema.aiDeployments.organizationId, organizationId))
      .orderBy(desc(schema.aiDeploymentUsage.bucketStartedAt)),
  ]);
  const spendByDeployment = new Map<string, number>();
  for (const { usage: record } of usage) {
    spendByDeployment.set(
      record.deploymentId,
      (spendByDeployment.get(record.deploymentId) ?? 0) + record.amountUsd
    );
  }
  return deployments.map((row) => ({
    ...row,
    attributedSpendUsd: spendByDeployment.get(row.deployment.id) ?? 0,
  }));
}

export async function getManagedRunPodDeployment(input: {
  deploymentId: string;
  organizationId: string;
  environmentId?: string;
}) {
  const [row] = await knowledgeDb
    .select({
      deployment: schema.aiDeployments,
      profile: schema.aiDeploymentProfiles,
    })
    .from(schema.aiDeployments)
    .innerJoin(
      schema.aiDeploymentProfiles,
      eq(schema.aiDeploymentProfiles.id, schema.aiDeployments.profileId)
    )
    .where(
      and(
        eq(schema.aiDeployments.id, input.deploymentId),
        eq(schema.aiDeployments.organizationId, input.organizationId),
        input.environmentId
          ? eq(schema.aiDeployments.environmentId, input.environmentId)
          : undefined
      )
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const [runs, usage] = await Promise.all([
    knowledgeDb.query.aiDeploymentRuns.findMany({
      where: eq(schema.aiDeploymentRuns.deploymentId, input.deploymentId),
      orderBy: [desc(schema.aiDeploymentRuns.createdAt)],
    }),
    knowledgeDb.query.aiDeploymentUsage.findMany({
      where: eq(schema.aiDeploymentUsage.deploymentId, input.deploymentId),
      orderBy: [desc(schema.aiDeploymentUsage.bucketStartedAt)],
    }),
  ]);
  return {
    deployment: sanitizeManagedRunPodDeployment(row.deployment),
    profile: sanitizeManagedRunPodProfile(row.profile),
    runs,
    usage,
  };
}

export async function queueManagedRunPodDeletion(input: {
  deploymentId: string;
  organizationId: string;
  environmentId?: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [deployment] = await tx
      .select()
      .from(schema.aiDeployments)
      .where(
        and(
          eq(schema.aiDeployments.id, input.deploymentId),
          eq(schema.aiDeployments.organizationId, input.organizationId),
          input.environmentId
            ? eq(schema.aiDeployments.environmentId, input.environmentId)
            : undefined
        )
      )
      .limit(1)
      .for("update");
    if (!deployment || deployment.status === "deleted") {
      return null;
    }
    await tx
      .update(schema.aiDeployments)
      .set({ status: "deleting", failureCode: null, failureMessage: null })
      .where(eq(schema.aiDeployments.id, deployment.id));
    if (deployment.gatewayId) {
      await tx
        .update(schema.aiGateways)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(schema.aiGateways.id, deployment.gatewayId));
    }
    const [run] = await tx
      .insert(schema.aiDeploymentRuns)
      .values({
        id: crypto.randomUUID(),
        kind: "delete",
        profileId: deployment.profileId,
        deploymentId: deployment.id,
        status: "queued",
      })
      .returning();
    return { deployment: { ...deployment, status: "deleting" as const }, run };
  });
}

export async function queueManagedRunPodRetry(input: {
  deploymentId: string;
  organizationId: string;
  environmentId?: string;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [deployment] = await tx
      .select()
      .from(schema.aiDeployments)
      .where(
        and(
          eq(schema.aiDeployments.id, input.deploymentId),
          eq(schema.aiDeployments.organizationId, input.organizationId),
          input.environmentId
            ? eq(schema.aiDeployments.environmentId, input.environmentId)
            : undefined
        )
      )
      .limit(1)
      .for("update");
    if (
      !deployment ||
      (deployment.status !== "failed" && deployment.status !== "delete_failed")
    ) {
      throw new Error(
        "Only a failed managed RunPod deployment can be retried."
      );
    }
    const kind = deployment.status === "delete_failed" ? "delete" : "provision";
    if (kind === "provision") {
      const [policy] = await tx
        .select()
        .from(schema.organizationAiDeploymentPolicies)
        .where(
          eq(
            schema.organizationAiDeploymentPolicies.organizationId,
            input.organizationId
          )
        )
        .limit(1)
        .for("update");
      if (!(policy?.enabled && policy.maxActiveDeployments > 0)) {
        throw new Error(
          "Managed RunPod deployments are not enabled for this organization."
        );
      }
    }
    const [run] = await tx
      .insert(schema.aiDeploymentRuns)
      .values({
        id: crypto.randomUUID(),
        kind,
        profileId: deployment.profileId,
        deploymentId: deployment.id,
        status: "queued",
        providerTemplateId: deployment.providerTemplateId,
        providerEndpointId: deployment.providerEndpointId,
      })
      .returning();
    await tx
      .update(schema.aiDeployments)
      .set({
        status: kind === "delete" ? "deleting" : "requested",
        failureCode: null,
        failureMessage: null,
        reconciliationDeadline: new Date(Date.now() + 30 * 60 * 1000),
        updatedAt: new Date(),
      })
      .where(eq(schema.aiDeployments.id, deployment.id));
    return { deployment, run };
  });
}
