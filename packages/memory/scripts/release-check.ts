import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(path.join(packageDir, "package.json"), "utf8"),
) as Record<string, unknown>;

assert.equal(manifest.private, undefined, "memory package must be publishable.");
assert.equal(
  (manifest.publishConfig as Record<string, unknown> | undefined)?.access,
  "public",
  "memory package must publish with public access.",
);
assertNonEmptyString(manifest.homepage, "memory package must declare homepage metadata.");
assert.ok(typeof manifest.bugs === "object" && manifest.bugs !== null, "memory package must declare bugs metadata.");
assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, "memory package must declare keywords.");

const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-memory-pack-"));
const extractDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-memory-extract-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
    stdio: "pipe",
  });
  const tarballName = readdirSync(packDir).find(
    (entry) => entry.startsWith("kestrel-agents-memory-") && entry.endsWith(".tgz"),
  );
  assert.ok(tarballName, "pnpm pack did not produce a memory tarball.");
  const tarballPath = path.join(packDir, tarballName);
  const tarEntries = execFileSync("tar", ["-tf", tarballPath], {
    cwd: packageDir,
    encoding: "utf8",
  }).split("\n").filter((entry) => entry.length > 0);

  for (const required of [
    "package/README.md",
    "package/LICENSE",
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ]) {
    assert.ok(tarEntries.includes(required), `packed memory tarball is missing ${required}.`);
  }

  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    cwd: packageDir,
    stdio: "pipe",
  });
  const packedManifest = JSON.parse(
    readFileSync(path.join(extractDir, "package", "package.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(packedManifest.private, undefined, "packed memory package must not be private.");

  const entryModule = await import(
    pathToFileURL(path.join(extractDir, "package", "dist", "index.js")).href,
  );
  assert.equal(typeof entryModule.MemoryGateway, "function");
  assert.equal(typeof entryModule.InMemoryMemoryBackend, "function");
  assert.equal(typeof entryModule.parseMemoryQueryV1, "function");
  assert.equal(entryModule.MEMORY_QUERY_VERSION, "memory_query_v1");

  console.log("memory release-check passed");
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
}

function assertNonEmptyString(value: unknown, message: string): void {
  assert.ok(typeof value === "string" && value.trim().length > 0, message);
}
