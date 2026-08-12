import assert from "node:assert/strict";
import test from "node:test";

import { parseRetryAfterMs } from "../../src/io/RetryAfter.js";

test("Retry-After parses delta-seconds and future HTTP dates", () => {
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  assert.equal(parseRetryAfterMs("2.5", now), 2500);
  assert.equal(parseRetryAfterMs("Tue, 11 Aug 2026 12:00:05 GMT", now), 5000);
});

test("Retry-After rejects invalid, zero, and expired values", () => {
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  assert.equal(parseRetryAfterMs("not-a-delay", now), undefined);
  assert.equal(parseRetryAfterMs("0", now), undefined);
  assert.equal(parseRetryAfterMs("Tue, 11 Aug 2026 11:59:59 GMT", now), undefined);
});
