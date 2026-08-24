import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DevShellSupervisor } from "../../src/devshell/DevShellSupervisor.js";
import { InMemoryDevShellStore } from "../../src/devshell/InMemoryDevShellStore.js";
import type {
  DevShellProcessRecord,
  DevShellProcessStatus,
  DevShellProcessStore,
} from "../../src/devshell/contracts.js";
import {
  workspacePreviewCloseTool,
  workspacePreviewPublishTool,
} from "../../tools/kestrelOne/workspacePreviews.js";
import { buildWorkspaceFileShareServerSource } from "../../tools/kestrelOne/workspaceFileShareServerSource.js";

test("file-share server exits on SIGTERM while its owner pipe remains open", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-file-share-sigterm-"));
  const stagePath = path.join(baseDir, "stage");
  const payloadPath = path.join(stagePath, "payload");
  const payloadBytes = Buffer.from("graceful shutdown\n", "utf8");
  await mkdir(stagePath);
  await writeFile(payloadPath, payloadBytes);
  const stageStat = await lstat(stagePath);
  const config = Buffer.from(JSON.stringify({
    stagePath,
    payloadPath,
    downloadName: "graceful.txt",
    mediaType: "text/plain",
    expectedSizeBytes: payloadBytes.length,
    expectedSha256: createHash("sha256").update(payloadBytes).digest("hex"),
    stageDevice: String(stageStat.dev),
    stageInode: String(stageStat.ino),
  }), "utf8").toString("base64url");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", buildWorkspaceFileShareServerSource(), config],
    { stdio: "pipe" },
  );
  try {
    await readFileShareReady(child, 5_000);
    child.kill("SIGTERM");
    await waitForChildExit(child, 1_000);
    assert.equal(child.exitCode, 0);
    await assert.rejects(stat(stagePath), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test(
  "retained file-share exits on abrupt supervisor loss before restart recovery",
  { skip: process.platform === "win32" ? "requires Unix process-group checks" : false },
  async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-file-share-owner-loss-"));
    const workspacePath = path.join(baseDir, "workspace");
    const stateDir = path.join(baseDir, "state");
    const stagePath = path.join(baseDir, "stage");
    const payloadPath = path.join(stagePath, "payload");
    const serverPath = path.join(stagePath, "server.mjs");
    const recordPath = path.join(baseDir, "process-record.json");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(stagePath, { recursive: true });
    const workspaceRoot = await realpath(workspacePath);
    await writeFile(payloadPath, "survives while owned\n", "utf8");
    await writeFile(serverPath, buildWorkspaceFileShareServerSource(), "utf8");
    const owner = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("tests/fixtures/workspace-file-share-supervisor-owner.ts"),
        workspaceRoot,
        stateDir,
        stagePath,
        payloadPath,
        serverPath,
        recordPath,
      ],
      { cwd: process.cwd(), stdio: "pipe" },
    );
    let processGroupId: number | undefined;
    let unrelated: ReturnType<typeof spawn> | undefined;
    try {
      const ready = await readOwnerReady(owner, 10_000);
      processGroupId = ready.processGroupId;
      assert.equal(
        await (await fetch(`http://127.0.0.1:${ready.port}/restart-proof.txt`)).text(),
        "survives while owned\n",
      );
      await assert.rejects(stat(payloadPath), { code: "ENOENT" });

      unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      assert.equal(isProcessRunning(unrelated.pid), true);

      owner.kill("SIGKILL");
      await waitForChildExit(owner, 2_000);
      await waitForProcessGroupExit(processGroupId, 5_000);
      await waitForMissingPath(stagePath, 5_000);
      await assert.rejects(fetch(`http://127.0.0.1:${ready.port}/restart-proof.txt`));
      assert.equal(isProcessRunning(unrelated.pid), true);

      const store = new InMemoryDevShellStore();
      const record = JSON.parse(await readFile(recordPath, "utf8")) as DevShellProcessRecord;
      await store.upsertProcess(record);
      const restarted = new DevShellSupervisor(store, stateDir);
      await restarted.initialize();
      try {
        const recovered = await store.getProcess(ready.processId);
        assert.equal(recovered?.status, "LOST");
        assert.deepEqual(recovered?.retentionLeases, []);
        assert.equal(isProcessRunning(unrelated.pid), true);
      } finally {
        await restarted.close();
      }
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      if (processGroupId !== undefined && isProcessGroupRunning(processGroupId)) {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {}
      }
      if (unrelated?.pid !== undefined && isProcessRunning(unrelated.pid)) {
        unrelated.kill("SIGKILL");
      }
    }
  },
);

