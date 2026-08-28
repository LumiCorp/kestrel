import { and, eq } from "drizzle-orm";
import {
  GOOGLE_WORKSPACE_BASE_SCOPES,
  GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS,
  type GoogleWorkspacePack,
} from "../../../../src/apps/googleWorkspace.js";
import {
  MICROSOFT_365_BASE_SCOPES,
  MICROSOFT_365_OPERATION_DESCRIPTORS,
} from "../../../../src/apps/microsoft365.js";
import { insertAdminEvent } from "@/lib/admin/logs";
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
  | "ready"
  | "configuration_error";

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
  /** A safe, administrator-actionable explanation for unusable stored state. */
  configurationError: string | null;
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
  auditAction:
    | "create"
    | "update"
    | "rotate"
    | "enable"
    | "disable"
    | "narrow"
    | "none";
};

const RELEASED_PACKS = {
  google_workspace: ["gmail", "calendar"],
  microsoft_365: ["teams"],
} as const satisfies Record<PlatformOAuthProvider, readonly SupportedPack[]>;

const MICROSOFT_TENANT_GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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
  const labels: Record<SupportedPack, string> = {
    gmail: "Gmail",
    calendar: "Google Calendar",
    teams: "Microsoft Teams",
  };
  return RELEASED_PACKS[provider].map((id) => ({
    id,
    label: labels[id],
    scopes: operationScopesForPacks(provider, [id]),
  }));
}

function operationScopesForPacks(
  provider: PlatformOAuthProvider,
  packs: readonly SupportedPack[],
) {
  const descriptors =
    provider === "google_workspace"
      ? GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS
      : MICROSOFT_365_OPERATION_DESCRIPTORS;
  return [
    ...new Set(
      packs.flatMap((pack) =>
        descriptors
          .filter((descriptor) => descriptor.pack === pack)
          .flatMap((descriptor) => descriptor.requiredScopes),
      ),
    ),
  ];
}

function normalizePacks(
  provider: PlatformOAuthProvider,
  values: readonly string[],
): SupportedPack[] {
  const released = RELEASED_PACKS[provider];
  const allowed = new Set(released);
  const unique = Array.from(new Set(values));
  if (!unique.every((pack) => allowed.has(pack as SupportedPack))) {
    throw new PlatformOAuthRegistrationError(
      "OAUTH_PACK_UNSUPPORTED",
      `${providerDisplayName(provider)} supports only ${Array.from(allowed).join(", ")} in this release.`,
    );
  }
  // Capability packs are a set. Persist and compare their canonical provider
  // order so a UI ordering difference cannot stale existing authorizations.
  return released.filter((pack) => unique.includes(pack)) as SupportedPack[];
}

export function scopesForPlatformOAuthRegistration(input: {
  provider: PlatformOAuthProvider;
  packs: readonly string[];
}) {
  const packs = normalizePacks(input.provider, input.packs);
  const baseScopes =
    input.provider === "google_workspace"
      ? GOOGLE_WORKSPACE_BASE_SCOPES
      : MICROSOFT_365_BASE_SCOPES;
  return [...baseScopes, ...operationScopesForPacks(input.provider, packs)];
}

function secretBindingId(provider: PlatformOAuthProvider) {
  return `${OAUTH_SECRET_BINDING_PREFIX}:${provider}`;
}

function clean(value: string | null | undefined) {
  return value?.trim() || null;
}

export function validatePlatformOAuthRegistrationTenantOrIssuer(
  provider: PlatformOAuthProvider,
  tenantOrIssuer: string | null,
) {
  if (provider === "google_workspace") {
    if (tenantOrIssuer) {
      throw new PlatformOAuthRegistrationError(
        "OAUTH_TENANT_UNSUPPORTED",
        "Google Workspace does not accept a tenant or issuer setting.",
      );
    }
    return null;
  }
  if (!tenantOrIssuer) return null;
  if (tenantOrIssuer.toLowerCase() === "organizations") {
    return "organizations";
  }
  if (MICROSOFT_TENANT_GUID.test(tenantOrIssuer)) {
    return tenantOrIssuer.toLowerCase();
  }
  throw new PlatformOAuthRegistrationError(
    "OAUTH_TENANT_INVALID",
    "Microsoft 365 tenant must be Organizations or a tenant GUID.",
  );
}

