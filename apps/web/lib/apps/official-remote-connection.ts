import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  createEnvironmentMcpCredential,
  installEnvironmentMcpServer,
  requestEnvironmentMcpDiscovery,
  revokeEnvironmentMcpCredential,
} from "@/lib/mcp/control-plane";
import {
  completeEnvironmentMcpOauth,
  startEnvironmentMcpOauth,
} from "@/lib/mcp/oauth-flow";
import type { CreateEnvironmentAppConnectionInput } from "./contracts";
import {
  getOfficialRemoteOauthApp,
  getOfficialRemoteTokenApp,
  type OfficialRemoteOauthApp,
  type OfficialRemoteTokenApp,
  resolveOfficialOauthCapabilitySelection,
} from "./official-remote-apps";

type OfficialRemoteApp = OfficialRemoteOauthApp | OfficialRemoteTokenApp;

export async function connectOfficialRemoteTokenApp(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  actorUserId: string;
  connection: CreateEnvironmentAppConnectionInput;
}) {
  const app = getOfficialRemoteTokenApp(input.appKey);
  if (!app) return null;
  if (input.connection.kind === "ngrok_agent") {
    throw new Error(`${app.displayName} requires an API-key credential.`);
  }
  const credential = await createEnvironmentMcpCredential({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    actorUserId: input.actorUserId,
    credential: {
      name: `${app.appKey}.${crypto.randomUUID()}`,
      payload: {
        kind: "secret_headers",
        headers: {
          Authorization: app.authorizationHeader(input.connection.apiKey),
        },
      },
    },
  });
  return connectOfficialRemoteCredential({
    ...input,
    app,
    connectionName: input.connection.name,
    credentialId: credential.id,
    authMode: "secret_headers",
  });
}

export async function startOfficialRemoteOauthApp(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  actorUserId: string;
  redirectUri: string;
  capabilityPacks?: string[];
}) {
  const app = getOfficialRemoteOauthApp(input.appKey);
  if (!app) return null;
  const selection = resolveOfficialOauthCapabilitySelection({
    app,
    capabilityPacks: input.capabilityPacks,
  });
  const clientId = app.oauthClient
    ? process.env[app.oauthClient.clientIdEnvironmentVariable]?.trim()
    : undefined;
  const clientSecret = app.oauthClient
    ? process.env[app.oauthClient.clientSecretEnvironmentVariable]?.trim()
    : undefined;
  if (app.oauthClient && !(clientId && clientSecret)) {
    throw new Error(`${app.displayName} connection is not configured.`);
  }
  return startEnvironmentMcpOauth({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    actorUserId: input.actorUserId,
    redirectUri: input.redirectUri,
    clientName: `${app.displayName} for Kestrel`,
    oauth: {
      credentialName: `${app.appKey}.oauth.${crypto.randomUUID()}`,
      resource: app.remoteUrl,
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      tokenEndpointAuthMethod:
        app.oauthClient?.tokenEndpointAuthMethod ?? "none",
      ...(selection.scopes ? { scopes: selection.scopes } : {}),
    },
  });
}

export async function completeOfficialRemoteOauthApp(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  actorUserId: string;
  state: string;
  code: string;
}) {
  const app = getOfficialRemoteOauthApp(input.appKey);
  if (!app) return null;
  const completed = await completeEnvironmentMcpOauth({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    actorUserId: input.actorUserId,
    state: input.state,
    code: input.code,
    expectedResource: app.remoteUrl,
    acceptedTokenTypes: app.acceptedTokenTypes
      ? [...app.acceptedTokenTypes]
      : undefined,
  });
  const selection = resolveCompletedCapabilitySelection(app, completed.scopes);
  return connectOfficialRemoteCredential({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    appKey: input.appKey,
    actorUserId: input.actorUserId,
    app,
    connectionName: "Primary",
    credentialId: completed.credential.id,
    authMode: "oauth",
    capabilityPacks: selection,
    grantedScopes: completed.scopes,
    oauthTokenEndpoint: completed.tokenEndpoint,
  });
}

