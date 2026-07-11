/**
 * Health check endpoint for deployment verification
 * Useful for monitoring and verifying deployment status
 */
import { NextResponse } from "next/server";
import { getDbHealth } from "@/lib/db/runtime";
import { buildHealthResponsePayload } from "./payload";

export async function GET() {
  const startTime = Date.now();
  const databaseHealth = await getDbHealth();
  const responseTime = Date.now() - startTime;
  const { body, statusCode } = buildHealthResponsePayload({
    databaseHealth,
    environment: process.env.NODE_ENV || "development",
    responseTimeMs: responseTime,
    uptimeSeconds: process.uptime(),
    version: process.env.npm_package_version || "1.0.0",
  });

  return NextResponse.json(body, {
    status: statusCode,
  });
}
