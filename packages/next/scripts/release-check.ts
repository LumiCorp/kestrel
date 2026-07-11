import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const sdkPackageDir = path.resolve(packageDir, "..", "sdk");
const protocolPackageDir = path.resolve(packageDir, "..", "protocol");
const packageJsonPath = path.join(packageDir, "package.json");

const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
assertNonEmptyString(manifest.license, "packages/next/package.json must declare license.");
assert.ok(
  typeof manifest.repository === "object" && manifest.repository !== null,
  "packages/next/package.json must declare repository metadata.",
);
assertNonEmptyString(manifest.homepage, "packages/next/package.json must declare homepage.");
assert.ok(
  typeof manifest.bugs === "object" && manifest.bugs !== null,
  "packages/next/package.json must declare bugs metadata.",
);

const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-next-pack-"));
const extractDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-next-extract-"));
const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-next-fixture-"));
const storeDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-next-store-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
    stdio: "pipe",
  });
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: sdkPackageDir,
    stdio: "pipe",
  });
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: protocolPackageDir,
    stdio: "pipe",
  });

  const tarballName = readdirSync(packDir).find((entry) => entry.startsWith("kestrel-agents-next-") && entry.endsWith(".tgz"));
  assert.ok(tarballName, "pnpm pack did not produce a next tarball.");
  const sdkTarballName = readdirSync(packDir).find((entry) => entry.startsWith("kestrel-agents-sdk-") && entry.endsWith(".tgz"));
  assert.ok(sdkTarballName, "pnpm pack did not produce an SDK tarball for next dependency checks.");
  const protocolTarballName = readdirSync(packDir).find((entry) => entry.startsWith("kestrel-agents-protocol-") && entry.endsWith(".tgz"));
  assert.ok(protocolTarballName, "pnpm pack did not produce a protocol tarball for next dependency checks.");

  const tarballPath = path.join(packDir, tarballName);
  const sdkTarballPath = path.join(packDir, sdkTarballName);
  const protocolTarballPath = path.join(packDir, protocolTarballName);
  const tarEntries = execFileSync("tar", ["-tf", tarballPath], {
    cwd: packageDir,
    encoding: "utf8",
  }).split("\n").filter((entry) => entry.length > 0);

  assert.ok(tarEntries.includes("package/README.md"), "packed next tarball is missing README.md.");
  assert.ok(tarEntries.includes("package/LICENSE"), "packed next tarball is missing LICENSE.");
  assert.ok(tarEntries.includes("package/dist/index.js"), "packed next tarball is missing dist/index.js.");

  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    cwd: packageDir,
    stdio: "pipe",
  });

  writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({
    name: "kestrel-next-release-check",
    private: true,
    type: "module",
    packageManager: "pnpm@9.12.2",
    pnpm: {
      overrides: {
        "@kestrel-agents/protocol": protocolTarballPath,
        "@kestrel-agents/sdk": sdkTarballPath,
      },
    },
  }, null, 2));
  writePnpmWorkspaceSettings(
    fixtureDir,
    {
      "@kestrel-agents/protocol": protocolTarballPath,
      "@kestrel-agents/sdk": sdkTarballPath,
    },
    { sharp: true },
  );

  execFileSync("pnpm", ["add", "--workspace-root", protocolTarballPath, sdkTarballPath, tarballPath], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      npm_config_store_dir: storeDir,
    },
    stdio: "pipe",
  });

  const entryModule = await import(pathToFileURL(path.join(fixtureDir, "node_modules", "@kestrel-agents", "next", "dist", "index.js")).href);
  assert.equal(typeof entryModule.createJsonRunRouteHandler, "function", "packed next package does not export createJsonRunRouteHandler.");
  assert.equal(typeof entryModule.createStreamRunRouteHandler, "function", "packed next package does not export createStreamRunRouteHandler.");
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
  allowBuilds: Record<string, boolean>,
): void {
  const fileOverrides = Object.fromEntries(
    Object.entries(overrides).map(([name, tarballPath]) => [name, `file:${tarballPath}`]),
  );
  writeFileSync(
    path.join(fixtureDir, "pnpm-workspace.yaml"),
    `${JSON.stringify({ packages: ["."], overrides: fileOverrides, allowBuilds }, null, 2)}\n`,
  );
}
