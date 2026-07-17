import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { ProductTaskGraph } from "../taskGraph/contracts.js";
import type {
  ProductProjectAction,
  ProductReviewAction,
  ProductReviewChangedFile,
  ProductReviewCheckRun,
  ProductReviewComment,
  ProductReviewDetail,
  ProductReviewDiffHunk,
  ProductProjectSetupState,
  ProductReviewSnapshot,
  ProductReviewTarget,
} from "./contracts.js";

const execFileAsync = promisify(execFile);

export interface ProjectWorkspaceCommandRunner {
  run(command: string, args: string[], cwd: string, env?: Record<string, string | undefined>): Promise<string>;
}

export class DefaultProjectWorkspaceCommandRunner implements ProjectWorkspaceCommandRunner {
  async run(command: string, args: string[], cwd: string, env?: Record<string, string | undefined>): Promise<string> {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      env: env === undefined ? process.env : { ...process.env, ...env },
      maxBuffer: 1024 * 1024 * 8,
    });
    return result.stdout;
  }
}

export class ProductProjectWorkspaceService {
  private readonly runner: ProjectWorkspaceCommandRunner;

  constructor(runner: ProjectWorkspaceCommandRunner = new DefaultProjectWorkspaceCommandRunner()) {
    this.runner = runner;
  }

