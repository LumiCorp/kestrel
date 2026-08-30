import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LocalDevShellService } from "../../src/devshell/LocalDevShellService.js";
import { DEV_SHELL_SERVICE_PROTOCOL_VERSION } from "../../src/devshell/contracts.js";
import { acquireDevShellBootstrapAuthority } from "../../src/devshell/bootstrapAuthority.js";

test("two real simultaneous cold requests share one SQLite service", async () => {
  const baseDir = await mkdtemp(
    path.join(os.tmpdir(), "local-dev-shell-real-concurrent-"),
  );
  const binding = { driver: "sqlite" as const, revision: "binding-shared" };
  const options = {
    env: {
      ...process.env,
      KESTREL_HOME: path.join(baseDir, "home"),
      KESTREL_STORE_DRIVER: "sqlite",
      DATABASE_URL: undefined,
    },
    storeBinding: binding,
    startupTimeoutMs: 10_000,
    pollIntervalMs: 10,
  };
  const firstService = new LocalDevShellService(baseDir, options);
  const secondService = new LocalDevShellService(baseDir, options);

  try {
    const [first, second] = await Promise.all([
      firstService.runCommand({
        workspaceRoot: baseDir,
        command: "printf first",
        timeoutMs: 2_000,
      }),
      secondService.runCommand({
        workspaceRoot: baseDir,
        command: "printf second",
        timeoutMs: 2_000,
      }),
    ]);

    assert.equal(first.status, "COMPLETED");
    assert.equal(first.text, "first");
    assert.equal(second.status, "COMPLETED");
    assert.equal(second.text, "second");
  } finally {
    await Promise.allSettled([firstService.close(), secondService.close()]);
  }
});

