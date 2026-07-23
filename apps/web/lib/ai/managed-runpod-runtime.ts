import "server-only";

import { and, eq, inArray, isNotNull, ne, notInArray } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { meterRunPodUsage } from "@/lib/costs/metering";
import { buildRunPodServerlessBaseUrl } from "./gateway-utils";
import { createGateway, validateRunPodGatewayModelByRawId } from "./gateways";
import {
  createRunPodControlPlaneClient,
  listEnabledRunPodProviderConnections,
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
  isManagedRunPodDeletionStatus,
} from "./managed-runpod-orchestration";
import {
  isRunPodConnectionTestError,
  validateRunPodToolRoundTrip,
} from "./runpod-connection-test";
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

const PROVISION_CANCELLED_CODE = "MANAGED_RUNPOD_PROVISION_CANCELLED";
const DELETE_LIFECYCLE_STATUSES = [
  "deleting",
  "delete_failed",
  "deleted",
] as const;

function provisionCancelledError() {
  return new ManagedRunPodRuntimeError({
    code: PROVISION_CANCELLED_CODE,
    message: "Managed RunPod provisioning was cancelled by deletion.",
  });
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
  if (isRunPodConnectionTestError(error)) {
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

async function updateProvisioningDeployment(
  deploymentId: string,
  values: Partial<typeof schema.aiDeployments.$inferInsert>
) {
  const [updated] = await knowledgeDb
    .update(schema.aiDeployments)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(schema.aiDeployments.id, deploymentId),
        notInArray(schema.aiDeployments.status, [...DELETE_LIFECYCLE_STATUSES])
      )
    )
    .returning({ id: schema.aiDeployments.id });
  if (!updated) {
    throw provisionCancelledError();
  }
}

