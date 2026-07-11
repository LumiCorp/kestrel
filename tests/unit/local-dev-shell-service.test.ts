import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendBoundedDevShellOutput,
  isCompatibleDevShellHealth,
  LocalDevShellService,
} from "../../src/devshell/LocalDevShellService.js";
import { DEV_SHELL_SERVICE_PROTOCOL_VERSION } from "../../src/devshell/contracts.js";
import {
  resolveDefaultDevShellBaseDir,
  resolveDefaultDevShellBootstrapStatusPath,
  resolveDefaultDevShellLogPath,
  resolveDefaultDevShellSocketPath,
} from "../../src/devshell/paths.js";

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
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  });

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalStoreDriver = process.env.KESTREL_STORE_DRIVER;
  delete process.env.DATABASE_URL;
  process.env.KESTREL_STORE_DRIVER = "postgres";

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
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    if (originalStoreDriver !== undefined) {
      process.env.KESTREL_STORE_DRIVER = originalStoreDriver;
    } else {
      delete process.env.KESTREL_STORE_DRIVER;
    }
  }
});

const realSupervisorSmokeSkipReason =
  process.platform === "darwin" && process.versions.node === "25.2.1"
    ? "Node 25.2.1 on macOS aborts node:test after detached supervisor smoke tests"
    : false;

test("LocalDevShellService starts with sqlite store when DATABASE_URL is missing", {
  skip: realSupervisorSmokeSkipReason,
}, async () => {
  const serviceModuleUrl = new URL("../../src/devshell/LocalDevShellService.ts", import.meta.url).href;
  const script = `
    import { mkdtemp } from "node:fs/promises";
    import path from "node:path";
    import { LocalDevShellService } from ${JSON.stringify(serviceModuleUrl)};

    const baseDir = await mkdtemp(path.join("/tmp", "ldss-"));
    const service = new LocalDevShellService(baseDir, {
      startupTimeoutMs: 10_000,
      pollIntervalMs: 25,
    });
    delete process.env.DATABASE_URL;
    process.env.KESTREL_STORE_DRIVER = "sqlite";
    process.env.KESTREL_HOME = path.join(baseDir, "runtime-home");

    const result = await service.runCommand({
      workspaceRoot: baseDir,
      command: "printf ok",
      timeoutMs: 2_000,
    });
    await service.close();
    console.log(JSON.stringify({ status: result.status, text: result.text }));
  `;

  const env: NodeJS.ProcessEnv = { ...process.env, KESTREL_STORE_DRIVER: "sqlite" };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim()) as { status: string; text: string };
  assert.equal(payload.status, "COMPLETED");
  assert.equal(payload.text, "ok");
});

test("LocalDevShellService starts with explicit split socket, log, and status paths", {
  skip: realSupervisorSmokeSkipReason,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-service-split-paths-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousStoreDriver = process.env.KESTREL_STORE_DRIVER;
  const previousKestrelHome = process.env.KESTREL_HOME;
  const previousSocketPath = process.env.KESTREL_DEV_SHELL_SOCKET_PATH;
  const previousLogPath = process.env.KESTREL_DEV_SHELL_LOG_PATH;
  const previousStatusPath = process.env.KESTREL_DEV_SHELL_STATUS_PATH;
  delete process.env.DATABASE_URL;
  process.env.KESTREL_STORE_DRIVER = "sqlite";
  process.env.KESTREL_HOME = path.join(root, "runtime-home");
  process.env.KESTREL_DEV_SHELL_SOCKET_PATH = path.join(root, "runtime", "supervisor.sock");
  process.env.KESTREL_DEV_SHELL_LOG_PATH = path.join(root, "attempt", "logs", "service.log");
  process.env.KESTREL_DEV_SHELL_STATUS_PATH = path.join(root, "attempt", "status", "bootstrap-status.json");
  const service = new LocalDevShellService(undefined, {
    startupTimeoutMs: 10_000,
    pollIntervalMs: 25,
  });

  try {
    const result = await service.runCommand({
      workspaceRoot: root,
      command: "printf ok && sleep 0.1",
      timeoutMs: 10_000,
    });

    assert.equal(result.status, "COMPLETED", JSON.stringify(result));
    assert.equal(result.text, "ok");
  } finally {
    await service.close();
    restoreEnvVar("DATABASE_URL", previousDatabaseUrl);
    restoreEnvVar("KESTREL_STORE_DRIVER", previousStoreDriver);
    restoreEnvVar("KESTREL_HOME", previousKestrelHome);
    restoreEnvVar("KESTREL_DEV_SHELL_SOCKET_PATH", previousSocketPath);
    restoreEnvVar("KESTREL_DEV_SHELL_LOG_PATH", previousLogPath);
    restoreEnvVar("KESTREL_DEV_SHELL_STATUS_PATH", previousStatusPath);
  }
});

