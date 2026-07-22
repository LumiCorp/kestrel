import type {
  DesktopExecutionSelection,
  DesktopLegacyUiStateEntries,
  DesktopRunHistoryLine,
  DesktopRunnerEvent,
  DesktopUiStateV1,
  RunTurnAttachment,
} from "../../src/contracts";
import { extractWaitPrompt } from "../../../../src/runtime/waitForPrompt";
import {
  DESKTOP_DEFAULT_ENABLED_APP_IDS,
  normalizeDesktopAppId,
} from "../../../../src/desktopShell/configuration";

const THREADS_STORAGE_KEY = "kchat:web:threads:v2";
const ACTIVE_THREAD_STORAGE_KEY = "kchat:web:active-thread:v1";
const THEME_STORAGE_KEY = "kchat:web:theme-mode";
const INTERACTION_STATE_STORAGE_KEY = "kestrel:desktop-interaction-state:v1";
const LEGACY_DRAFTS_STORAGE_KEY = "kchat:web:composer-drafts:v1";
const LEGACY_HISTORY_STORAGE_KEY = "kchat:web:prompt-history:v1";
export const MAX_PROMPT_HISTORY = 100;
export const MAX_RENDERER_THREAD_TITLE_LENGTH = 54;
export const MAX_PERSISTED_TRANSCRIPT_BYTES = 6 * 1024 * 1024;
export const MAX_PERSISTED_TRANSCRIPT_LINES_PER_THREAD = 500;
const MAX_PERSISTED_TRANSCRIPT_LINE_TEXT_BYTES = 64 * 1024;

export type RendererTheme = "system" | "light" | "dark";
export type RendererMode = "chat" | "plan" | "build";
export type RendererWorkspaceMode = "local" | "managed";
export type RendererDiffScopeKind =
  | "unstaged"
  | "staged"
  | "uncommitted"
  | "branch"
  | "commit"
  | "pull_request"
  | "latest_run"
  | "latest_turn"
  | "promotion";

export interface RendererTranscriptLine {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  data?: unknown;
  attachments?: RunTurnAttachment[] | undefined;
  dialog?: {
    messageId: string;
    dialogId: string;
    name: string;
    childSessionId: string;
    sender: "kestrel" | "collaborator" | "system";
    status?: "failed" | "cancelled" | undefined;
  } | undefined;
}

export interface RendererThread {
  id: string;
  title: string;
  sessionId: string;
  projectPath?: string | undefined;
  archivedAt?: string | undefined;
  titleLocked?: boolean | undefined;
  updatedAt: string;
  transcript: RendererTranscriptLine[];
  pendingWaitEventType?: string | undefined;
  mode: RendererMode;
  workspaceMode: RendererWorkspaceMode;
  workspaceBaseRef: string;
  workspaceSetupIgnoredFiles: string;
  workspaceSetupExecutable: string;
  workspaceSetupArgs: string;
  openFiles: string[];
  diffScopeKind: RendererDiffScopeKind;
  diffRevision: string;
  diffView: "unified" | "side-by-side";
  draft: string;
  draftAttachmentIds: string[];
  promptHistory: string[];
  modelConfigurationId: string;
  modelConfigurationRevision: number;
  enabledAppIds: string[];
  rawSummary: Record<string, unknown>;
  rawState: Record<string, unknown>;
}

export interface RendererThreadGroup {
  key: string;
  label: string;
  projectPath?: string | undefined;
  kind: "project" | "no-project" | "unavailable-project";
  threads: RendererThread[];
}

export interface DesktopRendererState {
  entries: DesktopLegacyUiStateEntries;
  activeThreadId: string;
  threads: RendererThread[];
  theme: RendererTheme;
}

