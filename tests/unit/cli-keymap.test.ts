import test from "node:test";
import assert from "node:assert/strict";

import { cycleRegion, regionForDigit } from "../../cli/ink/keymap.js";

test("regionForDigit maps ctrl-digit focus targets", () => {
  assert.equal(regionForDigit("1"), "sessions");
  assert.equal(regionForDigit("3"), "composer");
  assert.equal(regionForDigit("6"), undefined);
  assert.equal(regionForDigit("0"), undefined);
});

test("cycleRegion wraps in both directions", () => {
  assert.equal(cycleRegion("sessions", false), "chat_list");
  assert.equal(cycleRegion("details", false), "sessions");
  assert.equal(cycleRegion("sessions", true), "details");
  assert.equal(cycleRegion("logs", true), "composer");
});
