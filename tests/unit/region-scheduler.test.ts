import assert from "node:assert/strict";

import { RegionScheduler } from "../../src/engine/RegionScheduler.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "RegionScheduler surfaces structured failure when authoritative current step is missing", async () => {
  const scheduler = new RegionScheduler({
    store: {} as never,
  });

  await assert.rejects(
    () =>
      scheduler.beforeStep({
        event: {
          id: "evt-1",
          type: "user.message",
          sessionId: "session-1",
          payload: {},
        },
        session: {
          sessionId: "session-1",
          currentStepAgent: undefined,
          state: {},
          version: 0,
          updatedAt: new Date().toISOString(),
        },
        currentStep: undefined,
        stepIndex: 1,
        laneCursor: undefined,
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "RUN_REGION_STEP_MISSING");
      assert.equal(
        (error as { details?: { contractPath?: string } }).details?.contractPath,
        "session.currentStepAgent",
      );
      return true;
    },
  );
});