export function readDesktopRendererState(
  uiState: DesktopUiStateV1 | null,
  defaults: {
    modelConfigurationId?: string | undefined;
    modelConfigurationRevision?: number | undefined;
    enabledAppIds?: string[] | undefined;
    theme?: RendererTheme | undefined;
  } = {},
): DesktopRendererState {
  const entries = { ...(uiState?.entries ?? {}) };
  const store = parseThreadStore(entries[THREADS_STORAGE_KEY]);
  const interactionState = parseInteractionState(entries[INTERACTION_STATE_STORAGE_KEY]);
  const legacyDrafts = parseLegacyStringMap(entries[LEGACY_DRAFTS_STORAGE_KEY]);
  const legacyHistory = parseLegacyHistory(entries[LEGACY_HISTORY_STORAGE_KEY]);
  const threads = collectThreads(store, defaults).map((thread) => {
    const interaction = interactionState[thread.id] ?? interactionState[thread.sessionId];
    return {
      ...thread,
      draft: interaction?.draft ?? legacyDrafts[thread.id] ?? legacyDrafts[thread.sessionId] ?? "",
      draftAttachmentIds: interaction?.attachmentIds ?? [],
      promptHistory: interaction?.promptHistory ?? legacyHistory[thread.id] ?? legacyHistory[thread.sessionId] ?? [],
    };
  });
  const normalizedThreads = threads.length > 0 ? threads : [createRendererThread(defaults)];
  const requestedActive = entries[ACTIVE_THREAD_STORAGE_KEY];
  const activeThreadId = normalizedThreads.some(
    (thread) => thread.id === requestedActive,
  )
    ? requestedActive!
    : normalizedThreads[0]!.id;
  return {
    entries,
    activeThreadId,
    threads: normalizedThreads,
    theme: defaults.theme
      ?? (entries[THEME_STORAGE_KEY] === "dark" || entries[THEME_STORAGE_KEY] === "light"
        ? entries[THEME_STORAGE_KEY]
        : "system"),
  };
}

export function createRendererThread(input: {
  projectPath?: string | undefined;
  modelConfigurationId?: string | undefined;
  modelConfigurationRevision?: number | undefined;
  enabledAppIds?: string[] | undefined;
} = {}): RendererThread {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    id,
    title: "New conversation",
    sessionId: crypto.randomUUID(),
    ...(input.projectPath !== undefined
      ? { projectPath: input.projectPath }
      : {}),
    updatedAt: now,
    transcript: [],
    mode: "build",
    workspaceMode: "local",
    workspaceBaseRef: "HEAD",
    workspaceSetupIgnoredFiles: "",
    workspaceSetupExecutable: "",
    workspaceSetupArgs: "",
    openFiles: [],
    diffScopeKind: "uncommitted",
    diffRevision: "",
    diffView: "unified",
    draft: "",
    draftAttachmentIds: [],
    promptHistory: [],
    modelConfigurationId: input.modelConfigurationId ?? "desktop-default",
    modelConfigurationRevision: input.modelConfigurationRevision ?? 1,
    enabledAppIds: [
      ...new Set(
        (input.enabledAppIds ?? DESKTOP_DEFAULT_ENABLED_APP_IDS).map(normalizeDesktopAppId),
      ),
    ],
    rawSummary: {},
    rawState: {},
  };
}

export function appendRendererTranscript(
  state: DesktopRendererState,
  threadId: string,
  line: RendererTranscriptLine,
): DesktopRendererState {
  return updateRendererThread(state, threadId, (thread) => {
    if (line.dialog !== undefined && thread.transcript.some((item) => item.dialog?.messageId === line.dialog?.messageId)) {
      return thread;
    }
    const firstUserText =
      line.role === "user" &&
      thread.transcript.every((item) => item.role !== "user")
        ? line.text.trim()
        : undefined;
    return {
      ...thread,
      title:
        firstUserText === undefined || thread.titleLocked === true
          ? thread.title
          : normalizeRendererThreadTitle(firstUserText),
      updatedAt: line.timestamp,
      transcript: [...thread.transcript, line],
    };
  });
}

export function updateRendererThread(
  state: DesktopRendererState,
  threadId: string,
  update: (thread: RendererThread) => RendererThread,
): DesktopRendererState {
  return {
    ...state,
    threads: state.threads.map((thread) =>
      thread.id === threadId ? update(thread) : thread,
    ),
  };
}

export function addRendererThread(
  state: DesktopRendererState,
  input: Parameters<typeof createRendererThread>[0] = {},
): DesktopRendererState {
  const thread = createRendererThread(input);
  return {
    ...state,
    activeThreadId: thread.id,
    threads: [thread, ...state.threads],
  };
}

export function selectRendererThread(
  state: DesktopRendererState,
  threadId: string,
): DesktopRendererState {
  return state.threads.some((thread) => thread.id === threadId)
    ? { ...state, activeThreadId: threadId }
    : state;
}

