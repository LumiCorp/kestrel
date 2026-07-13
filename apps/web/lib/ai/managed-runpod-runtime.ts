import "server-only";

import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { buildRunPodServerlessBaseUrl } from "./gateway-utils";
import {
  createGateway,
  listModelsForGateway,
  saveGatewayModel,
  syncGatewayModels,
  validateRunPodGatewayModel,
} from "./gateways";
import {
  createRunPodControlPlaneClient,
  resolveRunPodProviderApiKey,
} from "./managed-runpod-connection";
import {
  getManagedRunPodResourceName,
  parseManagedRunPodSpecSnapshot,
  runPodEndpointSpecSchema,
  runPodTemplateSpecSchema,
} from "./managed-runpod-contracts";
import {
  deleteManagedRunPodResources,
  ensureManagedRunPodResource,
} from "./managed-runpod-orchestration";
import { validateRunPodToolRoundTrip } from "./runpod-connection-test";
import { RunPodControlPlaneError } from "./runpod-control-plane";

class ManagedRunPodRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(input: { code: string; message: string; retryable?: boolean }) {
    super(input.message);
    this.name = "ManagedRunPodRuntimeError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
  }
}

function safeFailure(error: unknown) {
  if (error instanceof RunPodControlPlaneError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof ManagedRunPodRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "MANAGED_RUNPOD_OPERATION_FAILED",
    message: "Managed RunPod operation failed.",
    retryable: false,
  };
}

async function updateRun(
  runId: string,
  values: Partial<typeof schema.aiDeploymentRuns.$inferInsert>
) {
  await knowledgeDb
    .update(schema.aiDeploymentRuns)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.aiDeploymentRuns.id, runId));
}

async function ensureTemplate(input: {
  runId: string;
  name: string;
  imageRef: string;
  templateSpec: unknown;
  providerTemplateId: string | null;
}) {
  const { client } = await createRunPodControlPlaneClient();
  const templateId = await ensureManagedRunPodResource({
    knownResourceId: input.providerTemplateId,
    findExisting: async () =>
      (await client.listTemplates()).find(
        (template) => template.name === input.name
      ),
    create: () =>
      client.createTemplate({
        name: input.name,
        imageRef: input.imageRef,
        spec: runPodTemplateSpecSchema.parse(input.templateSpec),
      }),
    persistResourceId: (providerTemplateId) =>
      updateRun(input.runId, { providerTemplateId }),
  });
  return { client, templateId };
}

async function ensureEndpoint(input: {
  runId: string;
  name: string;
  templateId: string;
  endpointSpec: unknown;
  providerEndpointId: string | null;
}) {
  const { client } = await createRunPodControlPlaneClient();
  const endpointId = await ensureManagedRunPodResource({
    knownResourceId: input.providerEndpointId,
    findExisting: async () =>
      (await client.listEndpoints()).find(
        (endpoint) =>
          endpoint.name === input.name &&
          (endpoint.templateId === input.templateId ||
            endpoint.template?.id === input.templateId)
      ),
    create: () =>
      client.createEndpoint({
        name: input.name,
        templateId: input.templateId,
        spec: runPodEndpointSpecSchema.parse(input.endpointSpec),
      }),
    persistResourceId: (providerEndpointId) =>
      updateRun(input.runId, { providerEndpointId }),
  });
  return { client, endpointId };
}

async function assertExpectedModelAvailable(input: {
  endpointId: string;
  expectedModelId: string;
  apiKey: string;
}) {
  const baseUrl = buildRunPodServerlessBaseUrl(input.endpointId);
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new ManagedRunPodRuntimeError({
      code: "RUNPOD_MODEL_DISCOVERY_FAILED",
      message: `RunPod model discovery failed (${response.status}).`,
      retryable:
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500,
    });
  }
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  if (!body.data?.some((model) => model.id === input.expectedModelId)) {
    throw new ManagedRunPodRuntimeError({
      code: "RUNPOD_EXPECTED_MODEL_MISSING",
      message: "RunPod endpoint did not expose the deployment profile model.",
    });
  }
  return baseUrl;
}

async function cleanupProviderResources(input: {
  endpointId?: string | null;
  templateId?: string | null;
}) {
  const { client } = await createRunPodControlPlaneClient();
  await deleteManagedRunPodResources({
    ...input,
    deleteEndpoint: (endpointId) => client.deleteEndpoint(endpointId),
    deleteTemplate: (templateId) => client.deleteTemplate(templateId),
  });
}

