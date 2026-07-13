import { createHash, randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import {
  assertPublicMcpResolvedAddresses,
  normalizeMcpResolutionHostname,
} from "@kestrel/mcp-security";
import { eq } from "drizzle-orm";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { assertPublicHttpsEndpoint } from "./contracts";
import {
  decryptMcpCredential,
  encryptMcpCredential,
} from "./credential-crypto";

const startSchema = z.object({
  credentialName: z.string().trim().min(1).max(120),
  resource: z.string().url(),
  clientId: z.string().trim().min(1).max(4096),
  clientSecret: z.string().min(1).max(16_384).optional(),
  tokenEndpointAuthMethod: z
    .enum(["none", "client_secret_basic", "client_secret_post"])
    .default("none"),
});
export type McpOauthStartInput = z.input<typeof startSchema>;

export async function startEnvironmentMcpOauth(input: {
  organizationId: string;
  environmentId: string;
  actorUserId: string;
  redirectUri: string;
  oauth: McpOauthStartInput;
}) {
  if (!(await getOrganizationEnvironment(input)))
    throw new Error("Environment not found.");
  const oauth = startSchema.parse(input.oauth);
  const discovered = await discoverMcpOauthConfiguration({
    resource: oauth.resource,
  });
  const authorizationEndpoint = discovered.authorizationEndpoint;
  const tokenEndpoint = discovered.tokenEndpoint;
  if (oauth.tokenEndpointAuthMethod !== "none" && !oauth.clientSecret) {
    throw new Error("OAuth client authentication requires a client secret.");
  }
  const redirectUri = new URL(input.redirectUri);
  const isLoopback =
    redirectUri.hostname === "localhost" ||
    redirectUri.hostname === "127.0.0.1" ||
    redirectUri.hostname === "[::1]";
  if (
    redirectUri.protocol !== "https:" &&
    !(redirectUri.protocol === "http:" && isLoopback)
  )
    throw new Error("Invalid OAuth callback URL.");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const credentialId = crypto.randomUUID();
  const authorizationId = crypto.randomUUID();
  const encryptedSession = encryptMcpCredential({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    credentialId,
    payload: {
      kind: "secret_headers",
      headers: {
        "x-kestrel-pkce-verifier": verifier,
        ...(oauth.clientSecret
          ? { "x-kestrel-oauth-client-secret": oauth.clientSecret }
          : {}),
      },
    },
  });
  await knowledgeDb.insert(schema.mcpOauthAuthorizations).values({
    id: authorizationId,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    actorUserId: input.actorUserId,
    credentialId,
    credentialName: oauth.credentialName,
    stateDigest: sha(state),
    encryptedSession,
    authorizationEndpoint: authorizationEndpoint.toString(),
    tokenEndpoint: tokenEndpoint.toString(),
    clientId: oauth.clientId,
    tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod,
    scopes: discovered.scopes,
    resource: discovered.resource.toString(),
    redirectUri: redirectUri.toString(),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const url = new URL(authorizationEndpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: oauth.clientId,
    redirect_uri: redirectUri.toString(),
    state,
    code_challenge: sha(verifier, "base64url"),
    code_challenge_method: "S256",
  }))
    url.searchParams.set(key, value);
  if (discovered.scopes.length)
    url.searchParams.set("scope", discovered.scopes.join(" "));
  url.searchParams.set("resource", discovered.resource.toString());
  return { authorizationId, authorizationUrl: url.toString() };
}

export async function completeEnvironmentMcpOauth(input: {
  organizationId: string;
  environmentId: string;
  actorUserId: string;
  state: string;
  code: string;
}) {
  const row = await knowledgeDb.query.mcpOauthAuthorizations.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.stateDigest, sha(input.state)),
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
        eq(table.actorUserId, input.actorUserId),
        eq(table.status, "pending"),
      ),
  });
  if (!row || row.expiresAt.getTime() <= Date.now())
    throw new Error("MCP OAuth authorization is missing or expired.");
  const session = decryptMcpCredential({
    organizationId: row.organizationId,
    environmentId: row.environmentId,
    credentialId: row.credentialId,
    encrypted: row.encryptedSession,
  });
  if (session.kind !== "secret_headers")
    throw new Error("Invalid MCP OAuth session.");
  const verifier = session.headers["x-kestrel-pkce-verifier"];
  const clientSecret = session.headers["x-kestrel-oauth-client-secret"];
  if (!verifier) throw new Error("MCP OAuth PKCE verifier is unavailable.");
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: row.redirectUri,
    client_id: row.clientId,
    code_verifier: verifier,
  });
  if (row.resource) form.set("resource", row.resource);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (row.tokenEndpointAuthMethod === "client_secret_basic") {
    if (!clientSecret) throw new Error("OAuth client secret is unavailable.");
    headers.authorization = `Basic ${Buffer.from(`${row.clientId}:${clientSecret}`).toString("base64")}`;
  } else if (row.tokenEndpointAuthMethod === "client_secret_post") {
    if (!clientSecret) throw new Error("OAuth client secret is unavailable.");
    form.set("client_secret", clientSecret);
  }
  const endpoint = assertPublicHttpsEndpoint(row.tokenEndpoint);
  const transport = await createPinnedFetch(endpoint);
  try {
    const response = await transport.fetch(endpoint, {
      method: "POST",
      headers,
      body: form.toString(),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("MCP OAuth token exchange failed.");
    }
    const token = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        token_type: z.string(),
        expires_in: z.number().int().positive().optional(),
        scope: z.string().optional(),
      })
      .parse(await response.json());
    if (token.token_type.toLowerCase() !== "bearer")
      throw new Error("MCP OAuth requires Bearer tokens.");
    return await persistCompletedOauth({ row, token, clientSecret, endpoint });
  } finally {
    await transport.close();
  }
}

