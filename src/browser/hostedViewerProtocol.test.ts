import assert from "node:assert/strict";
import test from "node:test";

import {
  HOSTED_BROWSER_VIEWER_MAX_SERVER_MESSAGE_BYTES,
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  parseHostedBrowserViewerServerMessage,
} from "./hostedViewerProtocol.js";

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
});

test("hosted viewer server parser rejects oversized frame data", () => {
  assert.throws(
    () => parseHostedBrowserViewerServerMessage({
      ...frameMessage(),
      frame: {
        ...frameMessage().frame,
        dataBase64: "A".repeat(HOSTED_BROWSER_VIEWER_MAX_SERVER_MESSAGE_BYTES + 1),
      },
    }),
    /BROWSER_SESSION_LOST/u,
  );
});

function stateMessage() {
  return {
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "state",
    state: {
      version: "desktop_browser_viewer_state_v1",
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
    type: "frame",
    frame: {
      version: "desktop_browser_viewer_frame_v1",
      sessionId: "session-1",
      generation: 1,
      sequence: 1,
      capturedAt: "2026-08-30T12:00:00.000Z",
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgo=",
    },
  };
}