async function processQualification(
  run: typeof schema.aiDeploymentRuns.$inferSelect,
  profile: typeof schema.aiDeploymentProfiles.$inferSelect
) {
  const name = getManagedRunPodResourceName({
    kind: "qualification",
    id: run.id,
  });
  let templateId = run.providerTemplateId;
  let endpointId = run.providerEndpointId;
  try {
    const template = await ensureTemplate({
      runId: run.id,
      name,
      imageRef: profile.imageRef,
      templateSpec: profile.templateSpec,
      providerTemplateId: templateId,
    });
    templateId = template.templateId;
    const endpoint = await ensureEndpoint({
      runId: run.id,
      name,
      templateId,
      endpointSpec: profile.endpointSpec,
      providerEndpointId: endpointId,
    });
    endpointId = endpoint.endpointId;
    const { connection, client } = await createRunPodControlPlaneClient();
    await client.getEndpoint(endpointId);
    const apiKey = resolveRunPodProviderApiKey(connection);
    const baseUrl = await assertExpectedModelAvailable({
      endpointId,
      expectedModelId: profile.expectedModelId,
      apiKey,
    });
    const validation = await validateRunPodToolRoundTrip({
      apiKey,
      baseUrl,
      model: profile.expectedModelId,
    });
    await cleanupProviderResources({ endpointId, templateId });
    await knowledgeDb.transaction(async (tx) => {
      await tx
        .update(schema.aiDeploymentProfiles)
        .set({
          status: "draft",
          qualificationEvidence: {
            ...validation,
            specHash: profile.specHash,
            imageRef: profile.imageRef,
          },
          qualifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.aiDeploymentProfiles.id, profile.id));
      await tx
        .update(schema.aiDeploymentRuns)
        .set({
          status: "succeeded",
          providerTemplateId: templateId,
          providerEndpointId: endpointId,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.aiDeploymentRuns.id, run.id));
    });
  } catch (error) {
    const failure = safeFailure(error);
    if (!failure.retryable) {
      await cleanupProviderResources({ endpointId, templateId }).catch(
        () => {}
      );
      await knowledgeDb
        .update(schema.aiDeploymentProfiles)
        .set({ status: "draft", updatedAt: new Date() })
        .where(eq(schema.aiDeploymentProfiles.id, profile.id));
    }
    throw error;
  }
}

async function ensureManagedGateway(input: {
  deployment: typeof schema.aiDeployments.$inferSelect;
  connectionId: string;
  endpointId: string;
  apiKey: string;
}) {
  if (input.deployment.gatewayId) {
    return input.deployment.gatewayId;
  }
  const existing = await knowledgeDb.query.aiGateways.findFirst({
    where: eq(schema.aiGateways.deploymentId, input.deployment.id),
    columns: { id: true },
  });
  if (existing) {
    await knowledgeDb
      .update(schema.aiDeployments)
      .set({ gatewayId: existing.id, updatedAt: new Date() })
      .where(eq(schema.aiDeployments.id, input.deployment.id));
    return existing.id;
  }
  const gateway = await createGateway({
    provider: "runpod",
    endpointId: input.endpointId,
    displayName: `RunPod · ${input.deployment.displayName} · ${input.deployment.id.slice(0, 8)}`,
    apiKey: input.apiKey,
    enabled: false,
    organizationId: input.deployment.organizationId,
    deploymentId: input.deployment.id,
    providerConnectionId: input.connectionId,
    metadata: { managedBy: "kestrel", deploymentId: input.deployment.id },
  });
  await knowledgeDb
    .update(schema.aiDeployments)
    .set({ gatewayId: gateway.id, updatedAt: new Date() })
    .where(eq(schema.aiDeployments.id, input.deployment.id));
  return gateway.id;
}

