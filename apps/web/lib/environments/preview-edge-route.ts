import { timingSafeEqual } from "node:crypto";
import {
  PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
  PREVIEW_EDGE_ROUTE_TICKET_MAX_TTL_SECONDS,
  PREVIEW_EDGE_ROUTE_TICKET_VERSION,
  signPreviewEdgeRouteTicket,
} from "@lumi/kestrel-environment-auth";
import { and, eq, gt } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { authorizeDesktopPreviewViewer } from "./desktop-preview";

export const PREVIEW_EDGE_RESOLVED_ROUTE_VERSION =
  "preview-edge-resolved-route-v1" as const;
export const PREVIEW_EDGE_RESOLVED_ROUTE_V2_VERSION =
  "preview-edge-resolved-route-v2" as const;

export class PreviewEdgeRouteError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "PreviewEdgeRouteError";
  }
}

export type PreviewEdgeRouteDependencies = {
  expectedServiceToken: string | undefined;
  privateKey: string | undefined;
  findActiveLease(input: { hostname: string; now: Date }): Promise<{
    id: string;
    organizationId: string;
    environmentId: string;
    workspaceId: string;
    hostname: string;
    targetProvider?: "fly" | "desktop";
    expiresAt: Date;
  } | null>;
  findEnvironment(environmentId: string): Promise<{
    provider?: "fly" | "desktop";
    flyAppName: string | null;
    routerUrl: string | null;
  } | null>;
  authorizeDesktopViewer?(input: {
    leaseId: string;
    accessToken: string | null;
  }): Promise<boolean>;
  nonce(): string;
};

const defaultDependencies: PreviewEdgeRouteDependencies = {
  expectedServiceToken: process.env.KESTREL_PREVIEW_EDGE_SERVICE_TOKEN,
  privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY,
  findActiveLease: async ({ hostname, now }) =>
    (await knowledgeDb.query.workspacePreviewLeases.findFirst({
      where: and(
        eq(schema.workspacePreviewLeases.hostname, hostname),
        eq(schema.workspacePreviewLeases.status, "active"),
        gt(schema.workspacePreviewLeases.expiresAt, now),
      ),
      columns: {
        id: true,
        organizationId: true,
        environmentId: true,
        workspaceId: true,
        hostname: true,
        targetProvider: true,
        expiresAt: true,
      },
    })) ?? null,
  findEnvironment: async (environmentId) =>
    (await knowledgeDb.query.environments.findFirst({
      where: (table, { eq: equals }) => equals(table.id, environmentId),
      columns: {
        provider: true,
        flyAppName: true,
        routerUrl: true,
      },
    })) ?? null,
  authorizeDesktopViewer: authorizeDesktopPreviewViewer,
  nonce: () => crypto.randomUUID(),
};

export async function resolvePreviewEdgeRoute(
  input: {
    authorization: string | null;
    hostname: string;
    accessToken?: string | null | undefined;
    now?: Date | undefined;
  },
  dependencies: PreviewEdgeRouteDependencies = defaultDependencies,
) {
  authorizePreviewEdgeResolver({
    authorization: input.authorization,
    expectedToken: dependencies.expectedServiceToken,
  });
  const hostname = parsePreviewHostname(input.hostname);
  const now = input.now ?? new Date();
  const lease = await dependencies.findActiveLease({ hostname, now });
  if (!lease || lease.hostname.toLowerCase() !== hostname) {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_ROUTE_NOT_FOUND", 404);
  }
  if (lease.targetProvider === "desktop") {
    const authorized = await dependencies.authorizeDesktopViewer?.({
      leaseId: lease.id,
      accessToken: input.accessToken ?? null,
    });
    if (!authorized) {
      throw new PreviewEdgeRouteError("PREVIEW_EDGE_ROUTE_NOT_FOUND", 404);
    }
    return {
      version: PREVIEW_EDGE_RESOLVED_ROUTE_V2_VERSION,
      hostname,
      target: { provider: "desktop" as const, previewId: lease.id },
      expiresAt: new Date(
        Math.min(now.getTime() + 60_000, lease.expiresAt.getTime()),
      ).toISOString(),
    };
  }
  const environment = await dependencies.findEnvironment(lease.environmentId);
  if (!(environment?.flyAppName && environment.routerUrl)) {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_ROUTE_UNAVAILABLE", 503);
  }
  const targetUrl = requireEnvironmentRouterUrl({
    flyAppName: environment.flyAppName,
    routerUrl: environment.routerUrl,
  });
  const privateKey = dependencies.privateKey?.trim();
  if (!privateKey) {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_SIGNING_UNAVAILABLE", 503);
  }
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = Math.min(
    issuedAt + PREVIEW_EDGE_ROUTE_TICKET_MAX_TTL_SECONDS,
    Math.floor(lease.expiresAt.getTime() / 1000),
  );
  if (expiresAt <= issuedAt) {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_ROUTE_NOT_FOUND", 404);
  }
  let token: string;
  try {
    token = signPreviewEdgeRouteTicket({
      privateKey,
      ticket: {
        version: PREVIEW_EDGE_ROUTE_TICKET_VERSION,
        audience: PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
        organizationId: lease.organizationId,
        environmentId: lease.environmentId,
        workspaceId: lease.workspaceId,
        flyAppName: environment.flyAppName,
        previewId: lease.id,
        hostname,
        issuedAt,
        expiresAt,
        nonce: dependencies.nonce(),
      },
    });
  } catch {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_SIGNING_UNAVAILABLE", 503);
  }

  return {
    version: PREVIEW_EDGE_RESOLVED_ROUTE_VERSION,
    hostname,
    targetUrl,
    authorization: `Bearer ${token}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export function authorizePreviewEdgeResolver(input: {
  authorization: string | null;
  expectedToken: string | undefined;
}) {
  const expectedToken = input.expectedToken?.trim();
  if (!expectedToken) {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_AUTH_NOT_CONFIGURED", 503);
  }
  const suppliedToken = input.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!suppliedToken) {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_UNAUTHORIZED", 401);
  }
  const supplied = Buffer.from(suppliedToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_UNAUTHORIZED", 401);
  }
}

function parsePreviewHostname(value: string) {
  const hostname = value.trim().toLowerCase();
  if (
    hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(hostname)
  ) {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_HOST_INVALID", 400);
  }
  return hostname;
}

function requireEnvironmentRouterUrl(input: {
  flyAppName: string;
  routerUrl: string;
}) {
  let url: URL;
  try {
    url = new URL(input.routerUrl);
  } catch {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_ROUTE_UNAVAILABLE", 503);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname !== `${input.flyAppName}.fly.dev` ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new PreviewEdgeRouteError("PREVIEW_EDGE_ROUTE_UNAVAILABLE", 503);
  }
  return url.origin;
}
