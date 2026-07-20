import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("LocalDevShellService starts a real supervisor with a sqlite store", async () => {
  const serviceModuleUrl = new URL("../../src/devshell/LocalDevShellService.ts", import.meta.url).href;
  const script = `
    import { mkdtemp } from "node:fs/promises";
    import path from "node:path";
    import { LocalDevShellService } from ${JSON.stringify(serviceModuleUrl)};

    const baseDir = await mkdtemp(path.join("/tmp", "ldss-"));
    const service = new LocalDevShellService(baseDir, {
      startupTimeoutMs: 30_000,
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

test("LocalDevShellService recovers a real supervisor from a corrupt sqlite store", async () => {
  const serviceModuleUrl = new URL("../../src/devshell/LocalDevShellService.ts", import.meta.url).href;
  const script = `
    import { mkdtemp, readdir, writeFile } from "node:fs/promises";
    import path from "node:path";
    import { LocalDevShellService } from ${JSON.stringify(serviceModuleUrl)};

    const baseDir = await mkdtemp(path.join("/tmp", "ldss-recovery-"));
    await writeFile(path.join(baseDir, "store.db"), "invalid pglite store", "utf8");
    const service = new LocalDevShellService(baseDir, {
      startupTimeoutMs: 30_000,
      pollIntervalMs: 25,
    });
    delete process.env.DATABASE_URL;
    process.env.KESTREL_STORE_DRIVER = "sqlite";
    process.env.KESTREL_HOME = path.join(baseDir, "runtime-home");

    const result = await service.runCommand({
      workspaceRoot: baseDir,
      command: "printf recovered",
      timeoutMs: 2_000,
    });
    await service.close();
    const entries = await readdir(baseDir);
    console.log(JSON.stringify({
      status: result.status,
      text: result.text,
      recoveryStores: entries.filter((entry) => entry.startsWith("store.db.recovery-")),
    }));
  `;

  const env: NodeJS.ProcessEnv = { ...process.env, KESTREL_STORE_DRIVER: "sqlite" };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim()) as {
    status: string;
    text: string;
    recoveryStores: string[];
  };
  assert.equal(payload.status, "COMPLETED");
  assert.equal(payload.text, "recovered");
  assert.equal(payload.recoveryStores.length, 1);
});

test("LocalDevShellService starts a real supervisor with explicit split paths", async () => {
  const serviceModuleUrl = new URL("../../src/devshell/LocalDevShellService.ts", import.meta.url).href;
  const script = `
    import { mkdtemp } from "node:fs/promises";
    import path from "node:path";
    import { LocalDevShellService } from ${JSON.stringify(serviceModuleUrl)};
    const root = await mkdtemp(path.join("/tmp", "ldss-split-"));
    delete process.env.DATABASE_URL;
    process.env.KESTREL_STORE_DRIVER = "sqlite";
    process.env.KESTREL_HOME = path.join(root, "runtime-home");
    process.env.KESTREL_DEV_SHELL_SOCKET_PATH = path.join(root, "runtime", "supervisor.sock");
    process.env.KESTREL_DEV_SHELL_LOG_PATH = path.join(root, "attempt", "logs", "service.log");
    process.env.KESTREL_DEV_SHELL_STATUS_PATH = path.join(root, "attempt", "status", "bootstrap-status.json");
    const service = new LocalDevShellService(undefined, { startupTimeoutMs: 30_000, pollIntervalMs: 25 });
    const result = await service.runCommand({
      workspaceRoot: root,
      command: "printf ok && sleep 0.1",
      timeoutMs: 10_000,
    });
    await service.close();
    console.log(JSON.stringify({ status: result.status, text: result.text }));
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, KESTREL_STORE_DRIVER: "sqlite" };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim()) as { status: string; text: string };
  assert.equal(payload.status, "COMPLETED");
  assert.equal(payload.text, "ok");
});
