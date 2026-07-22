import { and, eq } from "drizzle-orm";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
} from "@/lib/ai/gateway-credential-crypto";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  createEmailConfigFingerprint,
  EmailConfigError,
  type EmailIntegrationStatus,
} from "./config";

const bindingId = (organizationId: string) =>
  `organization-email-config:${organizationId}`;

export type ResolvedOrganizationEmailConfig = {
  provider: "resend";
  enabled: boolean;
  credentialSource: "stored";
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

export type PublicOrganizationEmailConfig = Omit<
  ResolvedOrganizationEmailConfig,
  "apiKey" | "configFingerprint" | "configRevision"
>;

function clean(value: string | null | undefined) {
  return value?.trim() || null;
}

function statusFor(input: {
  configured: boolean;
  enabled: boolean;
  fingerprint: string | null;
  testedFingerprint: string | null;
  errorCode: string | null;
}): EmailIntegrationStatus {
  if (!input.configured) return "not_configured";
  if (input.errorCode) return "error";
  if (input.fingerprint === input.testedFingerprint) return "ready";
  return input.enabled ? "needs_test" : "disabled";
}

export async function resolveOrganizationEmailConfig(
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedOrganizationEmailConfig> {
  const row = await knowledgeDb.query.organizationEmailConfig.findFirst({
    where: (table, { eq: equals }) =>
      equals(table.organizationId, organizationId),
  });
  if (!row) {
    return {
      provider: "resend",
      enabled: false,
      credentialSource: "stored",
      apiKey: null,
      fromName: "Kestrel One",
      fromEmail: "",
      replyTo: null,
      status: "not_configured",
      credentialConfigured: false,
      lastTestedAt: null,
      lastTestMessageId: null,
      lastErrorCode: null,
      configFingerprint: null,
      configRevision: null,
      persisted: false,
    };
  }

  const apiKey = row.encryptedApiKey
    ? decryptGatewayCredential({
        gatewayId: bindingId(organizationId),
        encrypted: row.encryptedApiKey,
        env,
      })
    : null;
  const configFingerprint =
    apiKey && row.fromEmail
      ? createEmailConfigFingerprint({
          credentialSource: "stored",
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
    credentialSource: "stored",
    apiKey,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    status: statusFor({
      configured,
      enabled: row.enabled,
      fingerprint: configFingerprint,
      testedFingerprint: row.lastTestConfigFingerprint,
      errorCode: row.lastErrorCode,
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

export function toPublicOrganizationEmailConfig(
  config: ResolvedOrganizationEmailConfig
): PublicOrganizationEmailConfig {
  const {
    apiKey: _apiKey,
    configFingerprint: _fingerprint,
    configRevision: _revision,
    ...publicConfig
  } = config;
  return publicConfig;
}

export async function saveOrganizationEmailConfig(input: {
  organizationId: string;
  actorUserId: string;
  apiKey?: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  const existing = await knowledgeDb.query.organizationEmailConfig.findFirst({
    where: (table, { eq: equals }) =>
      equals(table.organizationId, input.organizationId),
  });
  const apiKey = clean(input.apiKey);
  const fromName = input.fromName.trim();
  const fromEmail = input.fromEmail.trim();
  const replyTo = clean(input.replyTo);
  const encryptedApiKey = apiKey
    ? encryptGatewayCredential({
        gatewayId: bindingId(input.organizationId),
        plaintext: apiKey,
        env,
      })
    : existing?.encryptedApiKey ?? null;
  if (!encryptedApiKey) {
    throw new EmailConfigError(
      "EMAIL_CREDENTIAL_REQUIRED",
      "A stored Resend API key is required."
    );
  }

  const deliveryChanged =
    !existing ||
    Boolean(apiKey) ||
    existing.fromName !== fromName ||
    existing.fromEmail !== fromEmail ||
    existing.replyTo !== replyTo;
  if (!deliveryChanged && input.enabled) {
    const current = await resolveOrganizationEmailConfig(
      input.organizationId,
      env
    );
    if (current.status !== "ready") {
      throw new EmailConfigError(
        "EMAIL_TEST_REQUIRED",
        "Send a successful test email before enabling delivery."
      );
    }
  }

  await knowledgeDb
    .insert(schema.organizationEmailConfig)
    .values({
      organizationId: input.organizationId,
      provider: "resend",
      enabled: deliveryChanged ? false : input.enabled,
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
      target: schema.organizationEmailConfig.organizationId,
      set: {
        enabled: deliveryChanged ? false : input.enabled,
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

  return resolveOrganizationEmailConfig(input.organizationId, env);
}

export async function recordOrganizationEmailTestResult(input: {
  organizationId: string;
  messageId?: string;
  errorCode?: string;
  testedConfigFingerprint: string;
  testedConfigRevision: Date;
  env?: NodeJS.ProcessEnv;
}) {
  const current = await resolveOrganizationEmailConfig(
    input.organizationId,
    input.env
  );
  if (
    current.configFingerprint !== input.testedConfigFingerprint ||
    current.configRevision?.getTime() !== input.testedConfigRevision.getTime()
  ) {
    return false;
  }
  const rows = await knowledgeDb
    .update(schema.organizationEmailConfig)
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
        eq(
          schema.organizationEmailConfig.organizationId,
          input.organizationId
        ),
        eq(
          schema.organizationEmailConfig.updatedAt,
          input.testedConfigRevision
        )
      )
    )
    .returning({ organizationId: schema.organizationEmailConfig.organizationId });
  return rows.length === 1;
}
