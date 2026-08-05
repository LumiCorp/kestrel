import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-ai-sdk-pack-"));
const extractDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-ai-sdk-extract-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
    stdio: "pipe",
  });
  const tarballName = readdirSync(packDir).find(
    (entry) => entry.startsWith("kestrel-agents-ai-sdk-") && entry.endsWith(".tgz"),
  );
  assert.ok(tarballName, "pnpm pack did not produce an AI SDK tarball.");
  const tarballPath = path.join(packDir, tarballName);
  const tarEntries = execFileSync("tar", ["-tf", tarballPath], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  for (const required of [
    "package/README.md",
    "package/LICENSE",
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ]) {
    assert.ok(tarEntries.includes(required), `packed AI SDK tarball is missing ${required}.`);
  }

  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], { stdio: "pipe" });
  const packedManifest = JSON.parse(
    readFileSync(path.join(extractDir, "package", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string>; version?: string };
  assert.match(packedManifest.version ?? "", /^\d+\.\d+\.\d+$/u);
  assert.equal(
    packedManifest.dependencies?.["@kestrel-agents/protocol"],
    packedManifest.version,
    "packed AI SDK must depend on the exact matching protocol version",
  );
  assert.equal(
    packedManifest.dependencies?.["@kestrel-agents/sdk"],
    packedManifest.version,
    "packed AI SDK must depend on the exact matching SDK version",
  );

  const entryModule = await import(
    pathToFileURL(path.join(extractDir, "package", "dist", "index.js")).href,
  );
  assert.equal(typeof entryModule.createKestrelPresentationAccumulator, "function");
  assert.equal(typeof entryModule.writeKestrelRunnerStreamToUIMessage, "function");
  console.log("AI SDK release-check passed");
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
}
