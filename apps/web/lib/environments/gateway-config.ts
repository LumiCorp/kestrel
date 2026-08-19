import type {
  EnvironmentGatewayConfig,
  EnvironmentGatewayConfigV3,
} from "@lumi/kestrel-environment-auth";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  serializeEnvironmentGatewayConfig,
  serializeLegacyEnvironmentGatewayConfig,
  signEnvironmentExecutionTicket,
  PREVIEW_RELAY_TICKET_AUDIENCE,
  PREVIEW_RELAY_TICKET_VERSION,
  PREVIEW_RELAY_TICKET_V3_VERSION,
  signPreviewRelayTicket,
} from "@lumi/kestrel-environment-auth";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { issueGatewayCredentialLease } from "@/lib/ai/gateway-credential-lease";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { verifyEnvironmentServiceToken } from "./service-tokens";
import { ENVIRONMENT_EXECUTION_ROUTE_CAPABILITIES } from "./execution-route";
import { getHostedRoutingContractMode } from "./config";
import {
  buildPrivateBackend,
  createGatewayConfigRevision,
  createGatewayRouteGeneration,
  requireQualifiedRouterUrl,
} from "./routing-authority";
import { parseEnvironmentProviderConnectionConfiguration } from "./provider-persistence-contracts";

export class EnvironmentGatewayConfigError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = "EnvironmentGatewayConfigError";
  }
}