  async inspectReviewState(
    setup: ProductProjectSetupState,
    graph: ProductTaskGraph,
  ): Promise<ProductReviewSnapshot> {
    if (setup.repoRoot.trim().length === 0) {
      return {
        branches: [],
        worktrees: [],
        pullRequests: [],
        recentCommits: [],
      };
    }
    const repoRoot = setup.repoRoot;
    const [currentBranch, statusSummary, branchesRaw, worktreesRaw, commitsRaw, pullRequestsRaw] = await Promise.all([
      this.safeGit(repoRoot, ["branch", "--show-current"]),
      this.safeGit(repoRoot, ["status", "--short", "--branch"]),
      this.safeGit(repoRoot, ["for-each-ref", "refs/heads", "--format=%(refname:short)|%(HEAD)"]),
      this.safeGit(repoRoot, ["worktree", "list", "--porcelain"]),
      this.safeGit(repoRoot, ["log", "--oneline", "-n", "8"]),
      this.safeGithubPullRequests(setup, repoRoot),
    ]);

    return {
      repoRoot,
      ...(currentBranch !== undefined ? { currentBranch } : {}),
      ...(statusSummary !== undefined ? { statusSummary } : {}),
      branches: parseBranchSummaries(branchesRaw),
      worktrees: parseWorktrees(worktreesRaw, repoRoot),
      recentCommits:
        commitsRaw
          ?.split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => {
            const firstSpace = line.indexOf(" ");
            return {
              sha: firstSpace > 0 ? line.slice(0, firstSpace) : line,
              summary: firstSpace > 0 ? line.slice(firstSpace + 1) : line,
            };
          }) ?? [],
      pullRequests: pullRequestsRaw ?? deriveTaskPullRequests(graph),
    };
  }

  async inspectReviewDetail(input: {
    setup: ProductProjectSetupState;
    graph: ProductTaskGraph;
    target: ProductReviewTarget;
  }): Promise<ProductReviewDetail> {
    const { setup, graph, target } = input;
    if (setup.repoRoot.trim().length === 0) {
      return {
        target,
        changedFiles: [],
        diffHunks: [],
        recentCommits: [],
        checks: [],
        comments: [],
      };
    }

    const task = target.taskId !== undefined ? graph.tasks[target.taskId] : undefined;
    const repoRoot = setup.repoRoot;
    const worktreePath = target.worktreePath ?? task?.linkedWorktree ?? repoRoot;
    const branchName = target.branchName ?? task?.linkedBranch ?? (await this.safeGit(worktreePath, ["branch", "--show-current"]));
    const rangeBase = target.pullRequestNumber !== undefined || branchName !== undefined
      ? `${setup.defaultBranch || "main"}...HEAD`
      : "HEAD";
    const [changedFilesRaw, commitsRaw, diffRaw, prDetail] = await Promise.all([
      this.safeGit(worktreePath, ["diff", "--name-status", "--find-renames", rangeBase]),
      this.safeGit(worktreePath, ["log", "--oneline", "-n", "12"]),
      this.safeGit(
        worktreePath,
        target.filePath !== undefined
          ? ["diff", "--unified=3", rangeBase, "--", target.filePath]
          : ["diff", "--unified=3", rangeBase],
      ),
      this.safeGithubPullRequestDetail(setup, worktreePath, target.pullRequestNumber ?? task?.linkedPullRequest?.number),
    ]);

    const changedFiles = prDetail?.changedFiles ?? parseChangedFiles(changedFilesRaw);
    const selectedFilePath = target.filePath
      ?? changedFiles[0]?.path;
    const selectedDiffRaw = selectedFilePath !== undefined && target.filePath === undefined
      ? await this.safeGit(worktreePath, ["diff", "--unified=3", rangeBase, "--", selectedFilePath])
      : diffRaw;

    return {
      target,
      repoRoot,
      ...(branchName !== undefined ? { branchName } : {}),
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(prDetail?.pullRequestNumber !== undefined ? { pullRequestNumber: prDetail.pullRequestNumber } : {}),
      ...(prDetail?.pullRequestTitle !== undefined ? { pullRequestTitle: prDetail.pullRequestTitle } : {}),
      ...(prDetail?.pullRequestState !== undefined ? { pullRequestState: prDetail.pullRequestState } : {}),
      ...(prDetail?.pullRequestUrl !== undefined ? { pullRequestUrl: prDetail.pullRequestUrl } : {}),
      ...(prDetail?.baseBranch !== undefined ? { baseBranch: prDetail.baseBranch } : { baseBranch: setup.defaultBranch || "main" }),
      ...(prDetail?.headSha !== undefined ? { headSha: prDetail.headSha } : {}),
      ...(prDetail?.mergeState !== undefined ? { mergeState: prDetail.mergeState } : {}),
      ...(prDetail?.reviewDecision !== undefined ? { reviewDecision: prDetail.reviewDecision } : {}),
      ...(selectedFilePath !== undefined ? { selectedFilePath } : {}),
      changedFiles,
      diffHunks: parseDiffHunks(selectedDiffRaw),
      recentCommits: parseCommits(commitsRaw),
      checks: prDetail?.checks ?? [],
      comments: prDetail?.comments ?? [],
    };
  }

  async applyAction(input: {
    action: ProductProjectAction;
    setup: ProductProjectSetupState;
  }): Promise<void> {
    const repoRoot = input.setup.repoRoot;
    if (repoRoot.trim().length === 0) {
      throw projectWorkspaceError("PROJECT_REPO_ROOT_MISSING", "Project repo root is not configured.");
    }
    const action = input.action;

    if (action.type === "branch.create") {
      if (action.branchName === undefined || action.branchName.trim().length === 0) {
        throw projectWorkspaceError("PROJECT_BRANCH_INPUT_INVALID", "branch.create requires branchName");
      }
      await this.runner.run("git", ["checkout", "-b", action.branchName], repoRoot);
      return;
    }
    if (action.type === "branch.switch") {
      if (action.branchName === undefined || action.branchName.trim().length === 0) {
        throw projectWorkspaceError("PROJECT_BRANCH_INPUT_INVALID", "branch.switch requires branchName");
      }
      await this.runner.run("git", ["checkout", action.branchName], repoRoot);
      return;
    }
    if (action.type === "worktree.create") {
      if (action.targetPath === undefined || action.targetPath.trim().length === 0 || action.branchName === undefined) {
        throw projectWorkspaceError("PROJECT_WORKTREE_INPUT_INVALID", "worktree.create requires targetPath and branchName");
      }
      await this.runner.run("git", ["worktree", "add", action.targetPath, action.branchName], repoRoot);
      return;
    }
    if (action.type === "commit.create") {
      if (action.message === undefined || action.message.trim().length === 0) {
        throw projectWorkspaceError("PROJECT_COMMIT_INPUT_INVALID", "commit.create requires message");
      }
      await this.runner.run("git", ["add", "-A"], repoRoot);
      await this.runner.run("git", ["commit", "-m", action.message], repoRoot);
      return;
    }
    if (action.type === "git.push") {
      const branch = action.branchName?.trim().length ? action.branchName : await this.safeGit(repoRoot, ["branch", "--show-current"]);
      await this.runner.run("git", ["push", "--set-upstream", "origin", branch ?? "HEAD"], repoRoot);
      return;
    }
    if (action.type === "pull_request.create") {
      if (action.title === undefined || action.title.trim().length === 0) {
        throw projectWorkspaceError("PROJECT_PULL_REQUEST_INPUT_INVALID", "pull_request.create requires title");
      }
      const args = ["pr", "create", "--title", action.title];
      if (action.body !== undefined) {
        args.push("--body", action.body);
      }
      if (action.baseBranch !== undefined) {
        args.push("--base", action.baseBranch);
      }
      if (action.branchName !== undefined) {
        args.push("--head", action.branchName);
      }
      await this.runner.run("gh", args, repoRoot);
      return;
    }
    if (action.type === "pull_request.merge") {
      if (typeof action.pullRequestNumber !== "number") {
        throw projectWorkspaceError("PROJECT_PULL_REQUEST_INPUT_INVALID", "pull_request.merge requires pullRequestNumber");
      }
      await this.runner.run("gh", ["pr", "merge", String(action.pullRequestNumber), "--merge"], repoRoot);
    }
  }

  async applyReviewAction(input: {
    action: ProductReviewAction;
    setup: ProductProjectSetupState;
  }): Promise<void> {
    const repoRoot = input.setup.repoRoot;
    if (repoRoot.trim().length === 0) {
      throw projectWorkspaceError("PROJECT_REPO_ROOT_MISSING", "Project repo root is not configured.");
    }
    const action = input.action;
    if (action.type === "review.refresh") {
      return;
    }
    if (action.type === "review.comment.create") {
      if (typeof action.body !== "string" || action.body.trim().length === 0) {
        throw projectWorkspaceError("PROJECT_REVIEW_COMMENT_INVALID", "review.comment.create requires body");
      }
      if (typeof action.target.pullRequestNumber !== "number") {
        throw projectWorkspaceError("PROJECT_REVIEW_TARGET_INVALID", "review.comment.create requires pullRequestNumber");
      }
      if (action.path !== undefined && typeof action.line === "number" && Number.isFinite(action.line) && action.line > 0) {
        if (
          typeof input.setup.githubOwner !== "string" ||
          input.setup.githubOwner.trim().length === 0 ||
          typeof input.setup.githubRepo !== "string" ||
          input.setup.githubRepo.trim().length === 0
        ) {
          throw projectWorkspaceError("PROJECT_GITHUB_REPO_MISSING", "File-scoped review comments require githubOwner and githubRepo.");
        }
        const commitSha = await this.safeGit(repoRoot, ["rev-parse", "HEAD"]);
        if (commitSha === undefined) {
          throw projectWorkspaceError("PROJECT_REVIEW_COMMENT_INVALID", "Unable to determine HEAD commit for file-scoped review comment.");
        }
        await this.runner.run(
          "gh",
          [
            "api",
            `repos/${input.setup.githubOwner}/${input.setup.githubRepo}/pulls/${action.target.pullRequestNumber}/comments`,
            "-f",
            `body=${action.body}`,
            "-f",
            `commit_id=${commitSha}`,
            "-f",
            `path=${action.path}`,
            "-F",
            `line=${action.line}`,
            ...(action.side !== undefined ? ["-f", `side=${action.side}`] : []),
          ],
          repoRoot,
        );
        return;
      }
      await this.runner.run("gh", ["pr", "comment", String(action.target.pullRequestNumber), "--body", action.body], repoRoot);
    }
  }

  private async safeGit(repoRoot: string, args: string[]): Promise<string | undefined> {
    try {
      const output = await this.runner.run("git", args, repoRoot);
      return output.trim();
    } catch {
      return ;
    }
  }

  private async safeGithubPullRequests(
    setup: ProductProjectSetupState,
    repoRoot: string,
  ): Promise<ProductReviewSnapshot["pullRequests"] | undefined> {
    if (setup.githubConnected !== true) {
      return ;
    }
    try {
      const output = await this.runner.run(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "all",
          "--json",
          "number,title,headRefName,baseRefName,state,url",
        ],
        repoRoot,
      );
      const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
      return normalizePullRequestSummaries(parsed);
    } catch {
      return ;
    }
  }

  private async safeGithubPullRequestDetail(
    setup: ProductProjectSetupState,
    repoRoot: string,
    pullRequestNumber?: number,
  ): Promise<{
    pullRequestNumber?: number;
    pullRequestTitle?: string;
    pullRequestState?: "OPEN" | "MERGED" | "CLOSED";
    pullRequestUrl?: string;
    baseBranch?: string;
    headSha?: string;
    mergeState?: string;
    reviewDecision?: string;
    changedFiles?: ProductReviewChangedFile[];
    checks?: ProductReviewCheckRun[];
    comments?: ProductReviewComment[];
  } | undefined> {
    if (setup.githubConnected !== true || typeof pullRequestNumber !== "number") {
      return ;
    }
    try {
      const output = await this.runner.run(
        "gh",
        [
          "pr",
          "view",
          String(pullRequestNumber),
          "--json",
          "number,title,state,url,baseRefName,headRefOid,mergeStateStatus,reviewDecision,files,statusCheckRollup,comments,reviews",
        ],
        repoRoot,
      );
      const record = JSON.parse(output) as Record<string, unknown>;
      return {
        ...(typeof record.number === "number" ? { pullRequestNumber: record.number } : {}),
        ...(typeof record.title === "string" ? { pullRequestTitle: record.title } : {}),
        ...(record.state === "OPEN" || record.state === "MERGED" || record.state === "CLOSED" ? { pullRequestState: record.state } : {}),
        ...(typeof record.url === "string" ? { pullRequestUrl: record.url } : {}),
        ...(typeof record.baseRefName === "string" ? { baseBranch: record.baseRefName } : {}),
        ...(typeof record.headRefOid === "string" ? { headSha: record.headRefOid } : {}),
        ...(typeof record.mergeStateStatus === "string" ? { mergeState: record.mergeStateStatus } : {}),
        ...(typeof record.reviewDecision === "string" ? { reviewDecision: record.reviewDecision } : {}),
        changedFiles: Array.isArray(record.files) ? parseGithubFiles(record.files) : [],
        checks: Array.isArray(record.statusCheckRollup) ? parseGithubChecks(record.statusCheckRollup) : [],
        comments: [
          ...(Array.isArray(record.comments) ? parseGithubComments(record.comments, "COMMENT") : []),
          ...(Array.isArray(record.reviews) ? parseGithubComments(record.reviews, "REVIEW") : []),
        ],
      };
    } catch {
      return ;
    }
  }
}