export function renameRendererThread(
  state: DesktopRendererState,
  threadId: string,
  title: string,
): DesktopRendererState {
  const normalizedTitle = normalizeRendererThreadTitle(title);
  if (normalizedTitle.length === 0) return state;
  return updateRendererThread(state, threadId, (thread) => ({
    ...thread,
    title: normalizedTitle,
    titleLocked: true,
  }));
}

export function archiveRendererThread(
  state: DesktopRendererState,
  threadId: string,
  input: Parameters<typeof createRendererThread>[0] = {},
  archivedAt = new Date().toISOString(),
): DesktopRendererState {
  const archivedThread = state.threads.find((thread) => thread.id === threadId);
  if (archivedThread === undefined || archivedThread.archivedAt !== undefined) return state;
  const threads = state.threads.map((thread) => thread.id === threadId
    ? { ...thread, archivedAt }
    : thread);
  if (state.activeThreadId !== threadId) return { ...state, threads };
  const nextActive = threads
    .filter((thread) => thread.archivedAt === undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (nextActive !== undefined) {
    return { ...state, activeThreadId: nextActive.id, threads };
  }
  const replacement = createRendererThread({
    ...input,
    ...(archivedThread.projectPath !== undefined
      ? { projectPath: archivedThread.projectPath }
      : {}),
  });
  return { ...state, activeThreadId: replacement.id, threads: [replacement, ...threads] };
}

export function restoreRendererThread(
  state: DesktopRendererState,
  threadId: string,
  select = true,
): DesktopRendererState {
  if (!state.threads.some((thread) => thread.id === threadId && thread.archivedAt !== undefined)) return state;
  return {
    ...state,
    ...(select ? { activeThreadId: threadId } : {}),
    threads: state.threads.map((thread) => thread.id === threadId
      ? { ...thread, archivedAt: undefined }
      : thread),
  };
}

export function undoArchiveRendererThread(
  state: DesktopRendererState,
  threadId: string,
  removeReplacement = false,
): DesktopRendererState {
  const archived = state.threads.find((thread) => thread.id === threadId);
  if (archived?.archivedAt === undefined) return state;
  const replacement = state.threads.find((thread) => thread.id === state.activeThreadId);
  const canRemoveReplacement = removeReplacement
    && replacement !== undefined
    && replacement.id !== threadId
    && replacement.archivedAt === undefined
    && replacement.transcript.length === 0
    && replacement.draft.trim().length === 0
    && replacement.pendingWaitEventType === undefined
    && replacement.projectPath === archived.projectPath;
  return {
    ...state,
    activeThreadId: threadId,
    threads: state.threads
      .filter((thread) => !canRemoveReplacement || thread.id !== replacement?.id)
      .map((thread) => thread.id === threadId ? { ...thread, archivedAt: undefined } : thread),
  };
}

export function isRendererThreadProjectLocked(
  thread: Pick<RendererThread, "transcript">,
  hasAuthoritativeWorkspace = false,
): boolean {
  return hasAuthoritativeWorkspace || thread.transcript.some((line) => line.role === "user");
}

export function getRendererThreadArchiveBlockReason(
  thread: Pick<RendererThread, "pendingWaitEventType">,
  input: { runActive: boolean; runtimeWaiting?: boolean | undefined; actionableOperatorRequest: boolean },
): string | undefined {
  if (input.runActive) return "Stop the running work before archiving this conversation.";
  if (thread.pendingWaitEventType !== undefined || input.runtimeWaiting === true) return "Resolve the pending wait before archiving this conversation.";
  if (input.actionableOperatorRequest) return "Resolve the pending operator request before archiving this conversation.";
  return undefined;
}

export function groupRendererThreads(input: {
  threads: readonly RendererThread[];
  projects: readonly { path: string; label: string }[];
  archived: boolean;
  query?: string | undefined;
}): RendererThreadGroup[] {
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const projectByPath = new Map(input.projects.map((project) => [project.path, project]));
  const matching = input.threads
    .filter((thread) => (thread.archivedAt !== undefined) === input.archived)
    .filter((thread) => {
      if (query.length === 0) return true;
      const projectLabel = thread.projectPath === undefined
        ? "No project"
        : (projectByPath.get(thread.projectPath)?.label ?? "Unavailable project");
      return thread.title.toLocaleLowerCase().includes(query)
        || projectLabel.toLocaleLowerCase().includes(query);
    });
  const byPath = new Map<string, RendererThread[]>();
  const noProject: RendererThread[] = [];
  const unavailable: RendererThread[] = [];
  for (const thread of matching) {
    if (thread.projectPath === undefined) noProject.push(thread);
    else if (projectByPath.has(thread.projectPath)) {
      const entries = byPath.get(thread.projectPath) ?? [];
      entries.push(thread);
      byPath.set(thread.projectPath, entries);
    } else unavailable.push(thread);
  }
  const sortThreads = (threads: RendererThread[]) =>
    threads.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const registered = input.projects.flatMap<RendererThreadGroup>((project) => {
    const threads = byPath.get(project.path);
    return threads === undefined || threads.length === 0 ? [] : [{
      key: `project:${project.path}`,
      label: project.label,
      projectPath: project.path,
      kind: "project",
      threads: sortThreads(threads),
    }];
  }).sort((left, right) => right.threads[0]!.updatedAt.localeCompare(left.threads[0]!.updatedAt));
  if (noProject.length > 0) registered.push({
    key: "no-project",
    label: "No project",
    kind: "no-project",
    threads: sortThreads(noProject),
  });
  if (unavailable.length > 0) registered.push({
    key: "unavailable-project",
    label: "Unavailable project",
    kind: "unavailable-project",
    threads: sortThreads(unavailable),
  });
  return registered;
}

export function normalizeRendererThreadTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > MAX_RENDERER_THREAD_TITLE_LENGTH
    ? `${trimmed.slice(0, MAX_RENDERER_THREAD_TITLE_LENGTH - 3)}...`
    : trimmed;
}

