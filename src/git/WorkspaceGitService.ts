import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { redactDiagnosticValue } from "../diagnostics/redaction.js";
import {
  createRuntimeFailure,
  RuntimeFailure,
} from "../runtime/RuntimeFailure.js";
import type {
  WorkspaceGitAuditRecord,
  WorkspaceGitFileStatus,
  WorkspaceGitNotification,
  WorkspaceGitOperation,
  WorkspaceGitRemote,
  WorkspaceGitSnapshot,
  WorkspacePullRequest,
} from "./contracts.js";

const execFileAsync = promisify(execFile);
interface Store {
  version: 1;
  audits: WorkspaceGitAuditRecord[];
  checkStates: Record<string, string>;
  notifications: WorkspaceGitNotification[];
}

export class WorkspaceGitService {
  private audits: WorkspaceGitAuditRecord[] = [];
  private checkStates: Record<string, string> = {};
  private notifications: WorkspaceGitNotification[] = [];
  private persistTail: Promise<void> = Promise.resolve();
  constructor(private readonly metadataPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.metadataPath), { recursive: true });
    try {
      const parsed = JSON.parse(
        await readFile(this.metadataPath, "utf8"),
      ) as Partial<Store>;
      if (parsed.version === 1) {
        if (Array.isArray(parsed.audits))
          this.audits = parsed.audits.filter(isAudit).slice(-500);
        if (parsed.checkStates && typeof parsed.checkStates === "object")
          this.checkStates = { ...parsed.checkStates };
        if (Array.isArray(parsed.notifications))
          this.notifications = parsed.notifications
            .filter(isNotification)
            .slice(-200);
      }
    } catch {
      /* Missing or invalid Local Core Git metadata starts empty. */
    }
    await this.persist();
  }

  async inspect(input: {
    sessionId: string;
    threadId: string;
    workspaceRoot: string;
    candidateFingerprint: string;
    validationReadiness: WorkspaceGitSnapshot["validationReadiness"];
  }): Promise<WorkspaceGitSnapshot> {
    const sessionId = identifier(input.sessionId, "sessionId");
    const threadId = identifier(input.threadId, "threadId");
    const workspaceRoot = await realpath(path.resolve(input.workspaceRoot));
    const repoRoot = await realpath(
      (
        await run("git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"])
      ).stdout.trim(),
    );
    assertInside(workspaceRoot, repoRoot);
    const [
      branchResult,
      headResult,
      upstreamResult,
      statusResult,
      branchesResult,
      remotesResult,
      commitsResult,
    ] = await Promise.all([
      safeRun("git", ["-C", repoRoot, "branch", "--show-current"]),
      safeRun("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"]),
      safeRun("git", [
        "-C",
        repoRoot,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]),
      run("git", [
        "-C",
        repoRoot,
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
      ]),
      run("git", [
        "-C",
        repoRoot,
        "for-each-ref",
        "refs/heads",
        "--format=%(refname:short)",
      ]),
      run("git", ["-C", repoRoot, "remote", "-v"]),
      safeRun("git", [
        "-C",
        repoRoot,
        "log",
        "-n",
        "20",
        "--format=%H%x00%s%x00%aI",
      ]),
    ]);
    const branch = branchResult?.stdout.trim() || undefined;
    const headSha = headResult?.stdout.trim() || undefined;
    const upstream = upstreamResult?.stdout.trim() || undefined;
    const divergence = upstream
      ? parseDivergence(
          (
            await safeRun("git", [
              "-C",
              repoRoot,
              "rev-list",
              "--left-right",
              "--count",
              `${upstream}...HEAD`,
            ])
          )?.stdout ?? "",
        )
      : { ahead: 0, behind: 0 };
    const github = await inspectGithub(repoRoot);
    const pullRequest = github.authenticated
      ? await inspectPullRequest(repoRoot)
      : undefined;
    if (pullRequest) await this.recordCheckChanges(pullRequest);
    const validationReadiness = input.validationReadiness;
    const deliveryReady = validationReadiness === "ready";
    const latestPush = [...this.audits].reverse().find(
      (audit) =>
        audit.sessionId === sessionId &&
        audit.threadId === threadId &&
        audit.operation === "push",
    );
    return {
      sessionId,
      threadId,
      workspaceRoot,
      repoRoot,
      candidateFingerprint: fingerprint(input.candidateFingerprint),
      validationReadiness,
      deliveryReady,
      deliveryReadinessMessage: deliveryReady
        ? "Validation passed for this exact candidate."
        : validationReadiness === "stale"
          ? "Validation evidence is stale and does not count toward delivery readiness."
          : `Validation is ${validationReadiness.replace("_", " ")}; delivery is not proven ready.`,
      ...(branch ? { branch } : {}),
      ...(headSha ? { headSha } : {}),
      ...(upstream ? { upstream } : {}),
      ...divergence,
      relation: relation(upstream, divergence.ahead, divergence.behind),
      pushState:
        latestPush === undefined
          ? "not_pushed"
          : latestPush.status === "succeeded"
            ? "succeeded"
            : latestPush.errorCode === "WORKSPACE_GIT_PUSH_REJECTED"
              ? "rejected"
              : "failed",
      files: parseStatus(statusResult.stdout),
      branches: branchesResult.stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      remotes: parseRemotes(remotesResult.stdout),
      recentCommits: parseCommits(commitsResult?.stdout),
      github,
      ...(pullRequest ? { pullRequest } : {}),
      audits: this.audits
        .filter(
          (audit) =>
            audit.sessionId === sessionId && audit.threadId === threadId,
        )
        .slice(-100)
        .reverse(),
      notifications: this.notifications
        .filter(
          (notification) =>
            pullRequest &&
            notification.pullRequestNumber === pullRequest.number,
        )
        .slice(-50)
        .reverse(),
      generatedAt: new Date().toISOString(),
    };
  }

  async createBranch(
    input: BaseMutation & { branchName: string },
  ): Promise<void> {
    await this.mutate(
      input,
      "branch_create",
      async (repoRoot) => {
        await run("git", [
          "-C",
          repoRoot,
          "check-ref-format",
          "--branch",
          input.branchName,
        ]);
        await run("git", ["-C", repoRoot, "switch", "-c", input.branchName]);
      },
      `Created branch ${input.branchName}.`,
    );
  }
  async fetch(input: BaseMutation & { remote: string }): Promise<void> {
    await this.mutate(
      input,
      "fetch",
      async (repoRoot) => {
        await run("git", [
          "-C",
          repoRoot,
          "fetch",
          "--prune",
          remoteName(input.remote),
        ]);
      },
      `Fetched ${input.remote}.`,
    );
  }
  async commit(
    input: BaseMutation & { message: string; paths: string[] },
  ): Promise<void> {
    await this.mutate(
      input,
      "commit",
      async (repoRoot) => {
        const selected = normalizedPaths(input.paths);
        if (selected.length === 0)
          throw failure(
            "WORKSPACE_GIT_COMMIT_SELECTION_INVALID",
            "Select at least one staged path to commit.",
          );
        const staged = (
          await run("git", [
            "-C",
            repoRoot,
            "diff",
            "--cached",
            "--name-only",
            "-z",
          ])
        ).stdout
          .split("\0")
          .filter(Boolean)
          .sort();
        if (JSON.stringify(staged) !== JSON.stringify([...selected].sort()))
          throw failure(
            "WORKSPACE_GIT_COMMIT_SELECTION_MISMATCH",
            "The staged paths must exactly match the selected commit paths. Unstage unrelated changes first.",
          );
        await run("git", [
          "-C",
          repoRoot,
          "commit",
          "-m",
          text(input.message, "commit message", 16_384),
        ]);
      },
      `Committed ${input.paths.length} selected path(s).`,
    );
  }
  async push(
    input: BaseMutation & {
      remote: string;
      branch: string;
      setUpstream: boolean;
    },
  ): Promise<void> {
    await this.mutate(
      input,
      "push",
      async (repoRoot) => {
        const args = [
          "-C",
          repoRoot,
          "push",
          "--porcelain",
          ...(input.setUpstream ? ["--set-upstream"] : []),
          remoteName(input.remote),
          gitRef(input.branch, "branch"),
        ];
        await run("git", args);
      },
      `Pushed ${input.branch} to ${input.remote}.`,
    );
  }
  async createPullRequest(
    input: BaseMutation & {
      title: string;
      body: string;
      baseBranch: string;
      draft: boolean;
    },
  ): Promise<void> {
    await this.mutate(
      input,
      "pr_create",
      async (repoRoot) => {
        const existing = await inspectPullRequest(repoRoot);
        if (existing)
          throw failure(
            "WORKSPACE_GIT_PR_EXISTS",
            `Pull request #${existing.number} already exists for this branch.`,
          );
        await requireGithubReady(repoRoot);
        await run(
          "gh",
          [
            "pr",
            "create",
            "--title",
            text(input.title, "PR title", 512),
            "--body",
            boundedText(input.body, "PR body", 65_536),
            "--base",
            gitRef(input.baseBranch, "base branch"),
            ...(input.draft ? ["--draft"] : []),
          ],
          repoRoot,
        );
      },
      `Created ${input.draft ? "draft" : "ready"} pull request.`,
    );
  }
  async markPullRequestReady(
    input: BaseMutation & { number: number },
  ): Promise<void> {
    await this.mutate(
      input,
      "pr_ready",
      async (repoRoot) => {
        await requireGithubReady(repoRoot);
        await run(
          "gh",
          ["pr", "ready", String(positiveInteger(input.number, "PR number"))],
          repoRoot,
        );
      },
      `Marked pull request #${input.number} ready for review.`,
    );
  }
  async commentOnPullRequest(
    input: BaseMutation & {
      number: number;
      body: string;
      path?: string | undefined;
      line?: number | undefined;
      side?: "LEFT" | "RIGHT" | undefined;
    },
  ): Promise<void> {
    await this.mutate(
      input,
      "pr_comment",
      async (repoRoot) => {
      await requireGithubReady(repoRoot);
      const number = positiveInteger(input.number, "PR number");
      const body = text(input.body, "comment", 16_384);
      if ((input.path !== undefined || input.line !== undefined || input.side !== undefined) && !(input.path && input.line))
        throw failure("WORKSPACE_GIT_PR_COMMENT_LOCATION_INVALID", "Line comments require both a path and line number.");
      if (input.path && input.line) {
          const repo = JSON.parse(
            (
              await run(
                "gh",
                ["repo", "view", "--json", "nameWithOwner"],
                repoRoot,
              )
            ).stdout,
          ) as { nameWithOwner?: unknown };
          if (
            typeof repo.nameWithOwner !== "string" ||
            !/^[^/]+\/[^/]+$/u.test(repo.nameWithOwner)
          )
            throw failure(
              "WORKSPACE_GIT_GITHUB_REPOSITORY_INVALID",
              "GitHub repository identity is unavailable.",
            );
          const head = (
            await run("git", ["-C", repoRoot, "rev-parse", "HEAD"])
          ).stdout.trim();
          await run(
            "gh",
            [
              "api",
              `repos/${repo.nameWithOwner}/pulls/${number}/comments`,
              "-f",
              `body=${body}`,
              "-f",
              `commit_id=${head}`,
              "-f",
              `path=${filePath(input.path)}`,
              "-F",
              `line=${positiveInteger(input.line, "line")}`,
              "-f",
              `side=${input.side ?? "RIGHT"}`,
            ],
            repoRoot,
          );
        } else
          await run(
            "gh",
            ["pr", "comment", String(number), "--body", body],
            repoRoot,
          );
      },
      `Commented on pull request #${input.number}.`,
    );
  }

  private async mutate(
    input: {
      sessionId: string;
      threadId: string;
      workspaceRoot: string;
      expectedHeadSha?: string | undefined;
      candidateFingerprint?: string | undefined;
    },
    operation: WorkspaceGitOperation,
    action: (repoRoot: string) => Promise<void>,
    summary: string,
  ): Promise<void> {
    const sessionId = identifier(input.sessionId, "sessionId");
    const threadId = identifier(input.threadId, "threadId");
    const workspaceRoot = await realpath(path.resolve(input.workspaceRoot));
    const repoRoot = await realpath(
      (
        await run("git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"])
      ).stdout.trim(),
    );
    assertInside(workspaceRoot, repoRoot);
    const headSha = (
      await safeRun("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"])
    )?.stdout.trim();
    if (input.expectedHeadSha && input.expectedHeadSha !== headSha)
      throw failure(
        "WORKSPACE_GIT_HEAD_STALE",
        "Repository HEAD changed. Refresh before delivery.",
      );
    try {
      await action(repoRoot);
      await this.audit({
        sessionId,
        threadId,
        operation,
        status: "succeeded",
        summary,
        ...(input.candidateFingerprint
          ? { candidateFingerprint: fingerprint(input.candidateFingerprint) }
          : {}),
        ...(headSha ? { headSha } : {}),
      });
    } catch (cause) {
      const error = redactDiagnosticValue(
        cause instanceof Error ? cause.message : String(cause),
      );
      await this.audit({
        sessionId,
        threadId,
        operation,
        status: "failed",
        summary: `${operation} failed.`,
        error,
        ...(cause instanceof RuntimeFailure ? { errorCode: cause.code } : {}),
        ...(input.candidateFingerprint
          ? { candidateFingerprint: fingerprint(input.candidateFingerprint) }
          : {}),
        ...(headSha ? { headSha } : {}),
      });
      throw cause;
    }
  }
  private async audit(
    input: Omit<WorkspaceGitAuditRecord, "auditId" | "at">,
  ): Promise<void> {
    this.audits.push({
      ...input,
      auditId: randomUUID(),
      at: new Date().toISOString(),
    });
    this.audits = this.audits.slice(-500);
    await this.persist();
  }
  private async recordCheckChanges(pr: WorkspacePullRequest): Promise<void> {
    let changed = false;
    for (const check of pr.checks) {
      const key = `${pr.number}:${check.id}`;
      const state = `${check.status}:${check.conclusion ?? ""}`;
      const previous = this.checkStates[key];
      if (previous && previous !== state) {
        this.notifications.push({
          notificationId: randomUUID(),
          pullRequestNumber: pr.number,
          kind: "check_state_changed",
          message: `${check.name} changed from ${previous} to ${state}.`,
          at: new Date().toISOString(),
        });
        changed = true;
      }
      if (previous !== state) {
        this.checkStates[key] = state;
        changed = true;
      }
    }
    if (changed) {
      this.notifications = this.notifications.slice(-200);
      await this.persist();
    }
  }
  private async persist(): Promise<void> {
    const value: Store = {
      version: 1,
      audits: this.audits,
      checkStates: this.checkStates,
      notifications: this.notifications,
    };
    const temp = `${this.metadataPath}.tmp`;
    this.persistTail = this.persistTail.then(async () => {
      await writeFile(temp, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temp, this.metadataPath);
    });
    await this.persistTail;
  }
}

