import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function read(relativePath: string) {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}

test("Apps use readiness-first detail and a compact installed or available index", () => {
  const page = read("app/(workspace)/apps/page.tsx");
  const index = read("components/apps/apps-gallery.tsx");
  const detail = read("components/apps/app-detail.tsx");

  assert.match(page, /getDefaultOrganizationEnvironment/u);
  assert.match(index, /\bPageHeader\b/u);
  assert.match(index, /TabsTrigger value="installed"/u);
  assert.match(index, /TabsTrigger value="available"/u);
  assert.match(index, /aria-label="Filter by category"/u);
  assert.match(index, /Add App/u);
  assert.match(
    read("components/apps/app-gallery.tsx"),
    /flex w-full items-center/u,
  );
  assert.doesNotMatch(index, /TabsTrigger value="discover"/u);
  assert.doesNotMatch(index, /TabsTrigger value="connections"/u);

  const statusIndex = detail.indexOf("<SettingsStatusNotice");
  const connectionsIndex = detail.indexOf('title="Connections"');
  assert.ok(statusIndex >= 0);
  assert.ok(connectionsIndex > statusIndex);
  assert.match(detail, /title="Capability details"/u);
  assert.match(detail, /aria-label="App actions"/u);
  assert.match(detail, /<AlertDialogTitle>Disable/u);
});

test("Project Apps and Skills lead with resource state and disclose advanced controls", () => {
  const projectApps = read("components/projects/project-apps.tsx");
  const appSheet = read("components/projects/project-shared-app-sheet.tsx");
  const skills = read("components/projects/project-skills.tsx");

  assert.match(projectApps, />Enabled</u);
  assert.match(projectApps, />Available</u);
  assert.match(projectApps, /layout="list"/u);
  assert.match(projectApps, /Loading Project Apps…/u);
  assert.match(projectApps, /Project Apps could not be loaded/u);
  assert.match(appSheet, /<details className="group border-t py-7">/u);
  assert.match(appSheet, /Agent capabilities/u);

  assert.match(skills, /\bResourceList\b/u);
  assert.match(skills, /\bResourceRow\b/u);
  assert.match(skills, /\bResourceEmpty\b/u);
  assert.match(skills, /Add skill/u);
  assert.match(skills, /<DialogTitle>/u);
  assert.match(skills, /Advanced source options/u);
  assert.match(skills, /Inspect provenance/u);
  assert.match(skills, /Sync pending changes/u);
  assert.match(skills, /<AlertDialogTitle>Remove this skill\?/u);
  assert.doesNotMatch(skills, /rounded-xl border bg-card/u);
});

test("Threads and Search keep one primary action and flat grouped results", () => {
  const threadsPage = read("app/(workspace)/threads/page.tsx");
  const threadIndex = read("components/threads/thread-index.tsx");
  const workspaceRail = read("components/workspace-rail.tsx");
  const search = read("app/(workspace)/search/page.tsx");

  assert.match(threadsPage, /\bPageHeader\b/u);
  assert.match(threadsPage, /TabsTrigger asChild value="active"/u);
  assert.match(threadsPage, /TabsTrigger asChild value="archived"/u);
  assert.equal(threadsPage.match(/New Thread/gu)?.length, 1);
  assert.match(threadIndex, /Thread actions for/u);
  assert.match(threadIndex, /Archive Thread/u);
  assert.match(workspaceRail, /pathname === "\/projects\/new"/u);
  assert.match(workspaceRail, /pathname === "\/threads"/u);
  assert.match(workspaceRail, /pathname\.startsWith\("\/search"\)/u);

  assert.match(search, /\bPageHeader\b/u);
  assert.match(search, /\bResourceList\b/u);
  assert.match(search, /\bResourceRow\b/u);
  assert.match(search, /results\.projects\.length > 0/u);
  assert.match(search, /results\.threads\.length > 0/u);
  assert.match(search, /results\.messages\.length > 0/u);
  assert.match(search, /No results for/u);
  assert.match(search, /aria-label="Clear Project scope"/u);
  assert.doesNotMatch(search, /\bCard\b/u);
});

test("Knowledge and Project creation defer low-value or destructive detail", () => {
  const knowledge = read("app/knowledge/knowledge-client.tsx");
  const createProject = read("components/projects/create-project-form.tsx");

  assert.match(knowledge, /\bResourceList\b/u);
  assert.match(knowledge, /\bResourceRow\b/u);
  assert.match(knowledge, /needsAttention \?/u);
  assert.match(knowledge, /Technical details/u);
  assert.match(knowledge, /Delete this document permanently\?/u);
  assert.doesNotMatch(knowledge, /\bCard\b/u);
  assert.doesNotMatch(knowledge, /\bTable\b/u);

  assert.match(createProject, /<details className="group py-5">/u);
  assert.match(createProject, /Add instructions now/u);
  assert.ok(createProject.includes("disabled={creating || !name.trim()}"));
});
