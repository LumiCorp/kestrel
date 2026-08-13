import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const PORTABLE_ROOT = ".kestrel/portable-backup";
const MANIFEST_VERSION = 1;

export class PortableWorkspaceBackupError extends Error {
  readonly code = "WORKSPACE_BACKUP_PORTABLE_STATE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PortableWorkspaceBackupError";
  }
}

type PortableWorktree = {
  bindingKey: string;
  worktreeRoot: string;
  baseHead: string;
  currentHead: string;
  untrackedPaths: string[];
};

type PortableBackupManifest = {
  version: typeof MANIFEST_VERSION;
  repository: {
    head: string;
    branch: string | null;
    bundlePath: string;
  };
  worktrees: PortableWorktree[];
  bindingRegistryPaths: string[];
};

export async function materializePortableBackupPayload(workspaceRoot: string) {
  const gitRoot = await git(workspaceRoot, ["rev-parse", "--show-toplevel"]).catch(
    () => {},
  );
  if (!gitRoot || (await realpath(gitRoot)) !== (await realpath(workspaceRoot))) {
    return;
  }
  const portableRoot = path.join(workspaceRoot, PORTABLE_ROOT);
  await rm(portableRoot, { recursive: true, force: true });
  await mkdir(path.join(portableRoot, "worktrees"), { recursive: true });

  const worktrees = await collectPortableWorktrees(workspaceRoot, portableRoot);
  const bindingRegistryPaths = await collectBindingRegistries(
    workspaceRoot,
    portableRoot,
  );
  for (const worktree of worktrees) {
    await git(workspaceRoot, [
      "update-ref",
      `refs/kestrel/portable/${worktree.bindingKey}`,
      worktree.currentHead,
    ]);
  }
  const bundlePath = path.join(portableRoot, "repository.bundle");
  await git(workspaceRoot, ["bundle", "create", bundlePath, "--all"]);
  const manifest: PortableBackupManifest = {
    version: MANIFEST_VERSION,
    repository: {
      head: await git(workspaceRoot, ["rev-parse", "HEAD"]),
      branch: await git(workspaceRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]).catch(() => null),
      bundlePath: `${PORTABLE_ROOT}/repository.bundle`,
    },
    worktrees,
    bindingRegistryPaths,
  };
  await writeFile(
    path.join(portableRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

export async function restorePortableBackupPayload(workspaceRoot: string) {
  const portableRoot = path.join(workspaceRoot, PORTABLE_ROOT);
  const raw = await readFile(path.join(portableRoot, "manifest.json"), "utf8").catch(
    () => {},
  );
  if (!raw) return false;
  const manifest = parseManifest(raw);
  const bundlePath = path.join(workspaceRoot, manifest.repository.bundlePath);
  await rm(path.join(workspaceRoot, ".git"), { recursive: true, force: true });
  await git(workspaceRoot, ["init"]);
  await git(workspaceRoot, [
    "symbolic-ref",
    "HEAD",
    "refs/heads/__kestrel_restore__",
  ]);
  await git(workspaceRoot, ["fetch", bundlePath, "+refs/*:refs/*"]);
  if (manifest.repository.branch) {
    await git(workspaceRoot, [
      "symbolic-ref",
      "HEAD",
      `refs/heads/${manifest.repository.branch}`,
    ]);
  }
  await git(workspaceRoot, ["reset", "--mixed", manifest.repository.head]);

  for (const worktree of manifest.worktrees) {
    const worktreeRoot = requireWorktreeRoot(
      worktree.worktreeRoot,
      path.join(workspaceRoot, ".kestrel", "runner", "worktrees"),
    );
    const payloadRoot = path.join(
      portableRoot,
      "worktrees",
      worktree.bindingKey,
    );
    await rm(worktreeRoot, { recursive: true, force: true });
    await mkdir(path.dirname(worktreeRoot), { recursive: true });
    await git(workspaceRoot, [
      "worktree",
      "add",
      "--detach",
      worktreeRoot,
      worktree.currentHead,
    ]);
    const patchPath = path.join(payloadRoot, "tracked.patch");
    if ((await readFile(patchPath)).length > 0) {
      await git(worktreeRoot, ["apply", "--binary", patchPath]);
    }
    for (const relativePath of worktree.untrackedPaths) {
      requireSafeRelativePath(relativePath);
      const destination = path.join(worktreeRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(payloadRoot, "untracked", relativePath), destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    await cp(
      path.join(payloadRoot, "binding.json"),
      `${worktreeRoot}.binding.json`,
    );
  }
  for (const relativePath of manifest.bindingRegistryPaths) {
    requireSafeRelativePath(relativePath);
    const destination = path.join(workspaceRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(portableRoot, "registries", relativePath), destination);
  }
  await rm(portableRoot, { recursive: true, force: true });
  return true;
}

async function collectPortableWorktrees(
  workspaceRoot: string,
  portableRoot: string,
) {
  const worktreesRoot = path.join(
    workspaceRoot,
    ".kestrel",
    "runner",
    "worktrees",
  );
  const bindingFiles = await findBindingFiles(worktreesRoot);
  const worktrees: PortableWorktree[] = [];
  for (const bindingFile of bindingFiles) {
    const raw = await readFile(bindingFile, "utf8");
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new PortableWorkspaceBackupError(
        "Managed worktree backup metadata is invalid.",
      );
    }
    const bindingKey = requireSafeSegment(metadata.bindingKey, "bindingKey");
    const baseHead = requireCommit(metadata.baseHead, "baseHead");
    const worktreeRoot = requireWorktreeRoot(metadata.worktreeRoot, worktreesRoot);
    const currentHead = await git(worktreeRoot, ["rev-parse", "HEAD"]);
    const payloadRoot = path.join(portableRoot, "worktrees", bindingKey);
    await mkdir(path.join(payloadRoot, "untracked"), { recursive: true });
    await writeFile(path.join(payloadRoot, "binding.json"), raw, "utf8");
    await writeFile(
      path.join(payloadRoot, "tracked.patch"),
      await gitRaw(worktreeRoot, ["diff", "--binary", currentHead]),
    );
    const untracked = (await gitRaw(worktreeRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]))
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    for (const relativePath of untracked) {
      requireSafeRelativePath(relativePath);
      const destination = path.join(payloadRoot, "untracked", relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(worktreeRoot, relativePath), destination, {
        recursive: true,
        errorOnExist: true,
      });
    }
    worktrees.push({
      bindingKey,
      worktreeRoot,
      baseHead,
      currentHead,
      untrackedPaths: untracked,
    });
  }
  return worktrees;
}

async function findBindingFiles(root: string) {
  const files: string[] = [];
  const repositories = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const repository of repositories) {
    if (!repository.isDirectory()) continue;
    const repositoryRoot = path.join(root, repository.name);
    const entries = await readdir(repositoryRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".binding.json")) {
        files.push(path.join(repositoryRoot, entry.name));
      }
    }
  }
  return files.sort();
}

