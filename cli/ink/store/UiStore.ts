import type {
  AgentRunLogLine,
  AppView,
  LayoutProfile,
  LayoutMode,
  ProgressUpdateV1,
  ReasoningUpdateV1,
  SplashPreflightState,
  TranscriptLine,
  TuiProfile,
  TuiSessionMeta,
  UiDetailDrawerState,
  UiLogFilters,
  UiPaneSizes,
  UiState,
  ViewScrollState,
} from "../../contracts.js";
import type { McpStatusSnapshot } from "../../../src/mcp/contracts.js";
import type { WorkspaceCheckpointRecord } from "../../../src/workspaceCheckpoints/contracts.js";
import {
  resolveThemeSelection,
  themeModeFromLegacyPreset,
  type ResolvedThemeMode,
  type ThemeMode,
  type ThemePresetId,
  type ThemeTokens,
} from "../theme/tokens.js";
import type { FocusRegion } from "../keymap.js";
import {
  normalizeRestoredActiveRegion,
  toPersistedActiveRegion,
} from "../focusPolicy.js";
export type { FocusRegion } from "../keymap.js";

export interface UiErrorState {
  message: string;
  code?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

export interface UiViewport {
  columns: number;
  rows: number;
}

export interface UiDerivedSnapshot {
  filteredLogsCount: number;
  filteredSessionsCount: number;
  filteredPaletteCount: number;
}

export interface UiRuntimeState extends UiState {
  appName: string;
  theme: ThemeTokens;
  themeMode: ThemeMode;
  resolvedThemeMode: ResolvedThemeMode;
  themePreset: ThemePresetId;
  activeProfile: TuiProfile;
  activeSession: TuiSessionMeta;
  sessions: TuiSessionMeta[];
  transcript: TranscriptLine[];
  runLogs: AgentRunLogLine[];
  statusLine: string;
  running: boolean;
  helpOpen: boolean;
  paletteOpen: boolean;
  paletteSource?: "manual" | "slash" | undefined;
  paletteContext?: "start-template" | "start-preset" | "start-workspace" | undefined;
  paletteQuery: string;
  paletteSelectedIndex: number;
  errorOverlay?: UiErrorState | undefined;
  errorDetailsExpanded: boolean;
  errorScrollOffset: number;
  logsFilterMode: boolean;
  sessionsSearchMode: boolean;
  sessionQuery: string;
  chatDraft: string;
  chatDraftExpanded: boolean;
  chatHighlightRunId?: string | undefined;
  activeRegion: FocusRegion;
  focusRegion?: FocusRegion | undefined;
  quitConfirm: boolean;
  viewport: UiViewport;
  activeProgressByRun: Record<string, ProgressUpdateV1>;
  latestProgressForSession?: ProgressUpdateV1 | undefined;
  latestReasoningForSession?: ReasoningUpdateV1 | undefined;
  taskScroll: ViewScrollState;
  commandBarReturnRegion?: FocusRegion | undefined;
  navigationStack: AppView[];
  layoutMode: LayoutMode;
  paneSizes: UiPaneSizes;
  derived: UiDerivedSnapshot;
  splashPreflight: SplashPreflightState;
  mcpStatus?: McpStatusSnapshot | undefined;
  workspaceCheckpoints?: WorkspaceCheckpointRecord[] | undefined;
}

type StateUpdater = UiRuntimeState | ((current: UiRuntimeState) => UiRuntimeState);

const DEFAULT_LOG_FILTERS: UiLogFilters = {
  level: "ALL",
  eventQuery: "",
  runIdQuery: "",
  paused: false,
  grouped: true,
};

const DEFAULT_VIEW: AppView = "chat";
const DEFAULT_SCROLL: ViewScrollState = {
  offset: 0,
  cursor: 0,
  tailLocked: false,
};
const DEFAULT_DETAIL_DRAWER: UiDetailDrawerState = {
  open: false,
  source: "chat",
  expanded: false,
};
const DEFAULT_LAYOUT_MODE: LayoutMode = "minimal";

export class UiStore {
  private state: UiRuntimeState;
  private readonly listeners = new Set<() => void>();

  constructor(initial: UiRuntimeState) {
    this.state = initial;
  }

  getState(): UiRuntimeState {
    return this.state;
  }

