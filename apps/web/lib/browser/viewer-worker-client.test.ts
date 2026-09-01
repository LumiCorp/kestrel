import assert from "node:assert/strict";
import test from "node:test";
import { HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES } from "@kestrel-agents/protocol";
import { readBoundedHostedBrowserViewerWorkerResponse } from "./viewer-worker-client";

test("Web admits the derived viewer frame envelope boundary and keeps control responses at 20 MiB", async () => {
  const exact = await readBoundedHostedBrowserViewerWorkerResponse(
    new Response(Buffer.alloc(HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES)),
    true,
  );
  assert.equal(
    exact.byteLength,
    HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES,
  );
  await assert.rejects(readBoundedHostedBrowserViewerWorkerResponse(
    new Response("too large", {
      headers: {
        "content-length": String(
          HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES + 1,
        ),
      },
    }),
    true,
  ), /BROWSER_ENGINE_FAILURE/u);
  await assert.rejects(readBoundedHostedBrowserViewerWorkerResponse(
    new Response("too large", {
      headers: { "content-length": String(20 * 1024 * 1024 + 1) },
    }),
    false,
  ), /BROWSER_ENGINE_FAILURE/u);
});
