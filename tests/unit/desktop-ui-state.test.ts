import assert from "node:assert/strict";

import {
  DESKTOP_BRIDGE_CAPABILITIES,
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_UI_STATE_SOURCE,
  DESKTOP_UI_STATE_VERSION,
  parseDesktopLegacyUiStateEntries,
  parseDesktopOperatorControlRequest,
  parseDesktopRunTurnRequest,
  parseDesktopUiStateV1,
} from "../../src/desktopShell/contracts.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "Desktop bridge v6 exposes workspace, attachment, and operator-control contracts", () => {
  assert.equal(DESKTOP_BRIDGE_VERSION, "6");
  assert.equal(DESKTOP_BRIDGE_CAPABILITIES.includes("attachments"), true);
  assert.equal(DESKTOP_BRIDGE_CAPABILITIES.includes("operator_control"), true);
  assert.deepEqual(parseDesktopOperatorControlRequest({
    action: "reply",
    threadId: "thread-1",
    requestId: "request-1",
    message: "Use these files",
    attachmentIds: ["attachment-1"],
  }), {
    action: "reply",
    threadId: "thread-1",
    requestId: "request-1",
    message: "Use these files",
    attachmentIds: ["attachment-1"],
  });
  assert.equal(parseDesktopOperatorControlRequest({ action: "continue_waiting", threadId: "thread-1" }).action, "continue_waiting");
});

contractTest("runtime.hermetic", "Desktop UI state accepts only the versioned legacy storage contract", () => {
  const state = parseDesktopUiStateV1({
    version: DESKTOP_UI_STATE_VERSION,
    source: DESKTOP_UI_STATE_SOURCE,
    sourceAppVersion: "0.5.1",
    capturedAt: "2026-07-09T12:00:00.000Z",
    entries: {
      "kchat:web:theme-mode": "dark",
      "kchat:web:active-thread:v1": "thread-1",
    },
  });

  assert.deepEqual(state.entries, {
    "kchat:web:theme-mode": "dark",
    "kchat:web:active-thread:v1": "thread-1",
  });
  assert.equal(state.sourceAppVersion, "0.5.1");
});

contractTest("runtime.hermetic", "Desktop UI state rejects unknown storage keys and non-string values", () => {
  assert.throws(
    () => parseDesktopLegacyUiStateEntries({ "provider-api-key": "secret" }),
    /unsupported key/u,
  );
  assert.throws(
    () => parseDesktopLegacyUiStateEntries({ "kchat:web:theme-mode": { mode: "dark" } }),
    /must be a string/u,
  );
});

contractTest("runtime.hermetic", "Desktop run requests admit only tagged runtime system prompts", () => {
  const timestamp = "2026-07-09T12:00:00.000Z";
  const executionSelection = {
    modelConfiguration: { id: "desktop-default", revision: 1 },
    apps: [],
  };
  const request = parseDesktopRunTurnRequest({
    sessionId: "session-1",
    message: "Continue",
    eventType: "user.reply",
    executionSelection,
    history: [
      { role: "user", text: "Start", timestamp },
      {
        role: "system",
        text: "Which workspace?",
        timestamp,
        data: { kind: "runtime.waiting_prompt", runId: "  run-waiting  ", ignored: true },
      },
    ],
  });

  assert.deepEqual(request.history, [
    { role: "user", text: "Start", timestamp },
    {
      role: "system",
      text: "Which workspace?",
      timestamp,
      data: { kind: "runtime.waiting_prompt", runId: "run-waiting" },
    },
  ]);
  assert.equal(
    parseDesktopRunTurnRequest({
      sessionId: "session-1",
      message: "Continue",
      eventType: "user.reply",
      projectPath: "  /workspace/project-a  ",
      workspaceMode: "managed",
      executionSelection,
    }).projectPath,
    "/workspace/project-a",
  );
  assert.equal(
    parseDesktopRunTurnRequest({
      sessionId: "session-1",
      message: "Continue",
      eventType: "user.reply",
      workspaceMode: "local",
      executionSelection,
    }).workspaceMode,
    "local",
  );
  assert.equal(
    parseDesktopRunTurnRequest({
      sessionId: "session-1",
      message: "Continue",
      eventType: "user.reply",
      workspaceBaseRef: "release/v2",
      executionSelection,
    }).workspaceBaseRef,
    "release/v2",
  );
  assert.deepEqual(
    parseDesktopRunTurnRequest({
      sessionId: "session-1",
      message: "Continue",
      eventType: "user.reply",
      executionSelection,
      workspaceSetup: {
        approvedIgnoredFiles: [".env"],
        steps: [{ id: "install", label: "Install", executable: "pnpm", args: ["install"] }],
      },
    }).workspaceSetup,
    {
      approvedIgnoredFiles: [".env"],
      steps: [{ id: "install", label: "Install", executable: "pnpm", args: ["install"] }],
    },
  );
  const attachment = {
    attachmentId: "attachment-1",
    threadId: "session-1",
    filename: "app.ts",
    mimeType: "text/plain",
    sizeBytes: 5,
    sha256: "a".repeat(64),
    kind: "text",
    text: "hello",
  };
  assert.deepEqual(
    parseDesktopRunTurnRequest({
      sessionId: "session-1",
      message: "Review this file",
      eventType: "user.message",
      executionSelection,
      attachments: [attachment],
      history: [{ role: "user", text: "Earlier file", timestamp, attachments: [attachment] }],
    }).attachments,
    [attachment],
  );
  assert.throws(
    () => parseDesktopRunTurnRequest({
      sessionId: "session-2",
      message: "Review this file",
      eventType: "user.message",
      executionSelection,
      attachments: [attachment],
    }),
    /attachments must belong to the active session/u,
  );
  assert.throws(
    () => parseDesktopRunTurnRequest({
      sessionId: "session-1",
      message: "Continue",
      eventType: "user.reply",
      executionSelection,
      workspaceMode: "shared",
    }),
    /workspaceMode is invalid/u,
  );
  assert.throws(
    () => parseDesktopRunTurnRequest({
      sessionId: "session-1",
      message: "Continue",
      eventType: "user.reply",
      projectPath: 42,
      executionSelection,
    }),
    /projectPath.*must be a non-empty string/u,
  );
  assert.throws(
    () => parseDesktopRunTurnRequest({
      sessionId: "session-1",
      message: "Continue",
      eventType: "user.reply",
      executionSelection,
      history: [{ role: "system", text: "Local status", timestamp }],
    }),
    /must be tagged as runtime\.waiting_prompt/u,
  );
});
