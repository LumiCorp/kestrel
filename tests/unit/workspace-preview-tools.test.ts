import test from "node:test";
import assert from "node:assert/strict";
import {
  publishRetainedWorkspacePreview,
  workspacePreviewCloseTool,
  workspacePreviewInspectTool,
  workspacePreviewListTool,
  workspacePreviewPublishTool,
  workspacePreviewRenewTool,
} from "../../tools/kestrelOne/workspacePreviews.js";
import type {
  DevProcessRetainInput,
  DevProcessRetentionPromoteInput,
  DevProcessRetentionInspectInput,
  DevProcessRetentionReleaseInput,
  DevShellServicePort,
} from "../../src/devshell/contracts.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";

test(
  "Workspace preview tools call the governed Kestrel Edge lifecycle with the signed execution ticket",
  async () => {
    assert.match(
      workspacePreviewPublishTool.definition.description,
      /copy the returned preview\.url byte-for-byte/u,
    );
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const retentionCalls: Array<{ operation: string; input: unknown }> = [];
    const lifecycle: string[] = [];
    const expiresAt = "2026-08-12T18:00:00.000Z";
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      lifecycle.push(`request:${init?.method ?? "GET"}`);
      if (String(input).includes("/list/")) {
        return Response.json({ previews: [{ id: "preview-1", expiresAt }] });
      }
      if (String(input).includes("/inspect/")) {
        return Response.json({ port: 5173, status: "listening" });
      }
      return new Response(
        JSON.stringify(
          init?.method === "DELETE"
            ? { ok: true }
            : { preview: { id: "preview-1", url: "https://public.example", expiresAt } }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const context = {
      fetchImpl,
      devShellService: {
        async retainProcess(input: DevProcessRetainInput) {
          lifecycle.push("retain");
          retentionCalls.push({ operation: "retain", input });
          return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
        },
        async promoteProcessRetention(input: DevProcessRetentionPromoteInput) {
          lifecycle.push("promote");
          retentionCalls.push({ operation: "promote", input });
          return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
        },
        async inspectProcessRetention(input: DevProcessRetentionInspectInput) {
          retentionCalls.push({ operation: "inspect", input });
          return { status: "active" as const, processId: "process-1", lifecycle: "retained" as const, leases: [] };
        },
        async releaseProcessRetention(input: DevProcessRetentionReleaseInput) {
          retentionCalls.push({ operation: "release", input });
          return { status: "missing" as const, processId: "process-1", leases: [] };
        },
      } as unknown as DevShellServicePort,
      kestrelOne: {
        appUrl: "https://kestrel.example",
        executionTicket: "signed-ticket",
      },
    };

    const published = await workspacePreviewPublishTool.createHandler(context)({
      port: 5173,
      sessionId: "process-1",
    });
    await workspacePreviewListTool.createHandler(context)({});
    await workspacePreviewInspectTool.createHandler(context)({ port: 5173 });
    await workspacePreviewRenewTool.createHandler(context)({
      previewId: "preview-1",
      ttlMinutes: 30,
    });
    await workspacePreviewCloseTool.createHandler(context)({
      previewId: "preview-1",
    });

    assert.match(
      (published as { warning: string }).warning,
      /Anyone with the URL/u
    );
    assert.deepEqual(lifecycle.slice(0, 3), ["retain", "request:POST", "promote"]);
    assert.equal((published as { preview: { retentionStatus: string } }).preview.retentionStatus, "active");
    const provisional = retentionCalls[0]?.input as DevProcessRetainInput;
    assert.match(provisional.leaseId, /^workspace-preview-publish:/u);
    assert.equal(provisional.processId, "process-1");
    assert.equal(provisional.kind, "workspace_preview_provisional");
    assert.ok(new Date(provisional.expiresAt).getTime() > Date.now());
    assert.deepEqual(retentionCalls.slice(1), [
      {
        operation: "promote",
        input: {
          processId: "process-1",
          fromLeaseId: provisional.leaseId,
          leaseId: "workspace-preview:preview-1",
          kind: "workspace_preview",
          expiresAt,
        },
      },
      { operation: "inspect", input: { leaseId: "workspace-preview:preview-1" } },
      { operation: "inspect", input: { leaseId: "workspace-preview:preview-1" } },
      {
        operation: "retain",
        input: {
          processId: "process-1",
          leaseId: "workspace-preview:preview-1",
          kind: "workspace_preview",
          expiresAt,
        },
      },
      { operation: "release", input: { leaseId: "workspace-preview:preview-1" } },
    ]);
    assert.deepEqual(
      requests.map(({ url, init }) => [url, init?.method ?? "GET"]),
      [
        ["https://kestrel.example/api/runtime/apps/built_in.previews/publish/auto/previews", "POST"],
        ["https://kestrel.example/api/runtime/apps/built_in.previews/list/auto/previews", "GET"],
        ["https://kestrel.example/api/runtime/apps/built_in.previews/inspect/auto/ports/5173", "GET"],
        ["https://kestrel.example/api/runtime/apps/built_in.previews/renew/auto/previews/preview-1", "POST"],
        ["https://kestrel.example/api/runtime/apps/built_in.previews/close/auto/previews/preview-1", "DELETE"],
      ]
    );
    assert.equal(
      (requests[0]?.init?.headers as Record<string, string>).authorization,
      "Bearer signed-ticket"
    );
  }
);

test("Workspace preview tools select the renewable hosted App relay", async () => {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const context = {
    fetchImpl: (async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      return Response.json({ port: 43110, status: "listening" });
    }) as typeof fetch,
    kestrelOne: {
      appUrl: "https://control-plane.example",
      executionTicket: "short-lived-ticket",
      appRelayUrl: "http://gateway.internal:43100",
      appRelayToken: "stable-workspace-token",
      executionRunId: "execution-1",
    },
  };

  const result = await workspacePreviewInspectTool.createHandler(context)({
    port: 43_110,
  });

  assert.deepEqual(result, { port: 43_110, status: "listening" });
  assert.deepEqual(requests, [{
    url: "http://gateway.internal:43100/internal/apps/execution-1/api/runtime/apps/built_in.previews/inspect/auto/ports/43110",
    authorization: "Bearer stable-workspace-token",
  }]);
});

test("shared retained publication uses the invoking file-share approval without changing the Preview App route", async () => {
  const requests: string[] = [];
  const context = {
    fetchImpl: (async (input) => {
      requests.push(String(input));
      return Response.json({
        preview: {
          id: "preview-share",
          url: "https://public.example",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    }) as typeof fetch,
    devShellService: {
      async retainProcess(input: DevProcessRetainInput) {
        return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
      },
      async promoteProcessRetention(input: DevProcessRetentionPromoteInput) {
        return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
      },
      async releaseProcessRetention() {
        return { status: "missing" as const, leases: [] };
      },
    } as unknown as DevShellServicePort,
    runtime: { runId: "run-1", sessionId: "session-1", approvalId: "approval-1" },
    kestrelOne: {
      appUrl: "https://kestrel.example",
      executionTicket: "signed-ticket",
      appApprovalModes: { "workspace.files.share": "ask" as const },
    },
  };

  await publishRetainedWorkspacePreview(context, {
    port: 43110,
    sessionId: "process-1",
    approvalToolName: "workspace.files.share",
  });

  assert.deepEqual(requests, [
    "https://kestrel.example/api/runtime/apps/built_in.previews/publish/confirmed%3Aapproval-1/previews",
  ]);
});

test("Workspace preview publication does not call Edge when provisional retention fails", async () => {
  const methods: string[] = [];
  const context = {
    fetchImpl: (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return init?.method === "DELETE"
        ? Response.json({ ok: true })
        : Response.json({ preview: { id: "preview-1", expiresAt: "2026-08-12T18:00:00.000Z" } });
    }) as typeof fetch,
    devShellService: {
      async retainProcess() {
        throw new Error("process missing");
      },
      async releaseProcessRetention() {
        return { status: "missing" as const, leases: [] };
      },
    } as unknown as DevShellServicePort,
    kestrelOne: { appUrl: "https://kestrel.example", executionTicket: "signed-ticket" },
  };

  await assert.rejects(
    workspacePreviewPublishTool.createHandler(context)({ port: 5173, sessionId: "process-1" }),
    /process missing/u,
  );
  assert.deepEqual(methods, []);
});

test("Workspace preview publication releases provisional retention when Edge publication fails", async () => {
  const operations: string[] = [];
  let provisionalLeaseId = "";
  const context = {
    fetchImpl: (async (_input, init) => {
      operations.push("publish");
      assert.equal(init?.method, "POST");
      return Response.json(
        { error: { code: "PREVIEW_PORT_NOT_LISTENING" } },
        { status: 409 },
      );
    }) as typeof fetch,
    devShellService: {
      async retainProcess(input: DevProcessRetainInput) {
        operations.push("retain");
        provisionalLeaseId = input.leaseId;
        return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
      },
      async releaseProcessRetention(input: DevProcessRetentionReleaseInput) {
        operations.push("release");
        assert.equal(input.leaseId, provisionalLeaseId);
        return { status: "missing" as const, leases: [] };
      },
    } as unknown as DevShellServicePort,
    kestrelOne: { appUrl: "https://kestrel.example", executionTicket: "signed-ticket" },
  };

  await assert.rejects(
    workspacePreviewPublishTool.createHandler(context)({ port: 5173, sessionId: "process-1" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PREVIEW_PORT_NOT_LISTENING");
      return true;
    },
  );
  assert.deepEqual(operations, ["retain", "publish", "release"]);
});

test("Workspace preview publication closes the URL then releases provisional retention when promotion fails", async () => {
  const operations: string[] = [];
  let provisionalLeaseId = "";
  const signal = new AbortController().signal;
  const context = {
    fetchImpl: (async (_input, init) => {
      if (init?.method === "DELETE") {
        operations.push("close");
        assert.equal(init.signal, undefined);
        return Response.json({ ok: true });
      }
      operations.push("publish");
      return Response.json({
        preview: {
          id: "preview-1",
          url: "https://public.example",
          expiresAt: "2026-08-12T18:00:00.000Z",
        },
      });
    }) as typeof fetch,
    devShellService: {
      async retainProcess(input: DevProcessRetainInput) {
        operations.push("retain");
        provisionalLeaseId = input.leaseId;
        return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
      },
      async promoteProcessRetention(input: DevProcessRetentionPromoteInput) {
        operations.push("promote");
        assert.equal(input.fromLeaseId, provisionalLeaseId);
        throw new Error("promotion unavailable");
      },
      async releaseProcessRetention(input: DevProcessRetentionReleaseInput) {
        operations.push("release");
        assert.equal(input.leaseId, provisionalLeaseId);
        return { status: "missing" as const, leases: [] };
      },
    } as unknown as DevShellServicePort,
    signal,
    kestrelOne: { appUrl: "https://kestrel.example", executionTicket: "signed-ticket" },
  };

  await assert.rejects(
    workspacePreviewPublishTool.createHandler(context)({ port: 5173, sessionId: "process-1" }),
    /promotion unavailable/u,
  );
  assert.deepEqual(operations, ["retain", "publish", "promote", "close", "release"]);
});

test("Workspace preview publication closes a created URL when authoritative expiry validation fails", async () => {
  const operations: string[] = [];
  const context = {
    fetchImpl: (async (_input, init) => {
      if (init?.method === "DELETE") {
        operations.push("close");
        return Response.json({ ok: true });
      }
      operations.push("publish");
      return Response.json({ preview: { id: "preview-invalid", expiresAt: "not-a-date" } });
    }) as typeof fetch,
    devShellService: {
      async retainProcess(input: DevProcessRetainInput) {
        operations.push("retain");
        return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
      },
      async releaseProcessRetention() {
        operations.push("release");
        return { status: "missing" as const, leases: [] };
      },
    } as unknown as DevShellServicePort,
    kestrelOne: { appUrl: "https://kestrel.example", executionTicket: "signed-ticket" },
  };

  await assert.rejects(
    workspacePreviewPublishTool.createHandler(context)({ port: 5173, sessionId: "process-1" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "WORKSPACE_PREVIEW_RESPONSE_INVALID");
      return true;
    },
  );
  assert.deepEqual(operations, ["retain", "publish", "close", "release"]);
});

test("Workspace preview publication forwards cancellation and uses the failure cleanup path", async () => {
  const operations: string[] = [];
  const controller = new AbortController();
  const context = {
    fetchImpl: (async (_input, init) => {
      operations.push("publish");
      assert.equal(init?.signal, controller.signal);
      if (init?.signal?.aborted === true) throw init.signal.reason;
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    }) as typeof fetch,
    devShellService: {
      async retainProcess(input: DevProcessRetainInput) {
        operations.push("retain");
        return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
      },
      async releaseProcessRetention() {
        operations.push("release");
        return { status: "missing" as const, leases: [] };
      },
    } as unknown as DevShellServicePort,
    signal: controller.signal,
    kestrelOne: { appUrl: "https://kestrel.example", executionTicket: "signed-ticket" },
  };

  const publication = workspacePreviewPublishTool.createHandler(context)({
    port: 5173,
    sessionId: "process-1",
  });
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(publication, /cancelled by caller/u);
  assert.deepEqual(operations, ["retain", "publish", "release"]);
});

test("Workspace preview publication cleans up final retention when cancelled during promotion", async () => {
  const operations: string[] = [];
  const controller = new AbortController();
  let resolvePromotionStarted!: () => void;
  const promotionStarted = new Promise<void>((resolve) => {
    resolvePromotionStarted = resolve;
  });
  let resolvePromotion!: () => void;
  const promotion = new Promise<void>((resolve) => {
    resolvePromotion = resolve;
  });
  let releasedLeaseId: string | undefined;
  const context = {
    fetchImpl: (async (_input, init) => {
      if (init?.method === "DELETE") {
        operations.push("close");
        return Response.json({ ok: true });
      }
      operations.push("publish");
      return Response.json({
        preview: {
          id: "preview-cancelled",
          url: "https://public.example/preview-cancelled",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      });
    }) as typeof fetch,
    devShellService: {
      async retainProcess(input: DevProcessRetainInput) {
        operations.push("retain");
        return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
      },
      async promoteProcessRetention() {
        operations.push("promote");
        resolvePromotionStarted();
        await promotion;
        return { status: "active" as const, processId: "process-1", lifecycle: "retained" as const, leases: [] };
      },
      async releaseProcessRetention(input: DevProcessRetentionReleaseInput) {
        operations.push("release");
        releasedLeaseId = input.leaseId;
        return { status: "missing" as const, processId: "process-1", leases: [] };
      },
    } as unknown as DevShellServicePort,
    signal: controller.signal,
    kestrelOne: { appUrl: "https://kestrel.example", executionTicket: "signed-ticket" },
  };

  const publication = workspacePreviewPublishTool.createHandler(context)({
    port: 5173,
    sessionId: "process-1",
  });
  await promotionStarted;
  controller.abort(new Error("cancelled during promotion"));
  resolvePromotion();

  await assert.rejects(publication, /cancelled during promotion/u);
  assert.deepEqual(operations, ["retain", "publish", "promote", "close", "release"]);
  assert.equal(releasedLeaseId, "workspace-preview:preview-cancelled");
});

test("Workspace preview publication preserves its primary error and attaches cleanup failure evidence", async () => {
  const primary = new Error("promotion failed");
  const context = {
    fetchImpl: (async (_input, init) => {
      if (init?.method === "DELETE") throw new Error("close failed");
      return Response.json({
        preview: {
          id: "preview-1",
          url: "https://public.example",
          expiresAt: "2026-08-12T18:00:00.000Z",
        },
      });
    }) as typeof fetch,
    devShellService: {
      async retainProcess(input: DevProcessRetainInput) {
        return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
      },
      async promoteProcessRetention() {
        throw primary;
      },
      async releaseProcessRetention() {
        throw new Error("release failed");
      },
    } as unknown as DevShellServicePort,
    kestrelOne: { appUrl: "https://kestrel.example", executionTicket: "signed-ticket" },
  };

  await assert.rejects(
    workspacePreviewPublishTool.createHandler(context)({ port: 5173, sessionId: "process-1" }),
    (error: unknown) => {
      assert.equal((error as Error).message, primary.message);
      assert.equal((error as Error).cause, primary);
      assert.deepEqual(
        (error as { cleanupFailures?: unknown }).cleanupFailures,
        [
          { operation: "close_preview", message: "close failed" },
          { operation: "release_provisional_retention", message: "release failed" },
        ],
      );
      assert.deepEqual(
        (error as { details?: { cleanupFailures?: unknown } }).details?.cleanupFailures,
        [
          { operation: "close_preview", message: "close failed" },
          { operation: "release_provisional_retention", message: "release failed" },
        ],
      );
      return true;
    },
  );
});

test("Workspace preview publication appends cleanup failures to promotion compensation evidence", async () => {
  const primary = new RuntimeFailure("PROMOTION_STORE_FAILED", "promotion failed", {
    cleanupFailures: [
      { operation: "restore_provisional_retention", message: "restore failed" },
    ],
  });
  const context = {
    fetchImpl: (async (_input, init) => {
      if (init?.method === "DELETE") throw new Error("close failed");
      return Response.json({
        preview: {
          id: "preview-1",
          url: "https://public.example",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      });
    }) as typeof fetch,
    devShellService: {
      async retainProcess(input: DevProcessRetainInput) {
        return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
      },
      async promoteProcessRetention() {
        throw primary;
      },
      async releaseProcessRetention() {
        throw new Error("release failed");
      },
    } as unknown as DevShellServicePort,
    kestrelOne: { appUrl: "https://kestrel.example", executionTicket: "signed-ticket" },
  };

  await assert.rejects(
    workspacePreviewPublishTool.createHandler(context)({ port: 5173, sessionId: "process-1" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PROMOTION_STORE_FAILED");
      assert.deepEqual(
        (error as { details?: { cleanupFailures?: unknown } }).details?.cleanupFailures,
        [
          { operation: "restore_provisional_retention", message: "restore failed" },
          { operation: "close_preview", message: "close failed" },
          { operation: "release_provisional_retention", message: "release failed" },
        ],
      );
      return true;
    },
  );
});
