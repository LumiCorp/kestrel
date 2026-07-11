import type { AppView, ResolvedWorkspace } from "../contracts.js";
import { buildStaticPaletteActions } from "./TuiCommandInventory.js";
import type { PaletteAction } from "../ink/overlays/CommandPalette.js";
import type { UiRuntimeState } from "../ink/store/UiStore.js";
import type { createUiDerivedSelectors } from "../ink/store/selectors.js";
import { listThemeModes } from "../ink/theme/tokens.js";
import {
  listOperatorProfilePresets,
  listOperatorTaskTemplates,
  pickResumeTarget,
  rankOperatorJourneys,
} from "../../src/operatorShell.js";
import { listSkillPacks } from "../runtime/skillPacks.js";
import { describeResolvedWorkspace } from "../workspace/WorkspaceResolver.js";

const SESSION_PALETTE_ACTION_LIMIT = 12;

export interface PaletteCommand {
  id: PaletteAction["id"];
  label: PaletteAction["label"];
  detail?: PaletteAction["detail"];
  command?: string | undefined;
  draft?: string | undefined;
}

export interface PaletteStartTaskJourney {
  availableWorkspaces: ResolvedWorkspace[];
}

export interface PaletteControllerContext {
  selectors: ReturnType<typeof createUiDerivedSelectors>;
  getState(): UiRuntimeState;
  getStartTaskJourney(): PaletteStartTaskJourney | undefined;
  getActiveWorkspace(): ResolvedWorkspace | undefined;
  patchState(next: Partial<UiRuntimeState>): void;
  handleStartTaskPaletteSelection(selected: PaletteCommand): Promise<boolean>;
  navigateToView(view: AppView, options?: { remember?: boolean | undefined }): void;
  jumpChatToLatest(): void;
  jumpChatToHighlightedRun(): void;
  submitInput(command: string): void;
}

export class PaletteController {
  private readonly context: PaletteControllerContext;

  constructor(context: PaletteControllerContext) {
    this.context = context;
  }

  getFilteredActions(state = this.context.getState()): PaletteCommand[] {
    const commands = this.getActions(state);
    const maxItems = state.layoutProfile === "narrow" ? 8 : 14;
    return this.context.selectors.filterPaletteActions(
      commands,
      state.paletteQuery,
      maxItems,
    ) as PaletteCommand[];
  }

  getTotalCount(state = this.context.getState()): number {
    return this.getActions(state).length;
  }

  getActions(state = this.context.getState()): PaletteCommand[] {
    if (state.paletteContext !== undefined) {
      return this.buildStartTaskPaletteActions(state.paletteContext);
    }
    return buildPaletteActions(state);
  }

  activate(selected: PaletteCommand, state = this.context.getState()): void {
    if (state.paletteContext !== undefined && selected.id.startsWith("start.")) {
      void this.context.handleStartTaskPaletteSelection(selected);
      return;
    }

    if (selected.id.startsWith("view.")) {
      const view = selected.id.replace("view.", "") as AppView;
      this.context.navigateToView(view, { remember: true });
      this.context.patchState({
        paletteOpen: false,
        paletteSource: undefined,
        paletteContext: undefined,
        paletteQuery: "",
        paletteSelectedIndex: 0,
      });
      return;
    }

    if (selected.id === "chat.jump.latest") {
      this.context.jumpChatToLatest();
      return;
    }

    if (selected.id === "chat.jump.highlight") {
      this.context.jumpChatToHighlightedRun();
      return;
    }

    if (selected.draft !== undefined) {
      this.context.patchState({
        chatDraft: selected.draft,
        paletteOpen: false,
        paletteSource: undefined,
        paletteContext: undefined,
        paletteQuery: "",
        paletteSelectedIndex: 0,
        commandBarReturnRegion: undefined,
        activeView: "chat",
        activeRegion: "composer",
        focusRegion: "composer",
        navigationStack: [],
      });
      return;
    }

    if (selected.command !== undefined) {
      this.context.submitInput(selected.command);
      this.context.patchState({
        paletteOpen: false,
        paletteSource: undefined,
        paletteContext: undefined,
        paletteQuery: "",
        paletteSelectedIndex: 0,
        paletteRecentCommands: [...state.paletteRecentCommands, selected.command].slice(-25),
        commandBarReturnRegion: undefined,
        activeView: "chat",
        activeRegion: "composer",
        focusRegion: "composer",
        navigationStack: [],
      });
    }
  }

