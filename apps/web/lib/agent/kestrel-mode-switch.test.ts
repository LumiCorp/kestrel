import assert from "node:assert/strict";
import test from "node:test";

import { readRequestedInteractionMode } from "./kestrel-runtime-core";

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
