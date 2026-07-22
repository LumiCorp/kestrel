import type { EnvironmentGatewayConfig } from "@lumi/kestrel-environment-auth";
import { ENVIRONMENT_GATEWAY_CONFIG_VERSION } from "@lumi/kestrel-environment-auth";
import {
  PREVIEW_RELAY_TICKET_AUDIENCE,
  PREVIEW_RELAY_TICKET_VERSION,
  signPreviewRelayTicket,
} from "@lumi/kestrel-environment-auth";
import { and, eq, gt, inArray } from "drizzle-orm";
import { issueGatewayCredentialLease } from "@/lib/ai/gateway-credential-lease";
import { markAppConnectionDegraded, markAppConnectionHealthy } from "@/lib/apps/runtime";
import { resolveEnvironmentAppCredential } from "@/lib/apps/service";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { verifyEnvironmentServiceToken } from "./service-tokens";

export class EnvironmentGatewayConfigError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = "EnvironmentGatewayConfigError";
  }
}

export async function reportEnvironmentGatewayNgrokStatus(input: {
  environmentId: string;
  authorization: string | null;
  connectionId: string;
  status: "connected" | "degraded";
  failureCode?: string | undefined;
}) {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { eq: equals }) => equals(table.id, input.environmentId),
  });
  if (!environment?.gatewayServiceTokenHash || !verifyEnvironmentServiceToken({
    token: readBearer(input.authorization),
    expectedHash: environment.gatewayServiceTokenHash,
  })) {
    throw new EnvironmentGatewayConfigError("ENVIRONMENT_GATEWAY_UNAUTHORIZED", 401);
  }
  const connection = await knowledgeDb.query.appConnections.findFirst({
    where: (table, { and: all, eq: equals, inArray: includes }) => all(
      equals(table.id, input.connectionId),
      equals(table.organizationId, environment.organizationId),
      equals(table.environmentId, environment.id),
      equals(table.appKey, "ngrok"),
      includes(table.status, ["connected", "degraded"])
    ),
  });
  if (!connection) throw new EnvironmentGatewayConfigError("ENVIRONMENT_NGROK_CONNECTION_NOT_FOUND", 404);
  if (input.status === "connected") {
    await markAppConnectionHealthy({
      organizationId: environment.organizationId,
      environmentId: environment.id,
      appKey: "ngrok",
      connectionId: connection.id,
    });
  } else {
    await markAppConnectionDegraded({
      organizationId: environment.organizationId,
      environmentId: environment.id,
      appKey: "ngrok",
      connectionId: connection.id,
      failureCode: input.failureCode ?? "NGROK_AGENT_ENDPOINT_FAILED",
    });
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

  const [ngrokConnection, workspaces, previews, modelGrants] =
    await Promise.all([
      knowledgeDb.query.appConnections.findFirst({
        where: (table, { and: all, eq: equals, inArray: includes }) =>
          all(
            equals(table.organizationId, environment.organizationId),
            equals(table.environmentId, environment.id),
            equals(table.appKey, "ngrok"),
            equals(table.ownerType, "environment"),
            includes(table.status, ["connected", "degraded"])
          ),
      }),
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
    ]);

  let ngrokCredential = null;
  if (ngrokConnection) {
    try {
      const resolved = await resolveEnvironmentAppCredential({
        organizationId: environment.organizationId,
        environmentId: environment.id,
        appKey: "ngrok",
        connectionId: ngrokConnection.id,
      });
      if (resolved.kind !== "ngrok_agent") {
        throw new Error("Ngrok credential kind is invalid.");
      }
      ngrokCredential = resolved;
    } catch {
      await markAppConnectionDegraded({
        organizationId: environment.organizationId,
        environmentId: environment.id,
        appKey: "ngrok",
        connectionId: ngrokConnection.id,
        failureCode: "NGROK_CREDENTIAL_UNAVAILABLE",
      }).catch(() => undefined);
    }
  }

  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const relayIssuedAt = Math.floor(now.getTime() / 1000);
  const relayPrivateKey =
    process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "";
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

  return {
    version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
    environmentId: environment.id,
    revision: now.toISOString(),
    ngrok:
      ngrokConnection && ngrokCredential
        ? {
            connectionId: ngrokConnection.id,
            authtoken: ngrokCredential.authtoken,
            wildcardDomain: ngrokCredential.wildcardDomain,
          }
        : null,
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
  };
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
