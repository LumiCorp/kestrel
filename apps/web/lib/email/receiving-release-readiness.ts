import "server-only";

import { insertAdminEvent } from "@/lib/admin/logs";
import {
  type KestrelBuildIdentity,
  loadKestrelBuildIdentity,
} from "@/lib/deployment/build-identity";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  decryptReceivingApiKey,
  ReceivingConfigError,
  receivingOrganizationUnavailable,
} from "./receiving-config";
import {
  ResendHttpReceivingProvider,
  type ResendReceivingDomain,
  type ResendReceivingProvider,
  type ResendWebhookProjection,
} from "./receiving-provider";

const RELEASE_EVIDENCE_ACTION = "email-receiving-release-readiness-passed";

type ReadinessAuthority = {
  connectionId: string;
  encryptedApiKey: string;
  receivingDomainId: string;
  providerWebhookId: string;
  endpoint: string;
  stagingSequence: number;
};

export type ReceivingReleaseReadiness = {
  buildRevision: string;
  checkedAt: string;
  checks: readonly [
    "deployment-evidence",
    "database-contracts",
    "provider-domain",
    "provider-webhook",
  ];
};

/**
 * Executes the pre-enable proof that can be checked without delivering a real
 * email. Its outcome is a redacted, build- and staging-bound Admin event.
 */
export async function runReceivingReleaseReadiness(input: {
  organizationId: string;
  actorUserId: string;
  provider?: ResendReceivingProvider;
  env?: NodeJS.ProcessEnv;
  buildIdentity?: KestrelBuildIdentity;
}): Promise<ReceivingReleaseReadiness> {
  const env = input.env ?? process.env;
  const buildIdentity = input.buildIdentity ?? loadKestrelBuildIdentity(env);
  assertDeploymentEvidence(buildIdentity, env);
  const authority = await prepareReadinessAuthority(input.organizationId);
  const provider = input.provider ?? new ResendHttpReceivingProvider();
  const apiKey = decryptReceivingApiKey({
    organizationId: input.organizationId,
    encryptedApiKey: authority.encryptedApiKey,
    env,
  });
  const [domain, webhook] = await Promise.all([
    provider.getDomain(apiKey, authority.receivingDomainId),
    provider.getWebhook(apiKey, authority.providerWebhookId),
    assertReceivingDatabaseContracts(),
  ]);
  assertReadyDomain(domain);
  assertStagedWebhook(webhook, authority);
  const readiness: ReceivingReleaseReadiness = {
    buildRevision: buildIdentity.revision,
    checkedAt: new Date().toISOString(),
    checks: [
      "deployment-evidence",
      "database-contracts",
      "provider-domain",
      "provider-webhook",
    ],
  };
  await knowledgeDb.transaction(async (transaction) => {
    const current =
      await transaction.query.organizationReceivingConnections.findFirst({
        where: (table, { eq: equals }) =>
          equals(table.organizationId, input.organizationId),
      });
    if (
      !current ||
      current.id !== authority.connectionId ||
      current.webhookStagingSequence !== authority.stagingSequence ||
      current.providerWebhookId !== authority.providerWebhookId ||
      current.inboundEnabled ||
      current.webhookStatus !== "staged"
    ) {
      throw releaseNotReady();
    }
    await insertAdminEvent(transaction, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: "email",
      action: RELEASE_EVIDENCE_ACTION,
      targetType: "organization_receiving_connection",
      targetId: input.organizationId,
      message: "Verified inbound email release readiness.",
      metadata: {
        buildRevision: readiness.buildRevision,
        checks: readiness.checks,
        stagingSequence: authority.stagingSequence,
      },
    });
  });
  return readiness;
}

