import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const settingsComponentsRoot = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(settingsComponentsRoot, "../..");
const settingsRoutesRoot = path.join(webRoot, "app/(workspace)/settings");

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(absolutePath);
    return entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) ? [absolutePath] : [];
  });
}

function read(relativePath: string) {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}

contractTest(
  "web.hermetic",
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
  }
);

contractTest(
  "web.hermetic",
  "settings shell and navigation own the inference and environment split",
  () => {
    const layout = read("app/(workspace)/settings/layout.tsx");
    const navigation = read("components/settings/settings-navigation.tsx");
    const manifest = read("app/route-ownership.manifest.ts");
    const inference = read("components/settings/inference-client.tsx");
    const environments = read("components/settings/environments-client.tsx");
    const setup = read("components/settings/setup-client.tsx");
    const settingsLayout = read("app/(workspace)/settings/layout.tsx");
    const teamSwitcher = read("components/team-switcher.tsx");

    assert.match(layout, /max-w-7xl/u);
    assert.match(layout, /<main className="[^"]*px-4/u);
    assert.match(navigation, /\/settings\/organization\/inference/u);
    assert.match(navigation, /\/settings\/organization\/setup/u);
    assert.doesNotMatch(navigation, /\/settings\/organization\/infrastructure/u);
    assert.match(manifest, /\/settings\/organization\/inference", "models"/u);
    assert.match(manifest, /\/settings\/organization\/setup", "models"/u);
    assert.doesNotMatch(manifest, /\/settings\/organization\/infrastructure"/u);
    assert.doesNotMatch(inference, /connections\/fly/u);
    assert.match(environments, /FlyWorkspaceProviderClient/u);
    assert.match(setup, /Start first chat/u);
    assert.doesNotMatch(setup, /components\/ui\/card/u);
    assert.equal(
      settingsLayout.match(/lg:mr-0 lg:ml-8 lg:w-auto/gu)?.length,
      2
    );
    assert.equal(settingsLayout.match(/max-w-\[100rem\]/gu)?.length, 2);
    assert.match(teamSwitcher, /aria-label="Switch organization"/u);
    assert.match(teamSwitcher, /tooltip="Switch organization"/u);
    assert.doesNotMatch(teamSwitcher, />\s*Workspace\s*<\/span>/u);
    assert.match(teamSwitcher, /bg-sidebar-primary/u);
    assert.match(teamSwitcher, /text-sidebar-primary-foreground/u);
    assert.equal(
      fs.existsSync(
        path.join(
          webRoot,
          "app/(workspace)/settings/organization/infrastructure/page.tsx"
        )
      ),
      false
    );
  }
);
