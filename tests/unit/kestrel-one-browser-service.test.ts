import assert from "node:assert/strict";
import test from "node:test";
import type { PreparedToolCallV1 } from "../../src/kestrel/contracts/tool-invocation.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { createKestrelOneBrowserService } from "../../tools/kestrelOne/browserService.js";

const prepared = {
  version: "v1",
  runId: "run-1",
  sessionId: "runtime-session-1",
  callId: "call-1",
  activation: { descriptor: { toolId: "browser.navigate" } },
  effectiveInput: { sessionId: "browser-session-1", generation: 1 },
} as unknown as PreparedToolCallV1;

const preparedGrant = {
  ...prepared,
  activation: { descriptor: { toolId: "browser.request_grant" } },
} as unknown as PreparedToolCallV1;

const preparedUpload = {
  ...prepared,
  activation: { descriptor: { toolId: "browser.upload" } },
  effectiveInput: {
    sessionId: "browser-session-1",
    generation: 1,
    snapshotId: "snapshot-1",
    targetRef: "@e1",
    attachmentId: "attachment-1",
  },
} as unknown as PreparedToolCallV1;

const preparedDownload = {
  ...prepared,
  activation: { descriptor: { toolId: "browser.download" } },
  effectiveInput: {
    sessionId: "browser-session-1",
    generation: 1,
    pendingDownloadId: "download-1",
  },
} as unknown as PreparedToolCallV1;

test("a prepared approval ID cannot supply missing transfer runtime authority", async () => {
  let calls = 0;
  const service = createKestrelOneBrowserService({
    kestrelOne: {
      appRelayUrl: "https://relay.example.test",
      appRelayToken: "test",
      executionRunId: "run-1",
    },
    fetchImpl: (async () => {
      calls++;
      return Response.json({});
    }) as typeof fetch,
  });
  await assert.rejects(
    service.execute(
      {
        ...preparedUpload,
        approval: { approvalId: "pending", authorityRevision: "test" },
      },
      {
        authority: { threadId: "thread-1" },
        async acknowledgeDispatch() {
          assert.fail("must not dispatch");
        },
        async persistCompletedResult() {
          assert.fail("must not persist");
        },
      },
    ),
    /trusted runtime authority/,
  );
  assert.equal(calls, 0);
});

test("hosted Browser transport acknowledges only after exact worker acceptance", async () => {
  const events: string[] = [];
  const requests: string[] = [];
  const service = createKestrelOneBrowserService({
    kestrelOne: {
      appRelayUrl: "https://relay.example.test",
      appRelayToken: "relay-token-1",
      executionRunId: "run-1",
    },
    fetchImpl: (async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/control/accept")) {
        events.push("accepted");
        return Response.json({
          version: "hosted_browser_dispatch_receipt_v1",
          receiptId: "receipt-1",
          operationId: "call-1",
          operation: "browser.navigate",
        });
      }
      if (String(url).endsWith("/control/commit")) {
        events.push("committed");
        return Response.json({ committed: true });
      }
      events.push("invoked");
      return Response.json({
        version: "hosted_browser_invocation_result_v1",
        output: {
          version: "browser_tool_result_v1",
          operation: "browser.navigate",
          sessionId: "browser-session-1",
          generation: 1,
          outcome: "navigated",
        },
        commitReceipt: {
          version: "hosted_browser_commit_receipt_v1",
          receiptId: "receipt-1",
          operationId: "call-1",
          operation: "browser.navigate",
        },
      });
    }) as typeof fetch,
  });
  const output = await service.execute(prepared, {
    authority: { threadId: "thread-1", projectId: "project-1" },
    async acknowledgeDispatch() {
      events.push("acknowledged");
    },
    async persistCompletedResult() {
      events.push("persisted");
    },
  });
  assert.deepEqual(events, [
    "accepted",
    "acknowledged",
    "invoked",
    "persisted",
    "committed",
  ]);
  assert.match(requests[0] ?? "", /control\/accept$/u);
  assert.match(requests[1] ?? "", /control\/invoke$/u);
  assert.match(requests[2] ?? "", /control\/commit$/u);
  assert.equal((output as Record<string, unknown>).outcome, "navigated");
});

