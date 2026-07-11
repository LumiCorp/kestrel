import type {
  DesktopLegacyUiStateEntries,
  DesktopRunHistoryLine,
  DesktopUiStateV1,
} from "../../src/contracts";

const THREADS_STORAGE_KEY = "kchat:web:threads:v2";
const ACTIVE_THREAD_STORAGE_KEY = "kchat:web:active-thread:v1";
const THEME_STORAGE_KEY = "kchat:web:theme-mode";

export type RendererTheme = "light" | "dark";
export type RendererMode = "chat" | "plan" | "build";

export interface RendererTranscriptLine extends DesktopRunHistoryLine {
  data?: unknown;
}

export interface RendererThread {
  id: string;
  title: string;
  sessionId: string;
  updatedAt: string;
  transcript: RendererTranscriptLine[];
  mode: RendererMode;
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
): DesktopRendererState {
  const entries = { ...(uiState?.entries ?? {}) };
  const store = parseThreadStore(entries[THREADS_STORAGE_KEY]);
  const threads = collectThreads(store);
  const normalizedThreads = threads.length > 0 ? threads : [createRendererThread()];
  const requestedActive = entries[ACTIVE_THREAD_STORAGE_KEY];
  const activeThreadId = normalizedThreads.some((thread) => thread.id === requestedActive)
    ? requestedActive!
    : normalizedThreads[0]!.id;
  return {
    entries,
    activeThreadId,
    threads: normalizedThreads,
    theme: entries[THEME_STORAGE_KEY] === "dark" ? "dark" : "light",
  };
}

export function createRendererThread(): RendererThread {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    id,
    title: "New conversation",
    sessionId: crypto.randomUUID(),
    updatedAt: now,
    transcript: [],
    mode: "build",
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
    const firstUserText = line.role === "user" && thread.transcript.every((item) => item.role !== "user")
      ? line.text.trim()
      : undefined;
    return {
      ...thread,
      title: firstUserText === undefined
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
    threads: state.threads.map((thread) => thread.id === threadId ? update(thread) : thread),
  };
}

export function addRendererThread(state: DesktopRendererState): DesktopRendererState {
  const thread = createRendererThread();
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

export function setRendererTheme(
  state: DesktopRendererState,
  theme: RendererTheme,
): DesktopRendererState {
  return { ...state, theme };
}

export function serializeDesktopRendererState(
  state: DesktopRendererState,
): DesktopLegacyUiStateEntries {
  const summaries = state.threads.map((thread) => ({
    ...thread.rawSummary,
    id: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
    createdAt: typeof thread.rawSummary.createdAt === "string"
      ? thread.rawSummary.createdAt
      : thread.updatedAt,
    lastPreview: thread.transcript.at(-1)?.text.slice(0, 160) ?? "",
  }));
  const states = Object.fromEntries(state.threads.map((thread) => [
    thread.id,
    {
      ...thread.rawState,
      sessionId: thread.sessionId,
      transcript: thread.transcript,
      interactionMode: thread.mode,
      ...(thread.mode === "build" ? { actSubmode: "safe" } : { actSubmode: undefined }),
    },
  ]));
  return {
    ...state.entries,
    [THREADS_STORAGE_KEY]: JSON.stringify({ summaries, states }),
    [ACTIVE_THREAD_STORAGE_KEY]: state.activeThreadId,
    [THEME_STORAGE_KEY]: state.theme,
  };
}

export function toDesktopRunHistory(thread: RendererThread): DesktopRunHistoryLine[] {
  return thread.transcript
    .filter((line) => line.role === "user" || line.role === "assistant" || line.role === "system")
    .map(({ role, text, timestamp }) => ({ role, text, timestamp }));
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

function collectThreads(store: {
  summaries: unknown[];
  states: Record<string, unknown>;
}): RendererThread[] {
  const summaries = new Map<string, Record<string, unknown>>();
  for (const candidate of store.summaries) {
    const summary = asRecord(candidate);
    if (typeof summary?.id === "string") {
      summaries.set(summary.id, summary);
    }
  }
  const ids = [...new Set([...summaries.keys(), ...Object.keys(store.states)])];
  return ids.flatMap((id) => {
    const rawState = asRecord(store.states[id]);
    if (rawState === undefined || typeof rawState.sessionId !== "string") {
      return [];
    }
    const rawSummary = summaries.get(id) ?? {};
    const transcript = Array.isArray(rawState.transcript)
      ? rawState.transcript.flatMap(parseTranscriptLine)
      : [];
    const updatedAt = typeof rawSummary.updatedAt === "string"
      ? normalizeTimestamp(rawSummary.updatedAt)
      : transcript.at(-1)?.timestamp ?? new Date().toISOString();
    const mode: RendererMode = rawState.interactionMode === "chat" || rawState.interactionMode === "plan"
      ? rawState.interactionMode
      : "build";
    return [{
      id,
      title: typeof rawSummary.title === "string" && rawSummary.title.trim().length > 0
        ? rawSummary.title
        : "Conversation",
      sessionId: rawState.sessionId,
      updatedAt,
      transcript,
      mode,
      rawSummary,
      rawState,
    }];
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function parseTranscriptLine(value: unknown): RendererTranscriptLine[] {
  const line = asRecord(value);
  if (
    (line?.role !== "user" && line?.role !== "assistant" && line?.role !== "system")
    || typeof line.text !== "string"
  ) {
    return [];
  }
  return [{
    role: line.role,
    text: line.text,
    timestamp: typeof line.timestamp === "string"
      ? normalizeTimestamp(line.timestamp)
      : new Date().toISOString(),
    ...(line.data !== undefined ? { data: line.data } : {}),
  }];
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
