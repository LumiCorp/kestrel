import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type {
  WorkspaceChangeFile,
  WorkspaceChangeFileStatus,
  WorkspaceChangeMutation,
  WorkspaceChangeMutationResult,
  WorkspaceChangeScope,
  WorkspaceChangeSnapshot,
  WorkspaceDiffOptions,
  WorkspaceDiffHunk,
} from "./contracts.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

interface StatusEntry {
  path: string;
  previousPath?: string | undefined;
  status: WorkspaceChangeFileStatus;
  staged: boolean;
  unstaged: boolean;
}

export class WorkspaceChangeService {
  async inspect(input: {
    sessionId: string;
    threadId: string;
    workspaceRoot: string;
    scope: WorkspaceChangeScope;
    options?: Partial<WorkspaceDiffOptions> | undefined;
  }): Promise<WorkspaceChangeSnapshot> {
    const sessionId = identifier(input.sessionId, "sessionId");
    const threadId = identifier(input.threadId, "threadId");
    const workspaceRoot = await realpath(path.resolve(input.workspaceRoot));
    const repoRoot = await realpath(await git(workspaceRoot, ["rev-parse", "--show-toplevel"]));
    assertInside(workspaceRoot, repoRoot, "repoRoot");
    const scope = parseScope(input.scope);
    const options = parseOptions(input.options);
    const [headSha, currentBranch, upstream, statusRaw, stagedDiff, unstagedDiff] = await Promise.all([
      git(repoRoot, ["rev-parse", "--verify", "HEAD"]).catch(missingGitValue),
      git(repoRoot, ["branch", "--show-current"]).catch(missingGitValue),
      git(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(missingGitValue),
      gitRaw(repoRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
      gitRaw(repoRoot, ["diff", "--cached", "--binary", "--no-ext-diff", "--find-renames"]),
      gitRaw(repoRoot, ["diff", "--binary", "--no-ext-diff", "--find-renames"]),
    ]);
    const status = parsePorcelainV2(statusRaw);
    const workspaceFingerprint = await fingerprint(repoRoot, headSha, statusRaw, stagedDiff, unstagedDiff, status);
    const scoped = await scopeDiff(repoRoot, scope, stagedDiff, unstagedDiff, status, options);
    const candidateFingerprint = scoped.candidateSeed === undefined ? workspaceFingerprint : `sha256:${createHash("sha256").update(scoped.candidateSeed).digest("hex")}`;
    const diffBytes = Buffer.byteLength(scoped.diff, "utf8");
    const diff = diffBytes > MAX_DIFF_BYTES ? truncateUtf8(scoped.diff, MAX_DIFF_BYTES) : scoped.diff;
    const divergence = upstream === undefined
      ? { ahead: 0, behind: 0 }
      : parseDivergence(await git(repoRoot, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).catch(() => "0 0"));
    return {
      sessionId,
      threadId,
      workspaceRoot,
      repoRoot,
      scope,
      options,
      readOnly: scope.kind === "branch" || scope.kind === "commit" || scope.kind === "pull_request" || scope.kind === "latest_run" || scope.kind === "latest_turn" || scope.kind === "promotion",
      candidateFingerprint,
      ...(currentBranch ? { currentBranch } : {}),
      ...(headSha ? { headSha } : {}),
      ...(scoped.baseRef ? { baseRef: scoped.baseRef } : {}),
      ...(scoped.mergeBase ? { mergeBase: scoped.mergeBase } : {}),
      ...(scoped.pullRequest ? { pullRequest: scoped.pullRequest } : {}),
      ...(upstream ? { upstream } : {}),
      ...divergence,
      conflicted: status.some((entry) => entry.status === "conflicted"),
      files: mergeFiles(
        scope.kind === "unstaged" ||
          scope.kind === "staged" ||
          scope.kind === "uncommitted"
          ? status
          : statusFromDiff(scoped.diff),
        parseNumstat(scoped.numstat),
        scope,
      ),
      hunks: scoped.hunks,
      diff,
      diffBytes,
      truncated: diffBytes > MAX_DIFF_BYTES,
      generatedAt: new Date().toISOString(),
    };
  }

  async inspectPatch(input: { sessionId: string; threadId: string; workspaceRoot: string; scope: WorkspaceChangeScope; candidateFingerprint: string; diff: string; options?: Partial<WorkspaceDiffOptions> | undefined; generatedAt?: string | undefined }): Promise<WorkspaceChangeSnapshot> {
    const identity = await this.inspect({ sessionId: input.sessionId, threadId: input.threadId, workspaceRoot: input.workspaceRoot, scope: { kind: "uncommitted" } });
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.candidateFingerprint)) throw failure("WORKSPACE_CHANGE_INPUT_INVALID", "External candidate fingerprint is invalid.");
    const options = parseOptions(input.options); const diffBytes = Buffer.byteLength(input.diff, "utf8"); const diff = diffBytes > MAX_DIFF_BYTES ? truncateUtf8(input.diff, MAX_DIFF_BYTES) : input.diff; const numstat = parseNumstat(numstatFromDiff(input.diff));
    return { ...identity, scope: parseScope(input.scope), options, readOnly: true, candidateFingerprint: input.candidateFingerprint, files: mergeFiles(statusFromDiff(input.diff), numstat, input.scope), hunks: parseHunks(diff, "committed"), diff, diffBytes, truncated: diffBytes > MAX_DIFF_BYTES, generatedAt: input.generatedAt ?? new Date().toISOString() };
  }

