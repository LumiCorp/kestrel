import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectsRoot = path.dirname(fileURLToPath(import.meta.url));
const componentsRoot = path.resolve(projectsRoot, "..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(componentsRoot, relativePath), "utf8");
}

test("Projects use a compact resource list with meaningful metadata", () => {
  const page = read("../app/(workspace)/projects/page.tsx");
  const source = read("projects/projects-index-client.tsx");

  assert.match(page, /\bPageHeader\b/u);
  assert.match(source, /\bResourceList\b/u);
  assert.match(source, /\bResourceRow\b/u);
  assert.match(source, /\bResourceEmpty\b/u);
  assert.match(source, /Updated <TimeText mode="relative"/u);
  assert.doesNotMatch(source, /No description yet/u);
  assert.doesNotMatch(source, /sm:grid-cols/u);
});

test("Project Overview keeps one primary action and discloses secondary lifecycle controls", () => {
  const source = read("projects/project-home-client.tsx");

  assert.match(source, /\bPageHeader\b/u);
  assert.match(source, /\bResourceList\b/u);
  assert.match(source, /\bResourceRow\b/u);
  assert.match(source, /Context revision/u);
  assert.match(source, /Active Threads/u);
  assert.match(source, /Archived Threads/u);
  assert.match(source, /aria-label="Project actions"/u);
  assert.match(source, /Configure Workspace/u);
  assert.match(source, /Archive Project/u);
  assert.match(source, /Delete Project/u);
  assert.doesNotMatch(source, /id="project-environment"/u);
  assert.doesNotMatch(source, /id="project-desktop-workspace"/u);
  assert.equal(source.match(/> New Thread/g)?.length, 1);
});

test("Workspace rail requests the authoritative Thread scope and distinguishes loading", () => {
  const source = read("workspace-rail.tsx");

  assert.ok(
    source.includes(
      "/api/threads?project_id=${encodeURIComponent(activeProjectId)}&limit=100",
    ),
  );
  assert.match(source, /\/api\/threads\?standalone=true&limit=100/u);
  assert.match(source, /Loading Threads…/u);
  assert.match(source, /role="status"/u);
  assert.match(source, /Threads could not be loaded\./u);
  assert.match(source, /pathname === "\/projects"/u);
  assert.match(source, /routeProjectId \? null : newThreadHref/u);
  assert.doesNotMatch(source, /thread\.projectId === activeProjectId/u);
  assert.doesNotMatch(source, /opacity-0/u);
});

test("Thread mutations revalidate every Workspace rail list scope", () => {
  const chat = read("chatbot/chat.tsx");
  const chatHeader = read("chatbot/chat-header.tsx");

  assert.match(chat, /mutate\(isThreadListCacheKey\)/u);
  assert.match(chatHeader, /mutate\(isThreadListCacheKey\)/u);
  assert.doesNotMatch(chat, /mutate\("\/api\/threads\?limit=/u);
  assert.doesNotMatch(chatHeader, /mutate\("\/api\/threads\?limit=/u);
});

test("Project tabs remain horizontally accessible without a visible scrollbar", () => {
  const source = read("projects/project-home-client.tsx");

  assert.match(
    source,
    /no-visible-scrollbar overflow-x-auto border-b pb-4 md:hidden/u,
  );
});

test("Schedules live in primary navigation under Work instead of Project tabs", () => {
  const navigation = read("nav-main.tsx");
  const schedules = read("schedules/schedules-client.tsx");
  const projectTabs = read("../lib/projects/project-tabs.ts");

  assert.ok(navigation.indexOf('title: "Schedules"') > navigation.indexOf('title: "Work"'));
  assert.match(navigation, /title: "Schedules",[\s\S]*url: "\/schedules"/u);
  assert.doesNotMatch(projectTabs, /"schedule"/u);
  assert.match(schedules, /eyebrow="Work"/u);
  assert.match(schedules, /title="Schedules"/u);
  assert.match(schedules, /New schedule/u);
  assert.match(schedules, /No schedules yet/u);
  assert.match(schedules, /Next run:/u);
  assert.match(schedules, /aria-describedby="schedule-next-run"/u);
  assert.match(schedules, /schedule\.permissions\.canEdit/u);
  assert.match(schedules, /schedule\.permissions\.canPause/u);
  assert.match(schedules, /schedule\.permissions\.canDelete/u);
  assert.match(schedules, /aria-label="Latest run failure"/u);
});

test("Project Workspace uses the standard page heading", () => {
  const source = read("../app/(workspace)/projects/[id]/workspace/workspace-client.tsx");

  assert.match(source, /\bPageHeader\b/u);
  assert.match(source, /title="Project Workspace"/u);
  assert.doesNotMatch(source, /\bCardTitle\b/u);
});
