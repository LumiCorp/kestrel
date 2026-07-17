import path from "node:path";
import { randomUUID } from "node:crypto";

import React from "react";
import { render, type Instance } from "ink";

import type {
  AgentRunLogLine,
  AppView,
  DelegationTaskMeta,
  ParsedInput,
  ResolvedWorkspace,
  SessionsFile,
  SplashPreflightCheck,
  SplashPreflightState,
  TranscriptLine,
  TuiProfile,
  TuiSessionMeta,
} from "../contracts.js";
import type { ProfileStore } from "../config/ProfileStore.js";
import type { RuntimeSettingsFile } from "../config/RuntimeSettings.js";
import type { HistoryStore } from "../history/HistoryStore.js";
import type { DiagnosticLogStore } from "../diagnostics/DiagnosticLogStore.js";
import { parseFinalizePayload } from "../output/FinalizePayload.js";
import type { SessionStore } from "../session/SessionStore.js";
import { resolveLocalCoreStoreClient } from "../localCoreStoreClient.js";
import type { UiStateStore } from "../ink/persistence/UiStateStore.js";
import {
  computeUnreadIncrement,
  deriveLayoutProfile,
  derivePaneRowCounts,
  derivePaneSizes,
  ensureCursorVisible,
  isAtTail,
  jumpCursor,
  moveCursor,
  pageCursor,
  toPersistedUiState,
  type UiStore,
  type UiRuntimeState,
} from "../ink/store/UiStore.js";
import { AppRoot, type InkAppController } from "../ink/AppRoot.js";
import { createUiDerivedSelectors } from "../ink/store/selectors.js";
import { cycleRegion, type FocusRegion } from "../ink/keymap.js";
import { truncate } from "../ink/ui/format.js";
import {
  buildThemeSummaryLines,
  listThemeModes,
  parseThemeCommandArgs,
  resolveThemeSelection,
  type ThemeMode,
} from "../ink/theme/tokens.js";
import {
  buildChatVisualRows,
  buildTranscriptStartScroll,
  countChatVisualRows,
  ensureChatCursorVisible,
  resolveChatVisualAnchor,
  resolveChatVisualCursorFromAnchor,
} from "../ink/views/chatRows.js";
import {
  resolveChatComposerInputRows,
  resolveChatLayoutBudget,
  type ChatLayoutBudget,
} from "../ink/views/chatLayout.js";
import { isInteractiveOperatorCommandDraft, parseInput } from "./CommandParser.js";
import { CodeModeController } from "./CodeModeController.js";
import { MissionControlRuntimeReporter } from "./MissionControlRuntimeReporter.js";
import { McpController, summarizeMcpDetails } from "./McpController.js";
import { normalizeSubmittedLine } from "./submitInput.js";
import { OperatorController, type OperatorControlApplyAction } from "./OperatorController.js";
import { PaletteController, type PaletteCommand } from "./PaletteController.js";
import { SessionController } from "./SessionController.js";
import { bootstrapTuiApp, runSplashDatabasePreflight } from "./TuiBootstrap.js";
import { TuiCommandRouter } from "./TuiCommandRouter.js";
import type { TuiAppContext, TuiAppOptions } from "./TuiAppContext.js";
import {
  clampIndex,
  dataHasArtifacts,
  splitTranscriptMessage,
  stripMcpSummary,
  summarizePreview,
} from "./TuiPresentationModel.js";
import { TuiRunController, resolveRunFailureSummary as resolveRunFailureSummaryFromController } from "./TuiRunController.js";
import { WorkspaceController, type WorkspaceSelection } from "./WorkspaceController.js";
import type { ProtocolClient } from "../client/ProtocolClient.js";
import { createConfiguredCliProtocolClient } from "../client/configuredClient.js";
import { toCoreExecutionProfile } from "../client/coreExecutionProfile.js";
import {
  buildModelCatalogStatusLine,
  buildModelSearchResultBlock,
  buildModelSummaryBlock,
  isSupportedModelSetProvider,
  MODEL_SET_PROVIDER_USAGE,
} from "../modelProviderCommand.js";
import type {
  OperatorControlledEventPayload,
  RunnerCommandMetadata,
  RunnerEvent,
  SessionDescribedEventPayload,
  WorkspaceCheckpointEventPayload,
} from "../protocol/contracts.js";
import {
  alignExecutionPolicyWithMode,
  createTuiClientCapabilities,
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  AGENT_STEP_IDS,
  buildPresentedProviderModelCatalog,
  formatModeSwitchCommand,
  formatUserFacingModeLabel,
  ModelPolicyStore,
  normalizeInteractionMode,
  resolveProviderModelCatalog,
  searchProviderModelCatalog,
  updateRecentModelsByProvider,
  toCanonicalInteractionMode,
  type ModelProviderId,
  type McpStatusSnapshot,
  type AgentProgressUpdateV1,
} from "../../src/index.js";
import type { ResolvedModelPolicy } from "../../src/profile/modelPolicy.js";
import {
  buildOperatorBootstrapSnapshot,
  buildChildMissionPrompt,
  buildOperatorCodeWorkspace,
  buildOperatorDelegationWorkspace,
  buildOperatorHistoryHome,
  buildOperatorLaunchSetup,
  buildOperatorMcpWorkspace,
  buildOperatorRecoveryCenter,
  buildOperatorWorkspaceJourney,
  getOperatorTaskTemplate,
  listOperatorProfilePresets,
  formatOperatorMode,
  buildOperatorStatusSnapshot,
  formatOperatorLaunchSummary,
  resolveOperatorStartTask,
  type OperatorProfilePresetSummary,
  type OperatorResolvedStartTask,
} from "../../src/operatorShell.js";
import {
  buildWaitingSystemText,
  extractWaitPrompt,
  isModeBlockedWait,
  resolveBlockedWaitModeReply,
} from "./waitForPrompt.js";
import {
  decorateOperatorAffordance,
  formatOperatorAffordance,
} from "../runtime/operatorAffordances.js";
import { buildOperatorAffordanceFromSessionProjection } from "../../src/orchestration/OperatorAffordanceProjection.js";
import {
  applySkillPackToProfile,
  getSkillPackById,
  listSkillPacks,
} from "../runtime/skillPacks.js";
import type { WorkspaceStore } from "../workspace/WorkspaceStore.js";
import {
  describeResolvedWorkspace,
} from "../workspace/WorkspaceResolver.js";
import {
  resolveDatabasePreflightTarget,
  resolveDatabaseSelfHealPolicy,
} from "../../src/runtime/databasePreflight.js";
import {
  resolveDockerCommandForSelfHealForTests,
  shouldLaunchDockerDesktopForSelfHealForTests,
} from "../../src/runtime/localDatabaseSelfHeal.js";

type AppOptions = TuiAppOptions;

const MAX_RUN_LOG_LINES = 500;
const SCRIPTED_INPUT_LINES_ENV = "KCHAT_SCRIPTED_INPUT_LINES_JSON";

class SplashPreflightError extends Error {
  readonly checkId: string;

