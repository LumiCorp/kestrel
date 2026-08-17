import type { DesktopRuntimeThreadInspection } from "../../src/contracts";
import type { DesktopThreadFeedback } from "./feedbackState";
import type { RendererThread } from "./state";

export type DesktopThreadNavigationStatus =
  | "waiting"
  | "failed"
  | "unavailable"
  | "running"
  | "idle";

export interface DesktopThreadNavigationState {
  thread: RendererThread;
  status: DesktopThreadNavigationStatus;
  activity: string;
  updatedAt: string;
}

export interface DesktopProjectNavigationSummary {
  total: number;
  running: number;
  waiting: number;
  failed: number;
  unavailable: number;
}

export interface DesktopWorkNavigatorGroup {
  key: string;
  label: string;
  kind: "project" | "no-project" | "unavailable-project";
  projectPath?: string | undefined;
  status: DesktopThreadNavigationStatus;
  latestUpdatedAt: string;
  summary: DesktopProjectNavigationSummary;
  threads: DesktopThreadNavigationState[];
}

export interface DesktopWorkNavigatorProjection {
  groups: DesktopWorkNavigatorGroup[];
}

export function resolveDesktopSelectedProjectPath(input: {
  projects: readonly { path: string }[];
  storedProjectPath?: string | undefined;
  activeThreadProjectPath?: string | undefined;
  defaultProjectPath?: string | undefined;
}): string | undefined {
  const registered = new Set(input.projects.map((project) => project.path));
  return [input.storedProjectPath, input.activeThreadProjectPath, input.defaultProjectPath]
    .find((candidate): candidate is string => candidate !== undefined && registered.has(candidate))
    ?? input.projects[0]?.path;
}

export function isDesktopThreadProjectUnavailable(
  thread: Pick<RendererThread, "projectPath">,
  projects: readonly { path: string }[],
): boolean {
  return thread.projectPath !== undefined &&
    !projects.some((project) => project.path === thread.projectPath);
}

const STATUS_PRIORITY: Record<DesktopThreadNavigationStatus, number> = {
  waiting: 0,
  failed: 1,
  unavailable: 2,
  running: 3,
  idle: 4,
};

export function resolveDesktopThreadNavigationStates(input: {
  threads: readonly RendererThread[];
  threadViews: Readonly<Record<string, DesktopRuntimeThreadInspection>>;
  activeRuns: Readonly<Record<string, unknown>>;
  authorityStatuses: Readonly<Record<string, "available" | "missing">>;
  feedback: Readonly<Record<string, DesktopThreadFeedback>>;
}): Record<string, DesktopThreadNavigationState> {
  return Object.fromEntries(input.threads.map((thread) => {
    const view = input.threadViews[thread.id];
    const feedback = input.feedback[thread.id];
    let status: DesktopThreadNavigationStatus;
    if (view?.activeRun?.status === "WAITING" || view?.thread.status === "WAITING" || thread.pendingWaitEventType !== undefined) {
      status = "waiting";
    } else if (view?.thread.status === "FAILED") {
      status = "failed";
    } else if (input.authorityStatuses[thread.id] === "missing") {
      status = "unavailable";
    } else if (input.activeRuns[thread.id] !== undefined || view?.activeRun?.status === "RUNNING" || view?.thread.status === "RUNNING") {
      status = "running";
    } else {
      status = "idle";
    }

    const activity = status === "waiting"
      ? view?.blocker?.summary ?? view?.nextAction?.summary ?? "Waiting for input"
      : status === "failed"
        ? feedback?.error ?? "Run failed"
        : status === "unavailable"
          ? "Thread authority unavailable"
          : status === "running"
            ? runningActivity(view, feedback)
            : "Idle";
    return [thread.id, {
      thread,
      status,
      activity,
      updatedAt: latestTimestamp(thread.updatedAt, feedback?.activityUpdatedAt),
    }];
  }));
}

