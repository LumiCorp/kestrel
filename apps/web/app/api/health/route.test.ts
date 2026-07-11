import assert from "node:assert/strict";
import test from "node:test";
import { buildHealthResponsePayload } from "./payload";

test("health payload reports healthy database state", () => {
  const { body, statusCode } = buildHealthResponsePayload({
    databaseHealth: {
      ok: true,
      diagnostics: {
        config: {
          cacheScope: "global",
          drizzle: {
            connectTimeoutSeconds: 10,
            idleTimeoutSeconds: 10,
            maxConnections: 4,
            maxLifetimeSeconds: 300,
            prepare: false,
          },
          kysely: {
            connectionTimeoutMillis: 10_000,
            idleTimeoutMillis: 10_000,
            maxConnections: 4,
            maxLifetimeSeconds: 300,
          },
        },
        databaseUrlConfigured: true,
        lastError: null,
        lastHealthyAt: null,
        pressure: {
          pool: {
            idleCount: 1,
            totalCount: 2,
            waitingCount: 0,
          },
        },
      },
    },
    environment: "test",
    responseTimeMs: 5,
    uptimeSeconds: 10,
    version: "1.2.3",
  });

  assert.equal(statusCode, 200);
  assert.equal(body.status, "healthy");
  assert.equal(body.checks.database.connected, true);
  assert.equal(body.environment, "test");
  assert.equal(body.version, "1.2.3");
});

test("health payload reports unhealthy categorized database failures", () => {
  const { body, statusCode } = buildHealthResponsePayload({
    databaseHealth: {
      ok: false,
      category: "too_many_clients",
      details: "sorry, too many clients already",
      diagnostics: {
        config: {
          cacheScope: "global",
          drizzle: {
            connectTimeoutSeconds: 10,
            idleTimeoutSeconds: 10,
            maxConnections: 4,
            maxLifetimeSeconds: 300,
            prepare: false,
          },
          kysely: {
            connectionTimeoutMillis: 10_000,
            idleTimeoutMillis: 10_000,
            maxConnections: 4,
            maxLifetimeSeconds: 300,
          },
        },
        databaseUrlConfigured: true,
        lastError: {
          at: "2026-03-19T00:00:00.000Z",
          category: "too_many_clients",
          details: "sorry, too many clients already",
          retryable: true,
        },
        lastHealthyAt: null,
        pressure: null,
      },
    },
    responseTimeMs: 8,
    uptimeSeconds: 12,
  });

  assert.equal(statusCode, 503);
  assert.equal(body.status, "unhealthy");
  assert.equal(body.checks.database.category, "too_many_clients");
  assert.equal(body.checks.database.error, "sorry, too many clients already");
});
