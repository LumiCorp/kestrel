import assert from "node:assert/strict";
import {
  kestrelOneGitHubIssueCreateTool,
  kestrelOneGitHubRepositoryReadTool,
} from "../tools/kestrelOne/githubActions.js";
import { contractTest } from "./helpers/contract-test.js";


contractTest("runtime.hermetic", "Kestrel One GitHub mutations send the pending approval ID", async () => {
  const requests: Request[] = [];
  const handler = kestrelOneGitHubIssueCreateTool.createHandler({
    kestrelOne: {
      appUrl: "https://kestrel.example",
      executionTicket: "execution-ticket",
    },
    runtime: {
      runId: "runtime-run",
      sessionId: "thread-1",
      approvalId: "runtime-run:4:abc123",
    },
    fetchImpl: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ ok: true });
    },
  });

  await handler({ repository: "acme/widgets", title: "Canary" });

  assert.equal(
    requests[0]?.headers.get("x-kestrel-approval-id"),
    "runtime-run:4:abc123"
  );
  assert.equal(requests[0]?.headers.get("x-kestrel-runtime-approval"), null);
});

contractTest("runtime.hermetic", "Kestrel One GitHub mutations fail closed without an approval ID", async () => {
  const handler = kestrelOneGitHubIssueCreateTool.createHandler({
    kestrelOne: {
      appUrl: "https://kestrel.example",
      executionTicket: "execution-ticket",
    },
    runtime: { runId: "runtime-run", sessionId: "thread-1" },
    fetchImpl: async () => Response.json({ ok: true }),
  });
  await assert.rejects(
    () => handler({ repository: "acme/widgets", title: "Canary" }),
    /Runtime GitHub approval ID is required/u
  );
});

contractTest("runtime.hermetic", "Kestrel One GitHub reads do not claim mutation approval", async () => {
  const requests: Request[] = [];
  const handler = kestrelOneGitHubRepositoryReadTool.createHandler({
    kestrelOne: {
      appUrl: "https://kestrel.example",
      executionTicket: "execution-ticket",
    },
    fetchImpl: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ ok: true });
    },
  });
  await handler({ repository: "acme/widgets", path: "README.md" });
  assert.equal(requests[0]?.headers.get("x-kestrel-approval-id"), null);
});
