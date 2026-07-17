import type { ResolvedWorkspace, TuiProfile, TuiSessionMeta } from "../contracts.js";
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

export interface CreateSessionOptions {
  launch: OperatorResolvedStartTask;
  profile: TuiProfile;
  workspace?: ResolvedWorkspace | undefined;
}

export interface SessionControllerContext extends TuiAppContext {
  saveSessionsFile(): Promise<void>;
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
    submittedMessage: string;
    resumeBlockedRun?: boolean | undefined;
  }): Promise<void>;
  getChatWrappedBodyWidth(): number;
  getChatListRows(): number;
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
      return `${session.name}${active} -> ${session.sessionId} mode:${mode}${waiting}${runStatus}`;
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
    const created = this.context.createSessionMeta(options.launch, options.profile, options.workspace);
    this.context.setSessionsFile(this.context.sessionStore.upsert(this.context.getSessionsFile(), created));
    await this.context.saveSessionsFile();

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
      activeProgressByRun: {},
      latestProgressForSession: undefined,
      latestReasoningForSession: undefined,
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
    await this.context.appendHistoryLine("system", formatOperatorLaunchSummary(options.launch));
    await this.context.persistUiState();
    if (options.launch.initialPrompt !== undefined) {
      await this.context.appendHistoryLine("user", options.launch.initialPrompt);
      await this.context.startActiveTurn({
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

    const profiles = await this.context.profileStore.load();
    const resolvedWorkspace = await this.context.resolveWorkspaceForSession(target);
    const profile =
      this.context.profileStore.findById(profiles, target.profileId) ??
      this.context.uiStore.getState().activeProfile;
    this.context.setActiveWorkspace(resolvedWorkspace);
    this.context.setSessionsFile(this.context.sessionStore.setActive(this.context.getSessionsFile(), target.name));
    await this.context.saveSessionsFile();
    const transcript = await this.context.historyStore.readTranscript(target.sessionId);
    const state = this.context.uiStore.getState();
    const decoratedTarget: TuiSessionMeta = {
      ...target,
      operatorState: this.context.buildSessionOperatorState({
        session: target,
        profile,
      }),
    };
    this.context.setSessionsFile(this.context.sessionStore.upsert(this.context.getSessionsFile(), decoratedTarget));

    const themeSelection = resolveThemeSelection({
      mode: state.themeMode,
      overrides: profile.theme,
    });
    this.context.uiStore.patch({
      activeProfile: profile,
      activeSession: decoratedTarget,
      sessions: this.context.getSessionsFile().sessions,
      transcript,
      runLogs: [],
      statusLine: this.context.withMcpSummary(`resumed '${target.name}'`),
      chatUnreadCount: 0,
      activeProgressByRun: {},
      latestProgressForSession: undefined,
      latestReasoningForSession: undefined,
      lastSelectedSession: target.name,
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

    try {
      const describe = await this.context.client.sendCommand("session.describe", {
        sessionId: decoratedTarget.sessionId,
      });
      if (describe.type === "session.described") {
        await this.context.syncSessionFromDescribePayload(describe.payload);
      }
    } catch {
      // Session switching should remain usable if the runner is not ready yet.
    }

    await this.context.appendHistoryLine("system", `Resumed session '${target.name}'.`);
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
