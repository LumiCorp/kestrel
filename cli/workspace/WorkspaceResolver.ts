import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ResolvedWorkspace,
  WorkspaceRegistryEntry,
  WorkspaceRuntimeContext,
  WorkspacesFile,
} from "../contracts.js";
import type { WorkspaceStore } from "./WorkspaceStore.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceResolutionResult {
  workspace?: ResolvedWorkspace | undefined;
  notices: string[];
}

export interface CreateWorkspaceOptions {
  label?: string | undefined;
}

export async function resolveWorkspaceFromCwd(
  cwd: string,
  store: WorkspaceStore,
): Promise<WorkspaceResolutionResult> {
  return {
    workspace: await registerWorkspaceForCwd(cwd, store),
    notices: [],
  };
}

export async function resolveWorkspaceFromBinding(
  binding: {
    workspaceId?: string | undefined;
    workspaceRoot?: string | undefined;
  },
  store: WorkspaceStore,
): Promise<WorkspaceResolutionResult> {
  const workspaces = await store.load();
  const candidates = [
    binding.workspaceId !== undefined ? store.findById(workspaces, binding.workspaceId) : undefined,
    binding.workspaceRoot !== undefined ? store.findByRootPath(workspaces, binding.workspaceRoot) : undefined,
  ].filter((value): value is WorkspaceRegistryEntry => value !== undefined);
  const uniqueCandidates = candidates.filter((value, index, list) =>
    list.findIndex((candidate) => candidate.workspaceId === value.workspaceId) === index
  );

  for (const entry of uniqueCandidates) {
    const workspace = await resolveWorkspaceEntry(entry);
    if (workspace !== undefined) {
      await applyWorkspaceLastUsed(workspaces, store, workspace);
      return { workspace, notices: [] };
    }
  }

  if (binding.workspaceId !== undefined || binding.workspaceRoot !== undefined) {
    return {
      notices: [
        `Workspace binding is stale: ${binding.workspaceId ?? "unknown"} (${binding.workspaceRoot ?? "missing path"}).`,
      ],
    };
  }
  return { notices: [] };
}

export async function registerWorkspaceForCwd(
  cwd: string,
  store: WorkspaceStore,
  options: CreateWorkspaceOptions = {},
): Promise<ResolvedWorkspace> {
  const launchCwd = await resolveExistingDirectory(cwd);
  const rootPath = await resolveCatalogRoot(launchCwd);
  return registerWorkspaceRoot(rootPath, store, {
    ...options,
    launchCwd,
  });
}

export async function initializeWorkspaceAtRoot(
  rootPath: string,
  store: WorkspaceStore,
  options: CreateWorkspaceOptions = {},
): Promise<ResolvedWorkspace> {
  return registerWorkspaceRoot(await resolveExistingDirectory(rootPath), store, options);
}

export async function registerWorkspaceRoot(
  rootPath: string,
  store: WorkspaceStore,
  options: CreateWorkspaceOptions & { launchCwd?: string | undefined } = {},
): Promise<ResolvedWorkspace> {
  const resolvedRoot = await resolveExistingDirectory(rootPath);
  const workspaces = await store.load();
  const existing = store.findByRootPath(workspaces, resolvedRoot);
  const now = new Date().toISOString();
  const entry: WorkspaceRegistryEntry = {
    workspaceId: existing?.workspaceId ?? deriveWorkspaceId(resolvedRoot),
    rootPath: resolvedRoot,
    ...(options.launchCwd !== undefined ? { launchCwd: path.resolve(options.launchCwd) } : existing?.launchCwd !== undefined ? { launchCwd: existing.launchCwd } : {}),
    label: options.label ?? existing?.label ?? path.basename(resolvedRoot),
    automationEnabled: existing?.automationEnabled ?? false,
    ...(existing?.automationEnabledAt !== undefined ? { automationEnabledAt: existing.automationEnabledAt } : {}),
    discoveredAt: existing?.discoveredAt ?? now,
    updatedAt: now,
    lastUsedAt: now,
  };
  await store.save(store.upsert(workspaces, entry));
  return toResolvedWorkspace(entry);
}

export function describeResolvedWorkspace(
  workspace: ResolvedWorkspace | undefined,
): string {
  if (workspace === undefined) {
    return "Workspace=none";
  }
  return `Workspace=${workspace.manifest.workspaceId} Root=${workspace.rootPath}`;
}

export function applyWorkspaceLastUsed(
  file: WorkspacesFile,
  store: WorkspaceStore,
  workspace: ResolvedWorkspace,
): Promise<void> {
  const existing = store.findById(file, workspace.manifest.workspaceId);
  const now = new Date().toISOString();
  return store.save(
    store.upsert(file, {
      workspaceId: workspace.manifest.workspaceId,
      rootPath: workspace.rootPath,
      ...(workspace.registryEntry.launchCwd !== undefined ? { launchCwd: workspace.registryEntry.launchCwd } : {}),
      ...(workspace.manifest.label !== undefined ? { label: workspace.manifest.label } : {}),
      automationEnabled: existing?.automationEnabled ?? false,
      ...(existing?.automationEnabledAt !== undefined ? { automationEnabledAt: existing.automationEnabledAt } : {}),
      discoveredAt: existing?.discoveredAt ?? now,
      updatedAt: now,
      lastUsedAt: now,
    }),
  );
}

async function resolveWorkspaceEntry(entry: WorkspaceRegistryEntry): Promise<ResolvedWorkspace | undefined> {
  try {
    return toResolvedWorkspace({
      ...entry,
      rootPath: await resolveExistingDirectory(entry.rootPath),
    });
  } catch {
    return ;
  }
}

function toResolvedWorkspace(entry: WorkspaceRegistryEntry): ResolvedWorkspace {
  const managedWorktreeIsolation = readManagedWorktreeIsolationEnv();
  const runtimeContext: WorkspaceRuntimeContext = {
    workspaceId: entry.workspaceId,
    workspaceRoot: entry.rootPath,
    ...(entry.launchCwd !== undefined ? { launchCwd: entry.launchCwd } : {}),
    appRoot: ".",
    commands: {},
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(managedWorktreeIsolation !== undefined ? { managedWorktreeIsolation } : {}),
  };
  return {
    rootPath: entry.rootPath,
    registryEntry: entry,
    manifest: {
      version: 1,
      workspaceId: entry.workspaceId,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      appRoot: ".",
      commands: {},
    },
    runtimeContext,
  };
}

function readManagedWorktreeIsolationEnv(): "scoped" | "session" | undefined {
  const value = process.env.KESTREL_MANAGED_WORKTREE_ISOLATION;
  return value === "scoped" || value === "session" ? value : undefined;
}

async function resolveCatalogRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
    });
    const gitRoot = stdout.trim();
    if (gitRoot.length > 0) {
      return resolveExistingDirectory(gitRoot);
    }
  } catch {
    // Non-git folders are still valid catalog workspaces.
  }
  return cwd;
}

async function resolveExistingDirectory(inputPath: string): Promise<string> {
  const resolved = await realpath(path.resolve(inputPath));
  const info = await stat(resolved);
  if (info.isDirectory() === false) {
    throw new Error(`Workspace path is not a directory: ${inputPath}`);
  }
  return resolved;
}

function deriveWorkspaceId(rootPath: string): string {
  const digest = createHash("sha256").update(path.resolve(rootPath)).digest("hex").slice(0, 16);
  return `local:${digest}`;
}
