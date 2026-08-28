import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ensureCoreAppCatalog, requireInstalledAppForOrganization } from "@/lib/apps/service";
import { resolveEffectiveProjectAppAccess } from "@/lib/apps/project-service";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
} from "@/lib/ai/gateway-credential-crypto";
import {
  isPlatformOAuthProvider,
  requireActivePlatformOAuthRegistration,
  scopesForPlatformOAuthRegistration,
  type PlatformOAuthProvider,
} from "@/lib/apps/platform-oauth-registrations";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getGoogleUserInfo } from "./google-calendar-api";
import { getMicrosoftIdentity } from "./microsoft-365-oauth";

const SESSION_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const RETURN_TARGET = "settings_connections";

const tokenPayloadSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  tokenType: z.string().min(1).nullable(),
}).strict();

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().min(1).optional(),
  expires_in: z.number().finite().positive().optional(),
  scope: z.string().optional(),
}).passthrough();

export type HostedPersonalOAuthProvider = PlatformOAuthProvider;
export type HostedPersonalOAuthPack = "gmail" | "calendar" | "teams";

export class HostedPersonalOAuthError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "HostedPersonalOAuthError";
  }
}

type FetchLike = typeof fetch;

function providerAppKey(provider: HostedPersonalOAuthProvider) {
  return provider;
}

function providerPath(provider: HostedPersonalOAuthProvider) {
  return provider === "google_workspace" ? "google-workspace" : "microsoft-365";
}

function sessionBindingId(sessionId: string) {
  return `platform-personal-oauth-session:${sessionId}`;
}

function authorizationBindingId(connectionId: string) {
  return `platform-personal-oauth-authorization:${connectionId}`;
}

function allowedPacks(provider: HostedPersonalOAuthProvider): HostedPersonalOAuthPack[] {
  return provider === "google_workspace" ? ["gmail", "calendar"] : ["teams"];
}

function normalizePacks(input: {
  provider: HostedPersonalOAuthProvider;
  packs: readonly string[];
  platformPacks: readonly string[];
}) {
  const allowed = allowedPacks(input.provider);
  const requested = [...new Set(input.packs)];
  if (!requested.length || !requested.every((pack) => allowed.includes(pack as HostedPersonalOAuthPack))) {
    throw new HostedPersonalOAuthError("OAUTH_PACK_UNSUPPORTED", "The requested OAuth capability pack is not available.");
  }
  if (!requested.every((pack) => input.platformPacks.includes(pack))) {
    throw new HostedPersonalOAuthError("OAUTH_PACK_NOT_ENABLED", "The requested OAuth capability pack is not enabled by the Platform Admin.");
  }
  return allowed.filter((pack) => requested.includes(pack));
}

function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

function authorizationEndpoints(registration: {
  provider: HostedPersonalOAuthProvider;
  tenantOrIssuer: string | null;
}) {
  if (registration.provider === "google_workspace") {
    return {
      authorization: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
    };
  }
  const tenant = registration.tenantOrIssuer ?? "organizations";
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
  return { authorization: `${base}/authorize`, token: `${base}/token` };
}

function callbackUri(provider: HostedPersonalOAuthProvider, origin: string) {
  return new URL(`/api/integrations/oauth/${providerPath(provider)}/callback`, origin).toString();
}

