import assert from "node:assert/strict";

import type { RunnerEvent } from "../../packages/protocol/src/index.js";
import {
  classifyDurableTerminalEvent,
  derivePromptSmokeOutcome,
  observeDurableSessionTerminal,
} from "../../scripts/lib/cli-prompt-smoke-observer.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "progress events never classify as durable completion", () => {
  const event = {
    id: "event-progress",
    type: "job.progress",
    ts: "2026-07-16T13:35:46.000Z",
    sessionId: "session-1",
    payload: {
      sessionId: "session-1",
      threadId: "thread-1",
      runId: "run-1",
      stage: "runtime_progress",
      message: "<< AGENT · Checking the workspace",
    },
  } satisfies RunnerEvent;

  assert.equal(classifyDurableTerminalEvent(event), undefined);
});

contractTest("runtime.hermetic", "canonical job completion, waiting, and failure remain distinct", () => {
  const completed = classifyDurableTerminalEvent(terminalEvent("job.completed", "COMPLETED"));
  const waiting = classifyDurableTerminalEvent(terminalEvent("job.completed", "WAITING"));
  const failed = classifyDurableTerminalEvent(terminalEvent("job.failed", "FAILED"));

  assert.equal(completed?.status, "completed");
  assert.equal(waiting?.status, "waiting");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.reasonCode, "DECISION_SCHEMA_FAILED");
});

contractTest("runtime.hermetic", "canonical TUI run completion is normalized by the same observer contract", () => {
  const completed = classifyDurableTerminalEvent(runTerminalEvent("run.completed", "COMPLETED"));
  const failed = classifyDurableTerminalEvent(runTerminalEvent("run.failed", "FAILED"));

  assert.equal(completed?.status, "completed");
  assert.equal(completed?.eventType, "run.completed");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.eventType, "run.failed");
  assert.equal(failed?.reasonCode, "DECISION_SCHEMA_FAILED");
});

contractTest("runtime.hermetic", "durable observer reconnects and follows the same session to terminal", async () => {
  let connectionCount = 0;
  const terminal = terminalEvent("job.completed", "COMPLETED");
  const observed = await observeDurableSessionTerminal({
    sessionId: "session-1",
    timeoutMs: 1000,
    openClient: async () => {
      connectionCount += 1;
      return fakeClient(connectionCount === 1 ? [] : [terminal]);
    },
    delay: async () => {},
  });

  assert.equal(connectionCount, 2);
  assert.equal(observed.status, "completed");
  assert.equal(observed.sessionId, "session-1");
  assert.equal(observed.runId, "run-1");
  assert.equal(observed.reconnectCount, 1);
});

contractTest("runtime.hermetic", "artifact success cannot override a failed or missing durable execution outcome", () => {
  assert.deepEqual(derivePromptSmokeOutcome({
    terminalStatus: "failed",
    assertionsConfigured: true,
    assertionsPassed: true,
  }), {
    runtimeStatus: "failed",
    artifactStatus: "passed",
    status: "failed",
  });
  assert.deepEqual(derivePromptSmokeOutcome({
    assertionsConfigured: true,
  }), {
    runtimeStatus: "failed",
    artifactStatus: "not_checked",
    status: "failed",
  });
});

function fakeClient(events: RunnerEvent[]) {
  return {
    subscribe() {
      return {
        result: Promise.resolve(undefined),
        async cancel() {},
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            yield event;
          }
        },
      };
    },
    async close() {},
  };
}

function terminalEvent(
  type: "job.completed" | "job.failed",
  status: "COMPLETED" | "WAITING" | "FAILED",
): RunnerEvent {
  const output = {
    version: "job_run_result_v1" as const,
    sessionId: "session-1",
    threadId: "thread-1",
    runId: "run-1",
    status,
    replay: replay(),
    result: {
      output: {
        status,
        sessionId: "session-1",
        runId: "run-1",
        errors: [],
      },
      assistantText: status === "COMPLETED" ? "Done." : null,
    },
  };
  if (type === "job.failed") {
    return {
      id: "event-failed",
      type,
      ts: "2026-07-16T13:37:44.000Z",
      sessionId: "session-1",
      runId: "run-1",
      payload: {
        output,
        replay: replay(),
        error: { code: "DECISION_SCHEMA_FAILED", message: "Invalid model action." },
      },
    } as RunnerEvent;
  }
  return {
    id: "event-completed",
    type,
    ts: "2026-07-16T13:37:44.000Z",
    sessionId: "session-1",
    runId: "run-1",
    payload: { output, replay: replay() },
  } as RunnerEvent;
}

function runTerminalEvent(
  type: "run.completed" | "run.failed",
  status: "COMPLETED" | "FAILED",
): RunnerEvent {
  const result = {
    output: {
      status,
      sessionId: "session-1",
      runId: "run-1",
      errors: [],
      threadId: "thread-1",
    },
    assistantText: status === "COMPLETED" ? "Done." : null,
  };
  if (type === "run.failed") {
    return {
      id: "run-failed",
      type,
      ts: "2026-07-16T13:37:44.000Z",
      sessionId: "session-1",
      runId: "run-1",
      payload: {
        result,
        error: { code: "DECISION_SCHEMA_FAILED", message: "Invalid model action." },
      },
    } as RunnerEvent;
  }
  return {
    id: "run-completed",
    type,
    ts: "2026-07-16T13:37:44.000Z",
    sessionId: "session-1",
    runId: "run-1",
    payload: { result },
  } as RunnerEvent;
}

function replay() {
  return {
    version: "job_replay_pointer_v1" as const,
    sessionId: "session-1",
    threadId: "thread-1",
    runId: "run-1",
    replayQuery: {
      sessionId: "session-1",
      threadId: "thread-1",
      runId: "run-1",
    },
    commands: {
      replay: "kestrel replay",
      doctor: "kestrel doctor",
      bundle: "kestrel bundle",
    },
  };
}