interface BaseMutation {
  sessionId: string;
  threadId: string;
  workspaceRoot: string;
  expectedHeadSha?: string | undefined;
  candidateFingerprint: string;
}
async function inspectGithub(repoRoot: string) {
  const version = await safeRun("gh", ["--version"], repoRoot);
  if (!version)
    return {
      available: false,
      authenticated: false,
      guidance: "Install GitHub CLI (gh), then run 'gh auth login'.",
    };
  const auth = await safeRun("gh", ["auth", "status"], repoRoot);
  if (!auth)
    return {
      available: true,
      authenticated: false,
      guidance: "Run 'gh auth login' to connect GitHub CLI.",
    };
  const repositoryResult = await safeRun(
    "gh",
    ["repo", "view", "--json", "nameWithOwner"],
    repoRoot,
  );
  let repository: string | undefined;
  try {
    const parsed = JSON.parse(repositoryResult?.stdout ?? "{}") as {
      nameWithOwner?: unknown;
    };
    if (typeof parsed.nameWithOwner === "string")
      repository = parsed.nameWithOwner;
  } catch {
    /* Optional repository identity. */
  }
  const accountMatch = /Logged in to github\.com account ([^\s]+)/u.exec(
    `${auth.stdout}\n${auth.stderr}`,
  );
  return {
    available: true,
    authenticated: true,
    ...(accountMatch?.[1] ? { account: accountMatch[1] } : {}),
    ...(repository ? { repository } : {}),
  };
}
async function requireGithubReady(repoRoot: string): Promise<void> {
  const status = await inspectGithub(repoRoot);
  if (!(status.available && status.authenticated))
    throw failure(
      "WORKSPACE_GIT_GITHUB_UNAVAILABLE",
      status.guidance ?? "GitHub CLI is unavailable.",
    );
}
async function inspectPullRequest(
  repoRoot: string,
): Promise<WorkspacePullRequest | undefined> {
  const result = await safeRun(
    "gh",
    [
      "pr",
      "view",
      "--json",
      "number,title,body,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,files,statusCheckRollup,comments,reviews",
    ],
    repoRoot,
  );
  if (!result) return ;
  try {
    const r = JSON.parse(result.stdout) as Record<string, unknown>;
    if (
      !Number.isInteger(r.number) ||
      typeof r.title !== "string" ||
      typeof r.url !== "string" ||
      (r.state !== "OPEN" && r.state !== "CLOSED" && r.state !== "MERGED") ||
      typeof r.baseRefName !== "string" ||
      typeof r.headRefName !== "string" ||
      typeof r.headRefOid !== "string"
    )
      return ;
    return {
      number: r.number as number,
      title: r.title,
      body: typeof r.body === "string" ? r.body : "",
      url: r.url,
      state: r.state,
      isDraft: r.isDraft === true,
      baseBranch: r.baseRefName,
      headBranch: r.headRefName,
      headSha: r.headRefOid,
      ...(typeof r.mergeable === "string" ? { mergeable: r.mergeable } : {}),
      ...(typeof r.mergeStateStatus === "string"
        ? { mergeState: r.mergeStateStatus }
        : {}),
      ...(typeof r.reviewDecision === "string"
        ? { reviewDecision: r.reviewDecision }
        : {}),
      changedFiles: parsePrFiles(r.files),
      checks: parseChecks(r.statusCheckRollup),
      comments: [
        ...parseComments(r.comments, "COMMENT"),
        ...parseComments(r.reviews, "REVIEW"),
      ],
    };
  } catch {
    return ;
  }
}
function parsePrFiles(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const r = record(entry);
    return r && typeof r.path === "string"
      ? [
          {
            path: r.path,
            additions: number(r.additions),
            deletions: number(r.deletions),
          },
        ]
      : [];
  });
}
function parseChecks(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const r = record(entry);
    if (!r) return [];
    const name =
      typeof r.name === "string"
        ? r.name
        : typeof r.context === "string"
          ? r.context
          : undefined;
    if (!name) return [];
    return [
      {
        id:
          typeof r.databaseId === "number"
            ? String(r.databaseId)
            : typeof r.id === "string"
              ? r.id
              : `${name}:${index}`,
        name,
        status: typeof r.status === "string" ? r.status : "UNKNOWN",
        ...(typeof r.conclusion === "string"
          ? { conclusion: r.conclusion }
          : {}),
        ...(typeof r.detailsUrl === "string"
          ? { detailsUrl: r.detailsUrl }
          : {}),
      },
    ];
  });
}
function parseComments(value: unknown, state: string) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const r = record(entry);
    if (!r || typeof r.body !== "string") return [];
    const author = record(r.author);
    return [
      {
        id: typeof r.id === "string" ? r.id : `${state}:${index}`,
        body: r.body,
        author: typeof author?.login === "string" ? author.login : "unknown",
        ...(typeof r.createdAt === "string" ? { createdAt: r.createdAt } : {}),
        ...(typeof r.path === "string" ? { path: r.path } : {}),
        ...(Number.isInteger(r.line) ? { line: r.line as number } : {}),
        state,
      },
    ];
  });
}
function parseStatus(raw: string): WorkspaceGitFileStatus[] {
  const parts = raw.split("\0");
  const result: WorkspaceGitFileStatus[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith("? ")) {
      result.push({
        path: line.slice(2),
        status: "untracked",
        staged: false,
        unstaged: true,
      });
      continue;
    }
    if (line.startsWith("u ")) {
      const fields = line.split(" ");
      result.push({
        path: fields.slice(10).join(" "),
        status: "conflicted",
        staged: true,
        unstaged: true,
      });
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const rename = line.startsWith("2 ");
      const fields = line.split(" ");
      const xy = fields[1] ?? "..";
      const file = fields.slice(rename ? 9 : 8).join(" ");
      const previous = rename ? parts[++i] : undefined;
      result.push({
        path: file,
        ...(previous ? { previousPath: previous } : {}),
        status:
          rename || xy.includes("R")
            ? "renamed"
            : xy.includes("A")
              ? "added"
              : xy.includes("D")
                ? "deleted"
                : xy.includes("C")
                  ? "copied"
                  : xy.includes("M") || xy.includes("T")
                    ? "modified"
                    : "unknown",
        staged: xy[0] !== ".",
        unstaged: xy[1] !== ".",
      });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function parseRemotes(raw: string): WorkspaceGitRemote[] {
  const result = new Map<string, WorkspaceGitRemote>();
  for (const line of raw.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(line);
    if (!match) continue;
    const current = result.get(match[1]!) ?? { name: match[1]! };
    result.set(match[1]!, {
      ...current,
      ...(match[3] === "fetch"
        ? { fetchUrl: match[2] }
        : { pushUrl: match[2] }),
    });
  }
  return [...result.values()];
}
function parseCommits(raw: string | undefined) {
  if (!raw) return [];
  const fields = raw.trim().split("\0");
  const result = [];
  for (let i = 0; i + 2 < fields.length; i += 3)
    result.push({
      sha: fields[i]!.trim(),
      summary: fields[i + 1]!.trim(),
      authoredAt: fields[i + 2]!.trim(),
    });
  return result.filter((entry) => entry.sha.length > 0);
}
function parseDivergence(raw: string) {
  const [behind = 0, ahead = 0] = raw.trim().split(/\s+/u).map(Number);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}
function relation(
  upstream: string | undefined,
  ahead: number,
  behind: number,
): WorkspaceGitSnapshot["relation"] {
  if (!upstream) return "untracked";
  if (ahead && behind) return "diverged";
  if (ahead) return "ahead";
  if (behind) return "behind";
  return "up_to_date";
}
async function run(command: string, args: string[], cwd?: string) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (cause) {
    const error = cause as Error & {
      stderr?: string;
      stdout?: string;
      code?: unknown;
    };
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    const rejectedPush =
      command === "git" &&
      args.includes("push") &&
      /^!\t[^\t]+\t\[rejected\]/mu.test(output);
    throw failure(
      rejectedPush
        ? "WORKSPACE_GIT_PUSH_REJECTED"
        : "WORKSPACE_GIT_COMMAND_FAILED",
      redactDiagnosticValue(error.stderr || error.stdout || error.message),
      { command, exitCode: error.code },
    );
  }
}
async function safeRun(command: string, args: string[], cwd?: string) {
  try {
    return await run(command, args, cwd);
  } catch {
    return ;
  }
}
function normalizedPaths(value: string[]) {
  if (!Array.isArray(value) || value.length > 1000)
    throw failure(
      "WORKSPACE_GIT_PATH_INVALID",
      "Git path selection is invalid.",
    );
  return [...new Set(value.map(filePath))];
}
function filePath(value: unknown) {
  const parsed = text(value, "path", 4096).replaceAll("\\", "/");
  if (path.isAbsolute(parsed) || parsed === ".." || parsed.startsWith("../"))
    throw failure(
      "WORKSPACE_GIT_PATH_INVALID",
      "Git path escapes the workspace.",
    );
  return parsed;
}
function remoteName(value: unknown) {
  const parsed = text(value, "remote", 256);
  if (!/^[A-Za-z0-9._-]+$/u.test(parsed))
    throw failure("WORKSPACE_GIT_REMOTE_INVALID", "Remote name is invalid.");
  return parsed;
}
function gitRef(value: unknown, label: string) {
  const parsed = text(value, label, 512);
  if (parsed.startsWith("-"))
    throw failure("WORKSPACE_GIT_REF_INVALID", `${label} is invalid.`);
  return parsed;
}
function fingerprint(value: unknown) {
  const parsed = text(value, "candidate fingerprint", 256);
  if (!/^sha256:[a-f0-9]{64}$/u.test(parsed))
    throw failure(
      "WORKSPACE_GIT_INPUT_INVALID",
      "Candidate fingerprint is invalid.",
    );
  return parsed;
}
function identifier(value: unknown, label: string) {
  return text(value, label, 256);
}
function text(value: unknown, label: string, max: number) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw failure("WORKSPACE_GIT_INPUT_INVALID", `${label} is invalid.`);
  return value.trim();
}
function boundedText(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw failure("WORKSPACE_GIT_INPUT_INVALID", `${label} is invalid.`);
  return value;
}
function positiveInteger(value: unknown, label: string) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0)
    throw failure("WORKSPACE_GIT_INPUT_INVALID", `${label} is invalid.`);
  return numberValue;
}
function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function assertInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw failure(
      "WORKSPACE_GIT_ROOT_INVALID",
      "Repository root escapes the authoritative workspace.",
    );
}
function isAudit(value: unknown): value is WorkspaceGitAuditRecord {
  const r = record(value);
  return Boolean(
    r &&
    typeof r.auditId === "string" &&
    typeof r.sessionId === "string" &&
    typeof r.threadId === "string" &&
    typeof r.operation === "string" &&
    typeof r.status === "string" &&
    typeof r.at === "string",
  );
}
function isNotification(value: unknown): value is WorkspaceGitNotification {
  const r = record(value);
  return Boolean(
    r &&
    typeof r.notificationId === "string" &&
    typeof r.pullRequestNumber === "number" &&
    typeof r.message === "string" &&
    typeof r.at === "string",
  );
}
function failure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return createRuntimeFailure(code, message, {
    subsystem: "git",
    classification: "state",
    recoverable: true,
    ...details,
  });
}