  async inspectGitRange(input: { sessionId: string; threadId: string; workspaceRoot: string; scope: WorkspaceChangeScope; baseRef: string; targetRef?: string | undefined; candidateFingerprint?: string | undefined; options?: Partial<WorkspaceDiffOptions> | undefined }): Promise<WorkspaceChangeSnapshot> {
    const workspaceRoot = await realpath(path.resolve(input.workspaceRoot)); const repoRoot = await realpath(await git(workspaceRoot, ["rev-parse", "--show-toplevel"])); assertInside(workspaceRoot, repoRoot, "repoRoot"); const baseRef = gitRef(input.baseRef, "baseRef"); await git(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]); const options = parseOptions(input.options); const flags = diffOptionArgs(options);
    let diff: string;
    if (input.targetRef) { const targetRef = gitRef(input.targetRef, "targetRef"); await git(repoRoot, ["rev-parse", "--verify", `${targetRef}^{commit}`]); diff = await gitRaw(repoRoot, ["diff", "--binary", "--find-renames", ...flags, baseRef, targetRef]); }
    else { const status = parsePorcelainV2(await gitRaw(repoRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])); const tracked = await gitRaw(repoRoot, ["diff", "--binary", "--find-renames", ...flags, baseRef]); const untracked = await untrackedDiff(repoRoot, status, flags); diff = [tracked, untracked.diff].filter(Boolean).join("\n"); }
    const candidateFingerprint = input.candidateFingerprint ?? `sha256:${createHash("sha256").update(`${input.scope.kind}\0${baseRef}\0${input.targetRef ?? "working"}\0${diff}`).digest("hex")}`;
    return this.inspectPatch({ ...input, workspaceRoot, candidateFingerprint, diff, options });
  }

  async mutate(input: {
    sessionId: string;
    threadId: string;
    workspaceRoot: string;
    expectedFingerprint: string;
    mutation: WorkspaceChangeMutation;
    scope?: WorkspaceChangeScope | undefined;
    options?: Partial<WorkspaceDiffOptions> | undefined;
  }): Promise<WorkspaceChangeMutationResult> {
    const scope = input.scope ?? { kind: "uncommitted" };
    const before = await this.inspect({ ...input, scope });
    if (scope.kind === "branch" || scope.kind === "commit" || scope.kind === "pull_request" || scope.kind === "latest_run" || scope.kind === "latest_turn" || scope.kind === "promotion") throw failure("WORKSPACE_CHANGE_SCOPE_READ_ONLY", "This historical diff scope is read-only. Select a working-tree scope before changing Git state.");
    if (before.candidateFingerprint !== input.expectedFingerprint) {
      throw failure("WORKSPACE_CHANGE_STALE", "The workspace changed after this diff was loaded. Refresh before modifying Git state.", {
        expectedFingerprint: input.expectedFingerprint,
        actualFingerprint: before.candidateFingerprint,
      });
    }
    const mutation = parseMutation(input.mutation);
    const changed = before.files.find((file) => file.path === mutation.path);
    if (changed === undefined) {
      throw failure("WORKSPACE_CHANGE_PATH_STALE", "The selected changed file is no longer part of this candidate.", { path: mutation.path });
    }
    if (mutation.operation === "stage_hunk" || mutation.operation === "unstage_hunk" || mutation.operation === "revert_hunk") {
      const hunk = before.hunks.find((candidate) => candidate.hunkId === mutation.hunkId && candidate.filePath === mutation.path);
      if (hunk === undefined) throw failure("WORKSPACE_CHANGE_HUNK_STALE", "The selected hunk is no longer part of this candidate.", { path: mutation.path, hunkId: mutation.hunkId });
      const expectedOrigin = mutation.operation === "unstage_hunk" ? "staged" : "unstaged";
      if (hunk.origin !== expectedOrigin) throw failure("WORKSPACE_CHANGE_HUNK_ORIGIN_INVALID", "The selected hunk cannot be used for this operation.", { operation: mutation.operation, origin: hunk.origin });
      if (changed.status === "untracked") throw failure("WORKSPACE_CHANGE_UNTRACKED_HUNK_UNSUPPORTED", "Stage the complete untracked file before selecting individual hunks.", { path: mutation.path });
      const applicable = await currentApplicableHunks(before.repoRoot, hunk.origin, before.options);
      const patch = applicable.find((candidate) => candidate.hunk.hunkId === hunk.hunkId && candidate.hunk.filePath === mutation.path)?.patch;
      if (patch === undefined) throw failure("WORKSPACE_CHANGE_HUNK_STALE", "The selected hunk changed before it could be applied.", { path: mutation.path, hunkId: mutation.hunkId });
      await applyPatch(before.repoRoot, patch, mutation.operation === "stage_hunk" ? ["--cached"] : mutation.operation === "unstage_hunk" ? ["--cached", "--reverse"] : ["--reverse"]);
    } else if (mutation.operation === "stage_file") {
      await git(before.repoRoot, ["add", "--", mutation.path]);
    } else if (mutation.operation === "unstage_file") {
      await git(before.repoRoot, ["restore", "--staged", "--", mutation.path]);
    } else {
      if (changed.status === "untracked") {
        throw failure("WORKSPACE_CHANGE_UNTRACKED_REVERT_UNSUPPORTED", "Untracked files require a separately confirmed cleanup action.", { path: mutation.path });
      }
      await git(before.repoRoot, ["restore", "--worktree", "--", mutation.path]);
    }
    return {
      operation: mutation.operation,
      previousFingerprint: before.candidateFingerprint,
      snapshot: await this.inspect({ ...input, scope }),
    };
  }
}

