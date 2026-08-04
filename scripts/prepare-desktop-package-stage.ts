import { execFileSync } from "node:child_process";
import {
  existsSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { verifyLocalCoreWorkspacePackagePayloads } from "../src/localCore/buildIdentity.js";

const repoRoot = resolveRepoRoot(process.cwd());
const desktopDir = path.join(repoRoot, "apps", "desktop");
const stageDir = path.join(desktopDir, ".desktop-package");
const runtimeDir = path.join(desktopDir, ".desktop-runtime");
const payloadDir = path.join(repoRoot, "apps", "desktop-runtime", "payload");

if (!existsSync(path.join(desktopDir, "dist"))) {
  throw new Error(
    "Desktop dist output is missing. Run the Desktop build before preparing its package.",
  );
}
if (!existsSync(payloadDir)) {
  throw new Error(
    "Desktop runtime payload is missing. Run prepare:resources before packaging.",
  );
}

rmSync(stageDir, { recursive: true, force: true });
rmSync(runtimeDir, { recursive: true, force: true });
deploy("@kestrel/desktop", stageDir);
deploy("@kestrel/desktop-runtime", runtimeDir);
verifyLocalCoreWorkspacePackagePayloads({
  sourceRoot: repoRoot,
  dependencyRoot: runtimeDir,
});
pruneNonArm64NativePayload(stageDir);
pruneNonArm64NativePayload(runtimeDir);
writeElectronBuilderStageManifest();

console.log(`[desktop] deployed Electron shell to ${stageDir}`);
console.log(`[desktop] deployed Local Core to ${runtimeDir}`);

function deploy(packageName: string, targetDir: string): void {
  execFileSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    [
      "--filter",
      packageName,
      "--fail-if-no-match",
      "--prod",
      "deploy",
      targetDir,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
}

function pruneNonArm64NativePayload(deploymentRoot: string): void {
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === "fsevents") {
        rmSync(entryPath, { recursive: true, force: true });
        continue;
      }
      if (
        path.basename(current) === "prebuilds" &&
        entry.name !== "darwin-arm64"
      ) {
        rmSync(entryPath, { recursive: true, force: true });
        continue;
      }
      visit(entryPath);
    }
  };
  visit(path.join(deploymentRoot, "node_modules"));
  removeBrokenOrExternalLinks(
    path.join(deploymentRoot, "node_modules"),
    deploymentRoot,
  );
}

function removeBrokenOrExternalLinks(root: string, deploymentRoot: string): void {
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string | undefined;
        try {
          target = realpathSync(entryPath);
        } catch {
          // Broken links are not a valid portable deployment.
        }
        if (
          target === undefined ||
          path.relative(deploymentRoot, target).startsWith(`..${path.sep}`) ||
          path.relative(deploymentRoot, target) === ".."
        ) {
          rmSync(entryPath, { force: true });
        }
        continue;
      }
      if (entry.isDirectory()) visit(entryPath);
    }
  };
  visit(root);
}

function writeElectronBuilderStageManifest(): void {
  const manifestPath = path.join(stageDir, "package.json");
  const source = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name: string;
    version: string;
    type: string;
    main: string;
  };
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: source.name,
        version: source.version,
        private: true,
        packageManager: "npm@10.9.2",
        type: source.type,
        main: source.main,
        dependencies: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}
