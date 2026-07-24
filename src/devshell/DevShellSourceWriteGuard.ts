import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  rmdir,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  DevShellSourceWriteApprovalGrant,
  DevShellSourceWriteGuardRequest,
  DevShellSourceWriteGuardResult,
  DevShellSourceWriteMode,
  DevShellUnauthorizedSourceWrite,
} from "./contracts.js";

type SnapshotEntry =
  | {
      type: "file";
      path: string;
      hash: string;
      content: Buffer;
      mode: number;
    }
  | {
      type: "symlink";
      path: string;
      target: string;
    };

interface FileState {
  type: "file" | "symlink";
  hash: string;
}

interface NormalizedGuardConfig {
  enabled: boolean;
  workspaceRoot: string;
  cwd: string;
  command: string;
  sourceRoots: string[];
  allowedWriteRoots: string[];
  internalStateRoots: string[];
  mode: DevShellSourceWriteMode;
  approvedGrantId?: string | undefined;
  gitVisibleOnly: boolean;
}

const execFileAsync = promisify(execFile);

export interface ActiveDevShellSourceWriteGuard {
  config: NormalizedGuardConfig;
  snapshot: Map<string, SnapshotEntry>;
  directorySnapshot: Set<string>;
}

export async function createDevShellSourceWriteGuard(input: {
  workspaceRoot: string;
  cwd: string;
  command: string;
  request?: DevShellSourceWriteGuardRequest | undefined;
  internalStateRoots?: string[] | undefined;
}): Promise<ActiveDevShellSourceWriteGuard | undefined> {
  if (input.request?.enabled !== true) {
    return ;
  }

  const workspaceRoot = path.resolve(input.workspaceRoot);
  const cwd = path.resolve(input.cwd);
  const sourceRoots = normalizeRoots(workspaceRoot, input.request.sourceRoots, [workspaceRoot]);
  const internalStateRoots = normalizeRoots(workspaceRoot, input.internalStateRoots, []);
  const mutationPolicy = input.request.mutationPolicy ?? "direct";
  if (input.request.managedWorktree === true && mutationPolicy === "direct") {
    return {
      config: {
        enabled: true,
        workspaceRoot,
        cwd,
        command: input.command,
        sourceRoots,
        allowedWriteRoots: sourceRoots,
        internalStateRoots,
        mode: "checkpoint_worktree",
        gitVisibleOnly: false,
      },
      snapshot: new Map(),
      directorySnapshot: new Set(),
    };
  }
  const approval = consumeMatchingApprovalGrant({
    workspaceRoot,
    cwd,
    command: input.command,
    grants: input.request.approvalGrants,
  });
  const approvedRoots = approval === undefined
    ? []
    : normalizeRoots(workspaceRoot, approval.writablePaths, []);
  const allowedWriteRoots = [
    ...normalizeRoots(workspaceRoot, input.request.allowedWriteRoots, []),
    ...approvedRoots,
  ];
  const hasExplicitSourceWriteAllowance = sourceRoots.every((sourceRoot) =>
    allowedWriteRoots.some((allowedRoot) => isWithinRoot(sourceRoot, allowedRoot)),
  );
  const config: NormalizedGuardConfig = {
    enabled: true,
    workspaceRoot,
    cwd,
    command: input.command,
    sourceRoots,
    allowedWriteRoots: mutationPolicy === "direct" ? [...new Set(allowedWriteRoots)] : [],
    internalStateRoots,
    mode: mutationPolicy === "capture"
      ? "captured_source_write"
      : mutationPolicy === "reject"
        ? "source_readonly"
        : approval === undefined && hasExplicitSourceWriteAllowance === false
          ? "source_readonly"
          : "approved_source_write",
    gitVisibleOnly: input.request.managedWorktree === true && mutationPolicy !== "direct",
    ...(approval !== undefined ? { approvedGrantId: approval.grantId } : {}),
  };

  return {
    config,
    snapshot: await snapshotSourceRoots(config),
    directorySnapshot: await snapshotSourceDirectories(config),
  };
}

