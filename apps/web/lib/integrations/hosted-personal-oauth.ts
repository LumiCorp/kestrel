import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  GOOGLE_WORKSPACE_PACK_SCOPES,
  GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS,
  type GoogleWorkspaceCanonicalOperation,
} from "../../../../src/apps/googleWorkspace.js";
import {
  MICROSOFT_365_OPERATION_DESCRIPTORS,
  type Microsoft365CanonicalOperation,
} from "../../../../src/apps/microsoft365.js";
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
  callbackUriForPlatformOAuthProvider,
  type PlatformOAuthProvider,
} from "@/lib/apps/platform-oauth-registrations";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { admitGmailExecutionRoute, authorizeGmailCapability } from "./gmail-policy";
import type { GmailCapability } from "./gmail-contract";
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
export type HostedPersonalOAuthPack = "gmail" | "calendar" | "outlook" | "teams";

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

function sessionBindingId(sessionId: string) {
  return `platform-personal-oauth-session:${sessionId}`;
}

function authorizationBindingId(connectionId: string) {
  return `platform-personal-oauth-authorization:${connectionId}`;
}

function personalConnectionLockKey(connectionId: string) {
  return `personal-app-connection:${connectionId}`;
}

function allowedPacks(provider: HostedPersonalOAuthProvider): HostedPersonalOAuthPack[] {
  return provider === "google_workspace" ? ["gmail", "calendar"] : ["outlook", "teams"];
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

const organizationPackPolicySchema = z.object({
  /**
   * Optional Organization App policy. When omitted, installing the App is the
   * Organization approval for its released Platform packs; when present, it
   * is an explicit narrowing ceiling for personal authorization starts.
   */
  personalOAuthPacks: z.array(z.string()).optional(),
}).passthrough();

async function requireOrganizationApprovedPacks(input: {
  organizationId: string;
  provider: HostedPersonalOAuthProvider;
  requestedPacks: readonly HostedPersonalOAuthPack[];
}) {
  const installation = await knowledgeDb.query.appInstallations.findFirst({
    where: (table, { and, eq }) => and(
      eq(table.organizationId, input.organizationId),
      eq(table.appKey, providerAppKey(input.provider)),
      eq(table.status, "installed"),
    ),
    columns: { settings: true },
  });
  if (!installation) {
    throw new HostedPersonalOAuthError("OAUTH_ORGANIZATION_DENIED", "This App is not approved by the Organization.");
  }
  const parsed = organizationPackPolicySchema.safeParse(installation.settings ?? {});
  if (!parsed.success) {
    throw new HostedPersonalOAuthError(
      "OAUTH_ORGANIZATION_POLICY_INVALID",
      "The Organization OAuth pack policy is invalid. Ask an Organization administrator to correct it.",
    );
  }
  if (parsed.data.personalOAuthPacks === undefined) return;
  const supported = allowedPacks(input.provider);
  if (!parsed.data.personalOAuthPacks.every((pack) => supported.includes(pack as HostedPersonalOAuthPack))) {
    throw new HostedPersonalOAuthError(
      "OAUTH_ORGANIZATION_POLICY_INVALID",
      "The Organization OAuth pack policy contains an unsupported capability pack.",
    );
  }
  const approved = new Set(parsed.data.personalOAuthPacks);
  if (!input.requestedPacks.every((pack) => approved.has(pack))) {
    throw new HostedPersonalOAuthError("OAUTH_ORGANIZATION_PACK_DENIED", "The Organization has not approved this OAuth capability pack.");
  }
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

function normalizeScopes(scopes: readonly string[]) {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

/**
 * Kestrel One's availability query is a hosted-only Calendar operation.  It
 * uses the released Calendar pack scope envelope but retains its own Project
 * capability instead of borrowing `calendar.events.read`.
 */
const HOSTED_GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS = [
  ...GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS,
  {
    id: "calendar.availability.read",
    pack: "calendar",
    requiredScopes: GOOGLE_WORKSPACE_PACK_SCOPES.calendar,
    serviceOperation: "availability.query",
  },
] as const;

export type HostedPersonalOAuthOperation =
  | GoogleWorkspaceCanonicalOperation
  | "availability.query"
  | Microsoft365CanonicalOperation;

/**
 * The shared operation descriptors are the only authority for a hosted
 * provider operation's capability pack and OAuth scopes.  Callers therefore
 * cannot widen a token request by asserting a more permissive pack or scope.
 */
function resolveHostedPersonalOAuthOperation(input: {
  provider: HostedPersonalOAuthProvider;
  operation: HostedPersonalOAuthOperation;
}) {
  const descriptor = (input.provider === "google_workspace"
    ? HOSTED_GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS
    : MICROSOFT_365_OPERATION_DESCRIPTORS
  ).find((candidate) => candidate.serviceOperation === input.operation);
  if (!descriptor) {
    throw new HostedPersonalOAuthError(
      "OAUTH_OPERATION_UNSUPPORTED",
      "This provider operation is not available through the hosted OAuth broker.",
    );
  }
  return {
    capabilityKey: descriptor.id,
    pack: descriptor.pack as HostedPersonalOAuthPack,
    requiredScopes: descriptor.requiredScopes,
  };
}

function scopeSetContains(granted: readonly string[], required: readonly string[]) {
  const actual = new Set(granted.map((scope) => scope.toLowerCase()));
  return required.every((scope) => actual.has(scope.toLowerCase()));
}

/**
 * An Outlook connection needs the selected mail and calendar scopes. A Teams
 * connection needs chat read. Sending remains optional because Microsoft
 * tenant-admin consent for ChatMessage.Send can be absent while chat reads
 * remain available.
 */
function requireMinimumConnectionScopes(input: {
  provider: HostedPersonalOAuthProvider;
  packs: readonly HostedPersonalOAuthPack[];
  grantedScopes: readonly string[];
}) {
  if (input.provider !== "microsoft_365") return;
  if (input.packs.includes("outlook")) {
    const outlookScopes = ["Mail.Read", "Mail.Send", "Calendars.Read"];
    if (!scopeSetContains(input.grantedScopes, outlookScopes)) {
      throw new HostedPersonalOAuthError(
        "OAUTH_CONNECTION_SCOPE_DENIED",
        "Outlook permissions were not fully granted. Reconnect and approve Mail.Read, Mail.Send, and Calendars.Read.",
      );
    }
  }
  if (!input.packs.includes("teams")) return;
  const teamsRead = resolveHostedPersonalOAuthOperation({
    provider: input.provider,
    operation: "chats.list",
  });
  if (!scopeSetContains(input.grantedScopes, teamsRead.requiredScopes)) {
    throw new HostedPersonalOAuthError(
      "OAUTH_CONNECTION_SCOPE_DENIED",
      "Teams chat read permission was not granted. Reconnect and approve Chat.Read.",
    );
  }
}

/**
 * Identity and refresh protocol scopes are not capability authority. Provider
 * refresh responses commonly omit them, so scope-retention decisions must use
 * only the descriptor-defined scopes for the connection's selected packs.
 */
function selectedPackCapabilityScopes(input: {
  provider: HostedPersonalOAuthProvider;
  packs: readonly string[];
}) {
  const selected = new Set(input.packs);
  const descriptors = input.provider === "google_workspace"
    ? GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS
    : MICROSOFT_365_OPERATION_DESCRIPTORS;
  return normalizeScopes(descriptors
    .filter((descriptor) => selected.has(descriptor.pack))
    .flatMap((descriptor) => descriptor.requiredScopes));
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
  await requireOrganizationApprovedPacks({
    organizationId: input.organizationId,
    provider: input.provider,
    requestedPacks: packs,
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
  url.searchParams.set(
    "redirect_uri",
    callbackUriForPlatformOAuthProvider(input.provider, input.env),
  );
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

function resourcesForProvider(provider: HostedPersonalOAuthProvider) {
  return provider === "google_workspace"
    ? [
        { externalId: "primary", resourceType: "calendar", label: "Primary calendar" },
        { externalId: "primary", resourceType: "account", label: "Primary account" },
      ]
    : [{ externalId: "primary", resourceType: "account", label: "Primary account" }];
}

export async function completeHostedPersonalAuthorization(input: {
  provider: HostedPersonalOAuthProvider;
  sessionId: string;
  userId: string;
  code: string;
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
  await requireOrganizationApprovedPacks({
    organizationId: session.organizationId,
    provider: input.provider,
    requestedPacks: packs,
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
      redirect_uri: callbackUriForPlatformOAuthProvider(input.provider, input.env),
      code_verifier: verifier,
    },
    fetchImpl: input.fetchImpl,
  });
  const grantedScopes = normalizeScopes((exchanged.scope ?? "").split(/[\s,]+/u));
  if (!grantedScopes.length) {
    throw new HostedPersonalOAuthError("OAUTH_GRANTED_SCOPES_MISSING", "The OAuth provider did not report the granted scopes.");
  }
  requireMinimumConnectionScopes({
    provider: input.provider,
    packs,
    grantedScopes,
  });
  const identity = await providerIdentity({ provider: input.provider, accessToken: exchanged.access_token, fetchImpl: input.fetchImpl });
  const now = new Date();
  const expiresAt = exchanged.expires_in ? new Date(now.getTime() + exchanged.expires_in * 1000) : null;
  const tokenPayload = JSON.stringify({
    accessToken: exchanged.access_token,
    refreshToken: exchanged.refresh_token ?? null,
    tokenType: exchanged.token_type ?? null,
  });
  // The provider exchange is intentionally outside the database transaction.
  // Recheck the Organization ceiling immediately before its token can become
  // durable, so a policy narrowing during consent cannot persist authority
  // that is no longer approved.
  await requireOrganizationApprovedPacks({
    organizationId: session.organizationId,
    provider: input.provider,
    requestedPacks: packs,
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
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${personalConnectionLockKey(connectionId)}, 0))`,
    );
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
    for (const resource of resourcesForProvider(input.provider)) {
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
    }
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

export async function markHostedPersonalAuthorizationDegraded(input: {
  connectionId: string;
  code: string;
}) {
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${personalConnectionLockKey(input.connectionId)}, 0))`,
    );
    await transaction.update(schema.platformPersonalOAuthAuthorizations)
      .set({ reconnectRequired: true, failureCode: input.code, updatedAt: now })
      .where(eq(schema.platformPersonalOAuthAuthorizations.connectionId, input.connectionId));
    await transaction.update(schema.appConnections)
      .set({ status: "degraded", failureCode: input.code, failureMessage: safeFailureMessage(), updatedAt: now })
      .where(eq(schema.appConnections.id, input.connectionId));
  });
}

/**
 * Refresh and every connection lifecycle transition use the connection lock.
 * A reconnect or disconnect therefore cannot interleave with a refresh and
 * leave a stale refresh result durable.
 */
async function refreshHostedPersonalProviderToken(input: {
  provider: HostedPersonalOAuthProvider;
  connectionId: string;
  registration: Awaited<ReturnType<typeof requireActivePlatformOAuthRegistration>>;
  requiredScopes: readonly string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}) {
  const result = await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${personalConnectionLockKey(input.connectionId)}, 0))`,
    );
    const degrade = async (code: string) => {
      const now = new Date();
      await transaction.update(schema.platformPersonalOAuthAuthorizations)
        .set({ reconnectRequired: true, failureCode: code, updatedAt: now })
        .where(eq(schema.platformPersonalOAuthAuthorizations.connectionId, input.connectionId));
      await transaction.update(schema.appConnections)
        .set({ status: "degraded", failureCode: code, failureMessage: safeFailureMessage(), updatedAt: now })
        .where(eq(schema.appConnections.id, input.connectionId));
      return { kind: "reconnect" as const };
    };
    const authorization = await transaction.query.platformPersonalOAuthAuthorizations.findFirst({
      where: (table, { eq }) => eq(table.connectionId, input.connectionId),
    });
    if (!authorization || authorization.provider !== input.provider) {
      throw new HostedPersonalOAuthError("OAUTH_CONNECTION_DENIED", "This personal OAuth connection is not available.");
    }
    if (authorization.reconnectRequired || authorization.registrationRevision !== input.registration.revision) {
      return degrade("OAUTH_RECONNECT_REQUIRED");
    }
    let payload: z.infer<typeof tokenPayloadSchema>;
    try {
      payload = tokenPayloadSchema.parse(JSON.parse(decryptGatewayCredential({
        gatewayId: authorizationBindingId(input.connectionId),
        encrypted: authorization.encryptedTokenPayload,
        env: input.env,
      })));
    } catch {
      return degrade("OAUTH_TOKEN_UNREADABLE");
    }
    if (!scopeSetContains(authorization.grantedScopes, input.requiredScopes)) {
      return degrade("OAUTH_SCOPE_DENIED");
    }
    if (!authorization.expiresAt || authorization.expiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return { kind: "success" as const, accessToken: payload.accessToken, expiresAt: authorization.expiresAt };
    }
    if (!payload.refreshToken) {
      return degrade("OAUTH_REFRESH_UNAVAILABLE");
    }
    let refreshed: z.infer<typeof tokenResponseSchema>;
    try {
      refreshed = await tokenRequest({
        provider: input.provider,
        tokenEndpoint: authorizationEndpoints(input.registration).token,
        clientId: input.registration.clientId,
        clientSecret: input.registration.clientSecret,
        fields: { grant_type: "refresh_token", refresh_token: payload.refreshToken },
        fetchImpl: input.fetchImpl,
      });
    } catch {
      return degrade("OAUTH_REFRESH_FAILED");
    }
    const now = new Date();
    const expiresAt = refreshed.expires_in ? new Date(now.getTime() + refreshed.expires_in * 1000) : null;
    const grantedScopes = refreshed.scope === undefined
      ? authorization.grantedScopes
      : normalizeScopes(refreshed.scope.split(/[\s,]+/u));
    // A connection's authority is its previously granted selected-pack scope
    // envelope, not only the operation that happened to trigger this refresh.
    // Exclude incidental identity/refresh scopes because providers may omit
    // those from refresh responses without reducing App capability authority.
    const selectedPackScopeSet = new Set(
      selectedPackCapabilityScopes({
        provider: input.provider,
        packs: authorization.selectedPacks,
      }).map((scope) => scope.toLowerCase()),
    );
    const previouslyGrantedCapabilityScopes = authorization.grantedScopes.filter(
      (scope) => selectedPackScopeSet.has(scope.toLowerCase()),
    );
    const retainedGrantedScopeEnvelope = scopeSetContains(
      grantedScopes,
      previouslyGrantedCapabilityScopes,
    );
    const nextPayload = JSON.stringify({
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? payload.refreshToken,
      tokenType: refreshed.token_type ?? payload.tokenType,
    });
    await transaction.update(schema.platformPersonalOAuthAuthorizations).set({
      encryptedTokenPayload: encryptGatewayCredential({ gatewayId: authorizationBindingId(input.connectionId), plaintext: nextPayload, env: input.env }),
      expiresAt,
      grantedScopes,
      lastRefreshedAt: now,
      failureCode: retainedGrantedScopeEnvelope ? null : "OAUTH_SCOPE_REDUCED",
      reconnectRequired: !retainedGrantedScopeEnvelope,
      updatedAt: now,
    }).where(eq(schema.platformPersonalOAuthAuthorizations.connectionId, input.connectionId));
    await transaction.update(schema.appConnections).set({
      scopes: grantedScopes,
      status: retainedGrantedScopeEnvelope ? "connected" : "degraded",
      failureCode: retainedGrantedScopeEnvelope ? null : "OAUTH_SCOPE_REDUCED",
      failureMessage: retainedGrantedScopeEnvelope ? null : safeFailureMessage(),
      lastHealthAt: now,
      updatedAt: now,
    }).where(eq(schema.appConnections.id, input.connectionId));
    if (!retainedGrantedScopeEnvelope) {
      return { kind: "reconnect" as const };
    }
    return { kind: "success" as const, accessToken: refreshed.access_token, expiresAt };
  });
  if (result.kind === "reconnect") {
    throw new HostedPersonalOAuthError("OAUTH_RECONNECT_REQUIRED", "Reconnect this App to restore access.");
  }
  return result;
}

/**
 * Internal-only provider token boundary. Runtime callers identify one shared
 * operation; this boundary derives its pack, scope, capability, and (for
 * Gmail) restricted-data admission itself. Provider tokens never depend on
 * caller-supplied authorization claims.
 */
export async function resolveHostedPersonalProviderToken(input: {
  provider: HostedPersonalOAuthProvider;
  connectionId: string;
  organizationId: string;
  userId: string;
  projectId: string;
  operation: HostedPersonalOAuthOperation;
  /** Required only for canonical Gmail operations. The ticket is verified by
   * the existing Gmail model-admission boundary; it is not an authorization
   * assertion supplied by a caller. */
  gmailExecution?: Parameters<typeof admitGmailExecutionRoute>[0]["ticket"];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}) {
  const operation = resolveHostedPersonalOAuthOperation({
    provider: input.provider,
    operation: input.operation,
  });
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
  await requireOrganizationApprovedPacks({
    organizationId: input.organizationId,
    provider: input.provider,
    requestedPacks: [operation.pack],
  });
  if (!access.capabilities.some((capability) => capability.key === operation.capabilityKey)) {
    throw new HostedPersonalOAuthError("OAUTH_OPERATION_DENIED", "This OAuth operation is not enabled for the Project.");
  }
  if (!allowedPacks(input.provider).includes(operation.pack) || !authorization.selectedPacks.includes(operation.pack)) {
    throw new HostedPersonalOAuthError("OAUTH_PACK_DENIED", "This OAuth capability pack was not selected for the connection.");
  }
  if (authorization.reconnectRequired || authorization.registrationRevision !== registration.revision) {
    await markHostedPersonalAuthorizationDegraded({ connectionId: input.connectionId, code: "OAUTH_RECONNECT_REQUIRED" });
    throw new HostedPersonalOAuthError("OAUTH_RECONNECT_REQUIRED", "Reconnect this App after the Platform OAuth registration changed.");
  }
  if (!scopeSetContains(authorization.grantedScopes, operation.requiredScopes)) {
    throw new HostedPersonalOAuthError("OAUTH_SCOPE_DENIED", "The connection does not grant the required OAuth scope.");
  }
  if (input.provider === "google_workspace" && operation.pack === "gmail") {
    if (!input.gmailExecution) {
      throw new HostedPersonalOAuthError("OAUTH_MODEL_ADMISSION_REQUIRED", "Gmail requires an active Kestrel One execution route.");
    }
    let gmailPolicy: Awaited<ReturnType<typeof authorizeGmailCapability>>;
    try {
      gmailPolicy = await authorizeGmailCapability({
        ticket: input.gmailExecution,
        capability: operation.capabilityKey as GmailCapability,
      });
    } catch {
      throw new HostedPersonalOAuthError("OAUTH_GMAIL_EXECUTION_DENIED", "The active Kestrel One execution route is not authorized for Gmail.");
    }
    if (gmailPolicy.projectId !== input.projectId || gmailPolicy.connection.id !== input.connectionId) {
      throw new HostedPersonalOAuthError("OAUTH_GMAIL_EXECUTION_DENIED", "The active Kestrel One execution route is not authorized for this Gmail connection.");
    }
    try {
      await admitGmailExecutionRoute({
        ticket: input.gmailExecution,
        projectAuthorized: true,
        gmailReadonlyGranted: scopeSetContains(authorization.grantedScopes, [
          "https://www.googleapis.com/auth/gmail.readonly",
        ]),
      });
    } catch {
      throw new HostedPersonalOAuthError("OAUTH_MODEL_ADMISSION_DENIED", "The active Kestrel One execution route is not admitted for Gmail.");
    }
  }
  let payload: z.infer<typeof tokenPayloadSchema>;
  try {
    payload = tokenPayloadSchema.parse(JSON.parse(decryptGatewayCredential({
      gatewayId: authorizationBindingId(input.connectionId),
      encrypted: authorization.encryptedTokenPayload,
      env: input.env,
    })));
  } catch {
    await markHostedPersonalAuthorizationDegraded({ connectionId: input.connectionId, code: "OAUTH_TOKEN_UNREADABLE" });
    throw new HostedPersonalOAuthError("OAUTH_RECONNECT_REQUIRED", "Reconnect this App to restore access.");
  }
  if (!authorization.expiresAt || authorization.expiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return { accessToken: payload.accessToken, expiresAt: authorization.expiresAt };
  }
  if (!payload.refreshToken) {
    await markHostedPersonalAuthorizationDegraded({ connectionId: input.connectionId, code: "OAUTH_REFRESH_UNAVAILABLE" });
    throw new HostedPersonalOAuthError("OAUTH_RECONNECT_REQUIRED", "Reconnect this App to restore access.");
  }
  return refreshHostedPersonalProviderToken({
    provider: input.provider,
    connectionId: input.connectionId,
    registration,
    requiredScopes: operation.requiredScopes,
    env: input.env,
    fetchImpl: input.fetchImpl,
  });
}

export function parseHostedPersonalOAuthProvider(value: string) {
  const provider = value === "google-workspace" ? "google_workspace" : value === "microsoft-365" ? "microsoft_365" : value;
  if (!isPlatformOAuthProvider(provider)) {
    throw new HostedPersonalOAuthError("OAUTH_PROVIDER_UNSUPPORTED", "This OAuth provider is not supported.");
  }
  return provider;
}
