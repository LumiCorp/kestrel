import assert from "node:assert/strict";
import test from "node:test";

import {
  HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES,
  HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES,
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  parseHostedBrowserViewerServerMessage,
  serializeHostedBrowserViewerServerMessage,
} from "./hostedViewerProtocol.js";

test("hosted viewer derives one serialized frame bound from the 20 MiB raw PNG contract", () => {
  assert.equal(HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(
    HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES,
    4 * Math.ceil(HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES / 3) + 8 * 1024,
  );
});

test("hosted viewer server parser accepts exact state and frame identities", () => {
  const expected = {
    threadId: "thread-1",
    projectId: "project-1",
    sessionId: "session-1",
    generation: 1,
    connectionId: "connection-1",
  };
  assert.equal(parseHostedBrowserViewerServerMessage(stateMessage(), expected).type, "state");
  assert.equal(parseHostedBrowserViewerServerMessage(frameMessage(), expected).type, "frame");
});

test("hosted viewer server parser rejects unknown envelopes and identity drift", () => {
  assert.throws(
    () => parseHostedBrowserViewerServerMessage({ ...stateMessage(), extra: true }),
    /BROWSER_SESSION_LOST/u,
  );
  assert.throws(
    () => parseHostedBrowserViewerServerMessage(
      { ...stateMessage(), type: "future_state" },
    ),
    /BROWSER_SESSION_LOST/u,
  );
  assert.throws(
    () => parseHostedBrowserViewerServerMessage(frameMessage(), {
      sessionId: "replacement-session",
      generation: 1,
    }),
    /BROWSER_SESSION_LOST/u,
  );
  assert.throws(
    () => parseHostedBrowserViewerServerMessage(stateMessage(), {
      threadId: "thread-1",
      projectId: "project-1",
      sessionId: "session-1",
      generation: 1,
      connectionId: "replacement-connection",
    }),
    /BROWSER_SESSION_LOST/u,
  );
  assert.throws(
    () => parseHostedBrowserViewerServerMessage(stateMessage(), {
      threadId: "thread-1",
      projectId: "replacement-project",
    }),
    /BROWSER_SESSION_LOST/u,
  );
});

test("hosted viewer server parser accepts exactly 20 MiB raw PNG base64", () => {
  const encodedLength = 4 * Math.ceil(HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES / 3);
  const dataBase64 = `${"A".repeat(encodedLength - 1)}=`;
  assert.equal(parseHostedBrowserViewerServerMessage({
    ...frameMessage(),
    frame: { ...frameMessage().frame, dataBase64 },
  }).type, "frame");
});

test("hosted viewer server parser rejects one raw byte over the PNG maximum", () => {
  const encodedLength = 4 * Math.ceil(HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES / 3);
  assert.throws(
    () => parseHostedBrowserViewerServerMessage({
      ...frameMessage(),
      frame: {
        ...frameMessage().frame,
        dataBase64: "A".repeat(encodedLength),
      },
    }),
    /BROWSER_SESSION_LOST/u,
  );
});

test("hosted viewer serialization admits raw-limit frames and rejects envelope overhead beyond the derived bound", () => {
  const encodedLength = 4 * Math.ceil(HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES / 3);
  const dataBase64 = `${"A".repeat(encodedLength - 1)}=`;
  const exact = serializeHostedBrowserViewerServerMessage({
    ...frameMessage(),
    frame: { ...frameMessage().frame, dataBase64 },
  });
  assert.ok(new TextEncoder().encode(exact).byteLength <=
    HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES);
  assert.throws(
    () => serializeHostedBrowserViewerServerMessage({
      ...frameMessage(),
      frame: {
        ...frameMessage().frame,
        sessionId: "s".repeat(8 * 1024),
        dataBase64,
      },
    }),
    /BROWSER_ARTIFACT_TOO_LARGE/u,
  );
});

test("hosted viewer server parser rejects structurally invalid and noncanonical Base64", () => {
  for (const dataBase64 of ["A", "AB==", "AAB=", "AAAA===", "AAAA\n"]) {
    assert.throws(
      () => parseHostedBrowserViewerServerMessage({
        ...frameMessage(),
        frame: { ...frameMessage().frame, dataBase64 },
      }),
      /BROWSER_SESSION_LOST/u,
      dataBase64,
    );
  }
});

function stateMessage() {
  return {
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "state" as const,
    state: {
      version: "desktop_browser_viewer_state_v1" as const,
      available: true,
      threadId: "thread-1",
      projectId: "project-1",
      sessionId: "session-1",
      generation: 1,
      connectionId: "connection-1",
      sessionState: "human_control",
      takeoverRequested: false,
      inputLeaseId: "lease-1",
      inputLeaseExpiresAt: "2026-08-30T12:01:00.000Z",
      nativeHandoffActive: false,
    },
  };
}

function frameMessage() {
  return {
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "frame" as const,
    frame: {
      version: "desktop_browser_viewer_frame_v1" as const,
      sessionId: "session-1",
      generation: 1,
      sequence: 1,
      capturedAt: "2026-08-30T12:00:00.000Z",
      mediaType: "image/png" as const,
      dataBase64: "iVBORw0KGgo=",
    },
  };
}