export function projectDesktopWorkNavigator(input: {
  threads: readonly RendererThread[];
  projects: readonly { path: string; label: string }[];
  navigation: Readonly<Record<string, DesktopThreadNavigationState>>;
  archived: boolean;
  query?: string | undefined;
}): DesktopWorkNavigatorProjection {
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const projectByPath = new Map(input.projects.map((project, index) => [project.path, { ...project, index }]));
  const matchingThreads = input.threads.filter((thread) => (thread.archivedAt !== undefined) === input.archived);
  const registered = input.projects.flatMap((project, projectIndex) => {
    const projectMatches = project.label.toLocaleLowerCase().includes(query);
    const threads = matchingThreads
      .filter((thread) => thread.projectPath === project.path)
      .filter((thread) => query.length === 0 || projectMatches || thread.title.toLocaleLowerCase().includes(query))
      .map((thread) => input.navigation[thread.id] ?? fallbackNavigation(thread))
      .sort(compareThreads);
    if (input.archived && threads.length === 0) return [];
    if (query.length > 0 && !projectMatches && threads.length === 0) return [];
    return [{ group: createGroup(`project:${project.path}`, project.label, "project", threads, project.path), projectIndex }];
  });

  if (!input.archived) {
    registered.sort((left, right) => compareGroups(left.group, right.group) || left.projectIndex - right.projectIndex);
  } else {
    registered.sort((left, right) => compareGroupRecency(left.group, right.group));
  }

  const groups = registered.map((entry) => entry.group);
  const noProject = specialGroup({
    key: "no-project",
    label: "No project",
    kind: "no-project",
    threads: matchingThreads.filter((thread) => thread.projectPath === undefined),
    navigation: input.navigation,
    query,
  });
  if (noProject !== undefined) groups.push(noProject);

  const unavailable = specialGroup({
    key: "unavailable-project",
    label: "Unavailable project",
    kind: "unavailable-project",
    threads: matchingThreads.filter((thread) => thread.projectPath !== undefined && !projectByPath.has(thread.projectPath)),
    navigation: input.navigation,
    query,
  });
  if (unavailable !== undefined) groups.push(unavailable);
  return { groups };
}

function runningActivity(
  view: DesktopRuntimeThreadInspection | undefined,
  feedback: DesktopThreadFeedback | undefined,
): string {
  if (feedback?.activity !== undefined && feedback.activity !== "Ready") return feedback.activity;
  return view?.runtimePlan?.currentChunk
    ?? view?.runtimePlan?.phase
    ?? view?.operatorPhase
    ?? "Working";
}

function fallbackNavigation(thread: RendererThread): DesktopThreadNavigationState {
  return { thread, status: "idle", activity: "Idle", updatedAt: thread.updatedAt };
}

function createGroup(
  key: string,
  label: string,
  kind: DesktopWorkNavigatorGroup["kind"],
  threads: DesktopThreadNavigationState[],
  projectPath?: string,
): DesktopWorkNavigatorGroup {
  const summary = summarize(threads);
  return {
    key,
    label,
    kind,
    ...(projectPath !== undefined ? { projectPath } : {}),
    status: threads[0]?.status ?? "idle",
    latestUpdatedAt: threads.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, ""),
    summary,
    threads,
  };
}

function specialGroup(input: {
  key: string;
  label: string;
  kind: "no-project" | "unavailable-project";
  threads: RendererThread[];
  navigation: Readonly<Record<string, DesktopThreadNavigationState>>;
  query: string;
}): DesktopWorkNavigatorGroup | undefined {
  const labelMatches = input.label.toLocaleLowerCase().includes(input.query);
  const threads = input.threads
    .filter((thread) => input.query.length === 0 || labelMatches || thread.title.toLocaleLowerCase().includes(input.query))
    .map((thread) => {
      const navigation = input.navigation[thread.id] ?? fallbackNavigation(thread);
      return input.kind === "unavailable-project"
        ? {
            ...navigation,
            status: "unavailable" as const,
            activity: "Project is no longer registered",
          }
        : navigation;
    })
    .sort(compareThreads);
  return threads.length === 0 ? undefined : createGroup(input.key, input.label, input.kind, threads);
}

function summarize(threads: readonly DesktopThreadNavigationState[]): DesktopProjectNavigationSummary {
  return {
    total: threads.length,
    running: threads.filter((entry) => entry.status === "running").length,
    waiting: threads.filter((entry) => entry.status === "waiting").length,
    failed: threads.filter((entry) => entry.status === "failed").length,
    unavailable: threads.filter((entry) => entry.status === "unavailable").length,
  };
}

function compareThreads(left: DesktopThreadNavigationState, right: DesktopThreadNavigationState): number {
  return STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status]
    || right.updatedAt.localeCompare(left.updatedAt);
}

function compareGroups(left: DesktopWorkNavigatorGroup, right: DesktopWorkNavigatorGroup): number {
  return STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status]
    || compareGroupRecency(left, right);
}

function compareGroupRecency(left: DesktopWorkNavigatorGroup, right: DesktopWorkNavigatorGroup): number {
  return right.latestUpdatedAt.localeCompare(left.latestUpdatedAt);
}

function latestTimestamp(persistedAt: string, liveAt: string | undefined): string {
  return liveAt !== undefined && liveAt > persistedAt ? liveAt : persistedAt;
}
