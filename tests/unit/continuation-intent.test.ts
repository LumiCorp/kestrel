import assert from "node:assert/strict";

import { parseContinuationIntent } from "../../src/runtime/continuationIntent.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "parseContinuationIntent accepts direct continuation phrases", () => {
  assert.equal(parseContinuationIntent("continue").approved, true);
  assert.equal(parseContinuationIntent("resume").approved, true);
  assert.equal(parseContinuationIntent("go on").approved, true);
  assert.equal(parseContinuationIntent("keep going").approved, true);
});

contractTest("runtime.hermetic", "parseContinuationIntent accepts affirmed continuation phrases and near-miss typos", () => {
  assert.equal(parseContinuationIntent("yes continue").approved, true);
  assert.equal(parseContinuationIntent("okay resume").approved, true);
  assert.equal(parseContinuationIntent("contimie").approved, true);
});

contractTest("runtime.hermetic", "parseContinuationIntent rejects unrelated replies and bare affirmatives", () => {
  assert.equal(parseContinuationIntent("yes").approved, false);
  assert.equal(parseContinuationIntent("sounds good").approved, false);
  assert.equal(parseContinuationIntent("tell me more").approved, false);
});

contractTest("runtime.hermetic", "parseContinuationIntent rejects non-string payloads without throwing", () => {
  assert.equal(parseContinuationIntent({ message: "continue" }).approved, false);
  assert.equal(parseContinuationIntent(["continue"]).approved, false);
});
