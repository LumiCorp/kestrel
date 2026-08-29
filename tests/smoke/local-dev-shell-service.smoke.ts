import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("standalone LocalDevShellService uses its SQLite settings store while inheriting an application URL", async () => {
  const serviceModuleUrl = new URL("../../src/devshell/LocalDevShellService.ts", import.meta.url).href;
  const script = `
    import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
    import path from "node:path";
    import { LocalDevShellService } from ${JSON.stringify(serviceModuleUrl)};

    const baseDir = await mkdtemp(path.join("/tmp", "ldss-"));
    const runtimeHome = path.join(baseDir, "runtime-home");
    await mkdir(runtimeHome, { recursive: true });
    await writeFile(
      path.join(runtimeHome, "settings.json"),
      JSON.stringify({ version: 1, defaults: { storeDriver: "sqlite" } }),
      "utf8",
    );
    const service = new LocalDevShellService(baseDir, {
      env: {
        ...process.env,
        KESTREL_HOME: runtimeHome,
        KESTREL_STORE_DRIVER: undefined,
        DATABASE_URL: "postgres://application.example/workspace",
      },
      startupTimeoutMs: 30_000,
      pollIntervalMs: 25,
    });

    const result = await service.runCommand({
      workspaceRoot: baseDir,
      command: "printf \\\"$DATABASE_URL\\\"",
      envMode: "inherit",
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
  assert.equal(payload.text, "postgres://application.example/workspace");
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
      env: {
        ...process.env,
        KESTREL_HOME: path.join(baseDir, "runtime-home"),
        KESTREL_STORE_DRIVER: "sqlite",
        DATABASE_URL: undefined,
      },
      startupTimeoutMs: 30_000,
      pollIntervalMs: 25,
    });

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

test("PGlite Local Core binding serves a static site despite a dead application DATABASE_URL", async () => {
  const serviceModuleUrl = new URL("../../src/devshell/LocalDevShellService.ts", import.meta.url).href;
  const localCoreStoreModuleUrl = new URL("../../src/localCore/store.ts", import.meta.url).href;
  const executionRuntimeModuleUrl = new URL("../../src/localCore/executionRuntime.ts", import.meta.url).href;
  const script = `
    import { mkdtemp, readFile, writeFile } from "node:fs/promises";
    import net from "node:net";
    import path from "node:path";
    import { LocalDevShellService } from ${JSON.stringify(serviceModuleUrl)};
    import { ensureLocalCoreStore } from ${JSON.stringify(localCoreStoreModuleUrl)};
    import { createLocalCoreDevShellStoreBinding } from ${JSON.stringify(executionRuntimeModuleUrl)};

    const root = await mkdtemp(path.join("/tmp", "ldss-static-"));
    const applicationDatabaseUrl = "postgres://application:secret@127.0.0.1:1/workspace";
    await writeFile(path.join(root, "index.html"), "kestrel static proof", "utf8");
    const localCoreStore = await ensureLocalCoreStore({
      homePath: path.join(root, "local-core"),
      mode: "pglite",
    });
    const storeBinding = createLocalCoreDevShellStoreBinding(
      localCoreStore,
      "static-proof-binding",
    );
    const service = new LocalDevShellService(root, {
      env: {
        ...process.env,
        KESTREL_HOME: path.join(root, "runtime-home"),
        DATABASE_URL: applicationDatabaseUrl,
        KESTREL_STORE_DRIVER: "postgres",
      },
      storeBinding,
      startupTimeoutMs: 30_000,
      pollIntervalMs: 25,
    });
    let processId;
    try {
      const environment = await service.runCommand({
        workspaceRoot: root,
        command: "printf '%s\\n%s\\n%s\\n%s' \\\"$DATABASE_URL\\\" \\\"$KESTREL_DEV_SHELL_STORE_DRIVER\\\" \\\"$KESTREL_DEV_SHELL_STORE_DATABASE_URL\\\" \\\"$KESTREL_DEV_SHELL_STORE_BINDING_REVISION\\\"",
        envMode: "inherit",
        timeoutMs: 2_000,
      });
      const port = await new Promise((resolve, reject) => {
        const reservation = net.createServer();
        reservation.once("error", reject);
        reservation.listen(0, "127.0.0.1", () => {
          const address = reservation.address();
          const selected = typeof address === "object" && address !== null ? address.port : undefined;
          reservation.close((error) => error ? reject(error) : resolve(selected));
        });
      });
      const started = await service.startProcess({
        workspaceRoot: root,
        command: \`python3 -m http.server \${port} --bind 127.0.0.1\`,
        envMode: "inherit",
        yieldTimeMs: 250,
      });
      processId = started.processId;
      if (processId === undefined) throw new Error("static server did not return a process id");
      let response;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          response = await fetch(\`http://127.0.0.1:\${port}/\`);
          if (response.ok) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (response === undefined || response.ok === false) {
        throw new Error("static server endpoint did not become reachable");
      }
      const body = await response.text();
      const health = await service.readHealth();
      const stopped = await service.stopProcess({ processId, waitMs: 2_000 });
      processId = undefined;
      const status = await readFile(service.bootstrapStatusPath, "utf8");
      const log = await readFile(service.logPath, "utf8");
      console.log(JSON.stringify({
        environment: environment.text,
        health,
        body,
        stopped: stopped.status,
        status,
        log,
      }));
    } finally {
      if (processId !== undefined) {
        await service.stopProcess({ processId, waitMs: 2_000 }).catch(() => {});
      }
      await service.close();
      await localCoreStore.close();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 60_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim()) as {
    environment: string;
    health: Record<string, unknown>;
    body: string;
    stopped: string;
    status: string;
    log: string;
  };
  assert.equal(
    payload.environment,
    "postgres://application:secret@127.0.0.1:1/workspace\n\n\n",
  );
  assert.equal(payload.health.storeDriver, "sqlite");
  assert.equal(payload.health.storeBindingRevision, "static-proof-binding");
  assert.equal(payload.body, "kestrel static proof");
  assert.equal(payload.stopped, "STOPPED");
  assert.doesNotMatch(payload.status, /application:secret/u);
  assert.doesNotMatch(payload.log, /application:secret/u);
});
