import assert from "node:assert/strict";
import test from "node:test";
import {
  intersectAppApprovalModes,
  isProjectApprovalWithinEnvironment,
} from "./policy";

test("Project approval can only match or narrow the Environment ceiling", () => {
  assert.equal(
    isProjectApprovalWithinEnvironment({ environment: "ask", project: "ask" }),
    true
  );
  assert.equal(
    isProjectApprovalWithinEnvironment({ environment: "ask", project: "deny" }),
    true
  );
  assert.equal(
    isProjectApprovalWithinEnvironment({ environment: "ask", project: "auto" }),
    false
  );
});

test("effective approval always chooses the most restrictive policy", () => {
  assert.equal(intersectAppApprovalModes("auto", "ask"), "ask");
  assert.equal(intersectAppApprovalModes("ask", "deny"), "deny");
  assert.equal(intersectAppApprovalModes("deny", "auto"), "deny");
});