  constructor(checkId: string, message: string, cause?: unknown) {
    super(message);
    this.checkId = checkId;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

type StartTaskJourneyStep = "template" | "preset" | "workspace" | "title" | "profile" | "mode" | "prompt";
type ChildMissionJourneyStep = "title" | "scope" | "return";

interface StartTaskJourneyState {
  step: StartTaskJourneyStep;
  presetId?: OperatorProfilePresetSummary["id"] | undefined;
  templateId?: "coding-task" | "investigation-task" | "review-task" | "orchestration-task" | undefined;
  title?: string | undefined;
  profile?: TuiProfile | undefined;
  interactionMode?: "chat" | "plan" | "build" | undefined;
  actSubmode?: "strict" | "safe" | "full_auto" | undefined;
  availableProfiles: TuiProfile[];
  availableWorkspaces: ResolvedWorkspace[];
  workspace: ResolvedWorkspace | undefined;
  workspaceBinding: "active" | "detached";
}

interface ChildMissionJourneyState {
  step: ChildMissionJourneyStep;
  title?: string | undefined;
  scope?: string | undefined;
  returnCondition?: string | undefined;
}

interface CreateSessionOptions {
  launch: OperatorResolvedStartTask;
  profile: TuiProfile;
  workspace?: ResolvedWorkspace | undefined;
}

export class App {
  private readonly options: AppOptions;
  private profileStore!: ProfileStore;
  private sessionStore!: SessionStore;
  private workspaceStore!: WorkspaceStore;
  private historyStore!: HistoryStore;
  private diagnosticsStore!: DiagnosticLogStore;
  private uiStateStore!: UiStateStore;
  private client!: ProtocolClient;
  private uiStore!: UiStore;
  private inkInstance: Instance | undefined;
  private sessionsFile!: SessionsFile;
  private activeWorkspace: ResolvedWorkspace | undefined;
  private launchWorkspace: ResolvedWorkspace | undefined;
  private mcpSummary = "mcp:unknown";
  private pendingModelProviderSelection: ModelProviderId | undefined;

  private stopped = false;
  private alternateScreenEnabled = false;
  private processingQueue = false;
  private readonly inputQueue: string[] = [];
  private lastComposerSubmission:
    | {
        sessionId: string;
        line: string;
      }
    | undefined;
  private resolveDone: (() => void) | undefined;
  private readonly selectors = createUiDerivedSelectors();
  private readonly startupNotices: string[] = [];
  private paletteController: PaletteController | undefined;
  private sessionController: SessionController | undefined;
  private workspaceController: WorkspaceController | undefined;
  private mcpController: McpController | undefined;
  private codeModeController: CodeModeController | undefined;
  private operatorController: OperatorController | undefined;
  private runController: TuiRunController | undefined;
  private commandRouter: TuiCommandRouter | undefined;
  private localCoreStatus:
    | import("../localCoreShell.js").CliLocalCoreStatus
    | undefined;
  private missionControlReporter: MissionControlRuntimeReporter | undefined;
  private runtimeSettings: RuntimeSettingsFile = {
    version: 1,
    defaults: {},
  };
  private bootstrapHintShown = false;
  private transcriptAppendQueue: Promise<void> = Promise.resolve();
  private readonly pendingAgentProgressTranscriptUpdates = new Map<string, AgentProgressUpdateV1>();
  private readonly activeAgentProgressTranscriptDrains = new Set<string>();
  private startTaskJourney: StartTaskJourneyState | undefined;
  private childMissionJourney: ChildMissionJourneyState | undefined;
  private scriptedInputsEnqueued = false;

  constructor(options: AppOptions) {
    this.options = options;
  }

  private getAppContext(): TuiAppContext {
    return {
      options: this.options,
      profileStore: this.profileStore,
      sessionStore: this.sessionStore,
      workspaceStore: this.workspaceStore,
      historyStore: this.historyStore,
      diagnosticsStore: this.diagnosticsStore,
      uiStateStore: this.uiStateStore,
      client: this.client,
      uiStore: this.uiStore,
      selectors: this.selectors,
      getRuntimeSettings: () => this.runtimeSettings,
      getLocalCoreClient: () => this.localCoreStatus?.client,
      getSessionsFile: () => this.sessionsFile,
      setSessionsFile: (sessionsFile) => {
        this.sessionsFile = sessionsFile;
      },
      getActiveWorkspace: () => this.activeWorkspace,
      setActiveWorkspace: (workspace) => {
        this.activeWorkspace = workspace;
      },
      getLaunchWorkspace: () => this.launchWorkspace,
      setLaunchWorkspace: (workspace) => {
        this.launchWorkspace = workspace;
      },
      appendHistoryLine: (role, text, data, output) =>
        this.appendHistoryLine(role, text, data, output),
      persistSessionAndUi: () => this.persistSessionAndUi(),
      persistUiState: () => this.persistUiState(),
      persistActiveProfile: (profile) => this.persistActiveProfile(profile),
      getActiveRunnerMetadata: () => this.getActiveRunnerMetadata(),
      setActiveSessionState: (patch) => this.setActiveSessionState(patch),
      navigateToView: (view, options) => {
        this.navigateToView(view, options);
      },
      withMcpSummary: (statusLine) => this.withMcpSummary(statusLine),
      recordPersistenceFailure: (scope, error) => {
        this.recordPersistenceFailure(scope, error);
      },
    };
  }

  private getActiveRunnerMetadata(): RunnerCommandMetadata {
    return {
      profile: toCoreExecutionProfile(this.uiStore.getState().activeProfile),
    };
  }

  async start(): Promise<void> {
    const bootstrap = await bootstrapTuiApp(this.options);
    this.profileStore = bootstrap.profileStore;
    this.sessionStore = bootstrap.sessionStore;
    this.workspaceStore = bootstrap.workspaceStore;
    this.historyStore = bootstrap.historyStore;
    this.diagnosticsStore = bootstrap.diagnosticsStore;
    this.uiStateStore = bootstrap.uiStateStore;
    this.runtimeSettings = bootstrap.runtimeSettings;
    this.sessionsFile = bootstrap.sessionsFile;
    this.launchWorkspace = bootstrap.launchWorkspace;
    this.activeWorkspace = bootstrap.activeWorkspace;
    this.uiStore = bootstrap.uiStore;
    this.localCoreStatus = bootstrap.localCoreStatus;
    this.missionControlReporter = new MissionControlRuntimeReporter({
      cwd: this.options.cwd,
      workspace: this.activeWorkspace,
      profile: bootstrap.activeProfile,
      session: bootstrap.activeSession,
    });
    this.missionControlReporter.start();
    this.startupNotices.push(...bootstrap.startupNotices);
    this.workspaceController = undefined;
    await this.refreshActiveSessionOperatorState();
    this.uiStore.patch({
      statusLine: this.withMcpSummary("ready"),
    });
    for (const notice of this.startupNotices) {
      await this.appendHistoryLine("system", notice);
    }

    this.client = createConfiguredCliProtocolClient(bootstrap.runnerTransportEnv);
    this.client.onEvent((event) => {
      this.onRunnerEvent(event);
    });

    this.enterAlternateScreen();
    this.inkInstance = render(React.createElement(AppRoot, { controller: this.buildController() }), {
      incrementalRendering: false,
      maxFps: 20,
      concurrent: false,
      exitOnCtrlC: false,
    });
    void this.runSplashPreflight();
    await new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  private async runSplashPreflight(): Promise<void> {
    try {
      const initial = this.uiStore.getState().splashPreflight;
      const presetFailure = initial.checks.find((check) => check.state === "fail");
      if (presetFailure !== undefined) {
        await this.handleStartupFailure({
          summary: presetFailure.detail ?? `${presetFailure.label} failed`,
          scope: `startup.${presetFailure.id}`,
          details: presetFailure.detail,
        });
        return;
      }

      this.setSplashPreflightSummary("starting runner");
      this.updateSplashPreflightCheck("runner", {
        state: "running",
        detail: "launching transport",
      });
      this.client.start();
      this.updateSplashPreflightCheck("runner", {
        state: "ok",
        detail: "local-core",
      });

      const state = this.uiStore.getState();
      this.setSplashPreflightSummary("handshaking session");
      this.updateSplashPreflightCheck("handshake", {
        state: "running",
        detail: state.activeSession.sessionId,
      });
      const describe = await this.client.sendCommand("session.describe", {
        sessionId: state.activeSession.sessionId,
      });
      if (describe.type !== "session.described" || describe.payload.sessionId !== state.activeSession.sessionId) {
        throw new Error("Runner session handshake failed");
      }
      await this.syncSessionFromDescribePayload(describe.payload);
      this.updateSplashPreflightCheck("handshake", {
        state: "ok",
        detail: "session linked",
      });

      this.setSplashPreflightSummary("verifying credentials");
      this.updateSplashPreflightCheck("provider", {
        state: "running",
        detail: "checking env",
      });
      const requiredEnv = resolveRequiredPreflightEnvVars(state.activeProfile, state.activeSession);
      const missingEnv = requiredEnv.filter((envName) => readEnvValue(envName).length === 0);
      if (missingEnv.length > 0) {
        const message = `missing ${missingEnv.join(", ")}`;
        this.updateSplashPreflightCheck("provider", {
          state: "fail",
          detail: message,
        });
        await this.handleStartupFailure({
          summary: message,
          scope: "startup.credentials",
          details: message,
        });
        return;
      }
      this.updateSplashPreflightCheck("provider", {
        state: "ok",
        detail: requiredEnv.join(", "),
      });

      await this.runSplashDatabaseCheck();
      await this.runSplashMcpCheck();

      const latest = this.uiStore.getState().splashPreflight;
      const warned = latest.checks.some((check) => check.state === "warn");
      await this.finalizeSplashPreflightPhase({
        phase: "ready",
        summary: warned ? "pre-flight complete with warnings" : "pre-flight complete",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = this.uiStore.getState().splashPreflight;
      const explicitCheckId = readSplashPreflightErrorCheckId(error);
      const failingCheck = latest.checks.find((check) => check.state === "running");
      const checkId = explicitCheckId ?? failingCheck?.id;
      if (checkId !== undefined) {
        this.updateSplashPreflightCheck(checkId, {
          state: "fail",
          detail: truncatePreflightDetail(message),
        });
      }
      await this.handleStartupFailure({
        summary: truncatePreflightDetail(message),
        scope: `startup.${checkId ?? "unknown"}`,
        error,
      });
    }
  }

  private async finalizeSplashPreflightPhase(input: {
    phase: Extract<SplashPreflightState["phase"], "ready" | "failed">;
    summary: string;
    statusLine?: string | undefined;
  }): Promise<void> {
    const current = this.uiStore.getState().splashPreflight;
    this.uiStore.patch({
      splashPreflight: {
        ...current,
        phase: input.phase,
        summary: input.summary,
      },
      ...(input.statusLine !== undefined ? { statusLine: input.statusLine } : {}),
    });
    await this.autoDismissSplashIfScripted(input.phase);
    if (input.phase === "ready") {
      await this.maybeQueueScriptedInputLines();
    }
  }

  private async maybeQueueScriptedInputLines(): Promise<void> {
    if (this.options.scripted !== true || this.scriptedInputsEnqueued) {
      return;
    }
    const encoded = readEnvValue(SCRIPTED_INPUT_LINES_ENV);
    if (encoded.length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      await this.appendHistoryLine("system", `${SCRIPTED_INPUT_LINES_ENV} was ignored because it is not valid JSON.`);
      this.scriptedInputsEnqueued = true;
      return;
    }

    if (!Array.isArray(parsed)) {
      await this.appendHistoryLine("system", `${SCRIPTED_INPUT_LINES_ENV} was ignored because it must be a JSON array.`);
      this.scriptedInputsEnqueued = true;
      return;
    }

    const lines = parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeSubmittedLine(entry))
      .filter((entry) => entry.trim().length > 0);
    this.scriptedInputsEnqueued = true;
    for (const line of lines) {
      this.enqueueInput(line);
    }
  }

  private async autoDismissSplashIfScripted(
    phase: Extract<SplashPreflightState["phase"], "ready" | "failed">,
  ): Promise<void> {
    if (this.options.scripted !== true) {
      return;
    }
    if (phase !== "ready" && phase !== "failed") {
      return;
    }
    if (this.uiStore.getState().splashVisible === false) {
      return;
    }
    this.uiStore.patch({ splashVisible: false });
    await this.persistUiState();
  }

  private async runSplashMcpCheck(): Promise<void> {
    const state = this.uiStore.getState();
    const configured = (state.activeProfile.mcpServers ?? []).filter((server) => server.enabled !== false);
    if (configured.length === 0) {
      this.updateSplashPreflightCheck("mcp", {
        state: "skip",
        detail: "none configured",
      });
      return;
    }

    this.setSplashPreflightSummary("refreshing mcp");
    this.updateSplashPreflightCheck("mcp", {
      state: "running",
      detail: `${configured.length} configured`,
    });

    try {
      const status = await this.fetchMcpStatus(true);
      const unhealthy = status.servers.filter((server) => server.enabled && server.healthy === false);
      this.updateSplashPreflightCheck("mcp", {
        state: unhealthy.length > 0 ? "warn" : "ok",
        detail: summarizeMcpDetails(status),
      });
    } catch (error) {
      this.updateSplashPreflightCheck("mcp", {
        state: "warn",
        detail: truncatePreflightDetail(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  private async runSplashDatabaseCheck(): Promise<void> {
    await runSplashDatabasePreflight({
      setSummary: (summary) => {
        this.setSplashPreflightSummary(summary);
      },
      updateCheck: (id, update) => {
        this.updateSplashPreflightCheck(id, update);
      },
      truncateDetail: (value) => truncatePreflightDetail(value),
      localCoreStatus: this.localCoreStatus,
      requireDatabaseUrl: false,
    });
  }

  private updateSplashPreflightCheck(
    id: string,
    update: Partial<Pick<SplashPreflightCheck, "state" | "detail">>,
  ): void {
    const current = this.uiStore.getState().splashPreflight;
    this.uiStore.patch({
      splashPreflight: {
        ...current,
        checks: current.checks.map((check) => (check.id === id ? { ...check, ...update } : check)),
      },
    });
  }

  private setSplashPreflightSummary(summary: string): void {
    const current = this.uiStore.getState().splashPreflight;
    this.uiStore.patch({
      splashPreflight: {
        ...current,
        summary,
      },
    });
  }

  private buildController(): InkAppController {
    return {
      getState: () => this.uiStore.getState(),
      subscribe: (listener) => this.uiStore.subscribe(listener),
      getPaletteActions: () => this.getPaletteController().getFilteredActions(this.uiStore.getState()),
      getPaletteTotalCount: () => this.getPaletteController().getTotalCount(this.uiStore.getState()),
      updateViewport: (columns, rows) => {
        const state = this.uiStore.getState();
        const previousLayout = this.getChatLayout(state);
        const previousRows = buildChatVisualRows(state.transcript, previousLayout.wrappedBodyWidth);
        const anchor = resolveChatVisualAnchor(previousRows, state.scroll.chat.cursor);
        const nextLayout = this.getChatLayoutForViewport(state, { columns, rows });
        const nextRows = buildChatVisualRows(state.transcript, nextLayout.wrappedBodyWidth);
        const nextCursor = state.scroll.chat.tailLocked
          ? Math.max(0, nextRows.length - 1)
          : resolveChatVisualCursorFromAnchor(nextRows, anchor);
        const nextChatScroll = ensureChatCursorVisible(
          nextRows,
          {
            ...state.scroll.chat,
            cursor: nextCursor,
          },
          nextLayout.transcriptRows,
        );
        this.uiStore.patch({
          viewport: { columns, rows },
          layoutProfile: deriveLayoutProfile(columns),
          paneSizes: derivePaneSizes(columns),
          scroll: {
            ...state.scroll,
            chat: nextChatScroll,
          },
        });
      },
      cycleFocus: (reverse) => {
        const state = this.uiStore.getState();
        const current = state.activeRegion;
        const next = normalizeDetailRegionForView(state.activeView, cycleRegion(current, reverse));
        this.uiStore.patch({
          activeRegion: next,
          focusRegion: next,
          activeView: next === "details" ? state.activeView : resolveViewForRegion(state.activeView, next),
        });
      },
      setActiveRegion: (region) => {
        const state = this.uiStore.getState();
        const next = normalizeDetailRegionForView(state.activeView, region);
        this.uiStore.patch({
          activeRegion: next,
          focusRegion: next,
          activeView: next === "details" ? state.activeView : resolveViewForRegion(state.activeView, next),
        });
      },
      openContextSearch: () => {
        const state = this.uiStore.getState();
        if (state.activeRegion === "logs") {
          this.uiStore.patch({ logsFilterMode: true });
          return;
        }
        if (state.activeRegion === "sessions") {
          this.uiStore.patch({ sessionsSearchMode: true });
          return;
        }
        this.uiStore.patch({
          paletteOpen: true,
          paletteSource: "manual",
          paletteQuery: "",
          paletteSelectedIndex: 0,
          commandBarReturnRegion: this.resolveCommandBarReturnRegion(state),
          activeRegion: "command_bar",
          focusRegion: "command_bar",
        });
      },
      openSlashPalette: () => {
        const state = this.uiStore.getState();
        this.uiStore.patch({
          logsFilterMode: false,
          sessionsSearchMode: false,
          paletteOpen: true,
          paletteSource: "slash",
          paletteContext: undefined,
          paletteQuery: "",
          paletteSelectedIndex: 0,
          commandBarReturnRegion: this.resolveCommandBarReturnRegion(state),
          helpOpen: false,
          activeRegion: "command_bar",
          focusRegion: "command_bar",
        });
      },
      closeContextSearch: () => {
        const state = this.uiStore.getState();
        const returnRegion = this.resolveCommandBarCloseRegion(state);
        this.uiStore.patch({
          logsFilterMode: false,
          sessionsSearchMode: false,
          paletteOpen: false,
          paletteSource: undefined,
          paletteQuery: "",
          paletteSelectedIndex: 0,
          commandBarReturnRegion: undefined,
          activeRegion: state.activeRegion === "command_bar" ? returnRegion : state.activeRegion,
          focusRegion: state.activeRegion === "command_bar" ? returnRegion : state.activeRegion,
        });
      },
      moveActiveSelection: (delta) => {
        const state = this.uiStore.getState();
        if (state.activeView === "tasks" && state.activeRegion === "sessions") {
          const tasks = this.listChildTaskSessions(state.activeSession.sessionId);
          const next = moveCursor(
            state.taskScroll,
            tasks.length,
            delta,
            this.getListRowsForScroll(state, "tasks"),
          );
          this.uiStore.patch({ taskScroll: next });
          return;
        }
        if (state.activeView === "history" && state.activeRegion === "sessions") {
          const entries = this.buildHistoryHomeEntries(state);
          const next = moveCursor(
            state.scroll.sessions,
            entries.length,
            delta,
            this.getListRowsForScroll(state, "sessions"),
          );
          this.uiStore.patchScroll("sessions", next);
          return;
        }
        if (
          (state.activeView === "workspace" ||
            state.activeView === "mcp" ||
            state.activeView === "code" ||
            state.activeView === "delegation" ||
            state.activeView === "recovery") &&
          state.activeRegion === "sessions"
        ) {
          const snapshot = this.buildWorkspaceSnapshotForView(state);
          const actions = snapshot === undefined ? [] : snapshot.primaryActions.concat(snapshot.secondaryActions);
          const next = moveCursor(
            state.scroll.sessions,
            actions.length,
            delta,
            this.getListRowsForScroll(state, "sessions"),
          );
          this.uiStore.patchScroll("sessions", next);
          return;
        }
        if (state.activeRegion === "sessions") {
          const filtered = this.selectors.filterSessions(state.sessions, state.sessionQuery);
          const next = moveCursor(
            state.scroll.sessions,
            filtered.length,
            delta,
            this.getListRowsForScroll(state, "sessions"),
          );
          this.uiStore.patchScroll("sessions", next);
          return;
        }
        if (state.activeRegion === "logs") {
          const filtered = this.selectors.filterLogs(state.runLogs, state.logFilters);
          const next = moveCursor(
            state.scroll.logs,
            filtered.length,
            delta,
            this.getListRowsForScroll(state, "logs"),
          );
          const atEnd = next.cursor >= Math.max(0, filtered.length - 1);
          this.uiStore.patchScroll("logs", { ...next, tailLocked: atEnd });
          return;
        }
        if (
          state.activeRegion === "chat_list" ||
          state.activeRegion === "details" ||
          state.activeRegion === "composer"
        ) {
          const chatVisualRows = this.getChatVisualRowCount(state);
          const candidate = moveCursor(
            state.scroll.chat,
            chatVisualRows,
            delta,
            this.getListRowsForScroll(state, "chat"),
          );
          const next = ensureChatCursorVisible(
            buildChatVisualRows(state.transcript, this.getChatLayout(state).wrappedBodyWidth),
            candidate,
            this.getListRowsForScroll(state, "chat"),
          );
          const atEnd = isAtTail(next, chatVisualRows);
          this.uiStore.patch({
            scroll: {
              ...state.scroll,
              chat: next,
            },
            chatUnreadCount: atEnd ? 0 : state.chatUnreadCount,
          });
          return;
        }
        if (state.activeRegion === "command_bar") {
          const list = this.getPaletteController().getFilteredActions(state);
          const next = clampIndex(state.paletteSelectedIndex + delta, list.length);
          this.uiStore.patch({ paletteSelectedIndex: next });
        }
      },
      pageActiveSelection: (direction) => {
        const state = this.uiStore.getState();
        if (state.activeView === "tasks" && state.activeRegion === "sessions") {
          const tasks = this.listChildTaskSessions(state.activeSession.sessionId);
          const next = pageCursor(
            state.taskScroll,
            tasks.length,
            this.getListRowsForScroll(state, "tasks"),
            direction,
          );
          this.uiStore.patch({ taskScroll: next });
          return;
        }
        if (state.activeView === "history" && state.activeRegion === "sessions") {
          const entries = this.buildHistoryHomeEntries(state);
          const next = pageCursor(
            state.scroll.sessions,
            entries.length,
            this.getListRowsForScroll(state, "sessions"),
            direction,
          );
          this.uiStore.patchScroll("sessions", next);
          return;
        }
        if (
          (state.activeView === "workspace" ||
            state.activeView === "mcp" ||
            state.activeView === "code" ||
            state.activeView === "delegation" ||
            state.activeView === "recovery") &&
          state.activeRegion === "sessions"
        ) {
          const snapshot = this.buildWorkspaceSnapshotForView(state);
          const actions = snapshot === undefined ? [] : snapshot.primaryActions.concat(snapshot.secondaryActions);
          const next = pageCursor(
            state.scroll.sessions,
            actions.length,
            this.getListRowsForScroll(state, "sessions"),
            direction,
          );
          this.uiStore.patchScroll("sessions", next);
          return;
        }
        if (state.activeRegion === "sessions") {
          const filtered = this.selectors.filterSessions(state.sessions, state.sessionQuery);
          const next = pageCursor(
            state.scroll.sessions,
            filtered.length,
            this.getListRowsForScroll(state, "sessions"),
            direction,
          );
          this.uiStore.patchScroll("sessions", next);
          return;
        }
        if (state.activeRegion === "logs") {
          const filtered = this.selectors.filterLogs(state.runLogs, state.logFilters);
          const next = pageCursor(
            state.scroll.logs,
            filtered.length,
            this.getListRowsForScroll(state, "logs"),
            direction,
          );
          const atEnd = next.cursor >= Math.max(0, filtered.length - 1);
          this.uiStore.patchScroll("logs", { ...next, tailLocked: atEnd });
          return;
        }
        if (
          state.activeRegion === "chat_list" ||
          state.activeRegion === "details" ||
          state.activeRegion === "composer"
        ) {
          const chatVisualRows = this.getChatVisualRowCount(state);
          const candidate = pageCursor(
            state.scroll.chat,
            chatVisualRows,
            this.getListRowsForScroll(state, "chat"),
            direction,
          );
          const next = ensureChatCursorVisible(
            buildChatVisualRows(state.transcript, this.getChatLayout(state).wrappedBodyWidth),
            candidate,
            this.getListRowsForScroll(state, "chat"),
          );
          const atEnd = isAtTail(next, chatVisualRows);
          this.uiStore.patch({
            scroll: {
              ...state.scroll,
              chat: next,
            },
            chatUnreadCount: atEnd ? 0 : state.chatUnreadCount,
          });
        }
      },
      jumpActiveSelection: (to) => {
        const state = this.uiStore.getState();
        if (state.activeView === "tasks" && state.activeRegion === "sessions") {
          const tasks = this.listChildTaskSessions(state.activeSession.sessionId);
          const next = jumpCursor(
            state.taskScroll,
            tasks.length,
            this.getListRowsForScroll(state, "tasks"),
            to,
          );
          this.uiStore.patch({ taskScroll: next });
          return;
        }
        if (state.activeView === "history" && state.activeRegion === "sessions") {
          const entries = this.buildHistoryHomeEntries(state);
          const next = jumpCursor(
            state.scroll.sessions,
            entries.length,
            this.getListRowsForScroll(state, "sessions"),
            to,
          );
          this.uiStore.patchScroll("sessions", next);
          return;
        }
        if (
          (state.activeView === "workspace" ||
            state.activeView === "mcp" ||
            state.activeView === "code" ||
            state.activeView === "delegation" ||
            state.activeView === "recovery") &&
          state.activeRegion === "sessions"
        ) {
          const snapshot = this.buildWorkspaceSnapshotForView(state);
          const actions = snapshot === undefined ? [] : snapshot.primaryActions.concat(snapshot.secondaryActions);
          const next = jumpCursor(
            state.scroll.sessions,
            actions.length,
            this.getListRowsForScroll(state, "sessions"),
            to,
          );
          this.uiStore.patchScroll("sessions", next);
          return;
        }
        if (state.activeRegion === "sessions") {
          const filtered = this.selectors.filterSessions(state.sessions, state.sessionQuery);
          const next = jumpCursor(
            state.scroll.sessions,
            filtered.length,
            this.getListRowsForScroll(state, "sessions"),
            to,
          );
          this.uiStore.patchScroll("sessions", next);
          return;
        }
        if (state.activeRegion === "logs") {
          const filtered = this.selectors.filterLogs(state.runLogs, state.logFilters);
          const next = jumpCursor(
            state.scroll.logs,
            filtered.length,
            this.getListRowsForScroll(state, "logs"),
            to,
          );
          this.uiStore.patchScroll("logs", {
            ...next,
            tailLocked: to === "end",
          });
          return;
        }
        if (
          state.activeRegion === "chat_list" ||
          state.activeRegion === "details" ||
          state.activeRegion === "composer"
        ) {
          const chatVisualRows = this.getChatVisualRowCount(state);
          const candidate = jumpCursor(
            state.scroll.chat,
            chatVisualRows,
            this.getListRowsForScroll(state, "chat"),
            to,
          );
          const next = ensureChatCursorVisible(
            buildChatVisualRows(state.transcript, this.getChatLayout(state).wrappedBodyWidth),
            candidate,
            this.getListRowsForScroll(state, "chat"),
          );
          this.uiStore.patch({
            scroll: {
              ...state.scroll,
              chat: next,
            },
            chatUnreadCount: to === "end" ? 0 : state.chatUnreadCount,
          });
        }
      },
      activatePrimaryAction: () => {
        const state = this.uiStore.getState();
        if (state.activeView === "tasks" && state.activeRegion === "sessions") {
          const tasks = this.listChildTaskSessions(state.activeSession.sessionId);
          const selected = tasks[state.taskScroll.cursor];
          if (selected !== undefined) {
            void this.switchSession(selected.name);
          }
          return;
        }
        if (state.activeView === "history" && state.activeRegion === "sessions") {
          const entries = this.buildHistoryHomeEntries(state);
          const selected = entries[state.scroll.sessions.cursor];
          if (selected !== undefined) {
            if (selected.id === "nav.back.history") {
              this.goBack();
              return;
            }
            void this.switchSession(selected.title);
          }
          return;
        }
        if (
          (state.activeView === "workspace" ||
            state.activeView === "mcp" ||
            state.activeView === "code" ||
            state.activeView === "delegation" ||
            state.activeView === "recovery") &&
          state.activeRegion === "sessions"
        ) {
          const snapshot = this.buildWorkspaceSnapshotForView(state);
          if (snapshot === undefined) {
            return;
          }
          const actions = snapshot.primaryActions.concat(snapshot.secondaryActions);
          const selected = actions[state.scroll.sessions.cursor];
          if (selected?.id === "nav.back") {
            this.goBack();
            return;
          }
          if (selected?.id === "view.history") {
            this.navigateToView("history", { remember: true });
            return;
          }
          if (selected?.command !== undefined) {
            void this.submitInput(selected.command);
            return;
          }
          if (selected?.draft !== undefined) {
            this.uiStore.patch({
              activeView: "chat",
              activeRegion: "composer",
              focusRegion: "composer",
              chatDraft: selected.draft,
              navigationStack: [],
            });
            void this.persistUiState();
          }
          return;
        }
        if (state.activeRegion === "sessions") {
          const filtered = this.selectors.filterSessions(state.sessions, state.sessionQuery);
          const selected = filtered[state.scroll.sessions.cursor];
          if (selected !== undefined) {
            void this.switchSession(selected.name);
          }
          return;
        }
        if (state.activeRegion === "logs") {
          const filtered = this.selectors.filterLogs(state.runLogs, state.logFilters);
          const selected = filtered[state.scroll.logs.cursor];
          if (selected?.runId !== undefined) {
            this.uiStore.patch({
              chatHighlightRunId: selected.runId,
            });
            this.jumpChatToHighlightedRun();
            this.uiStore.patch({
              activeView: "chat",
              activeRegion: "chat_list",
              focusRegion: "chat_list",
              detailDrawer: {
                ...state.detailDrawer,
                open: false,
                source: "chat",
              },
            });
          }
          return;
        }
        if (state.activeRegion === "command_bar") {
          const list = this.getPaletteController().getFilteredActions(state);
          const selected = list[state.paletteSelectedIndex];
          if (selected === undefined) {
            return;
          }
          this.activatePaletteAction(selected, state);
        }
      },
      goBack: () => {
        this.goBack();
      },
      submitLine: (line) => {
        const normalized = normalizeSubmittedLine(line);
        const state = this.uiStore.getState();
        if (normalized.trim() === "/") {
          this.resetComposerSubmissionGuard();
          this.uiStore.patch({
            chatDraft: "",
            paletteOpen: true,
            paletteSource: "slash",
            paletteQuery: "",
            paletteSelectedIndex: 0,
            commandBarReturnRegion: this.resolveCommandBarReturnRegion(state),
            helpOpen: false,
            activeRegion: "command_bar",
            focusRegion: "command_bar",
          });
          return;
        }

        // Enter submission belongs to the TextInput; this app-layer guard only backstops
        // repeated same-event submits until the draft changes again.
        if (this.consumeComposerSubmission(state.activeSession.sessionId, normalized) === false) {
          return;
        }
        this.uiStore.patch({ chatDraft: "", quitConfirm: false });
        this.submitInput(normalized);
      },
      setDraft: (value) => {
        this.resetComposerSubmissionGuard();
        if (value === "/") {
          this.uiStore.patch({
            chatDraft: "",
            quitConfirm: false,
            paletteOpen: true,
            paletteSource: "slash",
            paletteQuery: "",
            paletteSelectedIndex: 0,
            commandBarReturnRegion: this.resolveCommandBarReturnRegion(this.uiStore.getState()),
            helpOpen: false,
            activeRegion: "command_bar",
            focusRegion: "command_bar",
          });
          return;
        }
        this.uiStore.patch({ chatDraft: value, quitConfirm: false });
      },
      appendDraftLineBreak: () => {
        this.resetComposerSubmissionGuard();
        const state = this.uiStore.getState();
        this.uiStore.patch({ chatDraft: `${state.chatDraft}\n` });
      },
      clearDraft: () => {
        this.resetComposerSubmissionGuard();
        this.uiStore.patch({ chatDraft: "" });
      },
      dismissSplash: () => {
        const state = this.uiStore.getState();
        if (state.splashVisible === false) {
          return;
        }
        if (state.splashPreflight.phase !== "ready") {
          return;
        }
        this.uiStore.patch({ splashVisible: false });
        void this.persistUiState();
        void this.runBootstrapHandoff();
      },
      toggleDetailDrawer: () => {
        const state = this.uiStore.getState();
        if (state.activeView === "chat") {
          const fallbackRegion: FocusRegion = "composer";
          this.uiStore.patch({
            detailDrawer: {
              ...state.detailDrawer,
              open: false,
            },
            activeRegion: state.activeRegion === "details" ? fallbackRegion : state.activeRegion,
            focusRegion: state.activeRegion === "details" ? fallbackRegion : state.focusRegion,
          });
          void this.persistUiState();
          return;
        }
        const nextOpen =
          state.detailDrawer.source === state.activeView ? !state.detailDrawer.open : true;
        const fallbackRegion: FocusRegion =
          state.activeView === "sessions" ||
          state.activeView === "history" ||
          state.activeView === "workspace" ||
          state.activeView === "mcp" ||
          state.activeView === "code" ||
          state.activeView === "delegation" ||
          state.activeView === "recovery" ||
          state.activeView === "tasks"
            ? "sessions"
            : state.activeView === "logs"
              ? "logs"
              : "chat_list";
        this.uiStore.patch({
          detailDrawer: {
            ...state.detailDrawer,
            open: nextOpen,
            source: state.activeView,
          },
          activeRegion: nextOpen ? "details" : fallbackRegion,
          focusRegion: nextOpen ? "details" : fallbackRegion,
        });
        void this.persistUiState();
      },
      toggleHelp: () => {
        const state = this.uiStore.getState();
        this.uiStore.patch({ helpOpen: !state.helpOpen });
      },
      openPalette: () => {
        const state = this.uiStore.getState();
        this.uiStore.patch({
          paletteOpen: true,
          paletteSource: "manual",
          paletteContext: undefined,
          paletteQuery: "",
          paletteSelectedIndex: 0,
          commandBarReturnRegion: this.resolveCommandBarReturnRegion(state),
          helpOpen: false,
          activeRegion: "command_bar",
          focusRegion: "command_bar",
        });
      },
      closePalette: () => {
        const state = this.uiStore.getState();
        const returnRegion = this.resolveCommandBarCloseRegion(state);
        this.uiStore.patch({
          paletteOpen: false,
          paletteSource: undefined,
          paletteContext: undefined,
          paletteQuery: "",
          paletteSelectedIndex: 0,
          commandBarReturnRegion: undefined,
          activeRegion: returnRegion,
          focusRegion: returnRegion,
        });
      },
      focusComposerWithInput: (input) => {
        const state = this.uiStore.getState();
        this.resetComposerSubmissionGuard();
        this.uiStore.patch({
          activeView: "chat",
          activeRegion: "composer",
          focusRegion: "composer",
          chatDraft: `${state.chatDraft}${input}`,
          quitConfirm: false,
        });
      },
      setPaletteQuery: (value) => {
        const state = this.uiStore.getState();
        const matches = this.selectors.filterPaletteActions(
          this.getPaletteController().getActions(state),
          value,
          8,
        );
        if (state.paletteSource === "slash" && value.trim().length > 0 && matches.length === 0) {
          const returnRegion = this.resolveCommandBarCloseRegion(state);
          this.uiStore.patch({
            chatDraft: "",
            paletteOpen: false,
            paletteSource: undefined,
            paletteContext: undefined,
            paletteQuery: "",
            paletteSelectedIndex: 0,
            commandBarReturnRegion: undefined,
            activeRegion: returnRegion,
            focusRegion: returnRegion,
          });
          return;
        }
        this.uiStore.patch({ paletteQuery: value, paletteSelectedIndex: 0 });
      },
      movePaletteSelection: (delta) => {
        const state = this.uiStore.getState();
        const list = this.getPaletteController().getFilteredActions(state);
        const next = clampIndex(state.paletteSelectedIndex + delta, list.length);
        this.uiStore.patch({ paletteSelectedIndex: next });
      },
      executePaletteSelection: () => {
        const state = this.uiStore.getState();
        const list = this.getPaletteController().getFilteredActions(state);
        const selected = list[state.paletteSelectedIndex];
        if (selected === undefined) {
          return;
        }
        this.activatePaletteAction(selected, state);
        void this.persistUiState();
      },
      toggleErrorDetails: () => {
        const state = this.uiStore.getState();
        if (state.errorOverlay === undefined) {
          return;
        }
        this.uiStore.patch({
          errorDetailsExpanded: !state.errorDetailsExpanded,
          errorScrollOffset: 0,
        });
      },
      moveErrorScroll: (delta) => {
        const state = this.uiStore.getState();
        if (state.errorOverlay === undefined) {
          return;
        }
        this.uiStore.patch({
          errorScrollOffset: Math.max(0, state.errorScrollOffset + delta),
        });
      },
      pageErrorScroll: (direction) => {
        const state = this.uiStore.getState();
        if (state.errorOverlay === undefined) {
          return;
        }
        const step = Math.max(1, Math.floor(state.viewport.rows * 0.6));
        this.uiStore.patch({
          errorScrollOffset: Math.max(
            0,
            state.errorScrollOffset + (direction === "down" ? step : -step),
          ),
        });
      },
      jumpErrorScroll: (to) => {
        const state = this.uiStore.getState();
        if (state.errorOverlay === undefined) {
          return;
        }
        this.uiStore.patch({
          errorScrollOffset: to === "start" ? 0 : Number.MAX_SAFE_INTEGER,
        });
      },
      toggleLogsPause: () => {
        const state = this.uiStore.getState();
        const paused = !state.logFilters.paused;
        const filtered = this.selectors.filterLogs(state.runLogs, state.logFilters);
        let logsScroll = state.scroll.logs;
        if (paused === false && logsScroll.tailLocked) {
          logsScroll = ensureCursorVisible(
            {
              ...logsScroll,
              cursor: Math.max(0, filtered.length - 1),
            },
            filtered.length,
            this.getListRowsForScroll(state, "logs"),
          );
        }
        this.uiStore.patch({
          logFilters: {
            ...state.logFilters,
            paused,
          },
          scroll: {
            ...state.scroll,
            logs: logsScroll,
          },
        });
        void this.persistUiState();
      },
      toggleLogsGrouped: () => {
        const state = this.uiStore.getState();
        this.uiStore.patch({
          logFilters: {
            ...state.logFilters,
            grouped: !state.logFilters.grouped,
          },
        });
        void this.persistUiState();
      },
      cycleLogLevel: () => {
        const state = this.uiStore.getState();
        const levels: Array<UiRuntimeState["logFilters"]["level"]> = ["ALL", "INFO", "WARN", "ERROR"];
        const current = levels.indexOf(state.logFilters.level);
        const next = levels[(current + 1) % levels.length] ?? "ALL";
        this.uiStore.patch({
          logFilters: {
            ...state.logFilters,
            level: next,
          },
        });
      },
      setLogEventQuery: (value) => {
        const state = this.uiStore.getState();
        const nextFilters = {
          ...state.logFilters,
          eventQuery: value,
        };
        const filtered = this.selectors.filterLogs(state.runLogs, nextFilters);
        const nextScroll = ensureCursorVisible(
          {
            ...state.scroll.logs,
            cursor: Math.min(state.scroll.logs.cursor, Math.max(0, filtered.length - 1)),
          },
          filtered.length,
          this.getListRowsForScroll(state, "logs"),
        );
        this.uiStore.patch({
          logFilters: nextFilters,
          scroll: {
            ...state.scroll,
            logs: nextScroll,
          },
        });
      },
      setSessionQuery: (value) => {
        const state = this.uiStore.getState();
        const filtered = this.selectors.filterSessions(state.sessions, value);
        const nextScroll = ensureCursorVisible(
          {
            ...state.scroll.sessions,
            offset: 0,
            cursor: 0,
          },
          filtered.length,
          this.getListRowsForScroll(state, "sessions"),
        );
        this.uiStore.patch({
          sessionQuery: value,
          scroll: {
            ...state.scroll,
            sessions: nextScroll,
          },
        });
      },
      createSession: () => {
        const stamp = new Date().toISOString().replace(/[^\d]/gu, "").slice(0, 14);
        const name = `session-${stamp}`;
        void this.createSessionFromName(name);
      },
      dismissError: () => {
        this.uiStore.patch({
          errorOverlay: undefined,
          errorDetailsExpanded: false,
          errorScrollOffset: 0,
        });
      },
      requestQuit: () => {
        this.uiStore.patch({
          quitConfirm: true,
          statusLine: this.withMcpSummary("Press Ctrl+C again to quit"),
        });
      },
      confirmQuit: () => {
        void this.shutdown();
      },
    };
  }

  private enqueueInput(line: string): void {
    if (this.stopped) {
      return;
    }
    this.inputQueue.push(line);
    void this.drainQueue();
  }

  private submitInput(line: string): void {
    if (this.shouldDispatchImmediateOperatorCommand(line)) {
      void this.handleLine(line).catch((error: unknown) => {
        void this.handleInputProcessingFailure(line, error);
      });
      return;
    }
    this.enqueueInput(line);
  }

  private shouldDispatchImmediateOperatorCommand(line: string): boolean {
    return this.uiStore.getState().running === true && isInteractiveOperatorCommandDraft(line);
  }

  private consumeComposerSubmission(sessionId: string, line: string): boolean {
    const previous = this.lastComposerSubmission;
    if (previous?.sessionId === sessionId && previous.line === line) {
      return false;
    }
    this.lastComposerSubmission = {
      sessionId,
      line,
    };
    return true;
  }

  private resetComposerSubmissionGuard(): void {
    this.lastComposerSubmission = undefined;
  }

  private getPaletteController(): PaletteController {
    if (this.paletteController === undefined) {
      this.paletteController = new PaletteController({
        selectors: this.selectors,
        getState: () => this.uiStore.getState(),
        getStartTaskJourney: () => this.startTaskJourney,
        getActiveWorkspace: () => this.activeWorkspace,
        patchState: (next) => {
          this.uiStore.patch(next);
        },
        handleStartTaskPaletteSelection: (selected) =>
          this.handleStartTaskPaletteSelection(selected),
        navigateToView: (view, options) => {
          this.navigateToView(view, options);
        },
        jumpChatToLatest: () => {
          this.jumpChatToLatest();
        },
        jumpChatToHighlightedRun: () => {
          this.jumpChatToHighlightedRun();
        },
        submitInput: (command) => {
          this.submitInput(command);
        },
      });
    }
    return this.paletteController;
  }

  private activatePaletteAction(selected: PaletteCommand, state: UiRuntimeState): void {
    this.getPaletteController().activate(selected, state);
  }

  private getSessionController(): SessionController {
    if (this.sessionController === undefined) {
      this.sessionController = new SessionController({
        ...this.getAppContext(),
        saveSessionsFile: () => this.saveSessionsFile(),
        createSessionMeta: (launch, profile, workspace) =>
          this.createSessionMeta(launch, profile, workspace),
        buildSessionOperatorState: (input) => this.buildSessionOperatorState(input),
        resolveWorkspaceForSession: (session) => this.resolveWorkspaceForSession(session),
        syncSessionFromDescribePayload: (payload) => this.syncSessionFromDescribePayload(payload),
        startActiveTurn: (input) => this.startActiveTurn(input),
        getChatWrappedBodyWidth: () => this.getChatLayout(this.uiStore.getState()).wrappedBodyWidth,
        getChatListRows: () => this.getListRowsForScroll(this.uiStore.getState(), "chat"),
      });
    }
    return this.sessionController;
  }

  private getWorkspaceController(): WorkspaceController {
    if (this.workspaceController === undefined) {
      this.workspaceController = new WorkspaceController({
        ...this.getAppContext(),
        recordStartupNotices: (notices) => {
          this.startupNotices.push(...notices);
        },
      });
    }
    return this.workspaceController;
  }

  private getMcpController(): McpController {
    if (this.mcpController === undefined) {
      this.mcpController = new McpController({
        ...this.getAppContext(),
        fetchMcpStatus: (refresh) => this.fetchMcpStatus(refresh),
      });
    }
    return this.mcpController;
  }

  private getCodeModeController(): CodeModeController {
    if (this.codeModeController === undefined) {
      this.codeModeController = new CodeModeController(this.getAppContext());
    }
    return this.codeModeController;
  }

  private getOperatorController(): OperatorController {
    if (this.operatorController === undefined) {
      this.operatorController = new OperatorController({
        ...this.getAppContext(),
        cancelActiveRun: () => this.getRunController().cancelActiveRun(),
        applyOperatorControlResponse: (action, payload) =>
          this.applyOperatorControlResponse(action, payload),
        refreshCurrentSessionDescribe: () => this.refreshCurrentSessionDescribe(),
        refreshWorkspaceCheckpointList: () => this.refreshWorkspaceCheckpointList(),
        beginChildMissionJourney: () => this.beginChildMissionJourney(),
      });
    }
    return this.operatorController;
  }

  private getRunController(): TuiRunController {
    if (this.runController === undefined) {
      this.runController = new TuiRunController({
        ...this.getAppContext(),
        refreshWorkspaceForActiveSession: () => this.refreshWorkspaceForActiveSession(),
        shouldApplyCompactionOnContinuationResume: (session) =>
          this.shouldApplyCompactionOnContinuationResume(session),
        buildSessionOperatorState: (input) => this.buildSessionOperatorState(input),
        appendDiagnosticsLog: (input) => this.appendDiagnosticsLog(input),
        handleTaskUpdatedEvent: (task, kind, assistantText, finalizedPayload) =>
          this.handleTaskUpdatedEvent(task, kind, assistantText, finalizedPayload),
        syncBackgroundSessionProgress: (sessionId) => this.syncBackgroundSessionProgress(sessionId),
        syncBackgroundSessionResult: (output, assistantText, finalizedPayload, operatorState) =>
          this.syncBackgroundSessionResult(output, assistantText, finalizedPayload, operatorState),
        syncBackgroundSessionFailure: (sessionId, message) =>
          this.syncBackgroundSessionFailure(sessionId, message),
        clearProgressForRun: (runId) => {
          this.clearProgressForRun(runId);
        },
        pushRunLog: (line) => {
          this.pushRunLog(line);
        },
        enqueueAgentProgressTranscriptUpdate: (update) => {
          this.enqueueAgentProgressTranscriptUpdate(update);
        },
      });
    }
    return this.runController;
  }

  private jumpChatToLatest(): void {
    const state = this.uiStore.getState();
    const chatLayout = this.getChatLayout(state);
    const rows = buildChatVisualRows(state.transcript, chatLayout.wrappedBodyWidth);
    const total = rows.length;
    const next = ensureChatCursorVisible(
      rows,
      {
        ...state.scroll.chat,
        cursor: Math.max(0, total - 1),
        tailLocked: true,
      },
      this.getListRowsForScroll(state, "chat"),
    );
    this.uiStore.patch({
      activeView: "chat",
      activeRegion: "chat_list",
      focusRegion: "chat_list",
      navigationStack: [],
      chatUnreadCount: 0,
      paletteOpen: false,
      paletteSource: undefined,
      paletteContext: undefined,
      paletteQuery: "",
      paletteSelectedIndex: 0,
      commandBarReturnRegion: undefined,
      scroll: {
        ...state.scroll,
        chat: next,
      },
    });
  }

  private jumpChatToHighlightedRun(): void {
    const state = this.uiStore.getState();
    if (state.chatHighlightRunId === undefined) {
      this.jumpChatToLatest();
      return;
    }

    const transcriptIndex = state.transcript.findIndex(
      (line) => line.run?.runId === state.chatHighlightRunId,
    );
    if (transcriptIndex < 0) {
      this.jumpChatToLatest();
      return;
    }

    const chatLayout = this.getChatLayout(state);
    const rows = buildChatVisualRows(state.transcript, chatLayout.wrappedBodyWidth);
    const nextScroll =
      buildTranscriptStartScroll({
        rows,
        transcriptIndex,
        listRows: this.getListRowsForScroll(state, "chat"),
      }) ??
      ensureChatCursorVisible(
        rows,
        {
          ...state.scroll.chat,
          tailLocked: false,
        },
        this.getListRowsForScroll(state, "chat"),
      );
    this.uiStore.patch({
      activeView: "chat",
      activeRegion: "chat_list",
      focusRegion: "chat_list",
      navigationStack: [],
      paletteOpen: false,
      paletteSource: undefined,
      paletteContext: undefined,
      paletteQuery: "",
      paletteSelectedIndex: 0,
      commandBarReturnRegion: undefined,
      scroll: {
        ...state.scroll,
        chat: nextScroll,
      },
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.processingQueue || this.stopped || this.uiStore.getState().running === true) {
      return;
    }

    this.processingQueue = true;
    try {
      while (
        this.inputQueue.length > 0 &&
        this.stopped === false &&
        this.uiStore.getState().running === false
      ) {
        const line = this.inputQueue.shift();
        if (line === undefined) {
          continue;
        }
        try {
          await this.handleLine(line);
        } catch (error) {
          await this.handleInputProcessingFailure(line, error);
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private async handleInputProcessingFailure(line: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const code = readErrorCode(error) ?? "INPUT_PROCESSING_FAILED";
    const details = readErrorDetails(error);
    await this.appendHistoryLine(
      "system",
      `Input failed: ${message}`,
      {
        input: line,
        code,
        ...(details !== undefined ? { details } : {}),
      },
    );
    this.uiStore.patch({
      running: false,
      statusLine: this.withMcpSummary("failed"),
      activeProgressByRun: {},
      latestProgressForSession: undefined,
      latestReasoningForSession: undefined,
      errorOverlay: {
        message,
        code,
        ...(details !== undefined ? { details } : {}),
      },
      errorScrollOffset: 0,
    });
    await this.persistSessionAndUi();
  }

  private async beginStartTaskJourney(): Promise<void> {
    const profiles = await this.profileStore.load();
    const availableWorkspaces = await this.listDiscoveredWorkspaces();
    const state = this.uiStore.getState();
    const defaultWorkspace = this.activeWorkspace ?? this.launchWorkspace;
    this.startTaskJourney = {
      step: "template",
      profile: state.activeProfile,
      availableProfiles: profiles,
      availableWorkspaces,
      workspace: defaultWorkspace,
      workspaceBinding: defaultWorkspace !== undefined ? "active" : "detached",
    };
    const launchSetup = buildOperatorLaunchSetup({
      profileLabel: state.activeProfile.label,
      workspaceLabel: describeResolvedWorkspace(defaultWorkspace),
      ...(defaultWorkspace?.rootPath !== undefined ? { workspaceRoot: defaultWorkspace.rootPath } : {}),
    });
    await this.appendHistoryLine(
      "system",
      [
        "Start task journey",
        `Workspace: ${describeResolvedWorkspace(defaultWorkspace)}`,
        `Profile: ${state.activeProfile.id}`,
        `Policy: approval ${launchSetup.approvalPosture} · code ${launchSetup.codePosture}`,
        `Execution boundary: ${launchSetup.executionBoundarySummary}`,
        "Choose template, preset, and workspace in the palette. Type '/cancel' to stop.",
      ].join("\n"),
    );
    this.openStartTaskChooserForStep("template");
  }

  private async handleStartTaskJourneyInput(rawLine: string): Promise<boolean> {
    const journey = this.startTaskJourney;
    if (journey === undefined) {
      return false;
    }

    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      await this.appendHistoryLine("system", "Start task expects a value for this step. Type '/cancel' to exit.");
      return true;
    }

    if (trimmed === "/cancel") {
      this.startTaskJourney = undefined;
      await this.appendHistoryLine("system", "Cancelled start task journey.");
      return true;
    }

    if (trimmed.startsWith("/")) {
      await this.appendHistoryLine(
        "system",
        "Start task expects plain input for each step. Type '/cancel' to exit the launcher.",
      );
      return true;
    }

    if (journey.step === "template") {
      if (trimmed !== "none" && getOperatorTaskTemplate(trimmed as StartTaskJourneyState["templateId"]) === undefined) {
        await this.appendHistoryLine(
          "system",
          "Unknown template. Use none, coding-task, investigation-task, review-task, or orchestration-task.",
        );
        return true;
      }
      journey.templateId = trimmed === "none" ? undefined : trimmed as StartTaskJourneyState["templateId"];
      const template = getOperatorTaskTemplate(journey.templateId);
      if (template !== undefined) {
        journey.presetId = template.presetId;
        journey.title = template.defaultTitle;
        journey.interactionMode = toCanonicalInteractionMode(template.interactionMode);
        journey.actSubmode = template.actSubmode;
      }
      journey.step = "preset";
      await this.appendHistoryLine(
        "system",
        [
          `Template: ${template?.label ?? "None"}`,
          "Select a preset: none, coding, investigation, review, orchestration.",
        ].join("\n"),
      );
      return true;
    }

    if (journey.step === "preset") {
      const preset = trimmed === "none" ? undefined : listOperatorProfilePresets().find((entry) => entry.id === trimmed);
      if (trimmed !== "none" && preset === undefined) {
        await this.appendHistoryLine("system", "Unknown preset. Use none, coding, investigation, review, or orchestration.");
        return true;
      }
      journey.presetId = preset?.id;
      if (preset !== undefined) {
        journey.interactionMode = toCanonicalInteractionMode(preset.interactionMode);
        journey.actSubmode = preset.actSubmode;
      }
      journey.step = "workspace";
      await this.appendHistoryLine(
        "system",
        [
          `Preset: ${preset?.label ?? "None"}`,
          `Select workspace [default: ${journey.workspaceBinding}] using detached, active/current, or a discovered workspace id/root.`,
          ...(journey.availableWorkspaces.length > 0
            ? journey.availableWorkspaces.map((workspace) => `- ${workspace.manifest.workspaceId}: ${workspace.rootPath}`)
            : ["- no discovered workspaces"]),
        ].join("\n"),
      );
      return true;
    }

    if (journey.step === "workspace") {
      const selection = this.resolveWorkspaceSelection(trimmed, journey.availableWorkspaces);
      if (selection.kind === "invalid") {
        await this.appendHistoryLine(
          "system",
          "Invalid workspace selection. Use detached, active/current, or a discovered workspace id/root.",
        );
        return true;
      }
      if (selection.kind === "active") {
        const currentWorkspace = this.activeWorkspace ?? this.launchWorkspace;
        if (currentWorkspace === undefined) {
          await this.appendHistoryLine("system", "No active workspace is available. Use detached or a discovered workspace id/root.");
          return true;
        }
        journey.workspaceBinding = "active";
        journey.workspace = currentWorkspace;
      } else if (selection.kind === "detached") {
        journey.workspaceBinding = "detached";
        journey.workspace = undefined;
      } else if (selection.kind === "workspace") {
        journey.workspaceBinding = "active";
        journey.workspace = selection.workspace;
      } else {
        await this.appendHistoryLine(
          "system",
          "Invalid workspace selection. Use detached, active/current, or a discovered workspace id/root.",
        );
        return true;
      }
      journey.step = "title";
      await this.appendHistoryLine(
        "system",
        [
          `Workspace: ${journey.workspaceBinding === "active" ? describeResolvedWorkspace(journey.workspace) : "Detached workspace"}`,
          `Enter a task title [default: ${journey.title ?? "none"}].`,
        ].join("\n"),
      );
      return true;
    }

    if (journey.step === "title") {
      if (trimmed === "default" && journey.title === undefined) {
        await this.appendHistoryLine("system", "No default task title is available yet. Enter a title.");
        return true;
      }
      const resolvedTitle = trimmed === "default" && journey.title !== undefined ? journey.title : trimmed;
      journey.title = resolvedTitle;
      journey.step = "profile";
      await this.appendHistoryLine(
        "system",
        [
          `Task: ${resolvedTitle}`,
          `Select profile [default: ${journey.profile?.id ?? "none"}]`,
          ...journey.availableProfiles.map((profile) => `- ${profile.id}: ${profile.label}`),
          "Type a profile id or 'current'.",
        ].join("\n"),
      );
      return true;
    }

    if (journey.step === "profile") {
      const requestedProfileId = trimmed === "current" ? journey.profile?.id : trimmed;
      const nextProfile = journey.availableProfiles.find((profile) => profile.id === requestedProfileId);
      if (nextProfile === undefined) {
        await this.appendHistoryLine("system", `Unknown profile '${trimmed}'. Enter one of the listed profile ids.`);
        return true;
      }
      journey.profile = nextProfile;
      journey.step = "mode";
      const defaultMode = formatOperatorMode(nextProfile.defaultInteractionMode, nextProfile.defaultActSubmode);
      await this.appendHistoryLine(
        "system",
        `Profile: ${nextProfile.id}\nSelect mode [default: ${defaultMode}] using chat, build, plan, or default.`,
      );
      return true;
    }

    if (journey.step === "mode") {
      const selection = this.parseStartTaskModeSelection(trimmed, journey.profile);
      if (selection === undefined) {
        await this.appendHistoryLine(
          "system",
          "Invalid mode. Use chat, plan, build, or default.",
        );
        return true;
      }
      journey.interactionMode = selection.interactionMode;
      journey.actSubmode = selection.actSubmode;
      journey.step = "prompt";
      await this.appendHistoryLine(
        "system",
        "Enter an optional initial prompt, or type 'skip' to create the task without sending a first message.",
      );
      return true;
    }

    const prompt = trimmed === "skip" ? undefined : trimmed;
    const selectedProfile = journey.profile ?? this.uiStore.getState().activeProfile;
      const launch = resolveOperatorStartTask({
        title: journey.title ?? "",
        ...(journey.presetId !== undefined ? { presetId: journey.presetId } : {}),
        ...(journey.templateId !== undefined ? { templateId: journey.templateId } : {}),
        profileId: selectedProfile.id,
        profileLabel: selectedProfile.label,
        interactionMode: journey.interactionMode,
        actSubmode: journey.actSubmode,
        initialPrompt: prompt,
        workspaceBinding: journey.workspaceBinding,
        workspaceId: journey.workspace?.manifest.workspaceId,
        workspaceLabel:
          journey.workspaceBinding === "active"
            ? describeResolvedWorkspace(journey.workspace)
            : "Detached workspace",
        workspaceRoot: journey.workspace?.rootPath,
      defaultProfileId: selectedProfile.id,
      defaultProfileLabel: selectedProfile.label,
      defaultInteractionMode: selectedProfile.defaultInteractionMode,
      defaultActSubmode: selectedProfile.defaultActSubmode,
      requireTitle: true,
    });
    this.startTaskJourney = undefined;
    await this.createSession({
      launch,
      profile: selectedProfile,
      workspace: journey.workspace,
    });
    return true;
  }

  private hasMeaningfulPriorSessionContext(): boolean {
    return this.sessionsFile.sessions.some((session) =>
      session.started === true ||
      session.launchSummary !== undefined ||
      session.lastMessagePreview !== undefined ||
      session.lastRunStatus !== undefined ||
      session.pendingWaitFor !== undefined
    );
  }

  private async runBootstrapHandoff(): Promise<void> {
    if (this.bootstrapHintShown) {
      return;
    }
    const state = this.uiStore.getState();
    const bootstrap = buildOperatorBootstrapSnapshot({
      hasWorkspace: this.launchWorkspace !== undefined,
      profileLabel: state.activeProfile.label,
      presetCount: listOperatorProfilePresets().length,
      runnerPreflightStatus: state.splashPreflight.phase === "failed"
        ? "failed"
        : state.splashPreflight.phase === "running"
          ? "running"
          : "ready",
      hasPriorSessionContext: this.hasMeaningfulPriorSessionContext(),
      hasWaitingOrFailed: this.sessionsFile.sessions.some(
        (session) => session.pendingWaitFor !== undefined || session.lastRunStatus === "FAILED",
      ),
    });
    this.bootstrapHintShown = true;
    await this.appendHistoryLine("system", `Bootstrap: ${bootstrap.summary}`);
    if (bootstrap.recommendedInitialDestination === "start" && this.startTaskJourney === undefined) {
      await this.appendHistoryLine(
        "system",
        "No prior task context was detected. Opening Start task journey.",
      );
      await this.beginStartTaskJourney();
    }
  }

  private openStartTaskChooserForStep(step: StartTaskJourneyStep): void {
    const paletteContext =
      step === "template"
        ? "start-template"
        : step === "preset"
          ? "start-preset"
          : step === "workspace"
            ? "start-workspace"
            : undefined;
    if (paletteContext === undefined) {
      return;
    }
    const state = this.uiStore.getState();
    this.uiStore.patch({
      paletteOpen: true,
      paletteSource: "manual",
      paletteContext,
      paletteQuery: "",
      paletteSelectedIndex: 0,
      commandBarReturnRegion: this.resolveCommandBarReturnRegion(state),
      helpOpen: false,
      activeRegion: "command_bar",
      focusRegion: "command_bar",
    });
  }

  private async handleStartTaskPaletteSelection(selected: PaletteCommand): Promise<boolean> {
    const journey = this.startTaskJourney;
    if (journey === undefined || selected.id.startsWith("start.") === false) {
      return false;
    }
    if (selected.id === "start.cancel") {
      this.startTaskJourney = undefined;
      this.uiStore.patch({
        paletteOpen: false,
        paletteSource: undefined,
        paletteContext: undefined,
        paletteQuery: "",
        paletteSelectedIndex: 0,
        commandBarReturnRegion: undefined,
        activeRegion: "composer",
        focusRegion: "composer",
      });
      await this.appendHistoryLine("system", "Cancelled start task journey.");
      return true;
    }
    if (journey.step === "template" && selected.id.startsWith("start.template.")) {
      const templateId = selected.id.slice("start.template.".length);
      journey.templateId = templateId === "none"
        ? undefined
        : templateId as StartTaskJourneyState["templateId"];
      const template = getOperatorTaskTemplate(journey.templateId);
      if (template !== undefined) {
        journey.presetId = template.presetId;
        journey.title = template.defaultTitle;
        journey.interactionMode = toCanonicalInteractionMode(template.interactionMode);
        journey.actSubmode = template.actSubmode;
      }
      journey.step = "preset";
      await this.appendHistoryLine("system", `Template: ${template?.label ?? "None"}`);
      this.openStartTaskChooserForStep("preset");
      return true;
    }
    if (journey.step === "preset" && selected.id.startsWith("start.preset.")) {
      const presetId = selected.id.slice("start.preset.".length);
      const preset = presetId === "none" ? undefined : listOperatorProfilePresets().find((entry) => entry.id === presetId);
      journey.presetId = preset?.id;
      if (preset !== undefined) {
        journey.interactionMode = toCanonicalInteractionMode(preset.interactionMode);
        journey.actSubmode = preset.actSubmode;
      }
      journey.step = "workspace";
      await this.appendHistoryLine("system", `Preset: ${preset?.label ?? "None"}`);
      this.openStartTaskChooserForStep("workspace");
      return true;
    }
    if (journey.step === "workspace" && selected.id.startsWith("start.workspace.")) {
      const workspaceKey = selected.id.slice("start.workspace.".length);
      if (workspaceKey === "active") {
        if (this.activeWorkspace === undefined) {
          await this.appendHistoryLine("system", "No active workspace is available. Select detached or a discovered workspace.");
          return true;
        }
        journey.workspaceBinding = "active";
        journey.workspace = this.activeWorkspace;
      } else if (workspaceKey === "detached") {
        journey.workspaceBinding = "detached";
        journey.workspace = undefined;
      } else {
        const index = Number(workspaceKey.replace("idx-", ""));
        const selectedWorkspace = Number.isInteger(index) ? journey.availableWorkspaces[index] : undefined;
        if (selectedWorkspace === undefined) {
          await this.appendHistoryLine("system", "Selected workspace is no longer available.");
          return true;
        }
        journey.workspaceBinding = "active";
        journey.workspace = selectedWorkspace;
      }
      journey.step = "title";
      this.uiStore.patch({
        paletteOpen: false,
        paletteSource: undefined,
        paletteContext: undefined,
        paletteQuery: "",
        paletteSelectedIndex: 0,
        commandBarReturnRegion: undefined,
        activeRegion: "composer",
        focusRegion: "composer",
      });
      await this.appendHistoryLine(
        "system",
        [
          `Workspace: ${journey.workspaceBinding === "active" ? describeResolvedWorkspace(journey.workspace) : "Detached workspace"}`,
          `Enter a task title [default: ${journey.title ?? "none"}].`,
        ].join("\n"),
      );
      return true;
    }
    return false;
  }

  private async beginChildMissionJourney(): Promise<void> {
    this.childMissionJourney = {
      step: "title",
    };
    await this.appendHistoryLine(
      "system",
      [
        "Child mission journey",
        "Enter a child mission title. Type '/cancel' to stop.",
      ].join("\n"),
    );
  }

  private async handleChildMissionJourneyInput(rawLine: string): Promise<boolean> {
    const journey = this.childMissionJourney;
    if (journey === undefined) {
      return false;
    }
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      await this.appendHistoryLine("system", "Child mission expects a value for this step. Type '/cancel' to exit.");
      return true;
    }
    if (trimmed === "/cancel") {
      this.childMissionJourney = undefined;
      await this.appendHistoryLine("system", "Cancelled child mission journey.");
      return true;
    }
    if (trimmed.startsWith("/")) {
      await this.appendHistoryLine("system", "Child mission expects plain input for each step. Type '/cancel' to exit.");
      return true;
    }
    if (journey.step === "title") {
      journey.title = trimmed;
      journey.step = "scope";
      await this.appendHistoryLine("system", "Enter the child mission scope / contract.");
      return true;
    }
    if (journey.step === "scope") {
      journey.scope = trimmed;
      journey.step = "return";
      await this.appendHistoryLine("system", "Enter the return condition for the child mission.");
      return true;
    }
    journey.returnCondition = trimmed;
    const state = this.uiStore.getState();
    const focusedThreadId = state.activeSession.focusedThreadId ?? state.activeSession.sessionId;
    const prompt = buildChildMissionPrompt({
      title: journey.title ?? "",
      scope: journey.scope ?? "",
      returnCondition: journey.returnCondition,
      profileLabel: state.activeProfile.label,
      interactionMode: state.activeSession.interactionMode ?? DEFAULT_INTERACTION_MODE,
      actSubmode: state.activeSession.actSubmode ?? DEFAULT_ACT_SUBMODE,
    });
    this.childMissionJourney = undefined;
    const response = await this.client.sendCommand("operator.control", {
      action: "spawn_child_thread",
      threadId: focusedThreadId,
      message: prompt,
    }, this.getActiveRunnerMetadata());
    if (response.type !== "operator.controlled") {
      throw new Error(`Unexpected operator child response '${response.type}'`);
    }
    await this.applyOperatorControlResponse("child_spawn", response.payload);
    return true;
  }

  private parseStartTaskModeSelection(
    raw: string,
    profile: TuiProfile | undefined,
  ): { interactionMode?: "chat" | "plan" | "build"; actSubmode?: "strict" | "safe" | "full_auto" } | undefined {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "default") {
      return {
        ...(profile?.defaultInteractionMode !== undefined
          ? { interactionMode: toCanonicalInteractionMode(profile.defaultInteractionMode) }
          : {}),
        ...(profile?.defaultActSubmode !== undefined ? { actSubmode: profile.defaultActSubmode } : {}),
      };
    }
    if (normalized === "chat" || normalized === "plan") {
      return {
        interactionMode: normalized,
      };
    }
    if (normalized === "build") {
      return {
        interactionMode: "build",
      };
    }
    return ;
  }

  private async handleLine(rawLine: string): Promise<void> {
    if (await this.handleStartTaskJourneyInput(rawLine)) {
      return;
    }
    if (await this.handleChildMissionJourneyInput(rawLine)) {
      return;
    }

    const parsed = parseInput(rawLine);
    if (parsed.kind === "command") {
      this.uiStore.patch({ chatDraft: "" });
      await this.handleCommand(parsed);
      return;
    }

    const message = rawLine.trim();
    if (message.length === 0) {
      return;
    }

    this.uiStore.patch({ chatDraft: "" });

    const initialState = this.uiStore.getState();
    const blockedModeReply = resolveBlockedWaitModeReply(
      initialState.activeSession.pendingWaitFor,
      rawLine,
    );
    const shouldResumeBlockedRun =
      blockedModeReply?.resumeBlockedRun === true ||
      this.isPendingApprovalWaitReply(initialState.activeSession.pendingWaitFor) ||
      this.isBlockedRunResumeReply(initialState.activeSession.pendingWaitFor, rawLine);
    const shouldUsePendingWait =
      shouldResumeBlockedRun ||
      this.isAcceptedPendingWaitReply(initialState.activeSession.pendingWaitFor, rawLine);
    const shouldForceFreshTurn =
      initialState.activeSession.pendingWaitFor !== undefined && shouldUsePendingWait === false;
    if (blockedModeReply !== undefined) {
      const nextExecutionPolicy = alignExecutionPolicyWithMode({
        executionPolicy: initialState.activeSession.executionPolicy,
        interactionMode: blockedModeReply.interactionMode,
        actSubmode: blockedModeReply.actSubmode,
      });
      await this.setActiveSessionState({
        interactionMode: blockedModeReply.interactionMode,
        actSubmode: blockedModeReply.actSubmode,
        ...(nextExecutionPolicy !== undefined ? { executionPolicy: nextExecutionPolicy } : {}),
        updatedAt: new Date().toISOString(),
      });
      await this.appendHistoryLine("system", blockedModeReply.acknowledgement);
    } else {
      await this.appendHistoryLine("user", rawLine);
    }

    const submittedMessage = this.resolveBlockedRunSubmittedMessage(
      initialState.activeSession.pendingWaitFor,
      rawLine,
    );
    await this.startActiveTurn({
      submittedMessage,
      ...(submittedMessage !== rawLine ? { modelHistoryMessage: submittedMessage } : {}),
      ...(shouldResumeBlockedRun ? { resumeBlockedRun: true } : {}),
      ...(shouldForceFreshTurn ? { forceFreshTurn: true } : {}),
    });
  }

  private resolveBlockedRunSubmittedMessage(
    waitFor: TuiSessionMeta["pendingWaitFor"],
    reply: string,
  ): string {
    void waitFor;
    return reply;
  }

  private isBlockedRunResumeReply(
    waitFor: TuiSessionMeta["pendingWaitFor"],
    reply: string,
  ): boolean {
    if (waitFor?.eventType !== "user.reply") {
      return false;
    }
    const normalizedReply = normalizeSubmittedLine(reply).trim();
    const reason = waitFor.metadata?.reason;
    const resumeReply =
      typeof waitFor.metadata?.resumeReply === "string"
        ? waitFor.metadata.resumeReply.trim()
        : undefined;
    if (resumeReply !== undefined && resumeReply.length > 0) {
      return normalizedReply === normalizeSubmittedLine(resumeReply).trim();
    }
    if (reason === "max_steps_continuation" || reason === "max_model_calls_continuation") {
      return false;
    }
    if (normalizedReply === "continue" || normalizedReply === "proceed" || normalizedReply === "yes") {
      return true;
    }
    return false;
  }

  private isPendingApprovalWaitReply(
    waitFor: TuiSessionMeta["pendingWaitFor"],
  ): boolean {
    return waitFor?.eventType === "user.approval";
  }

  private isAcceptedPendingWaitReply(
    waitFor: TuiSessionMeta["pendingWaitFor"],
    reply: string,
  ): boolean {
    if (waitFor?.eventType !== "user.reply") {
      return false;
    }
    if (this.isBlockedRunResumeReply(waitFor, reply)) {
      return true;
    }
    const reason = waitFor.metadata?.reason;
    if (
      reason === "route_mode_blocked" ||
      reason === "planner_mode_blocked" ||
      reason === "acter_mode_blocked"
    ) {
      return true;
    }
    if (reason !== "max_steps_continuation" && reason !== "max_model_calls_continuation") {
      return false;
    }
    const normalizedReply = normalizeSubmittedLine(reply).trim();
    if (normalizedReply === "continue" || normalizedReply === "proceed" || normalizedReply === "yes") {
      return true;
    }
    if (normalizedReply === "resume") {
      return true;
    }
    return false;
  }

  private async handleCommand(parsed: Extract<ParsedInput, { kind: "command" }>): Promise<void> {
    await this.getCommandRouter().handle(parsed);
  }

  private async handleQueueCommand(args: string[]): Promise<void> {
    const message = args.join(" ").trim();
    if (message.length === 0) {
      await this.appendHistoryLine("system", "Usage: /queue <message>");
      return;
    }
    if (this.uiStore.getState().running === true) {
      this.enqueueInput(message);
      return;
    }
    await this.appendHistoryLine("user", message);
    await this.startActiveTurn({
      submittedMessage: message,
    });
  }

  private getCommandRouter(): TuiCommandRouter {
    if (this.commandRouter === undefined) {
      this.commandRouter = new TuiCommandRouter({
        appendHistoryLine: (role, text) => this.appendHistoryLine(role, text),
        handlers: {
          quit: async () => {
            await this.shutdown();
          },
          profiles: async (args) => {
            await this.handleProfilesCommand(args);
          },
          model: async (args) => {
            await this.handleModelCommand(args);
          },
          theme: async (args) => {
            await this.handleThemeCommand(args);
          },
          sessions: async () => {
            await this.getSessionController().handleSessionsCommand();
          },
          workspace: async (args) => {
            await this.getWorkspaceController().handleWorkspaceCommand(args);
          },
          tasks: async (args) => {
            await this.handleTasksCommand(args);
          },
          status: async () => {
            await this.handleStatusCommand();
          },
          mode: async (args) => {
            await this.handleModeCommand(args);
          },
          mcp: async (args) => {
            await this.getMcpController().handleMcpCommandSafely(args);
          },
          code: async (args) => {
            await this.getCodeModeController().handleCodeCommandSafely(args);
          },
          skill: async (args) => {
            await this.handleSkillCommand(args);
          },
          compact: async (args) => {
            await this.handleCompactCommand(args);
          },
          snapshot: async (args) => {
            await this.getOperatorController().handleSnapshotCommand(args);
          },
          restore: async (args) => {
            await this.getOperatorController().handleRestoreCommand(args);
          },
          approve: async (args) => {
            await this.getOperatorController().handleOperatorControlCommand("approve", args);
          },
          deny: async (args) => {
            await this.getOperatorController().handleOperatorControlCommand("reject", args);
          },
          reject: async (args) => {
            await this.getOperatorController().handleOperatorControlCommand("reject", args);
          },
          reply: async (args) => {
            await this.getOperatorController().handleOperatorControlCommand("reply", args);
          },
          retry: async (args) => {
            await this.getOperatorController().handleOperatorControlCommand("retry", args);
          },
          steer: async (args) => {
            await this.getOperatorController().handleOperatorControlCommand("steer", args);
          },
          queue: async (args) => {
            await this.handleQueueCommand(args);
          },
          stop: async (args) => {
            await this.getOperatorController().handleOperatorControlCommand("stop", args);
          },
          focus: async (args) => {
            await this.getOperatorController().handleFocusThreadCommand(args);
          },
          checkpoint: async (args) => {
            await this.getOperatorController().handleCheckpointCommand(args);
          },
          assembly: async (args) => {
            await this.getOperatorController().handleAssemblyCommand(args);
          },
          child: async (args) => {
            await this.getOperatorController().handleChildCommand(args);
          },
          fanin: async (args) => {
            await this.getOperatorController().handleFanInCommand(args);
          },
          operator: async (args) => {
            await this.getOperatorController().handleOperatorQuickPathCommand(args);
          },
          start: async (args) => {
            await this.handleStartCommand(args);
          },
          new: async (args) => {
            await this.getSessionController().handleNewCommand(args);
          },
          switch: async (args) => {
            await this.getSessionController().handleSwitchOrResumeCommand("switch", args);
          },
          resume: async (args) => {
            await this.getSessionController().handleSwitchOrResumeCommand("resume", args);
          },
        },
      });
    }
    return this.commandRouter;
  }

  private async handleStatusCommand(): Promise<void> {
    const state = this.uiStore.getState();
    const lastLane = findLatestSelectedLane(state.runLogs) ?? "unknown";
    let runnerState = "unknown";
    let mcpState = "unknown";
    try {
      const describe = await this.client.sendCommand("session.describe", {
        sessionId: state.activeSession.sessionId,
      });
      if (describe.type === "session.described") {
        await this.syncSessionFromDescribePayload(describe.payload);
        runnerState = describe.payload.sessionId === state.activeSession.sessionId ? "connected" : "unexpected";
      } else {
        runnerState = "unexpected";
      }
    } catch (error) {
      runnerState = `error:${error instanceof Error ? error.message : String(error)}`;
    }

    try {
      const mcp = await this.fetchMcpStatus(false);
      mcpState = summarizeMcpDetails(mcp);
    } catch (error) {
      mcpState = `error:${error instanceof Error ? error.message : String(error)}`;
    }

    const refreshedState = this.uiStore.getState();
    const snapshot = buildOperatorStatusSnapshot({
      title: refreshedState.activeSession.name,
      workspaceLabel: describeResolvedWorkspace(this.activeWorkspace),
      profileLabel: refreshedState.activeProfile.id,
      interactionMode: refreshedState.activeSession.interactionMode,
      actSubmode: refreshedState.activeSession.actSubmode,
      pendingWaitEventType: refreshedState.activeSession.pendingWaitFor?.eventType,
      lastRunStatus: refreshedState.activeSession.lastRunStatus,
      mcpSummary: mcpState,
      isActive: true,
    });
    await this.appendHistoryLine(
      "system",
      [
        `${snapshot.headline} :: ${snapshot.recommendedLabel}`,
        snapshot.subline,
        `Profile=${refreshedState.activeProfile.id} Session=${refreshedState.activeSession.name} ${describeResolvedWorkspace(this.activeWorkspace)} Mode=${formatSessionMode(refreshedState.activeSession)} Lane=${lastLane} WaitFor=${refreshedState.activeSession.pendingWaitFor?.eventType ?? "none"} Status=${refreshedState.statusLine} Runner=${runnerState} MCP=${mcpState}`,
        ...formatOperatorAffordance(
          this.buildSessionOperatorState({
            session: refreshedState.activeSession,
            profile: refreshedState.activeProfile,
          }),
        ),
      ].join("\n"),
    );
  }

  private async handleMcpCommandSafely(args: string[]): Promise<void> {
    await this.getMcpController().handleMcpCommandSafely(args);
  }

  private async handleCodeCommandSafely(args: string[]): Promise<void> {
    await this.getCodeModeController().handleCodeCommandSafely(args);
  }

  private async handleStartCommand(args: string[]): Promise<void> {
    if (args[0] === "recent") {
      const recent = this.resolveRecentSessionTarget();
      if (recent === undefined) {
        await this.appendHistoryLine("system", "No recent launch was available.");
        return;
      }
      await this.beginStartTaskJourney();
      const journey = this.startTaskJourney;
      if (journey !== undefined) {
        journey.title = recent.name;
        journey.profile = this.uiStore.getState().activeProfile;
        journey.presetId = recent.launchPresetId;
        journey.templateId = recent.launchTemplateId;
        journey.workspaceBinding = recent.workspaceBinding ?? (recent.workspaceRoot !== undefined ? "active" : "detached");
        journey.workspace =
          recent.workspaceRoot !== undefined
            ? await this.resolveWorkspaceFromSelectionValue(recent.workspaceRoot)
            : undefined;
        journey.step = "workspace";
        this.openStartTaskChooserForStep("workspace");
      }
      await this.appendHistoryLine("system", `Seeded start task from recent session '${recent.name}'.`);
      return;
    }
    await this.beginStartTaskJourney();
  }

  private async handleCodeCommand(args: string[]): Promise<void> {
    await this.getCodeModeController().handleCodeCommand(args);
  }

  private async handleProfilesCommand(args: string[]): Promise<void> {
    const [subcommand, profileId] = args;
    const profiles = await this.profileStore.load();
    const state = this.uiStore.getState();

    if (subcommand === undefined || subcommand === "list") {
      const lines = profiles.map((profile) => {
        const mode = profile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE;
        return `${profile.id}${profile.id === state.activeProfile.id ? " (active)" : ""}: ${profile.label} preset=${profile.presetId ?? "default"} mode=${mode} tools=${profile.toolAllowlist?.length ?? 0}`;
      });
      await this.appendHistoryLine("system", `Profiles:\n${lines.join("\n")}`);
      return;
    }

    if (subcommand === "use") {
      if (profileId === undefined || profileId.trim().length === 0) {
        await this.appendHistoryLine("system", "Usage: /profiles use <id>");
        return;
      }
      const nextProfile = this.profileStore.findById(profiles, profileId);
      if (nextProfile === undefined) {
        await this.appendHistoryLine("system", `Profile '${profileId}' not found.`);
        return;
      }
      await this.persistActiveProfile(nextProfile);
      await this.setActiveSessionState({
        profileId: nextProfile.id,
        updatedAt: new Date().toISOString(),
      });
      await this.persistSessionAndUi();
      await this.appendHistoryLine(
        "system",
        `Profile set to '${nextProfile.id}' (preset=${nextProfile.presetId ?? "default"}).`,
      );
      return;
    }

    await this.appendHistoryLine("system", "Usage: /profiles [list] | /profiles use <id>");
  }

  private async handleModelCommand(args: string[]): Promise<void> {
    const [subcommand, ...rest] = args;
    const policyStore = new ModelPolicyStore(this.profileStore.getBaseDir());
    const policy = await this.readSharedModelPolicy(policyStore);

    if (subcommand === undefined || subcommand === "show" || subcommand === "status") {
      const stageOverrides = Object.entries(policy.modelByStage);
      const targetProvider = this.pendingModelProviderSelection ?? policy.provider;
      const catalog = await resolveProviderModelCatalog(targetProvider);
      const summary = buildPresentedProviderModelCatalog({
        provider: targetProvider,
        catalog,
        recentModelsByProvider: this.uiStore.getState().recentModelsByProvider,
      });
      await this.appendHistoryLine(
        "system",
        [
          `provider=${policy.provider}`,
          `model=${policy.model}`,
          `timeoutMs=${policy.modelTimeoutMs ?? "default"}`,
          `visionInput=${policy.modelCapabilities.visionInputEnabled ? "enabled" : "disabled"}`,
          `stageOverrides=${stageOverrides.length > 0 ? stageOverrides.map(([stageId, model]) => `${stageId}=${model}`).join(", ") : "none"}`,
          buildModelCatalogStatusLine(catalog),
          ...(catalog.note !== undefined ? [catalog.note] : []),
          ...(this.pendingModelProviderSelection !== undefined
            ? [
                `pendingProvider=${this.pendingModelProviderSelection}`,
                `selectionRequired=Use /model set <model> to finish switching to '${this.pendingModelProviderSelection}'.`,
              ]
            : []),
          ...buildModelSummaryBlock({
            provider: targetProvider,
            summary,
            selectedModel: this.pendingModelProviderSelection === undefined ? policy.model : undefined,
          }),
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "search") {
      const query = rest.join(" ").trim();
      if (query.length === 0) {
        await this.appendHistoryLine("system", "Usage: /model search <query>");
        return;
      }
      const targetProvider = this.pendingModelProviderSelection ?? policy.provider;
      const catalog = await resolveProviderModelCatalog(targetProvider);
      const result = searchProviderModelCatalog({
        provider: targetProvider,
        catalog,
        query,
      });
      await this.appendHistoryLine(
        "system",
        [
          buildModelCatalogStatusLine(catalog),
          ...(catalog.note !== undefined ? [catalog.note] : []),
          ...(this.pendingModelProviderSelection !== undefined ? [`pendingProvider=${this.pendingModelProviderSelection}`] : []),
          ...buildModelSearchResultBlock(result),
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "set-provider") {
      const provider = rest[0];
      if (isSupportedModelSetProvider(provider) === false) {
        await this.appendHistoryLine("system", `Usage: /model set-provider ${MODEL_SET_PROVIDER_USAGE}`);
        return;
      }
      const catalog = await resolveProviderModelCatalog(provider);
      const model = rest.slice(1).join(" ").trim();
      if (model.length === 0) {
        this.pendingModelProviderSelection = provider;
        const summary = buildPresentedProviderModelCatalog({
          provider,
          catalog,
          recentModelsByProvider: this.uiStore.getState().recentModelsByProvider,
        });
        await this.appendHistoryLine(
          "system",
          [
            `Provider '${provider}' selected. Choose a model to finish the switch.`,
            buildModelCatalogStatusLine(catalog),
            ...(catalog.note !== undefined ? [catalog.note] : []),
            ...buildModelSummaryBlock({
              provider,
              summary,
            }),
            "Use /model set <model> to complete the switch.",
          ].join("\n"),
        );
        return;
      }
      if (catalog.models.includes(model) === false) {
        const summary = buildPresentedProviderModelCatalog({
          provider,
          catalog,
          recentModelsByProvider: this.uiStore.getState().recentModelsByProvider,
        });
        await this.appendHistoryLine(
          "system",
          [
            `Model '${model}' is not allowed for provider '${provider}'.`,
            buildModelCatalogStatusLine(catalog),
            ...(catalog.note !== undefined ? [catalog.note] : []),
            ...buildModelSummaryBlock({ provider, summary }),
          ].join("\n"),
        );
        return;
      }
      const saved = await this.writeSharedModelPolicy(policyStore, {
        ...policy,
        provider,
        model,
      });
      this.pendingModelProviderSelection = undefined;
      await this.refreshActiveProfileFromSharedPolicy();
      await this.rememberRecentModel(saved.provider, saved.model);
      await this.appendHistoryLine(
        "system",
        `Model provider set to '${saved.provider}' with model '${saved.model}'. Active and new sessions now use the updated shared model policy.`,
      );
      return;
    }

    if (subcommand === "set") {
      const model = rest.join(" ").trim();
      const targetProvider = this.pendingModelProviderSelection ?? policy.provider;
      const catalog = await resolveProviderModelCatalog(targetProvider);
      if (model.length === 0) {
        const summary = buildPresentedProviderModelCatalog({
          provider: targetProvider,
          catalog,
          recentModelsByProvider: this.uiStore.getState().recentModelsByProvider,
        });
        await this.appendHistoryLine(
          "system",
          [
            "Usage: /model set <model>",
            buildModelCatalogStatusLine(catalog),
            ...(catalog.note !== undefined ? [catalog.note] : []),
            ...buildModelSummaryBlock({
              provider: targetProvider,
              selectedModel: this.pendingModelProviderSelection === undefined ? policy.model : undefined,
              summary,
            }),
          ].join("\n"),
        );
        return;
      }
      if (catalog.models.includes(model) === false) {
        const summary = buildPresentedProviderModelCatalog({
          provider: targetProvider,
          catalog,
          recentModelsByProvider: this.uiStore.getState().recentModelsByProvider,
        });
        await this.appendHistoryLine(
          "system",
          [
            `Model '${model}' is not allowed for provider '${targetProvider}'.`,
            buildModelCatalogStatusLine(catalog),
            ...(catalog.note !== undefined ? [catalog.note] : []),
            ...buildModelSummaryBlock({
              provider: targetProvider,
              selectedModel: this.pendingModelProviderSelection === undefined ? policy.model : undefined,
              summary,
            }),
          ].join("\n"),
        );
        return;
      }
      const saved = await this.writeSharedModelPolicy(policyStore, {
        ...policy,
        provider: targetProvider,
        model,
      });
      const pendingProvider = this.pendingModelProviderSelection;
      this.pendingModelProviderSelection = undefined;
      await this.refreshActiveProfileFromSharedPolicy();
      await this.rememberRecentModel(saved.provider, saved.model);
      await this.appendHistoryLine(
        "system",
        pendingProvider !== undefined
          ? `Model provider set to '${saved.provider}' with model '${saved.model}'. Active and new sessions now use the updated shared model policy.`
          : `Model set to '${saved.model}' for provider '${saved.provider}'. Active and new sessions now use the updated shared model policy.`,
      );
      return;
    }

    await this.appendHistoryLine(
      "system",
      `Usage: /model [show] | /model search <query> | /model set-provider ${MODEL_SET_PROVIDER_USAGE} | /model set <model>`,
    );
  }

  private async readSharedModelPolicy(policyStore: ModelPolicyStore): Promise<ResolvedModelPolicy> {
    const core = resolveLocalCoreStoreClient(this.profileStore.getBaseDir());
    if (core !== undefined) {
      const response = await core.client.getJson("/v1/settings") as {
        settings?: { modelPolicy?: unknown } | undefined;
      };
      if (response.settings?.modelPolicy !== undefined) {
        return response.settings.modelPolicy as ResolvedModelPolicy;
      }
    }
    return policyStore.read();
  }

  private async writeSharedModelPolicy(
    policyStore: ModelPolicyStore,
    policy: ResolvedModelPolicy,
  ): Promise<ResolvedModelPolicy> {
    const core = resolveLocalCoreStoreClient(this.profileStore.getBaseDir());
    if (core !== undefined) {
      const response = await core.client.patchJson("/v1/settings", { modelPolicy: policy }) as {
        settings?: { modelPolicy?: unknown } | undefined;
      };
      if (response.settings?.modelPolicy !== undefined) {
        return response.settings.modelPolicy as ResolvedModelPolicy;
      }
    }
    return policyStore.write(policy);
  }

  private async rememberRecentModel(provider: ModelProviderId, model: string): Promise<void> {
    this.uiStore.patch({
      recentModelsByProvider: updateRecentModelsByProvider(
        this.uiStore.getState().recentModelsByProvider,
        provider,
        model,
      ),
    });
    await this.persistUiState();
  }

  private async refreshActiveProfileFromSharedPolicy(): Promise<void> {
    const profiles = await this.profileStore.load();
    const state = this.uiStore.getState();
    const nextProfile = this.profileStore.findById(profiles, state.activeProfile.id);
    if (nextProfile === undefined) {
      return;
    }
    const themeSelection = resolveThemeSelection({
      mode: state.themeMode,
      overrides: nextProfile.theme,
    });
    this.uiStore.patch({
      activeProfile: nextProfile,
      resolvedThemeMode: themeSelection.resolvedMode,
      themePreset: themeSelection.preset,
      theme: themeSelection.tokens,
      statusLine: this.withMcpSummary(stripMcpSummary(state.statusLine)),
    });
  }

  private async handleWorkspaceCommand(args: string[]): Promise<void> {
    await this.getWorkspaceController().handleWorkspaceCommand(args);
  }

  private async handleSkillCommand(args: string[]): Promise<void> {
    const [subcommand, skillId] = args;
    const state = this.uiStore.getState();
    const currentSkillPack = getSkillPackById(state.activeSession.activeSkillPackId);

    if (subcommand === undefined || subcommand === "status") {
      if (currentSkillPack === undefined) {
        await this.appendHistoryLine("system", "Skill pack: none");
        return;
      }
      await this.appendHistoryLine(
        "system",
        [
          `Skill pack: ${currentSkillPack.id} (${currentSkillPack.label})`,
          `Allowed tools: ${currentSkillPack.allowedTools.join(", ")}`,
          `Instructions: ${currentSkillPack.instructions.join(" ")}`,
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "list") {
      const lines = listSkillPacks().map((entry) => {
        const active = entry.id === currentSkillPack?.id ? " (active)" : "";
        return `${entry.id}${active}: ${entry.label}`;
      });
      await this.appendHistoryLine("system", `Skill packs:\n${lines.join("\n")}`);
      return;
    }

    if (subcommand === "use") {
      if (skillId === undefined || skillId.trim().length === 0) {
        await this.appendHistoryLine("system", "Usage: /skill use <id>");
        return;
      }
      const nextSkillPack = getSkillPackById(skillId);
      if (nextSkillPack === undefined) {
        await this.appendHistoryLine("system", `Skill pack '${skillId}' not found.`);
        return;
      }
      await this.setActiveSessionState({
        activeSkillPackId: nextSkillPack.id,
        updatedAt: new Date().toISOString(),
      });
      await this.refreshActiveSessionOperatorState();
      await this.persistSessionAndUi();
      await this.appendHistoryLine("system", `Skill pack set to '${nextSkillPack.id}'.`);
      return;
    }

    if (subcommand === "clear") {
      await this.setActiveSessionState({
        activeSkillPackId: undefined,
        updatedAt: new Date().toISOString(),
      });
      await this.refreshActiveSessionOperatorState();
      await this.persistSessionAndUi();
      await this.appendHistoryLine("system", "Skill pack cleared.");
      return;
    }

    await this.appendHistoryLine("system", "Usage: /skill status | /skill list | /skill use <id> | /skill clear");
  }

  private async handleTasksCommand(args: string[]): Promise<void> {
    const [subcommand, ...rest] = args;
    const state = this.uiStore.getState();
    const tasks = this.listChildTaskSessions(state.activeSession.sessionId);

    if (subcommand === undefined || subcommand === "list") {
      const lines = tasks.map((session) => {
        const delegation = session.delegation!;
        return `${session.name} [${delegation.status}] provider=${delegation.provider}/${delegation.model} skill=${delegation.skillPackId ?? "none"}`;
      });
      await this.appendHistoryLine("system", `Tasks:\n${lines.join("\n") || "(none)"}`);
      this.uiStore.patch({ activeView: "tasks", activeRegion: "sessions" });
      return;
    }

    if (subcommand === "open") {
      const name = rest.join(" ").trim();
      if (name.length === 0) {
        await this.appendHistoryLine("system", "Usage: /tasks open <name>");
        return;
      }
      await this.switchSession(name);
      return;
    }

    if (subcommand === "launch") {
      const [profileId, ...promptParts] = rest;
      const prompt = promptParts.join(" ").trim();
      if (profileId === undefined || prompt.length === 0) {
        await this.appendHistoryLine("system", "Usage: /tasks launch <profileId> <prompt...>");
        return;
      }

      const profiles = await this.profileStore.load();
      const profile = this.profileStore.findById(profiles, profileId);
      if (profile === undefined) {
        await this.appendHistoryLine("system", `Profile '${profileId}' not found.`);
        return;
      }

      const workspace = this.activeWorkspace ?? this.launchWorkspace;
      const childLaunch = resolveOperatorStartTask({
        title: `task:${prompt.slice(0, 48)}`,
        workspaceBinding: workspace !== undefined ? "active" : "detached",
        workspaceId: workspace?.manifest.workspaceId,
        workspaceLabel: describeResolvedWorkspace(workspace),
        workspaceRoot: workspace?.rootPath,
        defaultProfileId: profile.id,
        defaultProfileLabel: profile.label,
        defaultInteractionMode: profile.defaultInteractionMode,
        defaultActSubmode: profile.defaultActSubmode,
        requireTitle: true,
      });
      const childSession = this.createSessionMeta(childLaunch, profile, workspace);
      const now = new Date().toISOString();
      const delegation: DelegationTaskMeta = {
        taskId: `task-${childSession.sessionId}`,
        parentSessionId: state.activeSession.sessionId,
        title: prompt.slice(0, 96),
        status: "RUNNING",
        childSessionId: childSession.sessionId,
        childSessionName: childSession.name,
        profileId: profile.id,
        provider: profile.modelProvider ?? "openrouter",
        model: profile.model ?? "(env default)",
        ...(state.activeSession.activeSkillPackId !== undefined
          ? { skillPackId: state.activeSession.activeSkillPackId }
          : {}),
        launchedBy: "operator",
        createdAt: now,
        updatedAt: now,
      };
      const delegatedSession: TuiSessionMeta = {
        ...childSession,
        started: true,
        autoCompactionEnabled: true,
        delegation,
      };
      this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, delegatedSession);
      this.uiStore.patch({
        sessions: this.sessionsFile.sessions,
        activeView: "tasks",
        activeRegion: "sessions",
      });
      await this.saveSessionsFile();
      await this.appendSessionHistoryLine(
        delegatedSession,
        "system",
        `Background task started for '${prompt}'.`,
      );
      await this.appendHistoryLine("system", `Launched background task '${delegatedSession.name}'.`);

      const skillPack = getSkillPackById(state.activeSession.activeSkillPackId);
      const effectiveProfile = toCoreExecutionProfile(
        applySkillPackToProfile(profile, skillPack),
      );
      void this.client.sendCommand("run.start", {
        profile: effectiveProfile,
        turn: {
          sessionId: delegatedSession.sessionId,
          message: prompt,
          eventType: "user.message",
          modeSystemV2Enabled: effectiveProfile.modeSystemV2Enabled === true,
          interactionMode: delegatedSession.interactionMode,
          ...(delegatedSession.actSubmode !== undefined ? { actSubmode: delegatedSession.actSubmode } : {}),
          clientCapabilities: createTuiClientCapabilities(),
          autoCompaction: {
            enabled: delegatedSession.autoCompactionEnabled === true,
            state: "idle",
          },
          ...(workspace !== undefined ? { workspace: workspace.runtimeContext } : {}),
          ...(skillPack !== undefined ? { skillPack } : {}),
          stepAgent: getEntryStepAgent(effectiveProfile),
        },
      }).catch(async (error) => {
        await this.updateTaskSessionFromMeta({
          ...delegation,
          status: "FAILED",
          errorMessage: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
      });
      return;
    }

    await this.appendHistoryLine(
      "system",
      "Usage: /tasks [list] | /tasks open <name> | /tasks launch <profileId> <prompt...>",
    );
  }

  private async handleCompactCommand(args: string[]): Promise<void> {
    const [subcommand] = args;
    const state = this.uiStore.getState();
    if (subcommand === undefined) {
      await this.setActiveSessionState({
        pendingManualCompaction: true,
        updatedAt: new Date().toISOString(),
      });
      await this.refreshActiveSessionOperatorState();
      await this.persistSessionAndUi();
      await this.appendHistoryLine(
        "system",
        "Context compaction will run on the next turn.",
      );
      return;
    }

    if (subcommand === "status") {
      const context = state.activeSession.operatorState?.context;
      await this.appendHistoryLine(
        "system",
        [
          `auto=${state.activeSession.autoCompactionEnabled === true ? "on" : "off"}`,
          `manual=${state.activeSession.pendingManualCompaction === true ? "armed" : "idle"}`,
          `suppressed=${state.activeSession.suppressAutoCompactionOnce === true ? "yes" : "no"}`,
          `state=${context?.compactionState ?? "idle"}`,
          `reason=${context?.compactionReason ?? "n/a"}`,
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "on" || subcommand === "off") {
      await this.setActiveSessionState({
        autoCompactionEnabled: subcommand === "on",
        suppressAutoCompactionOnce: false,
        updatedAt: new Date().toISOString(),
      });
      await this.refreshActiveSessionOperatorState();
      await this.persistSessionAndUi();
      await this.appendHistoryLine("system", `Automatic compaction ${subcommand === "on" ? "enabled" : "disabled"}.`);
      return;
    }

    if (subcommand === "suppress") {
      await this.setActiveSessionState({
        suppressAutoCompactionOnce: true,
        updatedAt: new Date().toISOString(),
      });
      await this.refreshActiveSessionOperatorState();
      await this.persistSessionAndUi();
      await this.appendHistoryLine("system", "Automatic compaction suppressed for the next turn.");
      return;
    }

    await this.appendHistoryLine(
      "system",
      "Usage: /compact | /compact status | /compact on | /compact off | /compact suppress",
    );
  }

  private async handleThemeCommand(args: string[]): Promise<void> {
    const state = this.uiStore.getState();
    const plan = parseThemeCommandArgs(args);

    if (plan.kind === "show") {
      await this.appendHistoryLine(
        "system",
        buildThemeSummaryLines({
          mode: state.themeMode,
          resolvedMode: state.resolvedThemeMode,
          preset: state.themePreset,
          effectiveTheme: state.theme,
          overrides: state.activeProfile.theme,
        }).join("\n"),
      );
      return;
    }

    if (plan.kind === "list") {
      const lines = listThemeModes().map((mode) =>
        `${mode}${mode === state.themeMode ? " (active)" : ""}`,
      );
      await this.appendHistoryLine("system", `Theme modes:\n${lines.join("\n")}`);
      return;
    }

    if (plan.kind === "set-mode") {
      await this.applyThemeMode(plan.mode);
      await this.appendHistoryLine("system", `Theme mode set to '${plan.mode}'.`);
      return;
    }

    if (plan.kind === "help") {
      await this.appendHistoryLine(
        "system",
        [
          "Theme commands:",
          "/theme",
          "/theme list",
          "/theme light",
          "/theme dark",
          "/theme system",
        ].join("\n"),
      );
      return;
    }

    await this.appendHistoryLine("system", plan.message);
  }

  private async applyThemeMode(mode: ThemeMode): Promise<void> {
    const state = this.uiStore.getState();
    const themeSelection = resolveThemeSelection({
      mode,
      overrides: state.activeProfile.theme,
    });
    this.uiStore.patch({
      themeMode: themeSelection.mode,
      resolvedThemeMode: themeSelection.resolvedMode,
      themePreset: themeSelection.preset,
      theme: themeSelection.tokens,
    });
    await this.persistUiState();
  }

  private async handleModeCommand(args: string[]): Promise<void> {
    const state = this.uiStore.getState();
    const [subcommand, maybeSubmode] = args;
    const operatorState = this.buildSessionOperatorState({
      session: state.activeSession,
      profile: state.activeProfile,
    });

    if (subcommand === undefined || (subcommand === "status" && args.length === 1)) {
      await this.appendHistoryLine("system", formatOperatorAffordance(operatorState).join("\n"));
      return;
    }

    if ((subcommand === "chat" || subcommand === "plan") && args.length === 1) {
      const shouldResumeBlockedRun = isModeBlockedWait(state.activeSession.pendingWaitFor);
      const acknowledgement = shouldResumeBlockedRun
        ? `Mode set to ${formatUserFacingModeLabel({ interactionMode: subcommand })}. Resuming blocked run.`
        : `Mode set to ${formatUserFacingModeLabel({ interactionMode: subcommand })}.`;
      const nextExecutionPolicy = alignExecutionPolicyWithMode({
        executionPolicy: state.activeSession.executionPolicy,
        interactionMode: subcommand,
        actSubmode: undefined,
      });
      await this.setActiveSessionState({
        interactionMode: subcommand,
        actSubmode: undefined,
        ...(nextExecutionPolicy !== undefined ? { executionPolicy: nextExecutionPolicy } : {}),
        updatedAt: new Date().toISOString(),
      });
      this.resetModeChangeComposerState();
      await this.refreshActiveSessionOperatorState();
      await this.persistSessionAndUi();
      await this.appendHistoryLine("system", acknowledgement);
      if (shouldResumeBlockedRun) {
        await this.startActiveTurn({
          submittedMessage: `/mode ${subcommand}`,
          resumeBlockedRun: true,
        });
      }
      return;
    }

    if (subcommand === "build" && args.length === 1) {
      const label = formatUserFacingModeLabel({
        interactionMode: "build",
      });
      const shouldResumeBlockedRun = isModeBlockedWait(state.activeSession.pendingWaitFor);
      const acknowledgement = shouldResumeBlockedRun
        ? `Mode set to ${label}. Resuming blocked run.`
        : `Mode set to ${label}.`;
      const nextExecutionPolicy = alignExecutionPolicyWithMode({
        executionPolicy: state.activeSession.executionPolicy,
        interactionMode: "build",
      });
      await this.setActiveSessionState({
        interactionMode: "build",
        actSubmode: undefined,
        ...(nextExecutionPolicy !== undefined ? { executionPolicy: nextExecutionPolicy } : {}),
        updatedAt: new Date().toISOString(),
      });
      this.resetModeChangeComposerState();
      await this.refreshActiveSessionOperatorState();
      await this.persistSessionAndUi();
      await this.appendHistoryLine("system", acknowledgement);
      if (shouldResumeBlockedRun) {
        await this.startActiveTurn({
          submittedMessage: formatModeSwitchCommand({
            interactionMode: "build",
          }),
          resumeBlockedRun: true,
        });
      }
      return;
    }

    await this.appendHistoryLine(
      "system",
      "Usage: /mode status | /mode chat | /mode plan | /mode build",
    );
  }

  private async startActiveTurn(input: {
    submittedMessage: string;
    modelHistoryMessage?: string | undefined;
    resumeBlockedRun?: boolean | undefined;
    forceFreshTurn?: boolean | undefined;
  }): Promise<void> {
    try {
      await this.getRunController().startActiveTurn(input);
    } finally {
      void this.drainQueue();
    }
  }

  private resetModeChangeComposerState(): void {
    this.resetComposerSubmissionGuard();
    this.uiStore.patch({
      chatDraft: "",
      chatDraftExpanded: false,
      paletteOpen: false,
      paletteSource: undefined,
      paletteContext: undefined,
      paletteQuery: "",
      paletteSelectedIndex: 0,
      logsFilterMode: false,
      sessionsSearchMode: false,
      commandBarReturnRegion: undefined,
      helpOpen: false,
      quitConfirm: false,
      activeView: "chat",
      activeRegion: "composer",
      focusRegion: "composer",
      navigationStack: [],
    });
  }

  private async handleOperatorControlCommand(
    action: "approve" | "reject" | "reply" | "retry" | "steer" | "stop",
    args: string[],
  ): Promise<void> {
    await this.getOperatorController().handleOperatorControlCommand(action, args);
  }

  private async handleOperatorQuickPathCommand(args: string[]): Promise<void> {
    await this.getOperatorController().handleOperatorQuickPathCommand(args);
  }

  private async handleAssemblyCommand(args: string[]): Promise<void> {
    await this.getOperatorController().handleAssemblyCommand(args);
  }

  private async handleChildCommand(args: string[]): Promise<void> {
    await this.getOperatorController().handleChildCommand(args);
  }

  private async handleFanInCommand(args: string[]): Promise<void> {
    await this.getOperatorController().handleFanInCommand(args);
  }

  private async handleCheckpointCommand(args: string[]): Promise<void> {
    await this.getOperatorController().handleCheckpointCommand(args);
  }

  private navigateToView(
    view: AppView,
    options?: {
      remember?: boolean | undefined;
      region?: FocusRegion | undefined;
      resetStack?: boolean | undefined;
    },
  ): void {
    const state = this.uiStore.getState();
    const nextRegion: FocusRegion =
      options?.region ?? (view === "chat" ? "chat_list" : view === "logs" ? "logs" : "sessions");
    const nextStack =
      options?.resetStack === true
        ? []
        : options?.remember === false || state.activeView === view
          ? state.navigationStack
          : [...state.navigationStack, state.activeView].slice(-12);
    this.uiStore.patch({
      activeView: view,
      activeRegion: nextRegion,
      focusRegion: nextRegion,
      navigationStack: nextStack,
      logsFilterMode: false,
      sessionsSearchMode: false,
    });
  }

  private goBack(): void {
    const state = this.uiStore.getState();
    if (state.detailDrawer.open) {
      const fallbackRegion: FocusRegion =
        state.detailDrawer.source === "logs"
          ? "logs"
          : state.detailDrawer.source === "sessions" ||
              state.detailDrawer.source === "history" ||
              state.detailDrawer.source === "workspace" ||
              state.detailDrawer.source === "mcp" ||
              state.detailDrawer.source === "code" ||
              state.detailDrawer.source === "delegation" ||
              state.detailDrawer.source === "recovery" ||
              state.detailDrawer.source === "tasks"
            ? "sessions"
            : "composer";
      this.uiStore.patch({
        detailDrawer: {
          ...state.detailDrawer,
          open: false,
        },
        activeRegion: fallbackRegion,
        focusRegion: fallbackRegion,
      });
      void this.persistUiState();
      return;
    }
    if (state.activeView !== "chat") {
      const previousView = state.navigationStack[state.navigationStack.length - 1] ?? "chat";
      const nextStack =
        state.navigationStack.length > 0 ? state.navigationStack.slice(0, -1) : [];
      this.navigateToView(previousView, { remember: false, resetStack: true });
      this.uiStore.patch({
        navigationStack: nextStack,
      });
      void this.persistUiState();
      return;
    }
  }

  private async refreshCurrentSessionDescribe(): Promise<void> {
    const state = this.uiStore.getState();
    try {
      const describe = await this.client.sendCommand("session.describe", {
        sessionId: state.activeSession.sessionId,
      });
      if (describe.type === "session.described") {
        await this.syncSessionFromDescribePayload(describe.payload);
      }
    } catch {
      // Shell destinations should remain usable if describe is unavailable.
    }
  }

  private async refreshWorkspaceCheckpointList(): Promise<void> {
    const state = this.uiStore.getState();
    try {
      const response = await this.client.sendCommand("workspace.checkpoint.list", {
        sessionId: state.activeSession.sessionId,
      });
      if (response.type === "workspace.checkpoint") {
        const payload = response.payload as WorkspaceCheckpointEventPayload;
        this.uiStore.patch({
          workspaceCheckpoints: payload.checkpoints ?? [],
        });
      }
    } catch {
      this.uiStore.patch({
        workspaceCheckpoints: [],
      });
    }
  }

  private async handleFocusThreadCommand(args: string[]): Promise<void> {
    await this.getOperatorController().handleFocusThreadCommand(args);
  }

  private async handleMcpCommand(args: string[]): Promise<void> {
    await this.getMcpController().handleMcpCommand(args);
  }

  private async fetchMcpStatus(refresh: boolean): Promise<McpStatusSnapshot> {
    const state = this.uiStore.getState();
    const response = await this.client.sendCommand(refresh ? "mcp.refresh" : "mcp.status", {
      profile: state.activeProfile,
    });

    if (response.type !== "mcp.status" && response.type !== "mcp.refreshed") {
      throw new Error(`Unexpected MCP response type '${response.type}'`);
    }

    const status = response.payload.status;
    this.mcpSummary = summarizeMcpSummary(status);
    const current = this.uiStore.getState();
    this.uiStore.patch({
      mcpStatus: status,
      statusLine: this.withMcpSummary(stripMcpSummary(current.statusLine)),
    });
    return status;
  }

  private async persistActiveProfile(nextProfile: TuiProfile): Promise<void> {
    const profiles = await this.profileStore.load();
    const replaced = profiles.some((profile) => profile.id === nextProfile.id);
    const nextProfiles = profiles.map((profile) =>
      profile.id === nextProfile.id ? nextProfile : profile,
    );
    if (replaced === false) {
      nextProfiles.push(nextProfile);
    }
    await this.saveProfiles(nextProfiles);

    const state = this.uiStore.getState();
    const themeSelection = resolveThemeSelection({
      mode: state.themeMode,
      overrides: nextProfile.theme,
    });
    this.uiStore.patch({
      activeProfile: nextProfile,
      resolvedThemeMode: themeSelection.resolvedMode,
      themePreset: themeSelection.preset,
      theme: themeSelection.tokens,
      statusLine: this.withMcpSummary(stripMcpSummary(state.statusLine)),
    });
  }

  private buildSessionOperatorState(input: {
    session: TuiSessionMeta;
    profile: TuiProfile;
    runtime?: TuiSessionMeta["operatorState"] | undefined;
  }): NonNullable<TuiSessionMeta["operatorState"]> {
    const skillPack = getSkillPackById(input.session.activeSkillPackId);
    const decorated = decorateOperatorAffordance({
      base: input.runtime ?? input.session.operatorState,
      runtimeAuthoritative: input.runtime !== undefined,
      profile: input.profile,
      session: input.session,
      skillPack,
    });
    const childTasks = this.listChildTaskSessions(input.session.sessionId);
    if (childTasks.length === 0) {
      return decorated;
    }
    return {
      ...decorated,
      taskInbox: {
        total: childTasks.length,
        active: childTasks.filter((session) => {
          const status = session.delegation?.status;
          return status === "PENDING" || status === "RUNNING";
        }).length,
        waiting: childTasks.filter((session) => session.delegation?.status === "WAITING").length,
        completed: childTasks.filter((session) => session.delegation?.status === "COMPLETED").length,
        failed: childTasks.filter((session) => session.delegation?.status === "FAILED").length,
      },
    };
  }

  private buildRuntimeOperatorStateFromDescribe(input: {
    session: TuiSessionMeta;
    payload: SessionDescribedEventPayload;
  }): TuiSessionMeta["operatorState"] {
    return buildOperatorAffordanceFromSessionProjection({
      session: {
        interactionMode: input.session.interactionMode,
        actSubmode: input.session.actSubmode,
        executionPolicy: input.session.executionPolicy,
      },
      projection: input.payload,
    });
  }

  private async syncSessionFromDescribePayload(
    payload: SessionDescribedEventPayload,
  ): Promise<void> {
    const target = this.sessionsFile.sessions.find((session) => session.sessionId === payload.sessionId);
    if (target === undefined) {
      return;
    }
    const resolvedWaitFor = payload.waitFor ?? target.pendingWaitFor;
    const runtimePayload: SessionDescribedEventPayload =
      payload.waitFor === resolvedWaitFor
        ? payload
        : {
            ...payload,
            waitFor: resolvedWaitFor,
          };
    const state = this.uiStore.getState();
    const profile = state.activeProfile.id === target.profileId
      ? state.activeProfile
      : (await this.profileStore.load()).find((candidate) => candidate.id === target.profileId) ?? state.activeProfile;
    const patchedSession: TuiSessionMeta = {
      ...target,
      ...(payload.updatedAt !== undefined ? { updatedAt: payload.updatedAt } : {}),
      pendingWaitFor: resolvedWaitFor,
      ...(payload.focusedThreadId !== undefined ? { focusedThreadId: payload.focusedThreadId } : {}),
      operatorState: this.buildSessionOperatorState({
        session: {
          ...target,
          pendingWaitFor: resolvedWaitFor,
          ...(payload.focusedThreadId !== undefined ? { focusedThreadId: payload.focusedThreadId } : {}),
        },
        profile,
        runtime: this.buildRuntimeOperatorStateFromDescribe({
          session: target,
          payload: runtimePayload,
        }),
      }),
    };
    this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, patchedSession);
    this.uiStore.patch({
      sessions: this.sessionsFile.sessions,
      ...(state.activeSession.sessionId === patchedSession.sessionId
        ? { activeSession: patchedSession }
        : {}),
    });
  }

  private async applyOperatorControlResponse(
    action: OperatorControlApplyAction,
    payload: OperatorControlledEventPayload,
  ): Promise<void> {
    const state = this.uiStore.getState();
    if (payload.result !== undefined) {
      const output = payload.result.output;
      await this.setActiveSessionState({
        started: true,
        updatedAt: new Date().toISOString(),
        pendingWaitFor: output.status === "WAITING" ? output.waitFor : undefined,
        lastRunStatus: output.status,
      });
      if (output.status === "WAITING") {
        const waitPrompt = extractWaitPrompt(output.waitFor);
        await this.appendHistoryLine(
          "system",
          buildWaitingSystemText(output.waitFor),
          {
            waitEventType: output.waitFor?.eventType ?? "unknown",
            ...(waitPrompt === undefined ? {} : { prompt: waitPrompt }),
          },
          output,
        );
      } else if (output.status === "FAILED") {
        await this.appendHistoryLine("system", `Operator action failed: ${output.errors[0]?.message ?? "Run failed."}`);
      } else {
        await this.appendHistoryLine("system", `Operator action '${action}' applied.`);
      }
    } else {
      await this.appendHistoryLine("system", `Operator action '${action}' applied.`);
    }
    const describe = await this.client.sendCommand("session.describe", {
      sessionId: state.activeSession.sessionId,
    });
    if (describe.type === "session.described") {
      await this.syncSessionFromDescribePayload(describe.payload);
    }
  }

  private async refreshActiveSessionOperatorState(): Promise<void> {
    const state = this.uiStore.getState();
    const nextSession: TuiSessionMeta = {
      ...state.activeSession,
      operatorState: this.buildSessionOperatorState({
        session: state.activeSession,
        profile: state.activeProfile,
      }),
    };
    this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, nextSession);
    this.uiStore.patch({
      activeSession: nextSession,
      sessions: this.sessionsFile.sessions,
    });
  }

  private withMcpSummary(base: string): string {
    return `${stripMcpSummary(base)} | ${this.mcpSummary}`;
  }

  private async createSessionFromName(name: string): Promise<void> {
    await this.getSessionController().createSessionFromName(name);
  }

  private async createSession(options: CreateSessionOptions): Promise<void> {
    await this.getSessionController().createSession(options);
  }

  private listChildTaskSessions(parentSessionId: string): TuiSessionMeta[] {
    return this.sessionsFile.sessions
      .filter((session) => session.delegation?.parentSessionId === parentSessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async updateTaskSessionFromMeta(task: DelegationTaskMeta): Promise<void> {
    const childSessionId = task.childSessionId ?? `child-${task.taskId}`;
    const childSessionName = task.childSessionName ?? task.title;
    const existing = this.sessionsFile.sessions.find((session) => session.sessionId === childSessionId);
    const nextSession: TuiSessionMeta =
      existing === undefined
        ? {
            name: childSessionName,
            sessionId: childSessionId,
            profileId: task.profileId,
            createdAt: task.createdAt,
            started: true,
            updatedAt: task.updatedAt,
            interactionMode: "plan",
            autoCompactionEnabled: true,
            delegation: task,
          }
        : {
            ...existing,
            profileId: task.profileId,
            updatedAt: task.updatedAt,
            started: true,
            delegation: task,
            lastRunStatus:
              task.status === "FAILED"
                ? "FAILED"
                : task.status === "COMPLETED"
                  ? "COMPLETED"
                  : task.status === "WAITING"
                    ? "WAITING"
                    : existing.lastRunStatus,
          };
    this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, nextSession);
    const state = this.uiStore.getState();
    const activeSession =
      state.activeSession.sessionId === nextSession.sessionId
        ? nextSession
        : state.activeSession.sessionId === task.parentSessionId
          ? {
              ...state.activeSession,
              operatorState: this.buildSessionOperatorState({
                session: state.activeSession,
                profile: state.activeProfile,
              }),
            }
          : state.activeSession;
    this.uiStore.patch({
      sessions: this.sessionsFile.sessions,
      activeSession,
    });
    await this.saveSessionsFile();
  }

  private async switchSession(name: string): Promise<void> {
    await this.getSessionController().switchSession(name);
  }

  private resolveRecentSessionTarget(): TuiSessionMeta | undefined {
    return this.getSessionController().resolveRecentSessionTarget();
  }

  private async hydrateSessionHistoryMetadata(profiles: TuiProfile[]): Promise<void> {
    const overviews = await this.historyStore.readSessionOverviews(
      this.sessionsFile.sessions.map((session) => session.sessionId),
    );
    this.sessionsFile = {
      ...this.sessionsFile,
      sessions: this.sessionsFile.sessions.map((session) => {
        const overview = overviews[session.sessionId];
        const profile = profiles.find((candidate) => candidate.id === session.profileId);
        return {
          ...session,
          ...(profile?.label !== undefined ? { profileLabel: profile.label } : {}),
          ...(session.workspaceLabel === undefined ? { workspaceLabel: this.describeSessionWorkspaceLabel(session) } : {}),
          ...(overview?.launchSummary !== undefined && session.launchSummary === undefined
            ? { launchSummary: overview.launchSummary }
            : {}),
          ...(overview?.lastPreview !== undefined && session.lastMessagePreview === undefined
            ? { lastMessagePreview: overview.lastPreview }
            : {}),
          ...(overview !== undefined
            ? {
                hasArtifacts: overview.hasArtifacts,
                hasSummary: overview.hasSummary,
              }
            : {}),
        };
      }),
    };
  }

  private describeSessionWorkspaceLabel(session: TuiSessionMeta): string {
    if (session.workspaceLabel !== undefined && session.workspaceLabel.trim().length > 0) {
      return session.workspaceLabel;
    }
    if (session.workspaceId !== undefined) {
      return `workspace=${session.workspaceId}`;
    }
    if (session.workspaceRoot !== undefined) {
      return session.workspaceRoot;
    }
    return "Detached workspace";
  }

  private buildHistoryHomeEntries(state: UiRuntimeState) {
    const entries = buildOperatorHistoryHome(
      this.sessionsFile.sessions.map((session) => ({
        id: session.sessionId,
        title: session.name,
        updatedAt: session.updatedAt,
        interactionMode: session.interactionMode,
        actSubmode: session.actSubmode,
        pendingWaitEventType: session.pendingWaitFor?.eventType,
        lastRunStatus: session.lastRunStatus,
        lastPreview: session.lastMessagePreview,
        isActive: session.sessionId === state.activeSession.sessionId,
        profileLabel: session.profileLabel ?? session.profileId,
        workspaceLabel: this.describeSessionWorkspaceLabel(session),
        launchSummary: session.launchSummary,
        hasArtifacts: session.hasArtifacts,
        hasSummary: session.hasSummary,
        restartAvailable: session.started,
      })),
      24,
    );
    if (state.activeView !== "history") {
      return entries;
    }
    return [
      {
        id: "nav.back.history",
        title: state.navigationStack.length > 0
          ? `Back to ${formatBackViewLabel(state.navigationStack[state.navigationStack.length - 1] ?? "chat")}`
          : "Back to chat",
        updatedAt: state.activeSession.updatedAt,
        modeLabel: formatSessionMode(state.activeSession),
        lifecycle: "ready" as const,
        recommendedAction: "resume_recent" as const,
        recommendedLabel:
          state.navigationStack.length > 0 ? "Return to previous screen" : "Return to chat",
        detail:
          state.navigationStack.length > 0
            ? `Return to ${formatBackViewLabel(state.navigationStack[state.navigationStack.length - 1] ?? "chat")}`
            : "Return to chat",
        latestPreview: undefined,
        hasArtifacts: false,
        hasSummary: false,
        restartAvailable: false,
        isActive: false,
      },
      ...entries,
    ];
  }

  private buildWorkspaceSnapshotForView(state: UiRuntimeState) {
    if (state.activeView === "workspace") {
      return this.buildWorkspaceJourneySnapshot(state);
    }
    if (state.activeView === "mcp") {
      return this.buildMcpWorkspaceSnapshot(state);
    }
    if (state.activeView === "code") {
      return this.buildCodeWorkspaceSnapshot(state);
    }
    if (state.activeView === "delegation") {
      return this.buildDelegationWorkspaceSnapshot(state);
    }
    if (state.activeView === "recovery") {
      return this.buildRecoveryCenterSnapshot(state);
    }
    return ;
  }

  private buildWorkspaceJourneySnapshot(state: UiRuntimeState) {
    const discoveredWorkspaces = this.sessionsFile.sessions
      .filter((session) => session.workspaceId !== undefined || session.workspaceRoot !== undefined)
      .map((session) => ({
        workspaceId: session.workspaceId,
        label: this.describeSessionWorkspaceLabel(session),
        rootPath: session.workspaceRoot,
        isCurrentBinding: session.sessionId === state.activeSession.sessionId,
        isLaunchWorkspace:
          session.workspaceId !== undefined &&
          session.workspaceId === state.activeSession.workspaceId,
      }));
    const recentSessions = this.sessionsFile.sessions
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 8)
      .map((session) => ({
        id: session.sessionId,
        title: session.name,
        profileLabel: session.profileLabel ?? session.profileId,
        workspaceLabel: this.describeSessionWorkspaceLabel(session),
        interactionMode: session.interactionMode,
        actSubmode: session.actSubmode,
        launchSummary: session.launchSummary ?? "Launch summary missing",
        recommendedLabel: session.sessionId === state.activeSession.sessionId ? "Continue active" : "Resume",
        presetId: session.launchPresetId,
        templateId: session.launchTemplateId,
      }));
    return buildOperatorWorkspaceJourney({
      sessionTitle: state.activeSession.name,
      profileLabel: state.activeProfile.label,
      workspaceLabel: this.describeSessionWorkspaceLabel(state.activeSession),
      launchWorkspaceLabel:
        this.launchWorkspace !== undefined
          ? describeResolvedWorkspace(this.launchWorkspace)
          : "Detached workspace",
      interactionMode: state.activeSession.interactionMode,
      actSubmode: state.activeSession.actSubmode,
      pendingWaitEventType: state.activeSession.pendingWaitFor?.eventType,
      lastRunStatus: state.activeSession.lastRunStatus,
      isActive: true,
      discoveredWorkspaces,
      recentSessions,
    });
  }

  private buildMcpWorkspaceSnapshot(state: UiRuntimeState) {
    return buildOperatorMcpWorkspace({
      sessionTitle: state.activeSession.name,
      profileLabel: state.activeProfile.label,
      workspaceLabel: this.describeSessionWorkspaceLabel(state.activeSession),
      interactionMode: state.activeSession.interactionMode,
      actSubmode: state.activeSession.actSubmode,
      pendingWaitEventType: state.activeSession.pendingWaitFor?.eventType,
      lastRunStatus: state.activeSession.lastRunStatus,
      isActive: true,
      status: state.mcpStatus,
    });
  }

  private buildCodeWorkspaceSnapshot(state: UiRuntimeState) {
    return buildOperatorCodeWorkspace({
      sessionTitle: state.activeSession.name,
      profileLabel: state.activeProfile.label,
      workspaceLabel: this.describeSessionWorkspaceLabel(state.activeSession),
      interactionMode: state.activeSession.interactionMode,
      actSubmode: state.activeSession.actSubmode,
      pendingWaitEventType: state.activeSession.pendingWaitFor?.eventType,
      lastRunStatus: state.activeSession.lastRunStatus,
      isActive: true,
      codeMode: state.activeProfile.codeMode,
      latestHint: state.activeSession.launchSummary ?? state.activeSession.lastMessagePreview,
      hasArtifacts: state.activeSession.hasArtifacts,
      hasSummary: state.activeSession.hasSummary,
    });
  }

  private buildDelegationWorkspaceSnapshot(state: UiRuntimeState) {
    const operatorState = state.activeSession.operatorState;
    const childThreads = operatorState?.childThreads ?? [];
    const childOutcomes = childThreads
      .filter((child) =>
        child.result !== undefined ||
        child.errorCode !== undefined ||
        child.errorMessage !== undefined ||
        (child.references !== undefined && child.references.length > 0) ||
        child.outcomeState !== undefined ||
        child.outcomeSummary !== undefined
      )
      .map((child) => ({
        threadId: child.threadId,
        title: child.title ?? child.threadId,
        status: child.status,
        readiness:
          child.status === "COMPLETED"
            ? "ready" as const
            : child.status === "WAITING"
              ? "waiting" as const
              : child.status === "FAILED"
                ? "blocked" as const
                : "unknown" as const,
        latestPreview: child.outcomeSummary ?? child.result?.result ?? child.errorMessage,
        ...(child.result !== undefined ? { result: child.result } : {}),
        ...(child.result?.status !== undefined ? { resultStatus: child.result.status } : {}),
        ...(child.errorCode !== undefined || child.result?.error?.code !== undefined
          ? { errorCode: child.errorCode ?? child.result?.error?.code }
          : {}),
        ...(child.errorMessage !== undefined || child.result?.error?.message !== undefined
          ? { error: child.errorMessage ?? child.result?.error?.message }
          : {}),
        ...(child.outcomeSummary !== undefined ? { summary: child.outcomeSummary } : {}),
        ...(child.references !== undefined || child.result?.references !== undefined
          ? { references: child.references ?? child.result?.references }
          : {}),
      }));
    return buildOperatorDelegationWorkspace({
      sessionTitle: state.activeSession.name,
      profileLabel: state.activeProfile.label,
      workspaceLabel: this.describeSessionWorkspaceLabel(state.activeSession),
      interactionMode: state.activeSession.interactionMode,
      actSubmode: state.activeSession.actSubmode,
      pendingWaitEventType: state.activeSession.pendingWaitFor?.eventType,
      lastRunStatus: state.activeSession.lastRunStatus,
      isActive: true,
      delegation: {
        childThreads: childThreads.map((child) => ({
          threadId: child.threadId,
          title: child.title ?? child.threadId,
          status: child.status,
          ...(child.waitEventType !== undefined ? { waitEventType: child.waitEventType } : {}),
          ...(child.errorMessage !== undefined ? { reason: child.errorMessage } : {}),
          ...(child.result !== undefined ? { result: child.result } : {}),
          ...(child.errorCode !== undefined ? { errorCode: child.errorCode } : {}),
          ...(child.references !== undefined ? { references: child.references } : {}),
        })),
        childOutcomes,
        ...(operatorState?.recommendedAction?.code !== undefined
          ? { nextActionKind: operatorState.recommendedAction.code }
          : {}),
        ...(operatorState?.nextAction !== undefined ? { nextActionSummary: operatorState.nextAction } : {}),
        ...(operatorState?.blockReason?.summary !== undefined ? { blockerSummary: operatorState.blockReason.summary } : {}),
        ...(operatorState?.childBlocker?.reason !== undefined
          ? { childBlockerReason: operatorState.childBlocker.reason }
          : {}),
        ...(operatorState?.latestFanInDisposition !== undefined
          ? {
              fanInDisposition: {
                status: operatorState.latestFanInDisposition.status,
                ...(operatorState.latestFanInDisposition.checkpointId !== undefined
                  ? { checkpointId: operatorState.latestFanInDisposition.checkpointId }
                  : {}),
                ...(operatorState.latestFanInDisposition.summary !== undefined
                  ? { summary: operatorState.latestFanInDisposition.summary }
                  : {}),
              },
            }
          : {}),
        ...(operatorState?.inbox?.childBlockers !== undefined
          ? { inboxChildBlockers: operatorState.inbox.childBlockers }
          : {}),
      },
    });
  }

  private buildRecoveryCenterSnapshot(state: UiRuntimeState) {
    const operatorState = state.activeSession.operatorState;
    const recoveryInput = {
      ...(operatorState?.latestCheckpoint !== undefined
        ? {
            latestCheckpoint: {
              checkpointId: operatorState.latestCheckpoint.checkpointId,
              status: operatorState.latestCheckpoint.status,
              recommendedAction: operatorState.latestCheckpoint.recommendedAction,
              reason: operatorState.latestCheckpoint.reason,
            },
          }
        : {}),
      ...(operatorState?.latestFanInDisposition !== undefined
        ? {
            fanInDisposition: {
              status: operatorState.latestFanInDisposition.status,
              ...(operatorState.latestFanInDisposition.checkpointId !== undefined
                ? { checkpointId: operatorState.latestFanInDisposition.checkpointId }
                : {}),
              ...(operatorState.latestFanInDisposition.summary !== undefined
                ? { summary: operatorState.latestFanInDisposition.summary }
                : {}),
            },
          }
        : {}),
      ...(operatorState?.blockReason?.summary !== undefined ? { blockerSummary: operatorState.blockReason.summary } : {}),
      ...(operatorState?.wait?.detail !== undefined ? { activeWaitDetail: operatorState.wait.detail } : {}),
      ...(operatorState?.contextPosture !== undefined ? { contextPosture: operatorState.contextPosture } : {}),
      ...(operatorState?.latestReasoning?.message !== undefined
        ? { latestReasoningMessage: operatorState.latestReasoning.message }
        : {}),
      ...(operatorState?.latestSteering?.message !== undefined
        ? { latestSteeringMessage: operatorState.latestSteering.message }
        : {}),
      ...(operatorState?.latestEvidenceRecovery?.latestIssues !== undefined
        ? { latestEvidenceIssues: operatorState.latestEvidenceRecovery.latestIssues }
        : {}),
      ...(operatorState?.latestEvidenceRecovery?.terminalOutcome !== undefined
        ? { latestEvidenceTerminalOutcome: operatorState.latestEvidenceRecovery.terminalOutcome }
        : {}),
      ...(state.activeSession.lastMessagePreview !== undefined
        ? { latestPreview: state.activeSession.lastMessagePreview }
        : {}),
      childOutcomes: (operatorState?.childThreads ?? [])
        .filter((child) => child.outcomeSummary !== undefined)
        .map((child) => `${child.threadId}: ${child.outcomeSummary}`),
      ...(state.activeSession.launchSummary !== undefined
        ? { launchSummary: state.activeSession.launchSummary }
        : {}),
      setupSummary: `${state.activeProfile.label} · ${this.describeSessionWorkspaceLabel(state.activeSession)}`,
    };
    return buildOperatorRecoveryCenter({
      sessionTitle: state.activeSession.name,
      profileLabel: state.activeProfile.label,
      workspaceLabel: this.describeSessionWorkspaceLabel(state.activeSession),
      workspaceRoot: state.activeSession.workspaceRoot,
      interactionMode: state.activeSession.interactionMode,
      actSubmode: state.activeSession.actSubmode,
      pendingWaitEventType: state.activeSession.pendingWaitFor?.eventType,
      lastRunStatus: state.activeSession.lastRunStatus,
      isActive: true,
      recovery: recoveryInput,
      checkpoints: state.workspaceCheckpoints,
    });
  }

  private mergeSessionHistoryMetadata(
    session: TuiSessionMeta,
    input: {
      preview?: string | undefined;
      updatedAt?: string | undefined;
      hasArtifacts?: boolean | undefined;
      hasSummary?: boolean | undefined;
      launchSummary?: string | undefined;
      started?: boolean | undefined;
    },
  ): TuiSessionMeta {
    return {
      ...session,
      ...(input.preview !== undefined ? { lastMessagePreview: input.preview } : {}),
      ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
      ...(input.launchSummary !== undefined ? { launchSummary: input.launchSummary } : {}),
      ...(input.hasArtifacts === true || session.hasArtifacts === true ? { hasArtifacts: true } : {}),
      ...(input.hasSummary === true || session.hasSummary === true ? { hasSummary: true } : {}),
      ...(input.started !== undefined ? { started: input.started } : {}),
    };
  }

  private createSessionMeta(
    launch: OperatorResolvedStartTask,
    profile: TuiProfile,
    workspace?: ResolvedWorkspace | undefined,
  ): TuiSessionMeta {
    const now = new Date().toISOString();
    const slug = slugify(launch.title);
    const sessionId = `${profile.sessionPrefix}-${slug}-${Date.now()}`;

    const modeResolution = normalizeInteractionMode({
      interactionMode: launch.interactionMode,
      actSubmode: launch.actSubmode,
      defaultInteractionMode: DEFAULT_INTERACTION_MODE,
      defaultActSubmode: DEFAULT_ACT_SUBMODE,
    });

    const session: TuiSessionMeta = {
      name: launch.title,
      sessionId,
      profileId: profile.id,
      profileLabel: profile.label,
      ...(launch.presetId !== undefined ? { launchPresetId: launch.presetId } : {}),
      ...(launch.templateId !== undefined ? { launchTemplateId: launch.templateId } : {}),
      workspaceBinding: launch.workspace.binding,
      ...(workspace !== undefined ? { workspaceId: workspace.manifest.workspaceId } : {}),
      ...(workspace !== undefined ? { workspaceRoot: workspace.rootPath } : {}),
      workspaceLabel: launch.workspace.label,
      createdAt: now,
      updatedAt: now,
      interactionMode: modeResolution.interactionMode,
      ...(modeResolution.actSubmode !== undefined ? { actSubmode: modeResolution.actSubmode } : {}),
      executionPolicy: alignExecutionPolicyWithMode({
        executionPolicy: undefined,
        interactionMode: modeResolution.interactionMode,
        actSubmode: modeResolution.actSubmode,
      }),
      started: false,
      launchSummary: formatOperatorLaunchSummary(launch),
      hasArtifacts: false,
      hasSummary: false,
      autoCompactionEnabled: true,
    };

    return {
      ...session,
      operatorState: this.buildSessionOperatorState({
        session,
        profile,
      }),
    };
  }

  private async appendHistoryLine(
    role: TranscriptLine["role"],
    text: string,
    data?: Record<string, unknown> | undefined,
    output?: import("../../src/index.js").NormalizedOutput | undefined,
  ): Promise<void> {
    await this.enqueueTranscriptAppend(async () => {
      const state = this.uiStore.getState();
      const segments = splitTranscriptMessage(role, text);
      const timestamp = new Date().toISOString();
      const lines: TranscriptLine[] = segments.map((segment, index) => ({
        role,
        text: segment,
        ...(index === 0 && data !== undefined ? { data } : {}),
        timestamp,
        ...(index === 0 && output !== undefined
          ? {
              run: {
                runId: output.runId,
                status: output.status,
                telemetry: output.telemetry,
                errors: output.errors,
              },
            }
          : {}),
      }));

      const previousTranscript = state.transcript;
      const chatLayout = this.getChatLayout(state);
      const previousVisualRows = buildChatVisualRows(previousTranscript, chatLayout.wrappedBodyWidth);
      const previousVisualCount = previousVisualRows.length;
      const nextTranscript = [...previousTranscript, ...lines].slice(-400);
      const dropped = Math.max(0, previousTranscript.length + lines.length - nextTranscript.length);
      const droppedVisualCount = countChatVisualRows(
        previousTranscript.slice(0, dropped),
        chatLayout.wrappedBodyWidth,
      );
      const followTail = state.scroll.chat.tailLocked || isAtTail(state.scroll.chat, previousVisualCount);
      const previousAnchor = resolveChatVisualAnchor(previousVisualRows, state.scroll.chat.cursor);
      const mappedAnchor = previousAnchor === undefined
        ? undefined
        : previousAnchor.transcriptIndex < dropped
          ? undefined
          : {
              transcriptIndex: previousAnchor.transcriptIndex - dropped,
              wrappedLineIndex: previousAnchor.wrappedLineIndex,
            };
      const nextVisualRows = buildChatVisualRows(nextTranscript, chatLayout.wrappedBodyWidth);
      const nextVisualCount = nextVisualRows.length;
      const retainedVisualCount = Math.max(0, previousVisualCount - droppedVisualCount);
      const appendedVisualCount = Math.max(0, nextVisualCount - retainedVisualCount);
      const listRows = this.getListRowsForScroll(state, "chat");
      const nextCursor = followTail
        ? Math.max(0, nextVisualCount - 1)
        : mappedAnchor === undefined
          ? Math.max(0, state.scroll.chat.cursor - droppedVisualCount)
          : resolveChatVisualCursorFromAnchor(nextVisualRows, mappedAnchor);
      const defaultScroll = followTail
        ? ensureChatCursorVisible(
            nextVisualRows,
            {
              ...state.scroll.chat,
              cursor: nextCursor,
              tailLocked: true,
            },
            listRows,
          )
        : ensureChatCursorVisible(
            nextVisualRows,
            {
              ...state.scroll.chat,
              cursor: nextCursor,
              tailLocked: false,
            },
            listRows,
          );
      const nextScroll = defaultScroll;
      const nextUnread = computeUnreadIncrement({
        currentUnread: state.chatUnreadCount ?? 0,
        wasAtTail: followTail,
        appendedCount: appendedVisualCount,
      });

      const preview = summarizePreview(text);
      const updatedAt = lines[lines.length - 1]?.timestamp ?? new Date().toISOString();
      const activeSession = this.mergeSessionHistoryMetadata(state.activeSession, {
        preview,
        updatedAt,
        started: true,
        hasArtifacts: dataHasArtifacts(data),
        hasSummary: role === "assistant" && preview.length > 0,
        launchSummary:
          role === "system" && text.startsWith("Task=") ? text : undefined,
      });
      this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, activeSession);

      this.uiStore.patch({
        transcript: nextTranscript,
        activeSession,
        sessions: this.sessionsFile.sessions,
        chatUnreadCount: nextUnread,
        scroll: {
          ...state.scroll,
          chat: nextScroll,
        },
      });

      try {
        for (const line of lines) {
          await this.historyStore.append({
            source: "runner",
            eventId: randomUUID(),
            timestamp: line.timestamp,
            sessionName: state.activeSession.name,
            sessionId: state.activeSession.sessionId,
            profileId: state.activeProfile.id,
            role,
            text: line.text,
            ...(line.data !== undefined ? { data: line.data } : {}),
            ...(line.run !== undefined ? { run: line.run } : {}),
          });
        }
      } catch (error) {
        this.recordPersistenceFailure("history.append", error);
      }
    });
  }

  private async appendSessionHistoryLine(
    session: TuiSessionMeta,
    role: TranscriptLine["role"],
    text: string,
    data?: Record<string, unknown> | undefined,
    output?: import("../../src/index.js").NormalizedOutput | undefined,
  ): Promise<void> {
    const state = this.uiStore.getState();
    if (state.activeSession.sessionId === session.sessionId) {
      await this.appendHistoryLine(role, text, data, output);
      return;
    }

    await this.enqueueTranscriptAppend(async () => {
      try {
        await this.historyStore.append({
          source: "runner",
          eventId: randomUUID(),
          timestamp: new Date().toISOString(),
          sessionName: session.name,
          sessionId: session.sessionId,
          profileId: session.profileId,
          role,
          text,
          ...(data !== undefined ? { data } : {}),
          ...(output !== undefined
            ? {
                run: {
                  runId: output.runId,
                  status: output.status,
                  telemetry: output.telemetry,
                  errors: output.errors,
                },
              }
            : {}),
        });
        const preview = summarizePreview(text);
        const updatedSession = this.mergeSessionHistoryMetadata(session, {
          preview: preview.length > 0 ? preview : undefined,
          updatedAt: new Date().toISOString(),
          started: true,
          hasArtifacts: dataHasArtifacts(data),
          hasSummary: role === "assistant" && preview.length > 0,
          launchSummary:
            role === "system" && text.startsWith("Task=") ? text : undefined,
        });
        this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, updatedSession);
        const state = this.uiStore.getState();
        const activeSession =
          state.activeSession.sessionId === updatedSession.sessionId ? updatedSession : state.activeSession;
        this.uiStore.patch({
          activeSession,
          sessions: this.sessionsFile.sessions,
        });
      } catch (error) {
        this.recordPersistenceFailure("history.append", error);
      }
    });
  }

  private onRunnerEvent(event: RunnerEvent): void {
    this.getRunController().onRunnerEvent(event);
  }

  private async handleTaskUpdatedEvent(
    task: DelegationTaskMeta,
    kind: "spawned" | "waiting" | "completed" | "failed",
    assistantText: string | null,
    finalizedPayload: unknown | undefined,
  ): Promise<void> {
    await this.updateTaskSessionFromMeta(task);
    const session = this.sessionsFile.sessions.find((item) => item.sessionId === task.childSessionId);
    if (session === undefined) {
      return;
    }
    if (kind === "spawned") {
      await this.appendSessionHistoryLine(session, "system", `Background task started: ${task.title}`);
      return;
    }
    if (kind === "waiting") {
      await this.appendSessionHistoryLine(
        session,
        "system",
        task.waitEventType !== undefined
          ? `Task waiting for '${task.waitEventType}'.`
          : "Task is waiting for operator input.",
      );
      return;
    }
    if (kind === "completed") {
      const parsed = parseFinalizePayload(finalizedPayload);
      if (assistantText !== null) {
        const structuredData = parsed.ok === true ? parsed.payload?.data : undefined;
        await this.appendSessionHistoryLine(
          session,
          "assistant",
          assistantText,
          structuredData,
        );
        const reportingGroundingNotice = structuredData === undefined
          ? undefined
          : buildFinalizeReportingGroundingNotice(structuredData);
        if (reportingGroundingNotice !== undefined) {
          await this.appendSessionHistoryLine(session, "system", reportingGroundingNotice);
        }
      } else {
        await this.appendSessionHistoryLine(
          session,
          "system",
          task.resultSummary ?? "Task completed.",
        );
      }
      return;
    }
    await this.appendSessionHistoryLine(
      session,
      "system",
      `Task failed: ${task.errorMessage ?? "unknown error"}`,
    );
  }

  private async syncBackgroundSessionProgress(sessionId: string): Promise<void> {
    const session = this.sessionsFile.sessions.find((item) => item.sessionId === sessionId);
    if (session?.delegation === undefined) {
      return;
    }
    await this.updateTaskSessionFromMeta({
      ...session.delegation,
      status: "RUNNING",
      updatedAt: new Date().toISOString(),
    });
  }

  private async syncBackgroundSessionResult(
    output: import("../../src/index.js").NormalizedOutput,
    assistantText: string | null,
    finalizedPayload: unknown | undefined,
    operatorState?: TuiSessionMeta["operatorState"] | undefined,
  ): Promise<void> {
    const session = this.sessionsFile.sessions.find((item) => item.sessionId === output.sessionId);
    if (session?.delegation === undefined) {
      return;
    }
    await this.updateTaskSessionFromMeta({
      ...session.delegation,
      status: output.status === "WAITING" ? "WAITING" : "COMPLETED",
      waitEventType: output.waitFor?.eventType,
      resultSummary:
        output.status === "WAITING"
          ? session.delegation.resultSummary
          : assistantText ?? session.delegation.resultSummary,
      updatedAt: new Date().toISOString(),
    });
    if (operatorState !== undefined) {
      const updatedSession: TuiSessionMeta = {
        ...session,
        pendingWaitFor: output.status === "WAITING" ? output.waitFor : undefined,
        lastRunStatus: output.status,
        operatorState: this.buildSessionOperatorState({
          session: {
            ...session,
            pendingWaitFor: output.status === "WAITING" ? output.waitFor : undefined,
            lastRunStatus: output.status,
          },
          profile: this.uiStore.getState().activeProfile,
          runtime: operatorState,
        }),
        updatedAt: new Date().toISOString(),
      };
      this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, updatedSession);
      this.uiStore.patch({
        sessions: this.sessionsFile.sessions,
      });
    }
  }

  private async syncBackgroundSessionFailure(sessionId: string, message: string): Promise<void> {
    const session = this.sessionsFile.sessions.find((item) => item.sessionId === sessionId);
    if (session?.delegation === undefined) {
      return;
    }
    await this.updateTaskSessionFromMeta({
      ...session.delegation,
      status: "FAILED",
      errorMessage: message,
      updatedAt: new Date().toISOString(),
    });
  }

  private clearProgressForRun(runId: string): void {
    const state = this.uiStore.getState();
    const nextProgressByRun = { ...state.activeProgressByRun };
    delete nextProgressByRun[runId];
    const latestProgress =
      state.latestProgressForSession?.runId === runId
        ? undefined
        : state.latestProgressForSession;
    const latestReasoning =
      state.latestReasoningForSession?.runId === runId
        ? undefined
        : state.latestReasoningForSession;
    this.uiStore.patch({
      activeProgressByRun: nextProgressByRun,
      latestProgressForSession: latestProgress,
      latestReasoningForSession: latestReasoning,
    });
  }

  private async appendAgentProgressTranscriptLine(update: AgentProgressUpdateV1): Promise<void> {
    const state = this.uiStore.getState();
    if (state.activeSession.sessionId === update.sessionId) {
      if (this.isDuplicateAgentProgressTranscriptLine(state.transcript, update)) {
        return;
      }
      await this.appendHistoryLine("assistant", update.message, this.buildAgentProgressTranscriptData(update));
      return;
    }

    const session = this.sessionsFile.sessions.find((item) => item.sessionId === update.sessionId);
    if (session === undefined) {
      return;
    }

    await this.appendSessionHistoryLine(
      session,
      "assistant",
      update.message,
      this.buildAgentProgressTranscriptData(update),
    );
  }

  private enqueueAgentProgressTranscriptUpdate(update: AgentProgressUpdateV1): void {
    const key = this.getAgentProgressTranscriptKey(update);
    const pending = this.pendingAgentProgressTranscriptUpdates.get(key);
    if (pending !== undefined && pending.seq >= update.seq) {
      return;
    }
    this.pendingAgentProgressTranscriptUpdates.set(key, update);
    if (this.activeAgentProgressTranscriptDrains.has(key)) {
      return;
    }
    this.activeAgentProgressTranscriptDrains.add(key);
    void this.drainAgentProgressTranscriptUpdates(key);
  }

  private async drainAgentProgressTranscriptUpdates(key: string): Promise<void> {
    try {
      while (true) {
        const update = this.pendingAgentProgressTranscriptUpdates.get(key);
        if (update === undefined) {
          break;
        }
        this.pendingAgentProgressTranscriptUpdates.delete(key);
        await this.appendAgentProgressTranscriptLine(update);
      }
    } finally {
      this.activeAgentProgressTranscriptDrains.delete(key);
      if (this.pendingAgentProgressTranscriptUpdates.has(key)) {
        this.activeAgentProgressTranscriptDrains.add(key);
        void this.drainAgentProgressTranscriptUpdates(key);
      }
    }
  }

  private getAgentProgressTranscriptKey(update: Pick<AgentProgressUpdateV1, "sessionId" | "runId">): string {
    return `${update.sessionId}:${update.runId}`;
  }

  private buildAgentProgressTranscriptData(update: AgentProgressUpdateV1): Record<string, unknown> {
    return {
      agentProgress: true,
      label: "Agent progress",
      runId: update.runId,
      seq: update.seq,
      ...(update.stepIndex !== undefined ? { stepIndex: update.stepIndex } : {}),
      ...(update.stepAgent !== undefined ? { stepAgent: update.stepAgent } : {}),
    };
  }

  private isDuplicateAgentProgressTranscriptLine(
    transcript: TranscriptLine[],
    update: AgentProgressUpdateV1,
  ): boolean {
    const previous = transcript[transcript.length - 1];
    if (previous === undefined || previous.role !== "assistant" || previous.text !== update.message) {
      return false;
    }

    return (
      previous.data?.agentProgress === true &&
      previous.data.runId === update.runId &&
      previous.data.seq === update.seq
    );
  }

  private pushRunLog(line: AgentRunLogLine): void {
    const state = this.uiStore.getState();
    const runLogs = [...state.runLogs, line].slice(-MAX_RUN_LOG_LINES);
    const filtered = this.selectors.filterLogs(runLogs, state.logFilters);
    if (state.logFilters.paused || state.scroll.logs.tailLocked === false) {
      const nextScroll = ensureCursorVisible(
        {
          ...state.scroll.logs,
          cursor: Math.min(state.scroll.logs.cursor, Math.max(0, filtered.length - 1)),
        },
        filtered.length,
        this.getListRowsForScroll(state, "logs"),
      );
      this.uiStore.patch({
        runLogs,
        scroll: {
          ...state.scroll,
          logs: nextScroll,
        },
      });
      return;
    }

    const followScroll = ensureCursorVisible(
      {
        ...state.scroll.logs,
        cursor: Math.max(0, filtered.length - 1),
        tailLocked: true,
      },
      filtered.length,
      this.getListRowsForScroll(state, "logs"),
    );

    this.uiStore.patch({
      runLogs,
      scroll: {
        ...state.scroll,
        logs: followScroll,
      },
    });
  }

  private async resolveInitialSelection(
    profiles: TuiProfile[],
  ): Promise<{
    profile: TuiProfile;
    session: TuiSessionMeta;
    workspace?: ResolvedWorkspace | undefined;
  }> {
    if (this.options.freshSessionName !== undefined) {
      const selectedWorkspace = this.launchWorkspace;
      const resolvedProfile = await this.resolveProfileForStartup({
        profiles,
        workspace: selectedWorkspace,
      });
      const sessionName = this.buildUniqueSessionName(this.options.freshSessionName);
      const initialLaunch = resolveOperatorStartTask({
        title: sessionName,
        workspaceBinding: selectedWorkspace !== undefined ? "active" : "detached",
        workspaceId: selectedWorkspace?.manifest.workspaceId,
        workspaceLabel: describeResolvedWorkspace(selectedWorkspace),
        workspaceRoot: selectedWorkspace?.rootPath,
        defaultProfileId: resolvedProfile.id,
        defaultProfileLabel: resolvedProfile.label,
        defaultInteractionMode: resolvedProfile.defaultInteractionMode,
        defaultActSubmode: resolvedProfile.defaultActSubmode,
        requireTitle: true,
      });
      const created = this.createSessionMeta(initialLaunch, resolvedProfile, selectedWorkspace);
      this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, created);
      this.sessionsFile = this.sessionStore.setActive(this.sessionsFile, created.name);
      await this.sessionStore.save(this.sessionsFile);
      this.startupNotices.push(`Started fresh session '${created.name}'.`);
      return {
        profile: resolvedProfile,
        session: created,
        workspace: selectedWorkspace,
      };
    }

    const requestedSessionResolution =
      this.options.sessionName !== undefined
        ? this.sessionStore.resolveSelector(this.sessionsFile, this.options.sessionName)
        : undefined;
    const requestedSession = requestedSessionResolution?.status === "matched"
      ? requestedSessionResolution.session
      : undefined;
    if (this.options.sessionName !== undefined && requestedSessionResolution?.status === "ambiguous") {
      this.startupNotices.push(
        `Session id fragment '${this.options.sessionName}' matched multiple sessions; restored the active session instead.`,
      );
    } else if (this.options.sessionName !== undefined && requestedSessionResolution?.status === "not_found") {
      this.startupNotices.push(
        `Session '${this.options.sessionName}' was not found; restored the active session instead.`,
      );
    }
    const activeSession = requestedSession ?? this.sessionStore.getActive(this.sessionsFile);
    const boundWorkspace = activeSession === undefined
      ? undefined
      : await this.resolveWorkspaceForSession(activeSession);
    const explicitDetachedWorkspace = activeSession?.workspaceBinding === "detached";
    const sessionHasWorkspaceBinding =
      activeSession?.workspaceId !== undefined ||
      activeSession?.workspaceRoot !== undefined;
    const staleSessionWorkspaceBinding =
      activeSession !== undefined &&
      explicitDetachedWorkspace === false &&
      sessionHasWorkspaceBinding &&
      boundWorkspace === undefined;
    const startupWorkspaceConflict =
      requestedSession === undefined &&
      activeSession !== undefined &&
      boundWorkspace !== undefined &&
      this.launchWorkspace !== undefined &&
      path.resolve(boundWorkspace.rootPath) !== path.resolve(this.launchWorkspace.rootPath);
    const selectedWorkspace = explicitDetachedWorkspace
      ? undefined
      : startupWorkspaceConflict || staleSessionWorkspaceBinding
        ? this.launchWorkspace
        : (boundWorkspace ?? this.launchWorkspace);

    const resolvedProfile = await this.resolveProfileForStartup({
      profiles,
      session: activeSession,
      workspace: selectedWorkspace,
    });

    if (activeSession !== undefined) {
      if (startupWorkspaceConflict && selectedWorkspace !== undefined) {
        const sessionName = this.buildUniqueSessionName(
          this.buildStartupWorkspaceSessionTitle(selectedWorkspace),
        );
        const startupLaunch = resolveOperatorStartTask({
          title: sessionName,
          workspaceBinding: "active",
          workspaceId: selectedWorkspace.manifest.workspaceId,
          workspaceLabel: describeResolvedWorkspace(selectedWorkspace),
          workspaceRoot: selectedWorkspace.rootPath,
          defaultProfileId: resolvedProfile.id,
          defaultProfileLabel: resolvedProfile.label,
          defaultInteractionMode: resolvedProfile.defaultInteractionMode,
          defaultActSubmode: resolvedProfile.defaultActSubmode,
          requireTitle: true,
        });
        const created = this.createSessionMeta(startupLaunch, resolvedProfile, selectedWorkspace);
        this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, created);
        await this.sessionStore.save(this.sessionsFile);
        this.startupNotices.push(
          `Started new session '${created.name}' because launch workspace '${selectedWorkspace.manifest.workspaceId}' differed from restored session workspace '${boundWorkspace.manifest.workspaceId}'.`,
        );
        return {
          profile: resolvedProfile,
          session: created,
          workspace: selectedWorkspace,
        };
      }

      const normalized = normalizeSessionMode(activeSession, resolvedProfile);
      const shouldBindLaunchWorkspace =
        explicitDetachedWorkspace === false &&
        this.launchWorkspace !== undefined &&
        (
          (normalized.workspaceId === undefined && normalized.workspaceRoot === undefined) ||
          staleSessionWorkspaceBinding
        );
      const workspaceBound = explicitDetachedWorkspace
        ? {
            ...normalized,
            workspaceBinding: "detached" as const,
            workspaceId: undefined,
            workspaceRoot: undefined,
            workspaceLabel: "Detached workspace",
          }
        : shouldBindLaunchWorkspace
        ? {
            ...normalized,
            workspaceBinding: "active" as const,
            workspaceId: this.launchWorkspace!.manifest.workspaceId,
            workspaceRoot: this.launchWorkspace!.rootPath,
            workspaceLabel: describeResolvedWorkspace(this.launchWorkspace),
          }
        : normalized;
      const patched =
        workspaceBound.profileId === resolvedProfile.id
          ? workspaceBound
          : {
              ...workspaceBound,
              profileId: resolvedProfile.id,
            };

      if (patched !== activeSession) {
        if (normalized !== activeSession) {
          this.startupNotices.push(
            `Normalized session '${activeSession.name}' to explicit mode '${formatSessionMode(normalized)}'.`,
          );
        }
        if (shouldBindLaunchWorkspace) {
          const workspaceId = this.launchWorkspace?.manifest.workspaceId;
          this.startupNotices.push(staleSessionWorkspaceBinding
            ? `Workspace binding for session '${activeSession.name}' was stale; bound to launch workspace '${workspaceId}'.`
            : `Bound session '${activeSession.name}' to workspace '${workspaceId}'.`);
        }
        this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, patched);
      }
      if (requestedSession !== undefined) {
        this.sessionsFile = this.sessionStore.setActive(this.sessionsFile, requestedSession.name);
      }
      await this.sessionStore.save(this.sessionsFile);
      return {
        profile: resolvedProfile,
        session: patched,
        workspace: explicitDetachedWorkspace ? undefined : shouldBindLaunchWorkspace ? this.launchWorkspace : selectedWorkspace,
      };
    }

    const initialLaunch = resolveOperatorStartTask({
      title: "default",
      workspaceBinding: selectedWorkspace !== undefined ? "active" : "detached",
      workspaceId: selectedWorkspace?.manifest.workspaceId,
      workspaceLabel: describeResolvedWorkspace(selectedWorkspace),
      workspaceRoot: selectedWorkspace?.rootPath,
      defaultProfileId: resolvedProfile.id,
      defaultProfileLabel: resolvedProfile.label,
      defaultInteractionMode: resolvedProfile.defaultInteractionMode,
      defaultActSubmode: resolvedProfile.defaultActSubmode,
      requireTitle: true,
    });
    const created = this.createSessionMeta(initialLaunch, resolvedProfile, selectedWorkspace);
    this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, created);
    await this.sessionStore.save(this.sessionsFile);
    return {
      profile: resolvedProfile,
      session: created,
      workspace: selectedWorkspace,
    };
  }

  private async resolveProfileForStartup(input: {
    profiles: TuiProfile[];
    session?: TuiSessionMeta | undefined;
    workspace?: ResolvedWorkspace | undefined;
  }): Promise<TuiProfile> {
    if (this.options.profileId !== undefined) {
      const explicit = this.profileStore.findById(input.profiles, this.options.profileId);
      if (explicit === undefined) {
        throw new Error(`Profile '${this.options.profileId}' not found`);
      }
      return explicit;
    }

    if (input.session !== undefined) {
      const sessionProfile = this.profileStore.findById(input.profiles, input.session.profileId);
      if (sessionProfile !== undefined) {
        return sessionProfile;
      }
      this.startupNotices.push(
        `Session profile '${input.session.profileId}' not found. Falling back to defaults.`,
      );
    }

    const settingsProfileId = this.runtimeSettings.defaults.profileId;
    if (settingsProfileId !== undefined) {
      const settingsProfile = this.profileStore.findById(input.profiles, settingsProfileId);
      if (settingsProfile !== undefined) {
        return this.applyRuntimeSettingsProfileDefaults(settingsProfile);
      }
      this.startupNotices.push(
        `Setup default profile '${settingsProfileId}' not found. Falling back to configured default profile.`,
      );
    }

    return this.applyRuntimeSettingsProfileDefaults(this.profileStore.getDefault(input.profiles));
  }

  private applyRuntimeSettingsProfileDefaults(profile: TuiProfile): TuiProfile {
    const defaults = this.runtimeSettings.defaults;
    return {
      ...profile,
      ...(defaults.approvalPolicyPackId !== undefined
        ? { approvalPolicyPackId: defaults.approvalPolicyPackId }
        : {}),
      ...(defaults.minimalMode === true
        ? {
            defaultInteractionMode: "plan" as const,
            defaultActSubmode: "safe" as const,
          }
        : {}),
    };
  }

  private async resolveWorkspaceForSession(
    session: TuiSessionMeta,
  ): Promise<ResolvedWorkspace | undefined> {
    return this.getWorkspaceController().resolveWorkspaceForSession(session);
  }

  private buildStartupWorkspaceSessionTitle(workspace: ResolvedWorkspace): string {
    return this.getWorkspaceController().buildStartupWorkspaceSessionTitle(workspace);
  }

  private buildUniqueSessionName(baseName: string): string {
    if (this.sessionStore.findByName(this.sessionsFile, baseName) === undefined) {
      return baseName;
    }
    let index = 2;
    while (this.sessionStore.findByName(this.sessionsFile, `${baseName}-${index}`) !== undefined) {
      index += 1;
    }
    return `${baseName}-${index}`;
  }

  private async listDiscoveredWorkspaces(): Promise<ResolvedWorkspace[]> {
    return this.getWorkspaceController().listDiscoveredWorkspaces();
  }

  private resolveWorkspaceSelection(
    raw: string,
    discovered: ResolvedWorkspace[],
  ): WorkspaceSelection {
    return this.getWorkspaceController().resolveWorkspaceSelection(raw, discovered);
  }

  private async resolveWorkspaceFromSelectionValue(
    value: string | undefined,
  ): Promise<ResolvedWorkspace | undefined> {
    return this.getWorkspaceController().resolveWorkspaceFromSelectionValue(value);
  }

  private async refreshWorkspaceForActiveSession(): Promise<ResolvedWorkspace | undefined> {
    return this.getWorkspaceController().refreshWorkspaceForActiveSession();
  }

  private async setActiveSessionState(
    patch: Partial<TuiSessionMeta>,
  ): Promise<void> {
    const state = this.uiStore.getState();
    const nextSession = {
      ...state.activeSession,
      ...patch,
    };
    const activeSession = {
      ...nextSession,
      operatorState: this.buildSessionOperatorState({
        session: nextSession,
        profile: state.activeProfile,
        runtime: patch.operatorState,
      }),
    };
    this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, activeSession);
    this.uiStore.patch({
      activeSession,
      sessions: this.sessionsFile.sessions,
    });
  }

  private shouldApplyCompactionOnContinuationResume(session: TuiSessionMeta): boolean {
    return (
      session.operatorState?.latestAdaptation?.recommendedAction === "compact" ||
      session.operatorState?.context?.compactionState === "armed"
    );
  }

  private async enqueueTranscriptAppend(operation: () => Promise<void>): Promise<void> {
    const next = this.transcriptAppendQueue.then(operation, operation);
    this.transcriptAppendQueue = next.catch(() => {});
    await next;
  }

  private getListRowsForScroll(state: UiRuntimeState, key: "chat" | "logs" | "sessions" | "tasks"): number {
    if (key === "chat") {
      return this.getChatLayout(state).transcriptRows;
    }
    const rows = derivePaneRowCounts(state);
    if (key === "logs") {
      return rows.logs;
    }
    return rows.sessions;
  }

  private resolveCommandBarReturnRegion(state: UiRuntimeState): FocusRegion {
    return state.activeRegion === "command_bar"
      ? "composer"
      : state.activeRegion;
  }

  private resolveCommandBarCloseRegion(state: UiRuntimeState): FocusRegion {
    const region = state.commandBarReturnRegion;
    if (region === undefined || region === "command_bar") {
      return "composer";
    }
    return region;
  }

  private getChatVisualRowCount(
    state: Pick<UiRuntimeState, "transcript" | "viewport" | "detailDrawer" | "activeRegion" | "chatDraft">,
  ): number {
    return countChatVisualRows(
      state.transcript,
      this.getChatLayout(state).wrappedBodyWidth,
    );
  }

  private getChatLayout(
    state: Pick<UiRuntimeState, "viewport" | "detailDrawer" | "activeRegion" | "chatDraft">,
  ): ChatLayoutBudget {
    return this.getChatLayoutForViewport(state, state.viewport);
  }

  private getChatLayoutForViewport(
    state: Pick<UiRuntimeState, "detailDrawer" | "activeRegion" | "chatDraft">,
    viewport: { columns: number; rows: number },
  ): ChatLayoutBudget {
    const provisionalLayout = resolveChatLayoutBudget({
      viewportColumns: viewport.columns,
      viewportRows: viewport.rows,
      detailDrawerOpen: false,
    });
    const composerInputRows = resolveChatComposerInputRows({
      draft: state.chatDraft,
      inputWidth: Math.max(1, provisionalLayout.conversationWidth - 2),
      viewportRows: viewport.rows,
      detailDrawerOpen: false,
    });
    return resolveChatLayoutBudget({
      viewportColumns: viewport.columns,
      viewportRows: viewport.rows,
      detailDrawerOpen: false,
      composerRows: composerInputRows + 1,
    });
  }

  private async persistSessionAndUi(): Promise<void> {
    await this.saveSessionsFile();
    await this.persistUiState();
  }

  private async persistUiState(): Promise<void> {
    try {
      await this.uiStateStore.save(toPersistedUiState(this.uiStore.getState()));
    } catch (error) {
      this.recordPersistenceFailure("ui-state.save", error);
    }
  }

  private async saveSessionsFile(): Promise<void> {
    try {
      await this.sessionStore.save(this.sessionsFile);
    } catch (error) {
      this.recordPersistenceFailure("sessions.save", error);
    }
  }

  private async saveProfiles(profiles: TuiProfile[]): Promise<void> {
    try {
      await this.profileStore.save(profiles);
    } catch (error) {
      this.recordPersistenceFailure("profiles.save", error);
    }
  }

  private recordPersistenceFailure(scope: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.pushRunLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      eventName: "persistence_failed",
      metadata: {
        scope,
        message,
      },
    });
  }

  private async handleStartupFailure(input: {
    summary: string;
    scope: string;
    details?: string | undefined;
    error?: unknown;
  }): Promise<void> {
    await this.appendDiagnosticsLog({
      scope: input.scope,
      summary: input.summary,
      details: input.details ?? formatDiagnosticError(input.error),
    });
    await this.finalizeSplashPreflightPhase({
      phase: "failed",
      summary: `${input.summary} | log: ${this.diagnosticsStore.getDisplayPath()}`,
      statusLine: this.withMcpSummary("startup failed"),
    });
  }

  private async appendRunFailureDiagnostics(
    error: {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    } | undefined,
  ): Promise<void> {
    await this.getRunController().appendRunFailureDiagnostics(error);
  }

  private async appendTerminalHandoffDiagnostics(input: {
    scope: string;
    summary: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    await this.getRunController().appendTerminalHandoffDiagnostics(input);
  }

  private async appendDiagnosticsLog(input: {
    scope: string;
    summary: string;
    details?: string | undefined;
  }): Promise<void> {
    try {
      const state = this.uiStore.getState();
      await this.diagnosticsStore.append({
        scope: input.scope,
        summary: input.summary,
        ...(input.details !== undefined ? { details: input.details } : {}),
        sessionId: state.activeSession.sessionId,
        profileId: state.activeProfile.id,
        workspaceId: this.activeWorkspace?.manifest.workspaceId,
        cwd: this.options.cwd,
      });
    } catch (error) {
      this.recordPersistenceFailure("diagnostics.append", error);
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.uiStore.patch({
      statusLine: this.withMcpSummary("exiting"),
      running: false,
    });

    try {
      await this.persistSessionAndUi();
    } catch {
      // Persistence failures should not block shutdown.
    }

    this.missionControlReporter?.stop();
    this.missionControlReporter = undefined;
    await this.client.close();
    this.inkInstance?.unmount();
    this.inkInstance = undefined;
    this.leaveAlternateScreen();
    const resolveDone = this.resolveDone;
    this.resolveDone = undefined;
    resolveDone?.();
  }

  private enterAlternateScreen(): void {
    if (!process.stdout.isTTY || this.alternateScreenEnabled) {
      return;
    }
    process.stdout.write("\u001b[?1049h\u001b[2J\u001b[H");
    this.alternateScreenEnabled = true;
  }

  private leaveAlternateScreen(): void {
    if (!(process.stdout.isTTY && this.alternateScreenEnabled)) {
      return;
    }
    process.stdout.write("\u001b[?1049l");
    this.alternateScreenEnabled = false;
  }
}

function viewForRegion(region: FocusRegion): AppView {
  if (region === "sessions") {
    return "sessions";
  }
  if (region === "logs") {
    return "logs";
  }
  return "chat";
}

function resolveViewForRegion(currentView: AppView, region: FocusRegion): AppView {
  if (region !== "sessions") {
    return viewForRegion(region);
  }
  return currentView === "history" ||
    currentView === "workspace" ||
    currentView === "tasks" ||
    currentView === "mcp" ||
    currentView === "code" ||
    currentView === "delegation" ||
    currentView === "recovery"
    ? currentView
    : viewForRegion(region);
}

function normalizeDetailRegionForView(activeView: AppView, region: FocusRegion): FocusRegion {
  if (region === "details" && activeView === "chat") {
    return "composer";
  }
  return region;
}

function formatBackViewLabel(view: AppView): string {
  if (view === "history") {
    return "History";
  }
  if (view === "workspace") {
    return "Workspace";
  }
  if (view === "mcp") {
    return "MCP Workspace";
  }
  if (view === "code") {
    return "Code Workspace";
  }
  if (view === "delegation") {
    return "Delegation Review";
  }
  if (view === "recovery") {
    return "Recovery Center";
  }
  if (view === "logs") {
    return "Activity";
  }
  if (view === "tasks") {
    return "Tasks";
  }
  if (view === "sessions") {
    return "Sessions";
  }
  return "Chat";
}

function slugify(value: string): string {
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);

  return compact.length === 0 ? "session" : compact;
}

export function isSameWaitFor(
  left: Exclude<import("../../src/index.js").NormalizedOutput["waitFor"], undefined> | undefined,
  right: Exclude<import("../../src/index.js").NormalizedOutput["waitFor"], undefined> | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  if (left.eventType !== right.eventType) {
    return false;
  }

  const leftPrompt = extractWaitPrompt(left);
  const rightPrompt = extractWaitPrompt(right);
  return leftPrompt === rightPrompt;
}

const FINALIZE_REPORTING_GROUNDING_FIELDS = [
  "summary",
  "blockers",
  "residualRisks",
  "completionState",
] as const;

type FinalizeReportingGroundingLabel = "model_authored" | "runtime_linked" | "inferred_from_workplan";

function buildFinalizeReportingGroundingNotice(
  data: Record<string, unknown> | undefined,
): string | undefined {
  const reportingGrounding = asRecord(data?.reportingGrounding);
  if (reportingGrounding === undefined) {
    return ;
  }
  const labeledFields = FINALIZE_REPORTING_GROUNDING_FIELDS
    .map((field) => {
      const label = asReportingGroundingLabel(reportingGrounding[field]);
      return label === undefined ? undefined : `${field}=${label}`;
    })
    .filter((entry): entry is string => entry !== undefined);
  if (labeledFields.length === 0) {
    return ;
  }
  return [
    `Finalize provenance: ${labeledFields.join(", ")}.`,
    "Fields labeled model_authored are narrative and not runtime-verified facts.",
  ].join(" ");
}

function asReportingGroundingLabel(value: unknown): FinalizeReportingGroundingLabel | undefined {
  return value === "model_authored" || value === "runtime_linked" || value === "inferred_from_workplan"
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }

  return value as Record<string, unknown>;
}

function buildSplashPreflightState(input: {
  profile: TuiProfile;
  session: TuiSessionMeta;
  themeMode: ThemeMode;
}): SplashPreflightState {
  const themeSelection = resolveThemeSelection({
    mode: input.themeMode,
    overrides: input.profile.theme,
  });
  const activeSkillPack = getSkillPackById(input.session.activeSkillPackId);
  const skillsDetail =
    input.session.activeSkillPackId === undefined
      ? "builtin packs ready"
      : activeSkillPack !== undefined
        ? `active=${activeSkillPack.id}`
        : `missing=${input.session.activeSkillPackId}`;

  return {
    phase: "running",
    summary: "pre-flight checks in progress",
    checks: [
      { id: "profiles", label: "profiles", state: "ok", detail: input.profile.id },
      { id: "session", label: "session", state: "ok", detail: input.session.name },
      { id: "theme", label: "theme", state: "ok", detail: `${themeSelection.mode}:${themeSelection.resolvedMode}` },
      {
        id: "skills",
        label: "skills",
        state: activeSkillPack === undefined && input.session.activeSkillPackId !== undefined ? "fail" : "ok",
        detail: skillsDetail,
      },
      { id: "runner", label: "runner", state: "pending", detail: "waiting" },
      { id: "handshake", label: "handshake", state: "pending", detail: input.session.sessionId },
      { id: "database", label: "database", state: "pending", detail: "waiting" },
      { id: "provider", label: "credentials", state: "pending", detail: input.profile.modelProvider ?? "openrouter" },
      { id: "mcp", label: "mcp", state: "pending", detail: "waiting" },
    ],
  };
}

function resolveRequiredPreflightEnvVars(profile: TuiProfile, session: TuiSessionMeta): string[] {
  const required = new Set<string>();
  const provider = profile.modelProvider ?? "openrouter";
  if (provider === "openai") {
    required.add("OPENAI_API_KEY");
  } else if (provider === "anthropic") {
    required.add("ANTHROPIC_API_KEY");
  } else if (provider === "ollama" || provider === "lmstudio") {
    // Local OpenAI-compatible providers do not require API credentials by default.
  } else {
    required.add("OPENROUTER_API_KEY");
  }

  const skillPack = getSkillPackById(session.activeSkillPackId);
  const effectiveProfile = applySkillPackToProfile(profile, skillPack);
  const usesInternet = (effectiveProfile.toolAllowlist ?? []).some((toolName) => toolName.startsWith("internet."));
  if (usesInternet) {
    required.add("TAVILY_API_KEY");
  }

  return [...required];
}

function readEnvValue(name: string): string {
  return typeof process.env[name] === "string" ? process.env[name]?.trim() ?? "" : "";
}

function truncatePreflightDetail(value: string): string {
  return truncate(value.replace(/\s+/gu, " ").trim(), 48);
}

function formatDiagnosticError(error: unknown): string | undefined {
  if (error === undefined) {
    return ;
  }
  if (error instanceof Error) {
    const diagnostics = asRunnerExitDiagnostics(error);
    if (diagnostics !== undefined) {
      return [
        error.stack ?? error.message,
        "",
        "runner diagnostics:",
        ...(diagnostics.lastProcessError !== undefined
          ? [`lastProcessError: ${diagnostics.lastProcessError}`]
          : []),
        ...diagnostics.recentStderr.map((line) => `stderr: ${line}`),
      ].join("\n");
    }
    return error.stack ?? error.message;
  }
  return String(error);
}

function stringifyDiagnosticDetails(value: unknown): string | undefined {
  if (value === undefined) {
    return ;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolveRunFailureSummary(payload: {
  result?:
    | {
        output?: {
          errors?: Array<{
            code?: unknown;
            message?: unknown;
          }>;
        };
      }
    | undefined;
  error?: {
    code?: unknown;
    message?: unknown;
  } | undefined;
}): {
  code: string;
  message?: string | undefined;
} {
  const primary = payload.result?.output?.errors?.[0];
  const code =
    readNonEmptyText(primary?.code) ??
    readNonEmptyText(payload.error?.code) ??
    "RUN_FAILED";
  const message =
    readNonEmptyText(primary?.message) ??
    readNonEmptyText(payload.error?.message);

  return {
    code,
    ...(message !== undefined ? { message } : {}),
  };
}

export function resolveRunFailureSummaryForTests(payload: {
  result?:
    | {
        output?: {
          errors?: Array<{
            code?: unknown;
            message?: unknown;
          }>;
        };
      }
    | undefined;
  error?: {
    code?: unknown;
    message?: unknown;
  } | undefined;
}): {
  code: string;
  message?: string | undefined;
} {
  return resolveRunFailureSummaryFromController(payload);
}

function readNonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRunnerExitDiagnostics(
  error: Error,
): { lastProcessError?: string | undefined; recentStderr: string[] } | undefined {
  const candidate = (error as Error & {
    runnerExitDiagnostics?: { lastProcessError?: string | undefined; recentStderr?: unknown };
  }).runnerExitDiagnostics;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return ;
  }
  const recentStderr = Array.isArray(candidate.recentStderr)
    ? candidate.recentStderr.filter((line): line is string => typeof line === "string")
    : [];
  return {
    ...(typeof candidate.lastProcessError === "string"
      ? { lastProcessError: candidate.lastProcessError }
      : {}),
    recentStderr,
  };
}

function readSplashPreflightErrorCheckId(error: unknown): string | undefined {
  const checkId = (error as { checkId?: unknown })?.checkId;
  return typeof checkId === "string" && checkId.trim().length > 0 ? checkId : undefined;
}

function summarizeMcpSummary(status: McpStatusSnapshot): string {
  const enabled = status.servers.filter((server) => server.enabled);
  if (enabled.length === 0) {
    return "mcp:none";
  }
  const healthy = enabled.filter((server) => server.healthy).length;
  return `mcp:${healthy}/${enabled.length}`;
}

function normalizeSessionMode(session: TuiSessionMeta, profile: TuiProfile): TuiSessionMeta {
  const resolved = normalizeInteractionMode({
    interactionMode: session.interactionMode ?? profile.defaultInteractionMode,
    actSubmode: session.actSubmode ?? profile.defaultActSubmode,
    defaultInteractionMode: profile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
    defaultActSubmode: profile.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
  });
  const alignedExecutionPolicy = alignExecutionPolicyWithMode({
    executionPolicy: session.executionPolicy,
    interactionMode: resolved.interactionMode,
    actSubmode: resolved.actSubmode,
  });

  const changed =
    session.interactionMode !== resolved.interactionMode ||
    (session.actSubmode ?? undefined) !== (resolved.actSubmode ?? undefined) ||
    session.executionPolicy !== alignedExecutionPolicy ||
    session.autoCompactionEnabled === undefined;
  if (changed === false) {
    return session;
  }

  return {
    ...session,
    interactionMode: resolved.interactionMode,
    autoCompactionEnabled: session.autoCompactionEnabled ?? true,
    ...(resolved.actSubmode !== undefined ? { actSubmode: resolved.actSubmode } : { actSubmode: undefined }),
    ...(alignedExecutionPolicy !== undefined ? { executionPolicy: alignedExecutionPolicy } : {}),
  };
}

function findLatestSelectedLane(runLogs: AgentRunLogLine[]): string | undefined {
  for (let index = runLogs.length - 1; index >= 0; index -= 1) {
    const entry = runLogs[index];
    if (entry?.eventName !== "route_decision") {
      continue;
    }
    const selectedLane = entry.metadata?.executionLane ?? entry.metadata?.selectedLane;
    if (typeof selectedLane === "string" && selectedLane.trim().length > 0) {
      return selectedLane;
    }
  }
  return ;
}

function formatSessionMode(session: Pick<TuiSessionMeta, "interactionMode" | "actSubmode">): string {
  return formatUserFacingModeLabel({
    interactionMode: session.interactionMode ?? DEFAULT_INTERACTION_MODE,
    actSubmode: session.actSubmode ?? DEFAULT_ACT_SUBMODE,
  });
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return ;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code : undefined;
}

function readErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return ;
  }
  const details = (error as { details?: unknown }).details;
  return typeof details === "object" && details !== null && Array.isArray(details) === false
    ? details as Record<string, unknown>
    : undefined;
}

export function resolveDatabasePreflightTargetForTests(databaseUrl: string): {
  host: string;
  port: number;
  database: string;
  isLocalHarnessDefault: boolean;
} {
  return resolveDatabasePreflightTarget(databaseUrl);
}

export function resolveDatabaseSelfHealPolicyForTests(input: {
  databaseUrl: string;
  failureCode?: string | undefined;
  envValue?: string | undefined;
  defaultEnabled?: boolean | undefined;
}): {
  canAttempt: boolean;
  reason:
    | "enabled_local_refused"
    | "disabled"
    | "non_local_target"
    | "unsupported_failure_code";
} {
  return resolveDatabaseSelfHealPolicy({
    target: resolveDatabasePreflightTarget(input.databaseUrl),
    failureCode: input.failureCode,
    envValue: input.envValue,
    defaultEnabled: input.defaultEnabled,
  });
}

export {
  resolveDockerCommandForSelfHealForTests,
  shouldLaunchDockerDesktopForSelfHealForTests,
};

function getEntryStepAgent(profile: TuiProfile): string {
  if (profile.agent === "reference-react") {
    return AGENT_STEP_IDS.loop;
  }

  throw new Error(`Unsupported profile agent '${profile.agent}'`);
}
