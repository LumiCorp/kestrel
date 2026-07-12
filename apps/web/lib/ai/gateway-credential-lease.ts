import "server-only";

import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  assertGatewayCredentialLeaseEligible,
  buildGatewayCredentialLease,
  type GatewayCredentialLease,
  GatewayCredentialLeaseError,
  type GatewayCredentialLeaseRequest,
} from "./gateway-credential-lease-contract";
import { type GatewayProvider, getGatewayApiKey } from "./gateways";

export * from "./gateway-credential-lease-contract";

export async function issueGatewayCredentialLease(
  input: GatewayCredentialLeaseRequest,
  now = new Date()
): Promise<GatewayCredentialLease> {
  const [row] = await knowledgeDb
    .select({ gateway: schema.aiGateways, model: schema.aiGatewayModels })
    .from(schema.aiGatewayModels)
    .innerJoin(
      schema.aiGateways,
      eq(schema.aiGateways.id, schema.aiGatewayModels.gatewayId)
    )
    .where(
      and(
        eq(schema.aiGateways.id, input.gatewayId),
        eq(schema.aiGatewayModels.gatewayId, input.gatewayId),
        eq(schema.aiGatewayModels.rawModelId, input.rawModelId)
      )
    )
    .limit(1);

  if (!row) {
    throw new GatewayCredentialLeaseError(
      "GATEWAY_MODEL_NOT_APPROVED",
      "The requested gateway model is unavailable or not approved.",
      404
    );
  }
  assertGatewayCredentialLeaseEligible(row);

  return buildGatewayCredentialLease({
    gateway: {
      id: row.gateway.id,
      provider: row.gateway.provider as Exclude<GatewayProvider, "replicate">,
      baseUrl: row.gateway.baseUrl,
    },
    model: {
      rawModelId: row.model.rawModelId,
      metadata: row.model.metadata,
    },
    apiKey: getGatewayApiKey(row.gateway),
    now,
  });
}
