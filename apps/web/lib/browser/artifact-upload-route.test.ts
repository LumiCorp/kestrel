import assert from "node:assert/strict";
import test from "node:test";

import { handleHostedBrowserArtifactUpload } from "./artifact-upload-route";

const fileId = `file-browser-${"a".repeat(64)}`;

test("Browser artifact upload route requires a bearer capability without reflecting it", async () => {
  let called = false;
  const response = await handleHostedBrowserArtifactUpload({
    request: new Request(`https://kestrel.test/api/runtime/browser-artifacts/${fileId}`, {
      method: "PUT",
      body: new Uint8Array([1]),
      headers: { "content-length": "1", authorization: "Bearer secret-token" },
    }),
    fileId,
    authority: { async upload() { called = true; throw new Error("unused"); } },
  });
  assert.equal(response.status, 401);
  assert.equal(called, false);
  assert.deepEqual(await response.json(), {
    error: { code: "BROWSER_ARTIFACT_UPLOAD_DENIED" },
  });
});

test("Browser artifact upload route returns metadata only", async () => {
  const token = `${"a".repeat(20)}.${"b".repeat(20)}`;
  const response = await handleHostedBrowserArtifactUpload({
    request: new Request(`https://kestrel.test/api/runtime/browser-artifacts/${fileId}`, {
      method: "PUT",
      body: new Uint8Array([1]),
      headers: { "content-length": "1", authorization: `Bearer ${token}` },
    }),
    fileId,
    authority: {
      async upload(input) {
        assert.equal(input.token, token);
        return {
          id: fileId,
          organizationId: "org-1",
          uploaderUserId: "user-1",
          filename: "screenshot.png",
          declaredMediaType: "image/png",
          detectedMediaType: "image/png",
          sizeBytes: 1,
          sha256: "c".repeat(64),
          lifecycleState: "ready",
        };
      },
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    artifactId: fileId,
    state: "ready",
    mediaType: "image/png",
    bytes: 1,
    sha256: "c".repeat(64),
  });
  assert.doesNotMatch(JSON.stringify(body), /capability|Bearer|aaaa\.bbbb/u);
});
