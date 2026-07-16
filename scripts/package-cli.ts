import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldCopyDesktopResourceEntry } from "./prepare-desktop-resources.js";
import {
  packPublicProtocolPackage,
  resolveRuntimePackageDependencies,
  resolveRuntimeDependencyInstallArgs,
} from "./runtime-package-dependencies.js";
import {
  prepareDesktopPostgresBundle,
  verifyPreparedDesktopPostgresBundle,
} from "./prepare-desktop-postgres-bundle.js";

const TARGET_PLATFORM = process.env.KESTREL_CLI_PACKAGE_PLATFORM?.trim() || process.platform;
const TARGET_ARCH = process.env.KESTREL_CLI_PACKAGE_ARCH?.trim() || process.arch;
const CLI_NAMES = ["kestrel", "ks", "kcron"] as const;
const CLI_RESOURCE_DIRECTORIES = ["cli", "src", "agents", "tools", "db", "scripts", "models", "bin"] as const;
const CLI_EXCLUDED_RUNTIME_PATHS = [
  "cli/client/InProcessRunnerTransport.ts",
  "cli/client/RunnerProcess.ts",
  "cli/runner/main.ts",
] as const;

const repoRoot = resolveRepoRoot(process.cwd());
const rootPackageJson = readPackageJson(path.join(repoRoot, "package.json"));
const cliDir = path.join(repoRoot, "apps", "cli");
const stageDir = path.join(cliDir, ".cli-package");
const libexecDir = path.join(stageDir, "libexec");
const binDir = path.join(stageDir, "bin");
const outDir = path.join(cliDir, "out");
const npmCacheDir = path.join(cliDir, ".npm-cache");
const artifactName = `kestrel-cli-${rootPackageJson.version}-${TARGET_PLATFORM}-${TARGET_ARCH}.tar.gz`;
const artifactPath = path.join(outDir, artifactName);
const excludedRuntimePaths = new Set(
  CLI_EXCLUDED_RUNTIME_PATHS.map((relativePath) => path.resolve(repoRoot, relativePath)),
);

