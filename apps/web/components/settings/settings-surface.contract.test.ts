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
  "organization management replaces settings navigation while settings retains personal and platform surfaces",
  () => {
    const layout = read("app/(workspace)/settings/layout.tsx");
    const navigation = read("components/settings/settings-navigation.tsx");
    const organizationLayout = read(
      "app/(workspace)/organization/layout.tsx",
    );
    const organizationNavigation = read(
      "components/organization/organization-navigation.tsx",
    );
    const manifest = read("app/route-ownership.manifest.ts");
    const inference = read("components/settings/inference-client.tsx");
    const environments = read("components/settings/environments-client.tsx");
    const setup = read("components/settings/setup-client.tsx");
    const settingsLayout = read("app/(workspace)/settings/layout.tsx");
    const pageContainer = read("components/app-page.tsx");
    const teamSwitcher = read("components/team-switcher.tsx");

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
    assert.match(navigation, /label: "Platform"/u);
    assert.doesNotMatch(navigation, /organizationItems/u);
    assert.doesNotMatch(navigation, /label: "Organization"/u);
    assert.doesNotMatch(navigation, /\/settings\/organization/u);
    assert.doesNotMatch(navigation, /href: "\/organization/u);
    const navigationHrefs = [...navigation.matchAll(/href: "([^"]+)"/gu)].map(
      (match) => match[1],
    );
    assert.equal(new Set(navigationHrefs).size, navigationHrefs.length);
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
    assert.doesNotMatch(teamSwitcher, />\s*Workspace\s*<\/span>/u);
    assert.match(teamSwitcher, /bg-sidebar-primary/u);
    assert.match(teamSwitcher, /text-sidebar-primary-foreground/u);
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
