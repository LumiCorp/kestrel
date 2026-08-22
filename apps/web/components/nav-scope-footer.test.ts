import assert from "node:assert/strict";
import test from "node:test";
import { getSidebarScopeItems } from "./nav-scope-footer";

function labels(access: {
  canManageActiveOrganization: boolean;
  isPlatformAdmin: boolean;
}) {
  return getSidebarScopeItems(access).map((item) => item.label);
}

test("scope footer preserves authority order for every permission combination", () => {
  assert.deepEqual(
    labels({
      canManageActiveOrganization: false,
      isPlatformAdmin: false,
    }),
    ["Settings"],
  );
  assert.deepEqual(
    labels({ canManageActiveOrganization: true, isPlatformAdmin: false }),
    ["Admin", "Settings"],
  );
  assert.deepEqual(
    labels({ canManageActiveOrganization: false, isPlatformAdmin: true }),
    ["Platform", "Settings"],
  );
  assert.deepEqual(
    labels({ canManageActiveOrganization: true, isPlatformAdmin: true }),
    ["Platform", "Admin", "Settings"],
  );
});

test("scope footer matches only its canonical route family", () => {
  const items = getSidebarScopeItems({
    canManageActiveOrganization: true,
    isPlatformAdmin: true,
  });

  assert.equal(items[0]?.match("/platform/runtime"), true);
  assert.equal(items[0]?.match("/organization"), false);
  assert.equal(items[1]?.match("/organization/people"), true);
  assert.equal(items[1]?.match("/settings/profile"), false);
  assert.equal(items[2]?.match("/settings/connections"), true);
  assert.equal(items[2]?.match("/platform/users"), false);
});

test("platform scope links directly to its canonical landing page", () => {
  const items = getSidebarScopeItems({
    canManageActiveOrganization: true,
    isPlatformAdmin: true,
  });

  assert.equal(items[0]?.href, "/platform/users");
});
