import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
} from "@/lib/ai/gateway-credential-crypto";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export const PLATFORM_EMAIL_CONFIG_ID = "default";
const EMAIL_CREDENTIAL_BINDING_ID = "platform-email-config";

export type EmailCredentialSource = "stored" | "environment";
export type EmailIntegrationStatus =
  | "disabled"
  | "not_configured"
  | "needs_test"
  | "ready"
  | "error";

export class EmailConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EmailConfigError";
    this.code = code;
  }
}

export type ResolvedEmailConfig = {
  provider: "resend";
  enabled: boolean;
  credentialSource: EmailCredentialSource;
  apiKey: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  status: EmailIntegrationStatus;
  credentialConfigured: boolean;
  lastTestedAt: Date | null;
  lastTestMessageId: string | null;
  lastErrorCode: string | null;
  configFingerprint: string | null;
  configRevision: Date | null;
  persisted: boolean;
};

export type PublicEmailConfig = Omit<
  ResolvedEmailConfig,
  "apiKey" | "configFingerprint" | "configRevision"
>;

function clean(value: string | null | undefined) {
  return value?.trim() || null;
}

export function createEmailConfigFingerprint(input: {
  credentialSource: EmailCredentialSource;
  apiKey: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        credentialSource: input.credentialSource,
        apiKey: input.apiKey,
        fromName: input.fromName,
        fromEmail: input.fromEmail,
        replyTo: input.replyTo,
      })
    )
    .digest("hex");
}

function deriveStatus(input: {
  enabled: boolean;
  configured: boolean;
  lastErrorCode: string | null;
  lastTestConfigFingerprint: string | null;
  configFingerprint: string | null;
}): EmailIntegrationStatus {
  if (!input.configured) {
    return "not_configured";
  }
  if (input.lastErrorCode) {
    return "error";
  }
  if (
    input.configFingerprint &&
    input.lastTestConfigFingerprint === input.configFingerprint
  ) {
    return "ready";
  }
  if (!input.enabled) {
    return "disabled";
  }
  return "needs_test";
}

export async function resolveEmailConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedEmailConfig> {
  const row = await knowledgeDb.query.platformEmailConfig.findFirst({
    where: (table, { eq: equals }) =>
      equals(table.id, PLATFORM_EMAIL_CONFIG_ID),
  });

  if (!row) {
    const apiKey = clean(env.RESEND_API_KEY);
    const fromEmail = clean(env.BETTER_AUTH_EMAIL) ?? "";
    const enabled = Boolean(apiKey && fromEmail);
    const configFingerprint =
      apiKey && fromEmail
        ? createEmailConfigFingerprint({
            credentialSource: "environment",
            apiKey,
            fromName: "Kestrel One",
            fromEmail,
            replyTo: clean(env.BETTER_AUTH_REPLY_TO),
          })
        : null;
    return {
      provider: "resend",
      enabled,
      credentialSource: "environment",
      apiKey,
      fromName: "Kestrel One",
      fromEmail,
      replyTo: clean(env.BETTER_AUTH_REPLY_TO),
      status: deriveStatus({
        enabled,
        configured: Boolean(apiKey && fromEmail),
        lastErrorCode: null,
        lastTestConfigFingerprint: null,
        configFingerprint,
      }),
      credentialConfigured: Boolean(apiKey),
      lastTestedAt: null,
      lastTestMessageId: null,
      lastErrorCode: null,
      configFingerprint,
      configRevision: null,
      persisted: false,
    };
  }

  let apiKey: string | null = null;
  if (row.credentialSource === "environment") {
    apiKey = clean(env.RESEND_API_KEY);
  } else if (row.encryptedApiKey) {
    apiKey = decryptGatewayCredential({
      gatewayId: EMAIL_CREDENTIAL_BINDING_ID,
      encrypted: row.encryptedApiKey,
      env,
    });
  }

  const configFingerprint =
    apiKey && row.fromEmail
      ? createEmailConfigFingerprint({
          credentialSource: row.credentialSource,
          apiKey,
          fromName: row.fromName,
          fromEmail: row.fromEmail,
          replyTo: row.replyTo,
        })
      : null;
  const configured = Boolean(apiKey && row.fromEmail);

  return {
    provider: "resend",
    enabled: row.enabled,
    credentialSource: row.credentialSource,
    apiKey,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    status: deriveStatus({
      enabled: row.enabled,
      configured,
      lastErrorCode: row.lastErrorCode,
      lastTestConfigFingerprint: row.lastTestConfigFingerprint,
      configFingerprint,
    }),
    credentialConfigured: Boolean(apiKey),
    lastTestedAt: row.lastTestedAt,
    lastTestMessageId: row.lastTestMessageId,
    lastErrorCode: row.lastErrorCode,
    configFingerprint,
    configRevision: row.updatedAt,
    persisted: true,
  };
}