test("a client killed after child handoff cannot leave a live initializing child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-shell-handoff-death-"));
  const authorityPath = path.join(root, "bootstrap-authority");
  const initializedPath = path.join(root, "initialized");
  const moduleUrl = pathToFileURL(path.resolve("src/devshell/bootstrapAuthority.ts")).href;
  const tsxImport = createRequire(import.meta.url).resolve("tsx");
  const workerScript = `
    const fs = require("node:fs");
    process.on("message", (message) => {
      if (message?.type === "proceed") fs.writeFileSync(${JSON.stringify(initializedPath)}, "initialized");
    });
    process.once("disconnect", () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const clientScript = `
    import { acquireDevShellBootstrapAuthority } from ${JSON.stringify(moduleUrl)};
    import { spawn } from "node:child_process";
    const result = await acquireDevShellBootstrapAuthority({
      authorityPath: ${JSON.stringify(authorityPath)}, ownerToken: "client-owner",
      timeoutMs: 1000, pollIntervalMs: 2,
    });
    if (result.status !== "acquired") process.exit(2);
    const worker = spawn(process.execPath, ["-e", ${JSON.stringify(workerScript)}], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true,
    });
    const transferred = await result.lease.transferTo({ ownerPid: worker.pid, ownerToken: "worker-owner" });
    if (!transferred) process.exit(3);
    process.stdout.write(String(worker.pid) + "\\n", () => process.kill(process.pid, "SIGKILL"));
  `;
  const client = spawn(process.execPath, ["--import", tsxImport, "--input-type=module", "-e", clientScript], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const workerPid = Number(await waitForOutput(client));
  await waitForExit(client);

  const recovered = await acquireDevShellBootstrapAuthority({
    authorityPath, ownerToken: "next-client", timeoutMs: 2_000, pollIntervalMs: 5,
  });
  assert.equal(recovered.status, "acquired");
  assert.equal(isPidRunning(workerPid), false);
  await assert.rejects(readFile(initializedPath, "utf8"), /ENOENT/u);
  if (recovered.status === "acquired") await recovered.lease.release();
});

test("LocalDevShellService serializes simultaneous same-binding cold starts", async () => {
  const baseDir = await mkdtemp(
    path.join(os.tmpdir(), "local-dev-shell-same-binding-"),
  );
  const binding = { driver: "sqlite" as const, revision: "binding-shared" };
  const services = [
    new LocalDevShellService(baseDir, {
      storeBinding: binding,
      startupTimeoutMs: 2_000,
      pollIntervalMs: 2,
    }) as any,
    new LocalDevShellService(baseDir, {
      storeBinding: binding,
      startupTimeoutMs: 2_000,
      pollIntervalMs: 2,
    }) as any,
  ];
  let health: Record<string, unknown> | undefined;
  let spawnCount = 0;

  for (const service of services) {
    service.performRequest = async (method: string, pathname: string) => {
      if (method === "GET" && pathname === "/health") {
        if (health === undefined) throw new Error("not ready");
        return health;
      }
      if (method === "POST" && pathname === "/shell/run") {
        return completedRunResult("shared");
      }
      throw new Error(`unexpected request ${method} ${pathname}`);
    };
    service.spawnService = async () => {
      spawnCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      health = compatibleHealth(binding);
      return fakeRunningChild();
    };
  }

  const [first, second] = await Promise.all(
    services.map((service) =>
      service.runCommand({ workspaceRoot: ".", command: "echo shared" }),
    ),
  );

  assert.equal(first.status, "COMPLETED");
  assert.equal(second.status, "COMPLETED");
  assert.equal(spawnCount, 1);
});

test("LocalDevShellService serializes competing-binding replacements", async () => {
  const baseDir = await mkdtemp(
    path.join(os.tmpdir(), "local-dev-shell-competing-binding-"),
  );
  const bindings = [
    { driver: "sqlite" as const, revision: "binding-a" },
    { driver: "sqlite" as const, revision: "binding-b" },
  ];
  const services = bindings.map(
    (storeBinding) =>
      new LocalDevShellService(baseDir, {
        storeBinding,
        startupTimeoutMs: 2_000,
        pollIntervalMs: 2,
      }) as any,
  );
  let health: Record<string, unknown> | undefined;
  let activeBootstraps = 0;
  let maximumActiveBootstraps = 0;
  let spawnCount = 0;
  let replacementCount = 0;

  services.forEach((service, index) => {
    service.performRequest = async (method: string, pathname: string) => {
      if (method === "GET" && pathname === "/health") {
        if (health === undefined) throw new Error("not ready");
        return health;
      }
      if (method === "POST" && pathname === "/shell/run") {
        return completedRunResult(String(index));
      }
      throw new Error(`unexpected request ${method} ${pathname}`);
    };
    service.stopIncompatibleService = async () => {
      replacementCount += 1;
      health = undefined;
    };
    service.spawnService = async () => {
      spawnCount += 1;
      activeBootstraps += 1;
      maximumActiveBootstraps = Math.max(
        maximumActiveBootstraps,
        activeBootstraps,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      health = compatibleHealth(bindings[index]!);
      activeBootstraps -= 1;
      return fakeRunningChild();
    };
  });

  await Promise.all(
    services.map((service, index) =>
      service.runCommand({
        workspaceRoot: ".",
        command: `echo ${index}`,
      }),
    ),
  );

  assert.equal(spawnCount, 2);
  assert.equal(replacementCount, 1);
  assert.equal(maximumActiveBootstraps, 1);
});

test("LocalDevShellService releases bootstrap authority after failed bootstrap", async () => {
  const baseDir = await mkdtemp(
    path.join(os.tmpdir(), "local-dev-shell-failed-authority-"),
  );
  const binding = { driver: "sqlite" as const, revision: "binding-shared" };
  const failing = new LocalDevShellService(baseDir, {
    storeBinding: binding,
    startupTimeoutMs: 500,
    pollIntervalMs: 2,
  }) as any;
  const recovering = new LocalDevShellService(baseDir, {
    storeBinding: binding,
    startupTimeoutMs: 500,
    pollIntervalMs: 2,
  }) as any;
  let health: Record<string, unknown> | undefined;
  let recoveringSpawned = false;

  failing.performRequest = async () => {
    throw new Error("not ready");
  };
  failing.spawnService = async () => {
    throw new Error("deterministic bootstrap failure");
  };
  recovering.performRequest = async (method: string, pathname: string) => {
    if (method === "GET" && pathname === "/health") {
      if (health === undefined) throw new Error("not ready");
      return health;
    }
    if (method === "POST" && pathname === "/shell/run") {
      return completedRunResult("recovered");
    }
    throw new Error(`unexpected request ${method} ${pathname}`);
  };
  recovering.spawnService = async () => {
    recoveringSpawned = true;
    health = compatibleHealth(binding);
    return fakeRunningChild();
  };

  await assert.rejects(
    failing.runCommand({ workspaceRoot: ".", command: "echo fail" }),
    /deterministic bootstrap failure/u,
  );
  const result = await recovering.runCommand({
    workspaceRoot: ".",
    command: "echo recovered",
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(recoveringSpawned, true);
});

test("LocalDevShellService preserves a pre-existing socket with no provable live owner", async () => {
  const baseDir = await mkdtemp(
    path.join(os.tmpdir(), "local-dev-shell-unproven-socket-"),
  );
  const service = new LocalDevShellService(baseDir, {
    storeBinding: { driver: "sqlite", revision: "binding-current" },
    startupTimeoutMs: 100,
    pollIntervalMs: 2,
  }) as any;
  await writeFile(service.socketPath, "unproven owner", "utf8");
  let spawned = false;
  service.spawnService = async () => {
    spawned = true;
    throw new Error("replacement must not start");
  };

  await assert.rejects(
    service.runCommand({ workspaceRoot: ".", command: "echo unreachable" }),
    (error: unknown) =>
      (error as { details?: Record<string, unknown> }).details
        ?.bootstrapReason === "socket_ownership_unproven",
  );

  assert.equal(spawned, false);
  assert.equal(await readFile(service.socketPath, "utf8"), "unproven owner");
});

function compatibleHealth(binding: {
  driver: "sqlite" | "postgres";
  revision: string;
}): Record<string, unknown> {
  return {
    ok: true,
    serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
    servicePid: process.pid,
    storeDriver: binding.driver,
    storeBindingRevision: binding.revision,
    capabilities: {
      processWriteAndRead: true,
      processRetentionLeases: true,
      processRetentionPromotion: true,
    },
  };
}

function fakeRunningChild(): Record<string, unknown> {
  return {
    exitCode: null,
    signalCode: null,
    unref() {},
  };
}

function completedRunResult(text: string): Record<string, unknown> {
  return {
    status: "COMPLETED",
    stdout: text,
    text,
    truncated: false,
    exitCode: 0,
  };
}

async function waitForOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("\n")) resolve(output.trim());
    });
    child.once("exit", (code) => {
      if (output.length === 0) reject(new Error(`client exited before handoff: ${code}`));
    });
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function isPidRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
