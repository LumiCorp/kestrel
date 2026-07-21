import assert from "node:assert/strict";
import { readRequestedInteractionMode } from "./kestrel-runtime-core";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

contractTest("web.hermetic", "reads a requested interaction mode from a finalized agent payload", () => {
  assert.equal(
    readRequestedInteractionMode({
      finalized: true,
      payload: {
        data: {
          modeSwitch: { mode: "build" },
        },
      },
    }),
    "build"
  );
});

contractTest("web.hermetic", "rejects unsupported or unstructured mode switch payloads", () => {
  assert.equal(
    readRequestedInteractionMode({
      payload: { data: { modeSwitch: { mode: "autonomous" } } },
    }),
    null
  );
  assert.equal(readRequestedInteractionMode(null), null);
});
