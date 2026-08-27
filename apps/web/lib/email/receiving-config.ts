import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
} from "@/lib/ai/gateway-credential-crypto";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  ResendHttpReceivingProvider,
  ResendReceivingProviderError,
  type ResendReceivingDomain,
  type ResendReceivingProvider,
} from "./receiving-provider";

const credentialBinding = (organizationId: string) =>
  `organization-receiving-connection:${organizationId}:api-key`;
const signingSecretBinding = (organizationId: string) =>
  `organization-receiving-connection:${organizationId}:signing-secret`;

export type PublicReceivingConnection = {
  provider: "resend";
  configured: boolean;
  credentialStatus: "not_configured" | "full_access" | "insufficient" | "error";
  credentialValidatedAt: string | null;
  receivingDomain: string | null;
  receivingDomainStatus: "not_selected" | "pending" | "verified" | "failed";
  mxStatus: "unknown" | "pending" | "verified" | "failed";
  domainCheckedAt: string | null;
  webhookStatus: "not_staged" | "staged" | "active" | "disabled" | "error";
  inboundEnabled: boolean;
  lastHealthCheckedAt: string | null;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  readiness:
    | "not_configured"
    | "credential_insufficient"
    | "domain_unready"
    | "ready_inactive"
    | "staged"
    | "active"
    | "error";
};

export type ReceivingDomainOption = ResendReceivingDomain;

export class ReceivingConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReceivingConfigError";
  }
}

export async function getPublicReceivingConnection(
  organizationId: string,
): Promise<PublicReceivingConnection> {
  const row = await findConnection(organizationId);
  return projectConnection(row);
}

export async function inspectReceivingDomains(input: {
  organizationId: string;
  apiKey?: string | undefined;
  env?: NodeJS.ProcessEnv;
  provider?: ResendReceivingProvider;
}): Promise<ReceivingDomainOption[]> {
  const suppliedApiKey = input.apiKey?.trim() || undefined;
  const existing = suppliedApiKey
    ? undefined
    : await findConnection(input.organizationId);
  const storedEncryptedApiKey = existing?.encryptedApiKey ?? null;
  const key =
    suppliedApiKey ??
    decryptStoredApiKey({
      organizationId: input.organizationId,
      encryptedApiKey: storedEncryptedApiKey,
      env: input.env,
    });
  if (!key) {
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_CREDENTIAL_REQUIRED",
      "Enter a Resend Full access API key.",
    );
  }
  const storedHealthCheck =
    !suppliedApiKey && storedEncryptedApiKey
      ? await beginStoredCredentialHealthCheck({
          organizationId: input.organizationId,
          expectedEncryptedApiKey: storedEncryptedApiKey,
        })
      : undefined;
  let domains: ReceivingDomainOption[];
  try {
    domains = await (
      input.provider ?? new ResendHttpReceivingProvider()
    ).listDomains(key);
  } catch (error) {
    const normalized = normalizeProviderError(error);
    if (storedHealthCheck) {
      await persistStoredCredentialHealth({
        organizationId: input.organizationId,
        expectedEncryptedApiKey: storedHealthCheck.expectedEncryptedApiKey,
        healthCheckSequence: storedHealthCheck.healthCheckSequence,
        outcome: credentialFailureOutcome(normalized),
      });
    }
    throw normalized;
  }
  if (storedHealthCheck) {
    await persistStoredCredentialHealth({
      organizationId: input.organizationId,
      expectedEncryptedApiKey: storedHealthCheck.expectedEncryptedApiKey,
      healthCheckSequence: storedHealthCheck.healthCheckSequence,
      outcome: { credentialStatus: "full_access", errorCode: null },
      checkedDomains: domains,
    });
  }
  return domains;
}