export async function enforceDevShellSourceWriteGuard(
  guard: ActiveDevShellSourceWriteGuard | undefined,
): Promise<DevShellSourceWriteGuardResult | undefined> {
  if (guard === undefined) {
    return ;
  }
  if (guard.config.mode === "checkpoint_worktree") {
    return {
      enabled: true,
      mode: "checkpoint_worktree",
      sourceRoots: guard.config.sourceRoots.map((root) => displayPath(guard.config.workspaceRoot, root)),
      allowedWriteRoots: guard.config.allowedWriteRoots.map((root) => displayPath(guard.config.workspaceRoot, root)),
      unauthorizedSourceWrites: [],
      restored: true,
    };
  }

  const after = await collectCurrentFileStates(guard.config);
  const capturedPatch = guard.config.mode === "captured_source_write"
    ? await buildCapturedPatch(guard, after)
    : undefined;
  const unauthorized: DevShellUnauthorizedSourceWrite[] = [];
  const seen = new Set<string>();

  for (const [absolutePath, before] of guard.snapshot) {
    seen.add(absolutePath);
    const current = after.get(absolutePath);
    if (current === undefined) {
      const restored = await restoreSnapshotEntry(before);
      unauthorized.push({
        path: displayPath(guard.config.workspaceRoot, absolutePath),
        kind: "deleted",
        restored,
      });
      continue;
    }
    if (current.type !== before.type) {
      const restored = await restoreSnapshotEntry(before);
      unauthorized.push({
        path: displayPath(guard.config.workspaceRoot, absolutePath),
        kind: "type_changed",
        restored,
      });
      continue;
    }
    const beforeHash = before.type === "file"
      ? before.hash
      : hashString(before.target);
    if (current.hash !== beforeHash) {
      const restored = await restoreSnapshotEntry(before);
      unauthorized.push({
        path: displayPath(guard.config.workspaceRoot, absolutePath),
        kind: "modified",
        restored,
      });
    }
  }

  for (const absolutePath of after.keys()) {
    if (seen.has(absolutePath)) {
      continue;
    }
    const restored = await rm(absolutePath, { recursive: true, force: true })
      .then(() => true)
      .catch(() => false);
    unauthorized.push({
      path: displayPath(guard.config.workspaceRoot, absolutePath),
      kind: "created",
      restored,
    });
  }

  const directoriesAfterRestore = await collectCurrentDirectories(guard.config);
  const createdDirectories = [...directoriesAfterRestore]
    .filter((absolutePath) =>
      guard.directorySnapshot.has(absolutePath) === false &&
      guard.config.sourceRoots.includes(absolutePath) === false &&
      isAllowedWritePath(guard.config, absolutePath) === false &&
      isInternalStateDirectoryPath(guard.config, absolutePath) === false
    )
    .sort((left, right) => right.length - left.length);
  for (const absolutePath of createdDirectories) {
    const restored = await rmdir(absolutePath)
      .then(() => true)
      .catch(() => false);
    if (restored === true || await pathExists(absolutePath)) {
      unauthorized.push({
        path: displayPath(guard.config.workspaceRoot, absolutePath),
        kind: "created",
        restored,
      });
    }
  }

  return {
    enabled: true,
    mode: guard.config.mode,
    ...(guard.config.approvedGrantId !== undefined ? { approvedGrantId: guard.config.approvedGrantId } : {}),
    sourceRoots: guard.config.sourceRoots.map((root) => displayPath(guard.config.workspaceRoot, root)),
    allowedWriteRoots: guard.config.allowedWriteRoots.map((root) => displayPath(guard.config.workspaceRoot, root)),
    unauthorizedSourceWrites: unauthorized,
    restored: unauthorized.every((item) => item.restored),
    ...(capturedPatch !== undefined && capturedPatch.patch.length > 0
      ? {
        capturedPatch: capturedPatch.patch,
        capturedBaseRevisions: capturedPatch.baseRevisions,
        changedFiles: unauthorized.map((item) => item.path),
      }
      : {}),
  };
}

export function hasUnauthorizedSourceWrites(
  result: DevShellSourceWriteGuardResult | undefined,
): boolean {
  return result?.mode !== "captured_source_write" && (result?.unauthorizedSourceWrites.length ?? 0) > 0;
}

function consumeMatchingApprovalGrant(input: {
  workspaceRoot: string;
  cwd: string;
  command: string;
  grants: DevShellSourceWriteApprovalGrant[] | undefined;
}): DevShellSourceWriteApprovalGrant | undefined {
  if (input.grants === undefined) {
    return ;
  }
  const now = Date.now();
  const grantIndex = input.grants.findIndex((grant) => {
    if (grant.command !== input.command) {
      return false;
    }
    if (grant.expiresAt !== undefined) {
      const expiresAt = Date.parse(grant.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        return false;
      }
    }
    if (grant.cwd !== undefined) {
      const expectedCwd = path.resolve(input.workspaceRoot, grant.cwd);
      if (expectedCwd !== input.cwd) {
        return false;
      }
    }
    return grant.writablePaths.length > 0;
  });
  if (grantIndex < 0) {
    return ;
  }
  const [grant] = input.grants.splice(grantIndex, 1);
  return grant;
}

