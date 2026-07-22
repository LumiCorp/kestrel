import assert from "node:assert/strict";
import {
  workspacePreviewCloseTool,
  workspacePreviewListTool,
  workspacePreviewPublishTool,
  workspacePreviewRenewTool,
} from "../../tools/kestrelOne/workspacePreviews.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest(
  "runtime.hermetic",
  "Workspace preview tools call the governed ngrok App lifecycle with the signed execution ticket",
  async () => {
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
        ["https://kestrel.example/api/runtime/apps/ngrok/publish/auto/previews", "POST"],
        ["https://kestrel.example/api/runtime/apps/ngrok/list/auto/previews", "GET"],
        ["https://kestrel.example/api/runtime/apps/ngrok/renew/auto/previews/preview-1", "POST"],
        ["https://kestrel.example/api/runtime/apps/ngrok/close/auto/previews/preview-1", "DELETE"],
      ]
    );
    assert.equal(
      (requests[0]?.init?.headers as Record<string, string>).authorization,
      "Bearer signed-ticket"
    );
  }
);
