import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WorkspaceRequestError } from "./security.js";

const execFileAsync = promisify(execFile);

export async function readThreadWorkspaceHead(
  workspaceRoot: string,
  threadId: string,
) {
  const sourceRepoRoot = await git(workspaceRoot, [
    "rev-parse",
    "--show-toplevel",
  ]).then((value) => realpath(value));
  const worktreesRoot = path.join(
    workspaceRoot,
    ".kestrel",
    "runner",
    "worktrees",
  );
  const repoHash = shortHash(sourceRepoRoot, 12);
  const bindingHash = shortHash(`threadId:${threadId}`, 16);
  const bindingKey = shortHash(
    [sourceRepoRoot, "threadId", threadId].join("\0"),
    24,
  );
  const registryPath = path.join(
    worktreesRoot,
    repoHash,
    "bindings",
    `${bindingHash}.json`,
  );
  const raw = await readFile(registryPath, "utf8").catch(() => {});
  if (!raw) return git(sourceRepoRoot, ["rev-parse", "--verify", "HEAD"]);

  let registry: Record<string, unknown>;
  try {
    registry = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new WorkspaceRequestError(409, "WORKTREE_BINDING_INVALID");
  }
  const scope = asRecord(registry.scope);
  if (
    registry.bindingKey !== bindingKey ||
    registry.sourceRepoRoot !== sourceRepoRoot ||
    scope?.kind !== "threadId" ||
    scope.value !== threadId ||
    typeof registry.currentWorktreeRoot !== "string"
  ) {
    throw new WorkspaceRequestError(409, "WORKTREE_BINDING_INVALID");
  }
  const worktreeRoot = path.resolve(registry.currentWorktreeRoot);
  const repositoryWorktreesRoot = path.join(worktreesRoot, repoHash);
  const relative = path.relative(repositoryWorktreesRoot, worktreeRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceRequestError(409, "WORKTREE_BINDING_INVALID");
  }
  return git(worktreeRoot, ["rev-parse", "--verify", "HEAD"]).catch(() => {
    throw new WorkspaceRequestError(409, "WORKTREE_HEAD_UNAVAILABLE");
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function shortHash(value: string, length: number) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", cwd, ...args]);
  return result.stdout.trim();
}
