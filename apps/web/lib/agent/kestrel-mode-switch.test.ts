import test from "node:test";
import assert from "node:assert/strict";
import {
  readInteractionModeSwitch,
  readRequestedInteractionMode,
} from "./kestrel-runtime-core";

test("reads a requested interaction mode from a finalized agent payload", () => {
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

test("rejects unsupported or unstructured mode switch payloads", () => {
  assert.equal(
    readRequestedInteractionMode({
      payload: { data: { modeSwitch: { mode: "autonomous" } } },
    }),
    null
  );
  assert.equal(readRequestedInteractionMode(null), null);
});

test("reads an applied mode switch from a waiting interaction", () => {
  assert.equal(
    readInteractionModeSwitch({ modeSwitch: { mode: "plan" } }),
    "plan"
  );
  assert.equal(readInteractionModeSwitch({ modeSwitch: { mode: "auto" } }), null);
});