export function updateRendererDraft(
  state: DesktopRendererState,
  threadId: string,
  draft: string,
): DesktopRendererState {
  return updateRendererThread(state, threadId, (thread) => ({ ...thread, draft }));
}

export function updateRendererDraftAttachments(
  state: DesktopRendererState,
  threadId: string,
  attachmentIds: string[],
): DesktopRendererState {
  return updateRendererThread(state, threadId, (thread) => ({ ...thread, draftAttachmentIds: attachmentIds }));
}

export function addRendererDraftAttachment(
  state: DesktopRendererState,
  threadId: string,
  input: { attachmentId: string; generatedDraft?: string | undefined; replaceDraft?: boolean | undefined },
): DesktopRendererState {
  return updateRendererThread(state, threadId, (thread) => {
    if (thread.draftAttachmentIds.includes(input.attachmentId) || thread.draftAttachmentIds.length >= 8) return thread;
    return {
      ...thread,
      draftAttachmentIds: [...thread.draftAttachmentIds, input.attachmentId],
      draft: input.generatedDraft === undefined
        ? thread.draft
        : input.replaceDraft === true || thread.draft.trim().length === 0
          ? input.generatedDraft
          : thread.draft,
    };
  });
}

export function acceptRendererPrompt(
  state: DesktopRendererState,
  threadId: string,
  prompt: string,
): DesktopRendererState {
  return updateRendererThread(state, threadId, (thread) => {
    const trimmed = prompt.trim();
    const history = thread.promptHistory.at(-1) === trimmed
      ? thread.promptHistory
      : [...thread.promptHistory, trimmed].slice(-MAX_PROMPT_HISTORY);
    return { ...thread, draft: "", draftAttachmentIds: [], promptHistory: history };
  });
}

export function resolveRendererThreadProjectPath(input: {
  thread: Pick<RendererThread, "projectPath">;
  authoritativeProjectPath?: string | undefined;
}): string | undefined {
  return input.authoritativeProjectPath ?? input.thread.projectPath;
}

export function setRendererTheme(
  state: DesktopRendererState,
  theme: RendererTheme,
): DesktopRendererState {
  return { ...state, theme };
}

