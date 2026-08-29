import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendBoundedDevShellOutput,
  isCompatibleDevShellHealth,
  LocalDevShellService,
  resolveDevShellServiceLaunch,
} from "../../src/devshell/LocalDevShellService.js";
import {
  DEV_SHELL_SERVICE_PROTOCOL_VERSION,
  DEV_SHELL_SERVICE_STARTUP_TIMEOUT_MS,
} from "../../src/devshell/contracts.js";
import {
  resolveDefaultDevShellBaseDir,
  resolveDefaultDevShellBootstrapStatusPath,
  resolveDefaultDevShellLogPath,
  resolveDefaultDevShellSocketPath,
} from "../../src/devshell/paths.js";

test("developer shell launch resolution selects the source TypeScript entrypoint", () => {
  const launch = resolveDevShellServiceLaunch(
    "file:///repo/src/devshell/LocalDevShellService.ts",
    "/repo/node_modules/tsx/dist/loader.mjs",
  );

  assert.equal(launch.entrypointPath, "/repo/cli/dev-shell/service.ts");
  assert.deepEqual(launch.nodeArguments, [
    "--import",
    "/repo/node_modules/tsx/dist/loader.mjs",
    "/repo/cli/dev-shell/service.ts",
  ]);
});

test("developer shell launch resolution selects the compiled JavaScript entrypoint without tsx", () => {
  const launch = resolveDevShellServiceLaunch(
    "file:///app/dist/src/devshell/LocalDevShellService.js",
    "/app/node_modules/tsx/dist/loader.mjs",
  );

  assert.equal(launch.entrypointPath, "/app/dist/cli/dev-shell/service.js");
  assert.deepEqual(launch.nodeArguments, ["/app/dist/cli/dev-shell/service.js"]);
});

test("developer shell launch resolution rejects unsupported runtime module extensions", () => {
  assert.throws(
    () => resolveDevShellServiceLaunch("file:///app/dist/src/devshell/LocalDevShellService.mjs"),
    /Unsupported LocalDevShellService runtime module extension: \.mjs/u,
  );
});

test("LocalDevShellService reports a missing resolved entrypoint before spawn", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-missing-entrypoint-"));
  const previousStoreDriver = process.env.KESTREL_STORE_DRIVER;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.KESTREL_STORE_DRIVER = "sqlite";
  delete process.env.DATABASE_URL;
  const service = new LocalDevShellService(baseDir, {
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
    runtimeModuleUrl: new URL("dist/src/devshell/LocalDevShellService.js", `file://${baseDir}/`).href,
  });

  try {
    await assert.rejects(
      service.runCommand({ workspaceRoot: baseDir, command: "printf unreachable" }),
      (error: unknown) => {
        const failure = error as Error & { code?: string; details?: Record<string, unknown> };
        assert.equal(failure.code, "DEV_SHELL_SERVICE_UNAVAILABLE");
        assert.equal(failure.details?.bootstrapReason, "entrypoint_missing");
        assert.equal(failure.details?.reasonCode, "entrypoint_missing");
        assert.equal(
          failure.details?.entrypointPath,
          path.join(baseDir, "dist", "cli", "dev-shell", "service.js"),
        );
        assert.equal(failure.details?.exitCode, null);
        assert.match(String(failure.details?.nextSuggestedAction), /Rebuild the runtime package/u);
        return true;
      },
    );
  } finally {
    await service.close();
    if (previousStoreDriver === undefined) delete process.env.KESTREL_STORE_DRIVER;
    else process.env.KESTREL_STORE_DRIVER = previousStoreDriver;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test("LocalDevShellService uses its injected runtime environment for bootstrap prerequisites", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-injected-env-"));
  const previousStoreDriver = process.env.KESTREL_STORE_DRIVER;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.KESTREL_STORE_DRIVER = "postgres";
  process.env.DATABASE_URL = "postgres://127.0.0.1:55432/leaked-repository-env";
  const service = new LocalDevShellService(baseDir, {
    env: {
      ...process.env,
      KESTREL_STORE_DRIVER: "sqlite",
      DATABASE_URL: undefined,
    },
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
    runtimeModuleUrl: new URL(
      "dist/src/devshell/LocalDevShellService.js",
      `file://${baseDir}/`,
    ).href,
  });

  try {
    await assert.rejects(
      service.runCommand({ workspaceRoot: baseDir, command: "printf unreachable" }),
      (error: unknown) => {
        const failure = error as Error & { details?: Record<string, unknown> };
        assert.equal(failure.details?.bootstrapReason, "entrypoint_missing");
        return true;
      },
    );
  } finally {
    await service.close();
    restoreEnvVar("KESTREL_STORE_DRIVER", previousStoreDriver);
    restoreEnvVar("DATABASE_URL", previousDatabaseUrl);
  }
});

test("LocalDevShellService preserves an explicitly configured Postgres prerequisite", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-explicit-postgres-"));
  const service = new LocalDevShellService(baseDir, {
    env: {
      ...process.env,
      KESTREL_STORE_DRIVER: "postgres",
      DATABASE_URL: undefined,
    },
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  });

  try {
    await assert.rejects(
      service.runCommand({ workspaceRoot: baseDir, command: "printf unreachable" }),
      (error: unknown) => {
        const failure = error as Error & { details?: Record<string, unknown> };
        assert.equal(failure.details?.bootstrapReason, "missing_database_url");
        return true;
      },
    );
  } finally {
    await service.close();
  }
});

