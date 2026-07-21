import assert from "node:assert/strict";
import {
  classifyDbError,
  getDbHealth,
  getDbRuntimeConfig,
  getDrizzleDb,
  getKyselyDb,
  getPgPool,
  resetDbRuntimeForTests,
} from "./runtime";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


function withEnv(overrides: Record<string, string | undefined>) {
  const originalEnv = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    originalEnv.set(key, process.env[key]);

    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return async () => {
    await resetDbRuntimeForTests();

    for (const [key, value] of originalEnv.entries()) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

contractTest("web.hermetic", "runtime config applies bounded development defaults", async () => {
  const restore = withEnv({
    DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
    NODE_ENV: "development",
  });

  try {
    const config = getDbRuntimeConfig();
    assert.equal(config.cacheScope, "global");
    assert.equal(config.drizzle.maxConnections, 4);
    assert.equal(config.kysely.maxConnections, 4);
    assert.equal(config.drizzle.prepare, false);
  } finally {
    await restore();
  }
});

contractTest("web.hermetic", "classifyDbError recognizes missing database configuration", () => {
  const classified = classifyDbError(
    new Error("DATABASE_URL or POSTGRES_URL not configured")
  );

  assert.equal(classified.category, "misconfigured_database");
  assert.equal(classified.retryable, false);
});

contractTest("web.hermetic", "classifyDbError does not misclassify non-database required errors", () => {
  const classified = classifyDbError(new Error("Active organization required"));

  assert.equal(classified.category, "unknown");
  assert.equal(classified.retryable, false);
});

contractTest("web.hermetic", "classifyDbError recognizes too many clients failures", () => {
  const classified = classifyDbError({
    cause: { code: "53300", message: "sorry, too many clients already" },
    message: "Failed query: insert into organization_tool_connections",
  });

  assert.equal(classified.category, "too_many_clients");
  assert.equal(classified.retryable, true);
});

contractTest("web.hermetic", "classifyDbError recognizes transient network failures", () => {
  const classified = classifyDbError(
    new Error("connect ECONNREFUSED 127.0.0.1:5432")
  );

  assert.equal(classified.category, "transient_network");
  assert.equal(classified.retryable, true);
});

contractTest("web.hermetic", "classifyDbError recognizes authentication failures", () => {
  const classified = classifyDbError(
    new Error("password authentication failed for user postgres")
  );

  assert.equal(classified.category, "authentication_failed");
  assert.equal(classified.retryable, false);
});

contractTest("web.hermetic", "runtime reuses shared db clients across repeated lookups", async () => {
  const restore = withEnv({
    DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
    NODE_ENV: "development",
  });

  try {
    const drizzleA = getDrizzleDb();
    const drizzleB = getDrizzleDb();
    const poolA = getPgPool();
    const poolB = getPgPool();
    const kyselyA = getKyselyDb();
    const kyselyB = getKyselyDb();

    assert.equal(drizzleA, drizzleB);
    assert.equal(poolA, poolB);
    assert.equal(kyselyA, kyselyB);
  } finally {
    await restore();
  }
});

contractTest("web.hermetic", "getDbHealth reports stable category when database is missing", async () => {
  const restore = withEnv({
    DATABASE_URL: undefined,
    POSTGRES_URL: undefined,
    NODE_ENV: "test",
  });

  try {
    const result = await getDbHealth();

    assert.equal(result.ok, false);
    assert.equal(result.category, "misconfigured_database");
    assert.equal(result.diagnostics.databaseUrlConfigured, false);
  } finally {
    await restore();
  }
});
