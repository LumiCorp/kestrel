import assert from "node:assert/strict";
import { canManageOrganizationBillingRole } from "./access-shared";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "organization billing is limited to owner/admin roles", () => {
  assert.equal(
    canManageOrganizationBillingRole({
      isPersonalOrganization: false,
      role: "owner",
    }),
    true
  );
  assert.equal(
    canManageOrganizationBillingRole({
      isPersonalOrganization: false,
      role: "admin",
    }),
    true
  );
  assert.equal(
    canManageOrganizationBillingRole({
      isPersonalOrganization: false,
      role: "member",
    }),
    false
  );
});

contractTest("web.hermetic", "personal workspaces never expose organization billing controls", () => {
  assert.equal(
    canManageOrganizationBillingRole({
      isPersonalOrganization: true,
      role: "owner",
    }),
    false
  );
});