  setState(next: StateUpdater): void {
    const resolved = typeof next === "function" ? next(this.state) : next;
    this.state = resolved;
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  patch(next: Partial<UiRuntimeState>): void {
    this.setState((current) => ({
      ...current,
      ...next,
    }));
  }

  patchScroll(view: AppView, scroll: ViewScrollState): void {
    this.patch({
      scroll: {
        ...this.state.scroll,
        [view]: scroll,
      },
    });
  }
}

export function deriveLayoutProfile(columns: number): LayoutProfile {
  if (columns < 100) {
    return "narrow";
  }
  if (columns >= 140) {
    return "wide";
  }
  return "standard";
}

export function derivePaneSizes(columns: number): UiPaneSizes {
  if (columns >= 140) {
    return {
      sessions: 0.25,
      chat: 0.46,
      logs: 0.29,
    };
  }
  if (columns < 100) {
    return {
      sessions: 1,
      chat: 1,
      logs: 1,
    };
  }
  return {
    sessions: 0.28,
    chat: 0.44,
    logs: 0.28,
  };
}

export function derivePaneRowCounts(state: Pick<UiRuntimeState, "viewport" | "layoutMode">): {
  sessions: number;
  chat: number;
  logs: number;
} {
  const contentRows = state.layoutMode === "minimal" ? Math.max(8, state.viewport.rows - 6) : Math.max(12, state.viewport.rows - 11);
  return {
    sessions: Math.max(6, contentRows),
    chat: Math.max(6, contentRows),
    logs: Math.max(6, contentRows),
  };
}

export function getViewportFallback(): UiViewport {
  return {
    columns: typeof process.stdout.columns === "number" ? process.stdout.columns : 120,
    rows: typeof process.stdout.rows === "number" ? process.stdout.rows : 40,
  };
}

export function clampScrollState(
  input: ViewScrollState,
  totalCount: number,
): ViewScrollState {
  const maxCursor = Math.max(0, totalCount - 1);
  const cursor = Math.min(Math.max(0, input.cursor), maxCursor);
  const maxOffset = Math.max(0, totalCount - 1);
  const offset = Math.min(Math.max(0, input.offset), maxOffset);
  return {
    offset,
    cursor,
    tailLocked: input.tailLocked,
  };
}

export function isAtTail(scroll: ViewScrollState, itemCount: number): boolean {
  if (itemCount <= 0) {
    return true;
  }
  return scroll.cursor >= itemCount - 1;
}

export function computeUnreadIncrement(input: {
  currentUnread: number;
  wasAtTail: boolean;
  appendedCount: number;
}): number {
  if (input.appendedCount <= 0) {
    return input.currentUnread;
  }
  if (input.wasAtTail) {
    return 0;
  }
  return input.currentUnread + input.appendedCount;
}

export function ensureCursorVisible(
  input: ViewScrollState,
  totalCount: number,
  windowSize: number,
): ViewScrollState {
  const clamped = clampScrollState(input, totalCount);
  const boundedWindow = Math.max(1, windowSize);
  let offset = clamped.offset;
  if (clamped.cursor < offset) {
    offset = clamped.cursor;
  } else if (clamped.cursor >= offset + boundedWindow) {
    offset = clamped.cursor - boundedWindow + 1;
  }
  const maxOffset = Math.max(0, totalCount - boundedWindow);
  return {
    ...clamped,
    offset: Math.min(Math.max(0, offset), maxOffset),
  };
}

export function moveCursor(
  input: ViewScrollState,
  totalCount: number,
  delta: number,
  windowSize: number,
): ViewScrollState {
  const next = clampScrollState(
    {
      ...input,
      cursor: input.cursor + delta,
    },
    totalCount,
  );
  return ensureCursorVisible(next, totalCount, windowSize);
}

export function pageCursor(
  input: ViewScrollState,
  totalCount: number,
  windowSize: number,
  direction: "up" | "down",
): ViewScrollState {
  const step = Math.max(1, Math.floor(windowSize * 0.8));
  return moveCursor(input, totalCount, direction === "down" ? step : -step, windowSize);
}

export function jumpCursor(
  input: ViewScrollState,
  totalCount: number,
  windowSize: number,
  to: "start" | "end",
): ViewScrollState {
  const cursor = to === "start" ? 0 : Math.max(0, totalCount - 1);
  return ensureCursorVisible(
    {
      ...input,
      cursor,
    },
    totalCount,
    windowSize,
  );
}

export function buildWindow<T>(
  items: T[],
  scroll: ViewScrollState,
  windowSize: number,
): {
  items: T[];
  start: number;
  end: number;
  scroll: ViewScrollState;
} {
  const normalized = ensureCursorVisible(scroll, items.length, windowSize);
  const boundedWindow = Math.max(1, windowSize);
  const start = normalized.offset;
  const end = Math.min(items.length, start + boundedWindow);
  return {
    items: items.slice(start, end),
    start,
    end,
    scroll: normalized,
  };
}

export function buildInitialUiRuntimeState(input: {
  profile: TuiProfile;
  activeSession: TuiSessionMeta;
  sessions: TuiSessionMeta[];
  transcript: TranscriptLine[];
  persisted?: Partial<UiState> | undefined;
  splashPreflight?: SplashPreflightState | undefined;
}): UiRuntimeState {
  const persisted = input.persisted as
    | Partial<
        UiState & {
          inspector?: {
            active?: boolean;
            source?: AppView;
          };
        }
      >
    | undefined;
  const viewport = getViewportFallback();
  const activeView = persisted?.activeView ?? DEFAULT_VIEW;
  const layoutProfile = persisted?.layoutProfile ?? deriveLayoutProfile(viewport.columns);
  const paneSizes = persisted?.paneSizes ?? derivePaneSizes(viewport.columns);
  const logFilters: UiLogFilters = {
    ...DEFAULT_LOG_FILTERS,
    ...(persisted?.logFilters ?? {}),
  };
  const persistedScroll = persisted?.scroll;
  const chatScroll = clampScrollState(
    {
      ...DEFAULT_SCROLL,
      tailLocked: true,
      ...(persistedScroll?.chat ?? {}),
    },
    input.transcript.length,
  );
  const logsScroll = clampScrollState(
    {
      ...DEFAULT_SCROLL,
      tailLocked: true,
      ...(persistedScroll?.logs ?? {}),
    },
    0,
  );
  const sessionsScroll = clampScrollState(
    {
      ...DEFAULT_SCROLL,
      ...(persistedScroll?.sessions ?? {}),
    },
    input.sessions.length,
  );
  const detailDrawer = {
    ...DEFAULT_DETAIL_DRAWER,
    source:
      persisted?.detailDrawer?.source ??
      persisted?.inspector?.source ??
      activeView,
  };
  const requestedInitialRegion =
    persisted?.activeRegion ??
    (activeView === "logs"
      ? "logs"
      : activeView === "sessions" || activeView === "tasks" || activeView === "history" || activeView === "mcp" || activeView === "code"
        || activeView === "delegation" || activeView === "recovery"
        ? "sessions"
        : "composer");
  const initialRegion: FocusRegion =
    normalizeRestoredActiveRegion(activeView, requestedInitialRegion);
  const themeMode = persisted?.themeMode ?? themeModeFromLegacyPreset(persisted?.themePreset);
  const themeSelection = resolveThemeSelection({
    mode: themeMode,
    overrides: input.profile.theme,
  });

  return {
    appName: "Kestrel Chat",
    theme: themeSelection.tokens,
    activeProfile: input.profile,
    activeSession: input.activeSession,
    sessions: input.sessions,
    transcript: input.transcript,
    runLogs: [],
    statusLine: "ready",
    running: false,
    helpOpen: false,
    paletteOpen: false,
    paletteSource: undefined,
    paletteContext: undefined,
    paletteQuery: "",
    paletteSelectedIndex: 0,
    errorDetailsExpanded: false,
    errorScrollOffset: 0,
    sessionQuery: "",
    logsFilterMode: false,
    sessionsSearchMode: false,
    chatDraft: "",
    chatDraftExpanded: false,
    activeRegion: initialRegion,
    focusRegion: initialRegion,
    quitConfirm: false,
    viewport,
    activeView,
    layoutMode: DEFAULT_LAYOUT_MODE,
    paneSizes,
    themeMode: themeSelection.mode,
    resolvedThemeMode: themeSelection.resolvedMode,
    themePreset: themeSelection.preset,
    splashVisible: true,
    densityMode: "dense",
    layoutProfile,
    overlayLayout: "adaptive",
    logFilters,
    scroll: {
      chat: chatScroll,
      logs: logsScroll,
      sessions: sessionsScroll,
    },
    taskScroll: {
      ...DEFAULT_SCROLL,
    },
    detailDrawer,
    activeProgressByRun: {},
    latestProgressForSession: undefined,
    latestReasoningForSession: undefined,
    commandBarReturnRegion: undefined,
    navigationStack: [],
    derived: {
      filteredLogsCount: 0,
      filteredSessionsCount: input.sessions.length,
      filteredPaletteCount: 0,
    },
    splashPreflight: input.splashPreflight ?? {
      phase: "running",
      summary: "pre-flight checks in progress",
      checks: [],
    },
    mcpStatus: undefined,
    workspaceCheckpoints: undefined,
    chatUnreadCount: persisted?.chatUnreadCount ?? 0,
    lastSelectedSession: persisted?.lastSelectedSession,
    paletteRecentCommands: persisted?.paletteRecentCommands ?? [],
    recentModelsByProvider: persisted?.recentModelsByProvider ?? {},
  };
}

export function toPersistedUiState(state: UiRuntimeState): UiState {
  return {
    version: 5,
    activeView: state.activeView,
    activeRegion: toPersistedActiveRegion(state),
    layoutMode: state.layoutMode,
    paneSizes: state.paneSizes,
    themeMode: state.themeMode,
    splashVisible: false,
    densityMode: "dense",
    layoutProfile: state.layoutProfile,
    overlayLayout: "adaptive",
    logFilters: state.logFilters,
    scroll: state.scroll,
    detailDrawer: state.detailDrawer,
    chatUnreadCount: state.chatUnreadCount ?? 0,
    lastSelectedSession: state.activeSession.name,
    paletteRecentCommands: state.paletteRecentCommands.slice(-25),
    recentModelsByProvider: Object.fromEntries(
      Object.entries(state.recentModelsByProvider ?? {}).map(([provider, models]) => [
        provider,
        models.slice(0, 5),
      ]),
    ),
  };
}
