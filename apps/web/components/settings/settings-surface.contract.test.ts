import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const settingsComponentsRoot = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(settingsComponentsRoot, "../..");
const settingsRoutesRoot = path.join(webRoot, "app/(workspace)/settings");

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(absolutePath);
    return entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)
      ? [absolutePath]
      : [];
  });
}

function read(relativePath: string) {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}

test(
  "settings-owned modules use the shared cardless settings surface",
  () => {
    const files = [
      ...listSourceFiles(settingsRoutesRoot),
      ...listSourceFiles(settingsComponentsRoot),
    ].filter((file) => !file.endsWith("settings-surface.contract.test.ts"));

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const relative = path.relative(webRoot, file);
      assert.doesNotMatch(source, /components\/ui\/card/u, relative);
      assert.doesNotMatch(source, /\bAppPage\b/u, relative);
      assert.doesNotMatch(source, /\bAdminPageHeader\b/u, relative);
      assert.doesNotMatch(source, /\bbg-card\b/u, relative);
      assert.doesNotMatch(source, /\bshadow(?:-|\b)/u, relative);
    }
  },
);

test(
  "organization, platform, and personal settings retain separate navigation scopes",
  () => {
    const layout = read("app/(workspace)/settings/layout.tsx");
    const navigation = read("components/settings/settings-navigation.tsx");
    const organizationLayout = read(
      "app/(workspace)/organization/layout.tsx",
    );
    const organizationNavigation = read(
      "components/organization/organization-navigation.tsx",
    );
    const platformLayout = read("app/(workspace)/platform/layout.tsx");
    const platformNavigation = read(
      "components/platform/platform-navigation.tsx",
    );
    const scopeFooter = read("components/nav-scope-footer.tsx");
    const manifest = read("app/route-ownership.manifest.ts");
    const inference = read("components/settings/inference-client.tsx");
    const environments = read("components/settings/environments-client.tsx");
    const setup = read("components/settings/setup-client.tsx");
    const settingsLayout = read("app/(workspace)/settings/layout.tsx");
    const pageContainer = read("components/app-page.tsx");
    const teamSwitcher = read("components/team-switcher.tsx");
    const appSidebar = read("components/app-sidebar.tsx");
    const connectionsPage = read(
      "app/(workspace)/settings/connections/page.tsx",
    );
    const githubConnection = read(
      "components/apps/github-connection-card.tsx",
    );
    const googleConnection = read(
      "components/apps/google-workspace-connection-card.tsx",
    );
    const microsoftConnection = read(
      "components/apps/microsoft-365-connection-card.tsx",
    );

    assert.match(pageContainer, /max-w-7xl/u);
    assert.match(layout, /\bPageContainer\b/u);
    assert.doesNotMatch(layout, /<h1/u);
    assert.equal(layout.match(/<PageContainer/gu)?.length, 1);
    assert.doesNotMatch(layout, /<main className="[^"]*\bpx-/u);
    assert.doesNotMatch(navigation, /lg:hidden[^\n]*\bpx-4/u);
    assert.match(organizationLayout, /\bPageContainer\b/u);
    assert.doesNotMatch(organizationLayout, /<main\b/u);
    assert.match(organizationLayout, /\bOrganizationNavigation\b/u);
    assert.doesNotMatch(organizationLayout, /\bAppPage\b/u);
    assert.doesNotMatch(organizationLayout, /<h1/u);
    assert.equal(organizationLayout.match(/<PageContainer/gu)?.length, 1);
    assert.doesNotMatch(
      organizationLayout,
      /<main className="[^"]*\bpx-/u,
    );
    assert.match(organizationNavigation, /label: "Manage"/u);
    assert.match(organizationNavigation, /label: "Configure"/u);
    assert.match(organizationNavigation, /label: "Operate"/u);
    assert.match(
      organizationNavigation,
      /pathname\.startsWith\("\/organization\/environments\/"\)/u,
    );
    assert.match(organizationNavigation, /id="organization-section"/u);
    assert.match(organizationNavigation, /lg:hidden/u);
    assert.match(organizationNavigation, /lg:block/u);
    assert.doesNotMatch(organizationNavigation, /\bEnvironmentTabs\b/u);
    const organizationNavigationHrefs = [
      ...organizationNavigation.matchAll(/href: "([^"]+)"/gu),
    ].map((match) => match[1]);
    assert.equal(
      new Set(organizationNavigationHrefs).size,
      organizationNavigationHrefs.length,
    );
    for (const href of [
      "/organization",
      "/organization/setup",
      "/organization/connections",
      "/organization/inference",
      "/organization/systems",
      "/organization/usage",
    ]) {
      assert.ok(organizationNavigationHrefs.includes(href), href);
    }
    assert.match(navigation, /label: "Personal"/u);
    assert.doesNotMatch(navigation, /label: "Platform"/u);
    assert.doesNotMatch(navigation, /organizationItems/u);
    assert.doesNotMatch(navigation, /label: "Organization"/u);
    assert.doesNotMatch(navigation, /\/settings\/organization/u);
    assert.doesNotMatch(navigation, /href: "\/organization/u);
    const navigationHrefs = [...navigation.matchAll(/href: "([^"]+)"/gu)].map(
      (match) => match[1],
    );
    assert.deepEqual(navigationHrefs, [
      "/settings/profile",
      "/settings/appearance",
      "/settings/api-keys",
      "/settings/connections",
    ]);
    assert.equal(new Set(navigationHrefs).size, navigationHrefs.length);
    assert.match(platformLayout, /requireAdmin: true/u);
    assert.match(platformLayout, /\bPageContainer\b/u);
    assert.match(platformLayout, /\bPlatformNavigation\b/u);
    assert.match(platformNavigation, /label: "Configure"/u);
    assert.match(platformNavigation, /label: "Operate"/u);
    assert.match(platformNavigation, /id="platform-section"/u);
    assert.match(platformNavigation, /lg:hidden/u);
    assert.match(platformNavigation, /lg:block/u);
    const platformHrefs = [
      ...platformNavigation.matchAll(/href: "([^"]+)"/gu),
    ].map((match) => match[1]);
    assert.deepEqual(platformHrefs, [
      "/platform/users",
      "/platform/signup-codes",
      "/platform/email",
      "/platform/operations",
      "/platform/runtime",
      "/platform/billing",
      "/platform/docs",
    ]);
    assert.ok(
      scopeFooter.indexOf('label: "Platform"') <
        scopeFooter.indexOf('label: "Admin"'),
    );
    assert.ok(
      scopeFooter.indexOf('label: "Admin"') <
        scopeFooter.indexOf('label: "Settings"'),
    );
    assert.match(scopeFooter, /access\.isPlatformAdmin/u);
    assert.match(scopeFooter, /access\.canManageActiveOrganization/u);
    assert.match(scopeFooter, /pathname\.startsWith\("\/platform"\)/u);
    assert.match(scopeFooter, /pathname\.startsWith\("\/organization"\)/u);
    assert.match(scopeFooter, /pathname\.startsWith\("\/settings"\)/u);
    assert.match(scopeFooter, /aria-current/u);
    assert.match(manifest, /"\/organization\/setup"/u);
    assert.match(manifest, /"\/organization\/agent-defaults"/u);
    assert.match(manifest, /"\/organization\/connections"/u);
    assert.match(manifest, /"\/organization\/inference"/u);
    assert.match(manifest, /"\/organization\/usage"/u);
    assert.match(manifest, /\/organization\/environments\/:id\/apps\/:appKey/u);
    assert.match(manifest, /"\/organization\/danger"/u);
    assert.doesNotMatch(manifest, /\/settings\/organization\/infrastructure"/u);
    assert.doesNotMatch(inference, /connections\/fly/u);
    assert.match(environments, /FlyWorkspaceProviderClient/u);
    assert.match(setup, /Start first chat/u);
    assert.doesNotMatch(setup, /components\/ui\/card/u);
    assert.doesNotMatch(settingsLayout, /lg:mr-0 lg:ml-8 lg:w-auto/u);
    assert.doesNotMatch(settingsLayout, /max-w-\[100rem\]/u);
    assert.match(teamSwitcher, /aria-label="Switch organization"/u);
    assert.match(teamSwitcher, /tooltip="Switch organization"/u);
    assert.match(teamSwitcher, /Manage organization/u);
    assert.match(teamSwitcher, /href="\/organization"/u);
    assert.match(teamSwitcher, /activeOrg && canManageDisplayedOrganization/u);
    assert.match(teamSwitcher, /pendingOrgId === null/u);
    assert.match(teamSwitcher, /onSwitchPendingChange\?\.\(true\)/u);
    assert.match(teamSwitcher, /window\.location\.reload\(\)/u);
    assert.match(appSidebar, /!organizationSwitchPending/u);
    assert.match(
      teamSwitcher,
      /activeOrg\?\.id === initialActiveOrganization\?\.id/u,
    );
    assert.doesNotMatch(teamSwitcher, />\s*Workspace\s*<\/span>/u);
    assert.match(teamSwitcher, /bg-sidebar-primary/u);
    assert.match(teamSwitcher, /text-sidebar-primary-foreground/u);
    assert.match(connectionsPage, /listAppsForOrganization/u);
    assert.match(connectionsPage, /installationStatus === "installed"/u);
    assert.match(connectionsPage, /<GithubConnectionCard\s+installed=/u);
    assert.match(connectionsPage, /<GoogleWorkspaceConnectionCard/u);
    assert.match(connectionsPage, /<Microsoft365ConnectionCard/u);
    for (const connectionCard of [
      githubConnection,
      googleConnection,
      microsoftConnection,
    ]) {
      assert.match(connectionCard, /installed: boolean/u);
      assert.match(connectionCard, /!installed/u);
      assert.match(connectionCard, /organization admin must install/u);
    }
    assert.equal(
      fs.existsSync(
        path.join(
          webRoot,
          "app/(workspace)/settings/organization/infrastructure/page.tsx",
        ),
      ),
      false,
    );
  },
);

