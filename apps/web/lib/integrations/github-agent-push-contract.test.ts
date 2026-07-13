import assert from "node:assert/strict";
import test from "node:test";
import {
  githubAgentBranchName,
  githubRepositoryRemoteUrl,
  readGithubDefaultBranch,
} from "./github-agent-push-contract";

test("agent push refs are generated exclusively from the run identity", () => {
  assert.equal(githubAgentBranchName("run-123"), "kestrel/agent/run-123");
});

test("agent pushes require synchronized repository metadata", () => {
  assert.equal(readGithubDefaultBranch({ defaultBranch: "trunk" }), "trunk");
  assert.equal(readGithubDefaultBranch({}), null);
  assert.equal(
    githubRepositoryRemoteUrl("acme/private repo"),
    "https://github.com/acme/private%20repo.git"
  );
});