export async function resolveEnvironmentGatewayConfig(input: {
  environmentId: string;
  authorization: string | null;
  now?: Date | undefined;
}): Promise<EnvironmentGatewayConfig> {
  const now = input.now ?? new Date();
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { eq: equals }) =>
      equals(table.id, input.environmentId),
  });
  if (!environment?.gatewayServiceTokenHash) {
    throw new EnvironmentGatewayConfigError(
      "ENVIRONMENT_GATEWAY_IDENTITY_UNAVAILABLE",
      401
    );
  }
  const flyAppName = environment.flyAppName;
  const logicalRouting = getHostedRoutingContractMode() === "logical-v1";
  const token = readBearer(input.authorization);
  if (
    !verifyEnvironmentServiceToken({
      token,
      expectedHash: environment.gatewayServiceTokenHash,
    })
  ) {
    throw new EnvironmentGatewayConfigError(
      "ENVIRONMENT_GATEWAY_UNAUTHORIZED",
      401
    );
  }

  if (environment.provider === "kubernetes" && !logicalRouting) {
    return serializeLegacyEnvironmentGatewayConfig({
      environmentId: environment.id,
      revision: now.toISOString(),
      workspaces: [],
      previews: [],
      modelGrants: [],
      appGrants: [],
    });
  }
  if (!flyAppName && environment.provider === "fly") {
    throw new EnvironmentGatewayConfigError(
      "ENVIRONMENT_GATEWAY_IDENTITY_UNAVAILABLE",
      401
    );
  }

  const providerResources = logicalRouting
    && environment.providerConnectionId
    ? await knowledgeDb.query.environmentProviderResources.findMany({
        where: and(
          eq(schema.environmentProviderResources.organizationId, environment.organizationId),
          eq(schema.environmentProviderResources.environmentId, environment.id),
          eq(
            schema.environmentProviderResources.providerConnectionId,
            environment.providerConnectionId,
          ),
          isNull(schema.environmentProviderResources.deletedAt),
        ),
      })
    : [];
  const gatewayResource = providerResources.find((resource) =>
    resource.resourceRole === "gateway" && resource.workspaceId === null
  );
  const scopeResource = providerResources.find((resource) =>
    resource.resourceRole === "environment_scope" && resource.workspaceId === null
  );
  if (logicalRouting && !(gatewayResource && scopeResource)) {
    if (environment.provider === "kubernetes") {
      return serializeLegacyEnvironmentGatewayConfig({
        environmentId: environment.id,
        revision: now.toISOString(),
        workspaces: [],
        previews: [],
        modelGrants: [],
        appGrants: [],
      });
    }
    throw new EnvironmentGatewayConfigError(
      "ENVIRONMENT_GATEWAY_IDENTITY_UNAVAILABLE",
      503,
    );
  }

  const [workspaces, previews, modelGrants, appExecutions] = await Promise.all([
      knowledgeDb.query.environmentWorkspaces.findMany({
        where: and(
          eq(schema.environmentWorkspaces.environmentId, environment.id),
          inArray(schema.environmentWorkspaces.status, [
            "ready",
            "starting",
            "stopped",
          ]),
          isNull(schema.environmentWorkspaces.deletedAt),
        ),
      }),
      knowledgeDb.query.workspacePreviewLeases.findMany({
        where: and(
          eq(schema.workspacePreviewLeases.environmentId, environment.id),
          inArray(schema.workspacePreviewLeases.status, [
            "provisioning",
            "active",
          ]),
          gt(schema.workspacePreviewLeases.expiresAt, now)
        ),
      }),
      knowledgeDb
        .select({ grant: schema.environmentModelGrants })
        .from(schema.environmentModelGrants)
        .innerJoin(
          schema.environmentRunExecutions,
          eq(
            schema.environmentRunExecutions.id,
            schema.environmentModelGrants.runId
          )
        )
        .where(
          and(
            eq(schema.environmentModelGrants.environmentId, environment.id),
            eq(schema.environmentModelGrants.status, "active"),
            inArray(schema.environmentRunExecutions.status, ["routed", "running"])
          )
        ),
      knowledgeDb.query.environmentRunExecutions.findMany({
        where: and(
          eq(schema.environmentRunExecutions.environmentId, environment.id),
          inArray(schema.environmentRunExecutions.status, ["routed", "running"]),
        ),
      }),
    ]);

  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const computeByWorkspace = new Map(
    providerResources
      .filter((resource) =>
        resource.resourceRole === "workspace_compute" &&
        resource.workspaceId !== null &&
        resource.replacementId === null
      )
      .map((resource) => [resource.workspaceId!, resource]),
  );
  const logicalWorkspaces = logicalRouting && scopeResource
    ? workspaces.flatMap((workspace) => {
        const compute = computeByWorkspace.get(workspace.id);
        return compute && workspace.serviceTokenHash
          ? [{
              id: workspace.id,
              serviceTokenHash: workspace.serviceTokenHash,
              backend: buildPrivateBackend({
                provider: environment.provider,
                flyAppName,
                scopeExternalId: scopeResource.externalId,
                compute: {
                  id: compute.id,
                  externalId: compute.externalId,
                  desiredRevision: compute.desiredRevision,
                },
              }),
            }]
          : [];
      })
    : [];
  const relayIssuedAt = Math.floor(now.getTime() / 1000);
  const relayPrivateKey =
    process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "";
  const appGrants = appExecutions.flatMap((execution) => {
    const workspace = workspaceById.get(execution.workspaceId);
    if (!workspace || (logicalRouting
      ? !computeByWorkspace.has(workspace.id)
      : !workspace.flyMachineId)) return [];
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + 300;
    return [{
      executionId: execution.id,
      runId: execution.runtimeRunId,
      workspaceId: execution.workspaceId,
      executionTicket: signEnvironmentExecutionTicket({
        privateKey: relayPrivateKey,
        ticket: logicalRouting
          ? {
          version: 3,
          audience: ENVIRONMENT_ROUTER_AUDIENCE,
          organizationId: execution.organizationId,
          environmentId: execution.environmentId,
          workspaceId: execution.workspaceId,
          threadId: execution.threadId,
          runId: execution.id,
          actorId: execution.actorId,
          agentId: "kestrel-one-app-relay",
          target: {
            kind: "gateway",
            gatewayId: gatewayResource!.id,
          },
          capabilities: [...ENVIRONMENT_EXECUTION_ROUTE_CAPABILITIES],
          issuedAt,
          expiresAt,
          nonce: crypto.randomUUID(),
        }
          : {
          version: 2,
          audience: ENVIRONMENT_ROUTER_AUDIENCE,
          organizationId: execution.organizationId,
          environmentId: execution.environmentId,
          workspaceId: execution.workspaceId,
          threadId: execution.threadId,
          runId: execution.id,
          actorId: execution.actorId,
          agentId: "kestrel-one-app-relay",
          target: {
            provider: "fly",
            appName: flyAppName!,
            machineId: workspace.flyMachineId!,
          },
          capabilities: [...ENVIRONMENT_EXECUTION_ROUTE_CAPABILITIES],
          issuedAt,
          expiresAt,
          nonce: crypto.randomUUID(),
        },
      }),
      credentialExpiresAt: new Date(expiresAt * 1000).toISOString(),
    }];
  });
  const resolvedModelGrants = await Promise.all(
    modelGrants.map(async ({ grant }) => {
      const lease = await issueGatewayCredentialLease({
        version: "gateway-credential-lease-v3",
        gatewayId: grant.gatewayId,
        organizationId: grant.organizationId,
        environmentId: grant.environmentId,
        rawModelId: grant.rawModelId,
      });
      return {
        runId: grant.runId,
        workspaceId: grant.workspaceId,
        gatewayId: grant.gatewayId,
        rawModelId: grant.rawModelId,
        provider: lease.provider,
        protocol: lease.protocol,
        baseUrl: lease.baseUrl,
        apiKey: lease.apiKey,
        credentialExpiresAt: lease.expiresAt,
      };
    })
  );

  const legacyWorkspaces = workspaces.flatMap((workspace) =>
      workspace.flyMachineId && workspace.serviceTokenHash
        ? [
            {
              id: workspace.id,
              machineId: workspace.flyMachineId,
              serviceTokenHash: workspace.serviceTokenHash,
            },
          ]
        : []
    );
  const resolvedPreviews = previews.flatMap((preview) => {
      const workspace = workspaceById.get(preview.workspaceId);
      const relayExpiresAt = Math.min(
        relayIssuedAt + 300,
        Math.floor(preview.expiresAt.getTime() / 1000)
      );
      const routable = logicalRouting
        ? computeByWorkspace.has(preview.workspaceId)
        : Boolean(workspace?.flyMachineId);
      return workspace && routable && relayExpiresAt > relayIssuedAt
        ? [
            {
              id: preview.id,
              workspaceId: preview.workspaceId,
              ...(!logicalRouting ? { machineId: workspace.flyMachineId! } : {}),
              hostname: preview.hostname,
              port: preview.port,
              expiresAt: preview.expiresAt.toISOString(),
              relayTicket: signPreviewRelayTicket({
                privateKey: relayPrivateKey,
                ticket: logicalRouting
                  ? {
                  version: PREVIEW_RELAY_TICKET_V3_VERSION,
                  audience: PREVIEW_RELAY_TICKET_AUDIENCE,
                  organizationId: preview.organizationId,
                  environmentId: preview.environmentId,
                  workspaceId: preview.workspaceId,
                  previewId: preview.id,
                  hostname: preview.hostname,
                  port: preview.port,
                  issuedAt: relayIssuedAt,
                  expiresAt: relayExpiresAt,
                  nonce: crypto.randomUUID(),
                  target: { kind: "workspace" },
                }
                  : {
                  version: PREVIEW_RELAY_TICKET_VERSION,
                  audience: PREVIEW_RELAY_TICKET_AUDIENCE,
                  organizationId: preview.organizationId,
                  environmentId: preview.environmentId,
                  workspaceId: preview.workspaceId,
                  flyAppName: flyAppName!,
                  flyMachineId: workspace.flyMachineId!,
                  previewId: preview.id,
                  hostname: preview.hostname,
                  port: preview.port,
                  issuedAt: relayIssuedAt,
                  expiresAt: relayExpiresAt,
                  nonce: crypto.randomUUID(),
                },
              }),
            },
          ]
        : [];
    });
  if (!logicalRouting) {
    return serializeLegacyEnvironmentGatewayConfig({
      environmentId: environment.id,
      revision: now.toISOString(),
      workspaces: legacyWorkspaces,
      previews: resolvedPreviews as EnvironmentGatewayConfigV3["previews"],
      modelGrants: resolvedModelGrants,
      appGrants,
    });
  }
  if (!(gatewayResource && environment.providerConnectionId && environment.routerUrl)) {
    throw new EnvironmentGatewayConfigError("ENVIRONMENT_GATEWAY_IDENTITY_UNAVAILABLE", 503);
  }
  const connection = await knowledgeDb.query.environmentProviderConnections.findFirst({
    where: and(
      eq(schema.environmentProviderConnections.id, environment.providerConnectionId),
      eq(schema.environmentProviderConnections.organizationId, environment.organizationId),
      isNull(schema.environmentProviderConnections.revokedAt),
    ),
  });
  if (!connection) {
    throw new EnvironmentGatewayConfigError("ENVIRONMENT_GATEWAY_IDENTITY_UNAVAILABLE", 503);
  }
  const configuration = parseEnvironmentProviderConnectionConfiguration(connection.configuration);
  requireQualifiedRouterUrl({
    provider: environment.provider,
    environmentId: environment.id,
    flyAppName,
    routerUrl: environment.routerUrl,
    configuration,
  });
  const routeGeneration = createGatewayRouteGeneration({
    gatewayId: gatewayResource.id,
    workspaces: logicalWorkspaces,
  });
  const body = {
    environmentId: environment.id,
    gatewayId: gatewayResource.id,
    routeGeneration,
    workspaces: logicalWorkspaces,
    previews: resolvedPreviews.map(({ machineId: _machineId, ...preview }) => preview),
    modelGrants: resolvedModelGrants,
    appGrants,
  };
  return serializeEnvironmentGatewayConfig({
    ...body,
    revision: createGatewayConfigRevision(body),
  });
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) {
    throw new EnvironmentGatewayConfigError(
      "ENVIRONMENT_GATEWAY_AUTHORIZATION_REQUIRED",
      401
    );
  }
  return match[1];
}
