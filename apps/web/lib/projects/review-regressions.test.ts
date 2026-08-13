import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectTabHref, resolveProjectTab } from "./project-tabs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readAppSource(relativePath: string) {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

test("Project tabs stay owned by the URL across same-page navigation", () => {
  assert.equal(resolveProjectTab({ tab: "apps", hasGoogle: false }), "apps");
  assert.equal(
    resolveProjectTab({ tab: "skills", hasGoogle: false }),
    "skills",
  );
  assert.equal(
    resolveProjectTab({ tab: "context", hasGoogle: false }),
    "context",
  );
  assert.equal(
    resolveProjectTab({ tab: "unknown", hasGoogle: false }),
    "overview",
  );
  assert.equal(resolveProjectTab({ tab: null, hasGoogle: true }), "apps");
  assert.equal(projectTabHref("project-1", "overview"), "/projects/project-1");
  assert.equal(
    projectTabHref("project-1", "activity"),
    "/projects/project-1?tab=activity",
  );
  assert.equal(
    projectTabHref("project-1", "skills"),
    "/projects/project-1?tab=skills",
  );
});

test("Project skills have a first-class tab separate from Apps and Workspace setup", () => {
  const projectHome = readAppSource(
    "components/projects/project-home-client.tsx",
  );
  const workspaceRail = readAppSource("components/workspace-rail.tsx");
  const projectSkills = readAppSource("components/projects/project-skills.tsx");
  const workspaceSetup = readAppSource(
    "app/(workspace)/projects/[id]/workspace/workspace-client.tsx",
  );

  assert.match(projectHome, /TabsTrigger value="apps">Apps</u);
  assert.match(projectHome, /TabsTrigger value="skills">Skills</u);
  assert.match(
    projectHome,
    /TabsContent value="skills">[\s\S]*<ProjectSkills/u,
  );
  assert.match(workspaceRail, /label: "Apps", tab: "apps"/u);
  assert.match(workspaceRail, /label: "Skills", tab: "skills"/u);
  assert.match(
    projectSkills,
    /placeholder="https:\/\/github\.com\/org\/skills\.git"/u,
  );
  assert.match(projectSkills, /Add skill/u);
  assert.match(projectSkills, /<DialogTitle>/u);
  assert.match(projectSkills, /\bResourceList\b/u);
  assert.match(projectSkills, />Git repository URL</u);
  assert.match(projectSkills, /pending: "Pending activation"/u);
  assert.match(projectSkills, /Advanced source options/u);
  assert.match(projectSkills, /Inspect provenance/u);
  assert.doesNotMatch(projectSkills, /Project Workspace required/u);
  assert.doesNotMatch(projectSkills, /href=.*workspace/u);
  assert.doesNotMatch(workspaceSetup, /Agent skills/u);
});

test("Project header owns its primary Thread action while Workspace owns binding", () => {
  const projectHome = readAppSource(
    "components/projects/project-home-client.tsx",
  );
  const headerIndex = projectHome.indexOf("<PageHeader");
  const overviewIndex = projectHome.indexOf('<TabsContent value="overview">');

  assert.ok(headerIndex >= 0);
  assert.ok(overviewIndex > headerIndex);
  const header = projectHome.slice(headerIndex, overviewIndex);
  assert.match(header, /New Thread/u);
  assert.match(header, /Configure Workspace/u);
  assert.doesNotMatch(header, /Project Environment/u);
  assert.match(projectHome, /Archive Project/u);
  assert.match(projectHome, /\/duplicate/u);
  assert.match(projectHome, /Archive Thread/u);
});

test("Workspace setup owns Environment and source selection with rollback", () => {
  const workspaceSetup = readAppSource(
    "app/(workspace)/projects/[id]/workspace/workspace-client.tsx",
  );
  assert.match(workspaceSetup, /Project Environment/u);
  assert.match(
    workspaceSetup,
    /source:[\s\S]*\{ type: "desktop", catalogId: resourceId \}/u,
  );
  assert.match(workspaceSetup, /rollbackProjectEnvironment/u);
  assert.match(
    workspaceSetup,
    /\/api\/projects\/\$\{projectId\}\/environment/u,
  );
});