export async function assertReceivingReleaseReadiness(input: {
  organizationId: string;
  stagingSequence: number;
  env?: NodeJS.ProcessEnv;
  buildIdentity?: KestrelBuildIdentity;
}) {
  const env = input.env ?? process.env;
  const buildIdentity = input.buildIdentity ?? loadKestrelBuildIdentity(env);
  assertDeploymentEvidence(buildIdentity, env);
  const event = await knowledgeDb.query.adminEventLogs.findFirst({
    columns: { metadata: true },
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.organizationId, input.organizationId),
        equals(table.action, RELEASE_EVIDENCE_ACTION),
      ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
  const metadata = event?.metadata;
  if (
    !isReleaseEvidence(metadata) ||
    metadata.buildRevision !== buildIdentity.revision ||
    metadata.stagingSequence !== input.stagingSequence
  ) {
    throw releaseNotReady();
  }
}

async function prepareReadinessAuthority(organizationId: string) {
  const organization = await knowledgeDb.query.organizations.findFirst({
    columns: { lifecycleState: true },
    where: (table, { eq: equals }) => equals(table.id, organizationId),
  });
  if (organization?.lifecycleState !== "active") {
    throw receivingOrganizationUnavailable();
  }
  const row =
    await knowledgeDb.query.organizationReceivingConnections.findFirst({
      where: (table, { eq: equals }) =>
        equals(table.organizationId, organizationId),
    });
  if (
    !row ||
    row.credentialStatus !== "full_access" ||
    !row.encryptedApiKey ||
    !row.receivingDomainId ||
    !row.providerWebhookId ||
    !row.encryptedSigningSecret ||
    !row.webhookCreateIntent ||
    row.inboundEnabled ||
    row.webhookStatus !== "staged"
  ) {
    throw releaseNotReady();
  }
  return {
    connectionId: row.id,
    encryptedApiKey: row.encryptedApiKey,
    receivingDomainId: row.receivingDomainId,
    providerWebhookId: row.providerWebhookId,
    endpoint: row.webhookCreateIntent.endpoint,
    stagingSequence: row.webhookStagingSequence,
  } satisfies ReadinessAuthority;
}

async function assertReceivingDatabaseContracts() {
  await Promise.all([
    knowledgeDb
      .select({ id: schema.emailDeliveryReceipts.id })
      .from(schema.emailDeliveryReceipts)
      .limit(1),
    knowledgeDb
      .select({ id: schema.emailDeliveryAttachments.id })
      .from(schema.emailDeliveryAttachments)
      .limit(1),
    knowledgeDb
      .select({ id: schema.projectEmailTriggers.id })
      .from(schema.projectEmailTriggers)
      .limit(1),
    knowledgeDb
      .select({ id: schema.adminEventLogs.id })
      .from(schema.adminEventLogs)
      .limit(1),
  ]);
}

function assertReadyDomain(domain: ResendReceivingDomain) {
  if (
    domain.receiving !== "enabled" ||
    domain.status !== "verified" ||
    domain.mxStatus !== "verified"
  ) {
    throw releaseNotReady();
  }
}

function assertStagedWebhook(
  webhook: ResendWebhookProjection,
  authority: ReadinessAuthority,
) {
  if (
    webhook.id !== authority.providerWebhookId ||
    webhook.endpoint !== authority.endpoint ||
    webhook.status !== "disabled" ||
    webhook.events.length !== 1 ||
    webhook.events[0] !== "email.received"
  ) {
    throw releaseNotReady();
  }
}

function assertDeploymentEvidence(
  buildIdentity: KestrelBuildIdentity,
  env: NodeJS.ProcessEnv,
) {
  if (
    env.KESTREL_EMAIL_RECEIVING_RELEASE_EVIDENCE_REVISION?.trim() !==
      buildIdentity.revision ||
    env.KESTREL_EMAIL_RECEIVING_SECURITY_REVIEW_REVISION?.trim() !==
      buildIdentity.revision
  ) {
    throw releaseNotReady();
  }
}

function isReleaseEvidence(value: unknown): value is {
  buildRevision: string;
  stagingSequence: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "buildRevision") === "string" &&
    Number.isSafeInteger(Reflect.get(value, "stagingSequence"))
  );
}

function releaseNotReady() {
  return new ReceivingConfigError(
    "RESEND_RECEIVING_RELEASE_NOT_READY",
    "Inbound receiving release readiness has not passed for this staged connection.",
  );
}
