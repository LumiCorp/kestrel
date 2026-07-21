import type {
  DesktopExecutionSelection,
  DesktopLegacyUiStateEntries,
  DesktopRunHistoryLine,
  DesktopRunnerEvent,
  DesktopUiStateV1,
  RunTurnAttachment,
} from "../../src/contracts";
import { extractWaitPrompt } from "../../../../src/runtime/waitForPrompt";

const THREADS_STORAGE_KEY = "kchat:web:threads:v2";
const ACTIVE_THREAD_STORAGE_KEY = "kchat:web:active-thread:v1";
const THEME_STORAGE_KEY = "kchat:web:theme-mode";
const INTERACTION_STATE_STORAGE_KEY = "kestrel:desktop-interaction-state:v1";
const LEGACY_DRAFTS_STORAGE_KEY = "kchat:web:composer-drafts:v1";
const LEGACY_HISTORY_STORAGE_KEY = "kchat:web:prompt-history:v1";
export const MAX_PROMPT_HISTORY = 100;
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
}

export interface RendererThread {
  id: string;
  title: string;
  sessionId: string;
  projectPath?: string | undefined;
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
    enabledAppIds: [...(input.enabledAppIds ?? ["weather"])],
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
    const firstUserText =
      line.role === "user" &&
      thread.transcript.every((item) => item.role !== "user")
        ? line.text.trim()
        : undefined;
    return {
      ...thread,
      title:
        firstUserText === undefined
          ? thread.title
          : firstUserText.length > 54
            ? `${firstUserText.slice(0, 51)}...`
            : firstUserText,
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
  activeProjectPath?: string | undefined;
  projects: readonly { path: string }[];
}): string | undefined {
  const registeredPaths = new Set(
    input.projects.map((project) => project.path),
  );
  if (
    input.authoritativeProjectPath !== undefined &&
    registeredPaths.has(input.authoritativeProjectPath)
  ) {
    return input.authoritativeProjectPath;
  }
  if (
    input.thread.projectPath !== undefined &&
    registeredPaths.has(input.thread.projectPath)
  ) {
    return input.thread.projectPath;
  }
  if (
    input.activeProjectPath !== undefined &&
    registeredPaths.has(input.activeProjectPath)
  ) {
    return input.activeProjectPath;
  }
  return input.projects[0]?.path;
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
          sessionId: rawState.sessionId,
          ...(typeof rawState.projectPath === "string" &&
          rawState.projectPath.trim().length > 0
            ? { projectPath: rawState.projectPath.trim() }
            : {}),
          updatedAt,
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
            ? rawState.enabledAppIds.filter(
                (appId): appId is string => typeof appId === "string",
              )
            : [...(defaults.enabledAppIds ?? ["weather"])],
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
      ...parseRendererAttachments(line.attachments),
    },
  ];
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