async function connectOfficialRemoteCredential(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  actorUserId: string;
  app: OfficialRemoteApp;
  connectionName: string;
  credentialId: string;
  authMode: "oauth" | "secret_headers";
  capabilityPacks?: string[];
  grantedScopes?: string[];
  oauthTokenEndpoint?: string;
}) {
  const egressAllowlist = [
    ...new Set([
      new URL(input.app.remoteUrl).origin,
      ...(input.oauthTokenEndpoint
        ? [new URL(input.oauthTokenEndpoint).origin]
        : []),
    ]),
  ];
  const existingConnection = await knowledgeDb.query.appConnections.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.organizationId, input.organizationId),
        equals(table.environmentId, input.environmentId),
        equals(table.appKey, input.appKey),
        equals(table.name, input.connectionName),
        equals(table.ownerType, "environment")
      ),
  });
  const existingServer = existingConnection
    ? await knowledgeDb.query.mcpServers.findFirst({
        where: (table, { and: all, eq: equals }) =>
          all(
            equals(table.id, existingConnection.id),
            equals(table.organizationId, input.organizationId),
            equals(table.environmentId, input.environmentId)
          ),
      })
    : null;
  if (existingConnection && !existingServer) {
    await revokeCredential(input);
    throw new Error("The retained App connection could not be restored.");
  }

  let server: Awaited<ReturnType<typeof installEnvironmentMcpServer>>;
  try {
    if (existingServer) {
      const [restored] = await knowledgeDb
        .update(schema.mcpServers)
        .set({
          credentialId: input.credentialId,
          authMode: input.authMode,
          sourceType: "remote",
          transport: "streamable_http",
          remoteUrl: input.app.remoteUrl,
          egressAllowlist,
          status: "draft",
          failureCode: null,
          failureMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.mcpServers.id, existingServer.id),
            eq(schema.mcpServers.organizationId, input.organizationId),
            eq(schema.mcpServers.environmentId, input.environmentId)
          )
        )
        .returning();
      if (!restored) throw new Error("App connection could not be restored.");
      await knowledgeDb
        .update(schema.appConnections)
        .set({
          status: "disconnected",
          failureCode: null,
          failureMessage: null,
          disconnectedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.appConnections.id, restored.id),
            eq(schema.appConnections.organizationId, input.organizationId),
            eq(schema.appConnections.appKey, input.appKey)
          )
        );
      server = restored;
    } else {
      server = await installEnvironmentMcpServer({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        actorUserId: input.actorUserId,
        appKey: input.app.appKey,
        server: {
          name: input.connectionName,
          slug: input.app.slug,
          sourceType: "remote",
          transport: "streamable_http",
          remoteUrl: input.app.remoteUrl,
          auth: { mode: input.authMode, credentialId: input.credentialId },
          launchArguments: [],
          egressAllowlist,
          resources: {
            cpuMillicores: 500,
            memoryMib: 512,
            pidsLimit: 128,
          },
        },
      });
    }
  } catch (error) {
    await revokeCredential(input);
    throw error;
  }

  if (
    existingServer?.credentialId &&
    existingServer.credentialId !== input.credentialId
  ) {
    await revokeEnvironmentMcpCredential({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      credentialId: existingServer.credentialId,
      actorUserId: input.actorUserId,
    });
  }

  await requestEnvironmentMcpDiscovery({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    serverId: server.id,
    actorUserId: input.actorUserId,
  });
  const connection = await knowledgeDb.query.appConnections.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.id, server.id),
        equals(table.organizationId, input.organizationId),
        equals(table.appKey, input.appKey)
      ),
  });
  if (!connection) throw new Error("App connection was not created.");
  if (input.capabilityPacks) {
    await knowledgeDb
      .update(schema.appConnections)
      .set({
        deliveryConfig: {
          ...(connection.deliveryConfig ?? {}),
          capabilityPacks: input.capabilityPacks,
        },
        scopes: input.grantedScopes ?? [],
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.appConnections.id, connection.id),
          eq(schema.appConnections.organizationId, input.organizationId),
          eq(schema.appConnections.appKey, input.appKey)
        )
      );
  }
  return {
    id: connection.id,
    name: connection.name,
    ownerType: connection.ownerType,
    status: connection.status,
    environmentId: connection.environmentId,
    isMine: false,
    lastHealthAt: connection.lastHealthAt?.toISOString() ?? null,
  };
}

function resolveCompletedCapabilitySelection(
  app: OfficialRemoteOauthApp,
  grantedScopes: string[]
) {
  if (!app.capabilityPackScopes) return;
  const granted = new Set(grantedScopes);
  return Object.entries(app.capabilityPackScopes).flatMap(([pack, scopes]) =>
    scopes.every((scope) => granted.has(scope)) ? [pack] : []
  );
}

function revokeCredential(input: {
  organizationId: string;
  environmentId: string;
  actorUserId: string;
  credentialId: string;
}) {
  return revokeEnvironmentMcpCredential({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    credentialId: input.credentialId,
    actorUserId: input.actorUserId,
  }).catch(() => {});
}