export function serializeDesktopRendererState(
  state: DesktopRendererState,
): DesktopLegacyUiStateEntries {
  const persistedTranscripts = compactTranscriptsForPersistence(state.threads);
  const summaries = state.threads.map((thread) => ({
    ...thread.rawSummary,
    id: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
    ...(thread.archivedAt !== undefined
      ? { archivedAt: thread.archivedAt }
      : { archivedAt: undefined }),
    ...(thread.titleLocked === true
      ? { titleLocked: true }
      : { titleLocked: undefined }),
    createdAt:
      typeof thread.rawSummary.createdAt === "string"
        ? thread.rawSummary.createdAt
        : thread.updatedAt,
    lastPreview: thread.transcript.at(-1)?.text.slice(0, 160) ?? "",
  }));
  const states = Object.fromEntries(
    state.threads.map((thread) => [
      thread.id,
      {
        ...thread.rawState,
        sessionId: thread.sessionId,
        ...(thread.projectPath !== undefined
          ? { projectPath: thread.projectPath }
          : { projectPath: undefined }),
        transcript: persistedTranscripts.get(thread.id) ?? [],
        ...(thread.pendingWaitEventType !== undefined
          ? { pendingWaitEventType: thread.pendingWaitEventType }
          : { pendingWaitEventType: undefined }),
        interactionMode: thread.mode,
        workspaceMode: thread.workspaceMode,
        workspaceBaseRef: thread.workspaceBaseRef,
        workspaceSetupIgnoredFiles: thread.workspaceSetupIgnoredFiles,
        workspaceSetupExecutable: thread.workspaceSetupExecutable,
        workspaceSetupArgs: thread.workspaceSetupArgs,
        openFiles: thread.openFiles.slice(-20),
        diffScopeKind: thread.diffScopeKind,
        diffRevision: thread.diffRevision,
        diffView: thread.diffView,
        modelConfigurationId: thread.modelConfigurationId,
        modelConfigurationRevision: thread.modelConfigurationRevision,
        enabledAppIds: [...thread.enabledAppIds],
        ...(thread.mode === "build"
          ? { actSubmode: "safe" }
          : { actSubmode: undefined }),
      },
    ]),
  );
  return {
    ...state.entries,
    [THREADS_STORAGE_KEY]: JSON.stringify({ summaries, states }),
    [ACTIVE_THREAD_STORAGE_KEY]: state.activeThreadId,
    [THEME_STORAGE_KEY]: state.theme,
    [INTERACTION_STATE_STORAGE_KEY]: JSON.stringify({
      version: "desktop-interaction-state-v1",
      threads: Object.fromEntries(state.threads.map((thread) => [thread.id, {
        draft: thread.draft,
        attachmentIds: thread.draftAttachmentIds,
        promptHistory: thread.promptHistory.slice(-MAX_PROMPT_HISTORY),
      }])),
    }),
  };
}

export function toDesktopExecutionSelection(
  thread: RendererThread,
  apps: readonly { id: string; contractVersion: number }[],
): DesktopExecutionSelection {
  const enabled = new Set(thread.enabledAppIds);
  return {
    modelConfiguration: {
      id: thread.modelConfigurationId,
      revision: thread.modelConfigurationRevision,
    },
    apps: apps
      .filter((app) => enabled.has(app.id))
      .map((app) => ({ id: app.id, contractVersion: app.contractVersion })),
  };
}

export function toDesktopRunHistory(
  thread: RendererThread,
): DesktopRunHistoryLine[] {
  return thread.transcript.flatMap<DesktopRunHistoryLine>((line) => {
    if (line.role === "user" || line.role === "assistant") {
      return [
        {
          role: line.role,
          text: line.text,
          timestamp: line.timestamp,
          ...(line.attachments !== undefined
            ? { attachments: line.attachments }
            : {}),
        },
      ];
    }
    const data = asRecord(line.data);
    const runId =
      typeof data?.runId === "string" && data.runId.trim().length > 0
        ? data.runId.trim()
        : undefined;
    return data?.kind === "runtime.waiting_prompt"
      ? [
          {
            role: "system" as const,
            text: line.text,
            timestamp: line.timestamp,
            data: {
              kind: "runtime.waiting_prompt" as const,
              ...(runId !== undefined ? { runId } : {}),
            },
          },
        ]
      : [];
  });
}

