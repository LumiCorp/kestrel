import test from "node:test";
import assert from "node:assert/strict";
import {
  workspacePreviewCloseTool,
  workspacePreviewInspectTool,
  workspacePreviewListTool,
  workspacePreviewPublishTool,
  workspacePreviewRenewTool,
} from "../../tools/kestrelOne/workspacePreviews.js";

test(
  "Workspace preview tools call the governed Kestrel Edge lifecycle with the signed execution ticket",
  async () => {
    assert.match(
      workspacePreviewPublishTool.definition.description,
      /copy the returned preview\.url byte-for-byte/u,
    );
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify(
          init?.method === "DELETE"
            ? { ok: true }
            : { preview: { id: "preview-1", url: "https://public.example" } }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const context = {
      fetchImpl,
      kestrelOne: {
        appUrl: "https://kestrel.example",
        executionTicket: "signed-ticket",
      },
    };

    const published = await workspacePreviewPublishTool.createHandler(context)({
      port: 5173,
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