test("LocalDevShellService standalone construction honors injected-home settings", async () => {
  const sqliteHome = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-settings-sqlite-"));
  const postgresHome = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-settings-postgres-"));
  await writeFile(
    path.join(sqliteHome, "settings.json"),
    JSON.stringify({ version: 1, defaults: { storeDriver: "sqlite" } }),
    "utf8",
  );
  await writeFile(
    path.join(postgresHome, "settings.json"),
    JSON.stringify({ version: 1, defaults: { storeDriver: "postgres" } }),
    "utf8",
  );
  const sqliteService = new LocalDevShellService(undefined, {
    env: {
      KESTREL_HOME: sqliteHome,
      DATABASE_URL: "postgres://application.example/workspace",
    },
  }) as any;
  const postgresService = new LocalDevShellService(undefined, {
    env: { KESTREL_HOME: postgresHome },
  }) as any;
  let spawned = false;
  postgresService.spawnService = async () => {
    spawned = true;
    throw new Error("service must not spawn");
  };

  assert.equal(sqliteService.storeBinding.driver, "sqlite");
  assert.equal(
    sqliteService.env.DATABASE_URL,
    "postgres://application.example/workspace",
  );
  await assert.rejects(
    postgresService.runCommand({ workspaceRoot: ".", command: "echo unreachable" }),
    (error: unknown) =>
      (error as { details?: Record<string, unknown> }).details?.bootstrapReason ===
      "missing_database_url",
  );
  assert.equal(spawned, false);
});

test("LocalDevShellService standalone construction preserves invalid driver rejection", () => {
  assert.throws(
    () =>
      new LocalDevShellService(undefined, {
        env: { KESTREL_STORE_DRIVER: "invalid" },
      }),
    (error: unknown) =>
      (error as { code?: unknown }).code === "STORE_DRIVER_INVALID",
  );
});

test("appendBoundedDevShellOutput enforces an aggregate UTF-8 byte limit", () => {
  const first = appendBoundedDevShellOutput(
    { text: "", byteLength: 0, truncated: false },
    "abc",
    5,
    false,
  );
  const second = appendBoundedDevShellOutput(first, "def", 5, false);

  assert.equal(second.text, "abcde");
  assert.equal(second.byteLength, 5);
  assert.equal(second.truncated, true);
});

test("appendBoundedDevShellOutput does not split multi-byte characters", () => {
  const output = appendBoundedDevShellOutput(
    { text: "", byteLength: 0, truncated: false },
    "a🙂b",
    4,
    false,
  );

  assert.equal(output.text, "a");
  assert.equal(output.byteLength, 1);
  assert.equal(output.truncated, true);
});

test("LocalDevShellService defaults under KESTREL_HOME when available", async () => {
  const kestrelHome = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-home-"));
  assert.equal(
    resolveDefaultDevShellBaseDir({ KESTREL_HOME: kestrelHome } as NodeJS.ProcessEnv),
    path.join(kestrelHome, "dev-shell"),
  );

  const previous = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = kestrelHome;
  try {
    const service = new LocalDevShellService(undefined, {
      startupTimeoutMs: 20,
      pollIntervalMs: 1,
    });
    assert.equal(service.socketPath, path.join(kestrelHome, "dev-shell", "supervisor.sock"));
  } finally {
    if (previous === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previous;
    }
  }
});