test("LocalDevShellService surfaces persisted bootstrap failure details before health timeout", async () => {
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
        reasonCode: "socket_bind_failed",
        message: "Socket path could not be bound.",
      }),
      "utf8",
    );
    await writeFile(testService.logPath, "socket bind failed\n", "utf8");
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
      assert.match(runtimeError.message, /Socket path could not be bound/i);
      assert.equal(runtimeError.details?.bootstrapReason, "socket_bind_failed");
      assert.equal(runtimeError.details?.logPath, testService.logPath);
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
        pid: 12345,
        ownerPid: 67890,
        ownerKind: "ks",
        socketPath: testService.socketPath,
        at: "2026-06-17T16:10:00.000Z",
      }),
      "utf8",
    );
    await writeFile(testService.logPath, "", "utf8");
    return {
      pid: 12345,
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
        assert.equal(runtimeError.details?.pid, 12345);
        assert.equal(runtimeError.details?.logEmpty, true);
        assert.equal(typeof runtimeError.details?.elapsedMs, "number");
        assert.deepEqual(runtimeError.details?.latestBootstrapStatus, {
          status: "booting",
          pid: 12345,
          ownerPid: 67890,
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
        return { ok: true };
      }
      return {
        ok: true,
        serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
        capabilities: {
          processWriteAndRead: true,
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

test("LocalDevShellService cleans up an incompatible supervisor socket recorded in bootstrap status", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "local-dev-shell-service-"));
  await mkdir(baseDir, { recursive: true });
  const service = new LocalDevShellService(baseDir, {
    startupTimeoutMs: 20,
    pollIntervalMs: 1,
  }) as any;

  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(service.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await writeFile(
    service.bootstrapStatusPath,
    JSON.stringify({
      status: "ready",
      pid: process.pid,
      at: new Date("2026-05-16T12:00:00.000Z").toISOString(),
    }),
    "utf8",
  );

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPerformRequest = service.performRequest.bind(service);
  process.env.DATABASE_URL = "postgres://local-dev-shell-test";
  let firstHealthCheck = true;
  let spawned = false;
  service.spawnService = async () => {
    spawned = true;
    await serverClosed(server);
    return {
      exitCode: null,
      signalCode: null,
      unref() {},
    };
  };
  service.performRequest = async (method: string, pathname: string) => {
    if (method === "GET" && pathname === "/health") {
      if (firstHealthCheck) {
        firstHealthCheck = false;
        return originalPerformRequest(method, pathname);
      }
      if (spawned) {
        return {
          ok: true,
          serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
          capabilities: {
            processWriteAndRead: true,
          },
        };
      }
      throw new Error("stale server should have been closed before spawn");
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

  try {
    await service.runCommand({ workspaceRoot: ".", command: "echo ok" });

    const status = JSON.parse(await readFile(service.bootstrapStatusPath, "utf8")) as { pid?: unknown };
    assert.equal(status.pid, process.pid);
    assert.equal(spawned, true);
  } finally {
    await closeServer(server);
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});

test("isCompatibleDevShellHealth requires the write_and_read process contract", () => {
  assert.equal(isCompatibleDevShellHealth({ ok: true }), false);
  assert.equal(isCompatibleDevShellHealth({
    ok: true,
    serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
    capabilities: {
      processWriteAndRead: true,
    },
  }), true);
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
