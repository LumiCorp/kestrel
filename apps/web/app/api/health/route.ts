/**
 * Health check endpoint for deployment verification
 * Useful for monitoring and verifying deployment status
 */
import { NextResponse } from "next/server";
import { getGatewayCredentialAuthorityReadiness } from "@/lib/ai/gateway-credential-readiness.server";
import { getDbHealth } from "@/lib/db/runtime";
import { buildHealthResponsePayload } from "./payload";

export async function GET() {
  const startTime = Date.now();
  const [databaseHealth, credentialAuthorityHealth] = await Promise.all([
    getDbHealth(),
    getGatewayCredentialAuthorityReadiness(),
  ]);
  const responseTime = Date.now() - startTime;
  const { body, statusCode } = buildHealthResponsePayload({
    databaseHealth,
    credentialAuthorityHealth,
    environment: process.env.NODE_ENV || "development",
    responseTimeMs: responseTime,
    uptimeSeconds: process.uptime(),
    version: process.env.npm_package_version || "1.0.0",
  });

  return NextResponse.json(body, {
    status: statusCode,
  });
}