function validateStoredPlatformOAuthRegistration(input: {
  provider: PlatformOAuthProvider;
  tenantOrIssuer: string | null;
  enabledPacks: readonly string[];
  enabled: boolean;
}) {
  const tenantOrIssuer = validatePlatformOAuthRegistrationTenantOrIssuer(
    input.provider,
    input.tenantOrIssuer,
  );
  const enabledPacks = normalizePacks(input.provider, input.enabledPacks);
  if (input.enabled && enabledPacks.length === 0) {
    throw new PlatformOAuthRegistrationError(
      "OAUTH_PACK_REQUIRED",
      "Enable at least one supported capability before enabling this registration.",
    );
  }
  return { tenantOrIssuer, enabledPacks };
}

function safeStoredRegistrationError(error: unknown) {
  if (error instanceof PlatformOAuthRegistrationError) return error.message;
  return "The saved OAuth registration is invalid and requires Platform Admin correction.";
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
  let packs: SupportedPack[] = [];
  let tenantOrIssuer = input.tenantOrIssuer ?? null;
  let configurationError: string | null = null;
  try {
    const validated = validateStoredPlatformOAuthRegistration({
      provider: input.provider,
      tenantOrIssuer,
      enabledPacks: input.enabledPacks ?? [],
      enabled: input.enabled ?? false,
    });
    packs = validated.enabledPacks;
    tenantOrIssuer = validated.tenantOrIssuer;
  } catch (error) {
    configurationError = safeStoredRegistrationError(error);
  }
  const credentialConfigured = Boolean(
    input.clientId && input.encryptedClientSecret,
  );
  const enabled = input.enabled ?? false;
  return {
    provider: input.provider,
    displayName: providerDisplayName(input.provider),
    enabled,
    clientId: input.clientId ?? null,
    tenantOrIssuer,
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
    status: configurationError
      ? "configuration_error"
      : credentialConfigured
        ? enabled
          ? "ready"
          : "disabled"
        : "not_configured",
    configurationError,
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
  /** The revision returned to the caller when it loaded this registration. */
  expectedRevision: number | null;
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
  const tenantOrIssuer = validatePlatformOAuthRegistrationTenantOrIssuer(
    input.provider,
    clean(input.tenantOrIssuer),
  );
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
  let clientSecretChanged = false;
  if (clientSecret) {
    const existingSecret = existing?.encryptedClientSecret
      ? decryptGatewayCredential({
          gatewayId: secretBindingId(input.provider),
          encrypted: existing.encryptedClientSecret,
          env,
        })
      : null;
    clientSecretChanged = existingSecret !== clientSecret;
    if (clientSecretChanged) {
      encryptedClientSecret = encryptGatewayCredential({
        gatewayId: secretBindingId(input.provider),
        plaintext: clientSecret,
        env,
      });
    }
  }
  if (!encryptedClientSecret) {
    throw new PlatformOAuthRegistrationError(
      "OAUTH_CLIENT_SECRET_REQUIRED",
      "A hosted OAuth client secret is required.",
    );
  }

  let previous: {
    tenantOrIssuer: string | null;
    enabledPacks: SupportedPack[];
  } | null = null;
  if (existing) {
    try {
      previous = validateStoredPlatformOAuthRegistration({
        provider: input.provider,
        tenantOrIssuer: existing.tenantOrIssuer,
        enabledPacks: existing.enabledPacks,
        enabled: existing.enabled,
      });
    } catch {
      // A Platform Admin can correct a legacy invalid row with a valid save.
      // It is never treated as a canonical no-op.
    }
  }
  const previousPacks = new Set(previous?.enabledPacks ?? []);
  const narrowed = [...previousPacks].some(
    (pack) => !enabledPacks.includes(pack as SupportedPack),
  );
  const auditAction: SaveResult["auditAction"] = existing
    ? clientSecretChanged
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

  const saved = await knowledgeDb.transaction(async (transaction) => {
    let row;
    if (existing) {
      const [current] = await transaction
        .select()
        .from(schema.platformOAuthRegistrations)
        .where(eq(schema.platformOAuthRegistrations.provider, input.provider))
        .for("update");
      if (!current || input.expectedRevision !== current.revision) {
        throw new PlatformOAuthRegistrationError(
          "OAUTH_REGISTRATION_CONFLICT",
          "This OAuth registration changed. Reload it before saving again.",
        );
      }
      let currentCanonical: {
        tenantOrIssuer: string | null;
        enabledPacks: SupportedPack[];
      } | null = null;
      try {
        currentCanonical = validateStoredPlatformOAuthRegistration({
          provider: input.provider,
          tenantOrIssuer: current.tenantOrIssuer,
          enabledPacks: current.enabledPacks,
          enabled: current.enabled,
        });
      } catch {
        // Invalid persisted state must be corrected, not accepted as unchanged.
      }
      const unchanged =
        current.clientId === clientId &&
        !clientSecretChanged &&
        currentCanonical?.tenantOrIssuer === tenantOrIssuer &&
        current.enabled === input.enabled &&
        currentCanonical?.enabledPacks.length === enabledPacks.length &&
        currentCanonical.enabledPacks.every(
          (pack, index) => pack === enabledPacks[index],
        );
      if (unchanged) {
        return {
          config: toPublicPlatformOAuthRegistration({
            ...current,
            provider: input.provider,
            persisted: true,
            env,
          }),
          auditAction: "none" as const,
        };
      }
      [row] = await transaction
        .update(schema.platformOAuthRegistrations)
        .set({
          enabled: input.enabled,
          clientId,
          encryptedClientSecret,
          tenantOrIssuer,
          enabledPacks,
          revision,
          updatedByUserId: input.actorUserId,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.platformOAuthRegistrations.provider, input.provider),
            eq(
              schema.platformOAuthRegistrations.revision,
              current.revision,
            ),
          ),
        )
        .returning();
    } else {
      if (input.expectedRevision !== null) {
        throw new PlatformOAuthRegistrationError(
          "OAUTH_REGISTRATION_CONFLICT",
          "This OAuth registration was created. Reload it before saving again.",
        );
      }
      [row] = await transaction
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
        .onConflictDoNothing()
        .returning();
    }
    if (!row) {
      throw new PlatformOAuthRegistrationError(
        "OAUTH_REGISTRATION_CONFLICT",
        "This OAuth registration changed. Reload it before saving again.",
      );
    }
    const config = toPublicPlatformOAuthRegistration({
      ...row,
      provider: input.provider,
      persisted: true,
      env,
    });
    await insertAdminEvent(transaction, {
      actorUserId: input.actorUserId,
      category: "platform_oauth_registration",
      action: auditAction,
      targetType: "platform_oauth_registration",
      targetId: config.provider,
      message: `${config.displayName} OAuth registration ${auditAction}d.`,
      metadata: {
        provider: config.provider,
        enabled: config.enabled,
        enabledPacks: config.enabledPacks,
        revision: config.revision,
        status: config.status,
        clientSecretSupplied: Boolean(clientSecret),
      },
    });
    return { config, auditAction };
  });

  return saved;
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
  const validated = validateStoredPlatformOAuthRegistration({
    provider,
    tenantOrIssuer: row.tenantOrIssuer,
    enabledPacks: row.enabledPacks,
    enabled: row.enabled,
  });
  return {
    provider,
    clientId: row.clientId,
    clientSecret: decryptGatewayCredential({
      gatewayId: secretBindingId(provider),
      encrypted: row.encryptedClientSecret,
      env,
    }),
    tenantOrIssuer: validated.tenantOrIssuer,
    enabledPacks: validated.enabledPacks,
    revision: row.revision,
  };
}

export function isPlatformOAuthProvider(
  value: string,
): value is PlatformOAuthProvider {
  return (PLATFORM_OAUTH_PROVIDERS as readonly string[]).includes(value);
}
