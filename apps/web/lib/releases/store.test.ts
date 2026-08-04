import assert from "node:assert/strict";
import test from "node:test";
import { digestCanonicalJson } from "./digest";

test("release manifest digests are stable across object key ordering", () => {
  assert.equal(
    digestCanonicalJson({ a: 1, b: { c: true, d: ["x", "y"] } }),
    digestCanonicalJson({ b: { d: ["x", "y"], c: true }, a: 1 }),
  );
  assert.notEqual(
    digestCanonicalJson({ values: ["x", "y"] }),
    digestCanonicalJson({ values: ["y", "x"] }),
  );
});
