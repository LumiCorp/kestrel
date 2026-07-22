import "server-only";

import { and, eq, isNull, notInArray } from "drizzle-orm";
import { getResolvedKestrelRuntimeExecutionModel } from "@/lib/ai/gateways";
import { getHostedEnvironmentsRollout } from "@/lib/environments/config";
import { getFlyProviderConnection } from "@/lib/environments/fly-connection";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { isPersonalOrganizationSlug } from "@/lib/personal-workspace-shared";

export type OrganizationSetupNextStep =
  | "model_access"
  | "workspace_compute"
  | "environment_execution"
  | null;

export type OrganizationReadinessCheck = {
  ready: boolean;
  status: string;
  detail: string;
};

export type OrganizationChatReadiness = {
  applicable: boolean;
  ready: boolean;
  nextStep: OrganizationSetupNextStep;
  modelAccess: OrganizationReadinessCheck & {
    gatewayId: string | null;
    gatewayName: string | null;
    modelId: string | null;
    modelName: string | null;
  };
  workspaceCompute: OrganizationReadinessCheck & {
    enabled: boolean;
    hasApiToken: boolean;
    organizationSlug: string;
    lastTestedAt: string | null;
  };
  environmentExecution: OrganizationReadinessCheck & {
    deploymentEnabled: boolean;
    organizationEnabled: boolean;
    environmentId: string | null;
    environmentName: string | null;
    environmentStatus: string | null;
    operationId: string | null;
    operationStatus: string | null;
    operationStage: string | null;
    failureMessage: string | null;
  };
};

export type OrganizationChatReadinessInput = {
  personal: boolean;
  model: {
    gatewayId: string;
    gatewayName: string;
    modelId: string;
    modelName: string;
    hasRequiredCredential: boolean;
  } | null;
  fly: {
    enabled: boolean;
    hasApiToken: boolean;
    organizationSlug: string;
    status: string;
    lastTestedAt: Date | string | null;
  } | null;
  rollout: {
    deploymentEnabled: boolean;
    organizationEnabled: boolean;
    effectiveEnabled: boolean;
  };
  environment: {
    id: string;
    name: string;
    status: string;
    failureMessage: string | null;
  } | null;
  operation: {
    id: string;
    status: string;
    stage: string;
    errorMessage: string | null;
  } | null;
};

function notApplicableCheck(): OrganizationReadinessCheck {
  return {
    ready: true,
    status: "not_applicable",
    detail: "Personal workspaces do not require organization setup.",
  };
}

export function deriveOrganizationChatReadiness(
  input: OrganizationChatReadinessInput
): OrganizationChatReadiness {
  if (input.personal) {
    const check = notApplicableCheck();
    return {
      applicable: false,
      ready: true,
      nextStep: null,
      modelAccess: {
        ...check,
        gatewayId: null,
        gatewayName: null,
        modelId: null,
        modelName: null,
      },
      workspaceCompute: {
        ...check,
        enabled: false,
        hasApiToken: false,
        organizationSlug: "",
        lastTestedAt: null,
      },
      environmentExecution: {
        ...check,
        deploymentEnabled: input.rollout.deploymentEnabled,
        organizationEnabled: input.rollout.organizationEnabled,
        environmentId: input.environment?.id ?? null,
        environmentName: input.environment?.name ?? null,
        environmentStatus: input.environment?.status ?? null,
        operationId: input.operation?.id ?? null,
        operationStatus: input.operation?.status ?? null,
        operationStage: input.operation?.stage ?? null,
        failureMessage: null,
      },
    };
  }

  const modelAccess: OrganizationChatReadiness["modelAccess"] = input.model
    ? input.model.hasRequiredCredential
      ? {
          ready: true,
          status: "ready",
          detail: `${input.model.modelName} is approved and set as default.`,
          gatewayId: input.model.gatewayId,
          gatewayName: input.model.gatewayName,
          modelId: input.model.modelId,
          modelName: input.model.modelName,
        }
      : {
          ready: false,
          status: "missing_credential",
          detail: "The default model provider is missing its stored credential.",
          gatewayId: input.model.gatewayId,
          gatewayName: input.model.gatewayName,
          modelId: input.model.modelId,
          modelName: input.model.modelName,
        }
    : {
        ready: false,
        status: "missing_default_model",
        detail: "Select an approved default language model.",
        gatewayId: null,
        gatewayName: null,
        modelId: null,
        modelName: null,
      };

  let workspaceStatus = "missing_connection";
  let workspaceDetail = "Connect and verify a Fly workspace provider.";
  if (input.fly) {
    if (!input.fly.enabled) {
      workspaceStatus = "disabled";
      workspaceDetail = "The Fly workspace provider is disabled.";
    } else if (!(input.fly.hasApiToken && input.fly.organizationSlug.trim())) {
      workspaceStatus = "missing_credential";
      workspaceDetail = "Fly requires an organization slug and stored API token.";
    } else if (input.fly.status === "degraded") {
      workspaceStatus = "degraded";
      workspaceDetail = "The last Fly connection test failed.";
    } else if (input.fly.status !== "ready") {
      workspaceStatus = "untested";
      workspaceDetail = "Test the Fly connection before provisioning.";
    } else {
      workspaceStatus = "ready";
      workspaceDetail = "Fly credentials are stored and verified.";
    }
  }
  const workspaceCompute: OrganizationChatReadiness["workspaceCompute"] = {
    ready: workspaceStatus === "ready",
    status: workspaceStatus,
    detail: workspaceDetail,
    enabled: input.fly?.enabled ?? false,
    hasApiToken: input.fly?.hasApiToken ?? false,
    organizationSlug: input.fly?.organizationSlug ?? "",
    lastTestedAt: input.fly?.lastTestedAt
      ? new Date(input.fly.lastTestedAt).toISOString()
      : null,
  };

  let executionStatus = input.environment?.status ?? "missing_environment";
  let executionDetail = "The default Environment is not available.";
  if (!input.rollout.deploymentEnabled) {
    executionStatus = "deployment_disabled";
    executionDetail = "Hosted execution is disabled for this deployment.";
  } else if (!input.rollout.organizationEnabled) {
    executionStatus = "rollout_disabled";
    executionDetail = "Enable Environment execution for this organization.";
  } else if (input.environment?.status === "ready") {
    executionStatus = "ready";
    executionDetail = "The default Environment is ready for agent turns.";
  } else if (
    input.operation?.status === "queued" ||
    input.operation?.status === "running" ||
    input.environment?.status === "requested" ||
    input.environment?.status === "provisioning"
  ) {
    executionStatus = "provisioning";
    executionDetail = "The default Environment is being provisioned.";
  } else if (input.environment?.status === "failed") {
    executionStatus = "failed";
    executionDetail =
      input.environment.failureMessage ||
      input.operation?.errorMessage ||
      "Default Environment provisioning failed safely.";
  } else if (input.environment?.status === "degraded") {
    executionStatus = "degraded";
    executionDetail =
      input.environment.failureMessage ||
      "The default Environment needs attention in Environment operations.";
  }
  const environmentExecution: OrganizationChatReadiness["environmentExecution"] = {
    ready: input.rollout.effectiveEnabled && input.environment?.status === "ready",
    status: executionStatus,
    detail: executionDetail,
    deploymentEnabled: input.rollout.deploymentEnabled,
    organizationEnabled: input.rollout.organizationEnabled,
    environmentId: input.environment?.id ?? null,
    environmentName: input.environment?.name ?? null,
    environmentStatus: input.environment?.status ?? null,
    operationId: input.operation?.id ?? null,
    operationStatus: input.operation?.status ?? null,
    operationStage: input.operation?.stage ?? null,
    failureMessage:
      input.environment?.failureMessage ?? input.operation?.errorMessage ?? null,
  };

  const nextStep: OrganizationSetupNextStep = modelAccess.ready
    ? workspaceCompute.ready
      ? environmentExecution.ready
        ? null : "environment_execution" : "workspace_compute" : "model_access";

  return {
    applicable: true,
    ready: nextStep === null,
    nextStep,
    modelAccess,
    workspaceCompute,
    environmentExecution,
  };
}

