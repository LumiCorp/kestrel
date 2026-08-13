import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
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
