import { eq } from "drizzle-orm";
import {
  GOOGLE_WORKSPACE_PACK_SCOPES,
  scopesForGoogleWorkspacePacks,
  type GoogleWorkspacePack,
} from "../../../../src/apps/googleWorkspace.js";
import {
  MICROSOFT_365_PACK_SCOPES,
  scopesForMicrosoft365Packs,
  type Microsoft365Pack,
} from "../../../../src/apps/microsoft365.js";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
} from "@/lib/ai/gateway-credential-crypto";
import { resolveKestrelAppUrl } from "@/lib/app-url";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export const PLATFORM_OAUTH_PROVIDERS = [
  "google_workspace",
  "microsoft_365",
] as const;
export type PlatformOAuthProvider = (typeof PLATFORM_OAUTH_PROVIDERS)[number];

export type PlatformOAuthRegistrationStatus =
  | "not_configured"
  | "disabled"
  | "ready";

type SupportedPack = GoogleWorkspacePack | "teams";

const OAUTH_SECRET_BINDING_PREFIX = "platform-oauth-registration";

export class PlatformOAuthRegistrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PlatformOAuthRegistrationError";
    this.code = code;
  }
}

export type PublicPlatformOAuthRegistration = {
  provider: PlatformOAuthProvider;
  displayName: string;
  enabled: boolean;
  clientId: string | null;
  tenantOrIssuer: string | null;
  enabledPacks: SupportedPack[];
  supportedPacks: Array<{
    id: SupportedPack;
    label: string;
    scopes: string[];
  }>;
  callbackUri: string;
  baseScopes: string[];
  scopes: string[];
  status: PlatformOAuthRegistrationStatus;
  credentialConfigured: boolean;
  revision: number | null;
  persisted: boolean;
  updatedAt: Date | null;
};

export type ActivePlatformOAuthRegistration = {
  provider: PlatformOAuthProvider;
  clientId: string;
  clientSecret: string;
  tenantOrIssuer: string | null;
  enabledPacks: SupportedPack[];
  revision: number;
};

type SaveResult = {
  config: PublicPlatformOAuthRegistration;
  auditAction: "create" | "update" | "rotate" | "enable" | "disable" | "narrow";
};

function callbackPath(provider: PlatformOAuthProvider) {
  return `/api/integrations/oauth/${provider === "google_workspace" ? "google-workspace" : "microsoft-365"}/callback`;
}

export function callbackUriForPlatformOAuthProvider(
  provider: PlatformOAuthProvider,
  env: NodeJS.ProcessEnv = process.env,
) {
  return new URL(callbackPath(provider), resolveKestrelAppUrl(env)).toString();
}

function providerDisplayName(provider: PlatformOAuthProvider) {
  return provider === "google_workspace" ? "Google Workspace" : "Microsoft 365";
}

function supportedPacks(provider: PlatformOAuthProvider) {
  if (provider === "google_workspace") {
    return [
      {
        id: "gmail" as const,
        label: "Gmail",
        scopes: [...GOOGLE_WORKSPACE_PACK_SCOPES.gmail],
      },
      {
        id: "calendar" as const,
        label: "Google Calendar",
        scopes: [...GOOGLE_WORKSPACE_PACK_SCOPES.calendar],
      },
    ];
  }
  return [
    {
      id: "teams" as const,
      label: "Microsoft Teams",
      scopes: [...MICROSOFT_365_PACK_SCOPES.teams],
    },
  ];
}

function normalizePacks(
  provider: PlatformOAuthProvider,
  values: readonly string[],
): SupportedPack[] {
  const allowed = new Set(supportedPacks(provider).map((pack) => pack.id));
  const unique = Array.from(new Set(values));
  if (!unique.every((pack) => allowed.has(pack as SupportedPack))) {
    throw new PlatformOAuthRegistrationError(
      "OAUTH_PACK_UNSUPPORTED",
      `${providerDisplayName(provider)} supports only ${Array.from(allowed).join(", ")} in this release.`,
    );
  }
  return unique as SupportedPack[];
}

export function scopesForPlatformOAuthRegistration(input: {
  provider: PlatformOAuthProvider;
  packs: readonly string[];
}) {
  const packs = normalizePacks(input.provider, input.packs);
  if (input.provider === "google_workspace") {
    return scopesForGoogleWorkspacePacks(packs as GoogleWorkspacePack[]);
  }
  return scopesForMicrosoft365Packs(packs as Microsoft365Pack[]);
}

function secretBindingId(provider: PlatformOAuthProvider) {
  return `${OAUTH_SECRET_BINDING_PREFIX}:${provider}`;
}

function clean(value: string | null | undefined) {
  return value?.trim() || null;
}

export function toPublicPlatformOAuthRegistration(input: {
  provider: PlatformOAuthProvider;
  clientId?: string | null;
  encryptedClientSecret?: string | null;
  tenantOrIssuer?: string | null;
  enabled?: boolean;
  enabledPacks?: readonly string[];
  revision?: number | null;
  updatedAt?: Date | null;
  persisted: boolean;
  env?: NodeJS.ProcessEnv;
}): PublicPlatformOAuthRegistration {
  const packs = normalizePacks(input.provider, input.enabledPacks ?? []);
  const credentialConfigured = Boolean(
    input.clientId && input.encryptedClientSecret,
  );
  const enabled = input.enabled ?? false;
  return {
    provider: input.provider,
    displayName: providerDisplayName(input.provider),
    enabled,
    clientId: input.clientId ?? null,
    tenantOrIssuer: input.tenantOrIssuer ?? null,
    enabledPacks: packs,
    supportedPacks: supportedPacks(input.provider),
    callbackUri: callbackUriForPlatformOAuthProvider(input.provider, input.env),
    baseScopes: scopesForPlatformOAuthRegistration({
      provider: input.provider,
      packs: [],
    }),
    scopes: scopesForPlatformOAuthRegistration({
      provider: input.provider,
      packs,
    }),
    status: credentialConfigured
      ? enabled
        ? "ready"
        : "disabled"
      : "not_configured",
    credentialConfigured,
    revision: input.revision ?? null,
    persisted: input.persisted,
    updatedAt: input.updatedAt ?? null,
  };
}

