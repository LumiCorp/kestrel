import assert from "node:assert/strict";
import test from "node:test";

import {
  createRendererThread,
  readDesktopRendererState,
  serializeDesktopRendererState,
} from "../renderer/src/state.js";
import { projectDesktopTerminalMessage } from "../renderer/src/terminalProjection.js";

test("Desktop projects terminal messages after pending users and suppresses duplicate run identities", () => {
  const thread = createRendererThread();
  const state = {
    entries: {},
    activeThreadId: thread.id,
    threads: [thread],
    theme: "system" as const,
  };
  const first = projectDesktopTerminalMessage(state, {
    threadId: thread.id,
    runId: "run-terminal-1",
    turnId: "turn-terminal-1",
    assistantText: "The durable answer.",
    status: "COMPLETED",
    timestamp: "2026-07-31T10:00:01.000Z",
    pendingUser: {
      text: "Finish this task",
      timestamp: "2026-07-31T10:00:00.000Z",
    },
  });
  assert.equal(first.outcome, "projected");
  assert.deepEqual(
    first.state.threads[0]?.transcript.map((line) => [line.role, line.text]),
    [
      ["user", "Finish this task"],
      ["assistant", "The durable answer."],
    ],
  );
  assert.equal(
    first.state.threads[0]?.transcript[1]?.terminal?.runId,
    "run-terminal-1",
  );

  const duplicate = projectDesktopTerminalMessage(first.state, {
    threadId: thread.id,
    runId: "run-terminal-1",
    assistantText: "The durable answer.",
    status: "COMPLETED",
    timestamp: "2026-07-31T10:00:02.000Z",
  });
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(duplicate.state.threads[0]?.transcript.length, 2);

  const hydrated = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "desktop-renderer-vite",
    capturedAt: "2026-07-31T10:00:03.000Z",
    entries: serializeDesktopRendererState(first.state),
  });
  assert.equal(
    hydrated.threads[0]?.transcript[1]?.terminal?.runId,
    "run-terminal-1",
  );
  const recoveredDuplicate = projectDesktopTerminalMessage(hydrated, {
    threadId: thread.id,
    runId: "run-terminal-1",
    assistantText: "The durable answer.",
    status: "COMPLETED",
    timestamp: "2026-07-31T10:00:04.000Z",
  });
  assert.equal(recoveredDuplicate.outcome, "duplicate");
  assert.equal(recoveredDuplicate.state.threads[0]?.transcript.length, 2);
});

test("Desktop restores all twenty draft file references", () => {
  const thread = createRendererThread();
  const attachmentIds = Array.from({ length: 20 }, (_, index) => `file-${index}`);
  const state = {
    entries: {},
    activeThreadId: thread.id,
    threads: [{ ...thread, draftAttachmentIds: attachmentIds }],
    theme: "system" as const,
  };
  const hydrated = readDesktopRendererState({
    version: "desktop-ui-state-v1",
    source: "desktop-renderer-vite",
    capturedAt: "2026-08-21T10:00:00.000Z",
    entries: serializeDesktopRendererState(state),
  });
  assert.deepEqual(hydrated.threads[0]?.draftAttachmentIds, attachmentIds);
});
