import { existsSync } from "node:fs";
import path from "node:path";
import { resolveLocalCorePaths } from "../../../src/localCore/home.js";
import { createDesktopError } from "./errors.js";

export interface DesktopPathConfig {
  repoRoot: string;
  bootHtmlPath: string;
  rendererHtmlPath: string;
  runtimeLogPath: string;
  runtimeHomePath: string;
  settingsPath: string;
  projectRunLedgerPath: string;
  postgresDataPath: string;
  postgresLogPath: string;
  postgresMetadataPath: string;
  isPackaged: boolean;
}

export function resolveDesktopLibexecRoot(input: {
  currentValue?: string | undefined;
  isPackaged: boolean;
  repoRoot: string;
}): string | undefined {
  const currentValue = input.currentValue?.trim();
  if (currentValue !== undefined && currentValue.length > 0) {
    return currentValue;
  }
  return input.isPackaged ? input.repoRoot : undefined;
}

export function resolveDesktopPathConfig(input: {
  cwd: string;
  resourcesPath?: string | undefined;
  userDataPath: string;
  localCoreHomePath?: string | undefined;
  isPackaged: boolean;
}): DesktopPathConfig {
  const repoRoot = input.isPackaged
    ? path.join(input.resourcesPath ?? input.cwd, "kestrel-repo")
    : resolveRepoRoot(input.cwd);
  const staticPath = input.isPackaged
    ? path.join(input.resourcesPath ?? input.cwd, "static")
    : path.join(resolveRepoRoot(input.cwd), "apps", "desktop", "static");
  const stateRoot = input.localCoreHomePath ?? input.userDataPath;
  const localCorePaths = resolveLocalCorePaths(stateRoot);

  return {
    repoRoot,
    bootHtmlPath: path.join(staticPath, "boot.html"),
    rendererHtmlPath: path.join(staticPath, "renderer", "index.html"),
    runtimeLogPath: path.join(localCorePaths.logsPath, "desktop-runtime.log"),
    runtimeHomePath: stateRoot,
    settingsPath: path.join(localCorePaths.settingsPath, "desktop-settings.json"),
    projectRunLedgerPath: path.join(localCorePaths.workspaceRegistryPath, "desktop-project-runs.json"),
    postgresDataPath: localCorePaths.postgresDataPath,
    postgresLogPath: path.join(localCorePaths.logsPath, "desktop-postgres.log"),
    postgresMetadataPath: localCorePaths.postgresMetadataPath,
    isPackaged: input.isPackaged,
  };
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, "pnpm-workspace.yaml");
    if (existsSync(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw createDesktopError({
        code: "desktop.repo_root_not_found",
        message: "Unable to locate the desktop repo root.",
        details: `cwd=${cwd}`,
      });
    }
    current = parent;
  }
}
