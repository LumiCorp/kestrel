import "server-only";

import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { GatewayPrivateBackend } from "@lumi/kestrel-environment-auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { parseEnvironmentProviderConnectionConfiguration } from "./provider-persistence-contracts";

const WORKSPACE_PORT = 43_104;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export class HostedRoutingAuthorityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HostedRoutingAuthorityError";
  }
}

export async function resolveHostedRoutingAuthority(input: {
  organizationId: string;
  environmentId: string;
  workspaceId?: string | undefined;
}) {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq, isNull }) => and(
      eq(table.id, input.environmentId),
      eq(table.organizationId, input.organizationId),
      eq(table.status, "ready"),
      isNull(table.archivedAt),
    ),
  });
  if (!(environment?.providerConnectionId && environment.routerUrl)) {
    throw unavailable("Environment routing authority is incomplete.");
  }
  if (environment.provider === "desktop") {
    throw unavailable("Desktop Environments do not use hosted routing authority.");
  }
  const connection = await knowledgeDb.query.environmentProviderConnections.findFirst({
    where: (table, { and, eq, isNull }) => and(
      eq(table.id, environment.providerConnectionId!),
      eq(table.organizationId, input.organizationId),
      eq(table.provider, environment.provider === "kubernetes" ? "kubernetes" : "fly"),
      isNull(table.revokedAt),
    ),
  });
  if (!connection) throw unavailable("Environment provider connection is unavailable.");
  const resources = await knowledgeDb.query.environmentProviderResources.findMany({
    where: and(
      eq(schema.environmentProviderResources.organizationId, input.organizationId),
      eq(schema.environmentProviderResources.environmentId, input.environmentId),
      eq(schema.environmentProviderResources.providerConnectionId, connection.id),
      isNull(schema.environmentProviderResources.deletedAt),
    ),
  });
  const gateway = resources.find((resource) =>
    resource.resourceRole === "gateway" && resource.workspaceId === null
  );
  const scope = resources.find((resource) =>
    resource.resourceRole === "environment_scope" && resource.workspaceId === null
  );
  if (!(gateway && scope)) throw unavailable("Environment gateway resources are unavailable.");
  const workspace = input.workspaceId
    ? await knowledgeDb.query.environmentWorkspaces.findFirst({
        where: (table, { and, eq, isNull }) => and(
          eq(table.id, input.workspaceId!),
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, input.environmentId),
          eq(table.status, "ready"),
          isNull(table.deletedAt),
        ),
      })
    : null;
  const compute = input.workspaceId
    ? resources.find((resource) =>
        resource.resourceRole === "workspace_compute" &&
        resource.workspaceId === input.workspaceId &&
        resource.replacementId === null
      )
    : null;
  if (input.workspaceId && !(workspace && compute)) {
    throw unavailable("Workspace routing authority is unavailable.");
  }
  const configuration = parseEnvironmentProviderConnectionConfiguration(connection.configuration);
  const routerUrl = requireQualifiedRouterUrl({
    provider: environment.provider,
    environmentId: environment.id,
    flyAppName: environment.flyAppName,
    routerUrl: environment.routerUrl,
    configuration,
  });
  return {
    environment,
    workspace,
    connection: { ...connection, configuration },
    gateway,
    scope,
    resources,
    compute,
    routerUrl,
    ...(compute
      ? { backend: buildPrivateBackend({
          provider: environment.provider,
          flyAppName: environment.flyAppName,
          scopeExternalId: scope.externalId,
          compute: {
            id: compute.id,
            externalId: compute.externalId,
            desiredRevision: compute.desiredRevision,
          },
        }) }
      : {}),
  };
}

