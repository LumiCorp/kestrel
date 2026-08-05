import { and, eq, isNull, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "../lib/knowledge/db";

function parseArguments(argv: string[]) {
  const organizationFlag = argv.indexOf("--organization-id");
  const organizationId =
    organizationFlag >= 0 ? argv[organizationFlag + 1]?.trim() : "";
  const dryRun = argv.includes("--dry-run");
  const apply = argv.includes("--apply");
  const retireUnreferenced = argv.includes("--retire-unreferenced");
  if (!organizationId) throw new Error("--organization-id is required.");
  if (dryRun === apply)
    throw new Error("Choose exactly one of --dry-run or --apply.");
  return {
    organizationId,
    retireUnreferenced,
    mode: apply ? ("apply" as const) : ("dry-run" as const),
  };
}

type Assignment = { id: string; organizationId: string };
type InventoryDb = Pick<typeof knowledgeDb, "query" | "select">;

async function inventory(input: {
  organizationId: string;
  retireUnreferenced: boolean;
}, db: InventoryDb = knowledgeDb) {
  const organization = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, input.organizationId),
    columns: { id: true },
  });
  if (!organization) throw new Error("Target organization does not exist.");

  const [connections, profiles, gateways, models] = await Promise.all([
    db.query.aiProviderConnections.findMany({
      where: isNull(schema.aiProviderConnections.organizationId),
    }),
    db.query.aiDeploymentProfiles.findMany({
      where: isNull(schema.aiDeploymentProfiles.organizationId),
    }),
    db.query.aiGateways.findMany({
      where: isNull(schema.aiGateways.organizationId),
    }),
    db.query.aiGatewayModels.findMany({
      where: isNull(schema.aiGatewayModels.organizationId),
    }),
  ]);

  const conflicts: string[] = [];
  const connectionAssignments: Assignment[] = [];
  const profileAssignments: Assignment[] = [];
  const gatewayAssignments: Assignment[] = [];
  const modelAssignments: Assignment[] = [];
  const retiredConnectionIds: string[] = [];
  const retiredGatewayIds: string[] = [];

  for (const connection of connections) {
    const references = await db.query.aiGateways.findMany({
      where: eq(schema.aiGateways.providerConnectionId, connection.id),
      columns: { organizationId: true },
    });
    const owners = new Set(
      references.map((row) => row.organizationId).filter(Boolean) as string[],
    );
    if (owners.size > 1) {
      conflicts.push(
        `provider connection ${connection.id} is referenced by another organization`,
      );
      continue;
    }
    const owner = [...owners][0];
    if (!owner) {
      if (input.retireUnreferenced) retiredConnectionIds.push(connection.id);
      else
        conflicts.push(`provider connection ${connection.id} is unreferenced`);
      continue;
    }
    const destination = await db.query.aiProviderConnections.findFirst(
      {
        where: and(
          eq(schema.aiProviderConnections.organizationId, owner),
          eq(schema.aiProviderConnections.provider, connection.provider),
        ),
        columns: { id: true },
      },
    );
    if (destination && destination.id !== connection.id) {
      conflicts.push(
        `provider connection ${connection.id} conflicts with organization-owned connection ${destination.id}`,
      );
    } else {
      connectionAssignments.push({ id: connection.id, organizationId: owner });
    }
  }

  for (const profile of profiles) {
    const references = await db.query.aiDeployments.findMany({
      where: eq(schema.aiDeployments.profileId, profile.id),
      columns: { organizationId: true },
    });
    const owners = new Set(references.map((row) => row.organizationId));
    if (owners.size > 1) {
      conflicts.push(
        `deployment profile ${profile.id} is referenced by another organization`,
      );
      continue;
    }
    const owner = [...owners][0] ?? input.organizationId;
    const conflictingProfile =
      await db.query.aiDeploymentProfiles.findFirst({
        where: and(
          eq(schema.aiDeploymentProfiles.organizationId, owner),
          eq(schema.aiDeploymentProfiles.profileKey, profile.profileKey),
          eq(schema.aiDeploymentProfiles.version, profile.version),
        ),
        columns: { id: true },
      });
    if (conflictingProfile && conflictingProfile.id !== profile.id) {
      conflicts.push(
        `deployment profile ${profile.id} conflicts with organization-owned profile ${conflictingProfile.id}`,
      );
    } else {
      profileAssignments.push({ id: profile.id, organizationId: owner });
    }
  }

  for (const gateway of gateways) {
    const owners = new Set<string>();
    if (gateway.environmentId) {
      const environment = await db.query.environments.findFirst({
        where: eq(schema.environments.id, gateway.environmentId),
        columns: { organizationId: true },
      });
      if (environment) owners.add(environment.organizationId);
    }
    if (gateway.deploymentId) {
      const deployment = await db.query.aiDeployments.findFirst({
        where: eq(schema.aiDeployments.id, gateway.deploymentId),
        columns: { organizationId: true },
      });
      if (deployment) owners.add(deployment.organizationId);
    }
    if (owners.size > 1) {
      conflicts.push(
        `gateway ${gateway.id} is attached to another organization`,
      );
      continue;
    }
    const owner = [...owners][0];
    if (!owner) {
      const [defaultReference, grantReference] = await Promise.all([
        db
          .select({ id: schema.environmentAiModelDefaults.environmentId })
          .from(schema.environmentAiModelDefaults)
          .innerJoin(
            schema.aiGatewayModels,
            eq(
              schema.aiGatewayModels.id,
              schema.environmentAiModelDefaults.modelId,
            ),
          )
          .where(eq(schema.aiGatewayModels.gatewayId, gateway.id))
          .limit(1),
        db.query.environmentModelGrants.findFirst({
          where: eq(schema.environmentModelGrants.gatewayId, gateway.id),
          columns: { runId: true },
        }),
      ]);
      if (defaultReference[0] || grantReference) {
        conflicts.push(`gateway ${gateway.id} still has model references`);
      } else if (input.retireUnreferenced) {
        retiredGatewayIds.push(gateway.id);
      } else {
        conflicts.push(`gateway ${gateway.id} is unreferenced`);
      }
      continue;
    }
    const destination = await db.query.aiGateways.findFirst({
      where: and(
        eq(schema.aiGateways.organizationId, owner),
        eq(schema.aiGateways.provider, gateway.provider),
        eq(schema.aiGateways.displayName, gateway.displayName),
      ),
      columns: { id: true },
    });
    if (destination && destination.id !== gateway.id) {
      conflicts.push(
        `gateway ${gateway.id} conflicts with organization-owned gateway ${destination.id}`,
      );
    } else {
      gatewayAssignments.push({ id: gateway.id, organizationId: owner });
    }
  }

  const retiredGatewaySet = new Set(retiredGatewayIds);
  const gatewayOwner = new Map(
    gatewayAssignments.map((assignment) => [
      assignment.id,
      assignment.organizationId,
    ]),
  );
  for (const model of models) {
    if (retiredGatewaySet.has(model.gatewayId)) continue;
    const gateway = await db.query.aiGateways.findFirst({
      where: eq(schema.aiGateways.id, model.gatewayId),
      columns: { organizationId: true },
    });
    const owner = gatewayOwner.get(model.gatewayId) ?? gateway?.organizationId;
    if (!owner) {
      conflicts.push(`gateway model ${model.id} has no inferred organization`);
    } else {
      modelAssignments.push({ id: model.id, organizationId: owner });
    }
  }

  return {
    conflicts,
    connectionAssignments,
    profileAssignments,
    gatewayAssignments,
    modelAssignments,
    retiredConnectionIds,
    retiredGatewayIds,
  };
}

