import assert from "node:assert/strict";
import test from "node:test";

import type { ProductProjectSetupState } from "../src/project/contracts.js";
import { ProductProjectWorkspaceService } from "../src/project/workspace.js";
import type { ProductTaskGraph } from "../src/taskGraph/contracts.js";

const graph: ProductTaskGraph = {
  version: 1,
  activeTaskId: "task:thread:thread-main",
  rootTaskIds: ["task:thread:thread-main"],
  tasks: {
    "task:thread:thread-main": {
      id: "task:thread:thread-main",
      title: "Main task",
      order: 0,
      status: "active",
      source: "thread",
      proposedByAgent: false,
      linkedThreadId: "thread-main",
      linkedSessionId: "session-main",
      activeThreadLineageId: "thread-main",
      linkedBranch: "feature/review-desk",
      linkedPullRequest: {
        number: 42,
        title: "This title must not become a file path",
      },
      memory: {
        goal: "",
        currentPlan: "",
        findings: "",
        decisions: "",
        openQuestions: "",
        nextAction: "",
        linkedArtifacts: [],
      },
      runtime: {},
      updatedAt: "2026-03-18T12:00:00.000Z",
    },
  },
};

const baseSetup: ProductProjectSetupState = {
  workspaceRoot: "/tmp/repo",
  repoRoot: "/tmp/repo",
  repoLabel: "kestrel",
  defaultBranch: "main",
  providerProfileId: "reference-web",
  githubConnected: false,
  browserReady: true,
  codeReady: true,
  mcpReady: false,
};

test("inspectReviewDetail uses changed file paths for default selection", async () => {
  const runner = {
    async run(command: string, args: string[]) {
      if (command === "git" && args.join(" ") === "diff --name-status --find-renames main...HEAD") {
        return "M\tsrc/project/workspace.ts\n";
      }
      if (command === "git" && args.join(" ") === "log --oneline -n 12") {
        return "abcdef1 Add review desk\n";
      }
      if (command === "git" && args.join(" ") === "diff --unified=3 main...HEAD") {
        return "@@ -1 +1 @@\n-old\n+new\n";
      }
      if (command === "git" && args.join(" ") === "diff --unified=3 main...HEAD -- src/project/workspace.ts") {
        return "@@ -1 +1 @@\n-old\n+new\n";
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };

  const service = new ProductProjectWorkspaceService(runner);
  const detail = await service.inspectReviewDetail({
    setup: baseSetup,
    graph,
    target: {
      taskId: "task:thread:thread-main",
    },
  });

  assert.equal(detail.selectedFilePath, "src/project/workspace.ts");
  assert.equal(detail.changedFiles[0]?.path, "src/project/workspace.ts");
  assert.equal(detail.diffHunks[0]?.header, "@@ -1 +1 @@");
});

test("inspectReviewDetail merges GitHub review metadata when connected", async () => {
  const runner = {
    async run(command: string, args: string[]) {
      if (command === "git" && args.join(" ") === "diff --name-status --find-renames main...HEAD") {
        return "M\tsrc/project/workspace.ts\n";
      }
      if (command === "git" && args.join(" ") === "log --oneline -n 12") {
        return "abcdef1 Add review desk\n";
      }
      if (command === "git" && args.join(" ") === "diff --unified=3 main...HEAD") {
        return "@@ -1 +1 @@\n-old\n+new\n";
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          number: 42,
          title: "Add full review desk",
          state: "OPEN",
          url: "https://example.com/pr/42",
          baseRefName: "main",
          headRefOid: "abcdef123456",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          files: [
            {
              path: "src/project/workspace.ts",
              additions: 10,
              deletions: 2,
            },
          ],
          statusCheckRollup: [
            {
              __typename: "CheckRun",
              databaseId: 99,
              name: "test",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              detailsUrl: "https://example.com/check/99",
            },
          ],
          comments: [
            {
              id: "issue-comment-1",
              author: { login: "reviewer" },
              body: "Looks good",
              createdAt: "2026-03-18T10:00:00.000Z",
            },
          ],
          reviews: [
            {
              id: "review-1",
              author: { login: "approver" },
              body: "Approved",
              state: "APPROVED",
              createdAt: "2026-03-18T10:05:00.000Z",
            },
          ],
        });
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };

  const service = new ProductProjectWorkspaceService(runner);
  const detail = await service.inspectReviewDetail({
    setup: {
      ...baseSetup,
      githubConnected: true,
      githubOwner: "greg",
      githubRepo: "kestrel",
    },
    graph,
    target: {
      taskId: "task:thread:thread-main",
      pullRequestNumber: 42,
    },
  });

  assert.equal(detail.pullRequestNumber, 42);
  assert.equal(detail.reviewDecision, "APPROVED");
  assert.equal(detail.checks[0]?.name, "test");
  assert.equal(detail.comments.length, 2);
});

test("applyReviewAction posts file-scoped comments through GitHub API", async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner = {
    async run(command: string, args: string[], cwd: string) {
      calls.push({ command, args, cwd });
      if (command === "git" && args.join(" ") === "rev-parse HEAD") {
        return "abcdef123456\n";
      }
      return "";
    },
  };

  const service = new ProductProjectWorkspaceService(runner);
  await service.applyReviewAction({
    setup: {
      ...baseSetup,
      githubConnected: true,
      githubOwner: "greg",
      githubRepo: "kestrel",
    },
    action: {
      type: "review.comment.create",
      sessionId: "session-main",
      target: {
        taskId: "task:thread:thread-main",
        pullRequestNumber: 42,
      },
      body: "Please tighten this branch selection.",
      path: "src/project/workspace.ts",
      line: 14,
      side: "RIGHT",
    },
  });

  assert.equal(calls[0]?.command, "git");
  assert.equal(calls[1]?.command, "gh");
  assert.match(calls[1]?.args.join(" "), /pulls\/42\/comments/);
  assert.match(calls[1]?.args.join(" "), /path=src\/project\/workspace\.ts/);
});

test("inspectReviewState drops invalid branch and pull request summaries", async () => {
  const runner = {
    async run(command: string, args: string[]) {
      if (command === "git" && args.join(" ") === "branch --show-current") {
        return "feature/review-desk\n";
      }
      if (command === "git" && args.join(" ") === "status --short --branch") {
        return "## feature/review-desk\n";
      }
      if (command === "git" && args.join(" ") === "for-each-ref refs/heads --format=%(refname:short)|%(HEAD)") {
        return "main|\nfeature/review-desk|*\n|*\n";
      }
      if (command === "git" && args.join(" ") === "worktree list --porcelain") {
        return "worktree /tmp/repo\nHEAD abcdef1\nbranch refs/heads/feature/review-desk\n";
      }
      if (command === "git" && args.join(" ") === "log --oneline -n 8") {
        return "abcdef1 Add review desk\n";
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 42,
            title: "Valid PR",
            headRefName: "feature/review-desk",
            baseRefName: "main",
            state: "OPEN",
          },
          {
            number: 43,
            title: "Missing branch",
            baseRefName: "main",
          },
        ]);
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };

  const service = new ProductProjectWorkspaceService(runner);
  const snapshot = await service.inspectReviewState(
    {
      ...baseSetup,
      githubConnected: true,
    },
    graph,
  );

  assert.deepEqual(snapshot.branches, [
    { name: "main" },
    { name: "feature/review-desk", current: true },
  ]);
  assert.equal(snapshot.pullRequests.length, 1);
  assert.equal(snapshot.pullRequests[0]?.number, 42);
});
