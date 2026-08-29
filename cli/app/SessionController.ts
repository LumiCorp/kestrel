import type { ResolvedWorkspace, TuiProfile, TuiSessionMeta } from "../contracts.js";
import { randomUUID } from "node:crypto";
import {
  buildChatVisualRows,
  countChatVisualRows,
  ensureChatCursorVisible,
} from "../ink/views/chatRows.js";
import { resolveThemeSelection } from "../ink/theme/tokens.js";
import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  formatUserFacingModeLabel,
} from "../../src/index.js";
import {
  formatOperatorLaunchSummary,
  pickResumeTarget,
  resolveOperatorStartTask,
  type OperatorResolvedStartTask,
} from "../../src/operatorShell.js";
import { describeResolvedWorkspace } from "../workspace/WorkspaceResolver.js";
import type { TuiAppContext } from "./TuiAppContext.js";
import type { SessionDescribedEventPayload } from "../protocol/contracts.js";
import {
  readTuiEnvironmentIdentityFailure,
  resolveTuiSessionEnvironment,
  TuiEnvironmentIdentityError,
  type TuiEnvironmentPresetId,
} from "../session/TuiExecutionEnvironment.js";
import type { ConversationActivityItem } from "@kestrel-agents/conversation";
import {
  hasDurableTuiRuntimeBinding,
  resolveStartedSessionAuthoringProfile,
} from "../session/TuiAuthoringProfile.js";
import { formatTuiEnvironmentLabel } from "../session/TuiEnvironmentPresentation.js";

export interface CreateSessionOptions {
  launch: OperatorResolvedStartTask;
  profile: TuiProfile;
  workspace?: ResolvedWorkspace | undefined;
  environmentPresetId?: TuiEnvironmentPresetId | undefined;
}

export interface SessionControllerContext extends TuiAppContext {
  saveSessionsFile(): Promise<void>;
  commitCreatedSession(session: TuiSessionMeta): Promise<void>;
  createSessionMeta(
    launch: OperatorResolvedStartTask,
    profile: TuiProfile,
    workspace?: ResolvedWorkspace | undefined,
  ): TuiSessionMeta;
  buildSessionOperatorState(input: {
    session: TuiSessionMeta;
    profile: TuiProfile;
    runtime?: TuiSessionMeta["operatorState"] | undefined;
  }): NonNullable<TuiSessionMeta["operatorState"]>;
  resolveWorkspaceForSession(session: TuiSessionMeta): Promise<ResolvedWorkspace | undefined>;
  syncSessionFromDescribePayload(payload: SessionDescribedEventPayload): Promise<void>;
  startActiveTurn(input: {
    messageId?: string | undefined;
    submittedMessage: string;
    resumeBlockedRun?: boolean | undefined;
  }): Promise<boolean>;
  getChatWrappedBodyWidth(): number;
  getChatListRows(): number;
  recoverTerminalMessages(session: TuiSessionMeta): Promise<void>;
  getConversationActivity(sessionId: string): ConversationActivityItem[];
  getConversationRunState(sessionId: string): {
    running: boolean;
    status: "running" | "waiting" | "completed" | "failed" | "ready";
  };
}

export class SessionController {
  private readonly context: SessionControllerContext;

  constructor(context: SessionControllerContext) {
    this.context = context;
  }

  async handleSessionsCommand(): Promise<void> {
    const state = this.context.uiStore.getState();
    const lines = state.sessions.map((session) => {
      const active = session.name === state.activeSession.name ? " (active)" : "";
      const waiting =
        session.pendingWaitFor?.eventType !== undefined ? ` waiting:${session.pendingWaitFor.eventType}` : "";
      const runStatus = session.lastRunStatus ? ` status:${session.lastRunStatus.toLowerCase()}` : "";
      const mode = formatTuiSessionMode(session);
      const agent = session.agentProfileLabel
        ?? session.profileLabel
        ?? (session.profileId === state.activeProfile?.id ? state.activeProfile.label : session.profileId);
      const environment = formatTuiEnvironmentLabel(session.environmentPresetId);
      return `${session.name}${active} -> ${session.sessionId} agent:${agent} environment:${environment} mode:${mode}${waiting}${runStatus}`;
    });

    await this.context.appendHistoryLine("system", `Sessions:\n${lines.join("\n") || "(none)"}`);
  }