test("preview publication retains a real HTTP process beyond its original wall deadline", async () => {
  const fixture = await createHttpProcessFixture(500);
  const publicPreviews = new Set<string>();
  try {
    const context = {
      devShellService: fixture.supervisor,
      fetchImpl: (async (_input, init) => {
        if (init?.method === "DELETE") {
          publicPreviews.delete("preview-success");
          return Response.json({ ok: true });
        }
        await delay(750);
        const response = await fetch(`http://127.0.0.1:${fixture.port}`);
        assert.equal(await response.text(), "ready\n");
        publicPreviews.add("preview-success");
        return Response.json({
          preview: {
            id: "preview-success",
            url: "https://public.example/preview-success",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        });
      }) as typeof fetch,
      kestrelOne: {
        appUrl: "https://kestrel.example",
        executionTicket: "signed-ticket",
      },
    };

    const published = await workspacePreviewPublishTool.createHandler(context)({
      port: fixture.port,
      sessionId: fixture.processId,
    });

    assert.equal(
      (published as { preview: { url: string } }).preview.url,
      "https://public.example/preview-success",
    );
    assert.equal(publicPreviews.has("preview-success"), true);
    assert.equal(
      (await fetch(`http://127.0.0.1:${fixture.port}`)).status,
      200,
    );
    const retained = await fixture.supervisor.inspectProcessRetention({
      processId: fixture.processId,
    });
    assert.deepEqual(
      retained.leases.map((lease) => [lease.leaseId, lease.kind]),
      [["workspace-preview:preview-success", "workspace_preview"]],
    );

    await workspacePreviewCloseTool.createHandler(context)({ previewId: "preview-success" });
    assert.equal(publicPreviews.size, 0);
    assert.equal(
      (await fixture.supervisor.readProcess({ processId: fixture.processId, waitMs: 0 })).status,
      "STOPPED",
    );
  } finally {
    await fixture.supervisor.close();
  }
});

test("failed delayed publication releases provisional retention and stops the real HTTP process", async () => {
  const fixture = await createHttpProcessFixture(500);
  const publicPreviews = new Set<string>();
  try {
    const context = {
      devShellService: fixture.supervisor,
      fetchImpl: (async () => {
        await delay(750);
        const response = await fetch(`http://127.0.0.1:${fixture.port}`);
        assert.equal(response.status, 200);
        return Response.json(
          { error: { code: "PREVIEW_PUBLICATION_FAILED" } },
          { status: 503 },
        );
      }) as typeof fetch,
      kestrelOne: {
        appUrl: "https://kestrel.example",
        executionTicket: "signed-ticket",
      },
    };

    await assert.rejects(
      workspacePreviewPublishTool.createHandler(context)({
        port: fixture.port,
        sessionId: fixture.processId,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "PREVIEW_PUBLICATION_FAILED");
        return true;
      },
    );

    assert.equal(publicPreviews.size, 0);
    assert.equal(
      (await fixture.supervisor.readProcess({ processId: fixture.processId, waitMs: 0 })).status,
      "STOPPED",
    );
    const retained = await fixture.supervisor.inspectProcessRetention({
      processId: fixture.processId,
    });
    assert.equal(retained.status, "missing");
    assert.deepEqual(retained.leases, []);
  } finally {
    await fixture.supervisor.close();
  }
});

test("promotion persistence failure closes the public URL and releases the real HTTP process", async () => {
  const store = new PromotionFailureStore();
  const fixture = await createHttpProcessFixture(100, store);
  const publicPreviews = new Set<string>();
  try {
    const context = {
      devShellService: fixture.supervisor,
      fetchImpl: (async (_input, init) => {
        if (init?.method === "DELETE") {
          publicPreviews.delete("preview-persistence-failure");
          return Response.json({ ok: true });
        }
        publicPreviews.add("preview-persistence-failure");
        store.failNextUpsertAfterWrite();
        return Response.json({
          preview: {
            id: "preview-persistence-failure",
            url: "https://public.example/preview-persistence-failure",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        });
      }) as typeof fetch,
      kestrelOne: {
        appUrl: "https://kestrel.example",
        executionTicket: "signed-ticket",
      },
    };

    await assert.rejects(
      workspacePreviewPublishTool.createHandler(context)({
        port: fixture.port,
        sessionId: fixture.processId,
      }),
      /injected promotion persistence failure/u,
    );

    assert.equal(publicPreviews.size, 0);
    assert.equal(
      (await fixture.supervisor.readProcess({ processId: fixture.processId, waitMs: 0 })).status,
      "STOPPED",
    );
    assert.deepEqual((await store.getProcess(fixture.processId))?.retentionLeases, []);
  } finally {
    await fixture.supervisor.close();
  }
});

async function createHttpProcessFixture(
  timeoutMs: number,
  store: DevShellProcessStore = new InMemoryDevShellStore(),
): Promise<{
  supervisor: DevShellSupervisor;
  processId: string;
  port: number;
}> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-preview-lifecycle-"));
  const workspacePath = path.join(baseDir, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspaceRoot = await realpath(workspacePath);
  const port = await reservePort();
  const supervisor = new DevShellSupervisor(
    store,
    path.join(baseDir, "state"),
  );
  await supervisor.initialize();
  const source = [
    "const http = require('node:http');",
    `http.createServer((_request, response) => response.end('ready\\n')).listen(${port}, '127.0.0.1');`,
  ].join("");
  const started = await supervisor.startProcess({
    workspaceRoot,
    command: `${process.execPath} -e ${shellQuote(source)}`,
    yieldTimeMs: 30,
    timeoutMs,
  });
  assert.equal(started.status, "RUNNING", JSON.stringify(started));
  assert.equal(typeof started.processId, "string");
  return { supervisor, processId: started.processId!, port };
}

class PromotionFailureStore implements DevShellProcessStore {
  private readonly delegate = new InMemoryDevShellStore();
  private failAfterWrite = false;

  failNextUpsertAfterWrite(): void {
    this.failAfterWrite = true;
  }

  async upsertProcess(record: DevShellProcessRecord): Promise<void> {
    await this.delegate.upsertProcess(record);
    if (this.failAfterWrite) {
      this.failAfterWrite = false;
      throw new Error("injected promotion persistence failure");
    }
  }

  getProcess(processId: string): Promise<DevShellProcessRecord | null> {
    return this.delegate.getProcess(processId);
  }

  listProcesses(input?: {
    status?: DevShellProcessStatus[] | undefined;
  }): Promise<DevShellProcessRecord[]> {
    return this.delegate.listProcesses(input);
  }
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = typeof address === "object" && address !== null ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function readOwnerReady(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ processId: string; port: number; processGroupId: number }> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("OWNER_READY ")) continue;
      const parsed = JSON.parse(line.slice("OWNER_READY ".length)) as {
        processId?: unknown;
        port?: unknown;
        processGroupId?: unknown;
      };
      if (
        typeof parsed.processId === "string" &&
        typeof parsed.port === "number" &&
        Number.isInteger(parsed.port) &&
        typeof parsed.processGroupId === "number" &&
        Number.isInteger(parsed.processGroupId)
      ) {
        return {
          processId: parsed.processId,
          port: parsed.port,
          processGroupId: parsed.processGroupId,
        };
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Supervisor owner exited before readiness: ${stderr || stdout}`);
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for supervisor owner readiness: ${stderr || stdout}`);
}

async function readFileShareReady(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<number> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("KESTREL_FILE_SHARE_READY ")) continue;
      const parsed = JSON.parse(line.slice("KESTREL_FILE_SHARE_READY ".length)) as {
        port?: unknown;
      };
      if (typeof parsed.port === "number" && Number.isInteger(parsed.port)) {
        return parsed.port;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`File-share server exited before readiness: ${stderr || stdout}`);
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for file-share readiness: ${stderr || stdout}`);
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    delay(timeoutMs).then(() => {
      throw new Error("Timed out waiting for supervisor owner exit.");
    }),
  ]);
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupRunning(processGroupId) && Date.now() < deadline) {
    await delay(25);
  }
  assert.equal(isProcessGroupRunning(processGroupId), false, "file-share process group remained alive");
}

function isProcessGroupRunning(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessRunning(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForMissingPath(targetPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await delay(25);
  }
  assert.fail(`Timed out waiting for '${targetPath}' to be reclaimed.`);
}