export async function saveReceivingConnection(input: {
  organizationId: string;
  actorUserId: string;
  receivingDomainId: string;
  apiKey?: string | undefined;
  env?: NodeJS.ProcessEnv;
  provider?: ResendReceivingProvider;
}): Promise<PublicReceivingConnection> {
  const existing = await findConnection(input.organizationId);
  const suppliedApiKey = input.apiKey?.trim() || undefined;
  const storedEncryptedApiKey = existing?.encryptedApiKey ?? null;
  const apiKey =
    suppliedApiKey ??
    decryptStoredApiKey({
      organizationId: input.organizationId,
      encryptedApiKey: storedEncryptedApiKey,
      env: input.env,
    });
  if (!apiKey) {
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_CREDENTIAL_REQUIRED",
      "Enter a Resend Full access API key.",
    );
  }
  const storedHealthCheck =
    !suppliedApiKey && storedEncryptedApiKey
      ? await beginStoredCredentialHealthCheck({
          organizationId: input.organizationId,
          expectedEncryptedApiKey: storedEncryptedApiKey,
        })
      : undefined;
  let domain: ResendReceivingDomain;
  try {
    domain = await (
      input.provider ?? new ResendHttpReceivingProvider()
    ).getDomain(apiKey, input.receivingDomainId.trim());
  } catch (error) {
    const normalized = normalizeProviderError(error);
    if (storedHealthCheck) {
      const persistence = await persistStoredCredentialHealth({
        organizationId: input.organizationId,
        expectedEncryptedApiKey: storedHealthCheck.expectedEncryptedApiKey,
        healthCheckSequence: storedHealthCheck.healthCheckSequence,
        outcome: credentialFailureOutcome(normalized),
      });
      rejectSupersededStoredSave(persistence);
    }
    throw normalized;
  }
  if (
    domain.receiving !== "enabled" ||
    domain.status !== "verified" ||
    domain.mxStatus !== "verified"
  ) {
    if (storedHealthCheck) {
      const persistence = await persistStoredCredentialHealth({
        organizationId: input.organizationId,
        expectedEncryptedApiKey: storedHealthCheck.expectedEncryptedApiKey,
        healthCheckSequence: storedHealthCheck.healthCheckSequence,
        outcome: { credentialStatus: "full_access", errorCode: null },
        ...(domain.id === existing?.receivingDomainId
          ? { checkedDomains: [domain] }
          : {}),
      });
      rejectSupersededStoredSave(persistence);
    }
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_DOMAIN_NOT_READY",
      "Choose a verified Resend receiving domain with healthy MX records.",
    );
  }
  const now = new Date();
  const preparedEncryptedApiKey = suppliedApiKey
    ? encryptGatewayCredential({
        gatewayId: credentialBinding(input.organizationId),
        plaintext: apiKey,
        env: input.env,
      })
    : storedEncryptedApiKey;
  if (!preparedEncryptedApiKey) {
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_CREDENTIAL_REQUIRED",
      "Enter a Resend Full access API key.",
    );
  }
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:receiving:${input.organizationId}`}, 0))`,
    );
    const lockedExisting =
      await transaction.query.organizationReceivingConnections.findFirst({
        where: (table, { eq }) =>
          eq(table.organizationId, input.organizationId),
      });
    if (
      !suppliedApiKey &&
      (lockedExisting?.encryptedApiKey ?? null) !== storedEncryptedApiKey
    ) {
      throw new ReceivingConfigError(
        "RESEND_RECEIVING_CREDENTIAL_CHANGED",
        "The Resend credential changed while receiving was being saved. Refresh and try again.",
      );
    }
    if (
      storedHealthCheck &&
      lockedExisting?.healthCheckSequence !==
        storedHealthCheck.healthCheckSequence
    ) {
      throw new ReceivingConfigError(
        "RESEND_RECEIVING_SAVE_SUPERSEDED",
        "The receiving configuration changed while receiving was being saved. Refresh and try again.",
      );
    }
    const encryptedApiKey = suppliedApiKey
      ? preparedEncryptedApiKey
      : lockedExisting?.encryptedApiKey;
    if (!encryptedApiKey) {
      throw new ReceivingConfigError(
        "RESEND_RECEIVING_CREDENTIAL_REQUIRED",
        "Enter a Resend Full access API key.",
      );
    }
    await transaction
      .insert(schema.organizationReceivingConnections)
      .values({
        id: lockedExisting?.id ?? randomUUID(),
        organizationId: input.organizationId,
        provider: "resend",
        encryptedApiKey,
        credentialStatus: "full_access",
        credentialValidatedAt: now,
        receivingDomainId: domain.id,
        receivingDomain: domain.name,
        receivingDomainStatus: domain.status,
        mxStatus: domain.mxStatus,
        domainCheckedAt: now,
        routeLocator:
          lockedExisting?.routeLocator ?? randomBytes(32).toString("base64url"),
        inboundEnabled: false,
        lastHealthCheckedAt: now,
        lastErrorCode: null,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.organizationReceivingConnections.organizationId,
        set: {
          encryptedApiKey,
          credentialStatus: "full_access",
          credentialValidatedAt: now,
          receivingDomainId: domain.id,
          receivingDomain: domain.name,
          receivingDomainStatus: domain.status,
          mxStatus: domain.mxStatus,
          domainCheckedAt: now,
          inboundEnabled: false,
          lastHealthCheckedAt: now,
          lastErrorCode: null,
          updatedByUserId: input.actorUserId,
          updatedAt: now,
        },
      });
  });
  return getPublicReceivingConnection(input.organizationId);
}

