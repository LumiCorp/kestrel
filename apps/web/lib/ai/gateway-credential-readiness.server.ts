import "server-only";

import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  type GatewayCredentialAuthorityHealth,
  getGatewayCredentialAuthorityHealth,
  getGatewayCredentialStorageHealth,
} from "./gateway-credential-readiness";

export async function getGatewayCredentialAuthorityReadiness(): Promise<GatewayCredentialAuthorityHealth> {
  const configured = getGatewayCredentialAuthorityHealth();
  if (!configured.ok) {
    return configured;
  }

  try {
    const rows = await knowledgeDb
      .select({
        id: schema.aiGateways.id,
        apiKey: schema.aiGateways.apiKey,
        apiKeyEnvVar: schema.aiGateways.apiKeyEnvVar,
      })
      .from(schema.aiGateways);
    return getGatewayCredentialStorageHealth(rows);
  } catch {
    return {
      ok: false,
      code: "GATEWAY_CREDENTIAL_STORAGE_UNAVAILABLE",
    };
  }
}
