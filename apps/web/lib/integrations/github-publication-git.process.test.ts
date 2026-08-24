import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  GitHubPublicationGitError,
  publishGitHubCandidateBundle,
} from "./github-publication-git";

const execFileAsync = promisify(execFile);

test("GitHub publication initializes one root commit and rejects later initialization", async () => {
  const fixture = await createFixture();
  try {
    await publishGitHubCandidateBundle({
      repositoryPath: path.join(fixture.root, "receive-init.git"),
      bundlePath: fixture.rootBundle,
      bundleRef: fixture.rootRef,
      remoteUrl: fixture.emptyRemote,
      mode: "initialize",
      defaultBranch: null,
      targetBranch: "main",
      expectedCommit: fixture.rootCommit,
    });
    assert.equal(await gitOutput(fixture.root, ["--git-dir", fixture.emptyRemote, "rev-list", "--count", "main"]), "1");
    assert.equal(
      (await gitOutput(fixture.root, ["--git-dir", fixture.emptyRemote, "rev-list", "--parents", "-n", "1", "main"])).split(" ").length,
      1,
    );
    assert.equal(
      await gitOutput(fixture.root, ["--git-dir", fixture.emptyRemote, "show", "main:river.txt"]),
      "reviewed riverbats tree",
    );
    const before = await gitOutput(fixture.root, ["--git-dir", fixture.emptyRemote, "show-ref"]);
    await assert.rejects(
      publishGitHubCandidateBundle({
        repositoryPath: path.join(fixture.root, "receive-again.git"),
        bundlePath: fixture.rootBundle,
        bundleRef: fixture.rootRef,
        remoteUrl: fixture.emptyRemote,
        mode: "initialize",
        defaultBranch: null,
        targetBranch: "main",
        expectedCommit: fixture.rootCommit,
      }),
      (error: unknown) =>
        error instanceof GitHubPublicationGitError &&
        error.code === "GITHUB_REPOSITORY_NOT_EMPTY",
    );
    assert.equal(
      await gitOutput(fixture.root, ["--git-dir", fixture.emptyRemote, "show-ref"]),
      before,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GitHub publication creates only an agent branch and binds the commit", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      publishGitHubCandidateBundle({
        repositoryPath: path.join(fixture.root, "receive-empty-agent.git"),
        bundlePath: fixture.agentBundle,
        bundleRef: fixture.agentRef,
        remoteUrl: fixture.emptyRemote,
        mode: "agent_branch",
        defaultBranch: "main",
        targetBranch: "kestrel/agent/run-1",
        expectedCommit: fixture.agentCommit,
      }),
      (error: unknown) =>
        error instanceof GitHubPublicationGitError &&
        error.code === "GITHUB_REPOSITORY_INITIALIZATION_REQUIRED",
    );
    await git(fixture.root, ["init", "--bare", fixture.nonEmptyRemote]);
    await git(fixture.source, ["push", fixture.nonEmptyRemote, `${fixture.rootCommit}:refs/heads/main`]);
    await publishGitHubCandidateBundle({
      repositoryPath: path.join(fixture.root, "receive-agent.git"),
      bundlePath: fixture.agentBundle,
      bundleRef: fixture.agentRef,
      remoteUrl: fixture.nonEmptyRemote,
      mode: "agent_branch",
      defaultBranch: "main",
      targetBranch: "kestrel/agent/run-1",
      expectedCommit: fixture.agentCommit,
    });
    assert.equal(
      await gitOutput(fixture.root, ["--git-dir", fixture.nonEmptyRemote, "rev-parse", "main"]),
      fixture.rootCommit,
    );
    assert.equal(
      await gitOutput(fixture.root, ["--git-dir", fixture.nonEmptyRemote, "rev-parse", "kestrel/agent/run-1"]),
      fixture.agentCommit,
    );

    await git(fixture.root, ["init", "--bare", fixture.substitutionRemote]);
    await assert.rejects(
      publishGitHubCandidateBundle({
        repositoryPath: path.join(fixture.root, "receive-substitution.git"),
        bundlePath: fixture.rootBundle,
        bundleRef: fixture.rootRef,
        remoteUrl: fixture.substitutionRemote,
        mode: "initialize",
        defaultBranch: null,
        targetBranch: "main",
        expectedCommit: "f".repeat(40),
      }),
      (error: unknown) =>
        error instanceof GitHubPublicationGitError &&
        error.code === "GITHUB_PUSH_CANDIDATE_CHANGED",
    );
    assert.equal(
      await gitOutput(fixture.root, ["--git-dir", fixture.substitutionRemote, "show-ref", "--head"]).catch(() => ""),
      "",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-github-publication-"));
  const source = path.join(root, "source");
  const emptyRemote = path.join(root, "empty.git");
  const nonEmptyRemote = path.join(root, "non-empty.git");
  const substitutionRemote = path.join(root, "substitution.git");
  await git(root, ["init", "--initial-branch=main", source]);
  await git(source, ["config", "user.name", "Kestrel Test"]);
  await git(source, ["config", "user.email", "test@kestrel.invalid"]);
  await writeFile(path.join(source, "river.txt"), "workspace base\n", "utf8");
  await git(source, ["add", "river.txt"]);
  await git(source, ["commit", "-m", "Workspace base"]);
  const baseCommit = await gitOutput(source, ["rev-parse", "HEAD"]);
  await writeFile(path.join(source, "river.txt"), "reviewed riverbats tree\n", "utf8");
  await git(source, ["add", "river.txt"]);
  const tree = await gitOutput(source, ["write-tree"]);
  const rootCommit = await gitOutput(source, [
    "commit-tree",
    tree,
    "-m",
    "Initialize repository from Kestrel",
  ]);
  const agentCommit = await gitOutput(source, [
    "commit-tree",
    tree,
    "-p",
    baseCommit,
    "-m",
    "Kestrel candidate run-1",
  ]);
  const rootRef = "refs/kestrel/bundles/root";
  const agentRef = "refs/kestrel/bundles/agent";
  const rootBundle = path.join(root, "root.bundle");
  const agentBundle = path.join(root, "agent.bundle");
  await git(source, ["update-ref", rootRef, rootCommit]);
  await git(source, ["update-ref", agentRef, agentCommit]);
  await git(source, ["bundle", "create", rootBundle, rootRef]);
  await git(source, ["bundle", "create", agentBundle, agentRef]);
  await git(root, ["init", "--bare", emptyRemote]);
  return {
    root,
    source,
    emptyRemote,
    nonEmptyRemote,
    substitutionRemote,
    baseCommit,
    rootCommit,
    agentCommit,
    rootRef,
    agentRef,
    rootBundle,
    agentBundle,
  };
}

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}
