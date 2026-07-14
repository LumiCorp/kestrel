import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalCoreClient } from "../../src/localCore/client.js";

test("LocalCoreClient lets a runtime store reset outlive the generic request timeout", async () => {
  const genericTimeoutMs = 20;
  const responseDelayMs = 80;
  const fixture = await startDelayedLocalCore(responseDelayMs);
  try {
    const client = new LocalCoreClient({
      socketPath: fixture.socketPath,
      token: "test-token",
      timeoutMs: genericTimeoutMs,
    });

    const startedAt = Date.now();
    const result = await client.resetRuntimeStore();

    assert.ok(Date.now() - startedAt >= responseDelayMs);
    assert.deepEqual(result.reset, {
      storePath: "/tmp/kestrel/core/database/pglite",
      archivedStorePath: null,
      resetAt: "2026-07-13T12:00:00.000Z",
    });
    assert.equal(result.status.state, "healthy");
  } finally {
    await fixture.close();
  }
});

test("LocalCoreClient keeps the generic timeout for ordinary requests", async () => {
  const genericTimeoutMs = 20;
  const fixture = await startDelayedLocalCore(80);
  try {
    const client = new LocalCoreClient({
      socketPath: fixture.socketPath,
      token: "test-token",
      timeoutMs: genericTimeoutMs,
    });

    await assert.rejects(
      () => client.health(),
      /Local Core API request timed out: GET \/v1\/health/u,
    );
  } finally {
    await fixture.close();
  }
});

async function startDelayedLocalCore(responseDelayMs: number): Promise<{
  socketPath: string;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-core-client-"));
  const socketPath = path.join(root, "api.sock");
  const server = createServer((request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/v1/runtime/store/reset") {
        response.end(JSON.stringify({
          ok: true,
          reset: {
            storePath: "/tmp/kestrel/core/database/pglite",
            archivedStorePath: null,
            resetAt: "2026-07-13T12:00:00.000Z",
          },
          status: {
            state: "healthy",
            summary: "Kestrel Local Core ready.",
            home: {
              productRootPath: "/tmp/kestrel",
              homePath: "/tmp/kestrel/state/0.6",
              stateEpoch: "0.6",
              source: "explicit_core_home",
              isolated: false,
              platform: "darwin",
            },
            lock: {
              state: "missing",
              lockPath: "/tmp/kestrel/state/0.6/core/lock.json",
            },
            dbMode: "pglite",
            database: {
              mode: "pglite",
              state: "healthy",
              summary: "PGlite is ready.",
              managed: true,
              initialized: true,
              running: true,
              identityVerified: true,
            },
            settingsReady: true,
            workspaceRegistryReady: true,
            diagnosticsPath: "/tmp/kestrel/state/0.6/diagnostics",
            logsPath: "/tmp/kestrel/state/0.6/core/logs",
          },
        }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    }, responseDelayMs);
  });
  await listen(server, socketPath);
  return {
    socketPath,
    async close(): Promise<void> {
      await close(server);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
