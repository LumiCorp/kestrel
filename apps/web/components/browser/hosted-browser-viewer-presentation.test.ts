import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyHostedBrowserViewerAvailabilityResponse,
  hostedBrowserViewerCleanupUnknownPresentation,
  HOSTED_BROWSER_VIEWER_CLEANUP_UNKNOWN_CODE,
} from "./hosted-browser-viewer-presentation";

test("availability polling keeps warnings on 5xx and clears them on authoritative Session loss", async () => {
  assert.deepEqual(
    await classifyHostedBrowserViewerAvailabilityResponse(
      Response.json({ error: { code: "BROWSER_SERVICE_UNAVAILABLE" } }, { status: 503 }),
    ),
    { kind: "transient" },
  );
  assert.deepEqual(
    await classifyHostedBrowserViewerAvailabilityResponse(
      Response.json({ error: { code: "BROWSER_SESSION_LOST" } }, { status: 404 }),
    ),
    { kind: "unavailable" },
  );
});

test("the first-party viewer preserves cleanup-unknown as an explicit recovery state", () => {
  assert.deepEqual(
    hostedBrowserViewerCleanupUnknownPresentation(
      HOSTED_BROWSER_VIEWER_CLEANUP_UNKNOWN_CODE,
    ),
    {
      title: "Browser cleanup status unknown",
      instruction: "The Browser Session remains blocked. Wait for Kestrel to confirm it closed before reconnecting.",
    },
  );
  assert.equal(
    hostedBrowserViewerCleanupUnknownPresentation("BROWSER_SESSION_LOST"),
    null,
  );
});