export async function resolvePlatformOAuthRegistration(
  provider: PlatformOAuthProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicPlatformOAuthRegistration> {
  const row = await knowledgeDb.query.platformOAuthRegistrations.findFirst({
    where: (table, { eq: equals }) => equals(table.provider, provider),
  });
  if (!row) {
    return toPublicPlatformOAuthRegistration({
      provider,
      persisted: false,
      env,
    });
  }
  return toPublicPlatformOAuthRegistration({
    ...row,
    provider,
    persisted: true,
    env,
  });
}

export async function listPlatformOAuthRegistrations(
  env: NodeJS.ProcessEnv = process.env,
) {
  return Promise.all(
    PLATFORM_OAUTH_PROVIDERS.map((provider) =>
      resolvePlatformOAuthRegistration(provider, env),
    ),
  );
}

export async function savePlatformOAuthRegistration(input: {
  actorUserId: string;
  provider: PlatformOAuthProvider;
  clientId: string;
  clientSecret?: string;
  tenantOrIssuer?: string | null;
  enabledPacks: readonly string[];
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<SaveResult> {
  const env = input.env ?? process.env;
  const existing = await knowledgeDb.query.platformOAuthRegistrations.findFirst(
    {
      where: (table, { eq: equals }) => equals(table.provider, input.provider),
    },
  );
  const clientId = clean(input.clientId);
  const clientSecret = clean(input.clientSecret);
  const tenantOrIssuer = clean(input.tenantOrIssuer);
  const enabledPacks = normalizePacks(input.provider, input.enabledPacks);

  if (!clientId) {
    throw new PlatformOAuthRegistrationError(
      "OAUTH_CLIENT_ID_REQUIRED",
      "An OAuth client ID is required.",
    );
  }
  if (input.enabled && enabledPacks.length === 0) {
    throw new PlatformOAuthRegistrationError(
      "OAUTH_PACK_REQUIRED",
      "Enable at least one supported capability before enabling this registration.",
    );
  }

  let encryptedClientSecret = existing?.encryptedClientSecret ?? null;
  if (clientSecret) {
    encryptedClientSecret = encryptGatewayCredential({
      gatewayId: secretBindingId(input.provider),
      plaintext: clientSecret,
      env,
    });
  }
  if (!encryptedClientSecret) {
    throw new PlatformOAuthRegistrationError(
      "OAUTH_CLIENT_SECRET_REQUIRED",
      "A hosted OAuth client secret is required.",
    );
  }

  const previousPacks = new Set(existing?.enabledPacks ?? []);
  const narrowed = [...previousPacks].some(
    (pack) => !enabledPacks.includes(pack as SupportedPack),
  );
  const auditAction: SaveResult["auditAction"] = existing
    ? clientSecret
      ? "rotate"
      : existing.enabled !== input.enabled
        ? input.enabled
          ? "enable"
          : "disable"
        : narrowed
          ? "narrow"
          : "update"
    : "create";
  const now = new Date();
  const revision = (existing?.revision ?? 0) + 1;

  await knowledgeDb
    .insert(schema.platformOAuthRegistrations)
    .values({
      provider: input.provider,
      enabled: input.enabled,
      clientId,
      encryptedClientSecret,
      tenantOrIssuer,
      enabledPacks,
      revision,
      updatedByUserId: input.actorUserId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.platformOAuthRegistrations.provider,
      set: {
        enabled: input.enabled,
        clientId,
        encryptedClientSecret,
        tenantOrIssuer,
        enabledPacks,
        revision,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      },
    });

  return {
    config: await resolvePlatformOAuthRegistration(input.provider, env),
    auditAction,
  };
}

/** Internal-only provider authority for the hosted authorization broker. */
export async function requireActivePlatformOAuthRegistration(
  provider: PlatformOAuthProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ActivePlatformOAuthRegistration> {
  const row = await knowledgeDb.query.platformOAuthRegistrations.findFirst({
    where: (table, { eq: equals }) => equals(table.provider, provider),
  });
  if (!(row?.enabled && row.clientId && row.encryptedClientSecret)) {
    throw new PlatformOAuthRegistrationError(
      "OAUTH_REGISTRATION_UNAVAILABLE",
      `${providerDisplayName(provider)} is not configured and enabled by the Platform Admin.`,
    );
  }
  return {
    provider,
    clientId: row.clientId,
    clientSecret: decryptGatewayCredential({
      gatewayId: secretBindingId(provider),
      encrypted: row.encryptedClientSecret,
      env,
    }),
    tenantOrIssuer: row.tenantOrIssuer,
    enabledPacks: normalizePacks(provider, row.enabledPacks),
    revision: row.revision,
  };
}

export function isPlatformOAuthProvider(
  value: string,
): value is PlatformOAuthProvider {
  return (PLATFORM_OAUTH_PROVIDERS as readonly string[]).includes(value);
}