export async function getOrganizationChatReadiness(
  organizationId: string
): Promise<OrganizationChatReadiness> {
  const [organization, environment, rollout, fly] = await Promise.all([
    knowledgeDb.query.organizations.findFirst({
      where: eq(schema.organizations.id, organizationId),
      columns: { slug: true },
    }),
    knowledgeDb.query.environments.findFirst({
      where: and(
        eq(schema.environments.organizationId, organizationId),
        eq(schema.environments.isDefault, true),
        isNull(schema.environments.archivedAt),
        notInArray(schema.environments.status, ["deleting", "deleted"])
      ),
      columns: {
        id: true,
        name: true,
        status: true,
        failureMessage: true,
      },
    }),
    getHostedEnvironmentsRollout({ organizationId }),
    getFlyProviderConnection(organizationId),
  ]);

  const [resolvedModel, operation] = await Promise.all([
    getResolvedKestrelRuntimeExecutionModel({
      organizationId,
      environmentId: environment?.id,
    }),
    environment
      ? knowledgeDb.query.environmentOperations.findFirst({
          where: and(
            eq(schema.environmentOperations.organizationId, organizationId),
            eq(schema.environmentOperations.environmentId, environment.id),
            eq(schema.environmentOperations.type, "environment.provision")
          ),
          orderBy: (table, { desc }) => [desc(table.createdAt)],
          columns: {
            id: true,
            status: true,
            stage: true,
            errorMessage: true,
          },
        })
      : Promise.resolve(undefined),
  ]);

  let providerConnectionHasCredential = false;
  if (resolvedModel?.gateway.providerConnectionId) {
    const providerConnection =
      await knowledgeDb.query.aiProviderConnections.findFirst({
        where: and(
          eq(
            schema.aiProviderConnections.id,
            resolvedModel.gateway.providerConnectionId
          ),
          eq(schema.aiProviderConnections.organizationId, organizationId)
        ),
        columns: { apiKey: true, enabled: true },
      });
    providerConnectionHasCredential = Boolean(
      providerConnection?.enabled && providerConnection.apiKey?.trim()
    );
  }

  const flyMetadata = (fly?.metadata ?? {}) as { organizationSlug?: string };
  return deriveOrganizationChatReadiness({
    personal: isPersonalOrganizationSlug(organization?.slug),
    model: resolvedModel
      ? {
          gatewayId: resolvedModel.gateway.id,
          gatewayName: resolvedModel.gateway.displayName,
          modelId: resolvedModel.model.gatewayModelId,
          modelName: resolvedModel.model.name,
          hasRequiredCredential:
            resolvedModel.gateway.provider === "ollama" ||
            Boolean(resolvedModel.gateway.apiKey?.trim()) ||
            providerConnectionHasCredential,
        }
      : null,
    fly: fly
      ? {
          enabled: fly.enabled,
          hasApiToken: Boolean(fly.apiKey?.trim()),
          organizationSlug: flyMetadata.organizationSlug ?? "",
          status: fly.status,
          lastTestedAt: fly.lastTestedAt,
        }
      : null,
    rollout,
    environment: environment ?? null,
    operation: operation ?? null,
  });
}
