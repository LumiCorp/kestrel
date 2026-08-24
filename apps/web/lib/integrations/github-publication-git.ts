import "server-only";

import { spawn } from "node:child_process";

export class GitHubPublicationGitError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "GitHubPublicationGitError";
  }
}

export async function publishGitHubCandidateBundle(input: {
  repositoryPath: string;
  bundlePath: string;
  bundleRef: string;
  remoteUrl: string;
  mode: "agent_branch" | "initialize";
  defaultBranch: string | null;
  targetBranch: string;
  expectedCommit: string;
  gitEnvironment?: Record<string, string> | undefined;
}) {
  const environment = input.gitEnvironment ?? {};
  await runGit(["init", "--bare", input.repositoryPath], environment);
  if (input.mode === "agent_branch") {
    const refs = await runGitOutput(["ls-remote", input.remoteUrl], environment);
    if (!refs.trim()) {
      throw new GitHubPublicationGitError(
        "GITHUB_REPOSITORY_INITIALIZATION_REQUIRED",
        409,
      );
    }
    if (!input.defaultBranch) {
      throw new GitHubPublicationGitError(
        "GITHUB_REPOSITORY_NOT_SYNCED",
        409,
      );
    }
    await runGit(
      [
        "-C",
        input.repositoryPath,
        "fetch",
        "--no-tags",
        input.remoteUrl,
        `refs/heads/${input.defaultBranch}:refs/remotes/origin/${input.defaultBranch}`,
      ],
      environment,
    );
  }
  await runGit(
    ["-C", input.repositoryPath, "bundle", "verify", input.bundlePath],
    {},
  );
  await runGit(
    [
      "-C",
      input.repositoryPath,
      "fetch",
      input.bundlePath,
      input.bundleRef,
    ],
    {},
  );
  const bundledCommit = (
    await runGitOutput(
      ["-C", input.repositoryPath, "rev-parse", "FETCH_HEAD"],
      {},
    )
  ).trim();
  if (bundledCommit !== input.expectedCommit) {
    throw new GitHubPublicationGitError("GITHUB_PUSH_CANDIDATE_CHANGED", 409);
  }
  if (input.mode === "initialize") {
    const refs = await runGitOutput(["ls-remote", input.remoteUrl], environment);
    if (refs.trim()) {
      throw new GitHubPublicationGitError("GITHUB_REPOSITORY_NOT_EMPTY", 409);
    }
  }
  await runGit(
    [
      "-C",
      input.repositoryPath,
      "push",
      ...(input.mode === "agent_branch" ? ["--force"] : []),
      input.remoteUrl,
      `FETCH_HEAD:refs/heads/${input.targetBranch}`,
    ],
    environment,
  );
  return { commit: bundledCommit, branch: input.targetBranch };
}

function runGit(args: string[], extraEnvironment: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      env: { ...process.env, ...extraEnvironment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new GitHubPublicationGitError("GITHUB_PUSH_GIT_FAILED", 502));
    });
  });
}

function runGitOutput(
  args: string[],
  extraEnvironment: Record<string, string>,
) {
  return new Promise<string>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const child = spawn("git", args, {
      env: { ...process.env, ...extraEnvironment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new GitHubPublicationGitError("GITHUB_PUSH_GIT_FAILED", 502));
    });
  });
}
