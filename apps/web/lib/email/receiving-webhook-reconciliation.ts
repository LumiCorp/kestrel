import "server-only";

import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { ResendHttpReceivingProvider } from "./receiving-provider";
import type { ResendWebhookCreateRecoveryProvider } from "./receiving-provider";
import { stageReceivingWebhook } from "./receiving-webhook-staging";

export const RECEIVING_WEBHOOK_RECONCILIATION_LIMIT = 10;

export type ReceivingWebhookReconciliationEvidence = {
  correlation: string;
  outcome: "failed" | "staged";
};

type ReconciliationInput = {
  env?: NodeJS.ProcessEnv;
  limit?: number;
  providerFactory?: (
    organizationId: string,
  ) => ResendWebhookCreateRecoveryProvider;
  report?: (evidence: ReceivingWebhookReconciliationEvidence) => void;
};

/**
 * Advances a bounded set of healthy pre-existing Receiving Connections through
 * the same durable webhook-staging authority used by an Admin save.
 */
export async function reconcileConfiguredReceivingWebhooks(
  input: ReconciliationInput = {},
) {
  const requestedLimit = Math.trunc(
    input.limit ?? RECEIVING_WEBHOOK_RECONCILIATION_LIMIT,
  );
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(
        RECEIVING_WEBHOOK_RECONCILIATION_LIMIT,
        Math.max(1, requestedLimit),
      )
    : RECEIVING_WEBHOOK_RECONCILIATION_LIMIT;
  const candidates = await knowledgeDb
    .select({
      organizationId: schema.organizationReceivingConnections.organizationId,
    })
    .from(schema.organizationReceivingConnections)
    .where(
      and(
        eq(schema.organizationReceivingConnections.provider, "resend"),
        isNotNull(schema.organizationReceivingConnections.encryptedApiKey),
        eq(
          schema.organizationReceivingConnections.credentialStatus,
          "full_access",
        ),
        isNotNull(
          schema.organizationReceivingConnections.credentialValidatedAt,
        ),
        isNotNull(schema.organizationReceivingConnections.receivingDomainId),
        isNotNull(schema.organizationReceivingConnections.receivingDomain),
        eq(
          schema.organizationReceivingConnections.receivingDomainStatus,
          "verified",
        ),
        eq(schema.organizationReceivingConnections.mxStatus, "verified"),
        isNotNull(schema.organizationReceivingConnections.domainCheckedAt),
        isNotNull(
          schema.organizationReceivingConnections.lastHealthCheckedAt,
        ),
        eq(schema.organizationReceivingConnections.inboundEnabled, false),
        inArray(schema.organizationReceivingConnections.webhookStatus, [
          "not_staged",
          "disabled",
          "error",
        ]),
        or(
          and(
            isNull(
              schema.organizationReceivingConnections.providerWebhookId,
            ),
            isNull(
              schema.organizationReceivingConnections.encryptedSigningSecret,
            ),
          ),
          and(
            isNotNull(
              schema.organizationReceivingConnections.providerWebhookId,
            ),
            isNotNull(
              schema.organizationReceivingConnections.encryptedSigningSecret,
            ),
          ),
        ),
      ),
    )
    .orderBy(
      sql`CASE ${schema.organizationReceivingConnections.webhookStatus}
        WHEN 'not_staged' THEN 0
        WHEN 'disabled' THEN 1
        ELSE 2
      END`,
      asc(schema.organizationReceivingConnections.updatedAt),
      asc(schema.organizationReceivingConnections.organizationId),
    )
    .limit(limit);

  let failed = 0;
  let staged = 0;
  for (const candidate of candidates) {
    const correlation = receivingCorrelation(candidate.organizationId);
    try {
      await stageReceivingWebhook({
        organizationId: candidate.organizationId,
        provider:
          input.providerFactory?.(candidate.organizationId) ??
          new ResendHttpReceivingProvider(),
        env: input.env,
      });
      staged += 1;
      emitEvidence(input.report, { correlation, outcome: "staged" });
    } catch {
      failed += 1;
      emitEvidence(input.report, { correlation, outcome: "failed" });
    }
  }
  return { attempted: candidates.length, failed, staged };
}

function receivingCorrelation(organizationId: string) {
  return createHash("sha256")
    .update(`kestrel:receiving-webhook-reconciliation:${organizationId}`)
    .digest("hex")
    .slice(0, 16);
}

function emitEvidence(
  reporter: ReconciliationInput["report"],
  evidence: ReceivingWebhookReconciliationEvidence,
) {
  try {
    (reporter ?? defaultReporter)(evidence);
  } catch {
    // Observability must never replace the durable reconciliation outcome.
  }
}

function defaultReporter(evidence: ReceivingWebhookReconciliationEvidence) {
  console.info("Kestrel One receiving webhook reconciliation completed.", evidence);
}