  private buildStartTaskPaletteActions(
    context: NonNullable<UiRuntimeState["paletteContext"]>,
  ): PaletteCommand[] {
    const journey = this.context.getStartTaskJourney();
    if (journey === undefined) {
      return [
        { id: "start.cancel", label: "Cancel start task", detail: "Exit the launcher" },
      ];
    }
    if (context === "start-template") {
      const templateActions = listOperatorTaskTemplates().map((template) => ({
        id: `start.template.${template.id}`,
        label: `Template: ${template.label}`,
        detail: template.description,
      }));
      return [
        { id: "start.template.none", label: "Template: None", detail: "Start without a template" },
        ...templateActions,
        { id: "start.cancel", label: "Cancel start task", detail: "Exit the launcher" },
      ];
    }
    if (context === "start-preset") {
      const presetActions = listOperatorProfilePresets().map((preset) => ({
        id: `start.preset.${preset.id}`,
        label: `Preset: ${preset.label}`,
        detail: preset.description,
      }));
      return [
        { id: "start.preset.none", label: "Preset: None", detail: "Use profile defaults without preset override" },
        ...presetActions,
        { id: "start.cancel", label: "Cancel start task", detail: "Exit the launcher" },
      ];
    }
    const workspaceActions = journey.availableWorkspaces.map((workspace, index) => ({
      id: `start.workspace.idx-${index}`,
      label: `Workspace: ${workspace.manifest.workspaceId}`,
      detail: workspace.rootPath,
    }));
    return [
      {
        id: "start.workspace.active",
        label: `Workspace: Active (${describeResolvedWorkspace(this.context.getActiveWorkspace())})`,
        detail: "Use the currently active workspace binding",
      },
      { id: "start.workspace.detached", label: "Workspace: Detached", detail: "Do not bind a workspace" },
      ...workspaceActions,
      { id: "start.cancel", label: "Cancel start task", detail: "Exit the launcher" },
    ];
  }
}

