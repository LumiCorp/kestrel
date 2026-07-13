import { knowledgeDb, schema } from "@/lib/knowledge/db";

export const HOSTED_ENVIRONMENTS_FEATURE_KEY = "hosted_environments";

export type HostedEnvironmentsRollout = {
  deploymentEnabled: boolean;
  organizationEnabled: boolean;
  effectiveEnabled: boolean;
};

export function hostedEnvironmentsDeploymentEnabled(
  env: Record<string, string | undefined> = process.env
) {
  return env.KESTREL_ENVIRONMENTS_ENABLED?.trim().toLowerCase() === "true";
}

export function hostedEnvironmentsEnabled(input: {
  organizationEnabled: boolean;
  env?: Record<string, string | undefined>;
}) {
  return (
    hostedEnvironmentsDeploymentEnabled(input.env) && input.organizationEnabled
  );
}

export async function getHostedEnvironmentsRollout(input: {
  organizationId: string;
  env?: Record<string, string | undefined>;
}): Promise<HostedEnvironmentsRollout> {
  const flag = await knowledgeDb.query.organizationFeatureFlags.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.key, HOSTED_ENVIRONMENTS_FEATURE_KEY)
      ),
  });
  const deploymentEnabled = hostedEnvironmentsDeploymentEnabled(input.env);
  const organizationEnabled = flag?.enabled === true;
  return {
    deploymentEnabled,
    organizationEnabled,
    effectiveEnabled: deploymentEnabled && organizationEnabled,
  };
}

export async function setHostedEnvironmentsOrganizationFlag(input: {
  organizationId: string;
  actorUserId: string;
  enabled: boolean;
}) {
  const now = new Date();
  const [flag] = await knowledgeDb
    .insert(schema.organizationFeatureFlags)
    .values({
      organizationId: input.organizationId,
      key: HOSTED_ENVIRONMENTS_FEATURE_KEY,
      enabled: input.enabled,
      updatedByUserId: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.organizationFeatureFlags.organizationId,
        schema.organizationFeatureFlags.key,
      ],
      set: {
        enabled: input.enabled,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      },
    })
    .returning();
  if (!flag) throw new Error("Environment rollout update failed.");
  return flag;
}

export async function requireHostedEnvironmentsEnabled(input: {
  organizationId: string;
  env?: Record<string, string | undefined>;
}) {
  const rollout = await getHostedEnvironmentsRollout(input);
  if (!rollout.deploymentEnabled) {
    throw new Error(
      "Hosted Environments are not enabled for this Kestrel One deployment."
    );
  }
  if (!rollout.organizationEnabled) {
    throw new Error(
      "Hosted Environments are not enabled for this organization."
    );
  }
  return rollout;
}