async function processProvision(
  run: typeof schema.aiDeploymentRuns.$inferSelect,
  deployment: typeof schema.aiDeployments.$inferSelect
) {
  const snapshot = parseManagedRunPodSpecSnapshot(deployment.specSnapshot);
  const name = getManagedRunPodResourceName({
    kind: "deployment",
    id: deployment.id,
  });
  await knowledgeDb
    .update(schema.aiDeployments)
    .set({ status: "provisioning_template", updatedAt: new Date() })
    .where(eq(schema.aiDeployments.id, deployment.id));
  const template = await ensureTemplate({
    runId: run.id,
    name,
    imageRef: snapshot.imageRef,
    templateSpec: snapshot.templateSpec,
    providerTemplateId: deployment.providerTemplateId ?? run.providerTemplateId,
  });
  await knowledgeDb
    .update(schema.aiDeployments)
    .set({
      status: "provisioning_endpoint",
      providerTemplateId: template.templateId,
      updatedAt: new Date(),
    })
    .where(eq(schema.aiDeployments.id, deployment.id));
  const endpoint = await ensureEndpoint({
    runId: run.id,
    name,
    templateId: template.templateId,
    endpointSpec: snapshot.endpointSpec,
    providerEndpointId: deployment.providerEndpointId ?? run.providerEndpointId,
  });
  const { connection, client } = await createRunPodControlPlaneClient();
  await client.getEndpoint(endpoint.endpointId);
  const apiKey = resolveRunPodProviderApiKey(connection);
  await knowledgeDb
    .update(schema.aiDeployments)
    .set({
      status: "waiting_for_capacity",
      providerEndpointId: endpoint.endpointId,
      updatedAt: new Date(),
    })
    .where(eq(schema.aiDeployments.id, deployment.id));
  const gatewayId = await ensureManagedGateway({
    deployment,
    connectionId: connection.id,
    endpointId: endpoint.endpointId,
    apiKey,
  });
  try {
    await syncGatewayModels(gatewayId);
  } catch {
    throw new ManagedRunPodRuntimeError({
      code: "RUNPOD_MODEL_SYNC_FAILED",
      message: "RunPod gateway model synchronization failed.",
      retryable: true,
    });
  }
  const models = await listModelsForGateway(gatewayId);
  const expected = models.find(
    (model) => model.rawModelId === snapshot.expectedModelId
  );
  if (!expected) {
    throw new ManagedRunPodRuntimeError({
      code: "RUNPOD_EXPECTED_MODEL_MISSING",
      message: "RunPod endpoint did not expose the deployment profile model.",
    });
  }
  await knowledgeDb
    .update(schema.aiDeployments)
    .set({ status: "validating", gatewayId, updatedAt: new Date() })
    .where(eq(schema.aiDeployments.id, deployment.id));
  await validateRunPodGatewayModel({ gatewayId, modelId: expected.id });
  await saveGatewayModel({
    id: expected.id,
    gatewayId,
    gatewayProvider: "runpod",
    gatewayBaseUrl: buildRunPodServerlessBaseUrl(endpoint.endpointId),
    rawModelId: expected.rawModelId,
    alias: expected.alias,
    modality: "language",
    approved: true,
    isDefault: true,
    description: expected.description,
    metadata: expected.metadata as Record<string, unknown> | null,
  });
  await knowledgeDb.transaction(async (tx) => {
    await tx
      .update(schema.aiGateways)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(schema.aiGateways.id, gatewayId));
    await tx
      .update(schema.aiDeployments)
      .set({
        status: "ready",
        providerTemplateId: template.templateId,
        providerEndpointId: endpoint.endpointId,
        gatewayId,
        failureCode: null,
        failureMessage: null,
        lastReconciledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.aiDeployments.id, deployment.id));
    await tx
      .update(schema.aiDeploymentRuns)
      .set({
        status: "succeeded",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.aiDeploymentRuns.id, run.id));
  });
}

async function processDelete(
  run: typeof schema.aiDeploymentRuns.$inferSelect,
  deployment: typeof schema.aiDeployments.$inferSelect
) {
  await cleanupProviderResources({
    endpointId: deployment.providerEndpointId ?? run.providerEndpointId,
    templateId: deployment.providerTemplateId ?? run.providerTemplateId,
  });
  await knowledgeDb.transaction(async (tx) => {
    if (deployment.gatewayId) {
      await tx
        .delete(schema.aiGateways)
        .where(eq(schema.aiGateways.id, deployment.gatewayId));
    }
    await tx
      .update(schema.aiDeployments)
      .set({
        status: "deleted",
        gatewayId: null,
        deletedAt: new Date(),
        failureCode: null,
        failureMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.aiDeployments.id, deployment.id));
    await tx
      .update(schema.aiDeploymentRuns)
      .set({
        status: "succeeded",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.aiDeploymentRuns.id, run.id));
  });
}

