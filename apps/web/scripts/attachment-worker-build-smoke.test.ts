import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  assertFileRouteUsesExternalPackage,
  assertNoBundledAttachmentWorker,
  listFiles,
  resolveTracedAttachmentPackage,
} from "./attachment-worker-build-smoke.mjs";

const routeTraces = [
  "app/api/cron/attachments/cleanup/route.js.nft.json",
  "app/api/files/route.js.nft.json",
  "app/api/files/[fileId]/route.js.nft.json",
  "app/api/knowledge/documents/route.js.nft.json",
  "app/api/threads/[id]/attachments/route.js.nft.json",
];

test("production build externalizes and traces the attachment package", async () => {
  const [config, manifest, attachmentManifest] = await Promise.all([
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/attachments/package.json", import.meta.url), "utf8"),
  ]);
  assert.match(config, /serverExternalPackages:[\s\S]*"@kestrel-agents\/files"/u);
  assert.match(config, /webpackBuildWorker: true/u);
  assert.match(config, /"@kestrel-agents\/files": "commonjs @kestrel-agents\/files"/u);
  assert.match(config, /"\.\.\/\.\.\/packages\/attachments\/dist\/\*\*\/\*"/u);
  assert.match(config, /"\/api\/cron\/attachments\/\*\*"/u);
  assert.match(config, /"\/api\/files\/\*\*"/u);
  assert.match(config, /"\/api\/knowledge\/documents\/\*\*"/u);
  assert.match(manifest, /next build --webpack && pnpm run smoke:attachment-worker-build/u);
  assert.match(attachmentManifest, /"require": "\.\/dist\/index\.cjs"/u);
});

test("build smoke rejects an attachment worker bundled anywhere in server output", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "attachment-build-smoke-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const asset = join(root, ".next/server/assets/worker.fixture.js");
  await mkdir(dirname(asset), { recursive: true });
  await writeFile(asset, "throw new Error('Attachment processor worker requires a parent port.');");
  await assert.rejects(
    assertNoBundledAttachmentWorker(await listFiles(join(root, ".next/server"))),
    /bundled the attachment worker/u,
  );
});

test("build smoke rejects the attachment package bundled as a Next server chunk", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "attachment-build-chunk-smoke-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const chunk = join(root, ".next/server/chunks/3359.js");
  await mkdir(dirname(chunk), { recursive: true });
  await writeFile(chunk, "throw new Error('Attachment processor input exceeds the 100 MiB limit.');");
  await assert.rejects(
    assertNoBundledAttachmentWorker(await listFiles(join(root, ".next/server"))),
    /bundled the attachment package/u,
  );
});

test("build smoke requires the complete package boundary in every owning route trace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "attachment-route-trace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const serverRoot = join(root, ".next/server");
  for (const routeTrace of routeTraces) {
    const path = join(serverRoot, routeTrace);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      files: [
        resolve(root, "packages/attachments/package.json"),
        resolve(root, "packages/attachments/dist/index.cjs"),
        resolve(root, "packages/attachments/dist/index.js"),
        resolve(root, "packages/attachments/dist/worker.js"),
      ],
    }));
  }
  const files = await listFiles(serverRoot);
  assert.equal(
    await resolveTracedAttachmentPackage(files),
    resolve(root, "packages/attachments/dist/index.cjs"),
  );

  const brokenTrace = join(serverRoot, routeTraces[0] as string);
  await writeFile(brokenTrace, JSON.stringify({ files: [] }));
  await assert.rejects(resolveTracedAttachmentPackage(files), /is missing/u);
});

test("build smoke requires the compiled file route to load the external package", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "attachment-route-external-smoke-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const route = join(root, ".next/server/app/api/files/route.js");
  await mkdir(dirname(route), { recursive: true });
  await writeFile(route, 'module.exports = require("@kestrel-agents/files");');
  const files = await listFiles(join(root, ".next/server"));
  await assertFileRouteUsesExternalPackage(files);
  await writeFile(route, "module.exports = {};");
  await assert.rejects(
    assertFileRouteUsesExternalPackage(files),
    /does not use the external attachment package/u,
  );
});