async function run() {
  const args = parseArguments(process.argv.slice(2));
  const plan =
    args.mode === "apply"
      ? await knowledgeDb.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('kestrel-one-organization-settings-backfill'))`,
          );
          await tx.execute(sql`
            LOCK TABLE
              "ai_provider_connections",
              "ai_deployment_profiles",
              "ai_gateways",
              "ai_gateway_models",
              "ai_deployments",
              "environment_ai_model_defaults",
              "environment_model_grants"
            IN SHARE ROW EXCLUSIVE MODE
          `);
          const lockedPlan = await inventory(args, tx);
          if (lockedPlan.conflicts.length > 0) return lockedPlan;
          for (const assignment of lockedPlan.connectionAssignments) {
            await tx
              .update(schema.aiProviderConnections)
              .set({
                organizationId: assignment.organizationId,
                updatedAt: new Date(),
              })
              .where(eq(schema.aiProviderConnections.id, assignment.id));
          }
          for (const assignment of lockedPlan.profileAssignments) {
            await tx
              .update(schema.aiDeploymentProfiles)
              .set({
                organizationId: assignment.organizationId,
                updatedAt: new Date(),
              })
              .where(eq(schema.aiDeploymentProfiles.id, assignment.id));
          }
          for (const assignment of lockedPlan.gatewayAssignments) {
            await tx
              .update(schema.aiGateways)
              .set({
                organizationId: assignment.organizationId,
                apiKeyEnvVar: null,
                updatedAt: new Date(),
              })
              .where(eq(schema.aiGateways.id, assignment.id));
          }
          for (const assignment of lockedPlan.modelAssignments) {
            await tx
              .update(schema.aiGatewayModels)
              .set({
                organizationId: assignment.organizationId,
                updatedAt: new Date(),
              })
              .where(eq(schema.aiGatewayModels.id, assignment.id));
          }
          for (const gatewayId of lockedPlan.retiredGatewayIds) {
            await tx
              .delete(schema.aiGateways)
              .where(eq(schema.aiGateways.id, gatewayId));
          }
          for (const connectionId of lockedPlan.retiredConnectionIds) {
            await tx
              .delete(schema.aiProviderConnections)
              .where(eq(schema.aiProviderConnections.id, connectionId));
          }
          return lockedPlan;
        })
      : await inventory(args);
  if (plan.conflicts.length > 0) {
    process.stderr.write(
      `${JSON.stringify({ ...args, status: "rejected", conflicts: plan.conflicts })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      ...args,
      status: args.mode === "apply" ? "applied" : "ready",
      providerConnectionsAssigned: plan.connectionAssignments.length,
      deploymentProfilesAssigned: plan.profileAssignments.length,
      gatewaysAssigned: plan.gatewayAssignments.length,
      gatewayModelsAssigned: plan.modelAssignments.length,
      providerConnectionsRetired: plan.retiredConnectionIds.length,
      gatewaysRetired: plan.retiredGatewayIds.length,
    })}\n`,
  );
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Organization settings backfill failed."}\n`,
  );
  process.exitCode = 1;
});