async function collectBindingRegistries(
  workspaceRoot: string,
  portableRoot: string,
) {
  const worktreesRoot = path.join(
    workspaceRoot,
    ".kestrel",
    "runner",
    "worktrees",
  );
  const paths: string[] = [];
  const repositories = await readdir(worktreesRoot, {
    withFileTypes: true,
  }).catch(() => []);
  for (const repository of repositories) {
    if (!repository.isDirectory()) continue;
    const bindingsRoot = path.join(worktreesRoot, repository.name, "bindings");
    const bindings = await readdir(bindingsRoot, { withFileTypes: true }).catch(
      () => [],
    );
    for (const binding of bindings) {
      if (!(binding.isFile() && binding.name.endsWith(".json"))) continue;
      const source = path.join(bindingsRoot, binding.name);
      const relativePath = path.relative(workspaceRoot, source);
      requireSafeRelativePath(relativePath);
      const destination = path.join(portableRoot, "registries", relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination);
      paths.push(relativePath.replaceAll(path.sep, "/"));
    }
  }
  return paths.sort();
}

function parseManifest(raw: string): PortableBackupManifest {
  const value = JSON.parse(raw) as PortableBackupManifest;
  if (
    value.version !== MANIFEST_VERSION ||
    !value.repository?.head ||
    value.repository.bundlePath !== `${PORTABLE_ROOT}/repository.bundle` ||
    !Array.isArray(value.worktrees) ||
    !Array.isArray(value.bindingRegistryPaths)
  ) {
    throw new Error("Portable Workspace backup manifest is invalid.");
  }
  for (const relativePath of value.bindingRegistryPaths) {
    requireSafeRelativePath(relativePath);
  }
  for (const worktree of value.worktrees) {
    requireSafeSegment(worktree.bindingKey, "bindingKey");
    requireCommit(worktree.baseHead, "baseHead");
    requireCommit(worktree.currentHead, "currentHead");
    if (!Array.isArray(worktree.untrackedPaths)) {
      throw new Error("Portable Workspace untracked paths are invalid.");
    }
  }
  return value;
}

function requireSafeSegment(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw new PortableWorkspaceBackupError(
      `Portable Workspace ${field} is invalid.`,
    );
  }
  return value;
}

function requireCommit(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new PortableWorkspaceBackupError(
      `Portable Workspace ${field} is invalid.`,
    );
  }
  return value;
}

function requireWorktreeRoot(value: unknown, worktreesRoot: string) {
  if (typeof value !== "string") {
    throw new PortableWorkspaceBackupError(
      "Portable Workspace worktreeRoot is invalid.",
    );
  }
  const resolved = path.resolve(value);
  const relative = path.relative(worktreesRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PortableWorkspaceBackupError(
      "Portable Workspace worktreeRoot is outside managed storage.",
    );
  }
  return resolved;
}

function requireSafeRelativePath(value: string) {
  const normalized = path.posix.normalize(value.replaceAll(path.sep, "/"));
  if (
    !normalized ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.isAbsolute(value)
  ) {
    throw new PortableWorkspaceBackupError(
      "Portable Workspace untracked path is invalid.",
    );
  }
}

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function gitRaw(cwd: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}
