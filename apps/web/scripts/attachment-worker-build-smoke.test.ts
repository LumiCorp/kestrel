import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  assertFileRouteUsesExternalPackage,
  assertNoBundledAttachmentWorker,
  assertRuntimeSymlinksContained,
  listFiles,
  resolveTracedAttachmentPackage,
} from "./attachment-worker-build-smoke.mjs";

const routeTraces = [
  "app/api/cron/attachments/cleanup/route.js.nft.json",
  "app/api/files/route.js.nft.json",
  "app/api/files/[fileId]/route.js.nft.json",
  "app/api/knowledge/documents/route.js.nft.json",
  "app/api/threads/[id]/attachments/[attachmentId]/route.js.nft.json",
];

const runtimeFiles = [
  "packages/attachments/package.json",
  "packages/attachments/dist/index.cjs",
  "packages/attachments/dist/index.js",
  "packages/attachments/dist/worker.js",
  "packages/attachments/node_modules/pdf-parse/package.json",
  "packages/attachments/node_modules/pdfjs-dist/package.json",
  "apps/web/node_modules/pdfjs-dist/package.json",
  "node_modules/pdf-parse/package.json",
  "node_modules/pdf-parse/dist/worker/cjs/index.cjs",
  "node_modules/pdf-parse/dist/worker/pdf.worker.mjs",
  "node_modules/pdfjs-dist/package.json",
  "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  "node_modules/pdfjs-dist/cmaps/Adobe-GB1-UCS2.bcmap",
  "node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf",
  "node_modules/pdfjs-dist/wasm/openjpeg.wasm",
  "node_modules/@napi-rs/canvas/package.json",
  "node_modules/@napi-rs/canvas/js-binding.js",
  "node_modules/@napi-rs/canvas-linux-x64-gnu/package.json",
  "node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node",
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
  assert.match(config, /pdfjs-dist@\*\/node_modules\/pdfjs-dist\/cmaps\/\*\*\/\*/u);
  assert.match(config, /pdfjs-dist@\*\/node_modules\/pdfjs-dist\/standard_fonts\/\*\*\/\*/u);
  assert.match(config, /pdfjs-dist@\*\/node_modules\/pdfjs-dist\/wasm\/\*\*\/\*/u);
  assert.match(config, /"pdf-parse"/u);
  assert.match(config, /"pdfjs-dist"/u);
  assert.match(config, /"@napi-rs\/canvas"/u);
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
      files: runtimeFiles.map((file) => resolve(root, file)),
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

test("build smoke rejects runtime symlinks that escape the isolated tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "attachment-symlink-smoke-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink("../../outside-runtime", join(root, "node_modules/escape"));
  await assert.rejects(assertRuntimeSymlinksContained(root), /escapes the isolated tree/u);
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
