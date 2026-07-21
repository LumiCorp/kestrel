import assert from "node:assert/strict";
import {
  intersectApprovalModes,
  requiresExplicitApproval,
} from "./github-policy-contract";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "GitHub policy intersection can only narrow automatic access", () => {
  assert.equal(intersectApprovalModes(["auto", "auto"]), "auto");
  assert.equal(intersectApprovalModes(["auto", "ask"]), "ask");
  assert.equal(intersectApprovalModes(["ask", "deny"]), "deny");
});

contractTest("web.hermetic", "GitHub external mutations always require explicit approval", () => {
  assert.equal(requiresExplicitApproval("repository.read"), false);
  assert.equal(requiresExplicitApproval("repository.push_agent_branch"), false);
  for (const capability of [
    "issue.write",
    "pull_request.write",
    "merge.write",
    "release.write",
    "workflow.dispatch",
  ] as const) {
    assert.equal(requiresExplicitApproval(capability), true);
  }
});
