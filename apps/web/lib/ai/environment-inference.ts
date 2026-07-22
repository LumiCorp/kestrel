import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  createGateway,
  listModelsForGateway,
  saveGatewayModel,
  syncGatewayModels,
  updateGateway,
  validateRunPodGatewayModel,
  validateRunPodGatewayModelByRawId,
} from "./gateways";
import { isManagedRunPodEnabled } from "./managed-runpod-config";
import {
  listManagedRunPodDeployments,
  listManagedRunPodProfiles,
  sanitizeManagedRunPodProfile,
} from "./managed-runpod-store";

async function requireOwnedEnvironment(input: {
  organizationId: string;
  environmentId: string;
}) {
  const environment = await getOrganizationEnvironment(input);
  if (!environment) {
    throw new Error("Environment not found.");
  }
  return environment;
}

function sanitizeEnvironmentGateway(
  gateway: typeof schema.aiGateways.$inferSelect
) {
  return {
    ...gateway,
    apiKey: null,
    hasApiKey: Boolean(gateway.apiKey?.trim()),
    metadata:
      gateway.metadata &&
      typeof gateway.metadata === "object" &&
      !Array.isArray(gateway.metadata)
        ? (gateway.metadata as Record<string, unknown>)
        : null,
  };
}

export async function getEnvironmentPrivateInference(input: {
  organizationId: string;
  environmentId: string;
}) {
  const environment = await requireOwnedEnvironment(input);
  const [policy, profiles, deployments, gateways, defaults] = await Promise.all(
    [
      knowledgeDb.query.organizationAiDeploymentPolicies.findFirst({
        where: eq(
          schema.organizationAiDeploymentPolicies.organizationId,
          input.organizationId
        ),
      }),
      listManagedRunPodProfiles({ organizationId: input.organizationId }),
      listManagedRunPodDeployments(input.organizationId, input.environmentId),
      knowledgeDb.query.aiGateways.findMany({
        where: and(
          eq(schema.aiGateways.organizationId, input.organizationId),
          eq(schema.aiGateways.environmentId, input.environmentId)
        ),
        orderBy: [asc(schema.aiGateways.displayName)],
      }),
      knowledgeDb.query.environmentAiModelDefaults.findMany({
        where: and(
          eq(
            schema.environmentAiModelDefaults.organizationId,
            input.organizationId
          ),
          eq(
            schema.environmentAiModelDefaults.environmentId,
            input.environmentId
          )
        ),
      }),
    ]
  );
  const models = (
    await Promise.all(
      gateways.map(async (gateway) =>
        (
          await listModelsForGateway(input.organizationId, gateway.id)
        ).map((model) => ({
          ...model,
          gatewayEnabled: gateway.enabled,
        }))
      )
    )
  ).flat();

  return {
    environment,
    managed: {
      available:
        isManagedRunPodEnabled() &&
        Boolean(policy?.enabled && policy.maxActiveDeployments > 0),
      policy: policy ?? {
        organizationId: input.organizationId,
        enabled: false,
        maxActiveDeployments: 0,
      },
      profiles: profiles.map(sanitizeManagedRunPodProfile),
      deployments,
    },
    connected: gateways
      .filter((gateway) => !gateway.deploymentId)
      .map(sanitizeEnvironmentGateway),
    models,
    defaults,
  };
}