test("Desktop workspace binding atomically moves the Project Environment", () => {
  const store = readAppSource("lib/environments/store.ts");
  assert.match(
    store,
    /environment\.provider === "desktop" && source\.type === "desktop"/u,
  );
  assert.match(
    store,
    /\.update\(schema\.projects\)[\s\S]*\.set\(\{ environmentId: environment\.id/u,
  );
  assert.match(
    store,
    /existing &&[\s\S]*environment\.provider === "desktop"[\s\S]*await assertProjectHasNoActiveWork\(\)/u,
  );
});

test("Desktop workspace projections are scoped to the Project Environment", () => {
  const projectWorkspaceRoute = readAppSource(
    "app/api/projects/[id]/workspace/route.ts",
  );
  const desktopAccount = readAppSource("lib/desktop-account.ts");

  assert.match(
    projectWorkspaceRoute,
    /listVisibleProjectDesktopWorkspaceCatalog/u,
  );
  assert.match(
    desktopAccount,
    /eq\(\s+schema\.environmentWorkspaces\.environmentId,\s+schema\.projects\.environmentId,\s+\)/u,
  );
});

test("Project Threads can duplicate conversation history without re-metering it", () => {
  const duplicateRoute = readAppSource(
    "app/api/threads/[id]/duplicate/route.ts",
  );

  assert.match(duplicateRoute, /source\?\.access\.canManage/u);
  assert.match(duplicateRoute, /createThreadForUser\(/u);
  assert.match(duplicateRoute, /saveThreadMessages\(/u);
  assert.match(duplicateRoute, /meterUsage: false/u);
});

test("Project skill catalog migration owns tenant-safe canonical state", () => {
  const migration = readAppSource(
    "lib/db/migrations/0044_project_skill_catalog.sql",
  );
  const journal = readAppSource("lib/db/migrations/meta/_journal.json");

  assert.match(migration, /ADD COLUMN "skill_catalog_initialized_at"/u);
  assert.match(migration, /CREATE TABLE "project_skill_installations"/u);
  assert.match(
    migration,
    /FOREIGN KEY \("organization_id", "project_id"\)[\s\S]*REFERENCES "public"\."projects"\("organization_id", "id"\)/u,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "project_skill_installations_source_idx"/u,
  );
  assert.match(migration, /project_skill_installations_status_check/u);
  assert.match(journal, /"tag": "0044_project_skill_catalog"/u);
});

test("Project runs reconcile skills before starting the runtime", () => {
  const runtime = readAppSource("lib/agent/kestrel-runtime.ts");
  const synchronizeIndex = runtime.indexOf("synchronizeProjectSkills({");
  const runIndex = runtime.indexOf("client.streamRun(");

  assert.ok(synchronizeIndex >= 0);
  assert.ok(runIndex > synchronizeIndex);
  assert.match(
    runtime.slice(synchronizeIndex, runIndex),
    /workspaceSkills: projectSkills\.catalog/u,
  );
});

test("Organization changes reload server authority and refresh workspace data", () => {
  const teamSwitcher = readAppSource("components/team-switcher.tsx");
  const workspaceRail = readAppSource("components/workspace-rail.tsx");

  assert.match(
    teamSwitcher,
    /await organization\.setActive\([\s\S]*window\.location\.reload\(\)/u,
  );
  assert.match(
    workspaceRail,
    /previousOrganizationId\.current === organizationId/u,
  );
  assert.match(
    workspaceRail,
    /mutateProjects\(\{ projects: \[\] \}, \{ revalidate: true \}\)/u,
  );
  assert.match(
    workspaceRail,
    /mutateThreads\(undefined, \{ revalidate: true \}\)/u,
  );
  assert.match(
    workspaceRail,
    /mutateThreadDetail\(undefined, \{ revalidate: true \}\)/u,
  );
});

test("Project uploads compensate new documents when context attachment fails", () => {
  const source = readAppSource("app/api/projects/[id]/files/route.ts");

  assert.match(source, /catch \(attachmentError\)/);
  assert.match(
    source,
    /if \(!uploaded\.deduped\)[\s\S]*removeKnowledgeDocument\([\s\S]*throw attachmentError/,
  );
});

test("Project deletion commits metadata before best-effort blob cleanup", () => {
  const source = readAppSource("lib/projects/store.ts");
  const transactionIndex = source.indexOf(
    "const deleted = await knowledgeDb.transaction",
  );
  const cleanupIndex = source.indexOf("cleanupProjectBlobKeys(");

  assert.ok(transactionIndex >= 0);
  assert.ok(cleanupIndex > transactionIndex);
  assert.match(
    source.slice(transactionIndex, cleanupIndex),
    /if \(!deleted\.project\)[\s\S]*try \{[\s\S]*getStorageAdapter\(\)/,
  );
});

test("Project collaborators use canonical Thread access for message actions", () => {
  for (const relativePath of [
    "app/api/messages/[id]/feedback/route.ts",
    "lib/messages/speech.ts",
  ]) {
    const source = readAppSource(relativePath);
    assert.match(source, /getThreadAccessForUser\(/);
    assert.doesNotMatch(source, /createdByUserId/);
  }
});

test("mobile Thread responses pin Project context and Environment before durable dispatch", () => {
  const source = readAppSource("app/api/mobile/v1/threads/[id]/turns/route.ts");
  assert.match(source, /await resolveProjectRuntimeContext\(/);
  assert.match(source, /await resolveThreadEnvironment\(/);
  assert.match(source, /await createDurableThreadTurn\(/);
  assert.match(source, /projectContextRevisionId:[\s\S]*contextRevision\.id/u);
  assert.match(source, /requestedEnvironmentId: environment\.id/u);
  assert.match(source, /await enqueueDurableThreadTurn\(/);
  assert.doesNotMatch(source, /createKestrelOneAgentResponse\(/);
});

test("durable interactions preserve exact request identity through runtime resume", () => {
  const store = readAppSource("lib/turns/store.ts");
  const worker = readAppSource("lib/turns/process-runtime.ts");
  const runtime = readAppSource("lib/agent/kestrel-runtime-core.ts");

  assert.match(store, /requestId: input\.requestId/u);
  assert.match(store, /interaction\.eventType !== input\.eventType/u);
  assert.match(worker, /interactionResponse: turn\.interactionResponse/u);
  assert.match(runtime, /resumeRequestId: interactionResponse\.requestId/u);
  assert.match(runtime, /eventType: interactionResponse\?\.eventType/u);
});

test("durable turn creation never rebinds an existing message ID", () => {
  const source = readAppSource("lib/turns/store.ts");

  assert.match(
    source,
    /\.onConflictDoNothing\(\{ target: schema\.threadMessages\.id \}\)[\s\S]*\.returning\(\{ id: schema\.threadMessages\.id \}\)/u,
  );
  assert.match(
    source,
    /if \(!insertedMessage\) \{[\s\S]*"TURN_CONFLICT"[\s\S]*"The input message ID is already in use\."/u,
  );
  assert.match(
    source,
    /\.update\(schema\.threadMessages\)[\s\S]*eq\(schema\.threadMessages\.id, input\.messageId\)[\s\S]*eq\(schema\.threadMessages\.threadId, input\.threadId\)/u,
  );
});