function projectWorkspaceError(code: string, message: string) {
  return createRuntimeFailure(code, message, {
    subsystem: "runtime",
    classification: "policy",
  });
}

function parseBranchSummaries(raw: string | undefined): ProductReviewSnapshot["branches"] {
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  const branches: ProductReviewSnapshot["branches"] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const [name, isHead] = line.split("|");
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }
    branches.push({
      name,
      ...(isHead === "*" ? { current: true } : {}),
    });
  }
  return branches;
}

function normalizePullRequestSummaries(
  entries: Array<Record<string, unknown>>,
): ProductReviewSnapshot["pullRequests"] {
  const pullRequests: ProductReviewSnapshot["pullRequests"] = [];
  for (const entry of entries) {
    if (
      typeof entry.number !== "number" ||
      typeof entry.title !== "string" ||
      typeof entry.headRefName !== "string" ||
      typeof entry.baseRefName !== "string"
    ) {
      continue;
    }
    pullRequests.push({
      number: entry.number,
      title: entry.title,
      branch: entry.headRefName,
      baseBranch: entry.baseRefName,
      state:
        entry.state === "MERGED" || entry.state === "CLOSED"
          ? entry.state
          : "OPEN",
      ...(typeof entry.url === "string" ? { url: entry.url } : {}),
    });
  }
  return pullRequests;
}