if (process.platform !== TARGET_PLATFORM || process.arch !== TARGET_ARCH) {
  throw new Error(
    `CLI packaging must run on its target platform; target is ${TARGET_PLATFORM}-${TARGET_ARCH}, current host is ${process.platform}-${process.arch}.`,
  );
}
if (
  (TARGET_PLATFORM !== "darwin" && TARGET_PLATFORM !== "linux") ||
  (TARGET_ARCH !== "arm64" && TARGET_ARCH !== "x64")
) {
  throw new Error(`Unsupported CLI package target: ${TARGET_PLATFORM}-${TARGET_ARCH}.`);
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(libexecDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

writeCliRuntimeManifest();
copyCliRuntimeResources();
if (TARGET_PLATFORM === "darwin") {
  prepareCliPostgresBundle();
  copyCliPostgresBundle();
}
installRuntimeDependenciesWithPackedProtocol();
writeLaunchers();
writeBundleManifest();

rmSync(artifactPath, { force: true });
execFileSync("tar", ["-czf", artifactPath, "-C", stageDir, "."], {
  cwd: repoRoot,
  stdio: "inherit",
});
writeArtifactDigest();

console.log(`[cli] packaged ${artifactPath}`);

function writeBundleManifest(): void {
  const sourceCommit = process.env.KESTREL_SOURCE_COMMIT?.trim() || readSourceCommit();
  writeFileSync(
    path.join(stageDir, "kestrel-bundle.json"),
    `${JSON.stringify({
      version: "kestrel_cli_bundle_v1",
      package: rootPackageJson.name,
      packageVersion: rootPackageJson.version,
      sourceCommit,
      platform: TARGET_PLATFORM,
      arch: TARGET_ARCH,
      nodeRequirement: rootPackageJson.engines?.node ?? null,
      entrypoint: "bin/kestrel",
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeArtifactDigest(): void {
  const digest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  writeFileSync(`${artifactPath}.sha256`, `${digest}  ${path.basename(artifactPath)}\n`, "utf8");
  console.log(`[cli] sha256 ${digest}`);
}

function readSourceCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("Unable to determine Kestrel source commit; set KESTREL_SOURCE_COMMIT explicitly.");
  }
}

function writeCliRuntimeManifest(): void {
  const dependencies = resolveRuntimePackageDependencies({
    repoRoot,
    runtimeVersion: rootPackageJson.version,
    dependencies: rootPackageJson.dependencies,
    tsxVersion: rootPackageJson.devDependencies?.tsx,
  });

  writeFileSync(
    path.join(libexecDir, "package.json"),
    `${JSON.stringify(
      {
        name: "kestrel-cli-runtime",
        version: rootPackageJson.version,
        private: true,
        type: "module",
        ...(rootPackageJson.packageManager !== undefined ? { packageManager: rootPackageJson.packageManager } : {}),
        ...(rootPackageJson.engines !== undefined ? { engines: rootPackageJson.engines } : {}),
        dependencies,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function copyCliRuntimeResources(): void {
  for (const relativePath of CLI_RESOURCE_DIRECTORIES) {
    const sourcePath = path.join(repoRoot, relativePath);
    if (existsSync(sourcePath) === false) {
      continue;
    }
    cpSync(sourcePath, path.join(libexecDir, relativePath), {
      recursive: true,
      filter: shouldCopyCliRuntimeResourceEntry,
    });
  }
}

function shouldCopyCliRuntimeResourceEntry(entry: string): boolean {
  return shouldCopyDesktopResourceEntry(entry) && excludedRuntimePaths.has(path.resolve(entry)) === false;
}

function prepareCliPostgresBundle(): void {
  const result = prepareDesktopPostgresBundle({
    repoRoot,
    platform: TARGET_PLATFORM,
    arch: TARGET_ARCH,
    strict: true,
  });
  if (result.prepared === false) {
    throw new Error(`Unable to prepare the CLI Postgres bundle: ${result.reason ?? "unavailable"}.`);
  }
  verifyPreparedDesktopPostgresBundle({
    targetRoot: result.targetRoot,
    expectedPlatform: TARGET_PLATFORM,
    expectedArch: TARGET_ARCH,
  });
}

function copyCliPostgresBundle(): void {
  const sourcePath = path.join(repoRoot, "apps", "desktop", "resources", "postgres-bundle");
  if (existsSync(sourcePath) === false) {
    throw new Error(`CLI package requires the managed Postgres bundle at '${sourcePath}'.`);
  }
  cpSync(sourcePath, path.join(libexecDir, "postgres-bundle"), {
    recursive: true,
    filter: shouldCopyDesktopResourceEntry,
  });
}

function installRuntimeDependenciesWithPackedProtocol(): void {
  const localPackageDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-cli-runtime-pack-"));
  try {
    installRuntimeDependencies([
      packPublicProtocolPackage({ repoRoot, packDir: localPackageDir }),
    ]);
  } finally {
    rmSync(localPackageDir, { recursive: true, force: true });
  }
}

function installRuntimeDependencies(localPackages: readonly string[]): void {
  mkdirSync(npmCacheDir, { recursive: true });
  execFileSync(resolveNpmCommand(), resolveRuntimeDependencyInstallArgs(localPackages), {
    cwd: libexecDir,
    env: {
      ...process.env,
      CI: "1",
      npm_config_cache: npmCacheDir,
    },
    stdio: "inherit",
  });
}

function writeLaunchers(): void {
  for (const name of CLI_NAMES) {
    const launcherPath = path.join(binDir, name);
    writeFileSync(launcherPath, buildLauncherSource(name), { encoding: "utf8", mode: 0o755 });
    const mode = statSync(launcherPath).mode;
    if ((mode & 0o111) === 0) {
      throw new Error(`Generated launcher is not executable: ${launcherPath}`);
    }
  }
}

function buildLauncherSource(name: string): string {
  const entrypoint = name === "kcron" ? "cli/kcron.ts" : "cli/tui.ts";
  const aliasLine =
    name === "kcron"
      ? ""
      : `
      KESTREL_ENTRYPOINT_ALIAS: invokedAs,`;
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const launcherPath = realpathSync(fileURLToPath(import.meta.url));
const invokedAs = path.basename(process.argv[1] ?? ${JSON.stringify(name)});
const libexecRoot = path.resolve(path.dirname(launcherPath), "..", "libexec");
const require = createRequire(pathToFileURL(path.join(libexecRoot, "package.json")).href);
const tsxImport = require.resolve("tsx");
const entrypoint = path.join(libexecRoot, ${JSON.stringify(entrypoint)});

const child = spawn(process.execPath, ["--import", tsxImport, entrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: {
    ...process.env,
    KESTREL_CLI_LIBEXEC: libexecRoot,${aliasLine}
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      return;
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(\`[${name}] failed to launch CLI: \${error.message}\`);
  process.exit(1);
});
`;
}

function readPackageJson(packageJsonPath: string): {
  name: string;
  version: string;
  packageManager?: string | undefined;
  engines?: Record<string, string> | undefined;
  dependencies?: Record<string, string> | undefined;
  devDependencies?: Record<string, string> | undefined;
} {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
    packageManager?: unknown;
    engines?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
  };
  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    throw new Error(`Package manifest at '${packageJsonPath}' must declare a name.`);
  }
  if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
    throw new Error(`Package manifest at '${packageJsonPath}' must declare a version.`);
  }
  return {
    name: parsed.name,
    version: parsed.version,
    ...(typeof parsed.packageManager === "string" ? { packageManager: parsed.packageManager } : {}),
    ...(isStringRecord(parsed.engines) ? { engines: parsed.engines } : {}),
    ...(isStringRecord(parsed.dependencies) ? { dependencies: parsed.dependencies } : {}),
    ...(isStringRecord(parsed.devDependencies) ? { devDependencies: parsed.devDependencies } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}

function resolveNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
