import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  projectTabHref,
  resolveProjectTab,
} from "./project-tabs";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function readAppSource(relativePath: string) {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

contractTest("web.hermetic", "Project tabs stay owned by the URL across same-page navigation", () => {
  assert.equal(resolveProjectTab({ tab: "apps", hasGoogle: false }), "apps");
  assert.equal(resolveProjectTab({ tab: "skills", hasGoogle: false }), "skills");
  assert.equal(
    resolveProjectTab({ tab: "context", hasGoogle: false }),
    "context"
  );
  assert.equal(resolveProjectTab({ tab: "unknown", hasGoogle: false }), "overview");
  assert.equal(resolveProjectTab({ tab: null, hasGoogle: true }), "apps");
  assert.equal(projectTabHref("project-1", "overview"), "/projects/project-1");
  assert.equal(
    projectTabHref("project-1", "activity"),
    "/projects/project-1?tab=activity"
  );
  assert.equal(
    projectTabHref("project-1", "skills"),
    "/projects/project-1?tab=skills"
  );
});

contractTest("web.hermetic", "Project skills have a first-class tab separate from Apps and Workspace setup", () => {
  const projectHome = readAppSource(
    "components/projects/project-home-client.tsx"
  );
  const workspaceRail = readAppSource("components/workspace-rail.tsx");
  const projectSkills = readAppSource(
    "components/projects/project-skills.tsx"
  );
  const workspaceSetup = readAppSource(
    "app/(workspace)/projects/[id]/workspace/workspace-client.tsx"
  );

  assert.match(projectHome, /TabsTrigger value="apps">Apps</u);
  assert.match(projectHome, /TabsTrigger value="skills">Skills</u);
  assert.match(
    projectHome,
    /TabsContent value="skills">[\s\S]*<ProjectSkills/u
  );
  assert.match(workspaceRail, /label: "Apps", tab: "apps"/u);
  assert.match(workspaceRail, /label: "Skills", tab: "skills"/u);
  assert.match(projectSkills, /placeholder="https:\/\/github\.com\/org\/skills\.git"/u);
  assert.match(projectSkills, /Advanced source options/u);
  assert.doesNotMatch(workspaceSetup, /Agent skills/u);
});

contractTest("web.hermetic", "Project uploads compensate new documents when context attachment fails", () => {
  const source = readAppSource("app/api/projects/[id]/files/route.ts");

  assert.match(source, /catch \(attachmentError\)/);
  assert.match(
    source,
    /if \(!uploaded\.deduped\)[\s\S]*removeKnowledgeDocument\([\s\S]*throw attachmentError/
  );
});

contractTest("web.hermetic", "Project deletion commits metadata before best-effort blob cleanup", () => {
  const source = readAppSource("lib/projects/store.ts");
  const transactionIndex = source.indexOf(
    "const deleted = await knowledgeDb.transaction"
  );
  const cleanupIndex = source.indexOf("cleanupProjectBlobKeys(");

  assert.ok(transactionIndex >= 0);
  assert.ok(cleanupIndex > transactionIndex);
  assert.match(
    source.slice(transactionIndex, cleanupIndex),
    /if \(!deleted\.project\)[\s\S]*try \{[\s\S]*getStorageAdapter\(\)/
  );
});

contractTest("web.hermetic", "Project collaborators use canonical Thread access for message actions", () => {
  for (const relativePath of [
    "app/api/messages/[id]/feedback/route.ts",
    "lib/messages/speech.ts",
  ]) {
    const source = readAppSource(relativePath);
    assert.match(source, /getThreadAccessForUser\(/);
    assert.doesNotMatch(source, /createdByUserId/);
  }
});

contractTest("web.hermetic", "mobile Thread responses pin Project context and Environment before durable dispatch", () => {
  const source = readAppSource(
    "app/api/mobile/v1/threads/[id]/turns/route.ts"
  );
  assert.match(source, /await resolveProjectRuntimeContext\(/);
  assert.match(source, /await resolveThreadEnvironment\(/);
  assert.match(source, /await createDurableThreadTurn\(/);
  assert.match(source, /projectContextRevisionId:[\s\S]*contextRevision\.id/u);
  assert.match(source, /requestedEnvironmentId: environment\.id/u);
  assert.match(source, /await enqueueDurableThreadTurn\(/);
  assert.doesNotMatch(source, /createKestrelOneAgentResponse\(/);
});

contractTest("web.hermetic", "durable interactions preserve exact request identity through runtime resume", () => {
  const store = readAppSource("lib/turns/store.ts");
  const worker = readAppSource("lib/turns/process-runtime.ts");
  const runtime = readAppSource("lib/agent/kestrel-runtime-core.ts");

  assert.match(store, /requestId: input\.requestId/u);
  assert.match(store, /interaction\.eventType !== input\.eventType/u);
  assert.match(worker, /interactionResponse: turn\.interactionResponse/u);
  assert.match(runtime, /resumeRequestId: interactionResponse\.requestId/u);
  assert.match(runtime, /eventType: interactionResponse\?\.eventType/u);
});

contractTest("web.hermetic", "durable turn creation never rebinds an existing message ID", () => {
  const source = readAppSource("lib/turns/store.ts");

  assert.match(
    source,
    /\.onConflictDoNothing\(\{ target: schema\.threadMessages\.id \}\)[\s\S]*\.returning\(\{ id: schema\.threadMessages\.id \}\)/u
  );
  assert.match(
    source,
    /if \(!insertedMessage\) \{[\s\S]*"TURN_CONFLICT"[\s\S]*"The input message ID is already in use\."/u
  );
  assert.match(
    source,
    /\.update\(schema\.threadMessages\)[\s\S]*eq\(schema\.threadMessages\.id, input\.messageId\)[\s\S]*eq\(schema\.threadMessages\.threadId, input\.threadId\)/u
  );
});
