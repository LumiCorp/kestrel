import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMobileProjectCallback,
  resolveMobileProjectReturn,
} from "./mobile-return";

test("accepts only the exact Kestrel One mobile Project return", () => {
  assert.equal(
    resolveMobileProjectReturn({
      source: "mobile",
      returnTo: "kestrelone://new-thread",
    }),
    "kestrelone://new-thread"
  );
  assert.equal(
    resolveMobileProjectReturn({
      source: "mobile",
      returnTo: "https://attacker.example/collect",
    }),
    null
  );
  assert.equal(
    resolveMobileProjectReturn({
      source: "web",
      returnTo: "kestrelone://new-thread",
    }),
    null
  );
});

test("returns the created Project id through the allowlisted callback", () => {
  assert.equal(
    buildMobileProjectCallback("kestrelone://new-thread", "project 1"),
    "kestrelone://new-thread?projectId=project+1"
  );
  assert.throws(
    () => buildMobileProjectCallback("https://attacker.example", "project-1"),
    /Unsupported mobile Project return URL/u
  );
});