export function getRendererTurnContinuation(thread: RendererThread): {
  eventType: string;
  resumeFromWait?: true | undefined;
  resumeBlockedRun?: true | undefined;
} {
  if (thread.pendingWaitEventType === undefined) {
    return { eventType: "user.message" };
  }
  return {
    eventType: thread.pendingWaitEventType,
    resumeFromWait: true,
    ...(thread.pendingWaitEventType === "user.approval"
      ? { resumeBlockedRun: true }
      : {}),
  };
}

export function getTerminalWaitEventType(
  event: DesktopRunnerEvent,
): string | undefined {
  if (
    event.type !== "run.completed" ||
    event.payload.result.output.status !== "WAITING"
  ) {
    return;
  }
  const eventType = event.payload.result.output.waitFor?.eventType;
  return typeof eventType === "string" && eventType.trim().length > 0
    ? eventType.trim()
    : undefined;
}

export function getTerminalWaitingPrompt(
  event: DesktopRunnerEvent,
): { text: string; runId: string } | undefined {
  if (
    event.type !== "run.completed" ||
    event.payload.result.output.status !== "WAITING"
  ) {
    return;
  }
  const prompt = extractWaitPrompt(event.payload.result.output.waitFor);
  return prompt !== undefined
    ? { text: prompt, runId: event.payload.result.output.runId }
    : undefined;
}

function parseThreadStore(raw: string | undefined): {
  summaries: unknown[];
  states: Record<string, unknown>;
} {
  if (raw === undefined) {
    return { summaries: [], states: {} };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    return {
      summaries: Array.isArray(record?.summaries) ? record.summaries : [],
      states: asRecord(record?.states) ?? {},
    };
  } catch {
    return { summaries: [], states: {} };
  }
}

interface ParsedInteractionState {
  draft: string;
  attachmentIds: string[];
  promptHistory: string[];
}

function parseInteractionState(raw: string | undefined): Record<string, ParsedInteractionState> {
  if (raw === undefined) return {};
  try {
    const root = asRecord(JSON.parse(raw));
    if (root?.version !== "desktop-interaction-state-v1") return {};
    const threads = asRecord(root.threads) ?? {};
    return Object.fromEntries(Object.entries(threads).flatMap(([id, value]) => {
      const record = asRecord(value);
      if (record === undefined) return [];
      return [[id, {
        draft: typeof record.draft === "string" ? record.draft : "",
        attachmentIds: parseStringArray(record.attachmentIds, 8),
        promptHistory: parseStringArray(record.promptHistory, MAX_PROMPT_HISTORY),
      }]];
    }));
  } catch { return {}; }
}

function parseLegacyStringMap(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  try {
    const value = asRecord(JSON.parse(raw));
    return Object.fromEntries(Object.entries(value ?? {}).flatMap(([key, entry]) => typeof entry === "string" ? [[key, entry]] : []));
  } catch { return {}; }
}

function parseLegacyHistory(raw: string | undefined): Record<string, string[]> {
  if (raw === undefined) return {};
  try {
    const value = asRecord(JSON.parse(raw));
    return Object.fromEntries(Object.entries(value ?? {}).map(([key, entry]) => [key, parseStringArray(entry, MAX_PROMPT_HISTORY)]));
  } catch { return {}; }
}

function parseStringArray(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => typeof entry === "string" && entry.trim().length > 0 ? [entry] : []).slice(-max)
    : [];
}

