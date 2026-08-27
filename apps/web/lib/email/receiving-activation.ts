import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  decryptReceivingApiKey,
  ReceivingConfigError,
  receivingOrganizationUnavailable,
} from "./receiving-config";
import {
  ResendHttpReceivingProvider,
  type ResendReceivingProvider,
  type ResendWebhookProjection,
} from "./receiving-provider";

const ACTIVATION_FAILURE = "RESEND_RECEIVING_WEBHOOK_ACTIVATION_FAILED";
const DISABLE_FAILURE = "RESEND_RECEIVING_WEBHOOK_DISABLE_FAILED";

type ActivationAuthority = {
  organizationId: string;
  connectionId: string;
  encryptedApiKey: string;
  providerWebhookId: string;
  endpoint: string;
  stagingSequence: number;
};

/**
 * Changes only the already-staged provider webhook. Incoming requests stay
 * unavailable until the provider confirms the exact intended webhook state.
 */
export async function setReceivingInboundEnabled(input: {
  organizationId: string;
  enabled: boolean;
  provider?: ResendReceivingProvider;
  env?: NodeJS.ProcessEnv;
}) {
  if (!input.enabled) {
    return disableReceivingInbound(input);
  }

  const authority = await prepareEnableAuthority(input.organizationId);
  if (authority === null) return;
  const provider = input.provider ?? new ResendHttpReceivingProvider();
  try {
    const apiKey = decryptReceivingApiKey({
      organizationId: input.organizationId,
      encryptedApiKey: authority.encryptedApiKey,
      env: input.env,
    });
    let webhook = await provider.getWebhook(apiKey, authority.providerWebhookId);
    assertExpectedWebhook(webhook, authority, "disabled", "enabled");
    if (webhook.status === "disabled") {
      await provider.updateWebhook({
        apiKey,
        webhookId: authority.providerWebhookId,
        enabled: true,
      });
      webhook = await provider.getWebhook(apiKey, authority.providerWebhookId);
      assertExpectedWebhook(webhook, authority, "enabled");
    }
    await persistWebhookState({
      ...authority,
      inboundEnabled: true,
      webhookStatus: "active",
      lastErrorCode: null,
    });
  } catch (error) {
    await persistLifecycleFailure({
      authority,
      errorCode: ACTIVATION_FAILURE,
    });
    throw normalizeLifecycleError(error, ACTIVATION_FAILURE);
  }
}

async function disableReceivingInbound(input: {
  organizationId: string;
  provider?: ResendReceivingProvider;
  env?: NodeJS.ProcessEnv;
}) {
  const authority = await closeIngressAndPrepareDisable(input.organizationId);
  if (authority === null) return;
  const provider = input.provider ?? new ResendHttpReceivingProvider();
  try {
    const apiKey = decryptReceivingApiKey({
      organizationId: input.organizationId,
      encryptedApiKey: authority.encryptedApiKey,
      env: input.env,
    });
    let webhook = await provider.getWebhook(apiKey, authority.providerWebhookId);
    assertExpectedWebhook(webhook, authority, "enabled", "disabled");
    if (webhook.status === "enabled") {
      await provider.updateWebhook({
        apiKey,
        webhookId: authority.providerWebhookId,
        enabled: false,
      });
      webhook = await provider.getWebhook(apiKey, authority.providerWebhookId);
      assertExpectedWebhook(webhook, authority, "disabled");
    }
    await persistWebhookState({
      ...authority,
      inboundEnabled: false,
      webhookStatus: "disabled",
      lastErrorCode: null,
    });
  } catch (error) {
    await persistLifecycleFailure({ authority, errorCode: DISABLE_FAILURE });
    throw normalizeLifecycleError(error, DISABLE_FAILURE);
  }
}

async function prepareEnableAuthority(organizationId: string) {
  return knowledgeDb.transaction(async (transaction) => {
    await lockReceiving(transaction, organizationId);
    const organization = await transaction.query.organizations.findFirst({
      columns: { lifecycleState: true },
      where: (table, { eq: equals }) => equals(table.id, organizationId),
    });
    if (organization?.lifecycleState !== "active") {
      throw receivingOrganizationUnavailable();
    }
    const row = await transaction.query.organizationReceivingConnections.findFirst({
      where: (table, { eq: equals }) => equals(table.organizationId, organizationId),
    });
    if (!row) throw unavailable("Configure Resend receiving before enabling it.");
    if (row.inboundEnabled && row.webhookStatus === "active") return null;
    if (row.lastErrorCode === DISABLE_FAILURE) {
      throw unavailable("Retry disabling inbound receiving before enabling it.");
    }
    if (
      row.credentialStatus !== "full_access" ||
      row.receivingDomainStatus !== "verified" ||
      row.mxStatus !== "verified" ||
      !row.credentialValidatedAt ||
      !row.domainCheckedAt ||
      !row.lastHealthCheckedAt ||
      !row.encryptedApiKey ||
      !row.providerWebhookId ||
      !row.encryptedSigningSecret ||
      !row.webhookCreateIntent
    ) {
      throw unavailable("Inbound receiving is not ready to enable.");
    }
    if (!["staged", "disabled", "error"].includes(row.webhookStatus)) {
      throw unavailable("Inbound receiving is not ready to enable.");
    }
    return {
      organizationId,
      connectionId: row.id,
      encryptedApiKey: row.encryptedApiKey,
      providerWebhookId: row.providerWebhookId,
      endpoint: row.webhookCreateIntent.endpoint,
      stagingSequence: row.webhookStagingSequence,
    } satisfies ActivationAuthority;
  });
}

