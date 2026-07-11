import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldCopyDesktopResourceEntry } from "./prepare-desktop-resources.js";
import {
  packPublicProtocolPackage,
  resolveRuntimeDependencyInstallArgs,
} from "./runtime-package-dependencies.js";
import {
  prepareDesktopPostgresBundle,
  verifyPreparedDesktopPostgresBundle,
} from "./prepare-desktop-postgres-bundle.js";

const TARGET_PLATFORM = "darwin";
const TARGET_ARCH = "arm64";
const CLI_NAMES = ["kestrel", "ks", "kcron"] as const;
const CLI_RESOURCE_DIRECTORIES = ["cli", "src", "agents", "tools", "db", "scripts", "models", "bin"] as const;

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

if (process.platform !== TARGET_PLATFORM || process.arch !== TARGET_ARCH) {
  throw new Error(
    `CLI v0.5 beta packaging currently targets ${TARGET_PLATFORM}-${TARGET_ARCH}; current host is ${process.platform}-${process.arch}.`,
  );
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(libexecDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

writeCliRuntimeManifest();
copyCliRuntimeResources();
prepareCliPostgresBundle();
copyCliPostgresBundle();
installRuntimeDependenciesWithPackedProtocol();
writeLaunchers();

rmSync(artifactPath, { force: true });
execFileSync("tar", ["-czf", artifactPath, "-C", stageDir, "."], {
  cwd: repoRoot,
  stdio: "inherit",
});

console.log(`[cli] packaged ${artifactPath}`);

function writeCliRuntimeManifest(): void {
  const dependencies = {
    ...(rootPackageJson.dependencies ?? {}),
    ...(rootPackageJson.devDependencies?.tsx !== undefined ? { tsx: rootPackageJson.devDependencies.tsx } : {}),
  };

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
      filter: shouldCopyDesktopResourceEntry,
    });
  }
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
  version: string;
  packageManager?: string | undefined;
  engines?: Record<string, string> | undefined;
  dependencies?: Record<string, string> | undefined;
  devDependencies?: Record<string, string> | undefined;
} {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
    packageManager?: unknown;
    engines?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
  };
  if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
    throw new Error(`Package manifest at '${packageJsonPath}' must declare a version.`);
  }
  return {
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
