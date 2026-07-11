import type { DbHealthResult } from "@/lib/db/runtime";

function isDatabasePressureHigh(databaseHealth: DbHealthResult) {
  const pressure = databaseHealth.diagnostics.pressure;

  if (!pressure) {
    return false;
  }

  if (pressure.pool.waitingCount > 0) {
    return true;
  }

  if (!pressure.database?.maxConnections) {
    return false;
  }

  return (
    pressure.database.currentDatabaseConnections /
      pressure.database.maxConnections >=
    0.8
  );
}

export function buildHealthResponsePayload(input: {
  databaseHealth: DbHealthResult;
  environment?: string;
  responseTimeMs: number;
  uptimeSeconds: number;
  version?: string;
}) {
  const degraded = input.databaseHealth.ok
    ? isDatabasePressureHigh(input.databaseHealth)
    : false;
  const status = input.databaseHealth.ok
    ? degraded
      ? "degraded"
      : "healthy"
    : "unhealthy";
  const statusCode = status === "unhealthy" ? 503 : 200;

  return {
    body: {
      status,
      timestamp: new Date().toISOString(),
      version: input.version || "1.0.0",
      environment: input.environment || "development",
      checks: {
        database: {
          connected: input.databaseHealth.ok,
          category: input.databaseHealth.category,
          error: input.databaseHealth.details,
          diagnostics: input.databaseHealth.diagnostics,
        },
      },
      responseTime: `${input.responseTimeMs}ms`,
      uptime: input.uptimeSeconds,
    },
    statusCode,
  };
}