function normalizeScopes(scopes: readonly string[]) {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

function scopeSetContains(granted: readonly string[], required: readonly string[]) {
  const actual = new Set(granted.map((scope) => scope.toLowerCase()));
  return required.every((scope) => actual.has(scope.toLowerCase()));
}

function safeFailureMessage() {
  return "Reconnect this App to restore access.";
}

/** Pure and intentionally redacted connection health projection. */
export function publicHostedPersonalOAuthHealth(input: {
  status: "connected" | "degraded" | "disconnected";
  reconnectRequired: boolean;
  failureCode: string | null;
  registrationRevision: number;
}) {
  return {
    status: input.status,
    reconnectRequired: input.reconnectRequired,
    failureCode: input.failureCode,
    registrationRevision: input.registrationRevision,
  };
}

export async function startHostedPersonalAuthorization(input: {
  provider: HostedPersonalOAuthProvider;
  organizationId: string;
  userId: string;
  packs: readonly string[];
  origin: string;
  env?: NodeJS.ProcessEnv;
}) {
  await ensureCoreAppCatalog();
  await requireInstalledAppForOrganization({
    organizationId: input.organizationId,
    appKey: providerAppKey(input.provider),
  });
  const registration = await requireActivePlatformOAuthRegistration(input.provider, input.env);
  const packs = normalizePacks({
    provider: input.provider,
    packs: input.packs,
    platformPacks: registration.enabledPacks,
  });
  const existing = await knowledgeDb.query.appConnections.findFirst({
    where: (table, { and, eq }) => and(
      eq(table.organizationId, input.organizationId),
      eq(table.appKey, providerAppKey(input.provider)),
      eq(table.ownerType, "personal"),
      eq(table.userId, input.userId),
    ),
    columns: { id: true },
  });
  const { verifier, challenge } = pkcePair();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await knowledgeDb.insert(schema.platformPersonalOAuthAuthorizationSessions).values({
    id,
    provider: input.provider,
    organizationId: input.organizationId,
    userId: input.userId,
    appKey: providerAppKey(input.provider),
    connectionId: existing?.id ?? null,
    selectedPacks: packs,
    registrationRevision: registration.revision,
    encryptedPkceVerifier: encryptGatewayCredential({
      gatewayId: sessionBindingId(id),
      plaintext: verifier,
      env: input.env,
    }),
    returnTarget: RETURN_TARGET,
    expiresAt,
  });
  const endpoint = authorizationEndpoints(registration);
  const url = new URL(endpoint.authorization);
  url.searchParams.set("client_id", registration.clientId);
  url.searchParams.set("redirect_uri", callbackUri(input.provider, input.origin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopesForPlatformOAuthRegistration({ provider: input.provider, packs }).join(" "));
  url.searchParams.set("state", id);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.provider === "google_workspace") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return { authorizationUrl: url.toString(), expiresAt };
}

async function consumeAuthorizationSession(input: {
  provider: HostedPersonalOAuthProvider;
  sessionId: string;
  userId: string;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    const [session] = await transaction
      .select()
      .from(schema.platformPersonalOAuthAuthorizationSessions)
      .where(and(
        eq(schema.platformPersonalOAuthAuthorizationSessions.id, input.sessionId),
        eq(schema.platformPersonalOAuthAuthorizationSessions.provider, input.provider),
      ))
      .for("update");
    if (!session || session.userId !== input.userId) {
      throw new HostedPersonalOAuthError("OAUTH_SESSION_DENIED", "This OAuth authorization is not available to the current user.");
    }
    if (session.consumedAt) {
      throw new HostedPersonalOAuthError("OAUTH_SESSION_USED", "This OAuth authorization was already completed.");
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new HostedPersonalOAuthError("OAUTH_SESSION_EXPIRED", "This OAuth authorization expired. Start again.");
    }
    if (session.returnTarget !== RETURN_TARGET) {
      throw new HostedPersonalOAuthError("OAUTH_RETURN_TARGET_INVALID");
    }
    await transaction
      .update(schema.platformPersonalOAuthAuthorizationSessions)
      .set({ consumedAt: new Date() })
      .where(eq(schema.platformPersonalOAuthAuthorizationSessions.id, session.id));
    return session;
  });
}

async function tokenRequest(input: {
  provider: HostedPersonalOAuthProvider;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  fields: Record<string, string>;
  fetchImpl?: FetchLike;
}) {
  const form = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    ...input.fields,
  });
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(input.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      cache: "no-store",
    });
  } catch {
    throw new HostedPersonalOAuthError("OAUTH_PROVIDER_UNAVAILABLE", "The OAuth provider could not be reached.");
  }
  if (!response.ok) {
    throw new HostedPersonalOAuthError("OAUTH_TOKEN_EXCHANGE_FAILED", "The OAuth provider did not accept this authorization.");
  }
  try {
    return tokenResponseSchema.parse(await response.json());
  } catch {
    throw new HostedPersonalOAuthError("OAUTH_TOKEN_RESPONSE_INVALID", "The OAuth provider returned an invalid token response.");
  }
}