async function scopeDiff(repoRoot: string, scope: WorkspaceChangeScope, stagedDefault: string, unstagedDefault: string, status: StatusEntry[], options: WorkspaceDiffOptions): Promise<{ diff: string; numstat: string; hunks: WorkspaceDiffHunk[]; baseRef?: string; mergeBase?: string; candidateSeed?: string; pullRequest?: { number: number; url: string; baseSha: string; headSha: string } }> {
  if (scope.kind === "latest_run" || scope.kind === "latest_turn" || scope.kind === "promotion") throw failure("WORKSPACE_CHANGE_SCOPE_UNRESOLVED", "This diff scope must be resolved by Local Core workspace authority.");
  const flags = diffOptionArgs(options);
  const staged = options.contextLines === 3 && options.whitespace === "show" ? stagedDefault : await gitRaw(repoRoot, ["diff", "--cached", "--binary", "--no-ext-diff", "--find-renames", ...flags]);
  const unstaged = options.contextLines === 3 && options.whitespace === "show" ? unstagedDefault : await gitRaw(repoRoot, ["diff", "--binary", "--no-ext-diff", "--find-renames", ...flags]);
  if (scope.kind === "staged") return { diff: staged, numstat: await gitRaw(repoRoot, ["diff", "--cached", "--numstat", "--find-renames"]), hunks: parseHunks(staged, "staged") };
  if (scope.kind === "unstaged" || scope.kind === "uncommitted") {
    const untracked = await untrackedDiff(repoRoot, status, flags);
    const trackedNumstat = await gitRaw(repoRoot, ["diff", "--numstat", "--find-renames"]);
    return {
      diff: [scope.kind === "uncommitted" ? staged : "", unstaged, untracked.diff].filter(Boolean).join("\n"),
      numstat: [scope.kind === "uncommitted" ? await gitRaw(repoRoot, ["diff", "--cached", "--numstat", "--find-renames"]) : "", trackedNumstat, untracked.numstat].filter(Boolean).join("\n"),
      hunks: [...(scope.kind === "uncommitted" ? parseHunks(staged, "staged") : []), ...parseHunks(unstaged, "unstaged"), ...parseHunks(untracked.diff, "unstaged")],
    };
  }
  if (scope.kind === "commit") {
    await git(repoRoot, ["rev-parse", "--verify", `${scope.commitSha}^{commit}`]);
    const diff = await gitRaw(repoRoot, ["show", "--format=", "--binary", "--find-renames", ...flags, scope.commitSha]);
    return {
      diff,
      numstat: await gitRaw(repoRoot, ["show", "--format=", "--numstat", "--find-renames", scope.commitSha]),
      hunks: parseHunks(diff, "committed"), candidateSeed: `commit\0${scope.commitSha}\0${diff}`,
    };
  }
  if (scope.kind === "pull_request") {
    const selector = scope.number === undefined ? [] : [String(scope.number)];
    const details = JSON.parse(await gh(repoRoot, ["pr", "view", ...selector, "--json", "number,url,baseRefOid,headRefOid"])) as { number?: unknown; url?: unknown; baseRefOid?: unknown; headRefOid?: unknown };
    if (!Number.isInteger(details.number) || typeof details.url !== "string" || typeof details.baseRefOid !== "string" || typeof details.headRefOid !== "string") throw failure("WORKSPACE_CHANGE_PR_INVALID", "GitHub returned invalid pull request identity.");
    const diff = await ghRaw(repoRoot, ["pr", "diff", ...selector, "--patch"]);
    return { diff, numstat: numstatFromDiff(diff), hunks: parseHunks(diff, "committed"), candidateSeed: `pull_request\0${details.number}\0${details.baseRefOid}\0${details.headRefOid}\0${diff}`, pullRequest: { number: details.number as number, url: details.url, baseSha: details.baseRefOid, headSha: details.headRefOid } };
  }
  await git(repoRoot, ["rev-parse", "--verify", `${scope.baseRef}^{commit}`]);
  const mergeBase = await git(repoRoot, ["merge-base", scope.baseRef, "HEAD"]);
  const diff = await gitRaw(repoRoot, ["diff", "--binary", "--find-renames", ...flags, mergeBase, "HEAD"]);
  return {
    diff,
    numstat: await gitRaw(repoRoot, ["diff", "--numstat", "--find-renames", mergeBase, "HEAD"]),
    hunks: parseHunks(diff, "committed"),
    candidateSeed: `branch\0${scope.baseRef}\0${mergeBase}\0${diff}`,
    baseRef: scope.baseRef,
    mergeBase,
  };
}

