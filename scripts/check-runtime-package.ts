import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface NpmPackFile {
  path: string;
}

interface NpmPackResult {
  files: NpmPackFile[];
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const npmCacheDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-runtime-pack-cache-"));
const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-runtime-pack-"));
const extractDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-runtime-extract-"));
const consumerDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-runtime-consumer-"));

const externalRuntimeWorkspacePackages = [
  { directory: "packages/conversation", tarballPrefix: "kestrel-agents-conversation-" },
  { directory: "packages/protocol", tarballPrefix: "kestrel-agents-protocol-" },
  { directory: "packages/sdk", tarballPrefix: "kestrel-agents-sdk-" },
  { directory: "packages/workspace-skills", tarballPrefix: "kestrel-agents-workspace-skills-" },
] as const;

const forbiddenPrefixes = [
  "apps/",
  "tests/",
  "docs/",
  ".github/",
  "benchmarks/",
  "coding-agent-review/",
] as const;

const bundledDependencyPrefixes = [
  "node_modules/@kestrel-agents/memory/",
  "node_modules/@lumi/kestrel-environment-auth/",
] as const;

const allowedWorkspacePackagePrefixes = [
  "packages/protocol/",
  "packages/workspace-skills/",
  "packages/memory/",
  "packages/environment-auth/",
  "packages/mcp-security/",
] as const;

const requiredFiles = [
  "package.json",
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "dist/packages/mcp-security/src/index.js",
  "dist/packages/mcp-security/src/index.d.ts",
  "bin/kestrel.js",
  "bin/kcron.js",
  "cli/tui.ts",
  "src/index.ts",
  "agents/reference-react/src/index.ts",
  "tools/index.ts",
  "db/migrations/001_sessions_runs.sql",
  "db/migrations/023_runner_protocol_events.sql",
  "db/migrations/024_provider_reasoning_state.sql",
  "packages/protocol/package.json",
  "packages/protocol/dist/index.js",
  "packages/workspace-skills/package.json",
  "packages/workspace-skills/dist/index.js",
  "packages/memory/package.json",
  "packages/memory/dist/index.js",
  "packages/environment-auth/package.json",
  "packages/environment-auth/dist/index.js",
  "packages/mcp-security/package.json",
  "packages/mcp-security/src/index.ts",
  "packages/mcp-security/dist/index.js",
  "cli/runner/RunnerServiceEventJournal.ts",
  "cli/runner/RunnerServiceHost.ts",
  "src/localCore/credentialStore.ts",
  "src/localCore/executionRuntime.ts",
  "src/localCore/macosKeychainCredentialStore.ts",
  "src/localCore/protocolEventJournal.ts",
  "src/localCore/runtimeEnvironment.ts",
  "src/localCore/store.ts",
  "scripts/start.ts",
  "scripts/migrate.ts",
  "scripts/kchat-smoke.ts",
  "README.md",
  "LICENSE",
] as const;

try {
  const output = execFileSync(
    resolveNpmCommand(),
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: npmCacheDir,
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const results = JSON.parse(output) as NpmPackResult[];
  assert.equal(results.length, 1, "npm pack must describe exactly one runtime package.");

  const filePaths = new Set(results[0]?.files.map((file) => file.path) ?? []);
  assert.ok(filePaths.size > 0, "npm pack returned an empty runtime package.");

  for (const filePath of filePaths) {
    if (filePath.startsWith("node_modules/")) {
      assert.ok(
        bundledDependencyPrefixes.some((prefix) => filePath.startsWith(prefix)),
        `runtime package contains unexpected bundled dependency '${filePath}'`,
      );
      continue;
    }
    if (filePath.startsWith("packages/")) {
      assert.ok(
        allowedWorkspacePackagePrefixes.some((prefix) => filePath.startsWith(prefix)),
        `runtime package contains unexpected workspace package '${filePath}'`,
      );
    }
    const forbiddenPrefix = forbiddenPrefixes.find((prefix) => filePath.startsWith(prefix));
    assert.equal(
      forbiddenPrefix,
      undefined,
      `runtime package contains forbidden path '${filePath}'`,
    );
    assert.ok(
      isSensitiveOrTestPath(filePath) === false,
      `runtime package contains unsafe path '${filePath}'`,
    );
  }

  for (const requiredFile of requiredFiles) {
    assert.ok(filePaths.has(requiredFile), `runtime package is missing '${requiredFile}'`);
  }
  assert.ok(
    filePaths.has("node_modules/@lumi/kestrel-environment-auth/dist/index.js"),
    "runtime package is missing the bundled environment-auth runtime",
  );
  assert.ok(
    filePaths.has("node_modules/@lumi/kestrel-environment-auth/package.json"),
    "runtime package is missing the bundled environment-auth manifest",
  );

  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    main?: string;
    name?: string;
    optionalDependencies?: Record<string, string>;
    types?: string;
    bundledDependencies?: string[];
  };
  assert.equal(manifest.name, "@kestrel-agents/kestrel");
  assert.equal(manifest.main, "dist/src/index.js");
  assert.equal(manifest.types, "dist/src/index.d.ts");
  assert.equal(manifest.dependencies?.["@kestrel-agents/protocol"], "workspace:*");
  assert.equal(manifest.dependencies?.["@kestrel-agents/workspace-skills"], "workspace:*");
  assert.equal(
    manifest.optionalDependencies?.fsevents,
    "2.3.3",
    "runtime package must declare fsevents directly optional for npm global installs",
  );
  assert.ok(
    filePaths.has("node_modules/@kestrel-agents/memory/dist/index.js"),
    "runtime package is missing the bundled memory runtime",
  );
  assert.ok(
    filePaths.has("node_modules/@kestrel-agents/memory/package.json"),
    "runtime package is missing the bundled memory manifest",
  );
  assert.deepEqual(manifest.bundledDependencies, [
    "@kestrel-agents/memory",
    "@lumi/kestrel-environment-auth",
  ]);
  assert.ok(filePaths.has(manifest.main), `runtime package main '${manifest.main}' is not packed`);
  assert.ok(filePaths.has(manifest.types), `runtime package types '${manifest.types}' are not packed`);

  execFileSync("pnpm", ["pack", "--config.node-linker=hoisted", "--pack-destination", packDir], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  const tarballName = readdirSync(packDir).find(
    (entry) => entry.startsWith("kestrel-agents-kestrel-") && entry.endsWith(".tgz"),
  );
  assert.ok(tarballName, "pnpm pack did not produce a runtime tarball.");
  const tarballPath = path.join(packDir, tarballName);
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  const packedFiles = listFilesRecursively(path.join(extractDir, "package"));
  const packedFileSet = new Set(packedFiles);
  for (const requiredPackedFile of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "packages/protocol/package.json",
    "packages/protocol/dist/index.js",
    "packages/workspace-skills/package.json",
    "packages/workspace-skills/dist/index.js",
    "packages/memory/package.json",
    "packages/memory/dist/index.js",
    "packages/environment-auth/package.json",
    "packages/environment-auth/dist/index.js",
    "scripts/kchat-smoke.ts",
  ]) {
    assert.ok(
      packedFileSet.has(requiredPackedFile),
      `pnpm-packed runtime is missing Local Core build input '${requiredPackedFile}'`,
    );
  }
  const packedWorkspaceFiles = packedFiles.filter(
    (filePath) => filePath.startsWith("packages/"),
  );
  for (const packedFilePath of packedWorkspaceFiles) {
    assert.ok(
      allowedWorkspacePackagePrefixes.some((prefix) => packedFilePath.startsWith(prefix)),
      `pnpm-packed runtime contains unexpected workspace package '${packedFilePath}'`,
    );
    assert.equal(
      isSensitiveOrTestPath(packedFilePath),
      false,
      `pnpm-packed runtime contains unsafe path '${packedFilePath}'`,
    );
  }
  const packedManifest = JSON.parse(
    readFileSync(path.join(extractDir, "package", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string>; version?: string };
  assert.equal(
    packedManifest.dependencies?.["@kestrel-agents/conversation"],
    packedManifest.version,
    "packed runtime must depend on the exact matching Conversation version",
  );
  assert.equal(
    packedManifest.dependencies?.["@kestrel-agents/protocol"],
    packedManifest.version,
    "packed runtime must depend on the exact matching protocol version",
  );
  assert.equal(
    packedManifest.dependencies?.["@kestrel-agents/sdk"],
    packedManifest.version,
    "packed runtime must depend on the exact matching SDK version",
  );
  assert.equal(
    packedManifest.dependencies?.["@kestrel-agents/workspace-skills"],
    packedManifest.version,
    "packed runtime must depend on the exact matching workspace-skills version",
  );
  assert.equal(
    packedManifest.dependencies?.["@kestrel-agents/memory"],
    packedManifest.version,
    "packed runtime must depend on the exact matching memory version",
  );
  for (const bundledManifestPath of [
    "node_modules/@kestrel-agents/memory/package.json",
    "node_modules/@lumi/kestrel-environment-auth/package.json",
  ]) {
    const bundledManifest = JSON.parse(
      readFileSync(path.join(extractDir, "package", bundledManifestPath), "utf8"),
    ) as { name?: string; version?: string };
    assert.equal(
      bundledManifest.version,
      packedManifest.version,
      `bundled ${bundledManifest.name ?? bundledManifestPath} manifest must match the runtime version`,
    );
  }

  const localDependencyTarballs = externalRuntimeWorkspacePackages.map((workspacePackage) =>
    packWorkspacePackage(workspacePackage),
  );
  execFileSync(
    resolveNpmCommand(),
    [
      "install",
      "--global",
      "--prefix",
      consumerDir,
      "--no-audit",
      "--no-fund",
      ...localDependencyTarballs,
      tarballPath,
    ],
    {
      cwd: consumerDir,
      stdio: "pipe",
      env: {
        ...process.env,
        npm_config_cache: npmCacheDir,
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const cliCommand = path.join(
    consumerDir,
    "bin",
    process.platform === "win32" ? "kestrel.cmd" : "kestrel",
  );
  const runtimePackageRoot = path.join(
    consumerDir,
    process.platform === "win32" ? "node_modules" : "lib/node_modules",
    "@kestrel-agents",
    "kestrel",
  );
  const cliEnv = {
    ...process.env,
    KESTREL_HOME: path.join(consumerDir, ".kestrel"),
    KESTREL_CORE_HOME: path.join(consumerDir, ".kestrel"),
    KESTREL_CORE_IDLE_TIMEOUT_MS: "500",
    KESTREL_DISABLE_DOTENV: "1",
    DATABASE_URL: "",
    FORCE_COLOR: "0",
  };
  const cliVersion = execFileSync(cliCommand, ["--version"], {
    cwd: consumerDir,
    encoding: "utf8",
    env: cliEnv,
  });
  assert.equal(
    cliVersion.trim(),
    `kestrel ${packedManifest.version ?? "unknown"}`,
    "clean-installed runtime CLI must report the packed version",
  );
  const coreStatus = execFileSync(cliCommand, ["core", "status"], {
    cwd: consumerDir,
    encoding: "utf8",
    env: cliEnv,
  });
  assert.match(
    coreStatus,
    /Expected build: sha256:[a-f0-9]{64}/u,
    "clean-installed runtime CLI must resolve its Local Core build identity",
  );
  const importSmoke = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify([
        "@kestrel-agents/kestrel",
        "@kestrel-agents/conversation",
        "@kestrel-agents/protocol",
        "@kestrel-agents/sdk",
        "@kestrel-agents/workspace-skills",
        "@kestrel-agents/memory",
      ])}.map((name) => import(name))); console.log("runtime imports: ok");`,
    ],
    {
      cwd: runtimePackageRoot,
      encoding: "utf8",
      env: cliEnv,
    },
  );
  assert.match(importSmoke, /runtime imports: ok/u);
  const protocolSmoke = execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(runtimePackageRoot, "scripts", "kchat-smoke.ts")],
    {
      cwd: runtimePackageRoot,
      encoding: "utf8",
      env: cliEnv,
      timeout: 30_000,
    },
  );
  assert.match(
    protocolSmoke,
    /kchat smoke: protocol ok/u,
    "clean-installed runtime CLI must start Local Core and round-trip protocol commands",
  );

  console.log(`runtime release-check passed (${filePaths.size} files)`);
} finally {
  rmSync(npmCacheDir, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(consumerDir, { recursive: true, force: true });
}

function isSensitiveOrTestPath(filePath: string): boolean {
  const normalized = `/${filePath.toLowerCase()}`;
  return (
    /\/(?:__tests__|tests?)(?:\/|$)/u.test(normalized) ||
    /\.(?:test|spec)\.[^/]+$/u.test(normalized) ||
    /\/(?:\.env(?:\.[^/]*)?|\.auth)(?:\/|$)/u.test(normalized) ||
    /\/(?:secrets?|credentials?)(?:\/|$)/u.test(normalized) ||
    /\/(?:storage-state|auth-state)(?:\.[^/]*)?$/u.test(normalized) ||
    /\/(?:\.vitest|coverage|playwright-report)(?:\/|$)/u.test(normalized) ||
    /\/__pycache__(?:\/|$)/u.test(normalized) ||
    /\.pyc$/u.test(normalized)
  );
}

function listFilesRecursively(rootPath: string, relativePath = ""): string[] {
  const directoryPath = path.join(rootPath, relativePath);
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(relativePath, entry.name);
    return entry.isDirectory() ? listFilesRecursively(rootPath, entryPath) : [entryPath];
  });
}

function resolveNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function packWorkspacePackage(
  workspacePackage: (typeof externalRuntimeWorkspacePackages)[number],
): string {
  const before = new Set(readdirSync(packDir));
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: path.join(repoRoot, workspacePackage.directory),
    stdio: "pipe",
  });
  const tarballs = readdirSync(packDir).filter(
    (entry) =>
      before.has(entry) === false &&
      entry.startsWith(workspacePackage.tarballPrefix) &&
      entry.endsWith(".tgz"),
  );
  assert.equal(
    tarballs.length,
    1,
    `expected one packed dependency from ${workspacePackage.directory}`,
  );
  return path.join(packDir, tarballs[0]!);
}