test("legacy platform routes permanently redirect to canonical owners", () => {
  const redirects = [
    ["app/admin/page.tsx", "/platform/operations"],
    ["app/admin/environments/page.tsx", "/platform/operations"],
    ["app/admin/releases/page.tsx", "/platform/runtime"],
    ["app/admin/billing/page.tsx", "/platform/billing"],
    ["app/admin/docs/page.tsx", "/platform/docs"],
    ["app/admin/users/page.tsx", "/platform/users"],
    ["app/(workspace)/settings/platform/page.tsx", "/platform/users"],
    [
      "app/(workspace)/settings/platform/users/page.tsx",
      "/platform/users",
    ],
    [
      "app/(workspace)/settings/platform/signup-codes/page.tsx",
      "/platform/signup-codes",
    ],
    [
      "app/(workspace)/settings/platform/email/page.tsx",
      "/platform/email",
    ],
  ] as const;

  for (const [legacyPath, target] of redirects) {
    const source = read(legacyPath);
    assert.match(source, /\bpermanentRedirect\b/u, legacyPath);
    assert.ok(source.includes(`permanentRedirect("${target}")`), legacyPath);
  }

  const dynamicDocs = read("app/admin/docs/[slug]/page.tsx");
  assert.match(dynamicDocs, /\bpermanentRedirect\b/u);
  assert.match(dynamicDocs, /`\/platform\/docs\/\$\{slug\}`/u);
});