export async function processManagedRunPodRun(runId: string) {
  const [row] = await knowledgeDb
    .select({
      run: schema.aiDeploymentRuns,
      profile: schema.aiDeploymentProfiles,
      deployment: schema.aiDeployments,
    })
    .from(schema.aiDeploymentRuns)
    .innerJoin(
      schema.aiDeploymentProfiles,
      eq(schema.aiDeploymentProfiles.id, schema.aiDeploymentRuns.profileId)
    )
    .leftJoin(
      schema.aiDeployments,
      eq(schema.aiDeployments.id, schema.aiDeploymentRuns.deploymentId)
    )
    .where(eq(schema.aiDeploymentRuns.id, runId))
    .limit(1);
  if (!row || row.run.status === "succeeded") {
    return;
  }
  await updateRun(runId, {
    status: "running",
    attempt: row.run.attempt + 1,
    startedAt: row.run.startedAt ?? new Date(),
  });
  try {
    if (row.run.kind === "qualification") {
      await processQualification(row.run, row.profile);
      return;
    }
    if (!row.deployment) {
      throw new Error(
        "Managed RunPod deployment run is missing its deployment."
      );
    }
    if (row.run.kind === "delete") {
      await processDelete(row.run, row.deployment);
      return;
    }
    await processProvision(row.run, row.deployment);
  } catch (error) {
    const failure = safeFailure(error);
    const deadlineExpired = Boolean(
      row.deployment?.reconciliationDeadline &&
        row.deployment.reconciliationDeadline.getTime() <= Date.now()
    );
    if (!failure.retryable || deadlineExpired || row.run.attempt + 1 >= 20) {
      if (row.run.kind === "qualification") {
        const latestRun = await knowledgeDb.query.aiDeploymentRuns.findFirst({
          where: eq(schema.aiDeploymentRuns.id, runId),
        });
        await cleanupProviderResources({
          endpointId: latestRun?.providerEndpointId,
          templateId: latestRun?.providerTemplateId,
        }).catch(() => {});
        await knowledgeDb
          .update(schema.aiDeploymentProfiles)
          .set({ status: "draft", updatedAt: new Date() })
          .where(eq(schema.aiDeploymentProfiles.id, row.profile.id));
      }
      await updateRun(runId, {
        status: "failed",
        errorCode: failure.code,
        errorMessage: failure.message,
        completedAt: new Date(),
      });
      if (row.deployment) {
        await knowledgeDb
          .update(schema.aiDeployments)
          .set({
            status: row.run.kind === "delete" ? "delete_failed" : "failed",
            failureCode: failure.code,
            failureMessage: failure.message,
            updatedAt: new Date(),
          })
          .where(eq(schema.aiDeployments.id, row.deployment.id));
      }
      return;
    }
    throw error;
  }
}

export async function reconcileManagedRunPodFleet() {
  const { client } = await createRunPodControlPlaneClient();
  const providerEndpoints = new Set(
    (await client.listEndpoints()).map((row) => row.id)
  );
  const deployments = await knowledgeDb.query.aiDeployments.findMany({
    where: and(
      ne(schema.aiDeployments.status, "deleted"),
      isNotNull(schema.aiDeployments.providerEndpointId)
    ),
  });
  for (const deployment of deployments) {
    if (
      deployment.providerEndpointId &&
      !providerEndpoints.has(deployment.providerEndpointId)
    ) {
      await knowledgeDb.transaction(async (tx) => {
        if (deployment.gatewayId) {
          await tx
            .update(schema.aiGateways)
            .set({ enabled: false, updatedAt: new Date() })
            .where(eq(schema.aiGateways.id, deployment.gatewayId));
        }
        await tx
          .update(schema.aiDeployments)
          .set({
            status: deployment.status === "deleting" ? "deleted" : "failed",
            failureCode: "RUNPOD_ENDPOINT_DRIFT",
            failureMessage: "The managed RunPod endpoint no longer exists.",
            lastReconciledAt: new Date(),
            ...(deployment.status === "deleting"
              ? { deletedAt: new Date() }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.aiDeployments.id, deployment.id));
      });
    } else {
      await knowledgeDb
        .update(schema.aiDeployments)
        .set({ lastReconciledAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.aiDeployments.id, deployment.id));
    }
  }
}

export async function ingestManagedRunPodUsage(now = new Date()) {
  const { client } = await createRunPodControlPlaneClient();
  const records = await client.listBilling({
    startTime: new Date(now.getTime() - 25 * 60 * 60 * 1000),
    endTime: now,
  });
  const endpoints = Array.from(
    new Set(records.map((record) => record.endpointId))
  );
  if (endpoints.length === 0) {
    return 0;
  }
  const deployments = await knowledgeDb.query.aiDeployments.findMany({
    where: inArray(schema.aiDeployments.providerEndpointId, endpoints),
  });
  const byEndpoint = new Map(
    deployments.map((deployment) => [deployment.providerEndpointId, deployment])
  );
  let stored = 0;
  for (const record of records) {
    const deployment = byEndpoint.get(record.endpointId);
    if (!deployment) {
      continue;
    }
    await knowledgeDb
      .insert(schema.aiDeploymentUsage)
      .values({
        id: crypto.randomUUID(),
        deploymentId: deployment.id,
        providerEndpointId: record.endpointId,
        bucketStartedAt: new Date(record.time),
        amountUsd: record.amount,
        timeBilledMs: record.timeBilledMs,
        diskSpaceBilledGb: record.diskSpaceBilledGb,
        gpuTypeId: record.gpuTypeId ?? null,
      })
      .onConflictDoUpdate({
        target: [
          schema.aiDeploymentUsage.deploymentId,
          schema.aiDeploymentUsage.bucketStartedAt,
          schema.aiDeploymentUsage.gpuTypeId,
        ],
        set: {
          amountUsd: record.amount,
          timeBilledMs: record.timeBilledMs,
          diskSpaceBilledGb: record.diskSpaceBilledGb,
          updatedAt: new Date(),
        },
      });
    stored += 1;
  }
  return stored;
}