export function buildPaletteActions(
  state: Pick<
    UiRuntimeState,
    | "activeView"
    | "paletteSource"
    | "paletteQuery"
    | "activeProfile"
    | "activeSession"
    | "sessions"
    | "themeMode"
    | "scroll"
    | "chatUnreadCount"
    | "chatHighlightRunId"
  >,
  nowMs = Date.now(),
): PaletteCommand[] {
  const sessionJourneys = rankOperatorJourneys(
    state.sessions.map((session) => ({
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
    4,
  );
  const resumeTarget = pickResumeTarget(
    state.sessions.map((session) => ({
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
  const sessionActions = [...state.sessions]
    .filter((session) => session.name !== state.activeSession.name)
    .sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt.localeCompare(left.updatedAt);
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, SESSION_PALETTE_ACTION_LIMIT)
    .map((session) => ({
      id: `session.switch.${session.sessionId}`,
      label: `Switch session: ${session.name}`,
      detail: "Jump to this conversation",
      command: `/switch ${session.name}`,
    }));
  const chatActions: PaletteCommand[] = [];
  if (state.scroll.chat.tailLocked === false || (state.chatUnreadCount ?? 0) > 0) {
    chatActions.push({
      id: "chat.jump.latest",
      label: "Jump to live tail",
      detail:
        (state.chatUnreadCount ?? 0) > 0
          ? `Return to the newest reply and clear ${state.chatUnreadCount ?? 0} unread rows`
          : "Return to the newest reply",
    });
  }
  if (state.chatHighlightRunId !== undefined) {
    chatActions.push({
      id: "chat.jump.highlight",
      label: `Jump to highlighted run: ${state.chatHighlightRunId.slice(0, 10)}`,
      detail: "Move chat selection to the highlighted run in the transcript",
    });
  }
  const taskSessions = state.sessions
    .filter((session) => session.delegation?.parentSessionId === state.activeSession.sessionId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const taskActions = taskSessions.map((session) => ({
    id: `cmd.tasks.open.${session.sessionId}`,
    label: `Open task: ${session.name}`,
    detail: "Jump to a delegated child task session",
    command: `/tasks open ${session.name}`,
  }));
  const mcpServerActions = (state.activeProfile.mcpServers ?? []).map((server) => ({
    id: `cmd.mcp.remove.${server.id}`,
    label: `Remove MCP server: ${server.id}`,
    detail: "Remove a configured MCP server",
    command: `/mcp remove ${server.id}`,
  }));
  const includeSlashCatalog =
    state.paletteSource === "slash" ||
    state.paletteQuery.trim().startsWith("/");
  const staticCommands = includeSlashCatalog ? buildStaticPaletteActions(nowMs) : [];
  const journeyActions: PaletteCommand[] = [
    {
      id: "journey.start.task",
      label: "Start guided task launch",
      detail: `Choose title, profile, and mode before creating a session in ${state.activeProfile.id}`,
      command: "/start",
    },
    ...(resumeTarget !== undefined
      ? [
          {
            id: "journey.resume.recent",
            label: resumeTarget.recommendedLabel,
            detail: `${resumeTarget.title} · ${resumeTarget.detail}`,
            command: "/resume recent",
          },
        ]
      : []),
    {
      id: "journey.inspect.status",
      label: "Inspect operator status",
      detail: "Show shared runner, wait, and MCP state",
      command: "/status",
    },
  ];
  const recentJourneyActions: PaletteCommand[] = sessionJourneys
    .filter((session) => session.isActive === false)
    .map((session) => ({
      id: `journey.session.${session.id}`,
      label: `${session.recommendedLabel}: ${session.title}`,
      detail: `${session.modeLabel} · ${session.detail}`,
      command: `/switch ${session.title}`,
    }));
  const skillActions = listSkillPacks().map((skill) => ({
    id: `cmd.skill.use.${skill.id}`,
    label: `Use skill pack: ${skill.id}`,
    detail: skill.label,
    command: `/skill use ${skill.id}`,
  }));

  return [
    { id: "view.chat", label: "Go to Chat", detail: "Open chat screen" },
    { id: "view.history", label: "Go to History Home", detail: "Browse resumable work, launch summaries, and restart points" },
    { id: "view.sessions", label: "Go to Sessions", detail: "Browse sessions" },
    { id: "view.tasks", label: "Go to Tasks", detail: "Open the task inbox" },
    { id: "view.logs", label: "Go to Activity Feed", detail: "Inspect runtime activity" },
    ...journeyActions,
    ...chatActions,
    ...recentJourneyActions,
    ...skillActions,
    ...taskActions,
    ...mcpServerActions,
    ...listThemeModes().map((mode) => ({
      id: `theme.mode.${mode}`,
      label: `${mode === state.themeMode ? "Theme active:" : "Theme:"} ${mode}`,
      detail: "Switch cockpit color mode",
      command: `/theme ${mode}`,
    })),
    ...sessionActions,
    ...(state.activeSession.pendingWaitFor !== undefined
      ? [
          {
            id: "cmd.resume",
            label: `/resume ${state.activeSession.name}`,
            detail: "Resume the active waiting session",
            command: `/resume ${state.activeSession.name}`,
          },
        ]
      : []),
    ...staticCommands,
  ];
}