export function toPublicEmailConfig(
  config: ResolvedEmailConfig
): PublicEmailConfig {
  const {
    apiKey: _apiKey,
    configFingerprint: _fingerprint,
    configRevision: _revision,
    ...publicConfig
  } = config;
  return publicConfig;
}

export function matchesEmailTestAuthority(
  config: ResolvedEmailConfig,
  testedConfigFingerprint: string,
  testedConfigRevision: Date
) {
  return (
    config.configFingerprint === testedConfigFingerprint &&
    config.configRevision?.getTime() === testedConfigRevision.getTime()
  );
}

export async function saveEmailConfig(input: {
  actorUserId: string;
  credentialSource: EmailCredentialSource;
  apiKey?: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  const existing = await knowledgeDb.query.platformEmailConfig.findFirst({
    where: (table, { eq: equals }) =>
      equals(table.id, PLATFORM_EMAIL_CONFIG_ID),
  });
  const apiKey = clean(input.apiKey);
  const fromName = input.fromName.trim();
  const fromEmail = input.fromEmail.trim();
  const replyTo = clean(input.replyTo);

  let encryptedApiKey: string | null = null;
  if (input.credentialSource === "stored") {
    if (apiKey) {
      encryptedApiKey = encryptGatewayCredential({
        gatewayId: EMAIL_CREDENTIAL_BINDING_ID,
        plaintext: apiKey,
        env,
      });
    } else if (existing?.credentialSource === "stored") {
      encryptedApiKey = existing.encryptedApiKey;
    }
    if (!encryptedApiKey) {
      throw new EmailConfigError(
        "EMAIL_CREDENTIAL_REQUIRED",
        "A stored Resend API key is required."
      );
    }
  }

  const deliveryChanged =
    !existing ||
    existing.credentialSource !== input.credentialSource ||
    Boolean(apiKey) ||
    existing.fromName !== fromName ||
    existing.fromEmail !== fromEmail ||
    existing.replyTo !== replyTo;

  if (!deliveryChanged && input.enabled) {
    const current = await resolveEmailConfig(env);
    if (current.status !== "ready") {
      throw new EmailConfigError(
        "EMAIL_TEST_REQUIRED",
        "Send a successful test email before enabling delivery."
      );
    }
  }

  await knowledgeDb
    .insert(schema.platformEmailConfig)
    .values({
      id: PLATFORM_EMAIL_CONFIG_ID,
      provider: "resend",
      enabled: deliveryChanged ? false : input.enabled,
      credentialSource: input.credentialSource,
      encryptedApiKey,
      fromName,
      fromEmail,
      replyTo,
      lastTestedAt: deliveryChanged ? null : existing?.lastTestedAt,
      lastTestMessageId: deliveryChanged ? null : existing?.lastTestMessageId,
      lastTestConfigFingerprint: deliveryChanged
        ? null
        : existing?.lastTestConfigFingerprint,
      lastErrorCode: null,
      updatedByUserId: input.actorUserId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.platformEmailConfig.id,
      set: {
        enabled: deliveryChanged ? false : input.enabled,
        credentialSource: input.credentialSource,
        encryptedApiKey,
        fromName,
        fromEmail,
        replyTo,
        lastTestedAt: deliveryChanged ? null : existing?.lastTestedAt,
        lastTestMessageId: deliveryChanged ? null : existing?.lastTestMessageId,
        lastTestConfigFingerprint: deliveryChanged
          ? null
          : existing?.lastTestConfigFingerprint,
        lastErrorCode: null,
        updatedByUserId: input.actorUserId,
        updatedAt: new Date(),
      },
    });

  return resolveEmailConfig(env);
}

export async function recordEmailTestResult(input: {
  messageId?: string;
  errorCode?: string;
  testedConfigFingerprint: string;
  testedConfigRevision: Date;
  env?: NodeJS.ProcessEnv;
}) {
  const config = await resolveEmailConfig(input.env);
  if (
    !matchesEmailTestAuthority(
      config,
      input.testedConfigFingerprint,
      input.testedConfigRevision
    )
  ) {
    return false;
  }

  const updated = await knowledgeDb
    .update(schema.platformEmailConfig)
    .set({
      lastTestedAt: input.messageId ? new Date() : null,
      lastTestMessageId: input.messageId ?? null,
      lastTestConfigFingerprint: input.messageId
        ? input.testedConfigFingerprint
        : null,
      lastErrorCode: input.errorCode ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.platformEmailConfig.id, PLATFORM_EMAIL_CONFIG_ID),
        eq(schema.platformEmailConfig.updatedAt, input.testedConfigRevision)
      )
    )
    .returning({ id: schema.platformEmailConfig.id });

  return updated.length === 1;
}
