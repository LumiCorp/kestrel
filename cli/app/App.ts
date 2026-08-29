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
  resolveChatActivityRows,
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
import {
  bootstrapTuiApp,
  resolveProfileForStartup as resolveSharedProfileForStartup,
  runSplashDatabasePreflight,
} from "./TuiBootstrap.js";
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
import {
  advanceTuiQueueAuthority,
  bindTuiQueueSuccessor,
  normalizeTuiQueueGraph,
  removeAndRewireTuiQueueRecord,
  resolveExactTuiQueuedEvidence,
} from "../session/TuiQueueGraph.js";
import type { LocalCoreConnectionManager } from "../../src/localCore/connectionManager.js";
import type { LocalCoreExecutionProfileResolution } from "../../src/localCore/contracts.js";
import {
  defaultTuiEnvironmentPresetId,
  readAuthoritativeRunStartRejection,
  resolveTuiSessionEnvironment,
  toResolvedSessionIdentity,
  TuiEnvironmentIdentityError,
  type TuiEnvironmentPresetId,
} from "../session/TuiExecutionEnvironment.js";
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
  readExactReview,
  readExactReviewOptionIds,
  resolveExactReviewOptionId,
  resolveBlockedWaitModeReply,
} from "./waitForPrompt.js";
import { projectTuiTerminalOutcome } from "./TuiConversationAdapter.js";
import {
  decorateOperatorAffordance,
  formatOperatorAffordance,
} from "../runtime/operatorAffordances.js";
import { buildOperatorAffordanceFromSessionProjection } from "../../src/orchestration/OperatorAffordanceProjection.js";
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
  private localCoreConnectionManager: LocalCoreConnectionManager | undefined;
  private runnerUsesLocalCore = false;
  private missionControlReporter: MissionControlRuntimeReporter | undefined;
  private runtimeSettings: RuntimeSettingsFile = {
    version: 1,
    defaults: {},
  };
  private bootstrapHintShown = false;
  private transcriptAppendQueue: Promise<void> = Promise.resolve();
  private sessionsFileCommitTail: Promise<void> = Promise.resolve();
  private readonly queueSessionCommitTailBySession = new Map<string, Promise<void>>();
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
      getLocalCoreClient: () => this.getCurrentLocalCoreClient(),
      prepareLocalCoreClient: async () => await this.prepareLocalCoreClient(),
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
      appendHistoryLine: (role, text, data, output, eventId) =>
        this.appendHistoryLine(role, text, data, output, eventId),
      appendSessionHistoryLine: async (sessionId, role, text, data, output, eventId) => {
        const session = this.sessionsFile.sessions.find((candidate) => candidate.sessionId === sessionId);
        if (session === undefined) return;
        await this.appendSessionHistoryLine(session, role, text, data, output, eventId);
      },
      persistSessionAndUi: (options) => this.persistSessionAndUi(options),
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

  private getCurrentLocalCoreClient(): import("../../src/localCore/client.js").LocalCoreClient | undefined {
    return this.localCoreConnectionManager?.current()?.client ?? this.localCoreStatus?.client;
  }

  private async prepareLocalCoreClient(): Promise<import("../../src/localCore/client.js").LocalCoreClient | undefined> {
    if (this.localCoreConnectionManager !== undefined) {
      await this.localCoreConnectionManager.executeIdempotent(
        async (client) => await client.health(),
      );
    }
    return this.getCurrentLocalCoreClient();
  }

  private getActiveRunnerMetadata(): RunnerCommandMetadata {
    return {};
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
    this.localCoreConnectionManager = bootstrap.localCoreConnectionManager;
    this.runnerUsesLocalCore = usesLocalCoreRunnerTransport(
      bootstrap.runnerTransportEnv,
    );
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

    this.client = createConfiguredCliProtocolClient(bootstrap.runnerTransportEnv, {
      beforeSend: bootstrap.prepareRunnerSend,
    });
    this.client.onEvent((event) => {
      this.onRunnerEvent(event);
    });
    await this.recoverTerminalMessages(bootstrap.activeSession).catch(() => {
      // Recovery is retried when the session is next focused.
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
      const activeDelegationStatus = state.activeSession.delegation?.status;
      const activeSessionNeedsBackgroundReconciliation =
        activeDelegationStatus === "PENDING" || activeDelegationStatus === "RECOVERING";
      if (activeSessionNeedsBackgroundReconciliation) {
        await this.reconcileBackgroundSessionDescription(
          describe.payload,
          state.activeSession.started !== true,
        );
      } else {
        await this.syncSessionFromDescribePayload(describe.payload);
      }
      await this.reconcilePendingBackgroundSessions(
        activeSessionNeedsBackgroundReconciliation ? state.activeSession.sessionId : undefined,
      );
      await this.reconcilePendingForegroundQueueSessions(state.activeSession.sessionId);
      this.updateSplashPreflightCheck("handshake", {
        state: "ok",
        detail: "session linked",
      });

      this.setSplashPreflightSummary("verifying credentials");
      this.updateSplashPreflightCheck("provider", {
        state: "running",
        detail: "checking runtime",
      });
      const provider = state.activeProfile.modelProvider ?? "openrouter";
      const core = this.runnerUsesLocalCore
        ? await this.prepareLocalCoreClient()
        : undefined;
      const coreReadiness = core === undefined
        ? undefined
        : await core.providerReadiness();
      if (core !== undefined) {
        const readiness = coreReadiness?.providerReadiness[provider];
        if (readiness === undefined) {
          throw new Error(`Local Core did not report readiness for provider '${provider}'.`);
        }
        if (readiness.ready === false) {
          const credentialName = resolveProviderCredentialEnvVar(provider);
          const credentialDetail = readiness.credential === "missing" && credentialName !== undefined
            ? `missing ${credentialName}`
            : `credential ${readiness.credential}`;
          const message = [
            `Local Core provider '${provider}' is ${credentialDetail}.`,
            "Restart Local Core from this environment or configure the provider credential.",
          ].join(" ");
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
        if (usesTavilyTools(state.activeProfile)) {
          const tavilyReadiness = coreReadiness?.toolReadiness.tavily;
          if (tavilyReadiness === undefined) {
            throw new Error("Local Core did not report readiness for Tavily.");
          }
          if (tavilyReadiness.ready === false) {
            const credentialDetail = tavilyReadiness.credential === "missing"
              ? "missing TAVILY_API_KEY"
              : `credential ${tavilyReadiness.credential}`;
            const message = [
              `Local Core tool 'Tavily' is ${credentialDetail}.`,
              "Restart Local Core from this environment or configure the tool credential.",
            ].join(" ");
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
        }
      }
      const requiredEnv = resolveRequiredPreflightEnvVars(
        state.activeProfile,
        state.activeSession,
        core === undefined,
      );
      const missingEnv = requiredEnv.filter(
        (envName) => readEnvValue(envName).length === 0,
      );
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
        detail: core !== undefined
          ? `${provider} ready in Local Core`
          : requiredEnv.join(", "),
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
              chat: {
                ...next,
                tailLocked: atEnd,
              },
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
              chat: {
                ...next,
                tailLocked: atEnd,
              },
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
              chat: {
                ...next,
                tailLocked: to === "end",
              },
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
    if (
      this.shouldDispatchImmediateOperatorCommand(line)
      || (
        this.uiStore.getState().running === true
        && parseInput(line).kind === "message"
      )
    ) {
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
        recoverTerminalMessages: (session) => this.recoverTerminalMessages(session),
        getConversationActivity: (sessionId) =>
          this.getRunController().getConversationActivity(sessionId),
        getConversationRunState: (sessionId) =>
          this.getRunController().getConversationRunState(sessionId),
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
        resolveWorkspaceForSession: (session) => this.resolveWorkspaceForSession(session),
        shouldApplyCompactionOnContinuationResume: (session) =>
          this.shouldApplyCompactionOnContinuationResume(session),
        buildSessionOperatorState: (input) => this.buildSessionOperatorState(input),
        appendDiagnosticsLog: (input) => this.appendDiagnosticsLog(input),
        handleTaskUpdatedEvent: (task, kind, assistantText, finalizedPayload) =>
          this.handleTaskUpdatedEvent(task, kind, assistantText, finalizedPayload),
        syncForegroundSessionProgress: (input) => this.syncForegroundSessionProgress(input),
        syncForegroundQueuedTerminal: (input) => this.syncForegroundQueuedTerminal(input),
        setSessionState: (sessionId, patch) => this.setSessionState(sessionId, patch),
        commitQueueSessionState: (sessionId, patch) => this.commitQueueSessionState(sessionId, patch),
        syncBackgroundSessionProgress: (input) => this.syncBackgroundSessionProgress(input),
        syncBackgroundSessionResult: (expectedSessionId, expectedRunId, allowUnstartedAcceptance, output, assistantText, finalizedPayload, operatorState) =>
          this.syncBackgroundSessionResult(expectedSessionId, expectedRunId, allowUnstartedAcceptance, output, assistantText, finalizedPayload, operatorState),
        syncBackgroundSessionFailure: (expectedSessionId, expectedRunId, outputSessionId, message) =>
          this.syncBackgroundSessionFailure(expectedSessionId, expectedRunId, outputSessionId, message),
        syncSessionFromDescribePayload: (payload) => this.syncSessionFromDescribePayload(payload),
        applyTerminalResult: (sessionId, result, finalizedPayload) => this.applyTerminalResult(sessionId, result, finalizedPayload),
        recoverTerminalMessages: (session) => this.recoverTerminalMessages(session),
        getChatWrappedBodyWidth: () => this.getChatLayout(this.uiStore.getState()).wrappedBodyWidth,
        getChatListRows: () => this.getListRowsForScroll(this.uiStore.getState(), "chat"),
        pushRunLog: (line) => {
          this.pushRunLog(line);
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

    const initialState = this.uiStore.getState();
    const exactReview = readExactReview(
      initialState.activeSession.pendingWaitFor,
    );
    if (exactReview.kind === "invalid_review") {
      await this.appendHistoryLine(
        "system",
        `${exactReview.error} Use /stop to end the waiting run.`,
      );
      return;
    }
    const exactReviewOptionId = resolveExactReviewOptionId(
      initialState.activeSession.pendingWaitFor,
      rawLine,
    );
    const exactReviewOptionIds = readExactReviewOptionIds(
      initialState.activeSession.pendingWaitFor,
    );
    if (exactReviewOptionIds.length > 0 && exactReviewOptionId === undefined) {
      await this.appendHistoryLine(
        "system",
        `Choose one exact option: ${exactReviewOptionIds.join(", ")}`,
      );
      return;
    }
    const blockedModeReply = resolveBlockedWaitModeReply(
      initialState.activeSession.pendingWaitFor,
      rawLine,
    );
    const composerPolicy = this.getRunController().getConversationComposerPolicy();
    if (
      initialState.activeSession.pendingWaitFor?.kind === "approval"
      || composerPolicy.mode === "blocked_interaction"
    ) {
      this.uiStore.patch({
        statusLine: this.withMcpSummary("approval requires explicit /approve or /reject"),
      });
      return;
    }
    this.uiStore.patch({ chatDraft: "" });
    const shouldResumeBlockedRun =
      blockedModeReply?.resumeBlockedRun === true ||
      exactReviewOptionId !== undefined ||
      initialState.activeSession.pendingWaitFor?.eventType === "user.reply";
    const shouldUsePendingWait = shouldResumeBlockedRun;
    const shouldForceFreshTurn =
      initialState.activeSession.pendingWaitFor !== undefined && shouldUsePendingWait === false;
    let optimisticMessageId: string | undefined;
    const interactionTurnId = shouldResumeBlockedRun
      ? this.getRunController().resolveInteractionTurnId(
          initialState.activeSession.pendingWaitFor?.interaction?.requestId?.trim() ?? "",
        )
      : undefined;
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
      const messageId = `tui:${randomUUID()}`;
      optimisticMessageId = messageId;
      await this.appendHistoryLine("user", rawLine, {
        kind: "tui.user-message.v1",
        messageId,
        deliveryState: "submitting",
        ...(interactionTurnId !== undefined ? { turnId: interactionTurnId } : {}),
      }, undefined, messageId);
    }

    const submittedMessage = this.resolveBlockedRunSubmittedMessage(
      initialState.activeSession.pendingWaitFor,
      rawLine,
    );
    await this.startActiveTurn({
      ...(optimisticMessageId !== undefined ? { messageId: optimisticMessageId } : {}),
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

  private async handleCommand(parsed: Extract<ParsedInput, { kind: "command" }>): Promise<void> {
    await this.getCommandRouter().handle(parsed);
  }

  private async handleQueueCommand(args: string[]): Promise<void> {
    const message = args.join(" ").trim();
    if (message.length === 0) {
      await this.appendHistoryLine("system", "Usage: /queue <message>");
      return;
    }
    const messageId = `tui:${randomUUID()}`;
    await this.appendHistoryLine("user", message, {
      kind: "tui.user-message.v1",
      messageId,
      deliveryState: "submitting",
    }, undefined, messageId);
    await this.startActiveTurn({
      messageId,
      submittedMessage: message,
      queueRequested: true,
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

  private async handleTasksCommand(args: string[]): Promise<void> {
    const [subcommand, ...rest] = args;
    const state = this.uiStore.getState();
    const tasks = this.listChildTaskSessions(state.activeSession.sessionId);

    if (subcommand === undefined || subcommand === "list") {
      const lines = tasks.map((session) => {
        const delegation = session.delegation!;
        return `${session.name} [${delegation.status}] provider=${delegation.provider}/${delegation.model}`;
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
        status: "PENDING",
        childSessionId: childSession.sessionId,
        childSessionName: childSession.name,
        profileId: profile.id,
        provider: profile.modelProvider ?? "openrouter",
        model: profile.model ?? "(env default)",
        launchedBy: "operator",
        createdAt: now,
        updatedAt: now,
      };
      const inheritedEnvironmentPresetId = resolveTuiSessionEnvironment({
        session: state.activeSession,
      });
      const delegatedSession: TuiSessionMeta = {
        ...childSession,
        environmentPresetId: inheritedEnvironmentPresetId,
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

      const effectiveProfile = profile;
      let executionProfile: LocalCoreExecutionProfileResolution;
      try {
        const core = await this.prepareLocalCoreClient();
        if (core === undefined) {
          throw new Error(
            "Kestrel Local Core is required to resolve background execution profiles.",
          );
        }
        executionProfile = await core.resolveExecutionProfile({
          client: "cli",
          profileId: profile.id,
          environmentPresetId: inheritedEnvironmentPresetId,
        });
        Object.assign(
          delegatedSession,
          toResolvedSessionIdentity(executionProfile, inheritedEnvironmentPresetId),
        );
        this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, delegatedSession);
        this.uiStore.patch({ sessions: this.sessionsFile.sessions });
        await this.saveSessionsFile();
      } catch (error) {
        await this.failBackgroundLaunchSetup(
          delegatedSession,
          delegation,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const pendingRunId = `tui-background:${randomUUID()}`;
      const pendingSession: TuiSessionMeta = {
        ...delegatedSession,
        pendingRunId,
        pendingRunThreadId: delegatedSession.sessionId,
        updatedAt: new Date().toISOString(),
      };
      this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, pendingSession);
      this.uiStore.patch({ sessions: this.sessionsFile.sessions });
      await this.saveSessionsFile();
      void this.client.sendCommand("run.start", {
        profileId: executionProfile.profileId,
        turn: {
          sessionId: delegatedSession.sessionId,
          runId: pendingRunId,
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
          stepAgent: getEntryStepAgent(effectiveProfile),
        },
      }).then(async (response) => {
        await this.syncBackgroundLaunchResponse(
          delegatedSession.sessionId,
          delegatedSession.sessionId,
          pendingRunId,
          response,
        );
      }).catch(async (error) => {
        await this.reconcileBackgroundLaunchSubmissionFailure(
          delegatedSession,
          delegation,
          error,
        );
      });
      return;
    }

    await this.appendHistoryLine(
      "system",
      "Usage: /tasks [list] | /tasks open <name> | /tasks launch <profileId> <prompt...>",
    );
  }

  private async failBackgroundLaunchSetup(
    session: TuiSessionMeta,
    delegation: DelegationTaskMeta,
    message: string,
  ): Promise<void> {
    const failedDelegation: DelegationTaskMeta = {
      ...delegation,
      status: "FAILED",
      errorMessage: message,
      updatedAt: new Date().toISOString(),
    };
    const failedSession: TuiSessionMeta = {
      ...session,
      started: false,
      pendingRunId: undefined,
      pendingRunMessageId: undefined,
      pendingRunThreadId: undefined,
      lastRunStatus: "FAILED",
      delegation: failedDelegation,
      updatedAt: failedDelegation.updatedAt,
    };
    this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, failedSession);
    this.uiStore.patch({ sessions: this.sessionsFile.sessions });
    await this.saveSessionsFile();
    await this.appendSessionHistoryLine(
      failedSession,
      "system",
      `Background task setup failed: ${message}`,
      undefined,
      undefined,
      `delegation-start-failed:${delegation.taskId}`,
    );
    await this.appendHistoryLine(
      "system",
      `Background task '${failedSession.name}' failed to start: ${message}`,
      undefined,
      undefined,
      `delegation-launch-failed:${delegation.taskId}`,
    );
  }

  private async syncBackgroundLaunchResponse(
    sessionId: string,
    expectedThreadId: string,
    expectedRunId: string,
    response: RunnerEvent,
  ): Promise<void> {
    if (response.threadId !== undefined && response.threadId !== expectedThreadId) return;
    if (response.type === "run.completed") {
      const output = response.payload.result.output;
      if (
        output.sessionId !== sessionId
        || output.runId !== expectedRunId
        || (response.sessionId !== undefined && response.sessionId !== sessionId)
        || (response.runId !== undefined && response.runId !== output.runId)
      ) return;
      await this.syncBackgroundSessionResult(
        sessionId,
        expectedRunId,
        true,
        output,
        response.payload.result.assistantText,
        response.payload.result.finalizedPayload,
        response.payload.result.operatorAffordance,
      );
      return;
    }
    if (response.type === "run.failed" && response.payload.result !== undefined) {
      const output = response.payload.result.output;
      if (
        output.sessionId !== sessionId
        || output.runId !== expectedRunId
        || (response.sessionId !== undefined && response.sessionId !== sessionId)
        || (response.runId !== undefined && response.runId !== output.runId)
      ) return;
      const session = this.sessionsFile.sessions.find((item) => item.sessionId === sessionId);
      if (session?.acceptedRunId === output.runId) {
        await this.syncBackgroundSessionFailure(
          sessionId,
          output.runId,
          output.sessionId,
          response.payload.error.message,
        );
      } else if (session?.delegation !== undefined) {
        await this.failBackgroundLaunchSetup(session, session.delegation, response.payload.error.message);
      }
      return;
    }
    if (response.type === "run.cancelled") {
      const output = response.payload.result.output;
      if (
        output.sessionId !== sessionId
        || output.runId !== expectedRunId
        || (response.sessionId !== undefined && response.sessionId !== sessionId)
        || (response.runId !== undefined && response.runId !== output.runId)
      ) return;
      const session = this.sessionsFile.sessions.find((item) => item.sessionId === sessionId);
      const message = output.errors[0]?.message ?? "Run cancelled.";
      if (session?.acceptedRunId === output.runId) {
        await this.syncBackgroundSessionFailure(sessionId, output.runId, output.sessionId, message);
      } else if (session?.delegation !== undefined) {
        await this.failBackgroundLaunchSetup(session, session.delegation, message);
      }
      return;
    }
    const message = response.type === "run.failed"
      ? response.payload.error.message
      : `Unexpected background launch response '${response.type}'.`;
    const session = this.sessionsFile.sessions.find((item) => item.sessionId === sessionId);
    if (session?.delegation !== undefined) {
      await this.reconcileBackgroundLaunchSubmissionFailure(session, session.delegation, new Error(message));
    }
  }

  private async reconcileBackgroundLaunchSubmissionFailure(
    session: TuiSessionMeta,
    delegation: DelegationTaskMeta,
    error: unknown,
  ): Promise<void> {
    const authoritativeRejection = readAuthoritativeRunStartRejection(error);
    if (authoritativeRejection !== undefined) {
      const current = this.sessionsFile.sessions.find((item) => item.sessionId === session.sessionId);
      if (current?.started === true) return;
      await this.failBackgroundLaunchSetup(
        current ?? session,
        current?.delegation ?? delegation,
        authoritativeRejection.message,
      );
      return;
    }
    try {
      const described = await this.client.sendCommand("session.describe", {
        sessionId: session.sessionId,
      });
      if (
        described.type === "session.described"
        && (
          described.payload.threadId !== undefined
          || described.payload.focusedThreadId !== undefined
          || described.payload.activeAssembly !== undefined
        )
      ) {
        const before = this.sessionsFile.sessions.find((item) => item.sessionId === session.sessionId);
        await this.reconcileBackgroundSessionDescription(described.payload, before?.started !== true);
        return;
      }
    } catch {
      // A durable run.started event may already have established acceptance while the response was lost.
    }
    const current = this.sessionsFile.sessions.find((item) => item.sessionId === session.sessionId);
    if (current?.started === true) return;
  }

  private async reconcilePendingBackgroundSessions(skipSessionId?: string): Promise<void> {
    const pending = this.sessionsFile.sessions.filter((session) =>
      session.sessionId !== skipSessionId
      && session.delegation !== undefined
      && (session.delegation.status === "PENDING" || session.delegation.status === "RECOVERING")
    );
    for (const session of pending) {
      try {
        const described = await this.client.sendCommand("session.describe", {
          sessionId: session.sessionId,
        });
        if (described.type !== "session.described" || described.payload.sessionId !== session.sessionId) {
          continue;
        }
        await this.reconcileBackgroundSessionDescription(described.payload, session.started !== true);
      } catch {
        // Durable authority may be temporarily unavailable; keep the child recoverable.
      }
    }
  }

  private async reconcilePendingForegroundQueueSessions(skipSessionId?: string): Promise<void> {
    const pending = this.sessionsFile.sessions.filter((session) =>
      session.sessionId !== skipSessionId
      && (
        (session.pendingQueueSubmissions?.length ?? 0) > 0
        || (session.queuedRunReservations?.length ?? 0) > 0
      )
    );
    for (const session of pending) {
      try {
        const described = await this.client.sendCommand("session.describe", {
          sessionId: session.sessionId,
        });
        if (
          described.type !== "session.described"
          || described.payload.sessionId !== session.sessionId
        ) continue;
        await this.syncSessionFromDescribePayload(described.payload);
      } catch {
        // Durable authority may be temporarily unavailable; keep exact queue evidence recoverable.
      }
    }
  }

  private async reconcileBackgroundSessionDescription(
    payload: SessionDescribedEventPayload,
    appendStartedHistory: boolean,
  ): Promise<void> {
    const initial = this.sessionsFile.sessions.find((item) => item.sessionId === payload.sessionId);
    if (initial?.delegation === undefined) return;
    this.assertDescribeThreadIdentity(payload);
    const state = this.uiStore.getState();
    const loadedProfiles = state.activeProfile.id === initial.profileId
      ? undefined
      : await this.profileStore.load();
    const activeRunId = payload.operatorThreadView?.activeRun?.runId;
    const terminalTurn = [...(payload.operatorThreadView?.conversationTurns ?? [])]
      .reverse()
      .find((turn) => turn.terminalRunId !== undefined);
    const evidenceRunId = activeRunId ?? terminalTurn?.terminalRunId;
    let runtimeStatus: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | undefined;
    let appendHistory = false;
    const committed = await this.commitQueueSessionMutation(payload.sessionId, (current) => {
      if (current.delegation === undefined) return undefined;
      const currentStatus = current.delegation.status;
      if (currentStatus === "COMPLETED" || currentStatus === "FAILED") return undefined;
      const pendingMessageRoute = current.pendingRunMessageId === undefined
        ? undefined
        : payload.operatorThreadView?.conversationMessageRoutes?.find(
            (route) => route.messageId === current.pendingRunMessageId,
          );
      const expectedRunId = current.pendingRunId
        ?? pendingMessageRoute?.runId
        ?? current.acceptedRunId;
      if (
        expectedRunId !== undefined
        && evidenceRunId !== undefined
        && expectedRunId !== evidenceRunId
      ) return undefined;
      if (
        evidenceRunId === undefined
        && (currentStatus === "RUNNING" || currentStatus === "WAITING")
      ) return undefined;
      const exactRunId = evidenceRunId ?? current.acceptedRunId;
      runtimeStatus = activeRunId !== undefined && activeRunId === exactRunId
        ? payload.operatorThreadView?.activeRun?.status
        : terminalTurn !== undefined
          && terminalTurn.terminalRunId === exactRunId
          && (terminalTurn.status === "COMPLETED" || terminalTurn.status === "FAILED")
          ? terminalTurn.status
          : undefined;
      const durableAcceptance = payload.threadId !== undefined
        || payload.focusedThreadId !== undefined
        || payload.activeAssembly !== undefined;
      if (durableAcceptance === false) return undefined;
      const currentState = this.uiStore.getState();
      const profile = currentState.activeProfile.id === current.profileId
        ? currentState.activeProfile
        : loadedProfiles?.find((candidate) => candidate.id === current.profileId)
          ?? currentState.activeProfile;
      const projected = this.projectSessionFromDescribePayloadForSession(payload, current, profile);
      const nextStatus = runtimeStatus
        ?? (currentStatus === "RUNNING" || currentStatus === "WAITING"
          ? currentStatus
          : "RECOVERING");
      const exactNewAcceptance = exactRunId !== undefined && exactRunId === expectedRunId;
      const acceptedThreadId = exactRunId === undefined
        ? current.acceptedRunThreadId
        : payload.operatorThreadView?.thread.threadId
          ?? payload.threadId
          ?? payload.focusedThreadId
          ?? current.acceptedRunThreadId;
      const routeMessageId = exactRunId === undefined
        ? undefined
        : payload.operatorThreadView?.conversationMessageRoutes?.find(
            (route) => route.runId === exactRunId,
          )?.messageId;
      const queuedEvidence = exactRunId === undefined || acceptedThreadId === undefined
        ? undefined
        : resolveExactTuiQueuedEvidence(current, {
            runId: exactRunId,
            threadId: acceptedThreadId,
            messageId: routeMessageId ?? current.pendingRunMessageId,
          });
      const now = payload.updatedAt ?? new Date().toISOString();
      appendHistory = appendStartedHistory && current.started !== true;
      return {
        ...projected,
        profileId: current.delegation.profileId,
        started: true,
        acceptedRunId: exactRunId,
        acceptedRunPredecessorId: queuedEvidence === undefined
          ? exactNewAcceptance
            ? projected.acceptedRunPredecessorId
            : current.acceptedRunPredecessorId
          : durableAcceptedQueuePredecessorId(queuedEvidence),
        ...(exactRunId !== undefined ? { acceptedRunThreadId: acceptedThreadId } : {}),
        ...(exactNewAcceptance
          ? {
              acceptedRunMessageId:
                routeMessageId
                ?? current.pendingRunMessageId
                ?? projected.acceptedRunMessageId,
              pendingRunId: undefined,
              pendingRunMessageId: undefined,
              pendingRunThreadId: undefined,
            }
          : {}),
        delegation: {
          ...current.delegation,
          status: nextStatus,
          errorCode: undefined,
          errorMessage: undefined,
          updatedAt: now,
        },
        lastRunStatus: nextStatus === "FAILED" || nextStatus === "COMPLETED" || nextStatus === "WAITING"
          ? nextStatus
          : undefined,
        updatedAt: now,
      };
    });
    if (committed === undefined || committed.delegation === undefined) return;
    if (appendHistory) {
      await this.appendSessionHistoryLine(
        committed,
        "system",
        `Background task started: ${committed.delegation.title}`,
        undefined,
        undefined,
        `delegation-started:${committed.delegation.taskId}`,
      );
      await this.appendHistoryLine(
        "system",
        `Launched background task '${committed.name}'.`,
        undefined,
        undefined,
        `delegation-launched:${committed.delegation.taskId}`,
      );
    }
    if (runtimeStatus === "COMPLETED" || runtimeStatus === "FAILED") {
      await this.recoverTerminalMessages(committed).catch(() => undefined);
    }
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
      const switchMode = async () => {
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
      };
      if (!shouldResumeBlockedRun) {
        await switchMode();
        return;
      }
      const requestId = state.activeSession.pendingWaitFor?.interaction?.requestId?.trim();
      if (!requestId) throw new Error("The mode-blocked interaction has no authoritative request identity.");
      await this.getRunController().switchModeAndRetry({
        recommendationId: requestId,
        mode: subcommand,
        switchMode,
        retry: () => this.startActiveTurn({
          submittedMessage: `/mode ${subcommand}`,
          resumeBlockedRun: true,
        }),
      });
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
      const switchMode = async () => {
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
      };
      if (!shouldResumeBlockedRun) {
        await switchMode();
        return;
      }
      const requestId = state.activeSession.pendingWaitFor?.interaction?.requestId?.trim();
      if (!requestId) throw new Error("The mode-blocked interaction has no authoritative request identity.");
      await this.getRunController().switchModeAndRetry({
        recommendationId: requestId,
        mode: "build",
        switchMode,
        retry: () => this.startActiveTurn({
          submittedMessage: formatModeSwitchCommand({ interactionMode: "build" }),
          resumeBlockedRun: true,
        }),
      });
      return;
    }

    await this.appendHistoryLine(
      "system",
      "Usage: /mode status | /mode chat | /mode plan | /mode build",
    );
  }

  private async startActiveTurn(input: {
    messageId?: string | undefined;
    submittedMessage: string;
    modelHistoryMessage?: string | undefined;
    resumeBlockedRun?: boolean | undefined;
    forceFreshTurn?: boolean | undefined;
    queueRequested?: boolean | undefined;
  }): Promise<boolean> {
    try {
      return await this.getRunController().startActiveTurn(input);
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
    const core = await this.prepareLocalCoreClient();
    if (core === undefined) {
      throw new Error(
        "Kestrel Local Core is required to resolve the active MCP profile.",
      );
    }
    const environmentPresetId = resolveTuiSessionEnvironment({
      session: state.activeSession,
    });
    const executionProfile = await core.resolveExecutionProfile({
      client: "cli",
      profileId: state.activeProfile.id,
      environmentPresetId,
    });
    await this.setActiveSessionState(
      toResolvedSessionIdentity(executionProfile, environmentPresetId),
    );
    const response = await this.client.sendCommand(refresh ? "mcp.refresh" : "mcp.status", {
      profileId: executionProfile.profileId,
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
    await this.saveSessionsFile();
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
    const decorated = decorateOperatorAffordance({
      base: input.runtime ?? input.session.operatorState,
      runtimeAuthoritative: input.runtime !== undefined,
      profile: input.profile,
      session: input.session,
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
          return status === "PENDING" || status === "RECOVERING" || status === "RUNNING";
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
    const initialTarget = this.sessionsFile.sessions.find(
      (session) => session.sessionId === payload.sessionId,
    );
    if (initialTarget === undefined) return;
    this.assertDescribeThreadIdentity(payload);
    const state = this.uiStore.getState();
    const loadedProfiles = state.activeProfile.id === initialTarget.profileId
      ? undefined
      : await this.profileStore.load();
    let discoveredQueuedTerminal = false;
    let terminalAccepted = false;
    let environmentError: TuiEnvironmentIdentityError | undefined;
    let patchedSession: TuiSessionMeta | undefined;
    try {
      patchedSession = await this.commitQueueSessionMutation(payload.sessionId, (current) => {
        if (
          current.acceptedRunId !== undefined
          && (current.lastRunStatus === "COMPLETED" || current.lastRunStatus === "FAILED")
          && payload.operatorThreadView !== undefined
          && exactRunStatusFromDescribedView(
            payload.operatorThreadView,
            current.acceptedRunId,
          ) === undefined
        ) return undefined;
        const currentState = this.uiStore.getState();
        const profile = currentState.activeProfile.id === current.profileId
          ? currentState.activeProfile
          : loadedProfiles?.find((candidate) => candidate.id === current.profileId)
            ?? currentState.activeProfile;
        try {
          const projected = this.projectSessionFromDescribePayloadForSession(payload, current, profile);
          discoveredQueuedTerminal = (projected.terminalQueuedRuns?.length ?? 0)
            > (current.terminalQueuedRuns?.length ?? 0);
        terminalAccepted = projected.acceptedRunId !== undefined
          && (projected.lastRunStatus === "COMPLETED" || projected.lastRunStatus === "FAILED")
          && (
            current.acceptedRunId !== projected.acceptedRunId
            || current.lastRunStatus !== projected.lastRunStatus
          );
          return projected;
        } catch (error) {
          if (error instanceof TuiEnvironmentIdentityError) environmentError = error;
          throw error;
        }
      });
    } catch (error) {
      if (environmentError !== undefined) {
        await this.appendDiagnosticsLog({
          scope: "tui.environment_identity",
          summary: environmentError.message,
          details: JSON.stringify({
            code: environmentError.code,
            sessionId: initialTarget.sessionId,
            persistedEnvironmentPresetId: initialTarget.environmentPresetId,
            runtimeEnvironmentPresetId: payload.activeAssembly?.environmentPresetId,
          }),
        });
      }
      throw error;
    }
    if (patchedSession === undefined) return;
    if (
      discoveredQueuedTerminal
      || terminalAccepted
    ) {
      await this.recoverTerminalMessages(patchedSession);
    }
  }

  private async projectSessionFromDescribePayload(
    payload: SessionDescribedEventPayload,
  ): Promise<TuiSessionMeta | undefined> {
    const initialTarget = this.sessionsFile.sessions.find((session) => session.sessionId === payload.sessionId);
    if (initialTarget === undefined) {
      return;
    }
    this.assertDescribeThreadIdentity(payload);
    const state = this.uiStore.getState();
    const loadedProfiles = state.activeProfile.id === initialTarget.profileId
      ? undefined
      : await this.profileStore.load();
    const target = this.sessionsFile.sessions.find((session) => session.sessionId === payload.sessionId);
    if (target === undefined) return;
    const profile = state.activeProfile.id === target.profileId
      ? state.activeProfile
      : loadedProfiles?.find((candidate) => candidate.id === target.profileId) ?? state.activeProfile;
    return this.projectSessionFromDescribePayloadForSession(payload, target, profile);
  }

  private assertDescribeThreadIdentity(payload: SessionDescribedEventPayload): void {
    const describedView = payload.operatorThreadView;
    if (
      describedView !== undefined
      && (
        describedView.thread.sessionId !== payload.sessionId
        || (payload.threadId !== undefined && describedView.thread.threadId !== payload.threadId)
      )
    ) {
      throw new Error("Session description thread identity did not match the described session.");
    }
  }

  private projectSessionFromDescribePayloadForSession(
    payload: SessionDescribedEventPayload,
    target: TuiSessionMeta,
    profile: TuiProfile,
  ): TuiSessionMeta {
    const describedView = payload.operatorThreadView;
    const resolvedWaitFor = payload.waitFor ?? target.pendingWaitFor;
    const runtimePayload: SessionDescribedEventPayload =
      payload.waitFor === resolvedWaitFor
        ? payload
        : {
            ...payload,
            waitFor: resolvedWaitFor,
          };
    const runtimeEnvironmentPresetId = payload.activeAssembly?.environmentPresetId;
    const environmentPresetId = resolveTuiSessionEnvironment({
      session: target,
      runtimeEnvironmentPresetId,
      requireRuntimeIdentity:
        target.started && target.environmentPresetId === undefined,
    });
    const recoveredRoute = target.pendingRunMessageId === undefined
      ? undefined
      : describedView?.conversationMessageRoutes?.find(
          (route) => route.messageId === target.pendingRunMessageId
            && (
              target.pendingRunId === undefined
              || route.runId === target.pendingRunId
            ),
        );
    const recoveredRequestRoute = target.pendingRunRequestId === undefined
      ? undefined
      : describedView?.conversationMessageRoutes?.find(
          (route) => route.requestId === target.pendingRunRequestId,
        );
    const recoveredAcceptedRoute = recoveredRoute ?? recoveredRequestRoute;
    const queuedLifecycle = reconcileExactQueuedLifecycle(target, describedView);
    const acceptedRunThreadBackfill = target.acceptedRunId !== undefined
      && target.acceptedRunThreadId === undefined
      && describedView !== undefined
      && exactRunStatusFromDescribedView(describedView, target.acceptedRunId) !== undefined
      ? describedView.thread.threadId
      : undefined;
    return {
      ...target,
      started:
        target.started
        || payload.threadId !== undefined
        || payload.focusedThreadId !== undefined
        || payload.activeAssembly !== undefined,
      environmentPresetId,
      ...(payload.activeAssembly?.bundleId !== undefined
        ? { effectiveAssemblyId: payload.activeAssembly.bundleId }
        : {}),
      ...(payload.activeAssembly?.label !== undefined
        ? { effectiveAssemblyLabel: payload.activeAssembly.label }
        : {}),
      ...(payload.updatedAt !== undefined ? { updatedAt: payload.updatedAt } : {}),
      pendingWaitFor: resolvedWaitFor,
      pendingQueueSubmissions: queuedLifecycle.pendingQueueSubmissions,
      queuedRunReservations: queuedLifecycle.queuedRunReservations,
      terminalQueuedRuns: queuedLifecycle.terminalQueuedRuns,
      ...(recoveredAcceptedRoute?.runId !== undefined
        ? {
            pendingRunId: undefined,
            pendingRunRequestId: undefined,
            pendingRunMessageId: undefined,
            pendingRunThreadId: undefined,
            ...(recoveredRoute !== undefined
              ? { acceptedRunMessageId: recoveredRoute.messageId }
              : {}),
            acceptedRunId: recoveredAcceptedRoute.runId,
            acceptedRunPredecessorId: undefined,
            ...(describedView !== undefined
              ? { acceptedRunThreadId: describedView.thread.threadId }
              : {}),
          }
        : {}),
      ...(acceptedRunThreadBackfill !== undefined
        ? { acceptedRunThreadId: acceptedRunThreadBackfill }
        : {}),
      ...(queuedLifecycle.accepted === undefined
        ? {}
        : {
            acceptedRunId: queuedLifecycle.accepted.runId,
            acceptedRunMessageId: queuedLifecycle.accepted.messageId,
            acceptedRunThreadId: queuedLifecycle.accepted.threadId,
            acceptedRunPredecessorId: durableAcceptedQueuePredecessorId(
              queuedLifecycle.accepted,
            ),
            lastRunStatus: queuedLifecycle.accepted.status === "RUNNING"
              ? undefined
              : queuedLifecycle.accepted.status,
            pendingWaitFor: queuedLifecycle.accepted.status === "WAITING"
              ? describedView?.thread.waitFor
              : undefined,
            ...(target.delegation !== undefined
              ? {
                  delegation: {
                    ...target.delegation,
                    status: queuedLifecycle.accepted.status,
                    errorCode: undefined,
                    errorMessage: undefined,
                    updatedAt: payload.updatedAt ?? target.updatedAt,
                  },
                }
              : {}),
          }),
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
  }

  private persistProjectedSession(patchedSession: TuiSessionMeta): void {
    const state = this.uiStore.getState();
    const activeSessionName = this.sessionsFile.activeSessionName;
    this.sessionsFile = this.sessionStore.upsert(this.sessionsFile, patchedSession);
    if (state.activeSession.sessionId !== patchedSession.sessionId) {
      this.sessionsFile = { ...this.sessionsFile, activeSessionName };
    }
    this.uiStore.patch({
      sessions: this.sessionsFile.sessions,
      ...(state.activeSession.sessionId === patchedSession.sessionId
        ? { activeSession: patchedSession }
        : {}),
    });
  }

  private async commitProjectedSession(
    patchedSession: TuiSessionMeta,
    expectedSession: TuiSessionMeta,
  ): Promise<boolean> {
    return await this.commitQueueSessionMutation(
      patchedSession.sessionId,
      (current) => current === expectedSession ? patchedSession : undefined,
    ) !== undefined;
  }

  private async commitQueueSessionState(
    sessionId: string,
    patch: Partial<TuiSessionMeta>,
  ): Promise<TuiSessionMeta | undefined> {
    return await this.commitQueueSessionMutation(sessionId, (current) => ({
      ...current,
      ...patch,
    }));
  }

  private async commitQueueSessionMutation(
    sessionId: string,
    mutation: (
      current: TuiSessionMeta,
    ) => TuiSessionMeta | undefined | Promise<TuiSessionMeta | undefined>,
  ): Promise<TuiSessionMeta | undefined> {
    const previous = this.queueSessionCommitTailBySession.get(sessionId) ?? Promise.resolve();
    let committed: TuiSessionMeta | undefined;
    const operation = previous.catch(() => undefined).then(async () => {
      await this.coordinateSessionsFileCommit(async () => {
        const sourceFile = this.sessionsFile;
        const sourceSession = sourceFile.sessions.find((session) => session.sessionId === sessionId);
        if (sourceSession === undefined) return;
        const projectedSession = await mutation(sourceSession);
        if (projectedSession === undefined) return;
        const activeSessionName = sourceFile.activeSessionName;
        let privateSnapshot = this.sessionStore.upsert(sourceFile, projectedSession);
        if (sourceSession.name !== activeSessionName) {
          privateSnapshot = { ...privateSnapshot, activeSessionName };
        }
        try {
          await this.sessionStore.save(privateSnapshot);
        } catch (error) {
          this.recordPersistenceFailure("sessions.queue_commit", error);
          return;
        }
        const currentFile = this.sessionsFile;
        const currentSession = currentFile.sessions.find((session) => session.sessionId === sessionId);
        if (currentSession !== sourceSession) return;
        const currentActiveSessionName = currentFile.activeSessionName;
        let publishedFile = this.sessionStore.upsert(currentFile, projectedSession);
        if (sourceSession.name !== currentActiveSessionName) {
          publishedFile = { ...publishedFile, activeSessionName: currentActiveSessionName };
        }
        this.sessionsFile = publishedFile;
        const state = this.uiStore.getState();
        this.uiStore.patch({
          sessions: publishedFile.sessions,
          ...(state.activeSession.sessionId === sessionId
            ? { activeSession: projectedSession }
            : {}),
        });
        committed = projectedSession;
      });
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.queueSessionCommitTailBySession.set(sessionId, tail);
    try {
      await operation;
      return committed;
    } finally {
      if (this.queueSessionCommitTailBySession.get(sessionId) === tail) {
        this.queueSessionCommitTailBySession.delete(sessionId);
      }
    }
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
      await this.applyTerminalResult(output.sessionId, payload.result);
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

  private async applyTerminalResult(
    sessionId: string,
    result: { assistantText: string | null; output: import("../../src/index.js").NormalizedOutput },
    finalizedPayload?: unknown | undefined,
  ): Promise<void> {
    await this.applyTerminalResultOnce(sessionId, result, finalizedPayload);
  }

  private async applyTerminalResultOnce(
    sessionId: string,
    result: { assistantText: string | null; output: import("../../src/index.js").NormalizedOutput },
    finalizedPayload?: unknown | undefined,
  ): Promise<void> {
    const session = this.sessionsFile.sessions.find((entry) => entry.sessionId === sessionId);
    if (session === undefined) return;
    const state = this.uiStore.getState();
    let history = state.activeSession.sessionId === sessionId
      ? state.transcript
      : await this.historyStore.readTranscript(sessionId, 100_000);
    const terminalEventId = `terminal:${result.output.runId}`;
    if (!history.some((line) => line.eventId === terminalEventId)) {
      history = await this.historyStore.readTranscript(sessionId, 100_000);
    }
    if (history.some((line) => line.eventId === terminalEventId)) {
      await this.appendDiagnosticsLog({
        scope: "terminal_message.duplicate_suppressed",
        summary: "Suppressed a duplicate terminal message.",
        details: stringifyDiagnosticDetails({ sessionId, runId: result.output.runId, count: 1 }),
      });
      return;
    }
    if (result.output.status === "WAITING") {
      const waitPrompt = extractWaitPrompt(result.output.waitFor);
      await this.appendSessionHistoryLine(session, "system", buildWaitingSystemText(result.output.waitFor), {
        kind: "runtime.waiting_prompt",
        runId: result.output.runId,
        waitEventType: result.output.waitFor?.eventType ?? "unknown",
        ...(waitPrompt === undefined ? {} : { prompt: waitPrompt }),
      }, result.output, terminalEventId);
    } else if (
      result.output.status === "FAILED"
      && result.output.errors.some((error) => error.code === "RUN_CANCELLED")
    ) {
      await this.appendSessionHistoryLine(
        session,
        "system",
        "Run cancelled.",
        {
          kind: "runtime.terminal.v1",
          runId: result.output.runId,
          terminalStatus: "cancelled",
        },
        result.output,
        terminalEventId,
      );
    } else if (result.output.status === "FAILED") {
      await this.appendSessionHistoryLine(
        session,
        "system",
        `Run failed: ${result.output.errors[0]?.message ?? "Run failed."}`,
        undefined,
        result.output,
        terminalEventId,
      );
    } else if (result.assistantText !== null && result.assistantText.trim().length > 0) {
      const parsed = parseFinalizePayload(finalizedPayload);
      const structuredData = parsed.ok ? parsed.payload?.data : undefined;
      await this.appendSessionHistoryLine(session, "assistant", result.assistantText, structuredData, result.output, terminalEventId);
      const notice = structuredData === undefined ? undefined : buildFinalizeReportingGroundingNotice(structuredData);
      if (notice !== undefined) {
        await this.appendSessionHistoryLine(session, "system", notice, undefined, result.output, `${terminalEventId}:grounding`);
      }
    } else {
      await this.appendSessionHistoryLine(
        session,
        "system",
        "The run completed, but its final response could not be delivered. Refocus this session to retry recovery.",
        undefined,
        result.output,
        terminalEventId,
      );
    }
    await this.appendDiagnosticsLog({
      scope: "terminal_message.projected",
      summary: "Projected a terminal message.",
      details: stringifyDiagnosticDetails({ sessionId, runId: result.output.runId, count: 1 }),
    });
  }

  private async recoverTerminalMessages(session: TuiSessionMeta): Promise<void> {
    let cursor = session.terminalMessageCursor;
    const fetch = async (afterCursor: string | undefined, limit: number) => {
      const response = await this.client.sendCommand("conversation.messages.list", {
        threadId: terminalMessageRecoveryThreadId(session.sessionId),
        ...(afterCursor !== undefined ? { afterCursor } : {}),
        limit,
        includeTerminalOutcomes: true,
      });
      if (response.type !== "conversation.messages") {
        throw new Error(`Unexpected conversation recovery response '${response.type}'.`);
      }
      return response.payload;
    };
    const applyPage = async (
      page: Awaited<ReturnType<typeof fetch>>,
      resetCursor = false,
    ) => {
      if (page.terminalOutcomes !== undefined) {
        for (const outcome of page.terminalOutcomes) {
          if (outcome.outcomeStatus === "completed" && outcome.result !== undefined) {
            await this.applyTerminalResult(outcome.sessionId, outcome.result, outcome.result.finalizedPayload);
            continue;
          }
          const line = projectTuiTerminalOutcome(outcome);
          const target = this.sessionsFile.sessions.find((entry) => entry.sessionId === outcome.sessionId);
          if (target !== undefined) {
            const currentHistory = this.uiStore.getState().activeSession.sessionId === outcome.sessionId
              ? this.uiStore.getState().transcript
              : await this.historyStore.readTranscript(outcome.sessionId, 100_000);
            if (currentHistory.some((entry) => entry.eventId === line.eventId)) continue;
            await this.appendSessionHistoryLine(
              target,
              line.role,
              line.text,
              line.data,
              outcome.result?.output,
              line.eventId,
            );
          }
        }
      } else {
        for (const message of page.messages) {
          await this.applyTerminalResult(message.sessionId, message.result);
        }
      }
      await this.appendDiagnosticsLog({
        scope: "terminal_message.recovered",
        summary: "Recovered terminal messages for a session.",
        details: stringifyDiagnosticDetails({
          sessionId: session.sessionId,
          count: page.terminalOutcomes?.length ?? page.messages.length,
        }),
      });
      if (page.nextCursor !== undefined || resetCursor) {
        await this.commitQueueSessionMutation(session.sessionId, (current) => ({
          ...current,
          terminalMessageCursor: page.nextCursor,
        }));
      }
    };
    try {
      while (true) {
        const page = await fetch(cursor, 100);
        await applyPage(page);
        if (!page.hasMore || page.nextCursor === undefined) return;
        cursor = page.nextCursor;
      }
    } catch (error) {
      if (cursor !== undefined) {
        try {
          await applyPage(await fetch(undefined, 500), true);
          await this.appendDiagnosticsLog({
            scope: "terminal_message.recovery_failed",
            summary: "Reset an invalid terminal message recovery cursor.",
            details: stringifyDiagnosticDetails({ sessionId: session.sessionId, count: 1 }),
          });
          return;
        } catch {
          // Preserve the original failure for diagnostics.
        }
      }
      await this.appendDiagnosticsLog({
        scope: "terminal_message.recovery_failed",
        summary: "Terminal message recovery failed and will be retried.",
        details: stringifyDiagnosticDetails({ sessionId: session.sessionId, count: 1 }),
      });
      throw error;
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

  private async updateTaskSessionFromMeta(
    task: DelegationTaskMeta,
    patch: Partial<TuiSessionMeta> = {},
  ): Promise<void> {
    const childSessionId = task.childSessionId ?? `child-${task.taskId}`;
    const childSessionName = task.childSessionName ?? task.title;
    const existing = this.sessionsFile.sessions.find((session) => session.sessionId === childSessionId);
    if (existing !== undefined) {
      const nextSession = await this.commitQueueSessionMutation(childSessionId, (current) => {
        const currentTask = current.delegation;
        if (
          currentTask !== undefined
          && (
            currentTask.taskId !== task.taskId
            || (
              currentTask.parentRunId !== undefined
              && task.parentRunId !== undefined
              && currentTask.parentRunId !== task.parentRunId
            )
            ||
            task.updatedAt < currentTask.updatedAt
            || (
              task.updatedAt === currentTask.updatedAt
              && (
                currentTask.status === "WAITING"
                || currentTask.status === "COMPLETED"
                || currentTask.status === "FAILED"
              )
              && (task.status === "RUNNING" || task.status === "RECOVERING")
            )
            || (
              (current.lastRunStatus === "COMPLETED" || current.lastRunStatus === "FAILED")
              && (task.status === "RUNNING" || task.status === "RECOVERING")
            )
          )
        ) return undefined;
        return {
          ...current,
          profileId: task.profileId,
          started: true,
          ...patch,
          delegation: task,
          updatedAt: task.updatedAt,
          lastRunStatus:
            task.status === "FAILED"
              ? "FAILED"
              : task.status === "COMPLETED"
                ? "COMPLETED"
                : task.status === "WAITING"
                  ? "WAITING"
                  : task.status === "RUNNING" || task.status === "RECOVERING"
                    ? undefined
                    : current.lastRunStatus,
        };
      });
      if (nextSession === undefined) return;
      const state = this.uiStore.getState();
      if (state.activeSession.sessionId === task.parentSessionId) {
        this.uiStore.patch({
          activeSession: {
            ...state.activeSession,
            operatorState: this.buildSessionOperatorState({
              session: state.activeSession,
              profile: state.activeProfile,
            }),
          },
        });
      }
      return;
    }
    const nextSession: TuiSessionMeta =
      {
            name: childSessionName,
            sessionId: childSessionId,
            profileId: task.profileId,
            createdAt: task.createdAt,
            started: true,
            updatedAt: task.updatedAt,
            interactionMode: "plan",
            autoCompactionEnabled: true,
            ...patch,
            delegation: task,
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
      ...(profile.agentProfileId !== undefined ? { agentProfileId: profile.agentProfileId } : {}),
      ...(profile.agentProfileLabel !== undefined ? { agentProfileLabel: profile.agentProfileLabel } : {}),
      environmentPresetId: defaultTuiEnvironmentPresetId({
        workspaceBinding: launch.workspace.binding,
        workspaceId: workspace?.manifest.workspaceId,
        workspaceRoot: workspace?.rootPath,
      }),
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
    eventId?: string | undefined,
  ): Promise<void> {
    await this.enqueueTranscriptAppend(async () => {
      const state = this.uiStore.getState();
      if (eventId !== undefined && state.transcript.some((line) => line.eventId === eventId)) {
        return;
      }
      const segments = splitTranscriptMessage(role, text);
      const timestamp = new Date().toISOString();
      const rootEventId = eventId ?? randomUUID();
      const lines: TranscriptLine[] = segments.map((segment, index) => ({
        eventId: index === 0 ? rootEventId : `${rootEventId}:segment:${index}`,
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
      const activeSession = await this.commitQueueSessionMutation(
        state.activeSession.sessionId,
        (current) => this.mergeSessionHistoryMetadata(current, {
          preview,
          updatedAt,
          hasArtifacts: dataHasArtifacts(data),
          hasSummary: role === "assistant" && preview.length > 0,
          launchSummary:
            role === "system" && text.startsWith("Task=") ? text : undefined,
        }),
      );
      if (activeSession === undefined) return;

      if (this.uiStore.getState().activeSession.sessionId === activeSession.sessionId) {
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
      }

      try {
        for (const line of lines) {
          await this.historyStore.append({
            source: "runner",
            eventId: line.eventId ?? randomUUID(),
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
    eventId?: string | undefined,
  ): Promise<void> {
    const state = this.uiStore.getState();
    if (state.activeSession.sessionId === session.sessionId) {
      await this.appendHistoryLine(role, text, data, output, eventId);
      return;
    }

    await this.enqueueTranscriptAppend(async () => {
      try {
        if (eventId !== undefined) {
          const transcript = await this.historyStore.readTranscript(session.sessionId, 100_000);
          if (transcript.some((line) => line.eventId === eventId)) return;
        }
        await this.historyStore.append({
          source: "runner",
          eventId: eventId ?? randomUUID(),
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
        await this.commitQueueSessionMutation(session.sessionId, (current) =>
          this.mergeSessionHistoryMetadata(current, {
            preview: preview.length > 0 ? preview : undefined,
            updatedAt: new Date().toISOString(),
            hasArtifacts: dataHasArtifacts(data),
            hasSummary: role === "assistant" && preview.length > 0,
            launchSummary:
              role === "system" && text.startsWith("Task=") ? text : undefined,
          })
        );
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

  private async syncForegroundSessionProgress(input: {
    sessionId: string;
    threadId: string;
    runId: string;
    messageId: string;
  }): Promise<boolean> {
    const committed = await this.commitQueueSessionMutation(input.sessionId, (current) =>
      projectForegroundSessionProgress(current, input)
    );
    if (committed === undefined) return false;
    if (this.uiStore.getState().activeSession.sessionId === input.sessionId) {
      this.uiStore.patch({
        running: true,
        statusLine: this.withMcpSummary("running"),
        errorOverlay: undefined,
        errorScrollOffset: 0,
      });
    }
    return true;
  }

  private async syncForegroundQueuedTerminal(input: {
    sessionId: string;
    threadId: string;
    runId: string;
    messageId?: string | undefined;
    result: Extract<RunnerEvent, { type: "run.completed" }>["payload"]["result"];
    authoritativeView?: SessionDescribedEventPayload["operatorThreadView"] | undefined;
  }): Promise<boolean> {
    if (
      input.result.output.sessionId !== input.sessionId
      || input.result.output.runId !== input.runId
    ) return false;
    const initialPersistedSession = this.sessionsFile.sessions.find((item) => item.sessionId === input.sessionId);
    const initialSession = initialPersistedSession === undefined
      ? undefined
      : { ...initialPersistedSession, ...normalizeTuiQueueGraph(initialPersistedSession) };
    if (initialSession === undefined) return false;
    const initialActiveProfile = this.uiStore.getState().activeProfile;
    const loadedProfiles = input.result.operatorAffordance !== undefined
      && initialSession.profileId !== initialActiveProfile.id
      ? await this.profileStore.load()
      : undefined;
    const terminalStatus = input.result.output.status === "COMPLETED"
      ? "COMPLETED" as const
      : input.result.output.status === "FAILED"
        ? "FAILED" as const
        : undefined;
    const committed = await this.commitQueueSessionMutation(input.sessionId, (current) => {
      const session = { ...current, ...normalizeTuiQueueGraph(current) };
      const queuedEvidence = resolveExactTuiQueuedEvidence(session, {
        runId: input.runId,
        threadId: input.threadId,
        messageId: input.messageId,
      });
      if (queuedEvidence === undefined) return undefined;
      const hasExactTerminalAuthority = terminalStatus === undefined
        || (
          input.authoritativeView !== undefined
          && input.authoritativeView.thread.sessionId === input.sessionId
          && input.authoritativeView.thread.threadId === input.threadId
          && hasExactQueuedTerminalTurn(input.authoritativeView, {
            ...queuedEvidence,
            status: terminalStatus,
          })
        );
      if (terminalStatus !== undefined && hasExactTerminalAuthority === false) return undefined;
      const pendingQueueSubmission = session.pendingQueueSubmissions?.find((submission) =>
        submission.runId === queuedEvidence.runId
        && submission.messageId === queuedEvidence.messageId
        && submission.threadId === queuedEvidence.threadId
      );
      let currentQueueGraph = normalizeTuiQueueGraph(session);
      let orderedEvidence = queuedEvidence;
      if (
        queuedEvidenceCanReplaceAcceptedRun(session, queuedEvidence) === false
        && terminalStatus !== undefined
      ) {
        const reconciled = reconcileExactQueuedLifecycle(session, input.authoritativeView!);
        currentQueueGraph = {
          pendingQueueSubmissions: reconciled.pendingQueueSubmissions,
          queuedRunReservations: reconciled.queuedRunReservations,
          terminalQueuedRuns: reconciled.terminalQueuedRuns,
        };
        const reconciledEvidence = [
          ...(currentQueueGraph.pendingQueueSubmissions ?? []),
          ...(currentQueueGraph.queuedRunReservations ?? []),
          ...(currentQueueGraph.terminalQueuedRuns ?? []),
        ].find((candidate) =>
          candidate.runId === queuedEvidence.runId
          && candidate.messageId === queuedEvidence.messageId
          && candidate.threadId === queuedEvidence.threadId
        );
        if (reconciledEvidence !== undefined) orderedEvidence = reconciledEvidence;
      }
      const installAsCurrent = queuedEvidenceCanReplaceAcceptedRun(
        { ...session, ...currentQueueGraph },
        orderedEvidence,
      );
      let settledQueueGraph = installAsCurrent
        ? advanceTuiQueueAuthority(currentQueueGraph, orderedEvidence)
        : {
            ...currentQueueGraph,
            queuedRunReservations: omitQueuedRunReservation(
              currentQueueGraph.queuedRunReservations,
              orderedEvidence,
            ),
            pendingQueueSubmissions: pendingQueueSubmission === undefined
              ? currentQueueGraph.pendingQueueSubmissions
              : omitExactRunIdentity(currentQueueGraph.pendingQueueSubmissions, pendingQueueSubmission),
          };
      if (installAsCurrent && terminalStatus !== undefined) {
        settledQueueGraph = {
          ...settledQueueGraph,
          queuedRunReservations: omitQueuedRunReservation(
            settledQueueGraph.queuedRunReservations,
            orderedEvidence,
          ),
          pendingQueueSubmissions: omitExactRunIdentity(
            settledQueueGraph.pendingQueueSubmissions,
            orderedEvidence,
          ),
        };
      }
      const currentActiveProfile = this.uiStore.getState().activeProfile;
      const owningProfile = input.result.operatorAffordance === undefined
        ? undefined
        : session.profileId === currentActiveProfile.id
          ? currentActiveProfile
          : this.profileStore.findById(loadedProfiles ?? [], session.profileId);
      const now = new Date().toISOString();
      return {
        ...session,
        started: true,
        ...(installAsCurrent
          ? {
              acceptedRunId: orderedEvidence.runId,
              acceptedRunMessageId: orderedEvidence.messageId,
              acceptedRunThreadId: orderedEvidence.threadId,
              acceptedRunPredecessorId: durableAcceptedQueuePredecessorId(orderedEvidence),
            }
          : {}),
        queuedRunReservations: settledQueueGraph.queuedRunReservations,
        pendingQueueSubmissions: settledQueueGraph.pendingQueueSubmissions,
        terminalQueuedRuns: terminalStatus === undefined
          ? settledQueueGraph.terminalQueuedRuns
          : appendTerminalQueuedRun(settledQueueGraph.terminalQueuedRuns, {
              ...orderedEvidence,
              status: terminalStatus,
            }),
        ...(installAsCurrent
          ? {
              pendingWaitFor: input.result.output.status === "WAITING"
                ? input.result.output.waitFor
                : undefined,
              lastRunStatus: input.result.output.status,
            }
          : {}),
        ...(input.result.operatorAffordance !== undefined && owningProfile !== undefined
          ? {
              operatorState: this.buildSessionOperatorState({
                session,
                profile: owningProfile,
                runtime: input.result.operatorAffordance,
              }),
            }
          : {}),
        ...(session.delegation === undefined
          ? {}
          : {
              delegation: {
                ...session.delegation,
                status: input.result.output.status === "COMPLETED"
                  ? "COMPLETED" as const
                  : input.result.output.status === "WAITING"
                    ? "WAITING" as const
                    : "FAILED" as const,
                errorCode: undefined,
                errorMessage: input.result.output.status === "FAILED"
                  ? input.result.output.errors[0]?.message
                  : undefined,
                updatedAt: now,
              },
            }),
        updatedAt: now,
      };
    });
    if (committed === undefined) return false;
    return true;
  }

  private async syncBackgroundSessionProgress(input: {
    sessionId: string;
    threadId: string;
    runId: string;
    messageId?: string | undefined;
    requestId?: string | undefined;
    status?: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | undefined;
    waitFor?: TuiSessionMeta["pendingWaitFor"] | undefined;
  }): Promise<void> {
    const nextStatus = input.status ?? "RUNNING";
    let appendStartedHistory = false;
    const committed = await this.commitQueueSessionMutation(input.sessionId, (current) => {
      if (current.delegation === undefined) return undefined;
      if (current.delegation.status === "COMPLETED" || current.delegation.status === "FAILED") return undefined;
      const queuedEvidence = input.messageId === undefined
        ? undefined
        : resolveExactTuiQueuedEvidence(current, {
            runId: input.runId,
            threadId: input.threadId,
            messageId: input.messageId,
          });
      const exactPendingAcceptance = current.pendingRunThreadId === input.threadId
        && current.pendingRunId === input.runId
        && (
          current.pendingRunMessageId === undefined
            ? input.messageId === undefined
            : current.pendingRunMessageId === input.messageId
        );
      const exactPendingReplyAcceptance = input.requestId !== undefined
        && current.pendingRunThreadId === input.threadId
        && current.pendingRunRequestId === input.requestId
        && current.acceptedRunId !== input.runId;
      const exactAccepted = current.acceptedRunId === input.runId
        && current.acceptedRunThreadId === input.threadId
        && (
          input.messageId === undefined
          || current.acceptedRunMessageId === input.messageId
        );
      if (
        exactAccepted === false
        && exactPendingAcceptance === false
        && exactPendingReplyAcceptance === false
        && queuedEvidence === undefined
      ) return undefined;
      if (
        exactAccepted
        && nextStatus === "RUNNING"
        && (current.delegation.status === "RUNNING" || current.delegation.status === "WAITING")
      ) return undefined;
      const acceptedMessageId = input.messageId
        ?? queuedEvidence?.messageId
        ?? current.acceptedRunMessageId
        ?? current.pendingRunMessageId;
      const now = new Date().toISOString();
      appendStartedHistory = current.started !== true;
      return {
        ...current,
        started: true,
        focusedThreadId: input.threadId,
        acceptedRunId: input.runId,
        acceptedRunMessageId: acceptedMessageId,
        acceptedRunThreadId: input.threadId,
        acceptedRunPredecessorId: queuedEvidence === undefined
          ? exactAccepted
            ? current.acceptedRunPredecessorId
            : undefined
          : durableAcceptedQueuePredecessorId(queuedEvidence),
        pendingRunId: undefined,
        pendingRunRequestId: undefined,
        pendingRunMessageId: undefined,
        pendingRunThreadId: undefined,
        queuedRunReservations: queuedEvidence === undefined
          ? current.queuedRunReservations
          : omitQueuedRunReservation(current.queuedRunReservations, queuedEvidence),
        pendingQueueSubmissions: queuedEvidence === undefined
          ? current.pendingQueueSubmissions
          : omitExactRunIdentity(current.pendingQueueSubmissions, queuedEvidence),
        pendingWaitFor: nextStatus === "WAITING" ? input.waitFor : undefined,
        lastRunStatus: nextStatus === "COMPLETED" || nextStatus === "FAILED"
          ? nextStatus
          : nextStatus === "WAITING"
            ? "WAITING"
            : undefined,
        delegation: {
          ...current.delegation,
          status: nextStatus,
          errorCode: undefined,
          errorMessage: undefined,
          updatedAt: now,
        },
        updatedAt: now,
      };
    });
    if (committed !== undefined && appendStartedHistory && committed.delegation !== undefined) {
      await this.appendSessionHistoryLine(
        committed,
        "system",
        `Background task started: ${committed.delegation.title}`,
        undefined,
        undefined,
        `delegation-started:${committed.delegation.taskId}`,
      );
      await this.appendHistoryLine(
        "system",
        `Launched background task '${committed.name}'.`,
        undefined,
        undefined,
        `delegation-launched:${committed.delegation.taskId}`,
      );
    }
    if (committed !== undefined && (nextStatus === "COMPLETED" || nextStatus === "FAILED")) {
      await this.recoverTerminalMessages(committed).catch(() => undefined);
    }
  }

  private async updateAcceptedBackgroundSession(
    task: DelegationTaskMeta,
    appendStartedHistory?: boolean,
    patch: Partial<TuiSessionMeta> = {},
  ): Promise<boolean> {
    const existing = this.sessionsFile.sessions.find(
      (item) => item.sessionId === task.childSessionId,
    );
    if (existing === undefined) return false;
    const shouldAppendStartedHistory = appendStartedHistory ?? existing?.started !== true;
    const accepted = await this.commitQueueSessionMutation(task.childSessionId, (current) => {
      const exactRunId = patch.acceptedRunId;
      const queuedIdentity = exactRunId === undefined
        ? undefined
        : [
            ...(current.pendingQueueSubmissions ?? []),
            ...(current.queuedRunReservations ?? []),
            ...(current.terminalQueuedRuns ?? []),
          ].find((candidate) => candidate.runId === exactRunId);
      const exactQueuedEvidence = queuedIdentity === undefined
        ? undefined
        : resolveExactTuiQueuedEvidence(current, {
            runId: queuedIdentity.runId,
            messageId: queuedIdentity.messageId,
            threadId: queuedIdentity.threadId,
          });
      const currentPatch = exactQueuedEvidence === undefined
        ? patch
        : {
            ...patch,
            acceptedRunId: exactQueuedEvidence.runId,
            acceptedRunMessageId: exactQueuedEvidence.messageId,
            acceptedRunThreadId: exactQueuedEvidence.threadId,
            acceptedRunPredecessorId: durableAcceptedQueuePredecessorId(exactQueuedEvidence),
            pendingQueueSubmissions: omitExactRunIdentity(
              current.pendingQueueSubmissions,
              exactQueuedEvidence,
            ),
            queuedRunReservations: omitQueuedRunReservation(
              current.queuedRunReservations,
              exactQueuedEvidence,
            ),
          };
      return {
        ...current,
        profileId: task.profileId,
        started: true,
        ...currentPatch,
        updatedAt: task.updatedAt,
        delegation: task,
        lastRunStatus:
          task.status === "FAILED"
            ? "FAILED"
            : task.status === "COMPLETED"
              ? "COMPLETED"
              : task.status === "WAITING"
                ? "WAITING"
                : task.status === "RUNNING" || task.status === "RECOVERING"
                  ? undefined
                  : current.lastRunStatus,
      };
    });
    if (accepted === undefined) return false;
    if (shouldAppendStartedHistory === false) return true;
    await this.appendSessionHistoryLine(
      accepted,
      "system",
      `Background task started: ${task.title}`,
      undefined,
      undefined,
      `delegation-started:${task.taskId}`,
    );
    await this.appendHistoryLine(
      "system",
      `Launched background task '${accepted.name}'.`,
      undefined,
      undefined,
      `delegation-launched:${task.taskId}`,
    );
    return true;
  }

  private async syncBackgroundSessionResult(
    expectedSessionId: string,
    expectedRunId: string,
    allowUnstartedAcceptance: boolean,
    output: import("../../src/index.js").NormalizedOutput,
    assistantText: string | null,
    finalizedPayload: unknown | undefined,
    operatorState?: TuiSessionMeta["operatorState"] | undefined,
  ): Promise<void> {
    if (output.sessionId !== expectedSessionId || output.runId !== expectedRunId) return;
    const session = this.sessionsFile.sessions.find((item) => item.sessionId === expectedSessionId);
    if (session?.delegation === undefined) {
      return;
    }
    const queuedReservation = session.queuedRunReservations?.find(
      (reservation) => reservation.runId === expectedRunId,
    );
    if (
      session.acceptedRunId === undefined
      && allowUnstartedAcceptance === false
      && queuedReservation === undefined
    ) return;
    if (
      session.acceptedRunId !== undefined
      && session.acceptedRunId !== expectedRunId
      && queuedReservation === undefined
    ) return;
    if (session.delegation.status === "COMPLETED" || session.delegation.status === "FAILED") return;
    const nextStatus = output.status === "WAITING"
      ? "WAITING"
      : output.status === "FAILED"
        ? "FAILED"
        : "COMPLETED";
    const nextSession = {
      acceptedRunId: expectedRunId,
      acceptedRunMessageId:
        queuedReservation?.messageId ?? session.pendingRunMessageId ?? session.acceptedRunMessageId,
      acceptedRunThreadId:
        queuedReservation?.threadId ?? session.pendingRunThreadId ?? session.acceptedRunThreadId,
      acceptedRunPredecessorId: queuedReservation === undefined
        ? session.acceptedRunId === expectedRunId
          ? session.acceptedRunPredecessorId
          : undefined
        : durableAcceptedQueuePredecessorId(queuedReservation),
      pendingRunId: undefined,
      pendingRunMessageId: undefined,
      pendingRunThreadId: undefined,
      queuedRunReservations: queuedReservation === undefined
        ? session.queuedRunReservations
        : omitQueuedRunReservation(session.queuedRunReservations, queuedReservation),
      pendingWaitFor: output.status === "WAITING" ? output.waitFor : undefined,
      lastRunStatus: output.status,
      ...(operatorState !== undefined
        ? {
            operatorState: this.buildSessionOperatorState({
              session: {
                ...session,
                pendingWaitFor: output.status === "WAITING" ? output.waitFor : undefined,
                lastRunStatus: output.status,
              },
              profile: this.uiStore.getState().activeProfile,
              runtime: operatorState,
            }),
          }
        : {}),
    } satisfies Partial<TuiSessionMeta>;
    await this.updateAcceptedBackgroundSession({
      ...session.delegation,
      status: nextStatus,
      errorCode: undefined,
      errorMessage: undefined,
      waitEventType: output.waitFor?.eventType,
      resultSummary:
        output.status === "WAITING"
          ? session.delegation.resultSummary
          : assistantText ?? session.delegation.resultSummary,
      updatedAt: new Date().toISOString(),
    }, undefined, nextSession);
  }

  private async syncBackgroundSessionFailure(
    expectedSessionId: string,
    expectedRunId: string,
    outputSessionId: string,
    message: string,
  ): Promise<void> {
    if (outputSessionId !== expectedSessionId) return;
    const session = this.sessionsFile.sessions.find((item) => item.sessionId === expectedSessionId);
    if (session?.delegation === undefined) {
      return;
    }
    const queuedReservation = session.queuedRunReservations?.find(
      (reservation) => reservation.runId === expectedRunId,
    );
    if (session.acceptedRunId === undefined && queuedReservation === undefined) {
      await this.failBackgroundLaunchSetup(session, session.delegation, message);
      return;
    }
    if (session.acceptedRunId !== expectedRunId && queuedReservation === undefined) return;
    if (session.delegation.status === "COMPLETED" || session.delegation.status === "FAILED") return;
    await this.updateAcceptedBackgroundSession({
      ...session.delegation,
      status: "FAILED",
      errorMessage: message,
      updatedAt: new Date().toISOString(),
    }, undefined, {
      acceptedRunId: expectedRunId,
      acceptedRunMessageId: queuedReservation?.messageId ?? session.acceptedRunMessageId,
      acceptedRunThreadId: queuedReservation?.threadId ?? session.acceptedRunThreadId,
      acceptedRunPredecessorId: queuedReservation === undefined
        ? session.acceptedRunId === expectedRunId
          ? session.acceptedRunPredecessorId
          : undefined
        : durableAcceptedQueuePredecessorId(queuedReservation),
      queuedRunReservations: queuedReservation === undefined
        ? session.queuedRunReservations
        : omitQueuedRunReservation(session.queuedRunReservations, queuedReservation),
    });
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
      await this.saveSessionsFile({ requireSessionSave: true });
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
      session: startupWorkspaceConflict ? undefined : activeSession,
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
        await this.saveSessionsFile({ requireSessionSave: true });
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
      await this.saveSessionsFile({ requireSessionSave: true });
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
    await this.saveSessionsFile({ requireSessionSave: true });
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
    return resolveSharedProfileForStartup({
      options: this.options,
      profiles: input.profiles,
      runtimeSettings: this.runtimeSettings,
      profileStore: this.profileStore,
      ...(input.session !== undefined ? { session: input.session } : {}),
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
      startupNotices: this.startupNotices,
    });
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

  private async setSessionState(
    sessionId: string,
    patch: Partial<TuiSessionMeta>,
  ): Promise<TuiSessionMeta | undefined> {
    const state = this.uiStore.getState();
    const current = this.sessionsFile.sessions.find((session) => session.sessionId === sessionId);
    if (current === undefined) return undefined;
    if (state.activeSession.sessionId === sessionId) {
      await this.setActiveSessionState(patch);
      return this.uiStore.getState().activeSession;
    }
    const activeSessionName = this.sessionsFile.activeSessionName;
    const nextSession = { ...current, ...patch };
    this.sessionsFile = {
      ...this.sessionStore.upsert(this.sessionsFile, nextSession),
      activeSessionName,
    };
    this.uiStore.patch({ sessions: this.sessionsFile.sessions });
    return nextSession;
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
    state: Pick<UiRuntimeState, "transcript" | "viewport" | "detailDrawer" | "activeRegion" | "chatDraft" | "conversationActivity">,
  ): number {
    return countChatVisualRows(
      state.transcript,
      this.getChatLayout(state).wrappedBodyWidth,
    );
  }

  private getChatLayout(
    state: Pick<UiRuntimeState, "viewport" | "detailDrawer" | "activeRegion" | "chatDraft" | "conversationActivity">,
  ): ChatLayoutBudget {
    return this.getChatLayoutForViewport(state, state.viewport);
  }

  private getChatLayoutForViewport(
    state: Pick<UiRuntimeState, "detailDrawer" | "activeRegion" | "chatDraft" | "conversationActivity">,
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
      composerRows: composerInputRows + 1 + resolveChatActivityRows(state.conversationActivity),
    });
  }

  private async persistSessionAndUi(options: {
    requireSessionSave?: boolean | undefined;
  } = {}): Promise<void> {
    await this.saveSessionsFile(options);
    await this.persistUiState();
  }

  private async persistUiState(): Promise<void> {
    try {
      await this.uiStateStore.save(toPersistedUiState(this.uiStore.getState()));
    } catch (error) {
      this.recordPersistenceFailure("ui-state.save", error);
    }
  }

  private async saveSessionsFile(options: {
    requireSessionSave?: boolean | undefined;
  } = {}): Promise<void> {
    try {
      await this.coordinateSessionsFileCommit(async () => {
        const snapshot = this.sessionsFile;
        await this.sessionStore.save(snapshot);
      });
    } catch (error) {
      this.recordPersistenceFailure("sessions.save", error);
      if (options.requireSessionSave === true) throw error;
    }
  }

  private async coordinateSessionsFileCommit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionsFileCommitTail;
    const current = previous.catch(() => undefined).then(operation);
    this.sessionsFileCommitTail = current.then(() => undefined, () => undefined);
    return await current;
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

export function terminalMessageRecoveryThreadId(sessionId: string): string {
  return `thread-main:${sessionId}`;
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

function hasSameTuiLifecycleEvidence(left: TuiSessionMeta, right: TuiSessionMeta): boolean {
  return left.started === right.started
    && left.pendingRunId === right.pendingRunId
    && left.pendingRunRequestId === right.pendingRunRequestId
    && left.pendingRunMessageId === right.pendingRunMessageId
    && left.pendingRunThreadId === right.pendingRunThreadId
    && hasSameExactRunIdentityCollection(
      left.pendingQueueSubmissions,
      right.pendingQueueSubmissions,
    )
    && hasSameQueuedRunReservations(left.queuedRunReservations, right.queuedRunReservations)
    && hasSameTerminalQueuedRuns(left.terminalQueuedRuns, right.terminalQueuedRuns)
    && left.acceptedRunId === right.acceptedRunId
    && left.acceptedRunMessageId === right.acceptedRunMessageId
    && left.acceptedRunThreadId === right.acceptedRunThreadId
    && left.acceptedRunPredecessorId === right.acceptedRunPredecessorId
    && left.lastRunStatus === right.lastRunStatus
    && left.delegation?.status === right.delegation?.status
    && isSameWaitFor(left.pendingWaitFor, right.pendingWaitFor);
}

function exactRunStatusFromDescribedView(
  view: NonNullable<SessionDescribedEventPayload["operatorThreadView"]>,
  runId: string,
): "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | undefined {
  if (view.activeRun !== undefined) {
    return view.activeRun.runId === runId ? view.activeRun.status : undefined;
  }
  const terminalTurn = [...(view.conversationTurns ?? [])]
    .reverse()
    .find((turn) =>
      turn.terminalRunId === runId
      && (turn.status === "COMPLETED" || turn.status === "FAILED")
    );
  return terminalTurn !== undefined
    ? terminalTurn.status
    : undefined;
}

function reconcileExactQueuedLifecycle(
  session: TuiSessionMeta,
  view: SessionDescribedEventPayload["operatorThreadView"],
): {
  pendingQueueSubmissions: TuiSessionMeta["pendingQueueSubmissions"];
  queuedRunReservations: TuiSessionMeta["queuedRunReservations"];
  terminalQueuedRuns: TuiSessionMeta["terminalQueuedRuns"];
  accepted?: {
    runId: string;
    messageId: string;
    threadId: string;
    predecessorRunId?: string | undefined;
    status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  } | undefined;
} {
  const normalizedQueue = normalizeTuiQueueGraph(session);
  const normalizedSession = { ...session, ...normalizedQueue };
  let pendingQueueSubmissions = normalizedQueue.pendingQueueSubmissions;
  let queuedRunReservations = normalizedQueue.queuedRunReservations;
  let terminalQueuedRuns = normalizedQueue.terminalQueuedRuns;
  if (view === undefined) {
    return { pendingQueueSubmissions, queuedRunReservations, terminalQueuedRuns };
  }
  const acceptedCandidates: Array<{
    runId: string;
    messageId: string;
    threadId: string;
    predecessorRunId?: string | undefined;
    status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  }> = [];
  for (const submission of normalizedSession.pendingQueueSubmissions ?? []) {
    const currentSubmission = pendingQueueSubmissions?.find(
      (candidate) => candidate.runId === submission.runId,
    );
    if (currentSubmission === undefined || currentSubmission.threadId !== view.thread.threadId) continue;
    const route = view.conversationMessageRoutes?.find(
      (candidate) => candidate.messageId === currentSubmission.messageId,
    );
    if (view.conversationMessageRoutes !== undefined && route === undefined) {
      const rewired = removeAndRewireTuiQueueRecord({
        pendingQueueSubmissions,
        queuedRunReservations,
        terminalQueuedRuns,
      }, currentSubmission);
      pendingQueueSubmissions = rewired.pendingQueueSubmissions;
      queuedRunReservations = rewired.queuedRunReservations;
      terminalQueuedRuns = rewired.terminalQueuedRuns;
      continue;
    }
    if (
      route?.disposition === "queued"
      && (route.runId === undefined || route.runId === currentSubmission.runId)
    ) {
      pendingQueueSubmissions = omitExactRunIdentity(pendingQueueSubmissions, currentSubmission);
      queuedRunReservations = appendExactQueuedRunReservation(
        queuedRunReservations,
        currentSubmission,
      );
      continue;
    }
    if (route?.disposition !== "started" || route.runId !== currentSubmission.runId) continue;
    const status = exactQueuedRunStatusFromDescribedView(view, currentSubmission.runId);
    if (status !== undefined) acceptedCandidates.push({ ...currentSubmission, status });
  }
  for (const reservation of normalizedSession.queuedRunReservations ?? []) {
    if (reservation.threadId !== view.thread.threadId) continue;
    const status = exactQueuedRunStatusFromDescribedView(view, reservation.runId);
    if (status !== undefined) acceptedCandidates.push({ ...reservation, status });
  }
  for (const terminal of normalizedSession.terminalQueuedRuns ?? []) {
    if (terminal.threadId !== view.thread.threadId) continue;
    const status = exactQueuedRunStatusFromDescribedView(view, terminal.runId);
    if (status === terminal.status) acceptedCandidates.push({ ...terminal, status });
  }
  if (view.activeRun !== undefined) {
    let activeIdentity = [
      ...(pendingQueueSubmissions ?? []),
      ...(queuedRunReservations ?? []),
    ].find((candidate) => candidate.runId === view.activeRun!.runId)
      ?? (
        session.acceptedRunId === view.activeRun.runId
        && session.acceptedRunMessageId !== undefined
        && session.acceptedRunThreadId === view.thread.threadId
          ? {
              runId: session.acceptedRunId,
              messageId: session.acceptedRunMessageId,
              threadId: session.acceptedRunThreadId,
              ...(session.acceptedRunPredecessorId === undefined
                ? {}
                : session.acceptedRunPredecessorId === null
                  ? { predecessorRunId: undefined }
                  : { predecessorRunId: session.acceptedRunPredecessorId }),
            }
          : undefined
      );
    if (
      activeIdentity !== undefined
      && session.acceptedRunId !== undefined
      && session.acceptedRunMessageId !== undefined
      && session.acceptedRunThreadId === view.thread.threadId
      && activeIdentity.runId !== session.acceptedRunId
    ) {
      const persistedAcceptedTerminal = terminalQueuedRuns?.find((terminal) =>
        terminal.runId === session.acceptedRunId
        && terminal.messageId === session.acceptedRunMessageId
        && terminal.threadId === session.acceptedRunThreadId
        && terminal.predecessorRunId === activeIdentity!.predecessorRunId
        && (
          session.acceptedRunPredecessorId === undefined
          || acceptedQueuePredecessorMatches(session, activeIdentity!)
        )
      );
      const acceptedTerminalStatus = exactQueuedRunStatusFromDescribedView(
        view,
        session.acceptedRunId,
      );
      const acceptedPredecessorConflictsWithActive =
        session.acceptedRunPredecessorId !== undefined
          ? session.acceptedRunPredecessorId !== durableAcceptedQueuePredecessorId(activeIdentity)
          : persistedAcceptedTerminal === undefined
            && hasExactQueuedSuccessorTurnSequence(view, {
              runId: session.acceptedRunId,
              messageId: session.acceptedRunMessageId,
              threadId: session.acceptedRunThreadId,
            }, activeIdentity) === false;
      const acceptedTerminal = persistedAcceptedTerminal ?? (
        acceptedPredecessorConflictsWithActive === false
        &&
        (acceptedTerminalStatus === "COMPLETED" || acceptedTerminalStatus === "FAILED")
        && hasExactQueuedTerminalTurn(view, {
          runId: session.acceptedRunId,
          messageId: session.acceptedRunMessageId,
          threadId: session.acceptedRunThreadId,
          status: acceptedTerminalStatus,
        })
          ? {
              runId: session.acceptedRunId,
              messageId: session.acceptedRunMessageId,
              threadId: session.acceptedRunThreadId,
              status: acceptedTerminalStatus,
              ...(activeIdentity.predecessorRunId === undefined
                ? {}
                : { predecessorRunId: activeIdentity.predecessorRunId }),
            }
          : undefined
      );
      if (acceptedTerminal !== undefined) {
        terminalQueuedRuns = appendTerminalQueuedRun(terminalQueuedRuns, acceptedTerminal);
        const bound = bindTuiQueueSuccessor({
          pendingQueueSubmissions,
          queuedRunReservations,
          terminalQueuedRuns,
        }, activeIdentity, acceptedTerminal);
        pendingQueueSubmissions = bound.pendingQueueSubmissions;
        queuedRunReservations = bound.queuedRunReservations;
        terminalQueuedRuns = bound.terminalQueuedRuns;
        activeIdentity = [
          ...(pendingQueueSubmissions ?? []),
          ...(queuedRunReservations ?? []),
        ].find((candidate) => candidate.runId === view.activeRun!.runId) ?? activeIdentity;
      }
    }
    const exactQueuedSuccessors = [
      ...(pendingQueueSubmissions ?? []),
      ...(queuedRunReservations ?? []),
    ].filter((candidate) =>
      candidate.runId !== view.activeRun!.runId
      && candidate.threadId === view.thread.threadId
      && (
        session.acceptedRunPredecessorId !== undefined
          ? candidate.predecessorRunId === activeIdentity?.predecessorRunId
          : candidate.predecessorRunId === activeIdentity?.runId
            || view.conversationTurns?.some((turn) =>
              turn.threadId === view.thread.threadId
              && turn.sessionId === view.thread.sessionId
              && turn.sourceMessageId === activeIdentity?.messageId
              && turn.terminalRunId === activeIdentity?.runId
              && (turn.status === "COMPLETED" || turn.status === "FAILED")
              && turn.sequence !== null
              && Number.isSafeInteger(turn.sequence)
            ) === true
      )
      && view.conversationMessageRoutes?.some((route) =>
        route.messageId === candidate.messageId
        && route.disposition === "queued"
        && route.runId === candidate.runId
      ) === true
    );
    if (activeIdentity !== undefined && exactQueuedSuccessors.length === 1) {
      const bound = bindTuiQueueSuccessor({
        pendingQueueSubmissions,
        queuedRunReservations,
        terminalQueuedRuns,
      }, exactQueuedSuccessors[0]!, activeIdentity);
      pendingQueueSubmissions = bound.pendingQueueSubmissions;
      queuedRunReservations = bound.queuedRunReservations;
      terminalQueuedRuns = bound.terminalQueuedRuns;
    }
  }
  const reboundQueueRecords = [
    ...(pendingQueueSubmissions ?? []),
    ...(queuedRunReservations ?? []),
    ...(terminalQueuedRuns ?? []),
  ];
  for (let index = 0; index < acceptedCandidates.length; index += 1) {
    const rebound = reboundQueueRecords.find((candidate) =>
      candidate.runId === acceptedCandidates[index]!.runId
    );
    if (rebound !== undefined) {
      acceptedCandidates[index] = { ...acceptedCandidates[index]!, ...rebound };
    }
  }
  const distinctCandidates = acceptedCandidates.filter((candidate, index, candidates) =>
    candidates.findIndex((other) =>
      other.runId === candidate.runId
      && other.messageId === candidate.messageId
      && other.threadId === candidate.threadId
    ) === index
  );
  const terminalCandidates = distinctCandidates.filter(
    (candidate) => candidate.status === "COMPLETED" || candidate.status === "FAILED",
  ) as Array<(typeof distinctCandidates)[number] & { status: "COMPLETED" | "FAILED" }>;
  const exactOrderedTerminalCandidates = orderExactTerminalCandidates(
    terminalCandidates,
    view,
  );
  if (terminalCandidates.length > 0 && exactOrderedTerminalCandidates === undefined) {
    return { pendingQueueSubmissions, queuedRunReservations, terminalQueuedRuns };
  }
  let acceptedFromTerminalSequence: (typeof terminalCandidates)[number] | undefined;
  let priorOrderedTerminal: (typeof terminalCandidates)[number] | undefined;
  let priorTerminalEpochRoot: string | undefined;
  for (const terminalCandidate of exactOrderedTerminalCandidates ?? []) {
    let terminal = terminalCandidate;
    const durableTerminalIdentity = [
      ...(pendingQueueSubmissions ?? []),
      ...(queuedRunReservations ?? []),
      ...(terminalQueuedRuns ?? []),
    ].find((candidate) =>
      candidate.runId === terminal.runId
      && candidate.messageId === terminal.messageId
      && candidate.threadId === terminal.threadId
    );
    if (durableTerminalIdentity === undefined) continue;
    const terminalEpochRoot = exactQueueEpochRootRunId(
      durableTerminalIdentity,
      reboundQueueRecords,
    );
    if (
      priorOrderedTerminal !== undefined
      && (
        terminalEpochRoot === undefined
        || priorTerminalEpochRoot === undefined
        || terminalEpochRoot !== priorTerminalEpochRoot
      )
    ) {
      priorOrderedTerminal = undefined;
    }
    if (
      priorOrderedTerminal !== undefined
      && durableTerminalIdentity.predecessorRunId !== priorOrderedTerminal.runId
    ) {
      const bound = bindTuiQueueSuccessor({
        pendingQueueSubmissions,
        queuedRunReservations,
        terminalQueuedRuns,
      }, durableTerminalIdentity, priorOrderedTerminal);
      pendingQueueSubmissions = bound.pendingQueueSubmissions;
      queuedRunReservations = bound.queuedRunReservations;
      terminalQueuedRuns = bound.terminalQueuedRuns;
      terminal = {
        ...terminal,
        predecessorRunId: priorOrderedTerminal.runId,
      };
    }
    priorOrderedTerminal = terminal;
    priorTerminalEpochRoot = terminalEpochRoot;
    pendingQueueSubmissions = omitExactRunIdentity(pendingQueueSubmissions, terminal);
    queuedRunReservations = omitExactRunIdentity(queuedRunReservations, terminal);
    terminalQueuedRuns = appendTerminalQueuedRun(terminalQueuedRuns, {
      runId: terminal.runId,
      messageId: terminal.messageId,
      threadId: terminal.threadId,
      status: terminal.status as "COMPLETED" | "FAILED",
      ...(terminal.predecessorRunId !== undefined
        ? { predecessorRunId: terminal.predecessorRunId }
        : {}),
    });
    if (
      queuedEvidenceCanReplaceAcceptedRun(
        {
          ...session,
          ...(acceptedFromTerminalSequence === undefined
            ? {}
            : { acceptedRunId: acceptedFromTerminalSequence.runId }),
          pendingQueueSubmissions,
          queuedRunReservations,
          terminalQueuedRuns,
        },
        terminal,
      )
    ) {
      acceptedFromTerminalSequence = terminal;
    }
  }
  const activeCandidates = distinctCandidates.filter(
    (candidate) => candidate.status === "RUNNING" || candidate.status === "WAITING",
  );
  let exactActiveCandidate = activeCandidates.length === 1 ? activeCandidates[0] : undefined;
  if (
    exactActiveCandidate !== undefined
    && priorOrderedTerminal !== undefined
    && exactQueueEpochRootRunId(exactActiveCandidate, reboundQueueRecords) !== undefined
    && exactQueueEpochRootRunId(exactActiveCandidate, reboundQueueRecords) === priorTerminalEpochRoot
    && session.acceptedRunId === exactActiveCandidate.runId
    && session.acceptedRunMessageId === exactActiveCandidate.messageId
    && session.acceptedRunThreadId === exactActiveCandidate.threadId
    && acceptedQueuePredecessorMatches(session, exactActiveCandidate)
    && exactActiveCandidate.predecessorRunId !== priorOrderedTerminal.runId
  ) {
    const bound = bindTuiQueueSuccessor({
      pendingQueueSubmissions,
      queuedRunReservations,
      terminalQueuedRuns,
    }, exactActiveCandidate, priorOrderedTerminal);
    pendingQueueSubmissions = bound.pendingQueueSubmissions;
    queuedRunReservations = bound.queuedRunReservations;
    terminalQueuedRuns = bound.terminalQueuedRuns;
    exactActiveCandidate = {
      ...exactActiveCandidate,
      predecessorRunId: priorOrderedTerminal.runId,
    };
  }
  const activeCanFollowTerminal = exactActiveCandidate !== undefined
    && queuedEvidenceCanReplaceAcceptedRun({
      ...normalizedSession,
      ...(acceptedFromTerminalSequence === undefined
        ? {}
        : { acceptedRunId: acceptedFromTerminalSequence.runId }),
      pendingQueueSubmissions,
      queuedRunReservations,
      terminalQueuedRuns,
    }, exactActiveCandidate);
  const soleCandidate = activeCanFollowTerminal
    ? exactActiveCandidate
    : acceptedFromTerminalSequence;
  const accepted = soleCandidate !== undefined
    && queuedEvidenceCanReplaceAcceptedRun({
      ...normalizedSession,
      pendingQueueSubmissions,
      queuedRunReservations,
      terminalQueuedRuns,
    }, soleCandidate)
    ? soleCandidate
    : undefined;
  if (accepted !== undefined) {
    const advanced = advanceTuiQueueAuthority({
      pendingQueueSubmissions,
      queuedRunReservations,
      terminalQueuedRuns,
    }, accepted);
    pendingQueueSubmissions = advanced.pendingQueueSubmissions;
    queuedRunReservations = advanced.queuedRunReservations;
    terminalQueuedRuns = advanced.terminalQueuedRuns;
  }
  return {
    pendingQueueSubmissions,
    queuedRunReservations,
    terminalQueuedRuns,
    ...(accepted !== undefined ? { accepted } : {}),
  };
}

function projectForegroundSessionProgress(
  source: TuiSessionMeta,
  input: { sessionId: string; threadId: string; runId: string; messageId: string },
): TuiSessionMeta | undefined {
  const session = { ...source, ...normalizeTuiQueueGraph(source) };
  if (session.delegation !== undefined) return undefined;
  const queuedEvidence = resolveExactTuiQueuedEvidence(session, input);
  if (queuedEvidence?.source === "tombstone") return undefined;
  const exactAcceptedStart = session.acceptedRunId === input.runId
    && session.acceptedRunMessageId === input.messageId
    && session.acceptedRunThreadId === input.threadId;
  if (
    queuedEvidence !== undefined
    && queuedEvidenceCanReplaceAcceptedRun(session, queuedEvidence) === false
  ) return undefined;
  if (
    exactAcceptedStart === false
    && queuedEvidence === undefined
    && (
      session.pendingRunId !== input.runId
      || session.pendingRunMessageId !== input.messageId
      || session.pendingRunThreadId !== input.threadId
    )
  ) return undefined;
  let acceptedQueueGraph = queuedEvidence !== undefined
    && (queuedEvidence.source === "pending" || queuedEvidence.source === "reservation")
    ? advanceTuiQueueAuthority(normalizeTuiQueueGraph(session), queuedEvidence)
    : normalizeTuiQueueGraph(session);
  let acceptedQueuePredecessorId = queuedEvidence === undefined
    ? exactAcceptedStart
      ? session.acceptedRunPredecessorId
      : undefined
    : durableAcceptedQueuePredecessorId(queuedEvidence);
  if (exactAcceptedStart) {
    const unresolvedSuccessors = [
      ...(acceptedQueueGraph.pendingQueueSubmissions ?? []),
      ...(acceptedQueueGraph.queuedRunReservations ?? []),
    ].filter((candidate) =>
      candidate.threadId === input.threadId
      && candidate.runId !== input.runId
      && candidate.predecessorRunId !== input.runId
      && acceptedQueuePredecessorMatches(session, candidate)
    );
    if (unresolvedSuccessors.length > 1) return undefined;
    if (unresolvedSuccessors.length === 1) {
      acceptedQueueGraph = bindTuiQueueSuccessor(
        acceptedQueueGraph,
        unresolvedSuccessors[0]!,
        { runId: input.runId, messageId: input.messageId, threadId: input.threadId },
      );
    }
    const retainedAcceptedRecord = [
      ...(acceptedQueueGraph.pendingQueueSubmissions ?? []),
      ...(acceptedQueueGraph.queuedRunReservations ?? []),
    ].find((candidate) =>
      candidate.runId === input.runId
      && candidate.messageId === input.messageId
      && candidate.threadId === input.threadId
    );
    if (retainedAcceptedRecord !== undefined) {
      acceptedQueuePredecessorId = durableAcceptedQueuePredecessorId(retainedAcceptedRecord);
      acceptedQueueGraph = advanceTuiQueueAuthority(acceptedQueueGraph, retainedAcceptedRecord);
    }
  }
  return {
    ...session,
    started: true,
    focusedThreadId: input.threadId,
    acceptedRunId: input.runId,
    acceptedRunMessageId: input.messageId,
    acceptedRunThreadId: input.threadId,
    acceptedRunPredecessorId: acceptedQueuePredecessorId,
    pendingRunId: undefined,
    pendingRunMessageId: undefined,
    pendingRunThreadId: undefined,
    queuedRunReservations: acceptedQueueGraph.queuedRunReservations,
    pendingQueueSubmissions: acceptedQueueGraph.pendingQueueSubmissions,
    terminalQueuedRuns: acceptedQueueGraph.terminalQueuedRuns,
    lastRunStatus: undefined,
    updatedAt: new Date().toISOString(),
  };
}

function exactQueuedRunStatusFromDescribedView(
  view: NonNullable<SessionDescribedEventPayload["operatorThreadView"]>,
  runId: string,
): "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | undefined {
  if (view.activeRun?.runId === runId) return view.activeRun.status;
  const terminalTurn = [...(view.conversationTurns ?? [])]
    .reverse()
    .find((turn) =>
      turn.terminalRunId === runId
      && (turn.status === "COMPLETED" || turn.status === "FAILED")
    );
  return terminalTurn?.status;
}

function orderExactTerminalCandidates<T extends {
  runId: string;
  messageId: string;
  threadId: string;
  predecessorRunId?: string | undefined;
  status: "COMPLETED" | "FAILED";
}>(
  candidates: T[],
  view: NonNullable<SessionDescribedEventPayload["operatorThreadView"]>,
): T[] | undefined {
  if (candidates.length === 0) return candidates;
  const ordered: Array<{ candidate: T; sequence: number }> = [];
  for (const candidate of candidates) {
    const matchingTurns = view.conversationTurns?.filter((turn) =>
      turn.sessionId === view.thread.sessionId
      && turn.threadId === candidate.threadId
      && turn.sourceMessageId === candidate.messageId
      && turn.terminalRunId === candidate.runId
      && turn.status === candidate.status
      && (turn.terminalStatus === undefined || turn.terminalStatus === candidate.status)
      && turn.sequence !== null
      && Number.isSafeInteger(turn.sequence)
    ) ?? [];
    if (matchingTurns.length !== 1) return undefined;
    ordered.push({ candidate, sequence: matchingTurns[0]!.sequence! });
  }
  if (new Set(ordered.map((entry) => entry.sequence)).size !== ordered.length) return undefined;
  return ordered
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry) => entry.candidate);
}

function hasExactQueuedTerminalTurn(
  view: NonNullable<SessionDescribedEventPayload["operatorThreadView"]>,
  candidate: {
    runId: string;
    messageId: string;
    threadId: string;
    status: "COMPLETED" | "FAILED";
  },
): boolean {
  const matchingTurns = view.conversationTurns?.filter((turn) =>
    turn.sessionId === view.thread.sessionId
    && turn.threadId === candidate.threadId
    && turn.sourceMessageId === candidate.messageId
    && turn.terminalRunId === candidate.runId
    && turn.status === candidate.status
    && (turn.terminalStatus === undefined || turn.terminalStatus === candidate.status)
    && turn.sequence !== null
    && Number.isSafeInteger(turn.sequence)
  ) ?? [];
  return matchingTurns.length === 1;
}

function hasExactQueuedSuccessorTurnSequence(
  view: OperatorThreadView,
  predecessor: { runId: string; messageId: string; threadId: string },
  successor: { runId: string; messageId: string; threadId: string },
): boolean {
  const predecessorTurns = view.conversationTurns?.filter((turn) =>
    turn.sessionId === view.thread.sessionId
    && turn.threadId === predecessor.threadId
    && turn.sourceMessageId === predecessor.messageId
    && turn.terminalRunId === predecessor.runId
    && (turn.status === "COMPLETED" || turn.status === "FAILED")
    && turn.sequence !== null
    && Number.isSafeInteger(turn.sequence)
  ) ?? [];
  const successorTurns = view.conversationTurns?.filter((turn) =>
    turn.sessionId === view.thread.sessionId
    && turn.threadId === successor.threadId
    && turn.sourceMessageId === successor.messageId
    && (turn.rootRunId === successor.runId || turn.terminalRunId === successor.runId)
    && turn.sequence !== null
    && Number.isSafeInteger(turn.sequence)
  ) ?? [];
  return predecessorTurns.length === 1
    && successorTurns.length === 1
    && predecessorTurns[0]!.sequence! < successorTurns[0]!.sequence!;
}

function exactQueueEpochRootRunId(
  candidate: {
    runId: string;
    threadId: string;
    predecessorRunId?: string | undefined;
  },
  records: Array<{
    runId: string;
    threadId: string;
    predecessorRunId?: string | undefined;
  }>,
): string | undefined {
  let predecessorRunId = candidate.predecessorRunId;
  const visited = new Set([candidate.runId]);
  while (predecessorRunId !== undefined) {
    if (visited.has(predecessorRunId)) return undefined;
    visited.add(predecessorRunId);
    const predecessors = records.filter((record) =>
      record.runId === predecessorRunId
      && record.threadId === candidate.threadId
    );
    if (predecessors.length === 0) return predecessorRunId;
    if (predecessors.length !== 1) return undefined;
    predecessorRunId = predecessors[0]!.predecessorRunId;
  }
  return undefined;
}

function appendTerminalQueuedRun(
  terminalRuns: TuiSessionMeta["terminalQueuedRuns"],
  terminal: NonNullable<TuiSessionMeta["terminalQueuedRuns"]>[number],
): NonNullable<TuiSessionMeta["terminalQueuedRuns"]> {
  const existing = terminalRuns ?? [];
  const sameRun = existing.find((candidate) => candidate.runId === terminal.runId);
  if (sameRun !== undefined) {
    if (
      sameRun.messageId !== terminal.messageId
      || sameRun.threadId !== terminal.threadId
      || sameRun.status !== terminal.status
      || sameRun.predecessorRunId !== terminal.predecessorRunId
    ) {
      throw new Error("Terminal queued run identity conflicted with durable lifecycle evidence.");
    }
    return existing;
  }
  return [...existing, terminal];
}

function omitExactRunIdentity<T extends { runId: string; messageId: string; threadId: string }>(
  values: T[] | undefined,
  identity: { runId: string; messageId: string; threadId: string },
): T[] | undefined {
  const remaining = values?.filter((candidate) =>
    candidate.runId !== identity.runId
    || candidate.messageId !== identity.messageId
    || candidate.threadId !== identity.threadId
  );
  return remaining === undefined || remaining.length === 0 ? undefined : remaining;
}

function omitQueuedRunReservation(
  reservations: TuiSessionMeta["queuedRunReservations"],
  reservation: NonNullable<TuiSessionMeta["queuedRunReservations"]>[number],
): TuiSessionMeta["queuedRunReservations"] {
  const remaining = reservations?.filter((candidate) =>
    candidate.runId !== reservation.runId
    || candidate.messageId !== reservation.messageId
    || candidate.threadId !== reservation.threadId
  );
  return remaining === undefined || remaining.length === 0 ? undefined : remaining;
}

function appendExactQueuedRunReservation(
  reservations: TuiSessionMeta["queuedRunReservations"],
  reservation: NonNullable<TuiSessionMeta["pendingQueueSubmissions"]>[number],
): NonNullable<TuiSessionMeta["queuedRunReservations"]> {
  const existing = reservations ?? [];
  const sameRun = existing.find((candidate) => candidate.runId === reservation.runId);
  if (sameRun !== undefined) {
    if (
      sameRun.messageId !== reservation.messageId
      || sameRun.threadId !== reservation.threadId
      || sameRun.predecessorRunId !== reservation.predecessorRunId
    ) {
      throw new Error("Queued run reservation identity conflicted with durable route evidence.");
    }
    return existing;
  }
  return [...existing, {
    runId: reservation.runId,
    messageId: reservation.messageId,
    threadId: reservation.threadId,
    ...(reservation.predecessorRunId !== undefined
      ? { predecessorRunId: reservation.predecessorRunId }
      : {}),
  }];
}

function hasSameQueuedRunReservations(
  left: TuiSessionMeta["queuedRunReservations"],
  right: TuiSessionMeta["queuedRunReservations"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((reservation, index) => {
    const candidate = right[index];
    return candidate?.runId === reservation.runId
      && candidate.messageId === reservation.messageId
      && candidate.threadId === reservation.threadId
      && candidate.predecessorRunId === reservation.predecessorRunId;
  });
}

function hasSameTerminalQueuedRuns(
  left: TuiSessionMeta["terminalQueuedRuns"],
  right: TuiSessionMeta["terminalQueuedRuns"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((terminal, index) => {
    const candidate = right[index];
    return candidate?.runId === terminal.runId
      && candidate.messageId === terminal.messageId
      && candidate.threadId === terminal.threadId
      && candidate.status === terminal.status
      && candidate.predecessorRunId === terminal.predecessorRunId;
  });
}

function hasSameExactRunIdentityCollection(
  left: TuiSessionMeta["pendingQueueSubmissions"],
  right: TuiSessionMeta["pendingQueueSubmissions"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((reservation, index) => {
    const candidate = right[index];
    return candidate?.runId === reservation.runId
      && candidate.messageId === reservation.messageId
      && candidate.threadId === reservation.threadId
      && candidate.predecessorRunId === reservation.predecessorRunId
      && candidate.indeterminate === reservation.indeterminate;
  });
}

function queuedEvidenceCanReplaceAcceptedRun(
  session: TuiSessionMeta,
  evidence: { runId: string; predecessorRunId?: string | undefined },
): boolean {
  if (session.acceptedRunId === undefined || session.acceptedRunId === evidence.runId) return true;
  let predecessorRunId = evidence.predecessorRunId;
  const visited = new Set<string>();
  while (predecessorRunId !== undefined && visited.has(predecessorRunId) === false) {
    if (predecessorRunId === session.acceptedRunId) return true;
    visited.add(predecessorRunId);
    const predecessor = [
      ...(session.pendingQueueSubmissions ?? []),
      ...(session.queuedRunReservations ?? []),
      ...(session.terminalQueuedRuns ?? []),
    ].find((candidate) => candidate.runId === predecessorRunId);
    predecessorRunId = predecessor?.predecessorRunId;
  }
  return false;
}

function durableAcceptedQueuePredecessorId(
  evidence: { predecessorRunId?: string | undefined },
): string | null {
  return evidence.predecessorRunId ?? null;
}

function acceptedQueuePredecessorMatches(
  session: TuiSessionMeta,
  evidence: { predecessorRunId?: string | undefined },
): boolean {
  return session.acceptedRunPredecessorId !== undefined
    && session.acceptedRunPredecessorId === durableAcceptedQueuePredecessorId(evidence);
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
  return {
    phase: "running",
    summary: "pre-flight checks in progress",
    checks: [
      { id: "profiles", label: "profiles", state: "ok", detail: input.profile.id },
      { id: "session", label: "session", state: "ok", detail: input.session.name },
      { id: "theme", label: "theme", state: "ok", detail: `${themeSelection.mode}:${themeSelection.resolvedMode}` },
      { id: "runner", label: "runner", state: "pending", detail: "waiting" },
      { id: "handshake", label: "handshake", state: "pending", detail: input.session.sessionId },
      { id: "database", label: "database", state: "pending", detail: "waiting" },
      { id: "provider", label: "credentials", state: "pending", detail: input.profile.modelProvider ?? "openrouter" },
      { id: "mcp", label: "mcp", state: "pending", detail: "waiting" },
    ],
  };
}

function resolveProviderCredentialEnvVar(
  provider: TuiProfile["modelProvider"],
): string | undefined {
  if (provider === "openai") {
    return "OPENAI_API_KEY";
  }
  if (provider === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  if (provider === "ollama" || provider === "lmstudio") {
    return;
  }
  return "OPENROUTER_API_KEY";
}

function usesLocalCoreRunnerTransport(env: NodeJS.ProcessEnv): boolean {
  const remoteUrl = env.KESTREL_RUNNER_SERVICE_URL?.trim();
  return (remoteUrl === undefined || remoteUrl.length === 0)
    && typeof env.KESTREL_LOCAL_CORE_API_SOCKET === "string"
    && env.KESTREL_LOCAL_CORE_API_SOCKET.trim().length > 0
    && typeof env.KESTREL_LOCAL_CORE_API_TOKEN === "string"
    && env.KESTREL_LOCAL_CORE_API_TOKEN.trim().length > 0;
}

function resolveRequiredPreflightEnvVars(
  profile: TuiProfile,
  _session: TuiSessionMeta,
  includeRuntimeCredentials = true,
): string[] {
  const required = new Set<string>();
  if (includeRuntimeCredentials) {
    const providerCredential = resolveProviderCredentialEnvVar(
      profile.modelProvider ?? "openrouter",
    );
    if (providerCredential !== undefined) {
      required.add(providerCredential);
    }
    if (usesTavilyTools(profile)) {
      required.add("TAVILY_API_KEY");
    }
  }

  return [...required];
}

function usesTavilyTools(profile: TuiProfile): boolean {
  return (profile.toolAllowlist ?? []).some((toolName) =>
    toolName.startsWith("internet.")
  );
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
  if (profile.agent === "kestrel") {
    return AGENT_STEP_IDS.loop;
  }

  throw new Error(`Unsupported profile agent '${profile.agent}'`);
}