export async function connectEnvironmentRunPodEndpoint(input: {
  organizationId: string;
  environmentId: string;
  displayName: string;
  endpointId: string;
  apiKey: string;
  servedModelId?: string;
  actorUserId: string;
}) {
  await requireOwnedEnvironment(input);
  const gateway = await createGateway({
    provider: "runpod",
    endpointId: input.endpointId,
    displayName: input.displayName,
    apiKey: input.apiKey,
    enabled: false,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    metadata: {
      managedBy: "environment",
      connectedByUserId: input.actorUserId,
    },
  });
  try {
    if (input.servedModelId?.trim()) {
      await validateAndEnableEnvironmentRunPodModelByRawId({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        gatewayId: gateway.id,
        rawModelId: input.servedModelId,
        actorUserId: input.actorUserId,
      });
      return getEnvironmentPrivateInference(input);
    }
    const synced = await syncGatewayModels(input.organizationId, gateway.id);
    const languageModels = synced.models.filter(
      (model) => model.modality === "language"
    );
    if (languageModels.length === 1) {
      await validateAndEnableEnvironmentRunPodModel({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        gatewayId: gateway.id,
        modelId: languageModels[0]!.id,
        actorUserId: input.actorUserId,
      });
    }
    return getEnvironmentPrivateInference(input);
  } catch (error) {
    const suppliedModelId = Boolean(input.servedModelId?.trim());
    await updateGateway(input.organizationId, gateway.id, {
      enabled: false,
      metadata: {
        managedBy: "environment",
        connectedByUserId: input.actorUserId,
        validationStatus: suppliedModelId
          ? "validation_failed"
          : "model_id_required",
        validationMessage: suppliedModelId
          ? error instanceof Error
            ? error.message
            : "The served model could not be validated."
          : "Model discovery is unavailable for this endpoint. Enter the served model ID to validate it directly.",
      },
    });
    return getEnvironmentPrivateInference(input);
  }
}

export async function validateAndEnableEnvironmentRunPodModelByRawId(input: {
  organizationId: string;
  environmentId: string;
  gatewayId: string;
  rawModelId: string;
  actorUserId: string;
}) {
  await requireOwnedEnvironment(input);
  const gateway = await knowledgeDb.query.aiGateways.findFirst({
    where: and(
      eq(schema.aiGateways.id, input.gatewayId),
      eq(schema.aiGateways.organizationId, input.organizationId),
      eq(schema.aiGateways.environmentId, input.environmentId),
      eq(schema.aiGateways.provider, "runpod"),
      isNull(schema.aiGateways.deploymentId)
    ),
  });
  if (!gateway) {
    throw new Error("Connected RunPod endpoint not found.");
  }
  let validation: Awaited<ReturnType<typeof validateRunPodGatewayModelByRawId>>;
  try {
    validation = await validateRunPodGatewayModelByRawId({
      organizationId: input.organizationId,
      gatewayId: gateway.id,
      rawModelId: input.rawModelId,
    });
  } catch (error) {
    await updateGateway(input.organizationId, gateway.id, {
      enabled: false,
      metadata: {
        ...(gateway.metadata as Record<string, unknown> | null),
        validationStatus: "validation_failed",
        validationMessage:
          error instanceof Error
            ? error.message
            : "The served model could not be validated.",
      },
    });
    throw error;
  }
  await updateGateway(input.organizationId, gateway.id, {
    enabled: true,
    metadata: {
      ...(gateway.metadata as Record<string, unknown> | null),
      validationStatus: "ready",
      validationMessage: null,
    },
  });
  await setEnvironmentDefaultModelIfMissing({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    modelId: validation.model.id,
    actorUserId: input.actorUserId,
  });
  return getEnvironmentPrivateInference(input);
}

export async function validateAndEnableEnvironmentRunPodModel(input: {
  organizationId: string;
  environmentId: string;
  gatewayId: string;
  modelId: string;
  actorUserId: string;
}) {
  await requireOwnedEnvironment(input);
  const gateway = await knowledgeDb.query.aiGateways.findFirst({
    where: and(
      eq(schema.aiGateways.id, input.gatewayId),
      eq(schema.aiGateways.organizationId, input.organizationId),
      eq(schema.aiGateways.environmentId, input.environmentId),
      eq(schema.aiGateways.provider, "runpod"),
      isNull(schema.aiGateways.deploymentId)
    ),
  });
  if (!gateway) {
    throw new Error("Connected RunPod endpoint not found.");
  }
  const validation = await validateRunPodGatewayModel({
    organizationId: input.organizationId,
    gatewayId: gateway.id,
    modelId: input.modelId,
  });
  const model = await saveGatewayModel({
    organizationId: input.organizationId,
    id: validation.model.id,
    gatewayId: gateway.id,
    rawModelId: validation.model.rawModelId,
    alias: validation.model.alias,
    modality: "language",
    approved: true,
    isDefault: false,
    description: validation.model.description,
    metadata: validation.model.metadata as Record<string, unknown> | null,
  });
  await updateGateway(input.organizationId, gateway.id, {
    enabled: true,
    metadata: {
      ...(gateway.metadata as Record<string, unknown> | null),
      validationStatus: "ready",
    },
  });
  await setEnvironmentDefaultModelIfMissing({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    modelId: model.id,
    actorUserId: input.actorUserId,
  });
  return getEnvironmentPrivateInference(input);
}