async function untrackedDiff(repoRoot: string, status: StatusEntry[], flags: string[] = []): Promise<{ diff: string; numstat: string }> {
  const diffs: string[] = [];
  const stats: string[] = [];
  let bytes = 0;
  for (const entry of status.filter((item) => item.status === "untracked").sort((a, b) => a.path.localeCompare(b.path))) {
    const args = ["diff", "--no-index", "--binary", "--no-ext-diff", ...flags, "--", process.platform === "win32" ? "NUL" : "/dev/null", entry.path];
    const output = await gitExpectedDifference(repoRoot, args);
    const outputBytes = Buffer.byteLength(output, "utf8");
    if (bytes + outputBytes <= MAX_DIFF_BYTES) {
      diffs.push(output);
      bytes += outputBytes;
    } else {
      diffs.push(`diff --git a/${entry.path} b/${entry.path}\nBinary or oversized untracked file ${entry.path} is not rendered.\n`);
    }
    stats.push(await gitExpectedDifference(repoRoot, ["diff", "--no-index", "--numstat", "--", process.platform === "win32" ? "NUL" : "/dev/null", entry.path]));
  }
  return { diff: diffs.join("\n"), numstat: stats.join("\n") };
}

async function fingerprint(repoRoot: string, headSha: string | undefined, statusRaw: string, staged: string, unstaged: string, status: StatusEntry[]): Promise<string> {
  const hash = createHash("sha256");
  for (const value of [headSha ?? "unborn", statusRaw, staged, unstaged]) hash.update(value).update("\0");
  for (const entry of status.filter((item) => item.status === "untracked").sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path).update("\0");
    const absolute = path.join(repoRoot, entry.path); const stat = await lstat(absolute); hash.update(String(stat.mode)).update("\0");
    hash.update(stat.isSymbolicLink() ? await readlink(absolute) : await git(repoRoot, ["hash-object", "--", entry.path])).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function parsePorcelainV2(raw: string): StatusEntry[] {
  const parts = raw.split("\0");
  const result: StatusEntry[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index];
    if (!line) continue;
    if (line.startsWith("? ")) {
      result.push({ path: normalizeGitPath(line.slice(2)), status: "untracked", staged: false, unstaged: true });
      continue;
    }
    if (line.startsWith("u ")) {
      const fields = line.split(" ");
      result.push({ path: normalizeGitPath(fields.slice(10).join(" ")), status: "conflicted", staged: true, unstaged: true });
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const renamed = line.startsWith("2 ");
      const fields = line.split(" ");
      const xy = fields[1] ?? "..";
      const filePath = normalizeGitPath(fields.slice(renamed ? 9 : 8).join(" "));
      const previousPath = renamed ? normalizeGitPath(parts[++index] ?? "") : undefined;
      result.push({ path: filePath, ...(previousPath ? { previousPath } : {}), status: statusFromXY(xy, renamed), staged: xy[0] !== ".", unstaged: xy[1] !== "." });
    }
  }
  return result;
}