test("LocalDevShellService expands ~/ KESTREL_HOME for socket, log, and bootstrap status defaults", async () => {
  const relativeHome = "~/kestrel-dev-shell-home";
  const expectedBaseDir = path.join(os.homedir(), "kestrel-dev-shell-home", "dev-shell");

  assert.equal(
    resolveDefaultDevShellBaseDir({ KESTREL_HOME: relativeHome } as NodeJS.ProcessEnv),
    expectedBaseDir,
  );
  assert.equal(
    resolveDefaultDevShellSocketPath({ KESTREL_HOME: relativeHome } as NodeJS.ProcessEnv),
    path.join(expectedBaseDir, "supervisor.sock"),
  );
  assert.equal(
    resolveDefaultDevShellLogPath({ KESTREL_HOME: relativeHome } as NodeJS.ProcessEnv),
    path.join(expectedBaseDir, "service.log"),
  );
  assert.equal(
    resolveDefaultDevShellBootstrapStatusPath({ KESTREL_HOME: relativeHome } as NodeJS.ProcessEnv),
    path.join(expectedBaseDir, "bootstrap-status.json"),
  );

  const previous = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = relativeHome;
  try {
    const service = new LocalDevShellService(undefined, {
      startupTimeoutMs: 20,
      pollIntervalMs: 1,
    });
    assert.equal(service.socketPath, path.join(expectedBaseDir, "supervisor.sock"));
    assert.equal(service.logPath, path.join(expectedBaseDir, "service.log"));
    assert.equal(service.bootstrapStatusPath, path.join(expectedBaseDir, "bootstrap-status.json"));
  } finally {
    if (previous === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previous;
    }
  }
});

test("LocalDevShellService honors explicit dev shell path environment overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-env-paths-"));
  const previousSocketPath = process.env.KESTREL_DEV_SHELL_SOCKET_PATH;
  const previousLogPath = process.env.KESTREL_DEV_SHELL_LOG_PATH;
  const previousStatusPath = process.env.KESTREL_DEV_SHELL_STATUS_PATH;
  process.env.KESTREL_DEV_SHELL_SOCKET_PATH = path.join(root, "socket-dir", "supervisor.sock");
  process.env.KESTREL_DEV_SHELL_LOG_PATH = path.join(root, "logs", "service.log");
  process.env.KESTREL_DEV_SHELL_STATUS_PATH = path.join(root, "status", "bootstrap-status.json");
  try {
    const service = new LocalDevShellService(undefined, {
      startupTimeoutMs: 20,
      pollIntervalMs: 1,
    });
    assert.equal(service.socketPath, path.join(root, "socket-dir", "supervisor.sock"));
    assert.equal(service.logPath, path.join(root, "logs", "service.log"));
    assert.equal(service.bootstrapStatusPath, path.join(root, "status", "bootstrap-status.json"));
  } finally {
    restoreEnvVar("KESTREL_DEV_SHELL_SOCKET_PATH", previousSocketPath);
    restoreEnvVar("KESTREL_DEV_SHELL_LOG_PATH", previousLogPath);
    restoreEnvVar("KESTREL_DEV_SHELL_STATUS_PATH", previousStatusPath);
  }
});

test("LocalDevShellService reads startup timeout from environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-timeout-env-"));
  const previousTimeout = process.env.KESTREL_DEV_SHELL_STARTUP_TIMEOUT_MS;
  process.env.KESTREL_DEV_SHELL_STARTUP_TIMEOUT_MS = "30000";
  try {
    const service = new LocalDevShellService(root) as any;
    assert.equal(service.startupTimeoutMs, 30_000);
  } finally {
    restoreEnvVar("KESTREL_DEV_SHELL_STARTUP_TIMEOUT_MS", previousTimeout);
  }
});

test("LocalDevShellService allows one bounded cold bootstrap by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-timeout-default-"));
  const previousTimeout = process.env.KESTREL_DEV_SHELL_STARTUP_TIMEOUT_MS;
  delete process.env.KESTREL_DEV_SHELL_STARTUP_TIMEOUT_MS;
  try {
    const service = new LocalDevShellService(root) as any;
    assert.equal(
      service.startupTimeoutMs,
      DEV_SHELL_SERVICE_STARTUP_TIMEOUT_MS,
    );
  } finally {
    restoreEnvVar("KESTREL_DEV_SHELL_STARTUP_TIMEOUT_MS", previousTimeout);
  }
});

test("LocalDevShellService shortens overlong isolated socket paths", async () => {
  const longHome = path.join(
    os.tmpdir(),
    "local-dev-shell-home-with-a-very-long-prefix-that-exceeds-darwin-unix-socket-path-limits",
    "nested",
    "workspace",
    "home",
  );
  const baseDir = resolveDefaultDevShellBaseDir({ KESTREL_HOME: longHome } as NodeJS.ProcessEnv);
  const socketPath = path.join(baseDir, "supervisor.sock");

  assert.equal(baseDir.startsWith(path.join(os.tmpdir(), "kds")), true);
  assert.notEqual(baseDir, path.join(longHome, "dev-shell"));
  assert.equal(Buffer.byteLength(socketPath, "utf8") < 104, true);
});