export async function resolveHostedRouteGeneration(input: {
  organizationId: string;
  environmentId: string;
}) {
  const authority = await resolveHostedRoutingAuthority(input);
  const workspaces = await knowledgeDb.query.environmentWorkspaces.findMany({
    where: (table, { and, eq, inArray, isNull }) => and(
      eq(table.organizationId, input.organizationId),
      eq(table.environmentId, input.environmentId),
      inArray(table.status, ["ready", "starting", "stopped"]),
      isNull(table.deletedAt),
    ),
    columns: { id: true, serviceTokenHash: true },
  });
  const computeByWorkspace = new Map(authority.resources
    .filter((resource) =>
      resource.resourceRole === "workspace_compute" &&
      resource.workspaceId !== null &&
      resource.replacementId === null
    )
    .map((resource) => [resource.workspaceId!, resource]));
  const routes = workspaces.flatMap((workspace) => {
    const compute = computeByWorkspace.get(workspace.id);
    return compute && workspace.serviceTokenHash
      ? [{
          id: workspace.id,
          backend: buildPrivateBackend({
            provider: authority.environment.provider,
            flyAppName: authority.environment.flyAppName,
            scopeExternalId: authority.scope.externalId,
            compute: {
              id: compute.id,
              externalId: compute.externalId,
              desiredRevision: compute.desiredRevision,
            },
          }),
        }]
      : [];
  });
  return {
    gatewayId: authority.gateway.id,
    routeGeneration: createGatewayRouteGeneration({
      gatewayId: authority.gateway.id,
      workspaces: routes,
    }),
  };
}

export function buildPrivateBackend(input: {
  provider: "fly" | "kubernetes" | "desktop";
  flyAppName: string | null;
  scopeExternalId: string;
  compute: { id: string; externalId: string; desiredRevision: string };
}): GatewayPrivateBackend {
  let hostname: string;
  if (input.provider === "fly") {
    if (!(input.flyAppName && validDnsName(input.flyAppName) && validDnsLabel(input.compute.externalId))) {
      throw unavailable("Fly workspace routing identity is invalid.");
    }
    hostname = `${input.compute.externalId}.vm.${input.flyAppName}.internal`;
  } else if (input.provider === "kubernetes") {
    if (!(validDnsLabel(input.compute.externalId) && validDnsLabel(input.scopeExternalId))) {
      throw unavailable("Kubernetes workspace routing identity is invalid.");
    }
    hostname = `${input.compute.externalId}.${input.scopeExternalId}.svc.cluster.local`;
  } else {
    throw unavailable("Desktop workspaces do not use hosted private backends.");
  }
  return {
    kind: "private_dns",
    hostname,
    port: WORKSPACE_PORT,
    computeResourceId: input.compute.id,
    desiredRevision: input.compute.desiredRevision,
  };
}

export function createGatewayRouteGeneration(input: {
  gatewayId: string;
  workspaces: Array<{ id: string; backend: GatewayPrivateBackend }>;
}) {
  return sha256(JSON.stringify({
    gatewayId: input.gatewayId,
    workspaces: [...input.workspaces]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((workspace) => ({ id: workspace.id, backend: workspace.backend })),
  }));
}

export function createGatewayConfigRevision(value: unknown) {
  return sha256(stableJson(value));
}

export function requireQualifiedRouterUrl(input: {
  provider: "fly" | "kubernetes" | "desktop";
  environmentId: string;
  flyAppName: string | null;
  routerUrl: string;
  configuration: ReturnType<typeof parseEnvironmentProviderConnectionConfiguration>;
}) {
  if (/[^\x00-\x7F]/u.test(input.routerUrl) || /[A-Z]/u.test(input.routerUrl)) {
    throw unavailable("Environment Router URL is invalid.");
  }
  let expectedHost: string;
  if (input.provider === "fly") {
    if (!input.flyAppName) throw unavailable("Fly Router identity is unavailable.");
    expectedHost = `${input.flyAppName}.fly.dev`;
  } else if (
    input.provider === "kubernetes" &&
    input.configuration.contract === "kubernetes-connection-config-v1"
  ) {
    expectedHost = `${sha256(input.environmentId).slice(0, 12)}.${input.configuration.profile.baseDomain}`;
  } else {
    throw unavailable("Hosted Router provider configuration is invalid.");
  }
  let url: URL;
  try {
    url = new URL(input.routerUrl);
  } catch {
    throw unavailable("Environment Router URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== expectedHost ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) throw unavailable("Environment Router URL is outside the qualified provider hostname.");
  return url.origin;
}

function validDnsLabel(value: string) {
  return value === value.toLowerCase() && DNS_LABEL.test(value);
}

function validDnsName(value: string) {
  return value.length <= 253 && value.split(".").every(validDnsLabel);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function unavailable(message: string) {
  return new HostedRoutingAuthorityError("ENVIRONMENT_ROUTING_AUTHORITY_UNAVAILABLE", message);
}