function parseWorktrees(raw: string | undefined, repoRoot: string): ProductReviewSnapshot["worktrees"] {
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  const worktrees: ProductReviewSnapshot["worktrees"] = [];
  const lines = raw.split("\n");
  let currentPath: string | undefined;
  let currentBranch: string | undefined;
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      if (currentPath !== undefined) {
        worktrees.push({
          path: currentPath,
          ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
          ...(path.resolve(currentPath) === path.resolve(repoRoot) ? { current: true } : {}),
        });
      }
      currentPath = line.slice("worktree ".length).trim();
      currentBranch = undefined;
      continue;
    }
    if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length).trim();
    }
  }
  if (currentPath !== undefined) {
    worktrees.push({
      path: currentPath,
      ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
      ...(path.resolve(currentPath) === path.resolve(repoRoot) ? { current: true } : {}),
    });
  }
  return worktrees;
}

function deriveTaskPullRequests(graph: ProductTaskGraph): ProductReviewSnapshot["pullRequests"] {
  return Object.values(graph.tasks)
    .filter((task) => task.linkedPullRequest !== undefined && task.linkedBranch !== undefined)
    .map((task) => ({
      number: task.linkedPullRequest!.number,
      title: task.linkedPullRequest!.title,
      branch: task.linkedBranch!,
      baseBranch: "main",
      state: task.linkedPullRequest!.state ?? "OPEN",
      ...(task.linkedPullRequest!.url !== undefined ? { url: task.linkedPullRequest!.url } : {}),
    }));
}