async function persistCompletedOauth(input: {
  row: typeof schema.mcpOauthAuthorizations.$inferSelect;
  token: {
    access_token: string;
    refresh_token?: string | undefined;
    token_type: string;
    expires_in?: number | undefined;
    scope?: string | undefined;
  };
  clientSecret: string | undefined;
  endpoint: URL;
}) {
  const { row, token, clientSecret, endpoint } = input;
  const expiresAt = token.expires_in
    ? new Date(Date.now() + token.expires_in * 1000).toISOString()
    : undefined;
  const encryptedPayload = encryptMcpCredential({
    organizationId: row.organizationId,
    environmentId: row.environmentId,
    credentialId: row.credentialId,
    payload: {
      kind: "oauth",
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      tokenType: "Bearer",
      scopes: token.scope?.split(/\s+/u).filter(Boolean) ?? row.scopes,
      ...(expiresAt ? { expiresAt } : {}),
      tokenEndpoint: endpoint.toString(),
      resource: row.resource ?? undefined,
      clientId: row.clientId,
      ...(clientSecret ? { clientSecret } : {}),
      tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    },
  });
  const now = new Date();
  const credential = await knowledgeDb.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.mcpCredentials)
      .values({
        id: row.credentialId,
        organizationId: row.organizationId,
        environmentId: row.environmentId,
        createdByUserId: row.actorUserId,
        name: row.credentialName,
        kind: "oauth",
        encryptedPayload,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      })
      .returning();
    await tx
      .update(schema.mcpOauthAuthorizations)
      .set({ status: "completed", completedAt: now, updatedAt: now })
      .where(eq(schema.mcpOauthAuthorizations.id, row.id));
    if (!created) throw new Error("MCP OAuth credential creation failed.");
    return created;
  });
  await logAdminEvent({
    organizationId: row.organizationId,
    actorUserId: row.actorUserId,
    category: "mcp",
    action: "mcp.credential.oauth_completed",
    targetType: "mcp_credential",
    targetId: credential.id,
    message: `Authorized OAuth MCP credential ${credential.name}.`,
    metadata: { environmentId: row.environmentId },
  });
  return credential;
}

function sha(value: string, encoding: "hex" | "base64url" = "hex") {
  return createHash("sha256").update(value).digest(encoding);
}

type DiscoveryResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

type DiscoveryRequest = (
  endpoint: URL,
  init?: import("undici").RequestInit,
) => Promise<DiscoveryResponse>;

const protectedResourceMetadataSchema = z.object({
  resource: z.string().url(),
  authorization_servers: z.array(z.string().url()).min(1),
  scopes_supported: z.array(z.string().min(1)).optional(),
});

const authorizationServerMetadataSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  code_challenge_methods_supported: z.array(z.string()).default([]),
});

