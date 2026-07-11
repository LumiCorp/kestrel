import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  installDesktopRuntimeDependencies,
  shouldInstallDesktopRuntimeDependencies,
} from "./prepare-desktop-resources.js";
import { packPublicProtocolPackage } from "./runtime-package-dependencies.js";

const repoRoot = resolveRepoRoot(process.cwd());
const desktopDir = path.join(repoRoot, "apps", "desktop");
const stageDir = path.join(desktopDir, ".desktop-package");
const distDir = path.join(desktopDir, "dist");
const resourcesDir = path.join(desktopDir, "resources", "kestrel-repo");
const npmCacheDir = path.join(desktopDir, ".npm-cache");

if (existsSync(distDir) === false) {
  throw new Error("Desktop dist output is missing. Run the desktop build before preparing the package stage.");
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

cpSync(distDir, path.join(stageDir, "dist"), { recursive: true });
writeStagePackageJson();
installStageDependencies();
if (shouldInstallDesktopRuntimeDependencies({ packageStage: true })) {
  const localPackageDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-desktop-runtime-pack-"));
  try {
    installDesktopRuntimeDependencies(resourcesDir, {
      npmCacheDir,
      localPackages: [packPublicProtocolPackage({ repoRoot, packDir: localPackageDir })],
    });
  } finally {
    rmSync(localPackageDir, { recursive: true, force: true });
  }
}

console.log(`[desktop] prepared package stage in ${stageDir}`);

function writeStagePackageJson(): void {
  const packageJson = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    type?: string | undefined;
    main: string;
    dependencies?: Record<string, string> | undefined;
    overrides?: Record<string, string> | undefined;
  };

  writeFileSync(
    path.join(stageDir, "package.json"),
    `${JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        private: true,
        ...(packageJson.type !== undefined ? { type: packageJson.type } : {}),
        main: packageJson.main,
        dependencies: packageJson.dependencies ?? {},
        ...(packageJson.overrides !== undefined ? { overrides: packageJson.overrides } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function installStageDependencies(): void {
  mkdirSync(npmCacheDir, { recursive: true });
  execFileSync(resolveNpmCommand(), ["install", "--omit=dev"], {
    cwd: stageDir,
    env: {
      ...process.env,
      CI: "1",
      npm_config_cache: npmCacheDir,
    },
    stdio: "inherit",
  });
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
