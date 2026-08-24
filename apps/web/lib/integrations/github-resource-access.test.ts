import assert from "node:assert/strict";
import test from "node:test";
import {
  githubCapabilityHasReadyResource,
} from "./github-resource-access";

const readOnlyResource = {
  permissions: { pull: true, push: false },
};

test("GitHub repository tools are visible only with an authorized permission", () => {
  assert.equal(
    githubCapabilityHasReadyResource(
      "repository.read",
      [readOnlyResource],
    ),
    true,
  );
  assert.equal(
    githubCapabilityHasReadyResource(
      "repository.push_agent_branch",
      [readOnlyResource],
    ),
    false,
  );
  assert.equal(
    githubCapabilityHasReadyResource("repository.initialize", []),
    false,
  );
  assert.equal(
    githubCapabilityHasReadyResource("issue.write", []),
    true,
  );
});
