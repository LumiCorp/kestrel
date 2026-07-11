import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveKestrelCoreHome, resolveLocalCorePaths } from "./home.js";

export type LegacyStateStatus = "absent" | "present";

export interface LegacyStateEntry {
  name: "local_core" | "desktop_legacy" | "cli_legacy";
  status: LegacyStateStatus;
  path: string;
  evidence: string[];
}

export interface LocalCoreMigrationReadinessReport {
  generatedAt: string;
  coreHome: string;
  coreHomeSource: string;
  isolatedDevMode: boolean;
  entries: LegacyStateEntry[];
  messages: string[];
}

export interface DetectLocalCoreMigrationStateOptions {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  homeDir?: string | undefined;
  now?: Date | undefined;
}

export function detectLocalCoreMigrationState(
  options: DetectLocalCoreMigrationStateOptions = {},
): LocalCoreMigrationReadinessReport {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const coreHome = resolveKestrelCoreHome(env, platform);
  const corePaths = resolveLocalCorePaths(coreHome.homePath);
  const generatedAt = (options.now ?? new Date()).toISOString();

  const entries: LegacyStateEntry[] = [
    {
      name: "local_core",
      status: existsSync(coreHome.homePath) ? "present" : "absent",
      path: coreHome.homePath,
      evidence: existingRelativePaths(coreHome.homePath, [
        path.relative(coreHome.homePath, corePaths.manifestPath),
        path.relative(coreHome.homePath, corePaths.lockPath),
        path.relative(coreHome.homePath, corePaths.apiSocketPath),
        path.relative(coreHome.homePath, corePaths.apiTokenPath),
        path.relative(coreHome.homePath, corePaths.postgresDataPath),
        path.relative(coreHome.homePath, corePaths.settingsPath),
        path.relative(coreHome.homePath, corePaths.workspaceRegistryPath),
        path.relative(coreHome.homePath, corePaths.diagnosticsPath),
      ]),
    },
    {
      name: "desktop_legacy",
      status: existsSync(desktopLegacyPath(homeDir)) ? "present" : "absent",
      path: desktopLegacyPath(homeDir),
      evidence: existingRelativePaths(desktopLegacyPath(homeDir), [
        "desktop-settings.json",
        "runtime-home",
        "postgres/data",
        "postgres/metadata.json",
        "logs",
      ]),
    },
    {
      name: "cli_legacy",
      status: existsSync(cliLegacyPath(homeDir)) ? "present" : "absent",
      path: cliLegacyPath(homeDir),
      evidence: existingRelativePaths(cliLegacyPath(homeDir), [
        "profiles.json",
        "workspaces.json",
        "sessions.json",
        "history.jsonl",
        "kcron",
      ]),
    },
  ];

  return {
    generatedAt,
    coreHome: coreHome.homePath,
    coreHomeSource: coreHome.source,
    isolatedDevMode: coreHome.isolated,
    entries,
    messages: buildMessages(coreHome.homePath, coreHome.source, coreHome.isolated, entries),
  };
}

function buildMessages(
  coreHome: string,
  coreHomeSource: string,
  isolatedDevMode: boolean,
  entries: LegacyStateEntry[],
): string[] {
  const messages = [`using Kestrel Local Core home: ${coreHome} (${coreHomeSource})`];
  if (isolatedDevMode) {
    messages.push("isolated/dev mode active: this state is intentionally separate from the packaged default Core home");
  }
  for (const entry of entries) {
    if (entry.name === "desktop_legacy" && entry.status === "present") {
      messages.push(`found old Desktop state at ${entry.path}; report only, do not move or overwrite automatically`);
    }
    if (entry.name === "cli_legacy" && entry.status === "present") {
      messages.push(`found old CLI state at ${entry.path}; report only, do not move or overwrite automatically`);
    }
  }
  return messages;
}

function existingRelativePaths(root: string, candidates: string[]): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const evidence: string[] = [];
  for (const candidate of candidates) {
    const candidatePath = path.join(root, candidate);
    if (existsSync(candidatePath)) {
      evidence.push(candidate);
    }
  }
  if (evidence.length === 0) {
    const children = readdirSync(root).slice(0, 5);
    for (const child of children) {
      const childPath = path.join(root, child);
      const suffix = statSync(childPath).isDirectory() ? "/" : "";
      evidence.push(`${child}${suffix}`);
    }
  }
  return evidence.sort();
}

function desktopLegacyPath(homeDir: string): string {
  return path.join(homeDir, "Library", "Application Support", "@kestrel", "desktop");
}

function cliLegacyPath(homeDir: string): string {
  return path.join(homeDir, ".kestrel");
}
