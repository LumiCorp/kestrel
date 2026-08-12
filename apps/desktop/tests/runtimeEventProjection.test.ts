import assert from "node:assert/strict";
import test from "node:test";

import { projectDesktopRunnerEvent } from "../src/runtimeEventProjection.js";

test("Desktop Runner projection removes private Runtime metadata recursively", () => {
  const projected = projectDesktopRunnerEvent({
    id: "event-1",
    type: "run.log",
    ts: "2026-08-12T00:00:00.000Z",
    sessionId: "thread-1",
    runId: "run-1",
    payload: {
      entry: {
        interaction: {
          requestId: "request-1",
          privateRuntimeMetadata: {
            nativeRequestId: "native-secret",
          },
        },
      },
    },
  } as never);

  assert.equal(
    JSON.stringify(projected).includes("privateRuntimeMetadata"),
    false,
  );
  assert.equal(JSON.stringify(projected).includes("native-secret"), false);
});
