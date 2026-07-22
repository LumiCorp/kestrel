import assert from "node:assert/strict";

import type { DesktopRunnerEvent } from "../src/contracts.js";
import { cancelDesktopRun } from "../src/runCancellation.js";
import { withoutDesktopActiveRun } from "../renderer/src/cancellationState.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

const context = {
  actor: { actorId: "desktop-test", actorType: "operator" as const },
};

contractTest("desktop.hermetic", "Desktop cancellation returns the durable cancelled event", async () => {
  const event = {
    id: "event-cancelled",
    type: "run.cancelled",
    ts: "2026-07-22T14:00:00.000Z",
    sessionId: "session-1",
    runId: "run-1",
    payload: {},
  } as DesktopRunnerEvent;
  const result = await cancelDesktopRun({
    adapter: { async sendControl() { return event; } },
    request: { sessionId: "session-1", runId: "run-1" },
    context,
  });
  assert.deepEqual(result, { status: "cancelled", event });
});

contractTest("desktop.hermetic", "Desktop cancellation reconciles an already-finished run", async () => {
  const error = Object.assign(new Error("No matching cancellable run was found."), {
    code: "RUN_CANCEL_NOT_FOUND",
  });
  const result = await cancelDesktopRun({
    adapter: { async sendControl() { throw error; } },
    request: { sessionId: "session-1", runId: "run-1" },
    context,
  });
  assert.deepEqual(result, { status: "already_stopped" });
});

contractTest("desktop.hermetic", "Desktop cancellation preserves a newer active run target", async () => {
  const error = Object.assign(new Error("No matching cancellable run was found."), {
    code: "RUN_CANCEL_NOT_FOUND",
    details: {
      runId: "run-stale",
      activeRunId: "run-current",
      activeCommandId: "command-current",
    },
  });
  const result = await cancelDesktopRun({
    adapter: { async sendControl() { throw error; } },
    request: { sessionId: "session-1", runId: "run-stale" },
    context,
  });
  assert.deepEqual(result, {
    status: "run_changed",
    activeRunId: "run-current",
    activeCommandId: "command-current",
  });
});

contractTest("desktop.hermetic", "Desktop clears cached active-run authority before refresh", () => {
  const view = {
    thread: { threadId: "thread-1", sessionId: "session-1" },
    childThreads: [],
    activeRun: { runId: "run-stale", status: "RUNNING" as const },
    followUpQueue: { state: "ready" as const, items: [] },
    inboxItems: [],
  } as Parameters<typeof withoutDesktopActiveRun>[0];
  const reconciled = withoutDesktopActiveRun(view);
  assert.equal(reconciled.activeRun, undefined);
  assert.equal("activeRun" in reconciled, false);
});

contractTest("desktop.hermetic", "Desktop cancellation preserves other runtime failures", async () => {
  const error = Object.assign(new Error("Runner unavailable."), {
    code: "RUNNER_RUNTIME_ERROR",
  });
  await assert.rejects(
    cancelDesktopRun({
      adapter: { async sendControl() { throw error; } },
      request: { sessionId: "session-1" },
      context,
    }),
    (cause: unknown) => cause === error,
  );
});
