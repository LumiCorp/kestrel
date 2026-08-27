import "server-only";

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { resolveKestrelAppUrl } from "@/lib/app-url";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  decryptReceivingApiKey,
  decryptReceivingSigningSecret,
  encryptReceivingSigningSecret,
  ReceivingConfigError,
} from "./receiving-config";
import {
  prepareResendWebhookCreateIntent,
  type ResendWebhookCreateRecoveryProvider,
} from "./receiving-provider";

export async function stageReceivingWebhook(input: {
  organizationId: string;
  provider: ResendWebhookCreateRecoveryProvider;
  env?: NodeJS.ProcessEnv;
}) {
  const authority = await prepareStagingAuthority(input);
  let created: { id: string; signingSecret: string };
  try {
    if (
      Boolean(authority.providerWebhookId) !== Boolean(authority.signingSecret)
    ) {
      throw new ReceivingConfigError(
        "RESEND_RECEIVING_WEBHOOK_CONFLICT",
        "Resend webhook staging requires operator review.",
      );
    }
    created = authority.providerWebhookId
      ? {
          id: authority.providerWebhookId,
          signingSecret: authority.signingSecret,
        }
      : authority.createAttempted
        ? await input.provider.reconcileWebhookCreate({
            apiKey: authority.apiKey,
            intent: authority.intent,
          })
        : await createAfterAttemptCheckpoint({ ...input, ...authority });
    if (!authority.providerWebhookId) {
      await persistCreateEvidence({
        organizationId: input.organizationId,
        encryptedApiKey: authority.encryptedApiKey,
        stagingSequence: authority.stagingSequence,
        providerWebhookId: created.id,
        encryptedSigningSecret: encryptReceivingSigningSecret({
          organizationId: input.organizationId,
          signingSecret: created.signingSecret,
          env: input.env,
        }),
      });
    }

    const projected = await input.provider.getWebhook(
      authority.apiKey,
      created.id,
    );
    if (
      projected.endpoint !== authority.intent.endpoint ||
      projected.status !== "disabled"
    ) {
      await input.provider.updateWebhook({
        apiKey: authority.apiKey,
        webhookId: created.id,
        ...(projected.endpoint === authority.intent.endpoint
          ? {}
          : { endpoint: authority.intent.endpoint }),
        enabled: false,
      });
    }
    const verified = await input.provider.getWebhook(
      authority.apiKey,
      created.id,
    );
    if (
      verified.id !== created.id ||
      verified.endpoint !== authority.intent.endpoint ||
      verified.status !== "disabled" ||
      verified.events.length !== 1 ||
      verified.events[0] !== "email.received"
    ) {
      throw new ReceivingConfigError(
        "RESEND_RECEIVING_WEBHOOK_INVALID",
        "Resend webhook staging could not be verified.",
      );
    }
    const staged = await knowledgeDb
      .update(schema.organizationReceivingConnections)
      .set({
        webhookStatus: "staged",
        inboundEnabled: false,
        lastErrorCode: null,
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
            authority.encryptedApiKey,
          ),
          eq(
            schema.organizationReceivingConnections.webhookStagingSequence,
            authority.stagingSequence,
          ),
          eq(
            schema.organizationReceivingConnections.providerWebhookId,
            created.id,
          ),
        ),
      )
      .returning({ id: schema.organizationReceivingConnections.id });
    if (staged.length === 0) {
      const alreadyStaged = await confirmAlreadyStagedAuthority({
        ...authority,
        organizationId: input.organizationId,
        providerWebhookId: created.id,
      });
      if (!alreadyStaged) throw stagingSuperseded();
    }
  } catch (error) {
    const persisted = await knowledgeDb
      .update(schema.organizationReceivingConnections)
      .set({
        webhookStatus: "error",
        inboundEnabled: false,
        lastErrorCode: "RESEND_RECEIVING_WEBHOOK_STAGING_FAILED",
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
            authority.encryptedApiKey,
          ),
          eq(
            schema.organizationReceivingConnections.webhookStagingSequence,
            authority.stagingSequence,
          ),
          ne(schema.organizationReceivingConnections.webhookStatus, "staged"),
        ),
      )
      .returning({ id: schema.organizationReceivingConnections.id });
    if (persisted.length === 0) {
      const alreadyStaged = await confirmAlreadyStagedAuthority({
        ...authority,
        organizationId: input.organizationId,
      });
      if (alreadyStaged) return;
      throw stagingSuperseded();
    }
    if (error instanceof ReceivingConfigError) throw error;
    throw new ReceivingConfigError(
      "RESEND_RECEIVING_WEBHOOK_STAGING_FAILED",
      "Resend webhook staging is temporarily unavailable.",
    );
  }
}

