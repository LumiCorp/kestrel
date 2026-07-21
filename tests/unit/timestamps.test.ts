import assert from "node:assert/strict";

import { normalizeTimestampString } from "../../src/runtime/timestamps.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "normalizeTimestampString rewrites legacy GMT offset timestamps to ISO", () => {
  assert.equal(
    normalizeTimestampString("2026-03-16T17:32:09 GMT-0400"),
    "2026-03-16T21:32:09.000Z",
  );
});

contractTest("runtime.hermetic", "normalizeTimestampString preserves bare timezone labels", () => {
  assert.equal(normalizeTimestampString("GMT-0400"), "GMT-0400");
});

contractTest("runtime.hermetic", "normalizeTimestampString accepts Date values from database drivers", () => {
  assert.equal(
    normalizeTimestampString(new Date("2026-03-16T21:32:09.000Z")),
    "2026-03-16T21:32:09.000Z",
  );
});

contractTest("runtime.hermetic", "normalizeTimestampString rejects malformed boundary values with a typed error", () => {
  assert.throws(
    () => normalizeTimestampString({ value: "2026-03-16T21:32:09.000Z" }),
    /Invalid timestamp value; expected string or Date, received object/u,
  );
});