test("LocalDevShellService fails fast with an explicit bootstrap reason when postgres DATABASE_URL is missing", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-service-"));
  const service = new LocalDevShellService(baseDir, {
    env: {
      ...process.env,
      KESTREL_STORE_DRIVER: "postgres",
      DATABASE_URL: undefined,
    },
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  });

  try {
    await assert.rejects(
      service.runCommand({ workspaceRoot: ".", command: "echo ok" }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const runtimeError = error as Error & {
          code?: string;
          details?: Record<string, unknown>;
        };
        assert.equal(runtimeError.code, "DEV_SHELL_SERVICE_UNAVAILABLE");
        assert.match(runtimeError.message, /DATABASE_URL/i);
        assert.equal(runtimeError.details?.bootstrapReason, "missing_database_url");
        return true;
      },
    );
  } finally {
    await service.close();
  }
});

test("LocalDevShellService surfaces actionable migration bootstrap failure before health timeout", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-service-"));
  await mkdir(baseDir, { recursive: true });
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://local-dev-shell-test";
  const service = new LocalDevShellService(baseDir, {
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  });
  const testService = service as any;

  testService.performRequest = async () => {
    throw new Error("socket not ready");
  };
  testService.spawnService = async () => {
    await writeFile(
      testService.bootstrapStatusPath,
      JSON.stringify({
        status: "failed",
        reasonCode: "migration_failed",
        message: "Developer shell storage migration failed.",
      }),
      "utf8",
    );
    await writeFile(
      testService.logPath,
      "migration refused postgres://operator:secret@database.invalid/control\n",
      "utf8",
    );
  };

  await assert.rejects(
    service.runCommand({ workspaceRoot: ".", command: "echo ok" }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const runtimeError = error as Error & {
        code?: string;
        details?: Record<string, unknown>;
      };
      assert.equal(runtimeError.code, "DEV_SHELL_SERVICE_UNAVAILABLE");
      assert.match(runtimeError.message, /storage migration failed/i);
      assert.equal(runtimeError.details?.bootstrapReason, "migration_failed");
      assert.equal(runtimeError.details?.failureReason, "migration_failed");
      assert.equal(runtimeError.details?.failurePhase, "service_bootstrap");
      assert.match(
        String(runtimeError.details?.nextSuggestedAction),
        /command did not run.*repair developer-shell storage.*retry the original command.*Changing the command cannot repair/is,
      );
      assert.equal(runtimeError.details?.logPath, testService.logPath);
      assert.match(String(runtimeError.details?.logTail), /operator:secret/u);
      return true;
    },
  );

  if (originalDatabaseUrl !== undefined) {
    process.env.DATABASE_URL = originalDatabaseUrl;
  } else {
    delete process.env.DATABASE_URL;
  }
});

test("LocalDevShellService health timeout includes startup diagnostics", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-service-timeout-"));
  await mkdir(baseDir, { recursive: true });
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://local-dev-shell-test";
  const service = new LocalDevShellService(baseDir, {
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  });
  const testService = service as any;

  testService.performRequest = async () => {
    throw new Error("socket not ready");
  };
  testService.spawnService = async () => {
    await writeFile(
      testService.bootstrapStatusPath,
      JSON.stringify({
        status: "booting",
        pid: 12_345,
        ownerPid: 67_890,
        ownerKind: "ks",
        socketPath: testService.socketPath,
        at: "2026-06-17T16:10:00.000Z",
      }),
      "utf8",
    );
    await writeFile(testService.logPath, "", "utf8");
    return {
      pid: 12_345,
      exitCode: null,
      signalCode: null,
    };
  };

  try {
    await assert.rejects(
      service.runCommand({ workspaceRoot: ".", command: "echo ok" }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const runtimeError = error as Error & {
          code?: string;
          details?: Record<string, unknown>;
        };
        assert.equal(runtimeError.code, "DEV_SHELL_SERVICE_UNAVAILABLE");
        assert.match(runtimeError.message, /did not become ready/i);
        assert.equal(runtimeError.details?.bootstrapReason, "health_timeout");
        assert.equal(runtimeError.details?.startupTimeoutMs, 20);
        assert.equal(runtimeError.details?.pid, 12_345);
        assert.equal(runtimeError.details?.logEmpty, true);
        assert.equal(typeof runtimeError.details?.elapsedMs, "number");
        assert.deepEqual(runtimeError.details?.latestBootstrapStatus, {
          status: "booting",
          pid: 12_345,
          ownerPid: 67_890,
          ownerKind: "ks",
          socketPath: testService.socketPath,
          at: "2026-06-17T16:10:00.000Z",
        });
        return true;
      },
    );
  } finally {
    restoreEnvVar("DATABASE_URL", originalDatabaseUrl);
  }
});