async function snapshotSourceRoots(
  config: NormalizedGuardConfig,
): Promise<Map<string, SnapshotEntry>> {
  const snapshot = new Map<string, SnapshotEntry>();
  if (config.gitVisibleOnly) {
    for (const absolutePath of await listGitVisiblePaths(config.workspaceRoot)) {
      if (isInternalStatePath(config, absolutePath)) continue;
      await snapshotPath(absolutePath, snapshot);
    }
    return snapshot;
  }
  for (const root of config.sourceRoots) {
    await visitSourceFiles(config, root, async (absolutePath, type) => {
      await snapshotPath(absolutePath, snapshot, type);
    });
  }
  return snapshot;
}

async function snapshotSourceDirectories(config: NormalizedGuardConfig): Promise<Set<string>> {
  if (config.gitVisibleOnly) {
    return new Set();
  }
  return collectCurrentDirectories(config);
}

async function collectCurrentDirectories(config: NormalizedGuardConfig): Promise<Set<string>> {
  if (config.gitVisibleOnly) {
    return new Set();
  }
  const directories = new Set<string>();
  for (const root of config.sourceRoots) {
    await visitSourcePaths(config, root, {
      visitDirectory: async (absolutePath) => {
        directories.add(absolutePath);
      },
    });
  }
  return directories;
}

async function collectCurrentFileStates(
  config: NormalizedGuardConfig,
): Promise<Map<string, FileState>> {
  const files = new Map<string, FileState>();
  if (config.gitVisibleOnly) {
    for (const absolutePath of await listGitVisiblePaths(config.workspaceRoot)) {
      if (isInternalStatePath(config, absolutePath)) continue;
      const info = await lstat(absolutePath).catch(() => {});
      if (info === undefined) continue;
      if (info.isSymbolicLink()) {
        files.set(absolutePath, { type: "symlink", hash: hashString(await readlink(absolutePath)) });
      } else if (info.isFile()) {
        files.set(absolutePath, { type: "file", hash: hashBuffer(await readFile(absolutePath)) });
      }
    }
    return files;
  }
  for (const root of config.sourceRoots) {
    await visitSourceFiles(config, root, async (absolutePath, type) => {
      if (type === "file") {
        files.set(absolutePath, {
          type: "file",
          hash: hashBuffer(await readFile(absolutePath)),
        });
        return;
      }
      files.set(absolutePath, {
        type: "symlink",
        hash: hashString(await readlink(absolutePath)),
      });
    });
  }
  return files;
}

async function visitSourceFiles(
  config: NormalizedGuardConfig,
  root: string,
  visit: (absolutePath: string, type: "file" | "symlink") => Promise<void>,
): Promise<void> {
  await visitSourcePaths(config, root, {
    visitFile: visit,
  });
}

async function visitSourcePaths(
  config: NormalizedGuardConfig,
  root: string,
  visitors: {
    visitDirectory?: ((absolutePath: string) => Promise<void>) | undefined;
    visitFile?: ((absolutePath: string, type: "file" | "symlink") => Promise<void>) | undefined;
  },
): Promise<void> {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (isAllowedWritePath(config, current) || isInternalStatePath(config, current)) {
      continue;
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch {
      continue;
    }
    if (path.basename(current) === ".git" && info.isDirectory()) {
      continue;
    }
    if (info.isSymbolicLink()) {
      await visitors.visitFile?.(current, "symlink");
      continue;
    }
    if (info.isFile()) {
      await visitors.visitFile?.(current, "file");
      continue;
    }
    if (info.isDirectory()) {
      await visitors.visitDirectory?.(current);
      let children: string[];
      try {
        children = await readdir(current);
      } catch {
        continue;
      }
      children.sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        queue.push(path.join(current, child));
      }
    }
  }
}

async function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

async function restoreSnapshotEntry(entry: SnapshotEntry): Promise<boolean> {
  try {
    await rm(entry.path, { recursive: true, force: true });
    await mkdir(path.dirname(entry.path), { recursive: true });
    if (entry.type === "file") {
      await writeFile(entry.path, entry.content);
      await chmod(entry.path, entry.mode).catch(() => {});
      return true;
    }
    await symlink(entry.target, entry.path);
    return true;
  } catch {
    return false;
  }
}