  async handleNewCommand(args: string[]): Promise<void> {
    const name = args.join(" ").trim();
    if (name.length === 0) {
      await this.context.appendHistoryLine("system", "Usage: /new <name>");
      return;
    }
    await this.createSessionFromName(name);
  }

  async handleSwitchOrResumeCommand(command: "switch" | "resume", args: string[]): Promise<void> {
    const name = args.join(" ").trim();
    if (name.length === 0) {
      await this.context.appendHistoryLine(
        "system",
        `Usage: /${command} <name|session-id-fragment${command === "resume" ? "|recent" : ""}>`,
      );
      return;
    }
    await this.switchSession(name);
  }

  async createSessionFromName(name: string): Promise<void> {
    const state = this.context.uiStore.getState();
    const activeWorkspace = this.context.getActiveWorkspace() ?? this.context.getLaunchWorkspace();
    const launch = resolveOperatorStartTask({
      title: name,
      workspaceBinding: activeWorkspace !== undefined ? "active" : "detached",
      workspaceId: activeWorkspace?.manifest.workspaceId,
      workspaceLabel:
        activeWorkspace !== undefined ? describeResolvedWorkspace(activeWorkspace) : "Detached workspace",
      workspaceRoot: activeWorkspace?.rootPath,
      defaultProfileId: state.activeProfile.id,
      defaultProfileLabel: state.activeProfile.label,
      defaultInteractionMode: state.activeProfile.defaultInteractionMode,
      defaultActSubmode: state.activeProfile.defaultActSubmode,
      requireTitle: true,
    });
    await this.createSession({
      launch,
      profile: state.activeProfile,
      workspace: activeWorkspace,
    });
  }

  async createSession(options: CreateSessionOptions): Promise<void> {
    const state = this.context.uiStore.getState();
    const defaultSession = this.context.createSessionMeta(options.launch, options.profile, options.workspace);
    const createdWithEnvironment: TuiSessionMeta = {
      ...defaultSession,
      ...(options.environmentPresetId !== undefined
        ? { environmentPresetId: options.environmentPresetId }
        : {}),
    };
    const created: TuiSessionMeta = {
      ...createdWithEnvironment,
      operatorState: this.context.buildSessionOperatorState({
        session: createdWithEnvironment,
        profile: options.profile,
      }),
    };
    await this.context.commitCreatedSession(created);
    this.context.setActiveWorkspace(options.workspace);
    this.context.setLaunchWorkspace(options.workspace);

    const themeSelection = resolveThemeSelection({
      mode: state.themeMode,
      overrides: options.profile.theme,
    });
    this.context.uiStore.patch({
      activeProfile: options.profile,
      activeSession: created,
      sessions: this.context.getSessionsFile().sessions,
      transcript: [],
      runLogs: [],
      statusLine: this.context.withMcpSummary(`new session '${options.launch.title}'`),
      chatUnreadCount: 0,
      conversationActivity: [],
      lastSelectedSession: options.launch.title,
      sessionQuery: "",
      activeView: "chat",
      activeRegion: "composer",
      focusRegion: "composer",
      navigationStack: [],
      resolvedThemeMode: themeSelection.resolvedMode,
      themePreset: themeSelection.preset,
      theme: themeSelection.tokens,
      scroll: {
        ...state.scroll,
        chat: {
          offset: 0,
          cursor: 0,
          tailLocked: true,
        },
        logs: {
          ...state.scroll.logs,
          offset: 0,
          cursor: 0,
        },
        sessions: {
          ...state.scroll.sessions,
          offset: 0,
          cursor: 0,
        },
      },
      taskScroll: {
        offset: 0,
        cursor: 0,
        tailLocked: false,
      },
      detailDrawer: {
        ...state.detailDrawer,
        open: false,
        source: "chat",
      },
    });

    await this.context.appendHistoryLine("system", `Started new session '${options.launch.title}'.`);
    await this.context.appendHistoryLine(
      "system",
      `Agent: ${created.agentProfileLabel ?? options.profile.label}\nEnvironment: ${formatTuiEnvironmentLabel(created.environmentPresetId)}`,
    );
    await this.context.appendHistoryLine("system", formatOperatorLaunchSummary(options.launch));
    await this.context.persistUiState();
    if (options.launch.initialPrompt !== undefined) {
      const messageId = `tui:${randomUUID()}`;
      await this.context.appendHistoryLine("user", options.launch.initialPrompt, {
        kind: "tui.user-message.v1",
        messageId,
        deliveryState: "submitting",
      }, undefined, messageId);
      await this.context.startActiveTurn({
        messageId,
        submittedMessage: options.launch.initialPrompt,
      });
    }
  }