test("LocalDevShellService preserves structured supervisor request errors", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-service-"));
  await mkdir(baseDir, { recursive: true });
  const service = new LocalDevShellService(baseDir, {
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  });
  const server = http.createServer((_request, response) => {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: {
        code: "DEV_SHELL_CWD_NOT_FOUND",
        message: "cwd '/missing' does not exist.",
        details: {
          subsystem: "dev_shell",
          cwd: "/missing",
          workspaceRoot: "/testbed",
        },
      },
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(service.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    await assert.rejects(
      (service as any).performRequest("GET", "/boom"),
      (error: unknown) => {
        const runtimeError = error as Error & {
          code?: string;
          details?: Record<string, unknown>;
        };
        assert.equal(runtimeError.code, "DEV_SHELL_CWD_NOT_FOUND");
        assert.match(runtimeError.message, /does not exist/u);
        assert.equal(runtimeError.details?.cwd, "/missing");
        assert.equal(runtimeError.details?.workspaceRoot, "/testbed");
        assert.equal(runtimeError.details?.statusCode, 500);
        assert.equal(runtimeError.details?.path, "/boom");
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await service.close();
  }
});

test("LocalDevShellService restarts a stale supervisor with legacy health", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-service-"));
  const service = new LocalDevShellService(baseDir, {
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  }) as any;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://local-dev-shell-test";
  let healthChecks = 0;
  let stopped = false;
  let spawned = false;

  service.performRequest = async (method: string, pathname: string) => {
    if (method === "GET" && pathname === "/health") {
      healthChecks += 1;
      if (healthChecks === 1) {
        return {
          ok: true,
          serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION - 1,
        };
      }
      return {
        ok: true,
        serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
        servicePid: process.pid,
        storeDriver: service.storeBinding.driver,
        storeBindingRevision: service.storeBinding.revision,
        capabilities: {
          processWriteAndRead: true,
          processRetentionLeases: true,
          processRetentionPromotion: true,
        },
      };
    }
    if (method === "POST" && pathname === "/shell/run") {
      return {
        status: "COMPLETED",
        stdout: "ok\n",
        text: "ok\n",
        truncated: false,
        exitCode: 0,
      };
    }
    throw new Error(`unexpected request ${method} ${pathname}`);
  };
  service.stopIncompatibleService = async () => {
    stopped = true;
  };
  service.spawnService = async () => {
    spawned = true;
    return {
      exitCode: null,
      signalCode: null,
      unref() {},
    };
  };

  try {
    const result = await service.runCommand({ workspaceRoot: ".", command: "echo ok" });

    assert.equal(result.status, "COMPLETED");
    assert.equal(stopped, true);
    assert.equal(spawned, true);
  } finally {
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});

test("LocalDevShellService refuses incompatible replacement when status identity is missing or corrupt", async () => {
  for (const statusFixture of [undefined, "not-json"] as const) {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-identity-"));
    await mkdir(baseDir, { recursive: true });
    const service = new LocalDevShellService(baseDir, {
      storeBinding: { driver: "sqlite", revision: "binding-current" },
      startupTimeoutMs: 20,
      pollIntervalMs: 1,
    }) as any;
    const server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: true,
        serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION - 1,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(service.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (statusFixture !== undefined) {
      await writeFile(service.bootstrapStatusPath, statusFixture, "utf8");
    }
    let spawned = false;
    service.spawnService = async () => {
      spawned = true;
      throw new Error("replacement must not start");
    };

    try {
      await assert.rejects(
        service.runCommand({ workspaceRoot: ".", command: "echo unreachable" }),
        (error: unknown) => {
          const failure = error as Error & {
            code?: string;
            details?: Record<string, unknown>;
          };
          assert.equal(failure.code, "DEV_SHELL_SERVICE_UNAVAILABLE");
          assert.equal(
            failure.details?.bootstrapReason,
            "incompatible_service_identity_unavailable",
          );
          assert.match(
            String(failure.details?.nextSuggestedAction),
            /command did not run.*stop the incompatible service safely/is,
          );
          return true;
        },
      );
      assert.equal(spawned, false);
      assert.deepEqual(
        await service.performRequest("GET", "/health"),
        {
          ok: true,
          serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION - 1,
        },
      );
    } finally {
      await closeServer(server);
    }
  }
});

test("LocalDevShellService does not spawn while a ready service PID is finishing cleanup without a socket", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-live-status-"));
  await mkdir(baseDir, { recursive: true });
  const service = new LocalDevShellService(baseDir, {
    storeBinding: { driver: "sqlite", revision: "binding-current" },
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  }) as any;
  const shuttingDownChild = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  let spawned = false;
  try {
    assert.ok(shuttingDownChild.pid !== undefined);
    await writeFile(
      service.bootstrapStatusPath,
      JSON.stringify({
        status: "ready",
        pid: shuttingDownChild.pid,
        socketPath: service.socketPath,
        at: new Date().toISOString(),
      }),
      "utf8",
    );
    service.spawnService = async () => {
      spawned = true;
      throw new Error("replacement must not start");
    };

    await assert.rejects(
      service.runCommand({ workspaceRoot: ".", command: "echo unreachable" }),
      (error: unknown) => {
        const failure = error as Error & {
          code?: string;
          details?: Record<string, unknown>;
        };
        assert.equal(failure.code, "DEV_SHELL_SERVICE_UNAVAILABLE");
        assert.equal(
          failure.details?.bootstrapReason,
          "service_shutdown_in_progress",
        );
        assert.match(
          String(failure.details?.nextSuggestedAction),
          /command did not run.*finish shutdown.*retry the original command/is,
        );
        return true;
      },
    );
    assert.equal(spawned, false);
    assert.equal(isChildRunning(shuttingDownChild), true);
  } finally {
    if (isChildRunning(shuttingDownChild)) {
      shuttingDownChild.kill("SIGKILL");
      await waitForChildExit(shuttingDownChild, 1_000);
    }
  }
});

test("LocalDevShellService does not signal a stale status PID that disagrees with current health", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-stale-pid-"));
  await mkdir(baseDir, { recursive: true });
  const service = new LocalDevShellService(baseDir, {
    storeBinding: { driver: "sqlite", revision: "binding-current" },
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  }) as any;
  const serverScript = `
    const http = require("node:http");
    const server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: true,
        serviceProtocolVersion: ${DEV_SHELL_SERVICE_PROTOCOL_VERSION},
        servicePid: process.pid,
        storeDriver: "sqlite",
        storeBindingRevision: "binding-stale",
        capabilities: {
          processWriteAndRead: true,
          processRetentionLeases: true,
          processRetentionPromotion: true,
        },
      }));
    });
    server.listen(${JSON.stringify(service.socketPath)});
    setInterval(() => {}, 1_000);
  `;
  const servingChild = spawn(process.execPath, ["-e", serverScript], { stdio: "ignore" });
  const unrelatedChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    const healthDeadline = Date.now() + 5_000;
    while (Date.now() < healthDeadline) {
      try {
        await service.performRequest("GET", "/health");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.ok(servingChild.pid !== undefined);
    assert.ok(unrelatedChild.pid !== undefined);
    await writeFile(
      service.bootstrapStatusPath,
      JSON.stringify({
        status: "ready",
        pid: unrelatedChild.pid,
        socketPath: service.socketPath,
        at: new Date().toISOString(),
      }),
      "utf8",
    );
    let spawned = false;
    service.spawnService = async () => {
      spawned = true;
      throw new Error("replacement must not start");
    };

    await assert.rejects(
      service.runCommand({ workspaceRoot: ".", command: "echo unreachable" }),
      (error: unknown) =>
        (error as { details?: Record<string, unknown> }).details?.bootstrapReason ===
        "incompatible_service_identity_unavailable",
    );
    assert.equal(spawned, false);
    assert.equal(isChildRunning(servingChild), true);
    assert.equal(isChildRunning(unrelatedChild), true);
  } finally {
    for (const child of [servingChild, unrelatedChild]) {
      if (isChildRunning(child)) {
        child.kill("SIGKILL");
        await waitForChildExit(child, 1_000);
      }
    }
  }
});

test("LocalDevShellService stops a current incompatible service only when health and status PID match", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-current-pid-"));
  await mkdir(baseDir, { recursive: true });
  const service = new LocalDevShellService(baseDir, {
    storeBinding: { driver: "sqlite", revision: "binding-current" },
  }) as any;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    assert.ok(child.pid !== undefined);
    await writeFile(service.socketPath, "current socket owner", "utf8");
    await writeFile(
      service.bootstrapStatusPath,
      JSON.stringify({
        status: "ready",
        pid: child.pid,
        socketPath: service.socketPath,
        at: new Date().toISOString(),
      }),
      "utf8",
    );

    await service.stopIncompatibleService({
      ok: true,
      serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
      servicePid: child.pid,
      storeDriver: "sqlite",
      storeBindingRevision: "binding-stale",
      capabilities: {
        processWriteAndRead: true,
        processRetentionLeases: true,
        processRetentionPromotion: true,
      },
    });

    assert.equal(isChildRunning(child), false);
    await assert.rejects(readFile(service.socketPath, "utf8"), /ENOENT/u);
  } finally {
    if (isChildRunning(child)) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 1_000);
    }
  }
});