async function ensureTemplate(input: {
  organizationId: string;
  runId: string;
  name: string;
  imageRef: string;
  templateSpec: unknown;
  providerTemplateId: string | null;
}) {
  const { client } = await createRunPodControlPlaneClient({
    organizationId: input.organizationId,
  });
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
  organizationId: string;
  runId: string;
  name: string;
  templateId: string;
  endpointSpec: unknown;
  providerEndpointId: string | null;
}) {
  const { client } = await createRunPodControlPlaneClient({
    organizationId: input.organizationId,
  });
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

async function cleanupProviderResources(input: {
  organizationId: string;
  endpointId?: string | null;
  templateId?: string | null;
}) {
  const { client } = await createRunPodControlPlaneClient({
    organizationId: input.organizationId,
  });
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
  if (!profile.organizationId) {
    throw new Error("Managed RunPod profile organization is required.");
  }
  const name = getManagedRunPodResourceName({
    kind: "qualification",
    id: run.id,
  });
  let templateId = run.providerTemplateId;
  let endpointId = run.providerEndpointId;
  try {
    const template = await ensureTemplate({
      organizationId: profile.organizationId,
      runId: run.id,
      name,
      imageRef: profile.imageRef,
      templateSpec: profile.templateSpec,
      providerTemplateId: templateId,
    });
    templateId = template.templateId;
    const endpoint = await ensureEndpoint({
      organizationId: profile.organizationId,
      runId: run.id,
      name,
      templateId,
      endpointSpec: {
        ...runPodEndpointSpecSchema.parse(profile.endpointSpec),
        // Qualification is short-lived and cleaned up immediately. Keeping one
        // worker warm prevents timed-out probes from accumulating in RunPod's
        // queue while the qualified deployment profile remains scale-to-zero.
        workersMin: 1,
      },
      providerEndpointId: endpointId,
    });
    endpointId = endpoint.endpointId;
    const { connection, client } = await createRunPodControlPlaneClient({
      organizationId: profile.organizationId,
    });
    await client.getEndpoint(endpointId);
    const apiKey = resolveRunPodProviderApiKey(connection);
    const validation = await validateRunPodToolRoundTrip({
      apiKey,
      baseUrl: buildRunPodServerlessBaseUrl(endpointId),
      model: profile.expectedModelId,
      timeoutMs: runPodEndpointSpecSchema.parse(profile.endpointSpec)
        .executionTimeoutMs,
    });
    await cleanupProviderResources({
      organizationId: profile.organizationId,
      endpointId,
      templateId,
    });
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
      await cleanupProviderResources({
        organizationId: profile.organizationId,
        endpointId,
        templateId,
      }).catch(
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
    await updateProvisioningDeployment(input.deployment.id, {
      gatewayId: input.deployment.gatewayId,
    });
    return input.deployment.gatewayId;
  }
  const existing = await knowledgeDb.query.aiGateways.findFirst({
    where: eq(schema.aiGateways.deploymentId, input.deployment.id),
    columns: { id: true },
  });
  if (existing) {
    await updateProvisioningDeployment(input.deployment.id, {
      gatewayId: existing.id,
    });
    return existing.id;
  }
  const gateway = await createGateway({
    provider: "runpod",
    endpointId: input.endpointId,
    displayName: `RunPod · ${input.deployment.displayName} · ${input.deployment.id.slice(0, 8)}`,
    apiKey: input.apiKey,
    enabled: false,
    organizationId: input.deployment.organizationId,
    environmentId: input.deployment.environmentId,
    deploymentId: input.deployment.id,
    providerConnectionId: input.connectionId,
    metadata: { managedBy: "kestrel", deploymentId: input.deployment.id },
  });
  await updateProvisioningDeployment(input.deployment.id, {
    gatewayId: gateway.id,
  });
  return gateway.id;
}

async function settleCancelledProvision(input: {
  runId: string;
  deploymentId: string;
}) {
  const [latestRun, latestDeployment] = await Promise.all([
    knowledgeDb.query.aiDeploymentRuns.findFirst({
      where: eq(schema.aiDeploymentRuns.id, input.runId),
    }),
    knowledgeDb.query.aiDeployments.findFirst({
      where: eq(schema.aiDeployments.id, input.deploymentId),
    }),
  ]);
  let cleanupFailure: ReturnType<typeof safeFailure> | null = null;
  const endpointId =
    latestDeployment?.providerEndpointId ?? latestRun?.providerEndpointId;
  const templateId =
    latestDeployment?.providerTemplateId ?? latestRun?.providerTemplateId;
  if (endpointId || templateId) {
    if (!latestDeployment?.organizationId) {
      throw new Error("Managed RunPod deployment organization is required.");
    }
    try {
      await cleanupProviderResources({
        organizationId: latestDeployment.organizationId,
        endpointId,
        templateId,
      });
    } catch (error) {
      cleanupFailure = safeFailure(error);
    }
  }
  await knowledgeDb.transaction(async (tx) => {
    const [currentDeployment] = await tx
      .select({ status: schema.aiDeployments.status })
      .from(schema.aiDeployments)
      .where(eq(schema.aiDeployments.id, input.deploymentId))
      .limit(1)
      .for("update");
    await tx
      .delete(schema.aiGateways)
      .where(eq(schema.aiGateways.deploymentId, input.deploymentId));
    await tx
      .update(schema.aiDeployments)
      .set({
        gatewayId: null,
        ...(cleanupFailure &&
        currentDeployment &&
        isManagedRunPodDeletionStatus(currentDeployment.status)
          ? {
              status: "delete_failed" as const,
              deletedAt: null,
              failureCode: cleanupFailure.code,
              failureMessage: cleanupFailure.message,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.aiDeployments.id, input.deploymentId));
    await tx
      .update(schema.aiDeploymentRuns)
      .set({
        status: "failed",
        errorCode: PROVISION_CANCELLED_CODE,
        errorMessage: "Managed RunPod provisioning was cancelled by deletion.",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.aiDeploymentRuns.id, input.runId));
  });
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
  await updateProvisioningDeployment(deployment.id, {
    status: "provisioning_template",
  });
  const template = await ensureTemplate({
    organizationId: deployment.organizationId,
    runId: run.id,
    name,
    imageRef: snapshot.imageRef,
    templateSpec: snapshot.templateSpec,
    providerTemplateId: deployment.providerTemplateId ?? run.providerTemplateId,
  });
  await updateProvisioningDeployment(deployment.id, {
    status: "provisioning_endpoint",
    providerTemplateId: template.templateId,
  });
  const endpoint = await ensureEndpoint({
    organizationId: deployment.organizationId,
    runId: run.id,
    name,
    templateId: template.templateId,
    endpointSpec: snapshot.endpointSpec,
    providerEndpointId: deployment.providerEndpointId ?? run.providerEndpointId,
  });
  const { connection, client } = await createRunPodControlPlaneClient({
    organizationId: deployment.organizationId,
  });
  await client.getEndpoint(endpoint.endpointId);
  const apiKey = resolveRunPodProviderApiKey(connection);
  await updateProvisioningDeployment(deployment.id, {
    status: "waiting_for_capacity",
    providerEndpointId: endpoint.endpointId,
  });
  const gatewayId = await ensureManagedGateway({
    deployment,
    connectionId: connection.id,
    endpointId: endpoint.endpointId,
    apiKey,
  });
  await updateProvisioningDeployment(deployment.id, {
    status: "validating",
    gatewayId,
  });
  const validation = await validateRunPodGatewayModelByRawId({
    organizationId: deployment.organizationId,
    gatewayId,
    rawModelId: snapshot.expectedModelId,
    isDefault: true,
    timeoutMs: snapshot.endpointSpec.executionTimeoutMs,
  });
  await knowledgeDb.transaction(async (tx) => {
    const [updatedDeployment] = await tx
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
      .where(
        and(
          eq(schema.aiDeployments.id, deployment.id),
          notInArray(schema.aiDeployments.status, [
            ...DELETE_LIFECYCLE_STATUSES,
          ])
        )
      )
      .returning({ id: schema.aiDeployments.id });
    if (!updatedDeployment) {
      throw provisionCancelledError();
    }
    await tx
      .update(schema.aiGateways)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(schema.aiGateways.id, gatewayId));
    await tx
      .insert(schema.environmentAiModelDefaults)
      .values({
        organizationId: deployment.organizationId,
        environmentId: deployment.environmentId,
        modality: "language",
        modelId: validation.model.id,
        updatedByUserId: deployment.createdByUserId,
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
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
    organizationId: deployment.organizationId,
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
    if (row.run.kind === "provision" && row.deployment) {
      const latestDeployment = await knowledgeDb.query.aiDeployments.findFirst({
        where: eq(schema.aiDeployments.id, row.deployment.id),
        columns: { status: true },
      });
      if (
        failure.code === PROVISION_CANCELLED_CODE ||
        (latestDeployment &&
          isManagedRunPodDeletionStatus(latestDeployment.status))
      ) {
        await settleCancelledProvision({
          runId,
          deploymentId: row.deployment.id,
        });
        return;
      }
    }
    const deadlineExpired = Boolean(
      row.deployment?.reconciliationDeadline &&
        row.deployment.reconciliationDeadline.getTime() <= Date.now()
    );
    if (!failure.retryable || deadlineExpired || row.run.attempt + 1 >= 20) {
      if (row.run.kind === "qualification") {
        const latestRun = await knowledgeDb.query.aiDeploymentRuns.findFirst({
          where: eq(schema.aiDeploymentRuns.id, runId),
        });
        if (row.profile.organizationId) {
          await cleanupProviderResources({
            organizationId: row.profile.organizationId,
            endpointId: latestRun?.providerEndpointId,
            templateId: latestRun?.providerTemplateId,
          }).catch(() => {});
        }
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
  const connections = await listEnabledRunPodProviderConnections();
  for (const connection of connections) {
    if (!connection.organizationId) continue;
    const { client } = await createRunPodControlPlaneClient({
      organizationId: connection.organizationId,
    });
    const providerEndpoints = new Set(
      (await client.listEndpoints()).map((row) => row.id)
    );
    const deployments = await knowledgeDb.query.aiDeployments.findMany({
      where: and(
        eq(schema.aiDeployments.organizationId, connection.organizationId),
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
            .set(
              isManagedRunPodDeletionStatus(deployment.status)
                ? { lastReconciledAt: new Date(), updatedAt: new Date() }
                : {
                    status: "failed",
                    failureCode: "RUNPOD_ENDPOINT_DRIFT",
                    failureMessage:
                      "The managed RunPod endpoint no longer exists.",
                    lastReconciledAt: new Date(),
                    updatedAt: new Date(),
                  }
            )
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
}

export async function ingestManagedRunPodUsage(now = new Date()) {
  let stored = 0;
  const connections = await listEnabledRunPodProviderConnections();
  for (const connection of connections) {
    if (!connection.organizationId) continue;
    const { client } = await createRunPodControlPlaneClient({
      organizationId: connection.organizationId,
    });
    const records = await client.listBilling({
      startTime: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      endTime: now,
    });
    const endpoints = Array.from(
      new Set(records.map((record) => record.endpointId))
    );
    if (endpoints.length === 0) continue;
    const deployments = await knowledgeDb.query.aiDeployments.findMany({
      where: and(
        eq(schema.aiDeployments.organizationId, connection.organizationId),
        inArray(schema.aiDeployments.providerEndpointId, endpoints)
      ),
    });
    const byEndpoint = new Map(
      deployments.map((deployment) => [deployment.providerEndpointId, deployment])
    );
    for (const record of records) {
      const deployment = byEndpoint.get(record.endpointId);
      if (!deployment) continue;
      const [usage] = await knowledgeDb
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
        })
        .returning();
      if (usage) await meterRunPodUsage({ usage, deployment });
      stored += 1;
    }
  }
  return stored;
}