function parseChangedFiles(raw: string | undefined): ProductReviewChangedFile[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [statusToken, ...rest] = line.split("\t");
      const path = rest[rest.length - 1] ?? "";
      return {
        path,
        status: normalizeGitStatus(statusToken),
      };
    })
    .filter((entry) => entry.path.length > 0);
}

function parseCommits(raw: string | undefined): ProductReviewSnapshot["recentCommits"] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const firstSpace = line.indexOf(" ");
      return {
        sha: firstSpace > 0 ? line.slice(0, firstSpace) : line,
        summary: firstSpace > 0 ? line.slice(firstSpace + 1) : line,
      };
    });
}

function parseDiffHunks(raw: string | undefined): ProductReviewDiffHunk[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  const hunks: ProductReviewDiffHunk[] = [];
  let current: ProductReviewDiffHunk | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      if (current !== undefined) {
        hunks.push(current);
      }
      current = { header: line, lines: [] };
      continue;
    }
    if (current !== undefined) {
      current.lines.push(line);
    }
  }
  if (current !== undefined) {
    hunks.push(current);
  }
  if (hunks.length > 0) {
    return hunks;
  }
  return [{ header: "diff", lines: raw.split("\n") }];
}

function normalizeGitStatus(token: string | undefined): ProductReviewChangedFile["status"] {
  if (token === undefined) {
    return "unknown";
  }
  if (token.startsWith("A")) {
    return "added";
  }
  if (token.startsWith("D")) {
    return "deleted";
  }
  if (token.startsWith("R")) {
    return "renamed";
  }
  if (token.startsWith("M")) {
    return "modified";
  }
  return "unknown";
}

function parseGithubFiles(input: Array<Record<string, unknown>>): ProductReviewChangedFile[] {
  return input
    .map<ProductReviewChangedFile | undefined>((entry) => {
      if (typeof entry.path !== "string") {
        return ;
      }
      return {
        path: entry.path,
        status: "modified" as const,
        ...(typeof entry.additions === "number" ? { additions: entry.additions } : {}),
        ...(typeof entry.deletions === "number" ? { deletions: entry.deletions } : {}),
      };
    })
    .filter((entry): entry is ProductReviewChangedFile => entry !== undefined);
}

function parseGithubChecks(input: Array<Record<string, unknown>>): ProductReviewCheckRun[] {
  return input
    .map((entry, index) => {
      const context = typeof entry.context === "string" ? entry.context : typeof entry.name === "string" ? entry.name : `check-${index + 1}`;
      const status = typeof entry.state === "string" ? entry.state : typeof entry.status === "string" ? entry.status : "UNKNOWN";
      return {
        id: typeof entry.id === "string" ? entry.id : `${context}-${index}`,
        name: context,
        status,
        ...(typeof entry.conclusion === "string" ? { conclusion: entry.conclusion } : {}),
        ...(typeof entry.detailsUrl === "string" ? { detailsUrl: entry.detailsUrl } : typeof entry.targetUrl === "string" ? { detailsUrl: entry.targetUrl } : {}),
      };
    });
}

function parseGithubComments(input: Array<Record<string, unknown>>, state: string): ProductReviewComment[] {
  return input
    .map<ProductReviewComment | undefined>((entry, index) => {
      const body = typeof entry.body === "string" ? entry.body : undefined;
      if (body === undefined || body.trim().length === 0) {
        return ;
      }
      const authorRecord = typeof entry.author === "object" && entry.author !== null ? entry.author as Record<string, unknown> : undefined;
      return {
        id: typeof entry.id === "string" ? entry.id : `${state}-${index}`,
        body,
        author: typeof authorRecord?.login === "string" ? authorRecord.login : "unknown",
        ...(typeof entry.createdAt === "string" ? { createdAt: entry.createdAt } : typeof entry.submittedAt === "string" ? { createdAt: entry.submittedAt } : {}),
        ...(typeof entry.path === "string" ? { path: entry.path } : {}),
        ...(typeof entry.line === "number" ? { line: entry.line } : {}),
        state,
      };
    })
    .filter((entry): entry is ProductReviewComment => entry !== undefined);
}
