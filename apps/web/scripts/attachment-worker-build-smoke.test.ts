import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
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
  const [config, manifest] = await Promise.all([
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(config, /serverExternalPackages:[\s\S]*"@kestrel-agents\/files"/u);
  assert.match(config, /"\.\.\/\.\.\/packages\/attachments\/dist\/\*\*\/\*"/u);
  assert.match(config, /"\/api\/cron\/attachments\/\*\*"/u);
  assert.match(config, /"\/api\/files\/\*\*"/u);
  assert.match(config, /"\/api\/knowledge\/documents\/\*\*"/u);
  assert.match(manifest, /next build --webpack && pnpm run smoke:attachment-worker-build/u);
});

test("build smoke rejects a raw attachment worker server asset", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "attachment-build-smoke-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const asset = join(root, ".next/server/assets/worker.fixture.js");
  await mkdir(dirname(asset), { recursive: true });
  await writeFile(asset, "throw new Error('Attachment processor worker requires a parent port.');");
  await assert.rejects(
    assertNoBundledAttachmentWorker(await listFiles(join(root, ".next/server"))),
    /raw server asset/u,
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
        resolve(root, "packages/attachments/dist/index.js"),
        resolve(root, "packages/attachments/dist/worker.js"),
      ],
    }));
  }
  const files = await listFiles(serverRoot);
  assert.equal(
    await resolveTracedAttachmentPackage(files),
    resolve(root, "packages/attachments/dist/index.js"),
  );

  const brokenTrace = join(serverRoot, routeTraces[0] as string);
  await writeFile(brokenTrace, JSON.stringify({ files: [] }));
  await assert.rejects(resolveTracedAttachmentPackage(files), /is missing/u);
});
