import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const npmCacheDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-runtime-pack-cache-"));
const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-runtime-pack-"));
const extractDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-runtime-extract-"));
const consumerDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-runtime-consumer-"));

const externalRuntimeWorkspacePackages = [
  { directory: "packages/attachments", tarballPrefix: "kestrel-agents-files-" },
  { directory: "packages/conversation", tarballPrefix: "kestrel-agents-conversation-" },
  { directory: "packages/protocol", tarballPrefix: "kestrel-agents-protocol-" },
  { directory: "packages/sdk", tarballPrefix: "kestrel-agents-sdk-" },
  { directory: "packages/workspace-skills", tarballPrefix: "kestrel-agents-workspace-skills-" },
] as const;

const exactRuntimeWorkspaceDependencies = [
  { name: "@kestrel-agents/conversation", directory: "packages/conversation" },
  { name: "@kestrel-agents/files", directory: "packages/attachments" },
  { name: "@kestrel-agents/protocol", directory: "packages/protocol" },
  { name: "@kestrel-agents/sdk", directory: "packages/sdk" },
  { name: "@kestrel-agents/workspace-skills", directory: "packages/workspace-skills" },
  { name: "@kestrel-agents/memory", directory: "packages/memory" },
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
  "packages/attachments/",
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
  "packages/attachments/package.json",
  "packages/attachments/dist/index.js",
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
  const filePaths = new Set(packedFiles);
  assert.ok(filePaths.size > 0, "pnpm pack produced an empty runtime package.");

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

  const packedFileSet = new Set(packedFiles);
  for (const requiredPackedFile of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "packages/attachments/package.json",
    "packages/attachments/dist/index.js",
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
  for (const workspaceDependency of exactRuntimeWorkspaceDependencies) {
    const workspaceManifest = JSON.parse(
      readFileSync(path.join(repoRoot, workspaceDependency.directory, "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    assert.equal(workspaceManifest.name, workspaceDependency.name);
    assert.equal(
      packedManifest.dependencies?.[workspaceDependency.name],
      workspaceManifest.version,
      `packed runtime must pin ${workspaceDependency.name} to its workspace version`,
    );
  }
  for (const bundledDependency of [
    {
      packedManifestPath: "node_modules/@kestrel-agents/memory/package.json",
      workspaceManifestPath: "packages/memory/package.json",
    },
    {
      packedManifestPath: "node_modules/@lumi/kestrel-environment-auth/package.json",
      workspaceManifestPath: "packages/environment-auth/package.json",
    },
  ]) {
    const bundledManifest = JSON.parse(
      readFileSync(path.join(extractDir, "package", bundledDependency.packedManifestPath), "utf8"),
    ) as { name?: string; version?: string };
    const workspaceManifest = JSON.parse(
      readFileSync(path.join(repoRoot, bundledDependency.workspaceManifestPath), "utf8"),
    ) as { name?: string; version?: string };
    assert.equal(
      bundledManifest.version,
      workspaceManifest.version,
      `bundled ${bundledManifest.name ?? bundledDependency.packedManifestPath} manifest must match its workspace version`,
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
    KESTREL_CORE_IDLE_TIMEOUT_MS: "500",
    KESTREL_DISABLE_DOTENV: "1",
    DATABASE_URL: "",
    FORCE_COLOR: "0",
  };
  delete cliEnv.KESTREL_CORE_HOME;
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
  const preflightInputPath = path.join(consumerDir, "job-preflight-input.json");
  const preflightOutputPath = path.join(consumerDir, "job-preflight-output.json");
  const preflightHome = path.join(consumerDir, ".kestrel-preflight");
  const preflightCliEnv = { ...cliEnv, KESTREL_HOME: preflightHome };
  writeFileSync(preflightInputPath, JSON.stringify({
    version: "job_input_v2",
    profileId: "kestrel",
    environmentPresetId: "cli_dev_local",
    approvalPolicyPackId: "dev",
    requiredTools: ["exec_command"],
    turn: { sessionId: "runtime-release-preflight", message: "Verify compatibility" },
  }));
  execFileSync(
    cliCommand,
    ["job", "preflight", "--json-in", preflightInputPath, "--json-out", preflightOutputPath],
    { cwd: consumerDir, encoding: "utf8", env: preflightCliEnv, timeout: 90_000 },
  );
  const preflight = JSON.parse(readFileSync(preflightOutputPath, "utf8")) as {
    version?: string;
    capability?: string;
    status?: string;
    missingTools?: string[];
    executionProfileBinding?: { approvalPolicyPack?: { digest?: string } };
  };
  assert.equal(preflight.version, "job_preflight_v1");
  assert.equal(preflight.capability, "local-core.execution-profile-resolution.v2");
  assert.equal(preflight.status, "ready");
  assert.deepEqual(preflight.missingTools, []);
  assert.match(preflight.executionProfileBinding?.approvalPolicyPack?.digest ?? "", /^[a-f0-9]{64}$/u);
  const rejectionInputPath = path.join(consumerDir, "job-run-rejection-input.json");
  const rejectionOutputPath = path.join(consumerDir, "job-run-rejection-output.json");
  writeFileSync(rejectionInputPath, JSON.stringify({
    version: "job_input_v2",
    profileId: "kestrel",
    environmentPresetId: "cli_dev_local",
    approvalPolicyPackId: "dev",
    requiredTools: ["exec_command"],
    turn: { sessionId: "runtime-release-rejection", message: "Must not dispatch" },
    executionProfileBinding: {
      ...(preflight as { executionProfileBinding: Record<string, unknown> }).executionProfileBinding,
      approvalPolicyPack: {
        ...(preflight as { executionProfileBinding: { approvalPolicyPack: Record<string, unknown> } }).executionProfileBinding.approvalPolicyPack,
        digest: "0".repeat(64),
      },
    },
  }));
  assert.throws(
    () => execFileSync(
      cliCommand,
      ["job", "run", "--json-in", rejectionInputPath, "--json-out", rejectionOutputPath],
      { cwd: consumerDir, encoding: "utf8", env: preflightCliEnv, timeout: 90_000 },
    ),
    /Command failed/u,
  );
  const rejection = JSON.parse(readFileSync(rejectionOutputPath, "utf8")) as {
    version?: string;
    code?: string;
  };
  assert.deepEqual(rejection, {
    version: "job_run_rejection_v1",
    code: "COMPATIBILITY_ERROR",
    message: "The execution profile binding is missing, stale, or has been altered.",
    details: { mismatches: ["approval policy pack does not match current preflight evidence"] },
  });
  assert.equal(
    existsSync(path.join(preflightHome, "worktrees")),
    false,
    "preflight must not create a worktree root",
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