async function providerIdentity(input: {
  provider: HostedPersonalOAuthProvider;
  accessToken: string;
  fetchImpl?: FetchLike;
}) {
  if (input.provider === "google_workspace") {
    const identity = await getGoogleUserInfo({ accessToken: input.accessToken, fetchImpl: input.fetchImpl });
    return { id: identity.sub, label: identity.email ?? identity.sub };
  }
  const identity = await getMicrosoftIdentity({ accessToken: input.accessToken, fetchImpl: input.fetchImpl });
  return {
    id: identity.sub,
    label: identity.email ?? identity.preferred_username ?? identity.name ?? identity.sub,
  };
}

function resourceForProvider(provider: HostedPersonalOAuthProvider) {
  return provider === "google_workspace"
    ? { externalId: "primary", resourceType: "calendar", label: "Primary calendar" }
    : { externalId: "primary", resourceType: "account", label: "Primary account" };
}

export async function completeHostedPersonalAuthorization(input: {
  provider: HostedPersonalOAuthProvider;
  sessionId: string;
  userId: string;
  code: string;
  origin: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}) {
  const session = await consumeAuthorizationSession(input);
  const registration = await requireActivePlatformOAuthRegistration(input.provider, input.env);
  if (registration.revision !== session.registrationRevision) {
    throw new HostedPersonalOAuthError("OAUTH_REGISTRATION_CHANGED", "The Platform OAuth registration changed. Start authorization again.");
  }
  const packs = normalizePacks({
    provider: input.provider,
    packs: session.selectedPacks,
    platformPacks: registration.enabledPacks,
  });
  const verifier = decryptGatewayCredential({
    gatewayId: sessionBindingId(session.id),
    encrypted: session.encryptedPkceVerifier,
    env: input.env,
  });
  const endpoint = authorizationEndpoints(registration);
  const exchanged = await tokenRequest({
    provider: input.provider,
    tokenEndpoint: endpoint.token,
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
    fields: {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: callbackUri(input.provider, input.origin),
      code_verifier: verifier,
    },
    fetchImpl: input.fetchImpl,
  });
  const grantedScopes = normalizeScopes((exchanged.scope ?? "").split(/[\s,]+/u));
  if (!grantedScopes.length) {
    throw new HostedPersonalOAuthError("OAUTH_GRANTED_SCOPES_MISSING", "The OAuth provider did not report the granted scopes.");
  }
  const identity = await providerIdentity({ provider: input.provider, accessToken: exchanged.access_token, fetchImpl: input.fetchImpl });
  const now = new Date();
  const expiresAt = exchanged.expires_in ? new Date(now.getTime() + exchanged.expires_in * 1000) : null;
  const tokenPayload = JSON.stringify({
    accessToken: exchanged.access_token,
    refreshToken: exchanged.refresh_token ?? null,
    tokenType: exchanged.token_type ?? null,
  });
  const connection = await knowledgeDb.transaction(async (transaction) => {
    const existing = session.connectionId
      ? await transaction.query.appConnections.findFirst({
          where: (table, { and, eq }) => and(
            eq(table.id, session.connectionId!),
            eq(table.organizationId, session.organizationId),
            eq(table.appKey, session.appKey),
            eq(table.ownerType, "personal"),
            eq(table.userId, session.userId),
          ),
        })
      : await transaction.query.appConnections.findFirst({
          where: (table, { and, eq }) => and(
            eq(table.organizationId, session.organizationId),
            eq(table.appKey, session.appKey),
            eq(table.ownerType, "personal"),
            eq(table.userId, session.userId),
          ),
        });
    const connectionId = existing?.id ?? crypto.randomUUID();
    const [saved] = await transaction
      .insert(schema.appConnections)
      .values({
        id: connectionId,
        organizationId: session.organizationId,
        appKey: session.appKey,
        ownerType: "personal",
        userId: session.userId,
        authAccountId: null,
        name: `Kestrel One ${input.provider}`,
        status: "connected",
        externalAccountId: identity.id,
        externalAccountLabel: identity.label,
        scopes: grantedScopes,
        deliveryConfig: { capabilityPacks: packs },
        failureCode: null,
        failureMessage: null,
        disconnectedAt: null,
        lastHealthAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.appConnections.id,
        set: {
          authAccountId: null,
          name: `Kestrel One ${input.provider}`,
          status: "connected",
          externalAccountId: identity.id,
          externalAccountLabel: identity.label,
          scopes: grantedScopes,
          deliveryConfig: { capabilityPacks: packs },
          failureCode: null,
          failureMessage: null,
          disconnectedAt: null,
          lastHealthAt: now,
          updatedAt: now,
        },
      })
      .returning();
    if (!saved) throw new HostedPersonalOAuthError("OAUTH_CONNECTION_SAVE_FAILED");
    await transaction
      .insert(schema.platformPersonalOAuthAuthorizations)
      .values({
        connectionId,
        provider: input.provider,
        providerAccountId: identity.id,
        selectedPacks: packs,
        grantedScopes,
        encryptedTokenPayload: encryptGatewayCredential({ gatewayId: authorizationBindingId(connectionId), plaintext: tokenPayload, env: input.env }),
        expiresAt,
        registrationRevision: registration.revision,
        reconnectRequired: false,
        failureCode: null,
        lastRefreshedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.platformPersonalOAuthAuthorizations.connectionId,
        set: {
          provider: input.provider,
          providerAccountId: identity.id,
          selectedPacks: packs,
          grantedScopes,
          encryptedTokenPayload: encryptGatewayCredential({ gatewayId: authorizationBindingId(connectionId), plaintext: tokenPayload, env: input.env }),
          expiresAt,
          registrationRevision: registration.revision,
          reconnectRequired: false,
          failureCode: null,
          lastRefreshedAt: now,
          updatedAt: now,
        },
      });
    const resource = resourceForProvider(input.provider);
    await transaction.insert(schema.appConnectionResources).values({
      id: `${connectionId}:${resource.resourceType}`,
      connectionId,
      ...resource,
      enabled: true,
      permissions: {},
      metadata: { logical: true },
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [schema.appConnectionResources.connectionId, schema.appConnectionResources.resourceType, schema.appConnectionResources.externalId],
      set: { label: resource.label, enabled: true, updatedAt: now },
    });
    return saved;
  });
  return {
    connectionId: connection.id,
    health: publicHostedPersonalOAuthHealth({
      status: connection.status,
      reconnectRequired: false,
      failureCode: null,
      registrationRevision: registration.revision,
    }),
  };
}

