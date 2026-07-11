import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const manifest = JSON.parse(
  readFileSync(path.join(packageDir, "package.json"), "utf8"),
) as Record<string, unknown>;

assertNonEmptyString(manifest.license, "packages/protocol/package.json must declare license.");
assert.ok(
  typeof manifest.repository === "object" && manifest.repository !== null,
  "packages/protocol/package.json must declare repository metadata.",
);
assertNonEmptyString(manifest.homepage, "packages/protocol/package.json must declare homepage.");
assert.ok(
  typeof manifest.bugs === "object" && manifest.bugs !== null,
  "packages/protocol/package.json must declare bugs metadata.",
);

const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-protocol-pack-"));
const extractDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-protocol-extract-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
    stdio: "pipe",
  });

  const tarballName = readdirSync(packDir).find(
    (entry) => entry.startsWith("kestrel-agents-protocol-") && entry.endsWith(".tgz"),
  );
  assert.ok(tarballName, "pnpm pack did not produce a protocol tarball.");

  const tarballPath = path.join(packDir, tarballName);
  const tarEntries = execFileSync("tar", ["-tf", tarballPath], {
    cwd: packageDir,
    encoding: "utf8",
  })
    .split("\n")
    .filter((entry) => entry.length > 0);

  for (const required of [
    "package/README.md",
    "package/LICENSE",
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ]) {
    assert.ok(tarEntries.includes(required), `packed protocol tarball is missing ${required}.`);
  }

  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    cwd: packageDir,
    stdio: "pipe",
  });

  const entryModule = await import(
    pathToFileURL(path.join(extractDir, "package", "dist", "index.js")).href
  );
  assert.equal(typeof entryModule.createRunnerHealthV1, "function");
  assert.equal(typeof entryModule.parseRunnerHealthV1, "function");
  assert.ok(Array.isArray(entryModule.RUNNER_RUN_STREAM_EVENT_TYPES));

  console.log("protocol release-check passed");
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
}

function assertNonEmptyString(value: unknown, message: string): void {
  assert.ok(typeof value === "string" && value.trim().length > 0, message);
}
