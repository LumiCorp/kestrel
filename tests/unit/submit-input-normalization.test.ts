import assert from "node:assert/strict";

import { normalizeSubmittedLine } from "../../cli/app/submitInput.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "normalizeSubmittedLine trims trailing CR/LF without changing inner content", () => {
  assert.equal(normalizeSubmittedLine("hello"), "hello");
  assert.equal(normalizeSubmittedLine("hello\r"), "hello");
  assert.equal(normalizeSubmittedLine("hello\n"), "hello");
  assert.equal(normalizeSubmittedLine("hello\r\n"), "hello");
  assert.equal(normalizeSubmittedLine("hello\n\n"), "hello");
  assert.equal(normalizeSubmittedLine("line 1\nline 2\n"), "line 1\nline 2");
  assert.equal(normalizeSubmittedLine("/status\r"), "/status");
});