async function markAuthorizationDegraded(input: { connectionId: string; code: string }) {
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.update(schema.platformPersonalOAuthAuthorizations)
      .set({ reconnectRequired: true, failureCode: input.code, updatedAt: now })
      .where(eq(schema.platformPersonalOAuthAuthorizations.connectionId, input.connectionId));
    await transaction.update(schema.appConnections)
      .set({ status: "degraded", failureCode: input.code, failureMessage: safeFailureMessage(), updatedAt: now })
      .where(eq(schema.appConnections.id, input.connectionId));
  });
}

/**
 * Internal-only provider token boundary. Runtime callers must supply their
 * owned model-admission assertion; the resolver invokes it before returning a
 * token, so a connection alone cannot bypass the model/data policy.
 */
export async function resolveHostedPersonalProviderToken(input: {
  provider: HostedPersonalOAuthProvider;
  connectionId: string;
  organizationId: string;
  userId: string;
  projectId: string;
  pack: HostedPersonalOAuthPack;
  requiredScopes: readonly string[];
  assertModelAdmission: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}) {
  const registration = await requireActivePlatformOAuthRegistration(input.provider, input.env);
  const [connection, authorization, access] = await Promise.all([
    knowledgeDb.query.appConnections.findFirst({
      where: (table, { and, eq }) => and(
        eq(table.id, input.connectionId),
        eq(table.organizationId, input.organizationId),
        eq(table.appKey, providerAppKey(input.provider)),
        eq(table.ownerType, "personal"),
        eq(table.userId, input.userId),
        inArray(table.status, ["connected", "degraded"]),
      ),
    }),
    knowledgeDb.query.platformPersonalOAuthAuthorizations.findFirst({
      where: (table, { eq }) => eq(table.connectionId, input.connectionId),
    }),
    resolveEffectiveProjectAppAccess({
      organizationId: input.organizationId,
      projectId: input.projectId,
      appKey: providerAppKey(input.provider),
      userId: input.userId,
    }),
  ]);
  if (!connection || !authorization || authorization.provider !== input.provider) {
    throw new HostedPersonalOAuthError("OAUTH_CONNECTION_DENIED", "This personal OAuth connection is not available.");
  }
  if (access?.connectionId !== input.connectionId) {
    throw new HostedPersonalOAuthError("OAUTH_PROJECT_DENIED", "This OAuth connection is not granted to the Project.");
  }
  if (!allowedPacks(input.provider).includes(input.pack) || !authorization.selectedPacks.includes(input.pack)) {
    throw new HostedPersonalOAuthError("OAUTH_PACK_DENIED", "This OAuth capability pack was not selected for the connection.");
  }
  if (!input.requiredScopes.length) {
    throw new HostedPersonalOAuthError("OAUTH_SCOPE_REQUIRED", "A provider operation must declare its required OAuth scopes.");
  }
  if (!scopeSetContains(authorization.grantedScopes, input.requiredScopes)) {
    throw new HostedPersonalOAuthError("OAUTH_SCOPE_DENIED", "The connection does not grant the required OAuth scope.");
  }
  if (authorization.reconnectRequired || authorization.registrationRevision !== registration.revision) {
    await markAuthorizationDegraded({ connectionId: input.connectionId, code: "OAUTH_RECONNECT_REQUIRED" });
    throw new HostedPersonalOAuthError("OAUTH_RECONNECT_REQUIRED", "Reconnect this App after the Platform OAuth registration changed.");
  }
  await input.assertModelAdmission();
  let payload: z.infer<typeof tokenPayloadSchema>;
  try {
    payload = tokenPayloadSchema.parse(JSON.parse(decryptGatewayCredential({
      gatewayId: authorizationBindingId(input.connectionId),
      encrypted: authorization.encryptedTokenPayload,
      env: input.env,
    })));
  } catch {
    await markAuthorizationDegraded({ connectionId: input.connectionId, code: "OAUTH_TOKEN_UNREADABLE" });
    throw new HostedPersonalOAuthError("OAUTH_RECONNECT_REQUIRED", "Reconnect this App to restore access.");
  }
  if (!authorization.expiresAt || authorization.expiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return { accessToken: payload.accessToken, expiresAt: authorization.expiresAt };
  }
  if (!payload.refreshToken) {
    await markAuthorizationDegraded({ connectionId: input.connectionId, code: "OAUTH_REFRESH_UNAVAILABLE" });
    throw new HostedPersonalOAuthError("OAUTH_RECONNECT_REQUIRED", "Reconnect this App to restore access.");
  }
  let refreshed: z.infer<typeof tokenResponseSchema>;
  try {
    refreshed = await tokenRequest({
      provider: input.provider,
      tokenEndpoint: authorizationEndpoints(registration).token,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      fields: { grant_type: "refresh_token", refresh_token: payload.refreshToken },
      fetchImpl: input.fetchImpl,
    });
  } catch {
    await markAuthorizationDegraded({ connectionId: input.connectionId, code: "OAUTH_REFRESH_FAILED" });
    throw new HostedPersonalOAuthError("OAUTH_RECONNECT_REQUIRED", "Reconnect this App to restore access.");
  }
  const now = new Date();
  const expiresAt = refreshed.expires_in ? new Date(now.getTime() + refreshed.expires_in * 1000) : null;
  const nextPayload = JSON.stringify({
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? payload.refreshToken,
    tokenType: refreshed.token_type ?? payload.tokenType,
  });
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.update(schema.platformPersonalOAuthAuthorizations).set({
      encryptedTokenPayload: encryptGatewayCredential({ gatewayId: authorizationBindingId(input.connectionId), plaintext: nextPayload, env: input.env }),
      expiresAt,
      lastRefreshedAt: now,
      failureCode: null,
      reconnectRequired: false,
      updatedAt: now,
    }).where(eq(schema.platformPersonalOAuthAuthorizations.connectionId, input.connectionId));
    await transaction.update(schema.appConnections).set({
      status: "connected",
      failureCode: null,
      failureMessage: null,
      lastHealthAt: now,
      updatedAt: now,
    }).where(eq(schema.appConnections.id, input.connectionId));
  });
  return { accessToken: refreshed.access_token, expiresAt };
}

export function parseHostedPersonalOAuthProvider(value: string) {
  const provider = value === "google-workspace" ? "google_workspace" : value === "microsoft-365" ? "microsoft_365" : value;
  if (!isPlatformOAuthProvider(provider)) {
    throw new HostedPersonalOAuthError("OAUTH_PROVIDER_UNSUPPORTED", "This OAuth provider is not supported.");
  }
  return provider;
}
