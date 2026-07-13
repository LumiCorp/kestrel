import assert from "node:assert/strict";
import test from "node:test";
import {
  kestrelOneGitHubIssueCreateTool,
  kestrelOneGitHubRepositoryReadTool,
} from "../../tools/kestrelOne/githubActions.js";
import { kestrelOneGitHubPushAgentBranchTool } from "../../tools/kestrelOne/githubPushAgentBranch.js";

test("GitHub mutation tools require external confirmation while reads and agent-branch pushes remain automatic", () => {
  assert.deepEqual(
    kestrelOneGitHubRepositoryReadTool.definition.capability
      .approvalCapabilities,
    ["network.call"]
  );
  assert.deepEqual(
    kestrelOneGitHubPushAgentBranchTool.definition.capability
      .approvalCapabilities,
    ["network.call"]
  );
  assert.deepEqual(
    kestrelOneGitHubIssueCreateTool.definition.capability
      .approvalCapabilities,
    ["network.call", "external.confirm"]
  );
});

test("GitHub action tools send the signed execution ticket and confirmation only for approved mutations", async () => {
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    requests.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    return Response.json({ result: { ok: true } });
  };
  const context = {
    fetchImpl,
    kestrelOne: {
      appUrl: "https://kestrel.example",
      executionTicket: "signed-environment-ticket",
    },
  };

  await kestrelOneGitHubRepositoryReadTool.createHandler(context)({
    repository: "acme/widgets",
    path: "README.md",
  });
  await kestrelOneGitHubIssueCreateTool.createHandler(context)({
    repository: "acme/widgets",
    title: "Investigate regression",
  });

  assert.equal(requests[0]?.body.operation, "repository.read_file");
  assert.equal(
    requests[0]?.headers.get("authorization"),
    "Bearer signed-environment-ticket"
  );
  assert.equal(
    requests[0]?.headers.get("x-kestrel-runtime-approval"),
    null
  );
  assert.equal(requests[1]?.body.operation, "issue.create");
  assert.equal(
    requests[1]?.headers.get("x-kestrel-runtime-approval"),
    "confirmed"
  );
});