export function encryptReceivingSigningSecret(input: {
  organizationId: string;
  signingSecret: string;
  env?: NodeJS.ProcessEnv;
}) {
  return encryptGatewayCredential({
    gatewayId: signingSecretBinding(input.organizationId),
    plaintext: input.signingSecret,
    env: input.env,
  });
}

export function decryptReceivingSigningSecret(input: {
  organizationId: string;
  encryptedSigningSecret: string;
  env?: NodeJS.ProcessEnv;
}) {
  return decryptGatewayCredential({
    gatewayId: signingSecretBinding(input.organizationId),
    encrypted: input.encryptedSigningSecret,
    env: input.env,
  });
}

function decryptStoredApiKey(input: {
  organizationId: string;
  encryptedApiKey?: string | null;
  env?: NodeJS.ProcessEnv;
}) {
  return input.encryptedApiKey
    ? decryptGatewayCredential({
        gatewayId: credentialBinding(input.organizationId),
        encrypted: input.encryptedApiKey,
        env: input.env,
      })
    : undefined;
}

async function persistStoredCredentialHealth(input: {
  organizationId: string;
  expectedEncryptedApiKey: string;
  healthCheckSequence: number;
  outcome: {
    credentialStatus: "full_access" | "insufficient" | "error";
    errorCode: string | null;
  };
  checkedDomains?: readonly ReceivingDomainOption[] | undefined;
}) {
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:receiving:${input.organizationId}`}, 0))`,
    );
    const lockedExisting =
      await transaction.query.organizationReceivingConnections.findFirst({
        where: (table, { eq: equals }) =>
          equals(table.organizationId, input.organizationId),
      });
    if (lockedExisting?.encryptedApiKey !== input.expectedEncryptedApiKey) {
      throw new ReceivingConfigError(
        "RESEND_RECEIVING_CREDENTIAL_CHANGED",
        "The Resend credential changed while receiving was being checked. Refresh and try again.",
      );
    }
    if (lockedExisting.healthCheckSequence !== input.healthCheckSequence) {
      return "superseded" as const;
    }
    const checkedDomain = lockedExisting.receivingDomainId
      ? input.checkedDomains?.find(
          (domain) => domain.id === lockedExisting.receivingDomainId,
        )
      : undefined;
    const checkedConfiguredDomain =
      input.checkedDomains && lockedExisting.receivingDomainId
        ? {
            ...(checkedDomain ? { receivingDomain: checkedDomain.name } : {}),
            receivingDomainStatus: checkedDomain?.status ?? ("failed" as const),
            mxStatus: checkedDomain?.mxStatus ?? ("unknown" as const),
            domainCheckedAt: now,
          }
        : {};
    await transaction
      .update(schema.organizationReceivingConnections)
      .set({
        credentialStatus: input.outcome.credentialStatus,
        ...(input.outcome.credentialStatus === "full_access"
          ? { credentialValidatedAt: now }
          : {}),
        lastHealthCheckedAt: now,
        lastErrorCode: input.outcome.errorCode,
        ...checkedConfiguredDomain,
        updatedAt: now,
      })
      .where(
        eq(
          schema.organizationReceivingConnections.organizationId,
          input.organizationId,
        ),
      );
    return "persisted" as const;
  });
}

