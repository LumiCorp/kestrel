import assert from "node:assert/strict";
import test from "node:test";
import {
  hostedBrowserViewerCleanupUnknownPresentation,
  HOSTED_BROWSER_VIEWER_CLEANUP_UNKNOWN_CODE,
} from "./hosted-browser-viewer-presentation";

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