  async switchSession(name: string): Promise<void> {
    const resolution = name === "recent"
      ? undefined
      : this.context.sessionStore.resolveSelector(this.context.getSessionsFile(), name);
    const target = name === "recent"
      ? this.resolveRecentSessionTarget()
      : resolution?.status === "matched"
        ? resolution.session
        : undefined;
    if (target === undefined) {
      if (resolution?.status === "ambiguous") {
        await this.context.appendHistoryLine(
          "system",
          `Session id fragment '${name}' matched multiple sessions: ${formatSessionMatches(resolution.matches)}. Use the full session name or more of the session id.`,
        );
        return;
      }
      await this.context.appendHistoryLine(
        "system",
        name === "recent" ? "No recent session was available to resume." : `Session '${name}' not found.`,
      );
      return;
    }

    let resolvedTarget = target;
    if (hasDurableTuiRuntimeBinding(target)) {
      try {
        const describe = await this.context.client.sendCommand("session.describe", {
          sessionId: target.sessionId,
        });
        if (describe.type !== "session.described") {
          throw new TuiEnvironmentIdentityError(
            "TUI_ENVIRONMENT_UNKNOWN",
            `Environment unknown for session '${target.name}': runtime identity could not be described.`,
          );
        }
        if (describe.payload.sessionId !== target.sessionId) {
          throw new TuiEnvironmentIdentityError(
            "TUI_ENVIRONMENT_UNKNOWN",
            `Environment unknown for session '${target.name}': runtime described a different session.`,
          );
        }
        resolveTuiSessionEnvironment({
          session: target,
          runtimeEnvironmentPresetId: describe.payload.activeAssembly?.environmentPresetId,
          requireRuntimeIdentity: true,
        });
        await this.context.syncSessionFromDescribePayload(describe.payload);
        resolvedTarget = this.context.sessionStore.findByName(
          this.context.getSessionsFile(),
          target.name,
        ) ?? target;
      } catch (error) {
        if (error instanceof TuiEnvironmentIdentityError) {
          throw error;
        }
        const environmentFailure = readTuiEnvironmentIdentityFailure(error);
        if (environmentFailure !== undefined) {
          throw environmentFailure;
        }
        throw new TuiEnvironmentIdentityError(
          "TUI_ENVIRONMENT_UNKNOWN",
          `Environment unknown for session '${target.name}': runtime identity could not be verified.`,
        );
      }
    }

    const profiles = await this.context.profileStore.load();
    const startedSessionProfile = resolveStartedSessionAuthoringProfile({
      session: target,
      profiles,
      profileStore: this.context.profileStore,
    });
    const resolvedWorkspace = await this.context.resolveWorkspaceForSession(resolvedTarget);
    const profile =
      startedSessionProfile ??
      this.context.profileStore.findById(profiles, resolvedTarget.profileId) ??
      this.context.uiStore.getState().activeProfile;
    this.context.setActiveWorkspace(resolvedWorkspace);
    this.context.setSessionsFile(
      this.context.sessionStore.setActive(this.context.getSessionsFile(), resolvedTarget.name),
    );
    await this.context.saveSessionsFile();
    const transcript = await this.context.historyStore.readTranscript(resolvedTarget.sessionId);
    const state = this.context.uiStore.getState();
    const decoratedTarget: TuiSessionMeta = {
      ...resolvedTarget,
      operatorState: this.context.buildSessionOperatorState({
        session: resolvedTarget,
        profile,
      }),
    };
    this.context.setSessionsFile(this.context.sessionStore.upsert(this.context.getSessionsFile(), decoratedTarget));

    const themeSelection = resolveThemeSelection({
      mode: state.themeMode,
      overrides: profile.theme,
    });
    const conversationActivity = this.context.getConversationActivity(resolvedTarget.sessionId);
    const conversationRunState = this.context.getConversationRunState(resolvedTarget.sessionId);
    const latestActivity = conversationActivity.at(-1);
    this.context.uiStore.patch({
      activeProfile: profile,
      activeSession: decoratedTarget,
      sessions: this.context.getSessionsFile().sessions,
      transcript,
      runLogs: [],
      statusLine: this.context.withMcpSummary(
        latestActivity === undefined
          ? conversationRunState.status === "ready"
            ? `resumed '${resolvedTarget.name}'`
            : conversationRunState.status
          : `${latestActivity.label}: ${latestActivity.text}`,
      ),
      running: conversationRunState.running,
      chatUnreadCount: 0,
      conversationActivity,
      lastSelectedSession: resolvedTarget.name,
      sessionQuery: "",
      activeView: "chat",
      activeRegion: "chat_list",
      focusRegion: "chat_list",
      navigationStack: [],
      scroll: {
        ...state.scroll,
        chat: ensureChatCursorVisible(
          buildChatVisualRows(transcript, this.context.getChatWrappedBodyWidth()),
          {
            ...state.scroll.chat,
            cursor: Math.max(
              0,
              countChatVisualRows(transcript, this.context.getChatWrappedBodyWidth()) - 1,
            ),
            tailLocked: true,
          },
          this.context.getChatListRows(),
        ),
        logs: {
          ...state.scroll.logs,
          offset: 0,
          cursor: 0,
        },
      },
      taskScroll: {
        offset: 0,
        cursor: 0,
        tailLocked: false,
      },
      detailDrawer: {
        ...state.detailDrawer,
        open: false,
        source: "chat",
      },
      resolvedThemeMode: themeSelection.resolvedMode,
      themePreset: themeSelection.preset,
      theme: themeSelection.tokens,
    });

    await this.context.recoverTerminalMessages(decoratedTarget).catch(() => {
      // Recovery diagnostics are durable and the existing transcript remains usable.
    });

    await this.context.appendHistoryLine("system", `Resumed session '${resolvedTarget.name}'.`);
    await this.context.persistUiState();
  }

