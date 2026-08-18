import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conversationPackageDir = path.resolve(packageDir, "..", "conversation");
const protocolPackageDir = path.resolve(packageDir, "..", "protocol");
const sdkPackageDir = path.resolve(packageDir, "..", "sdk");
const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-ai-sdk-pack-"));
const extractDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-ai-sdk-extract-"));
const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-ai-sdk-fixture-"));
const storeDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-ai-sdk-store-"));

try {
  for (const dependencyPackageDir of [
    conversationPackageDir,
    protocolPackageDir,
    sdkPackageDir,
    packageDir,
  ]) {
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: dependencyPackageDir,
      stdio: "pipe",
    });
  }
  const tarballName = readdirSync(packDir).find(
    (entry) => entry.startsWith("kestrel-agents-ai-sdk-") && entry.endsWith(".tgz"),
  );
  assert.ok(tarballName, "pnpm pack did not produce an AI SDK tarball.");
  const conversationTarballName = readdirSync(packDir).find(
    (entry) => entry.startsWith("kestrel-agents-conversation-") && entry.endsWith(".tgz"),
  );
  assert.ok(conversationTarballName, "pnpm pack did not produce a Conversation tarball.");
  const protocolTarballName = readdirSync(packDir).find(
    (entry) => entry.startsWith("kestrel-agents-protocol-") && entry.endsWith(".tgz"),
  );
  assert.ok(protocolTarballName, "pnpm pack did not produce a Protocol tarball.");
  const sdkTarballName = readdirSync(packDir).find(
    (entry) => entry.startsWith("kestrel-agents-sdk-") && entry.endsWith(".tgz"),
  );
  assert.ok(sdkTarballName, "pnpm pack did not produce an SDK tarball.");
  const tarballPath = path.join(packDir, tarballName);
  const conversationTarballPath = path.join(packDir, conversationTarballName);
  const protocolTarballPath = path.join(packDir, protocolTarballName);
  const sdkTarballPath = path.join(packDir, sdkTarballName);
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
    packedManifest.dependencies?.["@kestrel-agents/conversation"],
    packedManifest.version,
    "packed AI SDK must depend on the exact matching Conversation version",
  );
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

  const overrides = {
    "@kestrel-agents/conversation": conversationTarballPath,
    "@kestrel-agents/protocol": protocolTarballPath,
    "@kestrel-agents/sdk": sdkTarballPath,
  };
  writeFileSync(path.join(fixtureDir, "package.json"), `${JSON.stringify({
    name: "kestrel-ai-sdk-release-check",
    private: true,
    type: "module",
    packageManager: "pnpm@9.12.2",
    pnpm: { overrides },
  }, null, 2)}\n`);
  writeFileSync(
    path.join(fixtureDir, "pnpm-workspace.yaml"),
    `${JSON.stringify({
      packages: ["."],
      overrides: Object.fromEntries(
        Object.entries(overrides).map(([name, tarballPath]) => [name, `file:${tarballPath}`]),
      ),
    }, null, 2)}\n`,
  );
  execFileSync("pnpm", [
    "add",
    "--workspace-root",
    conversationTarballPath,
    protocolTarballPath,
    sdkTarballPath,
    tarballPath,
  ], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      npm_config_store_dir: storeDir,
    },
    stdio: "pipe",
  });

  const entryModule = await import(pathToFileURL(path.join(
    fixtureDir,
    "node_modules",
    "@kestrel-agents",
    "ai-sdk",
    "dist",
    "index.js",
  )).href);
  assert.equal(typeof entryModule.createKestrelPresentationAccumulator, "function");
  assert.equal(typeof entryModule.writeKestrelRunnerStreamToUIMessage, "function");
  console.log("AI SDK release-check passed");
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
}
