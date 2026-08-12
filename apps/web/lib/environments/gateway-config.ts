import type { EnvironmentGatewayConfigV3 } from "@lumi/kestrel-environment-auth";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  serializeEnvironmentGatewayConfig,
  signEnvironmentExecutionTicket,
  PREVIEW_RELAY_TICKET_AUDIENCE,
  PREVIEW_RELAY_TICKET_VERSION,
  signPreviewRelayTicket,
} from "@lumi/kestrel-environment-auth";
import { and, eq, gt, inArray } from "drizzle-orm";
import { issueGatewayCredentialLease } from "@/lib/ai/gateway-credential-lease";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { verifyEnvironmentServiceToken } from "./service-tokens";
import { ENVIRONMENT_EXECUTION_ROUTE_CAPABILITIES } from "./execution-route";

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
}): Promise<EnvironmentGatewayConfigV3> {
  const now = input.now ?? new Date();
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { eq: equals }) =>
      equals(table.id, input.environmentId),
  });
  if (!(environment?.gatewayServiceTokenHash && environment.flyAppName)) {
    throw new EnvironmentGatewayConfigError(
      "ENVIRONMENT_GATEWAY_IDENTITY_UNAVAILABLE",
      401
    );
  }
  const flyAppName = environment.flyAppName;
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

  const [workspaces, previews, modelGrants, appExecutions] = await Promise.all([
      knowledgeDb.query.environmentWorkspaces.findMany({
        where: and(
          eq(schema.environmentWorkspaces.environmentId, environment.id),
          inArray(schema.environmentWorkspaces.status, [
            "ready",
            "starting",
            "stopped",
          ])
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
  const relayIssuedAt = Math.floor(now.getTime() / 1000);
  const relayPrivateKey =
    process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "";
  const appGrants = appExecutions.flatMap((execution) => {
    const workspace = workspaceById.get(execution.workspaceId);
    if (!workspace?.flyMachineId) return [];
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + 300;
    return [{
      executionId: execution.id,
      runId: execution.runtimeRunId,
      workspaceId: execution.workspaceId,
      executionTicket: signEnvironmentExecutionTicket({
        privateKey: relayPrivateKey,
        ticket: {
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
            appName: flyAppName,
            machineId: workspace.flyMachineId,
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

  return serializeEnvironmentGatewayConfig({
    environmentId: environment.id,
    revision: now.toISOString(),
    workspaces: workspaces.flatMap((workspace) =>
      workspace.flyMachineId && workspace.serviceTokenHash
        ? [
            {
              id: workspace.id,
              machineId: workspace.flyMachineId,
              serviceTokenHash: workspace.serviceTokenHash,
            },
          ]
        : []
    ),
    previews: previews.flatMap((preview) => {
      const workspace = workspaceById.get(preview.workspaceId);
      const relayExpiresAt = Math.min(
        relayIssuedAt + 300,
        Math.floor(preview.expiresAt.getTime() / 1000)
      );
      return workspace?.flyMachineId && relayExpiresAt > relayIssuedAt
        ? [
            {
              id: preview.id,
              workspaceId: preview.workspaceId,
              machineId: workspace.flyMachineId,
              hostname: preview.hostname,
              port: preview.port,
              expiresAt: preview.expiresAt.toISOString(),
              relayTicket: signPreviewRelayTicket({
                privateKey: relayPrivateKey,
                ticket: {
                  version: PREVIEW_RELAY_TICKET_VERSION,
                  audience: PREVIEW_RELAY_TICKET_AUDIENCE,
                  organizationId: preview.organizationId,
                  environmentId: preview.environmentId,
                  workspaceId: preview.workspaceId,
                  flyAppName,
                  flyMachineId: workspace.flyMachineId,
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
    }),
    modelGrants: resolvedModelGrants,
    appGrants,
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
