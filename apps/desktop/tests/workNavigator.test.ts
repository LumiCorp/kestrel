import assert from "node:assert/strict";
import test from "node:test";

import { createRendererThread } from "../renderer/src/state.js";
import {
  isDesktopThreadProjectUnavailable,
  projectDesktopWorkNavigator,
  resolveDesktopSelectedProjectPath,
  resolveDesktopThreadNavigationStates,
} from "../renderer/src/workNavigator.js";

function thread(id: string, projectPath: string | undefined, updatedAt: string) {
  return {
    ...createRendererThread({ ...(projectPath === undefined ? {} : { projectPath }) }),
    id,
    title: id,
    updatedAt,
  };
}

test("work navigator resolves authoritative status and activity", () => {
  const threads = [
    thread("waiting", "/a", "2026-08-13T10:00:00.000Z"),
    thread("failed", "/a", "2026-08-13T11:00:00.000Z"),
    thread("running", "/a", "2026-08-13T12:00:00.000Z"),
    thread("missing", "/a", "2026-08-13T13:00:00.000Z"),
  ];
  const view = (status: "WAITING" | "FAILED" | "RUNNING", extra: Record<string, unknown> = {}) => ({
    thread: { status },
    childThreads: [],
    conversationTurns: [],
    followUpQueue: { state: "ready", items: [] },
    inboxItems: [],
    ...extra,
  });
  const navigation = resolveDesktopThreadNavigationStates({
    threads,
    threadViews: {
      waiting: view("WAITING", { blocker: { summary: "Approve deployment" } }),
      failed: view("FAILED"),
      running: view("RUNNING", { runtimePlan: { currentChunk: "Running tests" } }),
    } as never,
    activeRuns: { running: {} },
    authorityStatuses: { waiting: "available", failed: "available", running: "available", missing: "missing" },
    feedback: {},
  });
  assert.equal(navigation.waiting?.activity, "Approve deployment");
  assert.equal(navigation.failed?.status, "failed");
  assert.equal(navigation.running?.activity, "Running tests");
  assert.equal(navigation.missing?.status, "unavailable");
});

test("work navigator includes empty projects and sorts projects and threads by attention then recency", () => {
  const projects = [
    { path: "/empty", label: "Empty" },
    { path: "/active", label: "Active" },
    { path: "/attention", label: "Attention" },
  ];
  const threads = [
    thread("idle", "/active", "2026-08-13T14:00:00.000Z"),
    thread("running-new", "/active", "2026-08-13T13:00:00.000Z"),
    thread("running-old", "/active", "2026-08-13T12:00:00.000Z"),
    thread("waiting", "/attention", "2026-08-13T11:00:00.000Z"),
  ];
  const navigation = Object.fromEntries(threads.map((entry) => [entry.id, {
    thread: entry,
    status: entry.id === "waiting" ? "waiting" : entry.id.startsWith("running") ? "running" : "idle",
    activity: "state",
    updatedAt: entry.updatedAt,
  }])) as never;
  const projection = projectDesktopWorkNavigator({ threads, projects, navigation, archived: false });
  assert.deepEqual(projection.groups.map((group) => group.label), ["Attention", "Active", "Empty"]);
  assert.deepEqual(projection.groups[1]?.threads.map((entry) => entry.thread.id), ["running-new", "running-old", "idle"]);
});

test("work navigator searches project and thread names and isolates unavailable paths", () => {
  const threads = [
    { ...thread("alpha-thread", "/a", "2026-08-13T12:00:00.000Z"), title: "Implement auth" },
    { ...thread("legacy", "/removed", "2026-08-13T13:00:00.000Z"), title: "Legacy work" },
  ];
  const navigation = Object.fromEntries(threads.map((entry) => [entry.id, { thread: entry, status: "idle", activity: "Idle", updatedAt: entry.updatedAt }])) as never;
  const projects = [{ path: "/a", label: "Alpha project" }, { path: "/empty", label: "Empty project" }];
  assert.deepEqual(
    projectDesktopWorkNavigator({ threads, projects, navigation, archived: false, query: "alpha" }).groups.map((group) => group.label),
    ["Alpha project"],
  );
  assert.deepEqual(
    projectDesktopWorkNavigator({ threads, projects, navigation, archived: false, query: "auth" }).groups[0]?.threads.map((entry) => entry.thread.id),
    ["alpha-thread"],
  );
  assert.equal(projectDesktopWorkNavigator({ threads, projects, navigation, archived: false }).groups.at(-1)?.kind, "unavailable-project");
  assert.equal(projectDesktopWorkNavigator({ threads, projects, navigation, archived: false }).groups.at(-1)?.threads[0]?.status, "unavailable");
  assert.equal(projectDesktopWorkNavigator({ threads, projects, navigation, archived: false }).groups.at(-1)?.threads[0]?.activity, "Project is no longer registered");
  assert.equal(isDesktopThreadProjectUnavailable(threads[1]!, projects), true);
  assert.equal(isDesktopThreadProjectUnavailable(threads[0]!, projects), false);
});

test("work navigator handles more than twenty concurrent threads without dropping groups", () => {
  const projects = Array.from({ length: 4 }, (_, index) => ({ path: `/project/${index}`, label: `Project ${index}` }));
  const threads = Array.from({ length: 24 }, (_, index) => thread(`thread-${index}`, projects[index % projects.length]!.path, `2026-08-13T12:${String(index).padStart(2, "0")}:00.000Z`));
  const navigation = Object.fromEntries(threads.map((entry, index) => [entry.id, {
    thread: entry,
    status: index < 8 ? "running" : "idle",
    activity: index < 8 ? "Working" : "Idle",
    updatedAt: entry.updatedAt,
  }])) as never;
  const projection = projectDesktopWorkNavigator({ threads, projects, navigation, archived: false });
  assert.equal(projection.groups.length, 4);
  assert.equal(projection.groups.flatMap((group) => group.threads).length, 24);
});

test("selected project restoration rejects removed projects and follows explicit fallbacks", () => {
  const projects = [{ path: "/active" }, { path: "/default" }];
  assert.equal(resolveDesktopSelectedProjectPath({ projects, storedProjectPath: "/removed", activeThreadProjectPath: "/active", defaultProjectPath: "/default" }), "/active");
  assert.equal(resolveDesktopSelectedProjectPath({ projects, storedProjectPath: "/default", activeThreadProjectPath: "/active" }), "/default");
  assert.equal(resolveDesktopSelectedProjectPath({ projects: [] }), undefined);
});

test("live runner activity advances thread and project recency", () => {
  const olderPersisted = thread("live", "/live", "2026-08-13T10:00:00.000Z");
  const newerPersisted = thread("quiet", "/quiet", "2026-08-13T11:00:00.000Z");
  const navigation = resolveDesktopThreadNavigationStates({
    threads: [olderPersisted, newerPersisted],
    threadViews: {},
    activeRuns: { live: {}, quiet: {} },
    authorityStatuses: { live: "available", quiet: "available" },
    feedback: {
      live: { activity: "Running tests", activityUpdatedAt: "2026-08-13T12:00:00.000Z" },
      quiet: { activity: "Working" },
    },
  });
  const projection = projectDesktopWorkNavigator({
    threads: [olderPersisted, newerPersisted],
    projects: [{ path: "/quiet", label: "Quiet" }, { path: "/live", label: "Live" }],
    navigation,
    archived: false,
  });
  assert.equal(navigation.live?.updatedAt, "2026-08-13T12:00:00.000Z");
  assert.deepEqual(projection.groups.map((group) => group.label), ["Live", "Quiet"]);
});
