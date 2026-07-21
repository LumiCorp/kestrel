import assert from "node:assert/strict";
import { projectRoleAllows } from "./access";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Project role ordering preserves collaboration and administration boundaries", () => {
  assert.equal(projectRoleAllows("member", "member"), true);
  assert.equal(projectRoleAllows("member", "editor"), false);
  assert.equal(projectRoleAllows("editor", "member"), true);
  assert.equal(projectRoleAllows("editor", "owner"), false);
  assert.equal(projectRoleAllows("owner", "editor"), true);
  assert.equal(projectRoleAllows("owner", "owner"), true);
});
