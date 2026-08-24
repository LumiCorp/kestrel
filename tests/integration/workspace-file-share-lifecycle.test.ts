import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DevShellSupervisor } from "../../src/devshell/DevShellSupervisor.js";
import { InMemoryDevShellStore } from "../../src/devshell/InMemoryDevShellStore.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { workspaceFilesShareTool } from "../../tools/kestrelOne/workspaceFileShare.js";
import { workspacePreviewCloseTool } from "../../tools/kestrelOne/workspacePreviews.js";

test("workspace.files.share serves one immutable binary payload with safe HTTP behavior", async () => {
  const fixture = await createFixture();
  const sourceBytes = Buffer.from([0x00, 0xff, 0x7f, 0x42, 0x10]);
  await writeFile(path.join(fixture.workspaceRoot, "report.bin"), sourceBytes);
  await writeFile(path.join(fixture.workspaceRoot, "unselected.txt"), "private");
  try {
    const output = await workspaceFilesShareTool.createHandler(fixture.context)({
      mode: "file",
      paths: ["report.bin"],
      downloadName: "final report.bin",
      ttlMinutes: 30,
    }) as ShareResult;

    assert.equal(output.share.url, `${fixture.publicUrl}/final%20report.bin`);
    assert.equal(output.share.sizeBytes, sourceBytes.length);
    assert.equal(output.share.fileCount, 1);
    assert.match(output.warning, /Anyone with this link/u);
    assert.equal(fixture.publishedName, "Download: final report.bin");
    assert.equal(fixture.publishedTtlMinutes, 30);

    const localUrl = `http://127.0.0.1:${fixture.publishedPort}/final%20report.bin`;
    const download = await fetch(localUrl);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), sourceBytes);
    assert.equal(download.headers.get("accept-ranges"), "bytes");
    assert.equal(download.headers.get("content-length"), String(sourceBytes.length));
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      download.headers.get("content-disposition") ?? "",
      /attachment; filename="final report\.bin"; filename\*=UTF-8''final%20report\.bin/u,
    );

    await writeFile(path.join(fixture.workspaceRoot, "report.bin"), "changed");
    assert.deepEqual(
      Buffer.from(await (await fetch(localUrl)).arrayBuffer()),
      sourceBytes,
    );

    const head = await fetch(localUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(sourceBytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const range = await fetch(localUrl, { headers: { range: "bytes=1-3" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 1-3/${sourceBytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), sourceBytes.subarray(1, 4));
    const suffix = await fetch(localUrl, { headers: { range: "bytes=-2" } });
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), sourceBytes.subarray(3));
    const invalidRange = await fetch(localUrl, { headers: { range: "bytes=99-100" } });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("content-range"), `bytes */${sourceBytes.length}`);

    assert.equal((await fetch(`http://127.0.0.1:${fixture.publishedPort}/`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${fixture.publishedPort}/unselected.txt`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${fixture.publishedPort}/..%2Funselected.txt`)).status, 404);
    assert.equal((await fetch(localUrl, { method: "POST" })).status, 405);

    const normalized = workspaceFilesShareTool.normalizeResult?.(output, {});
    assert.deepEqual(normalized?.presentation?.artifacts, [
      {
        id: "file-share:preview-file-share",
        title: "final report.bin",
        kind: "file-share",
        url: `${fixture.publicUrl}/final%20report.bin`,
        mediaType: "application/octet-stream",
        metadata: {
          previewId: "preview-file-share",
          sizeBytes: sourceBytes.length,
          fileCount: 1,
          expiresAt: fixture.expiresAt,
          warning: output.warning,
        },
      },
    ]);

    await workspacePreviewCloseTool.createHandler(fixture.context)({
      previewId: output.share.previewId,
    });
    await eventually(async () => {
      const entries = await readdir(fixture.tempRoot);
      return entries.every((entry) => !entry.startsWith("kestrel-file-share-"));
    });
    assert.equal(fixture.closed, true);
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share streams a ZIP containing only normalized selected paths", async () => {
  const fixture = await createFixture();
  await mkdir(path.join(fixture.workspaceRoot, "reports"), { recursive: true });
  await writeFile(path.join(fixture.workspaceRoot, "reports", "summary.txt"), "summary\n");
  await writeFile(path.join(fixture.workspaceRoot, "data.bin"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(fixture.workspaceRoot, "not-selected.txt"), "nope");
  const expiredStage = path.join(fixture.tempRoot, "kestrel-file-share-orphan");
  await mkdir(expiredStage);
  await writeFile(path.join(expiredStage, "metadata.json"), JSON.stringify({
    version: 1,
    expiresAt: "2026-01-01T00:00:00.000Z",
  }));
  await writeFile(path.join(expiredStage, "leftover"), "stale");
  try {
    const output = await workspaceFilesShareTool.createHandler(fixture.context)({
      mode: "zip",
      paths: ["reports/summary.txt", "data.bin"],
      downloadName: "package.zip",
    }) as ShareResult;
    const response = await fetch(
      `http://127.0.0.1:${fixture.publishedPort}/package.zip`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const entries = readStoredZip(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual([...entries.keys()], ["reports/summary.txt", "data.bin"]);
    assert.equal(entries.get("reports/summary.txt")?.toString("utf8"), "summary\n");
    assert.deepEqual(entries.get("data.bin"), Buffer.from([1, 2, 3]));
    assert.equal(entries.has("not-selected.txt"), false);
    assert.equal(output.share.fileCount, 2);
    assert.equal(output.share.mediaType, "application/zip");
    await assert.rejects(access(expiredStage));
    await workspacePreviewCloseTool.createHandler(fixture.context)({
      previewId: output.share.previewId,
    });
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share rejects links, duplicates, traversal, and directories before publication", async () => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.workspaceRoot, "one.txt"), "one");
  await mkdir(path.join(fixture.workspaceRoot, "folder"));
  await symlink("one.txt", path.join(fixture.workspaceRoot, "linked.txt"));
  try {
    for (const input of [
      { mode: "file", paths: ["linked.txt"] },
      { mode: "file", paths: ["folder"] },
      { mode: "file", paths: ["../outside.txt"] },
      { mode: "zip", paths: ["one.txt", "./one.txt"] },
    ]) {
      await assert.rejects(
        workspaceFilesShareTool.createHandler(fixture.context)(input),
        (error: unknown) => {
          assert.equal(
            (error as RuntimeFailure).code,
            "WORKSPACE_FILE_SHARE_PATH_INVALID",
          );
          return true;
        },
      );
    }
    assert.equal(fixture.publishCalls, 0);
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share preserves preview publication failure and removes its managed payload", async () => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.workspaceRoot, "report.txt"), "report\n");
  fixture.context.fetchImpl = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { port: number };
    fixture.publishedPort = body.port;
    return Response.json(
      { error: { code: "PREVIEW_PUBLICATION_FAILED" } },
      { status: 503 },
    );
  }) as typeof fetch;
  try {
    await assert.rejects(
      workspaceFilesShareTool.createHandler(fixture.context)({
        mode: "file",
        paths: ["report.txt"],
      }),
      (error: unknown) => {
        assert.equal((error as RuntimeFailure).code, "PREVIEW_PUBLICATION_FAILED");
        return true;
      },
    );
    await eventually(async () => {
      const entries = await readdir(fixture.tempRoot);
      return entries.every((entry) => !entry.startsWith("kestrel-file-share-"));
    });
    await eventually(async () => {
      if (fixture.publishedPort === 0) return false;
      return fetch(`http://127.0.0.1:${fixture.publishedPort}/`)
        .then(() => false)
        .catch(() => true);
    });
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share stops a process when its readiness read fails", async () => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.workspaceRoot, "report.txt"), "report\n");
  let stopCalls = 0;
  const context = {
    ...fixture.context,
    devShellService: {
      async startProcess() {
        return {
          status: "RUNNING",
          processId: "process-read-failure",
          text: "",
          nextCursor: 0,
        };
      },
      async readProcess() {
        throw new Error("read transport failed");
      },
      async stopProcess() {
        stopCalls += 1;
        return {
          status: "STOPPED",
          processId: "process-read-failure",
          text: "",
          nextCursor: 0,
        };
      },
    } as unknown as NonNullable<typeof fixture.context.devShellService>,
  };
  try {
    await assert.rejects(
      workspaceFilesShareTool.createHandler(context)({
        mode: "file",
        paths: ["report.txt"],
      }),
      (error: unknown) => {
        assert.equal(
          (error as RuntimeFailure).code,
          "WORKSPACE_FILE_SHARE_SERVER_FAILED",
        );
        assert.match((error as Error).message, /confirm/u);
        return true;
      },
    );
    assert.equal(stopCalls, 1);
    await eventually(async () => {
      const entries = await readdir(fixture.tempRoot);
      return entries.every((entry) => !entry.startsWith("kestrel-file-share-"));
    });
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share rejects a payload above 500 MiB before starting a process", async () => {
  const fixture = await createFixture();
  const oversizedPath = path.join(fixture.workspaceRoot, "oversized.bin");
  await writeFile(oversizedPath, "");
  await truncate(oversizedPath, (500 * 1024 * 1024) + 1);
  try {
    await assert.rejects(
      workspaceFilesShareTool.createHandler(fixture.context)({
        mode: "file",
        paths: ["oversized.bin"],
      }),
      (error: unknown) => {
        assert.equal(
          (error as RuntimeFailure).code,
          "WORKSPACE_FILE_SHARE_LIMIT_EXCEEDED",
        );
        return true;
      },
    );
    assert.equal(fixture.publishCalls, 0);
  } finally {
    await fixture.supervisor.close();
  }
});

interface ShareResult {
  share: {
    previewId: string;
    url: string;
    downloadName: string;
    mediaType: string;
    sizeBytes: number;
    fileCount: number;
    expiresAt: string;
  };
  warning: string;
}

async function createFixture(): Promise<{
  supervisor: DevShellSupervisor;
  workspaceRoot: string;
  tempRoot: string;
  context: Parameters<typeof workspaceFilesShareTool.createHandler>[0];
  publicUrl: string;
  expiresAt: string;
  publishedPort: number;
  publishedName: string | undefined;
  publishedTtlMinutes: number | undefined;
  publishCalls: number;
  closed: boolean;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), "kestrel-file-share-test-"));
  const workspacePath = path.join(base, "workspace");
  const tempRoot = path.join(base, "tmp");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  const workspaceRoot = await realpath(workspacePath);
  const supervisor = new DevShellSupervisor(
    new InMemoryDevShellStore(),
    path.join(base, "state"),
  );
  await supervisor.initialize();
  const publicUrl = "https://p-file-share.preview.kestrelagents.dev";
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const fixture = {
    supervisor,
    workspaceRoot,
    tempRoot,
    context: undefined as unknown as Parameters<typeof workspaceFilesShareTool.createHandler>[0],
    publicUrl,
    expiresAt,
    publishedPort: 0,
    publishedName: undefined as string | undefined,
    publishedTtlMinutes: undefined as number | undefined,
    publishCalls: 0,
    closed: false,
  };
  fixture.context = {
    devShellService: supervisor,
    fileSystem: { workspaceRoot, tempRoots: [tempRoot], readOnlyRoots: [] },
    fetchImpl: (async (_input, init) => {
      if (init?.method === "DELETE") {
        fixture.closed = true;
        return Response.json({ ok: true });
      }
      fixture.publishCalls += 1;
      const body = JSON.parse(String(init?.body)) as {
        port: number;
        name?: string;
        ttlMinutes?: number;
      };
      fixture.publishedPort = body.port;
      fixture.publishedName = body.name;
      fixture.publishedTtlMinutes = body.ttlMinutes;
      const local = await fetch(`http://127.0.0.1:${body.port}/`);
      assert.equal(local.status, 404);
      return Response.json({
        preview: {
          id: "preview-file-share",
          url: publicUrl,
          expiresAt,
        },
      });
    }) as typeof fetch,
    kestrelOne: {
      appUrl: "https://kestrel.example",
      executionTicket: "signed-ticket",
    },
  };
  return fixture;
}

function readStoredZip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(flags & 0x0008, 0x0008);
    assert.equal(method, 0);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const descriptor = findDataDescriptor(buffer, dataStart);
    const size = buffer.readUInt32LE(descriptor + 8);
    const data = buffer.subarray(dataStart, dataStart + size);
    assert.equal(dataStart + size, descriptor);
    entries.set(name, Buffer.from(data));
    offset = descriptor + 16;
  }
  return entries;
}

function findDataDescriptor(buffer: Buffer, start: number): number {
  for (let offset = start; offset + 16 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x08074b50) continue;
    const size = buffer.readUInt32LE(offset + 8);
    if (start + size === offset) return offset;
  }
  throw new Error("ZIP data descriptor was not found.");
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Condition did not become true.");
}
