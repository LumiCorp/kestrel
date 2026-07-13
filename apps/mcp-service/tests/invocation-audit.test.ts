import assert from "node:assert/strict";
import test from "node:test";
import { digestJson } from "../src/invocation-audit.js";

test("MCP invocation evidence digests are deterministic and payload opaque", () => {
  const secret = "upstream-secret-value";
  const left = digestJson({ b: 2, a: { secret, value: 1 } });
  const right = digestJson({ a: { value: 1, secret }, b: 2 });
  assert.equal(left, right);
  assert.match(left, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(left.includes(secret), false);
});
