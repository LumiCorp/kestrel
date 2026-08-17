import test from "node:test";
import assert from "node:assert/strict";

import {
  kestrelOneVercelDeploymentEventsTool,
  kestrelOneVercelListDeploymentsTool,
  kestrelOneVercelListProjectsTool,
} from "../../tools/kestrelOne/vercel.js";

test("Vercel inspection tools remain read-only", () => {
  for (const tool of [
    kestrelOneVercelListProjectsTool,
    kestrelOneVercelListDeploymentsTool,
    kestrelOneVercelDeploymentEventsTool,
  ]) {
    assert.equal(tool.definition.capability.executionClass, "read_only");
    assert.deepEqual(tool.definition.capability.approvalCapabilities, [
      "network.call",
    ]);
  }
});

test("Vercel tools bind the App capability and signed execution ticket", async () => {
  const requests: Array<{
    url: string;
    method: string | undefined;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];
  const context = {
    runtime: {
      runId: "run-1",
      sessionId: "session-1",
      approvalId: "approval-1",
    },
    kestrelOne: {
      appUrl: "https://kestrel.example",
      executionTicket: "signed-environment-ticket",
      appApprovalModes: {
        "kestrel_one.vercel_deployment_events": "ask" as const,
      },
    },
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ result: { ok: true } });
    },
  };

  await kestrelOneVercelListProjectsTool.createHandler(context)({
    limit: 5,
    search: "kestrel",
  });
  await kestrelOneVercelDeploymentEventsTool.createHandler(context)({
    deploymentId: "dpl_123",
    limit: 25,
  });

  assert.deepEqual(requests[0], {
    url: "https://kestrel.example/api/runtime/apps/vercel/projects.read/auto/projects",
    method: "POST",
    headers: new Headers({
      authorization: "Bearer signed-environment-ticket",
      "content-type": "application/json",
    }),
    body: { limit: 5, search: "kestrel" },
  });
  assert.equal(
    requests[1]?.url,
    "https://kestrel.example/api/runtime/apps/vercel/operations.read/confirmed%3Aapproval-1/deployment-events",
  );
  assert.deepEqual(requests[1]?.body, {
    deploymentId: "dpl_123",
    limit: 25,
  });
});