test("LocalDevShellService waits for slow legacy shutdown before binding a replacement socket", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-slow-replacement-"));
  await mkdir(baseDir, { recursive: true });
  const service = new LocalDevShellService(baseDir, {
    storeBinding: { driver: "sqlite", revision: "binding-current" },
    startupTimeoutMs: 5_000,
    pollIntervalMs: 10,
  }) as any;
  const childScript = `
    const http = require("node:http");
    const { rmSync } = require("node:fs");
    const socketPath = ${JSON.stringify(service.socketPath)};
    const server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: true,
        serviceProtocolVersion: ${DEV_SHELL_SERVICE_PROTOCOL_VERSION - 1},
      }));
    });
    server.listen(socketPath);
    let stopping = false;
    process.on("SIGTERM", () => {
      if (stopping) return;
      stopping = true;
      setTimeout(() => {
        server.close(() => {
          rmSync(socketPath, { force: true });
          process.exit(0);
        });
      }, 1_200);
    });
  `;
  const staleChild = spawn(process.execPath, ["-e", childScript], {
    stdio: "ignore",
  });
  let replacementServer: http.Server | undefined;
  let replacementBoundAt = 0;
  try {
    const healthDeadline = Date.now() + 5_000;
    while (Date.now() < healthDeadline) {
      try {
        await service.performRequest("GET", "/health");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.ok(staleChild.pid !== undefined);
    await writeFile(
      service.bootstrapStatusPath,
      JSON.stringify({
        status: "ready",
        pid: staleChild.pid,
        socketPath: service.socketPath,
        at: new Date().toISOString(),
      }),
      "utf8",
    );

    service.spawnService = async () => {
      assert.equal(isChildRunning(staleChild), false);
      replacementServer = http.createServer((request, response) => {
        response.setHeader("content-type", "application/json; charset=utf-8");
        if (request.method === "GET" && request.url === "/health") {
          response.end(JSON.stringify({
            ok: true,
            serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
            servicePid: process.pid,
            storeDriver: "sqlite",
            storeBindingRevision: "binding-current",
            capabilities: {
              processWriteAndRead: true,
              processRetentionLeases: true,
              processRetentionPromotion: true,
            },
          }));
          return;
        }
        response.end(JSON.stringify({
          status: "COMPLETED",
          stdout: "replacement ok\n",
          text: "replacement ok\n",
          truncated: false,
          exitCode: 0,
        }));
      });
      await new Promise<void>((resolve, reject) => {
        replacementServer!.once("error", reject);
        replacementServer!.listen(service.socketPath, () => {
          replacementServer!.off("error", reject);
          replacementBoundAt = Date.now();
          resolve();
        });
      });
      return { exitCode: null, signalCode: null, unref() {} };
    };

    const replacementStartedAt = Date.now();
    const result = await service.runCommand({
      workspaceRoot: ".",
      command: "echo replacement",
    });

    assert.equal(result.status, "COMPLETED");
    assert.match(result.text, /replacement ok/u);
    assert.ok(replacementBoundAt - replacementStartedAt >= 1_100);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      (await service.performRequest("GET", "/health") as { storeBindingRevision?: unknown })
        .storeBindingRevision,
      "binding-current",
    );
  } finally {
    if (replacementServer !== undefined) {
      await closeServer(replacementServer);
    }
    if (isChildRunning(staleChild)) {
      staleChild.kill("SIGKILL");
      await waitForChildExit(staleChild, 1_000);
    }
  }
});