function statusFromXY(xy: string, renamed: boolean): WorkspaceChangeFileStatus {
  if (renamed || xy.includes("R")) return "renamed";
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("C")) return "copied";
  if (xy.includes("M") || xy.includes("T")) return "modified";
  return "unknown";
}

function parseNumstat(raw: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of raw.split("\n")) {
    const [added, deleted, ...rest] = line.split("\t");
    const filePath = normalizeNumstatPath(rest.at(-1));
    if (!filePath) continue;
    const binary = added === "-" || deleted === "-";
    const current = result.get(filePath) ?? { additions: 0, deletions: 0, binary: false };
    result.set(filePath, {
      additions: current.additions + (binary ? 0 : Number(added) || 0),
      deletions: current.deletions + (binary ? 0 : Number(deleted) || 0),
      binary: current.binary || binary,
    });
  }
  return result;
}

function normalizeNumstatPath(value: string | undefined): string | undefined {
  if (!(value && value.includes(" => "))) return value;
  const braceStart = value.indexOf("{");
  const braceEnd = value.indexOf("}", braceStart + 1);
  if (braceStart >= 0 && braceEnd > braceStart) {
    const replacement = value
      .slice(braceStart + 1, braceEnd)
      .split(" => ")
      .at(-1);
    return replacement === undefined
      ? value
      : `${value.slice(0, braceStart)}${replacement}${value.slice(braceEnd + 1)}`;
  }
  return value.split(" => ").at(-1);
}

