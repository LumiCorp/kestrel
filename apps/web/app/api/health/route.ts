/**
 * Health check endpoint for deployment verification
 * Useful for monitoring and verifying deployment status
 */
import { NextResponse } from "next/server";
import { getGatewayCredentialAuthorityReadiness } from "@/lib/ai/gateway-credential-readiness.server";
import { getDbHealth, getDbRuntimeConfig } from "@/lib/db/runtime";
import { inspectFlyReleaseCompatibilitySchema } from "@/lib/releases/deployment-preflight";
import { buildHealthResponsePayload } from "./payload";

export async function GET() {
  const startTime = Date.now();
  const databaseUrl = getDbRuntimeConfig().databaseUrl;
  const [databaseHealth, credentialAuthorityHealth, releaseCompatibilitySchema] =
    await Promise.all([
    getDbHealth(),
    getGatewayCredentialAuthorityReadiness(),
    databaseUrl
      ? inspectFlyReleaseCompatibilitySchema(databaseUrl).catch(() => ({
          ready: false,
          missingColumns: [],
        }))
      : Promise.resolve({ ready: false, missingColumns: [] }),
  ]);
  const responseTime = Date.now() - startTime;
  const { body, statusCode } = buildHealthResponsePayload({
    databaseHealth,
    credentialAuthorityHealth,
    releaseCompatibilitySchemaHealth: {
      ready: releaseCompatibilitySchema.ready,
    },
    environment: process.env.NODE_ENV || "development",
    responseTimeMs: responseTime,
    uptimeSeconds: process.uptime(),
    version: process.env.KESTREL_APP_VERSION,
    revision: process.env.KESTREL_BUILD_REVISION,
  });

  return NextResponse.json(body, {
    status: statusCode,
  });
}
