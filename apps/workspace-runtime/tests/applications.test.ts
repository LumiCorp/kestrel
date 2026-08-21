import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  parseRegistration,
  WorkspaceApplicationRegistry,
} from "../src/applications.js";


test("application registration accepts private sandbox ports and bounded paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-app-registration-"));
  try {
    await mkdir(path.join(root, "app"));
    assert.deepEqual(
      await parseRegistration(
        { name: "Preview", command: "pnpm dev", workingDirectory: "app", port: 3000 },
        root
      ),
      { name: "Preview", command: "pnpm dev", workingDirectory: "app", port: 3000 }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("application registration reserves Workspace service ports", async () => {
  await assert.rejects(
    parseRegistration({ name: "Bad", command: "serve", port: 43_104 }, "/workspace")
  );
});

test("desired applications restart when a sleeping Workspace wakes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-apps-"));
  try {
    await mkdir(path.join(root, ".kestrel"));
    await writeFile(
      path.join(root, ".kestrel", "applications.json"),
      JSON.stringify([
        {
          id: "app-1",
          name: "Preview",
          command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`,
          workingDirectory: "",
          port: 3000,
          desiredState: "running",
          status: "stopped",
          processId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ])
    );
    const registry = new WorkspaceApplicationRegistry(root);
    await registry.restore();
    assert.equal(registry.get("app-1")?.status, "running");
    assert.ok(registry.get("app-1")?.processId);
    await registry.stopAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("application lifecycle controls persist the desired state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-apps-lifecycle-"));
  try {
    await mkdir(path.join(root, ".kestrel"));
    const registry = new WorkspaceApplicationRegistry(root);
    const application = await registry.register({
      name: "Preview",
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`,
      port: 3000,
    });
    assert.equal(application.desiredState, "running");
    assert.equal(application.status, "running");

    const stopped = await registry.stop(application.id);
    assert.equal(stopped.desiredState, "stopped");
    assert.equal(stopped.status, "stopped");

    await registry.stopAll();
    assert.equal(registry.get(application.id)?.status, "stopped");
    const restarted = await registry.start(application.id);
    assert.equal(restarted.desiredState, "running");
    assert.equal(restarted.status, "running");
    await registry.stopAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping an application terminates shell descendants and releases its port", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-apps-process-group-"));
  const port = await availablePort();
  const pidPath = path.join(root, "application.pid");
  const scriptPath = path.join(root, "application.mjs");
  let applicationPid: number | null = null;
  try {
    await mkdir(path.join(root, ".kestrel"));
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        'import { createServer } from "node:http";',
        `const server = createServer((_request, response) => response.end("ok"));`,
        `server.listen(${port}, "127.0.0.1", () => {`,
        `  writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        `});`,
      ].join("\n"),
    );
    const registry = new WorkspaceApplicationRegistry(root);
    const application = await registry.register({
      name: "Forking preview",
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} & wait`,
      port,
    });
    applicationPid = Number(await waitForFile(pidPath));
    assert.equal(processIsAlive(applicationPid), true);

    await registry.stop(application.id);
    await registry.stopAll();

    assert.equal(registry.get(application.id)?.status, "stopped");
    assert.equal(processIsAlive(applicationPid), false);
    await assertPortAvailable(port);
  } finally {
    if (applicationPid && processIsAlive(applicationPid)) {
      process.kill(applicationPid, "SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping an application escalates to SIGKILL for a resistant descendant", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-apps-sigkill-"));
  const port = await availablePort();
  const pidPath = path.join(root, "application.pid");
  const scriptPath = path.join(root, "application.mjs");
  let applicationPid: number | null = null;
  try {
    await mkdir(path.join(root, ".kestrel"));
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        'import { createServer } from "node:http";',
        'process.on("SIGTERM", () => {});',
        `const server = createServer((_request, response) => response.end("ok"));`,
        `server.listen(${port}, "127.0.0.1", () => {`,
        `  writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        `});`,
      ].join("\n"),
    );
    const registry = new WorkspaceApplicationRegistry(root, {
      terminationGraceMs: 50,
    });
    const application = await registry.register({
      name: "Resistant preview",
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} & wait`,
      port,
    });
    applicationPid = Number(await waitForFile(pidPath));

    const stopped = await registry.stop(application.id);

    assert.equal(stopped.status, "stopped");
    assert.equal(processIsAlive(applicationPid), false);
    await assertPortAvailable(port);
  } finally {
    if (applicationPid && processIsAlive(applicationPid)) {
      process.kill(applicationPid, "SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a queued restart waits for the previous process group to stop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-apps-restart-"));
  try {
    await mkdir(path.join(root, ".kestrel"));
    const registry = new WorkspaceApplicationRegistry(root);
    const application = await registry.register({
      name: "Preview",
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`,
      port: 3000,
    });
    const initialPid = application.processId;

    const stop = registry.stop(application.id);
    const start = registry.start(application.id);
    await stop;
    const restarted = await start;

    assert.equal(restarted.desiredState, "running");
    assert.equal(restarted.status, "running");
    assert.notEqual(restarted.processId, initialPid);
    assert.equal(initialPid ? processIsAlive(initialPid) : false, false);
    await registry.stopAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starting an already-running application is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-apps-idempotent-start-"));
  try {
    await mkdir(path.join(root, ".kestrel"));
    const registry = new WorkspaceApplicationRegistry(root);
    const application = await registry.register({
      name: "Preview",
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`,
      port: 3000,
    });

    const started = await registry.start(application.id);

    assert.equal(started.status, "running");
    assert.equal(started.processId, application.processId);
    await registry.stopAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("natural application exits preserve successful and failed exit status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-apps-natural-exit-"));
  try {
    await mkdir(path.join(root, ".kestrel"));
    const registry = new WorkspaceApplicationRegistry(root);
    const successful = await registry.register({
      name: "Successful command",
      command: "exit 0",
      port: 3000,
    });
    const failed = await registry.register({
      name: "Failed command",
      command: "exit 7",
      port: 3001,
    });

    await waitForApplicationStatus(registry, successful.id, "stopped");
    await waitForApplicationStatus(registry, failed.id, "failed");

    assert.equal(registry.get(successful.id)?.status, "stopped");
    assert.equal(registry.get(failed.id)?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForFile(filePath: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function waitForApplicationStatus(
  registry: WorkspaceApplicationRegistry,
  applicationId: string,
  expectedStatus: "stopped" | "failed"
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (registry.get(applicationId)?.status === expectedStatus) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for application ${applicationId} to become ${expectedStatus}.`
  );
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertPortAvailable(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