function missingGitValue(): undefined {
  return;
}

function statusFromDiff(diff: string): StatusEntry[] {
  const result: StatusEntry[] = [];
  let current:
    | {
        oldPath?: string | undefined;
        path?: string | undefined;
        status: WorkspaceChangeFileStatus;
      }
    | undefined;
  const finish = () => {
    if (!current?.path) return;
    result.push({
      path: current.path,
      ...(current.oldPath && current.oldPath !== current.path
        ? { previousPath: current.oldPath }
        : {}),
      status: current.status,
      staged: false,
      unstaged: false,
    });
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      current = { status: "modified" };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode ")) current.status = "added";
    else if (line.startsWith("deleted file mode ")) current.status = "deleted";
    else if (line.startsWith("rename from ")) {
      current.oldPath = normalizeGitPath(line.slice("rename from ".length));
      current.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      current.path = normalizeGitPath(line.slice("rename to ".length));
      current.status = "renamed";
    } else if (line.startsWith("--- a/") && !current.oldPath) {
      current.oldPath = normalizeGitPath(line.slice(6));
    } else if (line.startsWith("+++ b/") && !current.path) {
      current.path = normalizeGitPath(line.slice(6));
    } else if (line === "+++ /dev/null" && current.oldPath) {
      current.path = current.oldPath;
      current.status = "deleted";
    }
  }
  finish();
  return result;
}