  resolveRecentSessionTarget(): TuiSessionMeta | undefined {
    const state = this.context.uiStore.getState();
    const target = pickResumeTarget(
      this.context.getSessionsFile().sessions.map((session) => ({
        id: session.sessionId,
        title: session.name,
        updatedAt: session.updatedAt,
        interactionMode: session.interactionMode,
        actSubmode: session.actSubmode,
        pendingWaitEventType: session.pendingWaitFor?.eventType,
        lastRunStatus: session.lastRunStatus,
        lastPreview: session.lastMessagePreview,
        isActive: session.sessionId === state.activeSession.sessionId,
      })),
    );
    if (target === undefined) {
      return ;
    }
    return this.context.getSessionsFile().sessions.find((session) => session.sessionId === target.id);
  }
}

function formatSessionMatches(matches: TuiSessionMeta[]): string {
  return matches
    .slice(0, 5)
    .map((session) => `${session.name} (${session.sessionId})`)
    .join(", ");
}

export function formatTuiSessionMode(session: Pick<TuiSessionMeta, "interactionMode" | "actSubmode">): string {
  return formatUserFacingModeLabel({
    interactionMode: session.interactionMode ?? DEFAULT_INTERACTION_MODE,
    actSubmode: session.actSubmode ?? DEFAULT_ACT_SUBMODE,
  });
}
