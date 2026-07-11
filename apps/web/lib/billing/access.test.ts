import assert from "node:assert/strict";
import test from "node:test";
import { canManageOrganizationBillingRole } from "./access-shared";

test("organization billing is limited to owner/admin roles", () => {
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

test("personal workspaces never expose organization billing controls", () => {
  assert.equal(
    canManageOrganizationBillingRole({
      isPersonalOrganization: true,
      role: "owner",
    }),
    false
  );
});