test("legacy organization routes permanently redirect to canonical owners", () => {
  const routePairs = [
    ["organization/page.tsx", "organization/page.tsx"],
    ["organization/setup/page.tsx", "organization/setup/page.tsx"],
    ["organization/members/page.tsx", "organization/people/page.tsx"],
    ["organization/billing/page.tsx", "organization/billing/page.tsx"],
    [
      "organization/agent-defaults/page.tsx",
      "organization/agent-defaults/page.tsx",
    ],
    [
      "organization/ai-providers/page.tsx",
      "organization/connections/page.tsx",
    ],
    ["organization/inference/page.tsx", "organization/inference/page.tsx"],
    ["organization/email/page.tsx", "organization/email/page.tsx"],
    ["organization/api-keys/page.tsx", "organization/api-keys/page.tsx"],
    ["organization/usage/page.tsx", "organization/usage/page.tsx"],
    ["organization/audit/page.tsx", "organization/audit/page.tsx"],
    [
      "organization/environments/[id]/page.tsx",
      "organization/environments/[id]/page.tsx",
    ],
    [
      "organization/environments/[id]/runtime/page.tsx",
      "organization/environments/[id]/runtime/page.tsx",
    ],
    [
      "organization/environments/[id]/access/page.tsx",
      "organization/environments/[id]/access/page.tsx",
    ],
    [
      "organization/environments/[id]/workspaces/page.tsx",
      "organization/environments/[id]/workspaces/page.tsx",
    ],
    [
      "organization/environments/[id]/inference/page.tsx",
      "organization/environments/[id]/inference/page.tsx",
    ],
    [
      "organization/environments/[id]/apps/page.tsx",
      "organization/environments/[id]/apps/page.tsx",
    ],
    [
      "organization/environments/[id]/apps/[appKey]/page.tsx",
      "organization/environments/[id]/apps/[appKey]/page.tsx",
    ],
    [
      "organization/environments/[id]/activity/page.tsx",
      "organization/environments/[id]/activity/page.tsx",
    ],
  ] as const;

  for (const [legacyPath, canonicalPath] of routePairs) {
    const legacy = read(`app/(workspace)/settings/${legacyPath}`);
    const canonical = read(`app/(workspace)/${canonicalPath}`);
    assert.match(legacy, /\bpermanentRedirect\b/u, legacyPath);
    assert.doesNotMatch(canonical, /export \{ default \} from/u, canonicalPath);
  }

  assert.match(
    read("app/(workspace)/settings/organization/environments/page.tsx"),
    /permanentRedirect\("\/organization"\)/u,
  );
  assert.match(
    read("app/(workspace)/organization/environments/page.tsx"),
    /permanentRedirect\("\/organization"\)/u,
  );
});
