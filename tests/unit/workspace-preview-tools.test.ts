import test from "node:test";
import assert from "node:assert/strict";
import {
  workspacePreviewCloseTool,
  workspacePreviewInspectTool,
  workspacePreviewListTool,
  workspacePreviewPublishTool,
  workspacePreviewRenewTool,
} from "../../tools/kestrelOne/workspacePreviews.js";
import type {
  DevProcessRetainInput,
  DevProcessRetentionInspectInput,
  DevProcessRetentionReleaseInput,
  DevShellServicePort,
} from "../../src/devshell/contracts.js";

test(
  "Workspace preview tools call the governed Kestrel Edge lifecycle with the signed execution ticket",
  async () => {
    assert.match(
      workspacePreviewPublishTool.definition.description,
      /copy the returned preview\.url byte-for-byte/u,
    );
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const retentionCalls: Array<{ operation: string; input: unknown }> = [];
    const expiresAt = "2026-08-12T18:00:00.000Z";
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
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
          retentionCalls.push({ operation: "retain", input });
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
    assert.equal((published as { preview: { retentionStatus: string } }).preview.retentionStatus, "active");
    assert.deepEqual(retentionCalls, [
      {
        operation: "retain",
        input: {
          processId: "process-1",
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

test("Workspace preview publication closes the URL when process retention fails", async () => {
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
    } as unknown as DevShellServicePort,
    kestrelOne: { appUrl: "https://kestrel.example", executionTicket: "signed-ticket" },
  };

  await assert.rejects(
    workspacePreviewPublishTool.createHandler(context)({ port: 5173, sessionId: "process-1" }),
    /process missing/u,
  );
  assert.deepEqual(methods, ["POST", "DELETE"]);
});
