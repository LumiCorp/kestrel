import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DevShellSupervisor } from "../../src/devshell/DevShellSupervisor.js";
import { InMemoryDevShellStore } from "../../src/devshell/InMemoryDevShellStore.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { workspaceFilesShareTool } from "../../tools/kestrelOne/workspaceFileShare.js";
import { inspectPortableZipEntryName } from "../../tools/kestrelOne/workspaceFileSharePathSafety.js";
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
  await writeFile(path.join(fixture.workspaceRoot, "reports", "überblick.txt"), "Überblick\n");
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
      paths: ["reports/summary.txt", "reports/überblick.txt", "data.bin"],
      downloadName: "package.zip",
    }) as ShareResult;
    const response = await fetch(
      `http://127.0.0.1:${fixture.publishedPort}/package.zip`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const entries = readStoredZip(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual([...entries.keys()], [
      "reports/summary.txt",
      "reports/überblick.txt",
      "data.bin",
    ]);
    assert.equal(entries.get("reports/summary.txt")?.toString("utf8"), "summary\n");
    assert.equal(entries.get("reports/überblick.txt")?.toString("utf8"), "Überblick\n");
    assert.deepEqual(entries.get("data.bin"), Buffer.from([1, 2, 3]));
    assert.equal(entries.has("not-selected.txt"), false);
    assert.equal(output.share.fileCount, 3);
    assert.equal(output.share.mediaType, "application/zip");
    await access(expiredStage);
    await workspacePreviewCloseTool.createHandler(fixture.context)({
      previewId: output.share.previewId,
    });
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share completes forced short file writes before publication", async () => {
  const fixture = await createFixture();
  const sourceBytes = Buffer.alloc((1024 * 1024) + 37);
  for (let index = 0; index < sourceBytes.length; index += 1) {
    sourceBytes[index] = index % 251;
  }
  await writeFile(path.join(fixture.workspaceRoot, "short-write.bin"), sourceBytes);
  let shortWrites = 0;
  try {
    const output = await withFileHandleWriteOverride(async (original, handle, buffer, offset, length, position) => {
      const requested = length >= 1024 * 1024 ? Math.floor(length / 3) : length;
      if (requested !== length) shortWrites += 1;
      return original.call(handle, buffer, offset, requested, position);
    }, async () => workspaceFilesShareTool.createHandler(fixture.context)({
      mode: "file",
      paths: ["short-write.bin"],
    }) as Promise<ShareResult>);

    assert.ok(shortWrites >= 1, "the regression must force a successful short write");
    assert.equal(output.share.sizeBytes, sourceBytes.length);
    const response = await fetch(
      `http://127.0.0.1:${fixture.publishedPort}/short-write.bin`,
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), sourceBytes);
    await workspacePreviewCloseTool.createHandler(fixture.context)({
      previewId: output.share.previewId,
    });
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share rejects portable-unsafe ZIP names and portable collisions", async () => {
  const fixture = await createFixture();
  for (const name of ["unsafe\\entry.txt", "C:drive.txt", "trailing.", "CON.txt"]) {
    await writeFile(path.join(fixture.workspaceRoot, name), name);
  }
  try {
    for (const unsafePath of ["unsafe\\entry.txt", "C:drive.txt", "trailing.", "CON.txt"]) {
      await assert.rejects(
        workspaceFilesShareTool.createHandler(fixture.context)({
          mode: "zip",
          paths: [unsafePath],
        }),
        (error: unknown) => {
          assert.equal((error as RuntimeFailure).code, "WORKSPACE_FILE_SHARE_PATH_INVALID");
          return true;
        },
      );
    }
    assert.equal(fixture.publishCalls, 0);

    const fileShare = await workspaceFilesShareTool.createHandler(fixture.context)({
      mode: "file",
      paths: ["C:drive.txt"],
      downloadName: "drive.txt",
    }) as ShareResult;
    assert.equal(fileShare.share.downloadName, "drive.txt");
    await workspacePreviewCloseTool.createHandler(fixture.context)({
      previewId: fileShare.share.previewId,
    });

    const composed = inspectPortableZipEntryName("Reports/Évidence.txt");
    const decomposed = inspectPortableZipEntryName("reports/E\u0301VIDENCE.TXT");
    assert.ok(!("reason" in composed));
    assert.ok(!("reason" in decomposed));
    assert.equal(composed.collisionKey, decomposed.collisionKey);
    const safe = inspectPortableZipEntryName("資料/結果.txt");
    assert.deepEqual("reason" in safe ? undefined : safe.entryName, "資料/結果.txt");
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share never reclaims forged or replaced staging targets", async () => {
  const fixture = await createFixture();
  const forged = path.join(fixture.tempRoot, "kestrel-file-share-forged");
  const linkedTarget = path.join(fixture.tempRoot, "linked-target");
  const linkedStage = path.join(fixture.tempRoot, "kestrel-file-share-link");
  await mkdir(forged);
  await writeFile(path.join(forged, "metadata.json"), JSON.stringify({
    version: 2,
    ownerId: "forged",
    expiresAt: "2026-01-01T00:00:00.000Z",
  }));
  await writeFile(path.join(forged, "sentinel"), "keep");
  await mkdir(linkedTarget);
  await writeFile(path.join(linkedTarget, "sentinel"), "keep");
  await symlink(linkedTarget, linkedStage, "dir");
  await writeFile(path.join(fixture.workspaceRoot, "one.txt"), "one");
  try {
    await assert.rejects(
      workspaceFilesShareTool.createHandler(fixture.context)({
        mode: "file",
        paths: ["missing.txt"],
      }),
      (error: unknown) => (error as RuntimeFailure).code === "WORKSPACE_FILE_SHARE_PATH_INVALID",
    );
    assert.equal(await readFile(path.join(forged, "sentinel"), "utf8"), "keep");
    assert.equal(await readFile(path.join(linkedTarget, "sentinel"), "utf8"), "keep");

    const output = await workspaceFilesShareTool.createHandler(fixture.context)({
      mode: "file",
      paths: ["one.txt"],
    }) as ShareResult;
    const genuineStage = await findSingleOwnedStage(fixture.tempRoot);
    const genuineMetadata = JSON.parse(
      await readFile(path.join(genuineStage, "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    genuineMetadata.expiresAt = "2026-01-01T00:00:00.000Z";
    await writeFile(
      path.join(genuineStage, "metadata.json"),
      JSON.stringify(genuineMetadata),
    );
    await killRetainedShare(fixture, output.share.previewId);
    const displaced = path.join(fixture.tempRoot, "displaced-genuine-stage");
    await rename(genuineStage, displaced);
    await mkdir(genuineStage);
    await writeFile(path.join(genuineStage, "metadata.json"), JSON.stringify(genuineMetadata));
    await writeFile(path.join(genuineStage, "replacement-sentinel"), "keep replacement");

    await assert.rejects(
      workspaceFilesShareTool.createHandler(fixture.context)({
        mode: "file",
        paths: ["missing-again.txt"],
      }),
      (error: unknown) => (error as RuntimeFailure).code === "WORKSPACE_FILE_SHARE_PATH_INVALID",
    );
    assert.equal(
      await readFile(path.join(genuineStage, "replacement-sentinel"), "utf8"),
      "keep replacement",
    );
    await rm(displaced, { recursive: true, force: true });
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share reclaims a genuine expired stage after abnormal process exit", async () => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.workspaceRoot, "one.txt"), "one");
  try {
    const output = await workspaceFilesShareTool.createHandler(fixture.context)({
      mode: "file",
      paths: ["one.txt"],
    }) as ShareResult;
    const stagePath = await findSingleOwnedStage(fixture.tempRoot);
    const metadata = JSON.parse(
      await readFile(path.join(stagePath, "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    metadata.expiresAt = "2026-01-01T00:00:00.000Z";
    await writeFile(path.join(stagePath, "metadata.json"), JSON.stringify(metadata));
    await killRetainedShare(fixture, output.share.previewId);
    await access(stagePath);

    await assert.rejects(
      workspaceFilesShareTool.createHandler(fixture.context)({
        mode: "file",
        paths: ["missing.txt"],
      }),
      (error: unknown) => (error as RuntimeFailure).code === "WORKSPACE_FILE_SHARE_PATH_INVALID",
    );
    await assert.rejects(access(stagePath));
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share settles cancellation before staging and during file or ZIP writes", async () => {
  for (const mode of ["file", "zip"] as const) {
    const fixture = await createFixture();
    const controller = new AbortController();
    const context = { ...fixture.context, signal: controller.signal };
    await writeFile(path.join(fixture.workspaceRoot, "large.bin"), Buffer.alloc(1024 * 1024, 7));
    try {
      if (mode === "file") controller.abort();
      const invocation = () => workspaceFilesShareTool.createHandler(context)({
        mode,
        paths: ["large.bin"],
      });
      if (mode === "file") {
        await assertCancelled(invocation());
      } else {
        await assertCancelled(withFileHandleWriteOverride(async (original, handle, buffer, offset, length, position) => {
          const result = await original.call(handle, buffer, offset, length, position);
          if (length >= 1024 * 1024) controller.abort();
          return result;
        }, invocation));
      }
      assert.equal(fixture.publishCalls, 0);
      assert.equal((await readdir(fixture.tempRoot)).some((entry) => entry.startsWith("kestrel-file-share-")), false);
    } finally {
      await fixture.supervisor.close();
    }
  }

  const fixture = await createFixture();
  const controller = new AbortController();
  const context = { ...fixture.context, signal: controller.signal };
  await writeFile(path.join(fixture.workspaceRoot, "large.bin"), Buffer.alloc(1024 * 1024, 9));
  try {
    await assertCancelled(withFileHandleWriteOverride(async (original, handle, buffer, offset, length, position) => {
      const requested = length >= 1024 * 1024 ? Math.floor(length / 2) : length;
      const result = await original.call(handle, buffer, offset, requested, position);
      if (requested !== length) controller.abort();
      return result;
    }, () => workspaceFilesShareTool.createHandler(context)({
      mode: "file",
      paths: ["large.bin"],
    })));
    assert.equal(fixture.publishCalls, 0);
    assert.equal((await readdir(fixture.tempRoot)).some((entry) => entry.startsWith("kestrel-file-share-")), false);
  } finally {
    await fixture.supervisor.close();
  }
});

test("workspace.files.share compensates post-publication cancellation and preserves post-commit success", async () => {
  const cancelledFixture = await createFixture();
  const cancelledController = new AbortController();
  const cancelledContext = { ...cancelledFixture.context, signal: cancelledController.signal };
  await writeFile(path.join(cancelledFixture.workspaceRoot, "cancel.txt"), "cancel");
  try {
    await assertCancelled(withFileHandleWriteOverride(async (original, handle, buffer, offset, length, position) => {
      const result = await original.call(handle, buffer, offset, length, position);
      const written = Buffer.from(buffer.buffer, buffer.byteOffset + offset, length).toString("utf8");
      if (written.includes(`\"expiresAt\":\"${cancelledFixture.expiresAt}\"`)) {
        cancelledController.abort();
      }
      return result;
    }, () => workspaceFilesShareTool.createHandler(cancelledContext)({
      mode: "file",
      paths: ["cancel.txt"],
    })));
    assert.equal(cancelledFixture.publishCalls, 1);
    assert.equal(cancelledFixture.closed, true);
    const retention = await cancelledFixture.supervisor.inspectProcessRetention({
      leaseId: "workspace-preview:preview-file-share",
    });
    assert.equal(retention.status, "missing");
    assert.equal((await readdir(cancelledFixture.tempRoot)).some((entry) => entry.startsWith("kestrel-file-share-")), false);
  } finally {
    await cancelledFixture.supervisor.close();
  }

  const committedFixture = await createFixture();
  const committedController = new AbortController();
  const committedContext = { ...committedFixture.context, signal: committedController.signal };
  await writeFile(path.join(committedFixture.workspaceRoot, "committed.txt"), "committed");
  try {
    const output = await workspaceFilesShareTool.createHandler(committedContext)({
      mode: "file",
      paths: ["committed.txt"],
    }) as ShareResult;
    committedController.abort();
    assert.equal(Buffer.from(await (await fetch(
      `http://127.0.0.1:${committedFixture.publishedPort}/committed.txt`,
    )).arrayBuffer()).toString("utf8"), "committed");
    assert.equal(committedFixture.closed, false);
    await workspacePreviewCloseTool.createHandler({
      ...committedFixture.context,
      signal: undefined,
    })({ previewId: output.share.previewId });
  } finally {
    await committedFixture.supervisor.close();
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
          expiresAt: fixture.expiresAt,
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

type PositionalWrite = (
  this: FileHandle,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

async function withFileHandleWriteOverride<T>(
  override: (
    original: PositionalWrite,
    handle: FileHandle,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>,
  run: () => Promise<T>,
): Promise<T> {
  const probePath = path.join(os.tmpdir(), `kestrel-file-share-write-probe-${process.pid}`);
  const probe = await open(probePath, "w+");
  const prototype = Object.getPrototypeOf(probe) as { write: FileHandle["write"] };
  const original = prototype.write as PositionalWrite;
  prototype.write = (async function (
    this: FileHandle,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) {
    return override(original, this, buffer, offset, length, position);
  }) as FileHandle["write"];
  await probe.close();
  await rm(probePath, { force: true });
  try {
    return await run();
  } finally {
    prototype.write = original as FileHandle["write"];
  }
}

async function assertCancelled(invocation: Promise<unknown>): Promise<void> {
  await assert.rejects(invocation, (error: unknown) => {
    assert.equal((error as RuntimeFailure).code, "RUN_CANCELLED");
    return true;
  });
}

async function findSingleOwnedStage(tempRoot: string): Promise<string> {
  const candidates: string[] = [];
  for (const entry of await readdir(tempRoot)) {
    if (!entry.startsWith("kestrel-file-share-")) continue;
    const stagePath = path.join(tempRoot, entry);
    const metadata = await readFile(path.join(stagePath, "metadata.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>)
      .catch(() => undefined);
    if (
      metadata?.version === 2 &&
      typeof metadata.ownerId === "string" &&
      metadata.ownerId !== "forged"
    ) {
      candidates.push(stagePath);
    }
  }
  assert.equal(candidates.length, 1);
  return candidates[0]!;
}

async function killRetainedShare(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  previewId: string,
): Promise<void> {
  const retention = await fixture.supervisor.inspectProcessRetention({
    leaseId: `workspace-preview:${previewId}`,
  });
  assert.equal(retention.status, "active");
  assert.ok(retention.processId);
  await fixture.supervisor.stopProcess({
    processId: retention.processId,
    signal: "SIGKILL",
    waitMs: 2_000,
  });
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