function mergeFiles(status: StatusEntry[], numstat: Map<string, { additions: number; deletions: number; binary: boolean }>, scope: WorkspaceChangeScope): WorkspaceChangeFile[] {
  const include = (entry: StatusEntry) => scope.kind === "unstaged" ? entry.unstaged : scope.kind === "staged" ? entry.staged : true;
  const workingScope = scope.kind === "unstaged" || scope.kind === "staged" || scope.kind === "uncommitted";
  const byPath = new Map(
    (workingScope ? status.filter(include) : status).map((entry) => [
      entry.path,
      entry,
    ]),
  );
  for (const filePath of numstat.keys()) {
    if (!byPath.has(filePath)) byPath.set(filePath, { path: filePath, status: "modified", staged: scope.kind === "staged", unstaged: scope.kind === "unstaged" });
  }
  return [...byPath.values()].map((entry) => ({
    ...entry,
    ...(numstat.get(entry.path) ?? { additions: 0, deletions: 0, binary: false }),
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function parseHunks(diff: string, origin: WorkspaceDiffHunk["origin"]): WorkspaceDiffHunk[] {
  const result: WorkspaceDiffHunk[] = [];
  let filePath = "";
  let current: WorkspaceDiffHunk | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) filePath = normalizeGitPath(line.slice(6));
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (match) {
      current = {
        hunkId: createHash("sha256").update(`${origin}\0${filePath}\0${line}`).digest("hex").slice(0, 24),
        filePath,
        header: line,
        lines: [],
        oldStart: Number(match[1]),
        newStart: Number(match[2]),
        origin,
      };
      result.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return result;
}

function parseScope(scope: WorkspaceChangeScope): WorkspaceChangeScope {
  if (scope?.kind === "unstaged" || scope?.kind === "staged" || scope?.kind === "uncommitted") return { kind: scope.kind };
  if (scope?.kind === "branch") return { kind: "branch", baseRef: gitRef(scope.baseRef, "baseRef") };
  if (scope?.kind === "commit") return { kind: "commit", commitSha: gitRef(scope.commitSha, "commitSha") };
  if (scope?.kind === "pull_request") { if (scope.number !== undefined && (!Number.isInteger(scope.number) || scope.number <= 0)) throw failure("WORKSPACE_CHANGE_SCOPE_INVALID", "Pull request number is invalid."); return { kind: "pull_request", ...(scope.number !== undefined ? { number: scope.number } : {}) }; }
  if (scope?.kind === "latest_run") return { kind: "latest_run", ...(scope.runId ? { runId: identifier(scope.runId, "runId") } : {}) };
  if (scope?.kind === "latest_turn") return { kind: "latest_turn", ...(scope.turnId ? { turnId: identifier(scope.turnId, "turnId") } : {}) };
  if (scope?.kind === "promotion") return { kind: "promotion", promotionId: identifier(scope.promotionId, "promotionId") };
  throw failure("WORKSPACE_CHANGE_SCOPE_INVALID", "Diff scope is invalid.");
}

function parseMutation(value: WorkspaceChangeMutation): WorkspaceChangeMutation {
  if (!(value && ["stage_file", "unstage_file", "revert_file", "stage_hunk", "unstage_hunk", "revert_hunk"].includes(value.operation))) throw failure("WORKSPACE_CHANGE_MUTATION_INVALID", "Change mutation is invalid.");
  const filePath = normalizeGitPath(value.path);
  if (!filePath || path.isAbsolute(filePath) || filePath === ".." || filePath.startsWith("../") || filePath.includes("\0")) throw failure("WORKSPACE_CHANGE_PATH_INVALID", "Changed file path is invalid.");
  if ((value.operation === "stage_hunk" || value.operation === "unstage_hunk" || value.operation === "revert_hunk") && (typeof value.hunkId !== "string" || !/^[a-f0-9]{24}$/u.test(value.hunkId))) throw failure("WORKSPACE_CHANGE_HUNK_INVALID", "Changed hunk id is invalid.");
  if (value.operation === "revert_file" && value.confirmation !== "revert_file") throw failure("WORKSPACE_CHANGE_CONFIRMATION_REQUIRED", "Reverting a file requires explicit confirmation.", { path: filePath });
  if (value.operation === "revert_hunk" && value.confirmation !== "revert_hunk") throw failure("WORKSPACE_CHANGE_CONFIRMATION_REQUIRED", "Reverting a hunk requires explicit confirmation.", { path: filePath });
  return { ...value, path: filePath };
}

interface ApplicableHunk { hunk: WorkspaceDiffHunk; patch: string }

async function currentApplicableHunks(repoRoot: string, origin: "staged" | "unstaged", options: WorkspaceDiffOptions): Promise<ApplicableHunk[]> {
  const flags = diffOptionArgs(options);
  const diff = await gitRaw(repoRoot, origin === "staged"
    ? ["diff", "--cached", "--binary", "--no-ext-diff", "--find-renames", ...flags]
    : ["diff", "--binary", "--no-ext-diff", "--find-renames", ...flags]);
  return parseApplicableHunks(diff, origin);
}

function parseApplicableHunks(diff: string, origin: "staged" | "unstaged"): ApplicableHunk[] {
  const result: ApplicableHunk[] = [];
  let fileHeader: string[] = [];
  let filePath = "";
  let active: { hunk: WorkspaceDiffHunk; lines: string[] } | undefined;
  const finish = () => {
    if (!active) return;
    result.push({ hunk: active.hunk, patch: [...fileHeader, active.hunk.header, ...active.lines, ""].join("\n") });
    active = undefined;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      fileHeader = [line];
      filePath = "";
      continue;
    }
    if (line.startsWith("+++ b/")) filePath = normalizeGitPath(line.slice(6));
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (match) {
      finish();
      active = { hunk: { hunkId: createHash("sha256").update(`${origin}\0${filePath}\0${line}`).digest("hex").slice(0, 24), filePath, header: line, lines: [], oldStart: Number(match[1]), newStart: Number(match[2]), origin }, lines: [] };
    } else if (active) {
      active.lines.push(line);
      active.hunk.lines.push(line);
    } else if (fileHeader.length > 0) {
      fileHeader.push(line);
    }
  }
  finish();
  return result;
}

async function applyPatch(repoRoot: string, patch: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", repoRoot, "apply", "--whitespace=nowarn", ...args, "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(failure("WORKSPACE_CHANGE_HUNK_APPLY_FAILED", "Git could not apply the selected hunk safely.", { exitCode: code, stderr: Buffer.concat(stderr).toString("utf8").slice(0, 2000) })));
    child.stdin.end(patch);
  });
}