async function prepareStagingAuthority(input: {
  organizationId: string;
  env?: NodeJS.ProcessEnv;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:receiving:${input.organizationId}`}, 0))`,
    );
    const row =
      await transaction.query.organizationReceivingConnections.findFirst({
        where: (table, { eq }) =>
          eq(table.organizationId, input.organizationId),
      });
    if (!(row?.encryptedApiKey && row.receivingDomain)) {
      throw new ReceivingConfigError(
        "RESEND_RECEIVING_CREDENTIAL_REQUIRED",
        "Configure Resend receiving before staging its webhook.",
      );
    }
    const intent =
      row.webhookCreateIntent ??
      prepareResendWebhookCreateIntent(
        new URL(
          `/api/webhooks/resend/inbound/${encodeURIComponent(row.routeLocator)}`,
          resolveKestrelAppUrl(input.env),
        ).toString(),
      );
    if (!row.webhookCreateIntent) {
      await transaction
        .update(schema.organizationReceivingConnections)
        .set({ webhookCreateIntent: intent, updatedAt: new Date() })
        .where(
          and(
            eq(schema.organizationReceivingConnections.id, row.id),
            eq(
              schema.organizationReceivingConnections.encryptedApiKey,
              row.encryptedApiKey,
            ),
            eq(
              schema.organizationReceivingConnections.webhookStagingSequence,
              row.webhookStagingSequence,
            ),
          ),
        );
    }
    return {
      apiKey: decryptReceivingApiKey({
        organizationId: input.organizationId,
        encryptedApiKey: row.encryptedApiKey,
        env: input.env,
      }),
      createAttempted: row.webhookCreateAttemptedAt !== null,
      encryptedApiKey: row.encryptedApiKey,
      intent,
      providerWebhookId: row.providerWebhookId,
      signingSecret: row.encryptedSigningSecret
        ? decryptReceivingSigningSecret({
            organizationId: input.organizationId,
            encryptedSigningSecret: row.encryptedSigningSecret,
            env: input.env,
          })
        : "",
      stagingSequence: row.webhookStagingSequence,
    };
  });
}

async function createAfterAttemptCheckpoint(
  input: {
    organizationId: string;
    provider: ResendWebhookCreateRecoveryProvider;
  } & Awaited<ReturnType<typeof prepareStagingAuthority>>,
) {
  const claimed = await knowledgeDb
    .update(schema.organizationReceivingConnections)
    .set({ webhookCreateAttemptedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(
          schema.organizationReceivingConnections.organizationId,
          input.organizationId,
        ),
        isNull(schema.organizationReceivingConnections.webhookCreateAttemptedAt),
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
  if (claimed.length === 0) {
    return input.provider.reconcileWebhookCreate({
      apiKey: input.apiKey,
      intent: input.intent,
    });
  }
  return input.provider.createWebhook({
    apiKey: input.apiKey,
    intent: input.intent,
  });
}

async function persistCreateEvidence(input: {
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
    const row =
      await transaction.query.organizationReceivingConnections.findFirst({
        where: (table, { eq }) =>
          eq(table.organizationId, input.organizationId),
      });
    if (
      !row ||
      row.encryptedApiKey !== input.encryptedApiKey ||
      row.webhookStagingSequence !== input.stagingSequence
    ) {
      throw stagingSuperseded();
    }
    if (row.providerWebhookId && row.providerWebhookId !== input.providerWebhookId) {
      throw new ReceivingConfigError(
        "RESEND_RECEIVING_WEBHOOK_CONFLICT",
        "Resend webhook staging requires operator review.",
      );
    }
    await transaction
      .update(schema.organizationReceivingConnections)
      .set({
        providerWebhookId: input.providerWebhookId,
        encryptedSigningSecret: input.encryptedSigningSecret,
        webhookStatus: "disabled",
        inboundEnabled: false,
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
      );
  });
}

async function confirmAlreadyStagedAuthority(input: {
  organizationId: string;
  encryptedApiKey: string;
  stagingSequence: number;
  providerWebhookId?: string | null;
}) {
  const row =
    await knowledgeDb.query.organizationReceivingConnections.findFirst({
      columns: {
        encryptedApiKey: true,
        providerWebhookId: true,
        webhookStagingSequence: true,
        webhookStatus: true,
      },
      where: (table, { eq }) => eq(table.organizationId, input.organizationId),
    });
  if (
    !row ||
    row.encryptedApiKey !== input.encryptedApiKey ||
    row.webhookStagingSequence !== input.stagingSequence ||
    (input.providerWebhookId &&
      row.providerWebhookId !== input.providerWebhookId)
  ) {
    throw stagingSuperseded();
  }
  return row.webhookStatus === "staged";
}

function stagingSuperseded() {
  return new ReceivingConfigError(
    "RESEND_RECEIVING_SAVE_SUPERSEDED",
    "The receiving configuration changed while its webhook was being staged. Refresh and try again.",
  );
}
