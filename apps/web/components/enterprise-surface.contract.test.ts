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

test("enterprise surfaces share one quiet page grammar", () => {
  const header = read("components/page-header.tsx");
  const settings = read("components/settings/settings-section.tsx");
  const resources = read("components/resource-list.tsx");

  assert.match(header, /<h1/u);
  assert.match(header, /status\?: ReactNode/u);
  assert.match(header, /w-full min-w-0 flex-col/u);
  assert.match(header, /w-full shrink-0 flex-wrap/u);
  assert.match(settings, /width\?: "narrow" \| "standard" \| "wide"/u);
  assert.match(settings, /data-slot="settings-disclosure"/u);
  assert.match(settings, /data-slot="settings-form-actions"/u);
  assert.match(settings, /tone="danger"/u);
  assert.match(resources, /data-slot="resource-list"/u);
  assert.match(resources, /role="listitem"/u);
  assert.match(settings, /grid grid-cols-2 border-y lg:grid-cols-4/u);
  assert.match(settings, /\[&>\*:nth-child\(n\+3\)\]:border-t/u);
});

test("pilot operation surfaces lead with attention and disclose evidence", () => {
  const environmentActivity = read(
    "app/(workspace)/organization/environments/[id]/activity/page.tsx"
  );
  const platformOperations = read("app/admin/environments/page.tsx");

  assert.match(environmentActivity, /title="Activity"/u);
  assert.match(environmentActivity, /title="Operations"/u);
  assert.match(environmentActivity, /title="Runs"/u);
  assert.match(environmentActivity, /title="Technical details"/u);
  assert.match(environmentActivity, /<SettingsDisclosure[\s\S]*\{run\.id\}/u);
  assert.match(environmentActivity, /getEnvironmentActivityPresentation/u);
  assert.match(environmentActivity, /\{operation\.stage\}/u);
  assert.match(environmentActivity, /\{operation\.id\}/u);

  assert.match(platformOperations, /Requires attention/u);
  assert.match(platformOperations, /href="\/admin\/environments\?view=active"/u);
  assert.match(platformOperations, /href="\/admin\/environments\?view=history"/u);
  assert.match(platformOperations, /Technical details/u);
  assert.doesNotMatch(platformOperations, /AdminStatCard/u);
});

test("Connections distinguishes loading, failure, and true empty states", () => {
  const connections = read("components/settings/ai-providers-client.tsx");

  assert.match(connections, /loadingGateways/u);
  assert.match(connections, /Providers could not be loaded/u);
  assert.match(connections, /No providers configured yet/u);
  assert.match(connections, /Try again/u);
});