export async function resyncEnvironmentRunPodEndpoint(input: {
  organizationId: string;
  environmentId: string;
  gatewayId: string;
}) {
  await requireOwnedEnvironment(input);
  const gateway = await knowledgeDb.query.aiGateways.findFirst({
    where: and(
      eq(schema.aiGateways.id, input.gatewayId),
      eq(schema.aiGateways.organizationId, input.organizationId),
      eq(schema.aiGateways.environmentId, input.environmentId),
      eq(schema.aiGateways.provider, "runpod"),
      isNull(schema.aiGateways.deploymentId)
    ),
  });
  if (!gateway) {
    throw new Error("Connected RunPod endpoint not found.");
  }
  await syncGatewayModels(input.organizationId, gateway.id);
  await updateGateway(input.organizationId, gateway.id, {
    enabled: false,
    metadata: {
      ...(gateway.metadata &&
      typeof gateway.metadata === "object" &&
      !Array.isArray(gateway.metadata)
        ? gateway.metadata
        : {}),
      validationStatus: "discovered",
    },
  });
  return getEnvironmentPrivateInference(input);
}

export async function setEnvironmentDefaultModel(input: {
  organizationId: string;
  environmentId: string;
  modelId: string;
  actorUserId: string;
}) {
  await requireOwnedEnvironment(input);
  const [row] = await knowledgeDb
    .select({ model: schema.aiGatewayModels })
    .from(schema.aiGatewayModels)
    .innerJoin(
      schema.aiGateways,
      eq(schema.aiGateways.id, schema.aiGatewayModels.gatewayId)
    )
    .where(
      and(
        eq(schema.aiGatewayModels.id, input.modelId),
        eq(schema.aiGatewayModels.approved, true),
        eq(schema.aiGatewayModels.modality, "language"),
        eq(schema.aiGateways.enabled, true),
        eq(schema.aiGateways.organizationId, input.organizationId),
        eq(schema.aiGateways.environmentId, input.environmentId)
      )
    )
    .limit(1);
  if (!row) {
    throw new Error("Model is unavailable in this Environment.");
  }
  const [saved] = await knowledgeDb
    .insert(schema.environmentAiModelDefaults)
    .values({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      modality: "language",
      modelId: input.modelId,
      updatedByUserId: input.actorUserId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.environmentAiModelDefaults.environmentId,
        schema.environmentAiModelDefaults.modality,
      ],
      set: {
        modelId: input.modelId,
        updatedByUserId: input.actorUserId,
        updatedAt: new Date(),
      },
    })
    .returning();
  return saved;
}

async function setEnvironmentDefaultModelIfMissing(input: {
  organizationId: string;
  environmentId: string;
  modelId: string;
  actorUserId: string;
}) {
  const [saved] = await knowledgeDb
    .insert(schema.environmentAiModelDefaults)
    .values({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      modality: "language",
      modelId: input.modelId,
      updatedByUserId: input.actorUserId,
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  return saved ?? null;
}

export async function removeEnvironmentConnectedEndpoint(input: {
  organizationId: string;
  environmentId: string;
  gatewayId: string;
}) {
  await requireOwnedEnvironment(input);
  const [deleted] = await knowledgeDb
    .delete(schema.aiGateways)
    .where(
      and(
        eq(schema.aiGateways.id, input.gatewayId),
        eq(schema.aiGateways.organizationId, input.organizationId),
        eq(schema.aiGateways.environmentId, input.environmentId),
        isNull(schema.aiGateways.deploymentId)
      )
    )
    .returning({ id: schema.aiGateways.id });
  if (!deleted) {
    throw new Error("Connected RunPod endpoint not found.");
  }
  return deleted;
}