function collectThreads(store: {
  summaries: unknown[];
  states: Record<string, unknown>;
}, defaults: {
  modelConfigurationId?: string | undefined;
  modelConfigurationRevision?: number | undefined;
  enabledAppIds?: string[] | undefined;
}): RendererThread[] {
  const summaries = new Map<string, Record<string, unknown>>();
  for (const candidate of store.summaries) {
    const summary = asRecord(candidate);
    if (typeof summary?.id === "string") {
      summaries.set(summary.id, summary);
    }
  }
  const ids = [...new Set([...summaries.keys(), ...Object.keys(store.states)])];
  return ids
    .flatMap((id) => {
      const rawState = asRecord(store.states[id]);
      if (rawState === undefined || typeof rawState.sessionId !== "string") {
        return [];
      }
      const sessionId = rawState.sessionId.trim().length > 0
        ? rawState.sessionId.trim()
        : crypto.randomUUID();
      const rawSummary = summaries.get(id) ?? {};
      const transcript = Array.isArray(rawState.transcript)
        ? rawState.transcript.flatMap(parseTranscriptLine)
        : [];
      const updatedAt =
        typeof rawSummary.updatedAt === "string"
          ? normalizeTimestamp(rawSummary.updatedAt)
          : (transcript.at(-1)?.timestamp ?? new Date().toISOString());
      const mode: RendererMode =
        rawState.interactionMode === "chat" ||
        rawState.interactionMode === "plan"
          ? rawState.interactionMode
          : "build";
      const workspaceMode: RendererWorkspaceMode =
        rawState.workspaceMode === "managed" ? "managed" : "local";
      const workspaceBaseRef =
        typeof rawState.workspaceBaseRef === "string" &&
        rawState.workspaceBaseRef.trim().length > 0
          ? rawState.workspaceBaseRef.trim()
          : "HEAD";
      const workspaceSetupIgnoredFiles =
        typeof rawState.workspaceSetupIgnoredFiles === "string"
          ? rawState.workspaceSetupIgnoredFiles
          : "";
      const workspaceSetupExecutable =
        typeof rawState.workspaceSetupExecutable === "string"
          ? rawState.workspaceSetupExecutable
          : "";
      const workspaceSetupArgs =
        typeof rawState.workspaceSetupArgs === "string"
          ? rawState.workspaceSetupArgs
          : "";
      const openFiles = Array.isArray(rawState.openFiles)
        ? rawState.openFiles
            .filter(
              (value): value is string =>
                typeof value === "string" && value.length > 0,
            )
            .slice(-20)
        : [];
      const diffScopeKind = parseDiffScopeKind(rawState.diffScopeKind);
      const diffRevision =
        typeof rawState.diffRevision === "string"
          ? rawState.diffRevision.slice(0, 512)
          : "";
      const diffView =
        rawState.diffView === "side-by-side"
          ? ("side-by-side" as const)
          : ("unified" as const);
      return [
        {
          id,
          title:
            typeof rawSummary.title === "string" &&
            rawSummary.title.trim().length > 0
              ? rawSummary.title
              : "Conversation",
          sessionId,
          ...(typeof rawState.projectPath === "string" &&
          rawState.projectPath.trim().length > 0
            ? { projectPath: rawState.projectPath.trim() }
            : {}),
          updatedAt,
          ...(typeof rawSummary.archivedAt === "string" && rawSummary.archivedAt.trim().length > 0
            ? { archivedAt: normalizeTimestamp(rawSummary.archivedAt) }
            : {}),
          ...(rawSummary.titleLocked === true ? { titleLocked: true } : {}),
          transcript,
          ...(typeof rawState.pendingWaitEventType === "string" &&
          rawState.pendingWaitEventType.trim().length > 0
            ? { pendingWaitEventType: rawState.pendingWaitEventType.trim() }
            : {}),
          mode,
          workspaceMode,
          workspaceBaseRef,
          workspaceSetupIgnoredFiles,
          workspaceSetupExecutable,
          workspaceSetupArgs,
          openFiles,
          diffScopeKind,
          diffRevision,
          diffView,
          draft: "",
          draftAttachmentIds: [],
          promptHistory: [],
          modelConfigurationId:
            typeof rawState.modelConfigurationId === "string"
              ? rawState.modelConfigurationId
              : defaults.modelConfigurationId ?? "desktop-default",
          modelConfigurationRevision:
            typeof rawState.modelConfigurationRevision === "number" &&
            Number.isSafeInteger(rawState.modelConfigurationRevision) &&
            rawState.modelConfigurationRevision > 0
              ? rawState.modelConfigurationRevision
              : defaults.modelConfigurationRevision ?? 1,
          enabledAppIds: Array.isArray(rawState.enabledAppIds)
            ? [...new Set(rawState.enabledAppIds.flatMap((appId) =>
                typeof appId === "string" ? [normalizeDesktopAppId(appId)] : []
              ))]
            : [...new Set(
                (defaults.enabledAppIds ?? DESKTOP_DEFAULT_ENABLED_APP_IDS).map(normalizeDesktopAppId),
              )],
          rawSummary,
          rawState,
        },
      ];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function parseDiffScopeKind(value: unknown): RendererDiffScopeKind {
  return value === "unstaged" ||
    value === "staged" ||
    value === "branch" ||
    value === "commit" ||
    value === "pull_request" ||
    value === "latest_run" ||
    value === "latest_turn" ||
    value === "promotion"
    ? value
    : "uncommitted";
}

function compactTranscriptsForPersistence(
  threads: RendererThread[],
): Map<string, RendererTranscriptLine[]> {
  const result = new Map<string, RendererTranscriptLine[]>();
  let remainingBytes = MAX_PERSISTED_TRANSCRIPT_BYTES;

  for (const thread of threads) {
    const compacted: RendererTranscriptLine[] = [];
    const candidates = thread.transcript.slice(
      -MAX_PERSISTED_TRANSCRIPT_LINES_PER_THREAD,
    );
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = compactTranscriptLine(candidates[index]!);
      const byteLength = serializedByteLength(candidate);
      if (byteLength > remainingBytes) {
        continue;
      }
      compacted.unshift(candidate);
      remainingBytes -= byteLength;
    }
    result.set(thread.id, compacted);
  }

  return result;
}

function compactTranscriptLine(
  line: RendererTranscriptLine,
): RendererTranscriptLine {
  const compacted: RendererTranscriptLine = {
    role: line.role,
    text: truncateUtf8(line.text, MAX_PERSISTED_TRANSCRIPT_LINE_TEXT_BYTES),
    timestamp: line.timestamp,
    ...(line.data !== undefined ? { data: line.data } : {}),
    ...(line.attachments !== undefined
      ? { attachments: line.attachments }
      : {}),
    ...(line.dialog !== undefined ? { dialog: line.dialog } : {}),
  };
  if (
    serializedByteLength(compacted) <=
    MAX_PERSISTED_TRANSCRIPT_LINE_TEXT_BYTES * 2
  ) {
    return compacted;
  }
  return {
    role: compacted.role,
    text: compacted.text,
    timestamp: compacted.timestamp,
  };
}

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) {
    return value;
  }
  return new TextDecoder().decode(encoded.slice(0, maxBytes));
}

