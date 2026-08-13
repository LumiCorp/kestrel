import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const componentsRoot = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(componentsRoot, "..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}

test("standard pages share one tight responsive container contract", () => {
  const source = read("components/app-page.tsx");

  assert.match(source, /data-slot="page-container"/u);
  assert.match(source, /px-4 py-5 sm:px-6 sm:py-6 lg:px-8/u);
  assert.match(source, /mx-auto w-full min-w-0 max-w-7xl/u);
  assert.match(source, /<PageContainer contentClassName=/u);
});

test("every application shell owns the standard page container", () => {
  const appPageLayouts = [
    "app/debug/layout.tsx",
    "app/knowledge/layout.tsx",
  ];

  for (const relativePath of appPageLayouts) {
    assert.match(read(relativePath), /<AppPage>/u, relativePath);
  }

  assert.match(
    read("app/(workspace)/settings/layout.tsx"),
    /<PageContainer/u,
  );
  assert.match(
    read("app/(workspace)/organization/layout.tsx"),
    /<PageContainer/u,
  );
  assert.match(read("app/(workspace)/platform/layout.tsx"), /<PageContainer/u);
  const legacyAdminLayout = read("app/admin/layout.tsx");
  assert.match(legacyAdminLayout, /requireAdmin: true/u);
  assert.doesNotMatch(legacyAdminLayout, /Navigation/u);
  const organizationNavigation = read(
    "components/organization/organization-navigation.tsx",
  );
  for (const href of [
    "/organization",
    "/organization/setup",
    "/organization/connections",
    "/organization/systems",
    "/organization/audit",
    "/organization/danger",
  ]) {
    assert.match(organizationNavigation, new RegExp(`href: "${href}"`, "u"));
  }
  assert.match(read("app/(auth)/layout.tsx"), /<PageContainer/u);
  assert.match(read("app/shared/[token]/page.tsx"), /<PageContainer/u);
  assert.match(read("app/desktop/enroll/[id]/page.tsx"), /<PageContainer/u);
  assert.match(read("app/(workspace)/welcome/page.tsx"), /<PageContainer/u);
  assert.match(read("app/accept-invitation/[id]/page.tsx"), /<PageContainer/u);

  const directlyContainedSurfaces = [
    "app/dashboard/page.tsx",
    "app/(workspace)/apps/page.tsx",
    "app/(workspace)/apps/[appKey]/page.tsx",
    "app/(workspace)/projects/page.tsx",
    "app/(workspace)/projects/new/page.tsx",
    "app/(workspace)/projects/[id]/page.tsx",
    "app/(workspace)/projects/[id]/workspace/workspace-client.tsx",
    "app/(workspace)/search/page.tsx",
    "app/(workspace)/threads/page.tsx",
  ];

  for (const relativePath of directlyContainedSurfaces) {
    assert.match(read(relativePath), /<AppPage/u, relativePath);
  }
});

test("immersive thread and workspace routes remain edge-to-edge", () => {
  const immersiveRoutes = [
    "app/(workspace)/threads/[id]/page.tsx",
    "app/(workspace)/threads/new/page.tsx",
    "app/(workspace)/threads/[id]/workspace/page.tsx",
    "app/(workspace)/projects/[id]/threads/new/page.tsx",
  ];

  for (const relativePath of immersiveRoutes) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /\bPageContainer\b/u, relativePath);
    assert.doesNotMatch(source, /\bAppPage\b/u, relativePath);
  }
});