function rejectSupersededStoredSave(
  persistence: Awaited<ReturnType<typeof persistStoredCredentialHealth>>,
) {
  if (persistence === "superseded") {
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_SAVE_SUPERSEDED",
      "The receiving configuration changed while receiving was being saved. Refresh and try again.",
    );
  }
}

async function beginStoredCredentialHealthCheck(input: {
  organizationId: string;
  expectedEncryptedApiKey: string;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:receiving:${input.organizationId}`}, 0))`,
    );
    const lockedExisting =
      await transaction.query.organizationReceivingConnections.findFirst({
        where: (table, { eq: equals }) =>
          equals(table.organizationId, input.organizationId),
      });
    if (lockedExisting?.encryptedApiKey !== input.expectedEncryptedApiKey) {
      throw new ReceivingConfigError(
        "RESEND_RECEIVING_CREDENTIAL_CHANGED",
        "The Resend credential changed while receiving was being checked. Refresh and try again.",
      );
    }
    const healthCheckSequence = lockedExisting.healthCheckSequence + 1;
    await transaction
      .update(schema.organizationReceivingConnections)
      .set({ healthCheckSequence })
      .where(
        eq(
          schema.organizationReceivingConnections.organizationId,
          input.organizationId,
        ),
      );
    return {
      expectedEncryptedApiKey: input.expectedEncryptedApiKey,
      healthCheckSequence,
    };
  });
}

function credentialFailureOutcome(error: ReceivingConfigError): {
  credentialStatus: "insufficient" | "error";
  errorCode: string;
} {
  return {
    credentialStatus:
      error.code === "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT"
        ? "insufficient"
        : "error",
    errorCode: error.code,
  };
}

async function findConnection(organizationId: string) {
  return knowledgeDb.query.organizationReceivingConnections.findFirst({
    where: (table, { eq }) => eq(table.organizationId, organizationId),
  });
}

function projectConnection(
  row: Awaited<ReturnType<typeof findConnection>>,
): PublicReceivingConnection {
  if (!row) {
    return {
      provider: "resend",
      configured: false,
      credentialStatus: "not_configured",
      credentialValidatedAt: null,
      receivingDomain: null,
      receivingDomainStatus: "not_selected",
      mxStatus: "unknown",
      domainCheckedAt: null,
      webhookStatus: "not_staged",
      inboundEnabled: false,
      lastHealthCheckedAt: null,
      lastTestedAt: null,
      lastErrorCode: null,
      readiness: "not_configured",
    };
  }
  return {
    provider: "resend",
    configured: Boolean(row.encryptedApiKey && row.receivingDomain),
    credentialStatus: row.credentialStatus,
    credentialValidatedAt: row.credentialValidatedAt?.toISOString() ?? null,
    receivingDomain: row.receivingDomain,
    receivingDomainStatus: row.receivingDomainStatus,
    mxStatus: row.mxStatus,
    domainCheckedAt: row.domainCheckedAt?.toISOString() ?? null,
    webhookStatus: row.webhookStatus,
    inboundEnabled: row.inboundEnabled,
    lastHealthCheckedAt: row.lastHealthCheckedAt?.toISOString() ?? null,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    readiness: readinessFor(row),
  };
}

function readinessFor(
  row: NonNullable<Awaited<ReturnType<typeof findConnection>>>,
): PublicReceivingConnection["readiness"] {
  if (row.credentialStatus === "insufficient") return "credential_insufficient";
  if (row.credentialStatus === "error" || row.lastErrorCode) return "error";
  if (!row.encryptedApiKey) return "not_configured";
  if (
    row.receivingDomainStatus !== "verified" ||
    row.mxStatus !== "verified"
  ) {
    return "domain_unready";
  }
  if (row.inboundEnabled && row.webhookStatus === "active") return "active";
  if (row.webhookStatus === "staged" || row.webhookStatus === "disabled") {
    return "staged";
  }
  return "ready_inactive";
}

function normalizeProviderError(error: unknown): ReceivingConfigError {
  if (error instanceof ResendReceivingProviderError) {
    return new ReceivingConfigError(error.code, error.message);
  }
  return new ReceivingConfigError(
    "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
    "Resend receiving is temporarily unavailable.",
  );
}
