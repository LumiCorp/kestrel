import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("runtime approval policy no longer carries the Environment Apps detour", () => {
  const source = fs.readFileSync(
    new URL("./runtime-approval-policy.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /alwaysApprovalAction/u);
  assert.doesNotMatch(source, /environmentAppsHref/u);
  assert.doesNotMatch(source, /resolveAlwaysApprovalAction/u);
});
