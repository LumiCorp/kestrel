import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DesktopAttachmentStore,
  DESKTOP_DRAFT_ATTACHMENT_RETENTION_MS,
} from "../../src/localCore/desktopAttachments.js";
import { resolveLocalCorePaths } from "../../src/localCore/home.js";

async function withStore(run: (store: DesktopAttachmentStore, home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-attachments-"));
  await run(new DesktopAttachmentStore(home), home);
}

test("Desktop attachment store validates, deduplicates, and resolves opaque thread-scoped attachments", async () => {
  await withStore(async (store, home) => {
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("image")]);
    const first = await store.import({ threadId: "thread-1", filename: "/private/example.png", mimeType: "image/png", data: png });
    const duplicate = await store.import({ threadId: "thread-1", filename: "copy.png", mimeType: "image/png", data: png });
    const text = await store.import({ threadId: "thread-1", filename: "main.ts", mimeType: "text/plain", data: Buffer.from("export const ok = true;\n") });

    assert.equal(first.filename, "example.png");
    assert.equal(first.sha256, duplicate.sha256);
    const blobDirectory = path.join(resolveLocalCorePaths(home).stateRootPath, "attachments", "blobs");
    assert.equal((await readdir(blobDirectory)).length, 2);

    const resolved = await store.resolve("thread-1", [first.attachmentId, text.attachmentId]);
    assert.equal(resolved[0]?.data, png.toString("base64"));
    assert.equal(resolved[1]?.text, "export const ok = true;\n");
    assert.equal(JSON.stringify(await store.list("thread-1")).includes(home), false);
    await assert.rejects(store.resolve("thread-2", [first.attachmentId]), /unavailable for this thread/u);
  });
});

test("Desktop attachment store rejects unsupported, malformed, mismatched, and oversized content", async () => {
  await withStore(async (store) => {
    await assert.rejects(store.import({ threadId: "thread-1", filename: "archive.zip", data: Buffer.from("PK") }), /unsupported/u);
    await assert.rejects(store.import({ threadId: "thread-1", filename: "bad.txt", data: Buffer.from([0xff]) }), /valid UTF-8/u);
    await assert.rejects(store.import({ threadId: "thread-1", filename: "nul.txt", data: Buffer.from("a\0b") }), /NUL/u);
    await assert.rejects(store.import({ threadId: "thread-1", filename: "bad.png", mimeType: "image/jpeg", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }), /MIME type/u);
    await assert.rejects(store.import({ threadId: "thread-1", filename: "hash.txt", data: Buffer.from("hello"), sha256: "0".repeat(64) }), /hash/u);
    await assert.rejects(store.import({ threadId: "thread-1", filename: "large.txt", data: Buffer.alloc(2 * 1024 * 1024 + 1, 97) }), /2 MiB/u);
  });
});

test("Desktop attachment store accepts each bounded image format by content signature", async () => {
  await withStore(async (store) => {
    const images = [
      ["image.png", "image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
      ["image.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xdb])],
      ["image.gif", "image/gif", Buffer.from("GIF89a")],
      ["image.webp", "image/webp", Buffer.from("RIFF0000WEBP")],
    ] as const;
    for (const [filename, mimeType, data] of images) {
      const attachment = await store.import({ threadId: "thread-1", filename, mimeType, data });
      assert.equal(attachment.mimeType, mimeType);
      assert.equal(attachment.kind, "image");
    }
  });
});

test("Desktop attachment store enforces the aggregate message limit", async () => {
  await withStore(async (store) => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const data = Buffer.alloc(7 * 1024 * 1024, index + 1);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
      ids.push((await store.import({ threadId: "thread-1", filename: `${index}.png`, mimeType: "image/png", data })).attachmentId);
    }
    await assert.rejects(store.resolve("thread-1", ids), /total size limit/u);
  });
});

test("Desktop attachment cleanup removes only expired unsubmitted references", async () => {
  await withStore(async (store) => {
    const old = new Date(Date.now() - DESKTOP_DRAFT_ATTACHMENT_RETENTION_MS - 1_000);
    const expired = await store.import({ threadId: "thread-1", filename: "expired.txt", data: Buffer.from("expired"), now: old });
    const retained = await store.import({ threadId: "thread-1", filename: "retained.txt", data: Buffer.from("retained"), now: old });
    await store.resolve("thread-1", [retained.attachmentId]);

    assert.equal(await store.cleanup(), 1);
    assert.deepEqual((await store.list("thread-1")).map((entry) => entry.attachmentId), [retained.attachmentId]);
    assert.equal(await store.remove("thread-1", expired.attachmentId), false);
    await assert.rejects(store.remove("thread-1", retained.attachmentId), /Submitted attachments/u);
  });
});
