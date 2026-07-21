import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { WorkspaceGitService } from "../../src/git/WorkspaceGitService.js";
import { contractTest } from "../helpers/contract-test.js";


const execFileAsync = promisify(execFile);
const candidateFingerprint = `sha256:${"a".repeat(64)}`;

contractTest("runtime.process", "WorkspaceGitService reports status, branches, remotes, commits, and delivery readiness", async () => {
  const { root, service } = await repository();
  await writeFile(path.join(root, "tracked.txt"), "changed\n", "utf8");
  await writeFile(path.join(root, "new.txt"), "new\n", "utf8");
  await git(root, "remote", "add", "origin", root);

  const snapshot = await service.inspect(input(root, "ready"));

  assert.equal(snapshot.branch, "main");
  assert.equal(snapshot.deliveryReady, true);
  assert.equal(snapshot.relation, "untracked");
  assert.equal(snapshot.pushState, "not_pushed");
  assert.deepEqual(
    snapshot.files
      .filter((file) => !file.path.startsWith(".kestrel-test/"))
      .map((file) => [file.path, file.status, file.unstaged]),
    [
      ["new.txt", "untracked", true],
      ["tracked.txt", "modified", true],
    ],
  );
  assert.equal(snapshot.remotes[0]?.name, "origin");
  assert.equal(snapshot.recentCommits[0]?.summary, "initial");
});

contractTest("runtime.process", "WorkspaceGitService commits exactly the selected staged paths", async () => {
  const { root, service, metadataPath } = await repository();
  await writeFile(path.join(root, "first.txt"), "first\n", "utf8");
  await writeFile(path.join(root, "second.txt"), "second\n", "utf8");
  await git(root, "add", "first.txt", "second.txt");

  await assert.rejects(
    service.commit({
      ...input(root),
      message: "partial",
      paths: ["first.txt"],
    }),
    /staged paths must exactly match/u,
  );
  await service.commit({
    ...input(root),
    message: "selected files",
    paths: ["first.txt", "second.txt"],
  });

  assert.equal(
    (await git(root, "show", "--format=%s", "--no-patch")).trim(),
    "selected files",
  );
  const persisted = JSON.parse(await readFile(metadataPath, "utf8")) as {
    audits: Array<{ operation: string; status: string }>;
  };
  assert.deepEqual(
    persisted.audits.slice(-2).map((audit) => [audit.operation, audit.status]),
    [
      ["commit", "failed"],
      ["commit", "succeeded"],
    ],
  );
});

contractTest("runtime.process", "WorkspaceGitService enforces HEAD preconditions and explicit push destinations", async () => {
  const { root, service } = await repository();
  const remote = await mkdtemp(path.join(os.tmpdir(), "kestrel-git-remote-"));
  await git(remote, "init", "--bare");
  await git(root, "remote", "add", "publish", remote);
  const originalHead = (await git(root, "rev-parse", "HEAD")).trim();

  await service.createBranch({
    ...input(root),
    expectedHeadSha: originalHead,
    branchName: "feature/delivery",
  });
  await writeFile(path.join(root, "feature.txt"), "feature\n", "utf8");
  await git(root, "add", "feature.txt");
  await git(root, "commit", "-m", "feature");
  const featureHead = (await git(root, "rev-parse", "HEAD")).trim();

  await assert.rejects(
    service.push({
      ...input(root),
      expectedHeadSha: originalHead,
      remote: "publish",
      branch: "feature/delivery",
      setUpstream: true,
    }),
    /HEAD changed/u,
  );
  await service.push({
    ...input(root),
    expectedHeadSha: featureHead,
    remote: "publish",
    branch: "feature/delivery",
    setUpstream: true,
  });

  assert.equal(
    (await git(remote, "rev-parse", "refs/heads/feature/delivery")).trim(),
    featureHead,
  );
  const snapshot = await service.inspect(input(root, "stale"));
  assert.equal(snapshot.upstream, "publish/feature/delivery");
  assert.equal(snapshot.relation, "up_to_date");
  assert.equal(snapshot.pushState, "succeeded");
  assert.equal(snapshot.deliveryReady, false);
  assert.match(snapshot.deliveryReadinessMessage, /stale/u);

  const competing = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-git-competing-"),
  );
  await execFileAsync(
    "git",
    ["clone", "--branch", "feature/delivery", remote, competing],
    { encoding: "utf8" },
  );
  await git(competing, "config", "user.name", "Competing Test");
  await git(competing, "config", "user.email", "competing@example.test");
  await writeFile(path.join(competing, "remote.txt"), "remote\n", "utf8");
  await git(competing, "add", "remote.txt");
  await git(competing, "commit", "-m", "remote");
  await git(competing, "push", "origin", "feature/delivery");
  await writeFile(path.join(root, "local.txt"), "local\n", "utf8");
  await git(root, "add", "local.txt");
  await git(root, "commit", "-m", "local");
  const localHead = (await git(root, "rev-parse", "HEAD")).trim();
  await assert.rejects(
    service.push({
      ...input(root),
      expectedHeadSha: localHead,
      remote: "publish",
      branch: "feature/delivery",
      setUpstream: false,
    }),
    /rejected|fetch first/u,
  );
  const rejected = await service.inspect(input(root));
  assert.equal(rejected.pushState, "rejected");
});