test("isCompatibleDevShellHealth requires the current process contract", () => {
  const binding = { driver: "sqlite" as const, revision: "binding-current" };
  assert.equal(isCompatibleDevShellHealth({ ok: true }, binding), false);
  assert.equal(isCompatibleDevShellHealth({
    ok: true,
    serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
    storeDriver: "sqlite",
    storeBindingRevision: "binding-current",
    capabilities: {
      processWriteAndRead: true,
      processRetentionLeases: true,
      processRetentionPromotion: true,
    },
  }, binding), false);
  assert.equal(isCompatibleDevShellHealth({
    ok: true,
    serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
    servicePid: process.pid,
    storeDriver: "sqlite",
    storeBindingRevision: "binding-current",
    capabilities: {
      processWriteAndRead: true,
      processRetentionLeases: true,
    },
  }, binding), false);
  assert.equal(isCompatibleDevShellHealth({
    ok: true,
    serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
    servicePid: process.pid,
    storeDriver: "sqlite",
    storeBindingRevision: "binding-current",
    capabilities: {
      processWriteAndRead: true,
      processRetentionLeases: true,
      processRetentionPromotion: true,
    },
  }, binding), true);
  assert.equal(isCompatibleDevShellHealth({
    ok: true,
    serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
    servicePid: process.pid,
    storeDriver: "sqlite",
    storeBindingRevision: "binding-stale",
    capabilities: {
      processWriteAndRead: true,
      processRetentionLeases: true,
      processRetentionPromotion: true,
    },
  }, binding), false);
});