async function closeIngressAndPrepareDisable(organizationId: string) {
  return knowledgeDb.transaction(async (transaction) => {
    await lockReceiving(transaction, organizationId);
    const row = await transaction.query.organizationReceivingConnections.findFirst({
      where: (table, { eq: equals }) => equals(table.organizationId, organizationId),
    });
    if (!row) return null;
    const stagingSequence = row.webhookStagingSequence + 1;
    const closed = await transaction
      .update(schema.organizationReceivingConnections)
      .set({
        inboundEnabled: false,
        webhookStatus: "disabled",
        webhookStagingSequence: stagingSequence,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizationReceivingConnections.id, row.id))
      .returning({ id: schema.organizationReceivingConnections.id });
    if (closed.length !== 1) throw superseded();
    if (!(row.encryptedApiKey && row.providerWebhookId && row.webhookCreateIntent)) {
      return null;
    }
    return {
      organizationId,
      connectionId: row.id,
      encryptedApiKey: row.encryptedApiKey,
      providerWebhookId: row.providerWebhookId,
      endpoint: row.webhookCreateIntent.endpoint,
      stagingSequence,
    } satisfies ActivationAuthority;
  });
}

function assertExpectedWebhook(
  webhook: ResendWebhookProjection,
  authority: ActivationAuthority,
  ...allowedStatuses: Array<ResendWebhookProjection["status"]>
) {
  if (
    webhook.id !== authority.providerWebhookId ||
    webhook.endpoint !== authority.endpoint ||
    webhook.events.length !== 1 ||
    webhook.events[0] !== "email.received" ||
    !allowedStatuses.includes(webhook.status)
  ) {
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_WEBHOOK_INVALID",
      "Resend webhook activation could not be verified.",
    );
  }
}

async function persistWebhookState(input: ActivationAuthority & {
  inboundEnabled: boolean;
  webhookStatus: "active" | "disabled";
  lastErrorCode: string | null;
}) {
  const persisted = await knowledgeDb.transaction(async (transaction) => {
    await lockReceiving(transaction, input.organizationId);
    return transaction
      .update(schema.organizationReceivingConnections)
      .set({
        inboundEnabled: input.inboundEnabled,
        webhookStatus: input.webhookStatus,
        lastErrorCode: input.lastErrorCode,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.organizationReceivingConnections.id, input.connectionId),
          eq(
            schema.organizationReceivingConnections.encryptedApiKey,
            input.encryptedApiKey,
          ),
          eq(
            schema.organizationReceivingConnections.providerWebhookId,
            input.providerWebhookId,
          ),
          eq(
            schema.organizationReceivingConnections.webhookStagingSequence,
            input.stagingSequence,
          ),
        ),
      )
      .returning({ id: schema.organizationReceivingConnections.id });
  });
  if (persisted.length !== 1) throw superseded();
}

async function persistLifecycleFailure(input: {
  authority: ActivationAuthority | null;
  errorCode: string;
}) {
  const authority = input.authority;
  if (!authority) return;
  await knowledgeDb.transaction(async (transaction) => {
    await lockReceiving(transaction, authority.organizationId);
    await transaction
      .update(schema.organizationReceivingConnections)
      .set({
        inboundEnabled: false,
        webhookStatus: "error",
        lastErrorCode: input.errorCode,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.organizationReceivingConnections.id, authority.connectionId),
          eq(
            schema.organizationReceivingConnections.encryptedApiKey,
            authority.encryptedApiKey,
          ),
          eq(
            schema.organizationReceivingConnections.providerWebhookId,
            authority.providerWebhookId,
          ),
          eq(
            schema.organizationReceivingConnections.webhookStagingSequence,
            authority.stagingSequence,
          ),
        ),
      );
  });
}

async function lockReceiving(
  transaction: Parameters<Parameters<typeof knowledgeDb.transaction>[0]>[0],
  organizationId: string,
) {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:receiving:${organizationId}`}, 0))`,
  );
}

function unavailable(message: string) {
  return new ReceivingConfigError("RESEND_RECEIVING_WEBHOOK_NOT_READY", message);
}

function superseded() {
  return new ReceivingConfigError(
    "RESEND_RECEIVING_SAVE_SUPERSEDED",
    "The receiving configuration changed while activation was in progress.",
  );
}

function normalizeLifecycleError(error: unknown, fallbackCode: string) {
  if (error instanceof ReceivingConfigError) return error;
  return new ReceivingConfigError(
    fallbackCode,
    "Resend webhook activation is temporarily unavailable.",
  );
}
