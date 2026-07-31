import test from "node:test";
import assert from "node:assert/strict";

import { shouldPersistProgressUpdate } from "../../src/engine/ExecutionEngine.js";
import type { ProgressUpdateV1 } from "../../src/index.js";

const progress = (
  code: ProgressUpdateV1["code"],
  persist = true,
): ProgressUpdateV1 => ({
  version: "v1",
  runId: "run-progress",
  sessionId: "session-progress",
  ts: "2026-07-24T12:00:00.000Z",
  seq: 1,
  kind: "stage",
  phase: "chat",
  code,
  message: code,
  persist,
});

test(
  "compact progress persistence retains provider retry history",
  () => {
    assert.equal(
      shouldPersistProgressUpdate(
        progress("MODEL_ATTEMPT_RETRYING"),
        "compact",
      ),
      true,
    );
    assert.equal(
      shouldPersistProgressUpdate(progress("MODEL_ATTEMPT_STARTED", false), "compact"),
      false,
    );
    assert.equal(
      shouldPersistProgressUpdate(progress("RUN_STILL_ACTIVE", false), "compact"),
      false,
    );
  },
);