test("LocalDevShellService rejects a healthy service with a different store binding", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-binding-mismatch-"));
  const binding = { driver: "sqlite" as const, revision: "binding-current" };
  const service = new LocalDevShellService(baseDir, {
    storeBinding: binding,
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  }) as any;
  let healthChecks = 0;
  let stopped = false;
  let spawned = false;

  service.performRequest = async (method: string, pathname: string) => {
    if (method === "GET" && pathname === "/health") {
      healthChecks += 1;
      return {
        ok: true,
        serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
        servicePid: process.pid,
        storeDriver: "sqlite",
        storeBindingRevision:
          healthChecks === 1 ? "binding-stale" : "binding-current",
        capabilities: {
          processWriteAndRead: true,
          processRetentionLeases: true,
          processRetentionPromotion: true,
        },
      };
    }
    if (method === "POST" && pathname === "/shell/run") {
      return {
        status: "COMPLETED",
        stdout: "ok\n",
        text: "ok\n",
        truncated: false,
        exitCode: 0,
      };
    }
    throw new Error(`unexpected request ${method} ${pathname}`);
  };
  service.stopIncompatibleService = async () => {
    stopped = true;
  };
  service.spawnService = async () => {
    spawned = true;
    return { exitCode: null, signalCode: null, unref() {} };
  };

  const result = await service.runCommand({
    workspaceRoot: ".",
    command: "echo ok",
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(stopped, true);
  assert.equal(spawned, true);
});

test("LocalDevShellService sends retention promotion over the v5 process endpoint", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-service-"));
  const service = new LocalDevShellService(baseDir, {
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  }) as any;
  const calls: unknown[][] = [];
  service.request = async (...args: unknown[]) => {
    calls.push(args);
    return { status: "active", processId: "process-1", lifecycle: "retained", leases: [] };
  };
  const input = {
    processId: "process-1",
    fromLeaseId: "workspace-preview-publish:publication-1",
    leaseId: "workspace-preview:preview-1",
    kind: "workspace_preview" as const,
    expiresAt: "2026-08-13T12:30:00.000Z",
  };

  const result = await service.promoteProcessRetention(input);

  assert.equal(result.status, "active");
  assert.deepEqual(calls, [[
    "POST",
    "/processes/process-1/retention/promote",
    input,
  ]]);
});

test("LocalDevShellService close terminates a spawned supervisor process", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-service-"));
  const service = new LocalDevShellService(baseDir, {
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  }) as any;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  service.ownedChild = child;

  try {
    assert.equal(isChildRunning(child), true);
    await service.close();
    await waitForChildExit(child, 1000);
    assert.equal(isChildRunning(child), false);
  } finally {
    if (isChildRunning(child)) {
      child.kill("SIGKILL");
    }
  }
});

function serverClosed(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function closeServer(server: http.Server): Promise<void> {
  if (server.listening === false) {
    return;
  }
  await serverClosed(server);
}

test("LocalDevShellService observed run preserves source-write guard metadata", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-service-"));
  const service = new LocalDevShellService(baseDir, {
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  }) as any;

  service.startProcess = async () => ({
    processId: "proc-1",
    status: "RUNNING",
    text: "started\n",
    truncated: false,
    cursor: 0,
    nextCursor: 8,
    command: "printf changed",
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    submittedAt: "2026-05-15T00:00:00.000Z",
    startedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  });
  service.readProcess = async () => ({
    status: "FAILED",
    text: "blocked\n",
    truncated: false,
    cursor: 8,
    nextCursor: 16,
    command: "printf changed",
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    submittedAt: "2026-05-15T00:00:00.000Z",
    startedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:01.000Z",
    completedAt: "2026-05-15T00:00:01.000Z",
    exitCode: 126,
    failureReason: "unauthorized source writes",
    sourceWriteGuard: {
      enabled: true,
      mode: "source_readonly",
      allowedWriteRoots: [],
      sourceRoots: ["/workspace"],
      unauthorizedSourceWrites: [{
        path: "app/page.tsx",
        kind: "modified",
        restored: true,
      }],
      restored: true,
    },
    unauthorizedSourceWrites: [{
      path: "app/page.tsx",
      kind: "modified",
      restored: true,
    }],
  });

  const result = await service.runCommand(
    {
      workspaceRoot: "/workspace",
      command: "printf changed",
      timeoutMs: 1000,
    },
    {
      outputObserver: () => {},
    },
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.sourceWriteGuard?.mode, "source_readonly");
  assert.deepEqual(result.unauthorizedSourceWrites?.map((item: any) => item.path), ["app/page.tsx"]);
});

function isChildRunning(child: ChildProcess): boolean {
  if (child.pid === undefined) {
    return false;
  }
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isChildRunning(child) === false) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function restoreEnvVar(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
