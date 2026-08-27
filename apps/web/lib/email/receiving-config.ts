import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
  const key = input.apiKey?.trim() || (await loadStoredApiKey(input));
  if (!key) {
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_CREDENTIAL_REQUIRED",
      "Enter a Resend Full access API key.",
    );
  }
  try {
    return await (input.provider ?? new ResendHttpReceivingProvider()).listDomains(
      key,
    );
  } catch (error) {
    throw normalizeProviderError(error);
  }
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
  const apiKey = input.apiKey?.trim() || (await loadStoredApiKey(input));
  if (!apiKey) {
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_CREDENTIAL_REQUIRED",
      "Enter a Resend Full access API key.",
    );
  }
  let domain: ResendReceivingDomain;
  try {
    domain = await (
      input.provider ?? new ResendHttpReceivingProvider()
    ).getDomain(apiKey, input.receivingDomainId.trim());
  } catch (error) {
    throw normalizeProviderError(error);
  }
  if (
    domain.receiving !== "enabled" ||
    domain.status !== "verified" ||
    domain.mxStatus !== "verified"
  ) {
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_DOMAIN_NOT_READY",
      "Choose a verified Resend receiving domain with healthy MX records.",
    );
  }
  const now = new Date();
  const encryptedApiKey = input.apiKey?.trim()
    ? encryptGatewayCredential({
        gatewayId: credentialBinding(input.organizationId),
        plaintext: apiKey,
        env: input.env,
      })
    : existing?.encryptedApiKey;
  if (!encryptedApiKey) {
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_CREDENTIAL_REQUIRED",
      "Enter a Resend Full access API key.",
    );
  }
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:receiving:${input.organizationId}`}, 0))`,
    );
    await transaction
      .insert(schema.organizationReceivingConnections)
      .values({
        id: existing?.id ?? randomUUID(),
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
          existing?.routeLocator ?? randomBytes(32).toString("base64url"),
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

async function loadStoredApiKey(input: {
  organizationId: string;
  env?: NodeJS.ProcessEnv;
}) {
  const existing = await findConnection(input.organizationId);
  return existing?.encryptedApiKey
    ? decryptGatewayCredential({
        gatewayId: credentialBinding(input.organizationId),
        encrypted: existing.encryptedApiKey,
        env: input.env,
      })
    : undefined;
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
