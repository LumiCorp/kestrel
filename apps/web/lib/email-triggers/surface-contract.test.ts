import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(directory, "../..");
const read = (relativePath: string) =>
  fs.readFileSync(path.join(webRoot, relativePath), "utf8");

test("Email Triggers are a primary Work surface with public aliases", () => {
  const navigation = read("components/nav-main.tsx");
  const client = read("components/email-triggers/email-triggers-client.tsx");
  const page = read("app/(workspace)/triggers/page.tsx");

  assert.match(navigation, /title: "Triggers",[\s\S]*url: "\/triggers"/u);
  assert.ok(navigation.indexOf('title: "Triggers"') > navigation.indexOf('title: "Schedules"'));
  assert.match(page, /listProjectEmailTriggersForUser/u);
  assert.match(client, /eyebrow="Work"/u);
  assert.match(client, /title="Triggers"/u);
  assert.match(client, /New trigger/u);
  assert.match(client, /No triggers yet/u);
  assert.match(client, /What should the agent do with each email\?/u);
  assert.match(client, /Label htmlFor="trigger-alias">Email alias/u);
  assert.match(client, /DEFAULT_EMAIL_TRIGGER_INSTRUCTION/u);
  assert.match(client, /Label htmlFor="trigger-model">Model/u);
  assert.match(client, /\/api\/models\/approved\?modality=language&projectId=/u);
  assert.match(client, /configured model is unavailable and will be preserved/iu);
  assert.match(client, /draft\.modelId !== editing\.modelId/u);
  assert.match(client, /Runs as/u);
  assert.match(client, /Exact claimed-From filter/u);
  assert.match(client, /does not verify the sender's identity/u);
  assert.match(client, /Copy email address/u);
  assert.match(client, /Rotate private address/u);
  assert.match(client, /> Disable/u);
  assert.match(client, /> Enable/u);
  assert.doesNotMatch(client, />\s*Public\s*</u);
  assert.doesNotMatch(client, /executionOwnerUserId|owner selector/iu);
  assert.doesNotMatch(
    client.match(/type EmailTriggerDraft = \{[\s\S]*?\n\};/u)?.[0] ?? "",
    /accessMode|executionOwner/u,
  );
  const saveRequest =
    client.match(/async function saveTrigger\(\)[\s\S]*?\n {2}async function setEnabled/u)?.[0] ??
    "";
  assert.match(saveRequest, /method: editing \? "PATCH" : "POST"/u);
  assert.match(saveRequest, /name: draft\.name/u);
  assert.match(saveRequest, /alias: draft\.alias/u);
  assert.match(saveRequest, /modelId: draft\.modelId/u);
  assert.doesNotMatch(saveRequest, /\benabled\b/u);
});

test("Email Trigger APIs keep access mode and Execution Owner server-owned", () => {
  const collection = read("app/api/projects/[id]/email-triggers/route.ts");
  const item = read("app/api/projects/[id]/email-triggers/[triggerId]/route.ts");
  const rotate = read("app/api/projects/[id]/email-triggers/[triggerId]/rotate/route.ts");

  for (const route of [collection, item, rotate]) {
    assert.match(route, /requireActiveOrganization/u);
    assert.doesNotMatch(route, /accessMode|executionOwnerUserId/u);
  }
  assert.match(collection, /createEmailTriggerInputSchema/u);
  assert.match(item, /updateEmailTriggerInputSchema/u);
  assert.match(rotate, /emailTriggerRevisionInputSchema/u);
  assert.match(item, /expectedRevision/u);
  assert.match(rotate, /expectedRevision/u);
});

test("Email Trigger addresses stay out of audit metadata and ordinary logging", () => {
  const store = read("lib/email-triggers/store.ts");
  assert.doesNotMatch(store, /console\.(?:log|info|warn|error)/u);
  assert.doesNotMatch(store, /metadata: \{[^}]*address/u);
  assert.match(store, /randomBytes\(16\)\.toString\("hex"\)/u);
});