function parseTranscriptLine(value: unknown): RendererTranscriptLine[] {
  const line = asRecord(value);
  if (
    (line?.role !== "user" &&
      line?.role !== "assistant" &&
      line?.role !== "system") ||
    typeof line.text !== "string"
  ) {
    return [];
  }
  return [
    {
      role: line.role,
      text: line.text,
      timestamp:
        typeof line.timestamp === "string"
          ? normalizeTimestamp(line.timestamp)
          : new Date().toISOString(),
      ...(line.data !== undefined ? { data: line.data } : {}),
      ...(parseDialogTranscriptData(line.dialog) !== undefined ? { dialog: parseDialogTranscriptData(line.dialog) } : {}),
      ...parseRendererAttachments(line.attachments),
    },
  ];
}

function parseDialogTranscriptData(value: unknown): RendererTranscriptLine["dialog"] {
  const dialog = asRecord(value);
  if (typeof dialog?.messageId !== "string" || typeof dialog.dialogId !== "string" || typeof dialog.name !== "string" || typeof dialog.childSessionId !== "string" || (dialog.sender !== "kestrel" && dialog.sender !== "collaborator" && dialog.sender !== "system")) return undefined;
  return {
    messageId: dialog.messageId,
    dialogId: dialog.dialogId,
    name: dialog.name,
    childSessionId: dialog.childSessionId,
    sender: dialog.sender,
    ...(dialog.status === "failed" || dialog.status === "cancelled" ? { status: dialog.status } : {}),
  };
}

function parseRendererAttachments(value: unknown): {
  attachments?: RunTurnAttachment[] | undefined;
} {
  if (Array.isArray(value) === false) {
    return {};
  }
  const attachments = value
    .filter((entry): entry is RunTurnAttachment => {
      const record = asRecord(entry);
      return (
        typeof record?.attachmentId === "string" &&
        typeof record.filename === "string" &&
        typeof record.mimeType === "string" &&
        typeof record.sizeBytes === "number" &&
        typeof record.sha256 === "string" &&
        (record.kind === "text" || record.kind === "image") &&
        (record.kind !== "text" || typeof record.text === "string") &&
        (record.kind !== "image" || typeof record.data === "string")
      );
    })
    .slice(0, 8);
  return attachments.length === 0 ? {} : { attachments };
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}