test("hosted upload acknowledges only after the dedicated byte transfer is staged", async () => {
  const events: string[] = [];
  let invokes = 0;
  const service = createKestrelOneBrowserService({
    runtime: {
      runId: "run-1",
      sessionId: "runtime-session-1",
      threadId: "thread-1",
    },
    kestrelOne: {
      appRelayUrl: "https://relay.example.test",
      appRelayToken: "relay-token-1",
      executionRunId: "run-1",
    },
    fetchImpl: (async (url) => {
      assert.match(String(url), /\/upload\/confirmed\/control\//u);
      if (String(url).endsWith("/control/accept")) {
        events.push("accepted");
        return Response.json({
          version: "hosted_browser_dispatch_receipt_v1",
          receiptId: "receipt-upload-1",
          operationId: "call-1",
          operation: "browser.upload",
        });
      }
      if (String(url).endsWith("/control/invoke")) {
        invokes += 1;
        if (invokes === 1) {
          events.push("staged");
          return Response.json({
            version: "hosted_browser_upload_staged_receipt_v1",
            receiptId: "receipt-upload-1",
            operationId: "call-1",
            operation: "browser.upload",
          });
        }
        events.push("invoked");
        return Response.json({
          version: "hosted_browser_invocation_result_v1",
          output: { outcome: "uploaded" },
          commitReceipt: {
            version: "hosted_browser_commit_receipt_v1",
            receiptId: "receipt-upload-1",
            operationId: "call-1",
            operation: "browser.upload",
          },
        });
      }
      events.push("committed");
      return Response.json({ committed: true });
    }) as typeof fetch,
  });
  await service.execute(preparedUpload, {
    authority: { threadId: "thread-1", projectId: "project-1" },
    async acknowledgeDispatch() {
      events.push("acknowledged");
    },
    async persistCompletedResult() {
      events.push("persisted");
    },
  });
  assert.deepEqual(events, [
    "accepted",
    "staged",
    "acknowledged",
    "invoked",
    "persisted",
    "committed",
  ]);
});

test("hosted download acknowledges only after the dedicated worker bytes are staged", async () => {
  const events: string[] = [];
  const artifactRequests: string[] = [];
  const artifact = {
    runId: "run-1",
    sessionId: "runtime-session-1",
    callId: "call-1",
    toolName: "browser.download",
  } as never;
  let invokes = 0;
  const service = createKestrelOneBrowserService({
    runtime: {
      runId: "run-1",
      sessionId: "runtime-session-1",
      threadId: "thread-1",
    },
    kestrelOne: {
      appRelayUrl: "https://relay.example.test",
      appRelayToken: "relay-token-1",
      executionRunId: "run-1",
    },
    fetchImpl: (async (url) => {
      if (String(url).endsWith("/control/artifact")) {
        artifactRequests.push(String(url));
        return Response.json(null);
      }
      assert.match(String(url), /\/download\/confirmed\/control\//u);
      if (String(url).endsWith("/control/accept")) {
        events.push("accepted");
        return Response.json({
          version: "hosted_browser_dispatch_receipt_v1",
          receiptId: "receipt-download-1",
          operationId: "call-1",
          operation: "browser.download",
        });
      }
      if (String(url).endsWith("/control/invoke")) {
        invokes += 1;
        if (invokes === 1) {
          events.push("staged");
          return Response.json({
            version: "hosted_browser_download_staged_receipt_v1",
            receiptId: "receipt-download-1",
            operationId: "call-1",
            operation: "browser.download",
          });
        }
        events.push("invoked");
        return Response.json({
          version: "hosted_browser_invocation_result_v1",
          output: { version: "hosted_browser_download_result_v1" },
          commitReceipt: {
            version: "hosted_browser_commit_receipt_v1",
            receiptId: "receipt-download-1",
            operationId: "call-1",
            operation: "browser.download",
          },
        });
      }
      events.push("committed");
      return Response.json({ committed: true });
    }) as typeof fetch,
  });
  await service.execute(preparedDownload, {
    authority: { threadId: "thread-1", projectId: "project-1" },
    async acknowledgeDispatch() {
      events.push("acknowledged");
    },
    async persistCompletedResult() {
      await service.authorizeArtifact(artifact);
      events.push("persisted");
    },
  });
  await service.authorizeArtifact(artifact);
  assert.match(artifactRequests[0]!, /\/confirmed\/control\/artifact$/u);
  assert.match(artifactRequests[1]!, /\/auto\/control\/artifact$/u);
  assert.deepEqual(events, [
    "accepted",
    "staged",
    "acknowledged",
    "invoked",
    "persisted",
    "committed",
  ]);
});

test("prepared download release uses the Browser-only cleanup action", async () => {
  const requests: string[] = [];
  const service = createKestrelOneBrowserService({
    kestrelOne: {
      appRelayUrl: "https://relay.example.test",
      appRelayToken: "relay-token-1",
      executionRunId: "run-1",
    },
    fetchImpl: (async (url) => {
      requests.push(String(url));
      return Response.json({ released: true, operationId: "call-1" });
    }) as typeof fetch,
  });
  await service.releasePreparedDownload?.(preparedDownload, {
    threadId: "thread-1",
    projectId: "project-1",
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0] ?? "", /control\/release-download$/u);
  assert.match(requests[0] ?? "", /\/download\/auto\//u);
});

test("transfer preparation never claims confirmation from a supplied approval ID", async () => {
  const requests: string[] = [];
  const service = createKestrelOneBrowserService({
    kestrelOne: {
      appRelayUrl: "https://relay.example.test",
      appRelayToken: "test",
      executionRunId: "run-1",
    },
    fetchImpl: (async (url) => {
      requests.push(String(url));
      return Response.json({ error: { code: "fixture" } }, { status: 400 });
    }) as typeof fetch,
  });
  await assert.rejects(
    service.prepareUpload({ approvalId: "not-proof" } as never),
  );
  await assert.rejects(
    service.prepareDownload({ approvalId: "not-proof" } as never),
  );
  assert.equal(requests.length, 2);
  for (const request of requests)
    assert.match(request, /\/auto\/control\/prepare-/u);
});

test("hosted prepared download release never accepts missing stable authority", async () => {
  let requests = 0;
  const service = createKestrelOneBrowserService({
    kestrelOne: {
      appRelayUrl: "https://relay.example.test",
      appRelayToken: "relay-token-1",
      executionRunId: "run-1",
    },
    fetchImpl: (async () => {
      requests += 1;
      return Response.json({ released: true });
    }) as typeof fetch,
  });
  assert.ok(service.releasePreparedDownload);
  await assert.rejects(
    service.releasePreparedDownload(preparedDownload),
    (error: unknown) =>
      error instanceof RuntimeFailure &&
      error.code === "BROWSER_SERVICE_UNAVAILABLE",
  );
  assert.equal(requests, 0);
});

test("invalid acceptance never acknowledges or invokes", async () => {
  let acknowledged = false;
  let calls = 0;
  const service = createKestrelOneBrowserService({
    kestrelOne: {
      appRelayUrl: "https://relay.example.test",
      appRelayToken: "relay-token-1",
      executionRunId: "run-1",
    },
    fetchImpl: (async () => {
      calls += 1;
      return Response.json({
        version: "hosted_browser_dispatch_receipt_v1",
        receiptId: "receipt-1",
        operationId: "wrong-call",
        operation: "browser.navigate",
      });
    }) as typeof fetch,
  });
  await assert.rejects(
    service.execute(prepared, {
      authority: { threadId: "thread-1", projectId: "project-1" },
      async acknowledgeDispatch() {
        acknowledged = true;
      },
      async persistCompletedResult() {},
    }),
  );
  assert.equal(acknowledged, false);
  assert.equal(calls, 1);
});

test("pre-dispatch completion persists without acknowledgement and ignores a lost commit response", async () => {
  const events: string[] = [];
  const service = createKestrelOneBrowserService({
    kestrelOne: {
      appRelayUrl: "https://relay.example.test",
      appRelayToken: "relay-token-1",
      executionRunId: "run-1",
    },
    fetchImpl: (async (url) => {
      if (String(url).endsWith("/control/accept")) {
        return Response.json({
          version: "hosted_browser_pre_dispatch_result_v1",
          output: { outcome: "already_allowed" },
          commitReceipt: {
            version: "hosted_browser_commit_receipt_v1",
            receiptId: "receipt-pre-1",
            operationId: "call-1",
            operation: "browser.request_grant",
          },
        });
      }
      events.push("commit-attempted");
      return Response.json(
        { error: { code: "BROWSER_ACTION_OUTCOME_UNKNOWN" } },
        { status: 409 },
      );
    }) as typeof fetch,
  });
  const output = await service.execute(preparedGrant, {
    authority: { threadId: "thread-1", projectId: "project-1" },
    async acknowledgeDispatch() {
      events.push("acknowledged");
    },
    async persistCompletedResult() {
      events.push("persisted");
    },
  });
  assert.deepEqual(events, ["persisted", "commit-attempted"]);
  assert.equal((output as Record<string, unknown>).outcome, "already_allowed");
});

test("lost commit response does not replace an already persisted invocation result", async () => {
  const events: string[] = [];
  const service = createKestrelOneBrowserService({
    kestrelOne: {
      appRelayUrl: "https://relay.example.test",
      appRelayToken: "relay-token-1",
      executionRunId: "run-1",
    },
    fetchImpl: (async (url) => {
      if (String(url).endsWith("/control/accept")) {
        return Response.json({
          version: "hosted_browser_dispatch_receipt_v1",
          receiptId: "receipt-1",
          operationId: "call-1",
          operation: "browser.navigate",
        });
      }
      if (String(url).endsWith("/control/invoke")) {
        return Response.json({
          version: "hosted_browser_invocation_result_v1",
          output: { outcome: "navigated" },
          commitReceipt: {
            version: "hosted_browser_commit_receipt_v1",
            receiptId: "receipt-1",
            operationId: "call-1",
            operation: "browser.navigate",
          },
        });
      }
      events.push("commit-attempted");
      throw new Error("commit response lost");
    }) as typeof fetch,
  });
  const output = await service.execute(prepared, {
    authority: { threadId: "thread-1", projectId: "project-1" },
    async acknowledgeDispatch() {
      events.push("acknowledged");
    },
    async persistCompletedResult() {
      events.push("persisted");
    },
  });
  assert.deepEqual(events, ["acknowledged", "persisted", "commit-attempted"]);
  assert.equal((output as Record<string, unknown>).outcome, "navigated");
});
