import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import {
  LocalCoreApiError,
  LocalCoreClient,
  startLocalCoreApiServer,
} from "../../src/localCore/index.js";
import { ensureLocalCoreStore } from "../../src/localCore/store.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "Local Core owns replay, doctor, and bundle reads from its canonical runtime store", async () => {
  const home = await mkdtemp(path.join("/tmp", "kcev-"));
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: home },
    platform: "darwin",
    coreVersion: "0.6.0",
    idleTimeoutMs: 0,
  });
  try {
    const handle = await ensureLocalCoreStore({ homePath: home });
    await handle.store.ensureSession("session-core-evidence", "react.exec.inspect");
    await handle.store.startRun("run-core-evidence", {
      id: "event-core-evidence-start",
      type: "task.start",
      sessionId: "session-core-evidence",
      payload: { runId: "run-core-evidence" },
      timestamp: "2026-07-13T12:00:00.000Z",
    });
    await handle.store.appendRunEvent({
      runId: "run-core-evidence",
      sessionId: "session-core-evidence",
      type: "run.started",
      level: "INFO",
      timestamp: "2026-07-13T12:00:00.000Z",
    });
    await handle.store.appendRunEvent({
      runId: "run-core-evidence",
      sessionId: "session-core-evidence",
      stepIndex: 0,
      type: "step.selected",
      level: "INFO",
      timestamp: "2026-07-13T12:00:01.000Z",
      metadata: { step: "react.exec.inspect" },
    });
    await handle.store.appendRunEvent({
      runId: "run-core-evidence",
      sessionId: "session-core-evidence",
      stepIndex: 0,
      type: "terminal.normalized",
      level: "INFO",
      timestamp: "2026-07-13T12:00:02.000Z",
      metadata: {
        status: "COMPLETED",
        finalStep: "react.exec.inspect",
        reasonCode: "goal_satisfied",
      },
    });
    await handle.store.appendRunEvent({
      runId: "run-core-evidence",
      sessionId: "session-core-evidence",
      type: "run.completed",
      level: "INFO",
      timestamp: "2026-07-13T12:00:03.000Z",
      metadata: { status: "COMPLETED" },
    });
    await handle.store.completeRun("run-core-evidence", "COMPLETED");

    const client = new LocalCoreClient({
      socketPath: server.socketPath,
      token: server.token,
    });
    const replay = await client.runtimeReplay({ runId: " run-core-evidence " });
    assert.equal(replay.query.runId, "run-core-evidence");
    assert.equal(replay.summary.eventCount, 4);
    assert.equal(replay.summary.terminalStatus, "COMPLETED");
    assert.equal(replay.events[1]?.type, "step.selected");

    const doctor = await client.runtimeDoctor({ runId: "run-core-evidence" });
    assert.equal(doctor.focus.runId, "run-core-evidence");
    assert.equal(doctor.status, "COMPLETED");
    assert.equal(doctor.finalStep, "react.exec.inspect");
    assert.equal(doctor.terminalReasonCode, "goal_satisfied");

    const bundle = await client.runtimeBundle({ runId: "run-core-evidence" });
    assert.equal(bundle.version, "runtime_replay_bundle_v1");
    assert.equal(bundle.focus.runId, "run-core-evidence");
    assert.equal(bundle.replay.summary.eventCount, 4);
    assert.equal(bundle.doctor.status, "COMPLETED");

    await assert.rejects(
      () => client.runtimeReplay({}),
      (error) => {
        if (error instanceof LocalCoreApiError === false || error.statusCode !== 400) {
          return false;
        }
        const body = error.body as { error?: { code?: string | undefined } | undefined };
        return body.error?.code === "LOCAL_CORE_RUNTIME_QUERY_INVALID";
      },
    );
    await assert.rejects(
      () => client.runtimeReplay({
        runId: "run-core-evidence",
        fromTimestamp: "not-a-timestamp",
      }),
      (error) => isInvalidRuntimeQuery(error),
    );
    await assert.rejects(
      () => client.runtimeReplay({
        runId: "run-core-evidence",
        fromTimestamp: "2026-07-14T00:00:00.000Z",
        toTimestamp: "2026-07-13T00:00:00.000Z",
      }),
      (error) => isInvalidRuntimeQuery(error),
    );
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

function isInvalidRuntimeQuery(error: unknown): boolean {
  if (error instanceof LocalCoreApiError === false || error.statusCode !== 400) {
    return false;
  }
  const body = error.body as { error?: { code?: string | undefined } | undefined };
  return body.error?.code === "LOCAL_CORE_RUNTIME_QUERY_INVALID";
}
