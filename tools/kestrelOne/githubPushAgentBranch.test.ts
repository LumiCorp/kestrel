import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { kestrelOneGitHubPushAgentBranchTool } from "./githubPushAgentBranch.js";

const execFileAsync = promisify(execFile);

test("empty GitHub targets return a successful Workspace review action", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-github-tool-"));
  try {
    await git(workspaceRoot, ["init", "--initial-branch=main"]);
    await git(workspaceRoot, ["config", "user.name", "Kestrel Test"]);
    await git(workspaceRoot, ["config", "user.email", "test@kestrel.invalid"]);
    await writeFile(path.join(workspaceRoot, "river.txt"), "base\n", "utf8");
    await git(workspaceRoot, ["add", "river.txt"]);
    await git(workspaceRoot, ["commit", "-m", "base"]);
    await writeFile(
      path.join(workspaceRoot, "river.txt"),
      "reviewed candidate\n",
      "utf8",
    );

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const handler = kestrelOneGitHubPushAgentBranchTool.createHandler({
      fileSystem: { workspaceRoot, tempRoots: [] },
      runtime: { sessionId: "thread-1", runId: "run-1" },
      kestrelOne: {
        appUrl: "https://kestrel.example",
        executionTicket: "execution-ticket",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: url.toString(), init });
        if (url.toString().endsWith("/api/runtime/github/credentials")) {
          return Response.json({
            token: "scoped-credential",
            expiresAt: 1060,
            resourceId: "11111111-1111-4111-8111-111111111111",
            repository: "greg/riverbats",
          });
        }
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer scoped-credential",
        );
        await new Response(init?.body as BodyInit).arrayBuffer();
        return Response.json(
          { error: { code: "GITHUB_REPOSITORY_INITIALIZATION_REQUIRED" } },
          { status: 409 },
        );
      },
    });
    const result = (await handler({ repository: "greg/riverbats" })) as {
      output: {
        status: string;
        repository: string;
        workspaceUrl: string;
        candidateFingerprint: string;
      };
      presentation: { artifacts: Array<{ title: string; url: string }> };
    };
    assert.equal(result.output.status, "review_required");
    assert.equal(result.output.repository, "greg/riverbats");
    assert.equal(
      result.output.workspaceUrl,
      "/threads/thread-1/workspace?runId=run-1&repository=greg%2Friverbats",
    );
    assert.equal(
      result.presentation.artifacts[0]?.title,
      "Review and initialize in Workspace",
    );
    const credentialRequest = JSON.parse(String(requests[0]?.init?.body)) as {
      operation: string;
      candidateFingerprint: string;
      candidateCommit: string;
    };
    assert.equal(credentialRequest.operation, "repository.push_agent_branch");
    assert.equal(
      credentialRequest.candidateFingerprint,
      credentialRequest.candidateCommit,
    );
    assert.match(credentialRequest.candidateCommit, /^[0-9a-f]{40,64}$/u);
    assert.equal(requests.length, 2);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}
