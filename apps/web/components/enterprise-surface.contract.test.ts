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

test("settings and organization surfaces keep creation and maintenance secondary", () => {
  const appearance = read("components/settings/appearance-client.tsx");
  const personalKeys = read("components/settings/personal-api-keys-client.tsx");
  const organizationKeys = read(
    "components/settings/organization-api-keys-client.tsx",
  );
  const people = read("components/settings/members-client.tsx");
  const billing = read("components/settings/billing-client.tsx");
  const usage = read("components/settings/usage-client.tsx");
  const audit = read(
    "app/(workspace)/settings/organization/audit/page-client.tsx",
  );

  assert.match(appearance, /title="Choose light palette"/u);
  assert.match(appearance, /title="Choose dark palette"/u);
  assert.match(personalKeys, /<Dialog onOpenChange=\{setCreateOpen\}/u);
  assert.match(personalKeys, /<AlertDialog/u);
  assert.match(organizationKeys, /<Dialog onOpenChange=\{setCreateOpen\}/u);
  assert.match(organizationKeys, /Save this API key now/u);
  assert.match(organizationKeys, /<AlertDialog/u);
  assert.match(people, /title="Members"/u);
  assert.match(people, /title="Pending invitations"/u);
  assert.match(people, /title="Invitation history"/u);
  assert.doesNotMatch(people, /CreateOrganizationDialog/u);
  assert.doesNotMatch(people, /useListOrganizations/u);
  assert.match(billing, /title="Subscription"/u);
  assert.match(billing, /label="Next event"/u);
  assert.match(usage, /title="Advanced pricing"/u);
  assert.match(audit, /title="Requires attention"/u);
  assert.match(audit, /title="Advanced maintenance"/u);
  assert.match(audit, /<AlertDialog/u);
});

test("environment details prioritize health and disclose technical controls", () => {
  const overview = read(
    "app/(workspace)/organization/environments/[id]/page.tsx",
  );
  const runtime = read(
    "app/(workspace)/organization/environments/[id]/runtime/page.tsx",
  );
  const workspaces = read(
    "app/(workspace)/organization/environments/[id]/workspaces/page.tsx",
  );
  const apps = read(
    "app/(workspace)/organization/environments/[id]/apps/page.tsx",
  );
  const inference = read(
    "app/(workspace)/settings/environments/[id]/inference/page-client.tsx",
  );
  const access = read(
    "app/(workspace)/settings/environments/[id]/access/environment-access-form.tsx",
  );

  assert.match(overview, /title="Operational state"/u);
  assert.match(overview, /title="Technical details"/u);
  assert.match(overview, /<SettingsDangerSection/u);
  assert.match(runtime, /title="Runtime release"/u);
  assert.match(runtime, /title="Runtime details"/u);
  assert.match(runtime, /title="Provider reasoning policy"/u);
  assert.match(workspaces, /<ResourceList>/u);
  assert.doesNotMatch(workspaces, /<Table/u);
  assert.match(apps, /title="Needs setup"/u);
  assert.match(apps, /title="Ready"/u);
  assert.match(apps, /title="Add custom app"/u);
  assert.match(inference, /title="Inference fleet"/u);
  assert.match(inference, /title="Add inference endpoint"/u);
  assert.match(inference, /<AlertDialog/u);
  assert.match(access, /"Read", "Write", "Administrative"/u);
});