export async function discoverMcpOauthConfiguration(input: {
  resource: string;
  request?: DiscoveryRequest;
}) {
  const resource = assertPublicHttpsEndpoint(input.resource);
  resource.hash = "";
  const request = input.request ?? secureDiscoveryRequest;
  const challenge = await request(resource, {
    method: "GET",
    headers: { accept: "application/json, text/event-stream" },
  });
  const authenticate = challenge.headers["www-authenticate"];
  const challengedMetadata = readBearerParameter(
    authenticate,
    "resource_metadata",
  );
  const challengedScope = readBearerParameter(authenticate, "scope");
  const metadataUrls = challengedMetadata
    ? [assertPublicHttpsEndpoint(challengedMetadata)]
    : protectedResourceMetadataUrls(resource);
  const protectedMetadata = await fetchFirstMetadata({
    urls: metadataUrls,
    request,
    schema: protectedResourceMetadataSchema,
    failure: "MCP protected resource metadata could not be discovered.",
  });
  if (new URL(protectedMetadata.resource).toString() !== resource.toString()) {
    throw new Error(
      "MCP protected resource metadata identifies another resource.",
    );
  }
  const authorizationServer = assertPublicHttpsEndpoint(
    protectedMetadata.authorization_servers[0]!,
  );
  const authorizationMetadata = await fetchFirstMetadata({
    urls: authorizationServerMetadataUrls(authorizationServer),
    request,
    schema: authorizationServerMetadataSchema,
    failure: "MCP authorization server metadata could not be discovered.",
  });
  if (
    new URL(authorizationMetadata.issuer).toString() !==
    authorizationServer.toString()
  ) {
    throw new Error("MCP authorization metadata issuer does not match.");
  }
  if (
    !authorizationMetadata.code_challenge_methods_supported.includes("S256")
  ) {
    throw new Error("MCP authorization server does not advertise PKCE S256.");
  }
  return {
    resource,
    authorizationEndpoint: assertPublicHttpsEndpoint(
      authorizationMetadata.authorization_endpoint,
    ),
    tokenEndpoint: assertPublicHttpsEndpoint(
      authorizationMetadata.token_endpoint,
    ),
    scopes:
      challengedScope?.split(/\s+/u).filter(Boolean) ??
      protectedMetadata.scopes_supported ??
      [],
  };
}

function protectedResourceMetadataUrls(resource: URL): URL[] {
  const path = resource.pathname === "/" ? "" : resource.pathname;
  return [
    ...(path
      ? [new URL(`/.well-known/oauth-protected-resource${path}`, resource)]
      : []),
    new URL("/.well-known/oauth-protected-resource", resource),
  ];
}

function authorizationServerMetadataUrls(issuer: URL): URL[] {
  const path =
    issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/u, "");
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, issuer),
    new URL(`/.well-known/openid-configuration${path}`, issuer),
    ...(path
      ? [new URL(`${path}/.well-known/openid-configuration`, issuer.origin)]
      : []),
  ];
}

async function fetchFirstMetadata<T>(input: {
  urls: URL[];
  request: DiscoveryRequest;
  schema: z.ZodType<T>;
  failure: string;
}): Promise<T> {
  for (const url of input.urls) {
    const response = await input.request(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (response.status >= 200 && response.status < 300) {
      const parsed = input.schema.safeParse(response.body);
      if (parsed.success) return parsed.data;
    }
  }
  throw new Error(input.failure);
}

function readBearerParameter(
  authenticate: string | undefined,
  parameter: string,
): string | undefined {
  if (!(authenticate && /^Bearer(?:\s|$)/iu.test(authenticate))) return;
  const match = authenticate.match(
    new RegExp(`(?:^|[,\\s])${parameter}="([^"]+)"`, "iu"),
  );
  return match?.[1];
}

async function secureDiscoveryRequest(
  endpoint: URL,
  init: import("undici").RequestInit = {},
): Promise<DiscoveryResponse> {
  const transport = await createPinnedFetch(
    assertPublicHttpsEndpoint(endpoint.toString()),
  );
  try {
    const response = await transport.fetch(endpoint, init);
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  } finally {
    await transport.close();
  }
}
async function createPinnedFetch(endpoint: URL) {
  const addresses = await dns.lookup(
    normalizeMcpResolutionHostname(endpoint.hostname),
    {
      all: true,
      verbatim: true,
    },
  );
  assertPublicMcpResolvedAddresses(
    addresses.map((item) => ({
      address: item.address,
      family: item.family as 4 | 6,
    })),
  );
  const pinned = addresses[0]!;
  const dispatcher = new Agent({
    maxRedirections: 0,
    connect: {
      lookup: (_host, _options, callback) =>
        callback(null, pinned.address, pinned.family),
    },
  });
  return {
    fetch: async (url: URL, init: import("undici").RequestInit) => {
      if (url.origin !== endpoint.origin)
        throw new Error("MCP OAuth request escaped its approved origin.");
      const response = await undiciFetch(url, {
        ...init,
        dispatcher,
        redirect: "manual",
      });
      await assertNoMcpOauthRedirect(response as unknown as Response);
      return response as unknown as Response;
    },
    close: () => dispatcher.close(),
  };
}

export async function assertNoMcpOauthRedirect(
  response: Response,
): Promise<void> {
  if (response.status < 300 || response.status >= 400) return;
  await response.body?.cancel().catch(() => {});
  throw new Error("MCP OAuth redirects are not allowed.");
}
