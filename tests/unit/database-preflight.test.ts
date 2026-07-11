import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import { DEFAULT_KESTREL_DB_PORT } from "../../src/config/localDev.js";
import {
  describeConnectionFailure,
  maybeBuildDatabaseConnectionFailure,
  preflightDatabaseConnection,
  resolveDatabasePreflightTarget,
} from "../../src/runtime/databasePreflight.js";

test("resolveDatabasePreflightTarget parses the default local harness database", () => {
  const target = resolveDatabasePreflightTarget(
    `postgres://kestrel:kestrel@localhost:${DEFAULT_KESTREL_DB_PORT}/kestrel`,
  );

  assert.deepEqual(target, {
    host: "localhost",
    port: DEFAULT_KESTREL_DB_PORT,
    database: "kestrel",
    isLocalHarnessDefault: true,
  });
});

test("resolveDatabasePreflightTarget marks non-default databases as non-local-harness targets", () => {
  const target = resolveDatabasePreflightTarget("postgres://kestrel:kestrel@db.internal:5432/reference");

  assert.equal(target.host, "db.internal");
  assert.equal(target.port, 5432);
  assert.equal(target.database, "reference");
  assert.equal(target.isLocalHarnessDefault, false);
});

test("preflightDatabaseConnection reports invalid DATABASE_URL payloads with actionable guidance", async () => {
  const result = await preflightDatabaseConnection({
    descriptor: {
      databaseUrl: "mysql://root@localhost:3306/demo",
      databaseUrlSource: "environment",
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected invalid database URL failure");
  }
  assert.equal(result.failure.code, "DATABASE_URL_INVALID");
  assert.match(result.failure.message, /must use postgres/u);
  assert.match(result.failure.recommendedAction, /Fix DATABASE_URL/u);
});

test("maybeBuildDatabaseConnectionFailure fills in blank ECONNREFUSED failures", () => {
  const failure = maybeBuildDatabaseConnectionFailure({
    error: Object.assign(new Error(""), { code: "ECONNREFUSED" }),
    descriptor: {
      databaseUrl: `postgres://kestrel:kestrel@localhost:${DEFAULT_KESTREL_DB_PORT}/kestrel`,
      databaseUrlSource: "desktop_default",
    },
  });

  assert.ok(failure);
  assert.equal(failure?.code, "ECONNREFUSED");
  assert.match(failure?.message ?? "", /Desktop Postgres is not reachable/u);
  assert.equal(failure?.details?.host, "localhost");
  assert.equal(failure?.details?.port, DEFAULT_KESTREL_DB_PORT);
  assert.equal(failure?.details?.databaseUrlSource, "desktop_default");
});

test("maybeBuildDatabaseConnectionFailure ignores non-connection runtime failures", () => {
  const failure = maybeBuildDatabaseConnectionFailure({
    error: Object.assign(new Error("Thread has a pending context checkpoint."), {
      code: "CONTEXT_CHECKPOINT_PENDING",
      details: {
        checkpointId: "checkpoint-1",
        recommendedAction: "compact",
      },
    }),
    descriptor: {
      databaseUrl: `postgres://kestrel:kestrel@localhost:${DEFAULT_KESTREL_DB_PORT}/kestrel`,
      databaseUrlSource: "environment",
    },
  });

  assert.equal(failure, undefined);
});

test("maybeBuildDatabaseConnectionFailure reports hosted desktop external source guidance", () => {
  const failure = maybeBuildDatabaseConnectionFailure({
    error: Object.assign(new Error(""), { code: "ECONNREFUSED" }),
    descriptor: {
      databaseUrl: "postgres://kestrel:kestrel@db.example:5432/kestrel",
      databaseUrlSource: "desktop_external",
    },
  });

  assert.ok(failure);
  assert.equal(failure?.code, "ECONNREFUSED");
  assert.match(failure?.message ?? "", /Hosted Postgres is not reachable/u);
  assert.match(failure?.recommendedAction ?? "", /Settings > Database/u);
  assert.equal(failure?.details?.databaseUrlSource, "desktop_external");
});

test("maybeBuildDatabaseConnectionFailure reports Local Core managed source guidance", () => {
  const failure = maybeBuildDatabaseConnectionFailure({
    error: Object.assign(new Error(""), { code: "ECONNREFUSED" }),
    descriptor: {
      databaseUrl: `postgres://kestrel:kestrel@localhost:${DEFAULT_KESTREL_DB_PORT}/kestrel`,
      databaseUrlSource: "local_core_managed",
    },
  });

  assert.ok(failure);
  assert.equal(failure?.code, "ECONNREFUSED");
  assert.match(failure?.message ?? "", /Kestrel Local Core managed database is not reachable/u);
  assert.match(failure?.recommendedAction ?? "", /kestrel status/u);
  assert.equal(failure?.details?.databaseUrlSource, "local_core_managed");
});

test("maybeBuildDatabaseConnectionFailure reports CLI external source guidance", () => {
  const failure = maybeBuildDatabaseConnectionFailure({
    error: Object.assign(new Error(""), { code: "ECONNREFUSED" }),
    descriptor: {
      databaseUrl: "postgres://kestrel:kestrel@db.example:5432/kestrel",
      databaseUrlSource: "cli_external",
    },
  });

  assert.ok(failure);
  assert.equal(failure?.code, "ECONNREFUSED");
  assert.match(failure?.message ?? "", /Configured external Postgres is not reachable/u);
  assert.match(failure?.recommendedAction ?? "", /configured external DATABASE_URL/u);
  assert.equal(failure?.details?.databaseUrlSource, "cli_external");
});

test("describeConnectionFailure preserves timeout and reset codes", () => {
  assert.deepEqual(
    describeConnectionFailure(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
    {
      code: "ETIMEDOUT",
      label: "ETIMEDOUT",
    },
  );
  assert.deepEqual(
    describeConnectionFailure(Object.assign(new Error("reset"), { code: "ECONNRESET" })),
    {
      code: "ECONNRESET",
      label: "ECONNRESET",
    },
  );
});

test("preflightDatabaseConnection can recover after a supported auto-start", async () => {
  const port = await reserveLocalPort();
  const server = createServer();

  try {
    const result = await preflightDatabaseConnection({
      descriptor: {
        databaseUrl: `postgres://kestrel:kestrel@127.0.0.1:${port}/kestrel`,
        databaseUrlSource: "desktop_default",
      },
      env: {
        ...process.env,
        KESTREL_DB_PORT: String(port),
      },
      selfHealDefaultEnabled: true,
      allowAutoStart: true,
      autoStart: async () => {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        return {
          ok: true,
          detail: "server started",
        };
      },
      timeoutMs: 100,
      retryTimeoutMs: 500,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("expected recovered preflight success");
    }
    assert.equal(result.target.port, port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function reserveLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Unable to reserve port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
