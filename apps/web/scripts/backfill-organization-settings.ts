import { eq, isNull, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "../lib/knowledge/db";

function parseArguments(argv: string[]) {
  const organizationFlag = argv.indexOf("--organization-id");
  const organizationId = organizationFlag >= 0 ? argv[organizationFlag + 1]?.trim() : "";
  const dryRun = argv.includes("--dry-run");
  const apply = argv.includes("--apply");
  if (!organizationId) throw new Error("--organization-id is required.");
  if (dryRun === apply) throw new Error("Choose exactly one of --dry-run or --apply.");
  return { organizationId, mode: apply ? ("apply" as const) : ("dry-run" as const) };
}

async function inventory(organizationId: string) {
  const organization = await knowledgeDb.query.organizations.findFirst({
    where: eq(schema.organizations.id, organizationId),
    columns: { id: true },
  });
  if (!organization) throw new Error("Target organization does not exist.");
  const [connections, profiles, gateways, models] = await Promise.all([
    knowledgeDb.query.aiProviderConnections.findMany({ where: isNull(schema.aiProviderConnections.organizationId) }),
    knowledgeDb.query.aiDeploymentProfiles.findMany({ where: isNull(schema.aiDeploymentProfiles.organizationId) }),
    knowledgeDb.query.aiGateways.findMany({ where: isNull(schema.aiGateways.organizationId) }),
    knowledgeDb.query.aiGatewayModels.findMany({ where: isNull(schema.aiGatewayModels.organizationId) }),
  ]);
  const conflicts: string[] = [];

  for (const connection of connections) {
    const references = await knowledgeDb.query.aiGateways.findMany({
      where: eq(schema.aiGateways.providerConnectionId, connection.id),
      columns: { organizationId: true },
    });
    const owners = new Set(references.map((row) => row.organizationId).filter(Boolean));
    if ([...owners].some((owner) => owner !== organizationId)) conflicts.push(`provider connection ${connection.id} is referenced by another organization`);
  }
  for (const profile of profiles) {
    const references = await knowledgeDb.query.aiDeployments.findMany({
      where: eq(schema.aiDeployments.profileId, profile.id),
      columns: { organizationId: true },
    });
    const owners = new Set(references.map((row) => row.organizationId));
    if ([...owners].some((owner) => owner !== organizationId)) conflicts.push(`deployment profile ${profile.id} is referenced by another organization`);
  }
  for (const gateway of gateways) {
    const owners = new Set<string>();
    if (gateway.environmentId) {
      const environment = await knowledgeDb.query.environments.findFirst({ where: eq(schema.environments.id, gateway.environmentId), columns: { organizationId: true } });
      if (environment) owners.add(environment.organizationId);
    }
    if (gateway.deploymentId) {
      const deployment = await knowledgeDb.query.aiDeployments.findFirst({ where: eq(schema.aiDeployments.id, gateway.deploymentId), columns: { organizationId: true } });
      if (deployment) owners.add(deployment.organizationId);
    }
    if ([...owners].some((owner) => owner !== organizationId)) conflicts.push(`gateway ${gateway.id} is attached to another organization`);
  }
  for (const model of models) {
    const gateway = await knowledgeDb.query.aiGateways.findFirst({ where: eq(schema.aiGateways.id, model.gatewayId), columns: { organizationId: true } });
    if (gateway?.organizationId && gateway.organizationId !== organizationId) conflicts.push(`gateway model ${model.id} belongs to another organization`);
  }
  return { connections, profiles, gateways, models, conflicts };
}

async function run() {
  const { organizationId, mode } = parseArguments(process.argv.slice(2));
  const plan = await inventory(organizationId);
  if (plan.conflicts.length > 0) {
    process.stderr.write(`${JSON.stringify({ mode, organizationId, status: "rejected", conflicts: plan.conflicts })}\n`);
    process.exitCode = 1;
    return;
  }
  if (mode === "apply") {
    await knowledgeDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kestrel-one-organization-settings-backfill'))`);
      await tx.update(schema.aiProviderConnections).set({ organizationId, updatedAt: new Date() }).where(isNull(schema.aiProviderConnections.organizationId));
      await tx.update(schema.aiDeploymentProfiles).set({ organizationId, updatedAt: new Date() }).where(isNull(schema.aiDeploymentProfiles.organizationId));
      await tx.update(schema.aiGateways).set({ organizationId, apiKeyEnvVar: null, updatedAt: new Date() }).where(isNull(schema.aiGateways.organizationId));
      await tx.update(schema.aiGatewayModels).set({ organizationId, updatedAt: new Date() }).where(isNull(schema.aiGatewayModels.organizationId));
    });
  }
  process.stdout.write(`${JSON.stringify({
    mode,
    organizationId,
    status: mode === "apply" ? "applied" : "ready",
    providerConnections: plan.connections.length,
    deploymentProfiles: plan.profiles.length,
    gateways: plan.gateways.length,
    gatewayModels: plan.models.length,
  })}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Organization settings backfill failed."}\n`);
  process.exitCode = 1;
});
