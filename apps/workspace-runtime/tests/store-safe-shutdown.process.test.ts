import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { contractTest } from "../../../tests/helpers/contract-test.js";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

contractTest(
  "runtime.process",
  "workspace image update shutdown leaves the PGlite store reopenable",
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "kestrel-workspace-store-shutdown-")
    );
    const sqlitePath = path.join(root, "runtime.db");
    const initial = new PGlite(sqlitePath);
    await initial.exec(
      "CREATE TABLE shutdown_sentinel (value TEXT PRIMARY KEY); " +
        "INSERT INTO shutdown_sentinel (value) VALUES ('persisted');"
    );
    await initial.close();

    const port = await reservePort();
    const child = spawn(
      process.execPath,
      [path.join(REPOSITORY_ROOT, "apps/workspace-runtime/dist/server.js")],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          KESTREL_HOME: path.join(root, ".local", "share", "kestrel"),
          KESTREL_SQLITE_PATH: sqlitePath,
          KESTREL_STORE_MIGRATIONS_DIR: path.join(
            REPOSITORY_ROOT,
            "db/migrations"
          ),
          KESTREL_WORKSPACE_ROOT: root,
          KESTREL_WORKSPACE_HOST: "127.0.0.1",
          KESTREL_WORKSPACE_PORT: String(port),
          KESTREL_WORKSPACE_ID: "workspace-store-shutdown-test",
          KESTREL_ORGANIZATION_ID: "organization-store-shutdown-test",
          KESTREL_ENVIRONMENT_ID: "environment-store-shutdown-test",
          FLY_MACHINE_ID: "machine-store-shutdown-test",
          KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: "test-public-key",
          KESTREL_CONTROL_PLANE_URL: "https://control.invalid",
          KESTREL_ENVIRONMENT_GATEWAY_URL: "https://gateway.invalid",
          KESTREL_WORKSPACE_SERVICE_TOKEN: "test-service-token",
          KESTREL_WORKSPACE_SOURCE_TYPE: "blank",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    try {
      await waitForHealthyWorkspace(port, child, () => output);
      assertEventOrder(
        output,
        '"type":"runner.store.ready"',
        '"type":"workspace.runner.ready"'
      );

      child.kill("SIGTERM");
      const exit = await waitForExit(child);
      assert.equal(exit.signal, null);
      assert.equal(exit.code, 0, output);

      const reopened = new PGlite(sqlitePath);
      try {
        const sentinel = await reopened.query<{ value: string }>(
          "SELECT value FROM shutdown_sentinel"
        );
        assert.deepEqual(sentinel.rows, [{ value: "persisted" }]);
        const migrations = await reopened.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM schema_migrations"
        );
        assert.ok((migrations.rows[0]?.count ?? 0) > 0);
      } finally {
        await reopened.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await waitForExit(child).catch(() => {
          child.kill("SIGKILL");
        });
      }
      await rm(root, { recursive: true, force: true });
    }
  }
);

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return port;
}

async function waitForHealthyWorkspace(
  port: number,
  child: ReturnType<typeof spawn>,
  readOutput: () => string
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Workspace runtime exited before becoming healthy.");
    }
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(
      () => null
    );
    if (response?.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Workspace runtime did not become store-ready.\n${readOutput()}`
  );
}

function waitForExit(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Workspace runtime did not exit in time.")),
      15_000
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function assertEventOrder(output: string, first: string, second: string) {
  const firstIndex = output.indexOf(first);
  const secondIndex = output.indexOf(second);
  assert.ok(firstIndex >= 0, `Missing ${first} in:\n${output}`);
  assert.ok(secondIndex > firstIndex, `Expected ${first} before ${second}.`);
}
