import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const protocolPackageDir = path.resolve(packageDir, "..", "protocol");
const packageJsonPath = path.join(packageDir, "package.json");

const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
assertNonEmptyString(manifest.license, "packages/sdk/package.json must declare license.");
assert.ok(
  typeof manifest.repository === "object" && manifest.repository !== null,
  "packages/sdk/package.json must declare repository metadata.",
);
assertNonEmptyString(manifest.homepage, "packages/sdk/package.json must declare homepage.");
assert.ok(
  typeof manifest.bugs === "object" && manifest.bugs !== null,
  "packages/sdk/package.json must declare bugs metadata.",
);
assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, "packages/sdk/package.json must declare keywords.");

const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-sdk-pack-"));
const extractDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-sdk-extract-"));
const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-sdk-fixture-"));
const storeDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-sdk-store-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: protocolPackageDir,
    stdio: "pipe",
  });
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
    stdio: "pipe",
  });

  const tarballName = readdirSync(packDir).find((entry) => entry.startsWith("kestrel-agents-sdk-") && entry.endsWith(".tgz"));
  assert.ok(tarballName, "pnpm pack did not produce an SDK tarball.");
  const protocolTarballName = readdirSync(packDir).find((entry) => entry.startsWith("kestrel-agents-protocol-") && entry.endsWith(".tgz"));
  assert.ok(protocolTarballName, "pnpm pack did not produce a protocol tarball for SDK dependency checks.");

  const tarballPath = path.join(packDir, tarballName);
  const protocolTarballPath = path.join(packDir, protocolTarballName);
  const tarEntries = execFileSync("tar", ["-tf", tarballPath], {
    cwd: packageDir,
    encoding: "utf8",
  }).split("\n").filter((entry) => entry.length > 0);

  assert.ok(tarEntries.includes("package/README.md"), "packed SDK tarball is missing README.md.");
  assert.ok(tarEntries.includes("package/LICENSE"), "packed SDK tarball is missing LICENSE.");
  assert.ok(tarEntries.includes("package/package.json"), "packed SDK tarball is missing package.json.");
  assert.ok(tarEntries.includes("package/dist/index.js"), "packed SDK tarball is missing dist/index.js.");
  assert.ok(tarEntries.includes("package/dist/index.d.ts"), "packed SDK tarball is missing dist/index.d.ts.");
  assert.ok(tarEntries.includes("package/dist/runner.js"), "packed SDK tarball is missing dist/runner.js.");
  assert.ok(tarEntries.includes("package/dist/runner.d.ts"), "packed SDK tarball is missing dist/runner.d.ts.");
  assert.ok(
    tarEntries.every((entry) => entry.includes("NativeRunnerClient") === false),
    "packed SDK tarball still includes removed NativeRunnerClient artifacts.",
  );

  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    cwd: packageDir,
    stdio: "pipe",
  });

  const packedManifest = JSON.parse(readFileSync(path.join(extractDir, "package", "package.json"), "utf8")) as Record<string, unknown>;
  assertNonEmptyString(packedManifest.license, "packed SDK manifest is missing license.");
  assertNonEmptyString(packedManifest.homepage, "packed SDK manifest is missing homepage.");
  assert.ok(
    typeof packedManifest.bugs === "object" && packedManifest.bugs !== null,
    "packed SDK manifest is missing bugs metadata.",
  );
  const packedDependencies = packedManifest.dependencies as Record<string, unknown> | undefined;
  assert.equal(
    packedDependencies?.["@kestrel-agents/protocol"],
    manifest.version,
    "packed SDK manifest must depend on the exact matching protocol version.",
  );

  writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({
    name: "kestrel-sdk-release-check",
    private: true,
    type: "module",
    packageManager: "pnpm@9.12.2",
    pnpm: {
      overrides: {
        "@kestrel-agents/protocol": protocolTarballPath,
      },
    },
  }, null, 2));
  writePnpmWorkspaceSettings(fixtureDir, {
    "@kestrel-agents/protocol": protocolTarballPath,
  });
  execFileSync("pnpm", ["add", "--workspace-root", protocolTarballPath, tarballPath], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      npm_config_store_dir: storeDir,
    },
    stdio: "pipe",
  });

  const installedPackageDir = path.join(fixtureDir, "node_modules", "@kestrel-agents", "sdk");
  const entryModule = await import(pathToFileURL(path.join(installedPackageDir, "dist", "index.js")).href);
  const runnerModule = await import(pathToFileURL(path.join(installedPackageDir, "dist", "runner.js")).href);
  assert.equal(typeof entryModule.createAgent, "function", "packed SDK root does not export createAgent.");
  assert.equal(typeof runnerModule.KestrelClient, "function", "packed SDK runner subpath does not export KestrelClient.");
  void entryModule.createAgent({ id: "release-check", profileId: "reference", baseUrl: "http://127.0.0.1:1" });
  void new runnerModule.KestrelClient({ baseUrl: "http://127.0.0.1:1" });

  console.log("sdk release-check passed");
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
}

function assertNonEmptyString(value: unknown, message: string): void {
  assert.ok(typeof value === "string" && value.trim().length > 0, message);
}

function writePnpmWorkspaceSettings(
  fixtureDir: string,
  overrides: Record<string, string>,
): void {
  const fileOverrides = Object.fromEntries(
    Object.entries(overrides).map(([name, tarballPath]) => [name, `file:${tarballPath}`]),
  );
  writeFileSync(
    path.join(fixtureDir, "pnpm-workspace.yaml"),
    `${JSON.stringify({ packages: ["."], overrides: fileOverrides }, null, 2)}\n`,
  );
}
