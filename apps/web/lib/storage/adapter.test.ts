import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { createLocalFilesystemStorageAdapter } from "./adapter";

test("streaming storage removes a partial object after upload failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-storage-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = createLocalFilesystemStorageAdapter({
    provider: "local",
    localRootDir: root,
    bucket: "test",
    region: "local",
    accessKeyId: "test",
    secretAccessKey: "test",
    forcePathStyle: true,
    keyPrefix: "backups",
  });
  const key = storage.buildObjectKey("workspace", "partial.kwb2");
  const body = Readable.from(
    (async function* streamThenFail() {
      yield Buffer.from("partial ciphertext");
      throw new Error("simulated export failure");
    })(),
  );

  await assert.rejects(
    storage.putObjectStream({ key, body }),
    /simulated export failure/u,
  );
  assert.equal(await storage.objectExists(key), false);
});

test("streaming storage settles abort before a partial object can remain", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-storage-abort-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = createLocalFilesystemStorageAdapter({
    provider: "local",
    localRootDir: root,
    bucket: "test",
    region: "local",
    accessKeyId: "test",
    secretAccessKey: "test",
    forcePathStyle: true,
    keyPrefix: "files",
  });
  const key = storage.buildObjectKey("browser", "receiving.bin");
  const body = new PassThrough();
  const controller = new AbortController();
  const upload = storage.putObjectStream({
    key,
    body,
    signal: controller.signal,
  });
  body.write(Buffer.from("partial Browser download"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error("transfer lease expired"));
  await assert.rejects(
    upload,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.match(String(controller.signal.reason), /transfer lease expired/u);
  assert.equal(await storage.objectExists(key), false);
});