function normalizeGitPath(value: string): string { return value.replaceAll("\\", "/").trim(); }
function parseOptions(value: Partial<WorkspaceDiffOptions> | undefined): WorkspaceDiffOptions {
  const contextLines = value?.contextLines ?? 3;
  const whitespace = value?.whitespace ?? "show";
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 100) throw failure("WORKSPACE_CHANGE_OPTIONS_INVALID", "Diff context must be an integer between 0 and 100.");
  if (whitespace !== "show" && whitespace !== "ignore_all" && whitespace !== "ignore_eol") throw failure("WORKSPACE_CHANGE_OPTIONS_INVALID", "Diff whitespace mode is invalid.");
  return { contextLines, whitespace };
}
function diffOptionArgs(options: WorkspaceDiffOptions): string[] { return [`--unified=${options.contextLines}`, ...(options.whitespace === "ignore_all" ? ["--ignore-all-space"] : options.whitespace === "ignore_eol" ? ["--ignore-space-at-eol"] : [])]; }
function numstatFromDiff(diff: string): string { const counts = new Map<string, { add: number; del: number }>(); let filePath = ""; for (const line of diff.split("\n")) { if (line.startsWith("+++ b/")) { filePath = normalizeGitPath(line.slice(6)); if (!counts.has(filePath)) counts.set(filePath, { add: 0, del: 0 }); } else if (filePath && line.startsWith("+") && !line.startsWith("+++")) counts.get(filePath)!.add += 1; else if (filePath && line.startsWith("-") && !line.startsWith("---")) counts.get(filePath)!.del += 1; } return [...counts].map(([file, count]) => `${count.add}\t${count.del}\t${file}`).join("\n"); }
function identifier(value: string, label: string): string { if (typeof value !== "string" || !value.trim() || value.length > 256) throw failure("WORKSPACE_CHANGE_INPUT_INVALID", `${label} is invalid.`); return value.trim(); }
function gitRef(value: string, label: string): string { if (typeof value !== "string" || !value.trim() || value.length > 512 || value.startsWith("-")) throw failure("WORKSPACE_CHANGE_INPUT_INVALID", `${label} is invalid.`); return value.trim(); }
function assertInside(root: string, candidate: string, label: string): void { const relative = path.relative(root, candidate); if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) throw failure("WORKSPACE_CHANGE_ROOT_INVALID", `${label} escapes the workspace.`); }
function parseDivergence(raw: string): { ahead: number; behind: number } { const values = raw.trim().split(/\s+/u).map(Number); const behind = values[0] ?? 0; const ahead = values[1] ?? 0; return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 }; }
function truncateUtf8(value: string, bytes: number): string { let end = Math.min(value.length, bytes); while (Buffer.byteLength(value.slice(0, end), "utf8") > bytes) end -= 1; return value.slice(0, end); }
async function git(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
async function gitRaw(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout; }
async function gh(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("gh", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
async function ghRaw(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("gh", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout; }
async function gitExpectedDifference(cwd: string, args: string[]): Promise<string> {
  try {
    return await gitRaw(cwd, args);
  } catch (cause) {
    const error = cause as { code?: number | string; stdout?: string };
    if (error.code === 1 && typeof error.stdout === "string") return error.stdout;
    if (typeof error.stdout === "string" && error.stdout.length > 0) return error.stdout;
    throw cause;
  }
}
function failure(code: string, message: string, details: Record<string, unknown> = {}): Error { return createRuntimeFailure(code, message, { subsystem: "workspace", classification: "state", recoverable: true, ...details }); }
