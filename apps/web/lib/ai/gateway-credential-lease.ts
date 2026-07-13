import "server-only";

import { and, eq, isNull, or } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  assertGatewayCredentialLeaseEligible,
  buildGatewayCredentialLease,
  type GatewayCredentialLease,
  GatewayCredentialLeaseError,
  type GatewayCredentialLeaseRequest,
} from "./gateway-credential-lease-contract";
import { type GatewayProvider, getGatewayApiKey } from "./gateways";
import { resolveRunPodProviderApiKey } from "./managed-runpod-connection";

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
        or(
          isNull(schema.aiGateways.organizationId),
          eq(schema.aiGateways.organizationId, input.organizationId)
        ),
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
  if (row.gateway.deploymentId) {
    const deployment = await knowledgeDb.query.aiDeployments.findFirst({
      where: and(
        eq(schema.aiDeployments.id, row.gateway.deploymentId),
        eq(schema.aiDeployments.organizationId, input.organizationId),
        eq(schema.aiDeployments.status, "ready")
      ),
      columns: { id: true },
    });
    if (!deployment) {
      throw new GatewayCredentialLeaseError(
        "GATEWAY_DEPLOYMENT_NOT_READY",
        "The requested managed model deployment is unavailable.",
        409
      );
    }
  }

  let apiKey = getGatewayApiKey(row.gateway);
  if (row.gateway.providerConnectionId) {
    const connection = await knowledgeDb.query.aiProviderConnections.findFirst({
      where: eq(
        schema.aiProviderConnections.id,
        row.gateway.providerConnectionId
      ),
    });
    if (!connection) {
      throw new GatewayCredentialLeaseError(
        "GATEWAY_CREDENTIAL_MISSING",
        "The managed provider connection is unavailable.",
        503
      );
    }
    apiKey = resolveRunPodProviderApiKey(connection);
  }

  return buildGatewayCredentialLease({
    organizationId: input.organizationId,
    gateway: {
      id: row.gateway.id,
      provider: row.gateway.provider as Exclude<GatewayProvider, "replicate">,
      baseUrl: row.gateway.baseUrl,
    },
    model: {
      rawModelId: row.model.rawModelId,
      metadata: row.model.metadata,
    },
    apiKey,
    now,
  });
}
