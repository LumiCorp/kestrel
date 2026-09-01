import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  decryptReceivingApiKey,
  encryptReceivingSigningSecret,
} from "./receiving-config";
import {
  ResendHttpReceivingProvider,
  type ResendWebhookCreateIntent,
  type ResendWebhookDecommissionProvider,
} from "./receiving-provider";

export class ReceivingDecommissionError extends Error {
  readonly code = "RESEND_RECEIVING_DECOMMISSION_FAILED";

  constructor() {
    super("Resend receiving could not be removed. Retry organization deletion.");
    this.name = "ReceivingDecommissionError";
  }
}

/**
 * Remove the Organization-owned Resend webhook before its local credential and
 * identity can be cascaded. Every externally supplied diagnostic is normalized
 * to ReceivingDecommissionError so deletion records remain content-free.
 */
export async function decommissionOrganizationReceivingWebhook(input: {
  organizationId: string;
  provider?: ResendWebhookDecommissionProvider;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const authority = await disableIngressAndPrepareAuthority(input.organizationId);
  if (!authority.cleanupRequired) return;

  const provider = input.provider ?? new ResendHttpReceivingProvider();
  try {
    const apiKey = decryptReceivingApiKey({
      organizationId: input.organizationId,
      encryptedApiKey: authority.encryptedApiKey,
      env: input.env,
    });
    let webhookId = authority.providerWebhookId;
    if (!webhookId) {
      if (!authority.createIntent) throw new ReceivingDecommissionError();
      const recovered = await provider.reconcileWebhookCreateIfPresent({
        apiKey,
        intent: authority.createIntent,
      });
      if (!recovered) return;
      await persistRecoveredCreateEvidence({
        organizationId: input.organizationId,
        encryptedApiKey: authority.encryptedApiKey,
        stagingSequence: authority.stagingSequence,
        providerWebhookId: recovered.id,
        encryptedSigningSecret: encryptReceivingSigningSecret({
          organizationId: input.organizationId,
          signingSecret: recovered.signingSecret,
          env: input.env,
        }),
      });
      webhookId = recovered.id;
    }

    await provider.removeWebhook(apiKey, webhookId);
    const remaining = await provider.getWebhookIfPresent(apiKey, webhookId);
    if (remaining !== null) throw new ReceivingDecommissionError();
  } catch {
    throw new ReceivingDecommissionError();
  }
}

type PreparedDecommissionAuthority =
  | { cleanupRequired: false }
  | {
      cleanupRequired: true;
      encryptedApiKey: string;
      providerWebhookId: string | null;
      createIntent: ResendWebhookCreateIntent | null;
      stagingSequence: number;
    };

async function disableIngressAndPrepareAuthority(
  organizationId: string,
): Promise<PreparedDecommissionAuthority> {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:receiving:${organizationId}`}, 0))`,
    );
    const row =
      await transaction.query.organizationReceivingConnections.findFirst({
        where: (table, { eq: equals }) =>
          equals(table.organizationId, organizationId),
      });
    if (!row) return { cleanupRequired: false };

    const stagingSequence = row.webhookStagingSequence + 1;
    await transaction
      .update(schema.organizationReceivingConnections)
      .set({
        inboundEnabled: false,
        webhookStatus: "disabled",
        webhookStagingSequence: stagingSequence,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizationReceivingConnections.id, row.id));

    const cleanupRequired =
      Boolean(row.providerWebhookId) || row.webhookCreateAttemptedAt !== null;
    if (!cleanupRequired) return { cleanupRequired: false };
    if (
      !(
        row.encryptedApiKey &&
        (row.providerWebhookId || row.webhookCreateIntent)
      )
    ) {
      throw new ReceivingDecommissionError();
    }
    return {
      cleanupRequired: true,
      encryptedApiKey: row.encryptedApiKey,
      providerWebhookId: row.providerWebhookId,
      createIntent: row.webhookCreateIntent,
      stagingSequence,
    };
  });
}

async function persistRecoveredCreateEvidence(input: {
  organizationId: string;
  encryptedApiKey: string;
  stagingSequence: number;
  providerWebhookId: string;
  encryptedSigningSecret: string;
}) {
  await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:receiving:${input.organizationId}`}, 0))`,
    );
    const current =
      await transaction.query.organizationReceivingConnections.findFirst({
        where: (table, { eq: equals }) =>
          equals(table.organizationId, input.organizationId),
      });
    if (
      !current ||
      current.encryptedApiKey !== input.encryptedApiKey ||
      current.webhookStagingSequence !== input.stagingSequence ||
      (current.providerWebhookId !== null &&
        current.providerWebhookId !== input.providerWebhookId)
    ) {
      throw new ReceivingDecommissionError();
    }
    const persisted = await transaction
      .update(schema.organizationReceivingConnections)
      .set({
        providerWebhookId: input.providerWebhookId,
        encryptedSigningSecret: input.encryptedSigningSecret,
        inboundEnabled: false,
        webhookStatus: "disabled",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(
            schema.organizationReceivingConnections.organizationId,
            input.organizationId,
          ),
          eq(
            schema.organizationReceivingConnections.encryptedApiKey,
            input.encryptedApiKey,
          ),
          eq(
            schema.organizationReceivingConnections.webhookStagingSequence,
            input.stagingSequence,
          ),
        ),
      )
      .returning({ id: schema.organizationReceivingConnections.id });
    if (persisted.length !== 1) throw new ReceivingDecommissionError();
  });
}
