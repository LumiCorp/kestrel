import assert from "node:assert/strict";
import { mobileActivity } from "./activity";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "mobile activity projects canonical runtime event discriminants", () => {
  assert.deepEqual(
    mobileActivity({ kind: "runtime_event", eventType: "run.tool.started" }),
    { stage: "using_capability", message: "Using a capability" }
  );
  assert.deepEqual(
    mobileActivity({
      kind: "runtime_event",
      eventType: "run.agent_progress",
    }),
    { stage: "working", message: "Working" }
  );
  assert.deepEqual(
    mobileActivity({
      kind: "runtime_event",
      eventType: "run.progress",
      code: "TOOL_CALL_STARTED",
    }),
    { stage: "using_capability", message: "Using a capability" }
  );
  assert.equal(
    mobileActivity({ kind: "runtime_event", eventType: "context.guessed" }),
    null
  );
});

contractTest("web.hermetic", "mobile activity projects canonical progress codes without reading prose", () => {
  assert.deepEqual(
    mobileActivity({ kind: "progress", code: "TOOL_CALL_STARTED" }),
    { stage: "using_capability", message: "Using a capability" }
  );
  assert.deepEqual(
    mobileActivity({ kind: "progress", code: "RUN_COMPLETED" }),
    { stage: "finalizing", message: "Finishing the answer" }
  );
  assert.deepEqual(mobileActivity({ kind: "progress", code: "UNKNOWN" }), {
    stage: "working",
    message: "Working",
  });
});

contractTest("web.hermetic", "mobile activity preserves explicit agent progress narration", () => {
  assert.deepEqual(
    mobileActivity({
      kind: "agent_progress",
      text: "  I found the source and am checking it now.  ",
    }),
    {
      stage: "working",
      message: "I found the source and am checking it now.",
    }
  );
});