function normalizeRoots(
  workspaceRoot: string,
  roots: string[] | undefined,
  fallback: string[],
): string[] {
  const values = roots !== undefined && roots.length > 0 ? roots : fallback;
  return [...new Set(values.map((value) =>
    path.resolve(path.isAbsolute(value) ? value : path.join(workspaceRoot, value))
  ))];
}

function isAllowedWritePath(
  config: NormalizedGuardConfig,
  candidate: string,
): boolean {
  return config.allowedWriteRoots.some((root) => isWithinRoot(candidate, root));
}

function isInternalStatePath(
  config: NormalizedGuardConfig,
  candidate: string,
): boolean {
  return config.internalStateRoots.some((root) => isWithinRoot(candidate, root));
}

function isInternalStateDirectoryPath(
  config: NormalizedGuardConfig,
  candidate: string,
): boolean {
  return config.internalStateRoots.some(
    (root) => isWithinRoot(candidate, root) || isWithinRoot(root, candidate),
  );
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative.startsWith("..") === false && path.isAbsolute(relative) === false);
}

function displayPath(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)
    ? absolutePath
    : relative;
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function snapshotPath(
  absolutePath: string,
  snapshot: Map<string, SnapshotEntry>,
  knownType?: "file" | "symlink",
): Promise<void> {
  const info = await lstat(absolutePath);
  const type = knownType ?? (info.isSymbolicLink() ? "symlink" : "file");
  if (type === "file") {
    const content = await readFile(absolutePath);
    snapshot.set(absolutePath, { type: "file", path: absolutePath, content, hash: hashBuffer(content), mode: info.mode });
    return;
  }
  const target = await readlink(absolutePath);
  snapshot.set(absolutePath, { type: "symlink", path: absolutePath, target });
}

async function listGitVisiblePaths(workspaceRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.toString("utf8").split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => path.join(workspaceRoot, entry));
}

async function buildCapturedPatch(
  guard: ActiveDevShellSourceWriteGuard,
  after: Map<string, FileState>,
): Promise<{ patch: string; baseRevisions: Record<string, string> }> {
  const changed = new Set<string>();
  for (const [absolutePath, before] of guard.snapshot) {
    const current = after.get(absolutePath);
    const beforeHash = before.type === "file" ? before.hash : hashString(before.target);
    if (current === undefined || current.type !== before.type || current.hash !== beforeHash) changed.add(absolutePath);
  }
  for (const absolutePath of after.keys()) {
    if (guard.snapshot.has(absolutePath) === false) changed.add(absolutePath);
  }
  if (changed.size === 0) return { patch: "", baseRevisions: {} };

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-shell-capture-"));
  const beforeRoot = path.join(tempRoot, "before");
  const afterRoot = path.join(tempRoot, "after");
  const baseRevisions: Record<string, string> = {};
  try {
    await mkdir(beforeRoot, { recursive: true });
    await mkdir(afterRoot, { recursive: true });
    for (const absolutePath of changed) {
      const relativePath = displayPath(guard.config.workspaceRoot, absolutePath);
      const before = guard.snapshot.get(absolutePath);
      if (before !== undefined) {
        await materializeSnapshotEntry(before, path.join(beforeRoot, relativePath));
        baseRevisions[relativePath] = `sha256:${before.type === "file" ? before.hash : hashString(before.target)}`;
      }
      if (after.has(absolutePath)) {
        await copyCurrentEntry(absolutePath, path.join(afterRoot, relativePath));
      }
    }
    let stdout = "";
    try {
      stdout = (await execFileAsync("git", ["diff", "--no-index", "--binary", "--src-prefix=a/", "--dst-prefix=b/", "--", beforeRoot, afterRoot], {
        maxBuffer: 16 * 1024 * 1024,
      })).stdout;
    } catch (error) {
      const record = error as { code?: number | string; stdout?: string };
      if (record.code !== 1 || typeof record.stdout !== "string") throw error;
      stdout = record.stdout;
    }
    return {
      patch: stdout.replaceAll(`a${beforeRoot}/`, "a/").replaceAll(`b${afterRoot}/`, "b/"),
      baseRevisions,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function materializeSnapshotEntry(entry: SnapshotEntry, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  if (entry.type === "file") {
    await writeFile(destination, entry.content);
    await chmod(destination, entry.mode).catch(() => {});
  } else {
    await symlink(entry.target, destination);
  }
}

async function copyCurrentEntry(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
  } else {
    await writeFile(destination, await readFile(source));
    await chmod(destination, info.mode).catch(() => {});
  }
}