contractTest("runtime.process", "WorkspaceGitService inspects GitHub PR state, comments explicitly, and records check transitions", async () => {
  const { root, service } = await repository();
  const bin = await mkdtemp(path.join(os.tmpdir(), "kestrel-fake-gh-"));
  const statePath = path.join(bin, "state.json");
  const callsPath = path.join(bin, "calls.jsonl");
  const ghPath = path.join(bin, "gh");
  await writeFile(
    statePath,
    JSON.stringify(pullRequestState("IN_PROGRESS")),
    "utf8",
  );
  await writeFile(
    ghPath,
    `#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2); fs.appendFileSync(process.env.KESTREL_FAKE_GH_CALLS, JSON.stringify(args)+'\\n'); if(args[0]==='--version') console.log('gh version 2.0'); else if(args[0]==='auth') console.error('Logged in to github.com account kestrel-test'); else if(args[0]==='repo') console.log(JSON.stringify({nameWithOwner:'LumiCorp/kestrel'})); else if(args[0]==='pr'&&args[1]==='view') console.log(fs.readFileSync(process.env.KESTREL_FAKE_GH_STATE,'utf8'));\n`,
    "utf8",
  );
  await chmod(ghPath, 0o755);
  const previousPath = process.env.PATH;
  const previousState = process.env.KESTREL_FAKE_GH_STATE;
  const previousCalls = process.env.KESTREL_FAKE_GH_CALLS;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  process.env.KESTREL_FAKE_GH_STATE = statePath;
  process.env.KESTREL_FAKE_GH_CALLS = callsPath;
  try {
    const first = await service.inspect(input(root));
    assert.deepEqual(first.github, {
      available: true,
      authenticated: true,
      account: "kestrel-test",
      repository: "LumiCorp/kestrel",
    });
    assert.equal(first.pullRequest?.checks[0]?.status, "IN_PROGRESS");
    await writeFile(
      statePath,
      JSON.stringify(pullRequestState("COMPLETED", "SUCCESS")),
      "utf8",
    );
    const second = await service.inspect(input(root));
    assert.match(
      second.notifications[0]?.message ?? "",
      /IN_PROGRESS.*COMPLETED:SUCCESS/u,
    );
    await service.commentOnPullRequest({
      ...input(root),
      expectedHeadSha: second.headSha,
      number: 17,
      body: "General feedback",
    });
    await service.commentOnPullRequest({
      ...input(root),
      expectedHeadSha: second.headSha,
      number: 17,
      body: "Line feedback",
      path: "src/app.ts",
      line: 12,
      side: "RIGHT",
    });
    await assert.rejects(service.commentOnPullRequest({ ...input(root), expectedHeadSha: second.headSha, number: 17, body: "Malformed line feedback", path: "src/app.ts" }), /require both a path and line/u);
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[][][number]);
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "comment"));
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "api" &&
          args.some((value) => value === "path=src/app.ts") &&
          args.some((value) => value === "line=12"),
      ),
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.KESTREL_FAKE_GH_STATE;
    else process.env.KESTREL_FAKE_GH_STATE = previousState;
    if (previousCalls === undefined) delete process.env.KESTREL_FAKE_GH_CALLS;
    else process.env.KESTREL_FAKE_GH_CALLS = previousCalls;
  }
});

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-git-service-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Kestrel Test");
  await git(root, "config", "user.email", "kestrel@example.test");
  await writeFile(path.join(root, "tracked.txt"), "initial\n", "utf8");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "initial");
  const metadataDirectory = path.join(root, ".kestrel-test");
  await mkdir(metadataDirectory);
  const metadataPath = path.join(metadataDirectory, "git.json");
  const service = new WorkspaceGitService(metadataPath);
  await service.initialize();
  return { root, service, metadataPath };
}

function input(
  workspaceRoot: string,
  validationReadiness:
    | "not_run"
    | "running"
    | "ready"
    | "blocked"
    | "stale" = "ready",
) {
  return {
    sessionId: "session-1",
    threadId: "thread-1",
    workspaceRoot,
    candidateFingerprint,
    validationReadiness,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return result.stdout;
}

function pullRequestState(status: string, conclusion?: string) {
  return {
    number: 17,
    title: "Delivery",
    body: "Body",
    url: "https://github.com/LumiCorp/kestrel/pull/17",
    state: "OPEN",
    isDraft: true,
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "abc",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    files: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
    statusCheckRollup: [
      {
        databaseId: 7,
        name: "test",
        status,
        ...(conclusion ? { conclusion } : {}),
        detailsUrl: "https://example.test/check",
      },
    ],
    comments: [
      {
        id: "comment-1",
        body: "Looks good",
        author: { login: "reviewer" },
        createdAt: "2026-07-20T00:00:00Z",
      },
    ],
    reviews: [],
  };
}
