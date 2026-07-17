import type React from "react";
import { useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useSyncExternalStore } from "react";

import { setActiveTheme, theme } from "./theme/tokens.js";
import { ThemedTextInput } from "./components/ThemedTextInput.js";
import {
  derivePaneRowCounts,
  type FocusRegion,
  type UiRuntimeState,
} from "./store/UiStore.js";
import { ChatView } from "./views/ChatView.js";
import { CodeWorkspaceView } from "./views/CodeWorkspaceView.js";
import { DelegationReviewView } from "./views/DelegationReviewView.js";
import { HistoryHomeView } from "./views/HistoryHomeView.js";
import { LogsView } from "./views/LogsView.js";
import { McpWorkspaceView } from "./views/McpWorkspaceView.js";
import { RecoveryCenterView } from "./views/RecoveryCenterView.js";
import { SessionsView } from "./views/SessionsView.js";
import { TasksView } from "./views/TasksView.js";
import { WorkspaceView } from "./views/WorkspaceView.js";
import { CommandPalette, type PaletteAction } from "./overlays/CommandPalette.js";
import { HelpOverlay } from "./overlays/HelpOverlay.js";
import { ErrorOverlay } from "./overlays/ErrorOverlay.js";
import { SplashGate } from "./splash/SplashGate.js";
import { ActiveViewHost } from "./ActiveViewHost.js";
import {
  isComposerSoftLineBreakKeypress,
  resolveSplashInputAction,
} from "./inputActions.js";
import { dispatchAppInput } from "./inputDispatcher.js";
import { truncate } from "./ui/format.js";
import {
  buildOperatorCodeWorkspace,
  buildOperatorDelegationWorkspace,
  buildOperatorHistoryHome,
  buildOperatorHistoryNextActions,
  buildOperatorMcpWorkspace,
  buildOperatorRecoveryCenter,
  buildOperatorWorkspaceJourney,
} from "../../src/operatorShell.js";

export interface InkAppController {
  getState: () => UiRuntimeState;
  subscribe: (listener: () => void) => () => void;
  getPaletteActions: () => PaletteAction[];
  getPaletteTotalCount: () => number;
  updateViewport: (columns: number, rows: number) => void;
  cycleFocus: (reverse: boolean) => void;
  setActiveRegion: (region: FocusRegion) => void;
  openContextSearch: () => void;
  openSlashPalette: () => void;
  closeContextSearch: () => void;
  moveActiveSelection: (delta: number) => void;
  pageActiveSelection: (direction: "up" | "down") => void;
  jumpActiveSelection: (to: "start" | "end") => void;
  activatePrimaryAction: () => void;
  goBack: () => void;
  submitLine: (line: string) => void;
  setDraft: (value: string) => void;
  appendDraftLineBreak: () => void;
  clearDraft: () => void;
  dismissSplash: () => void;
  toggleDetailDrawer: () => void;
  toggleHelp: () => void;
  openPalette: () => void;
  closePalette: () => void;
  focusComposerWithInput: (input: string) => void;
  setPaletteQuery: (value: string) => void;
  movePaletteSelection: (delta: number) => void;
  executePaletteSelection: () => void;
  toggleErrorDetails: () => void;
  moveErrorScroll: (delta: number) => void;
  pageErrorScroll: (direction: "up" | "down") => void;
  jumpErrorScroll: (to: "start" | "end") => void;
  toggleLogsPause: () => void;
  toggleLogsGrouped: () => void;
  cycleLogLevel: () => void;
  setLogEventQuery: (value: string) => void;
  setSessionQuery: (value: string) => void;
  createSession: () => void;
  dismissError: () => void;
  requestQuit: () => void;
  confirmQuit: () => void;
}

interface AppRootProps {
  controller: InkAppController;
}

export function AppRoot(props: AppRootProps): React.JSX.Element {
  const state = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getState,
    props.controller.getState,
  );
  setActiveTheme(state.theme);

  useEffect(() => {
    const applyViewport = () => {
      const columns = typeof process.stdout.columns === "number" ? process.stdout.columns : 120;
      const rows = typeof process.stdout.rows === "number" ? process.stdout.rows : 40;
      props.controller.updateViewport(columns, rows);
    };
    applyViewport();
    process.stdout.on("resize", applyViewport);
    return () => {
      process.stdout.off("resize", applyViewport);
    };
  }, [props.controller]);

  useInput((input, key) => {
    dispatchAppInput({
      state,
      controller: props.controller,
      input,
      key,
    });
  });

  const rowCounts = derivePaneRowCounts(state);
  const paletteActions = props.controller.getPaletteActions();
  const paletteTotalCount = props.controller.getPaletteTotalCount();
  const errorOverlayOpen = state.errorOverlay !== undefined;

  return (
    <Box
      flexDirection="column"
      width={state.viewport.columns}
      height={state.viewport.rows}
      backgroundColor={theme.bg}
    >
      {state.splashVisible ? (
        <SplashGate
          visible
          onDismiss={props.controller.dismissSplash}
          preflight={state.splashPreflight}
        />
      ) : null}
      {state.splashVisible ? null : (
        <Box
          flexDirection="column"
          width={state.viewport.columns}
          height={state.viewport.rows}
          backgroundColor={theme.bg}
        >
          <TopHeader state={state} />
          <ActiveViewHost
            state={state}
            controller={props.controller}
            rowCounts={rowCounts}
            renderers={{
              chat: () => <ChatScreen state={state} controller={props.controller} />,
              logs: (listRows) => <LogsScreen state={state} controller={props.controller} listRows={listRows} />,
              sessions: (listRows) => <SessionsScreen state={state} controller={props.controller} listRows={listRows} />,
              tasks: (listRows) => <TasksScreen state={state} listRows={listRows} />,
              history: (listRows) => <HistoryScreen state={state} controller={props.controller} listRows={listRows} />,
              workspace: (listRows) => <WorkspaceScreen state={state} listRows={listRows} />,
              mcp: (listRows) => <McpWorkspaceScreen state={state} listRows={listRows} />,
              code: (listRows) => <CodeWorkspaceScreen state={state} listRows={listRows} />,
              delegation: (listRows) => <DelegationReviewScreen state={state} listRows={listRows} />,
              recovery: (listRows) => <RecoveryCenterScreen state={state} listRows={listRows} />,
            }}
          />
        </Box>
      )}

      {state.splashVisible || errorOverlayOpen ? null : (
        <CommandPalette
          open={state.paletteOpen}
          layoutProfile={state.layoutProfile}
          title={state.paletteSource === "slash" ? "Slash Commands" : "Command Palette"}
          placeholder={state.paletteSource === "slash" ? "Type a slash command..." : "Find action..."}
          query={state.paletteQuery}
          selectedIndex={state.paletteSelectedIndex}
          actions={paletteActions}
          totalCount={paletteTotalCount}
          onChangeQuery={(value) => {
            props.controller.setPaletteQuery(value);
          }}
          onClose={() => {
            props.controller.closePalette();
          }}
        />
      )}

      {state.splashVisible || errorOverlayOpen ? null : (
        <HelpOverlay
          open={state.helpOpen}
          layoutProfile={state.layoutProfile}
        />
      )}

      <ErrorOverlay
        error={state.errorOverlay}
        layoutProfile={state.layoutProfile}
        expanded={state.errorDetailsExpanded}
        scrollOffset={state.errorScrollOffset}
        viewportRows={state.viewport.rows}
        viewportColumns={state.viewport.columns}
      />
    </Box>
  );
}

export { isComposerSoftLineBreakKeypress, resolveSplashInputAction };

function TopHeader(props: { state: UiRuntimeState }): React.JSX.Element {
  const left = `${props.state.activeSession.name} · ${labelForView(props.state.activeView)}`;
  const right = `${formatSessionModeBadge(props.state)} · ${chipForState(props.state)}`;
  const maxLeft = Math.max(18, Math.floor(props.state.viewport.columns * 0.5));
  const maxRight = Math.max(18, Math.floor(props.state.viewport.columns * 0.42));
  return (
    <Box
      marginBottom={0}
      justifyContent="space-between"
      paddingX={1}
      width={props.state.viewport.columns}
      backgroundColor={theme.brand}
    >
      <Text color={theme.brandAlt} backgroundColor={theme.brand} bold>
        {truncate(left, maxLeft)}
      </Text>
      <Text color={theme.brandAlt} backgroundColor={theme.brand}>
        {truncate(right, maxRight)}
      </Text>
    </Box>
  );
}

function chipForState(state: UiRuntimeState): string {
  if (state.running) {
    return "RUNNING";
  }
  const waitingEventType = readSessionWaitingEventType(state);
  if (waitingEventType !== undefined) {
    return `WAITING:${waitingEventType}`;
  }
  if (state.errorOverlay?.code) {
    return `FAILED:${state.errorOverlay.code}`;
  }
  const [base] = state.statusLine.split("|");
  return (base ?? state.statusLine).trim().toUpperCase();
}

function readSessionWaitingEventType(state: UiRuntimeState): string | undefined {
  const pending = state.activeSession.pendingWaitFor?.eventType;
  if (pending !== undefined) {
    return pending;
  }
  if (state.activeSession.operatorState?.childBlocker !== undefined) {
    return "delegation";
  }
  if (state.activeSession.operatorState?.wait?.eventType !== undefined) {
    return state.activeSession.operatorState.wait.eventType;
  }
  if ((state.activeSession.operatorState?.inbox?.approvals ?? 0) > 0) {
    return "user.approval";
  }
  if ((state.activeSession.operatorState?.inbox?.userInputs ?? 0) > 0) {
    return "user.reply";
  }
  return ;
}

function labelForView(view: UiRuntimeState["activeView"]): string {
  if (view === "history") {
    return "HISTORY";
  }
  if (view === "sessions") {
    return "SESSIONS";
  }
  if (view === "tasks") {
    return "TASKS";
  }
  if (view === "logs") {
    return "ACTIVITY";
  }
  if (view === "mcp") {
    return "MCP";
  }
  if (view === "code") {
    return "CODE";
  }
  if (view === "delegation") {
    return "DELEGATION";
  }
  if (view === "recovery") {
    return "RECOVERY";
  }
  if (view === "workspace") {
    return "WORKSPACE";
  }
  return "CHAT";
}

function formatSessionModeBadge(state: UiRuntimeState): string {
  const interactionMode = state.activeSession.interactionMode ?? "plan";
  const route = readLastExecutionLane(state);
  const modeLabel = `mode=${interactionMode}`;
  const assemblySummary = readAssemblyRuntimeSummary(state.activeSession.operatorState?.assembly);
  if (route !== undefined && assemblySummary !== undefined) {
    return `${modeLabel} route=${route} ${assemblySummary}`;
  }
  if (route !== undefined) {
    return `${modeLabel} route=${route}`;
  }
  return assemblySummary !== undefined ? `${modeLabel} ${assemblySummary}` : modeLabel;
}

function readLastExecutionLane(state: UiRuntimeState): string | undefined {
  for (let index = state.runLogs.length - 1; index >= 0; index -= 1) {
    const entry = state.runLogs[index];
    if (entry?.eventName !== "route_decision") {
      continue;
    }
    const route = readString(entry.metadata, "executionLane") ?? readString(entry.metadata, "selectedLane");
    if (route !== undefined) {
      return route;
    }
  }
  return ;
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readAssemblyRuntimeSummary(
  assembly: NonNullable<UiRuntimeState["activeSession"]["operatorState"]>["assembly"] | undefined,
): string | undefined {
  if (assembly === undefined) {
    return ;
  }
  const parts: string[] = [];
  if (assembly.provider !== undefined) {
    parts.push(`provider=${assembly.provider.id}/${assembly.provider.model}`);
  }
  if (assembly.provider?.promptVariant !== undefined) {
    parts.push(`variant=${assembly.provider.promptVariant}`);
  }
  if (assembly.compatibility?.status !== undefined) {
    parts.push(`compat=${assembly.compatibility.status}`);
  }
  if (assembly.compatibility?.downgradeReason !== undefined) {
    parts.push(`downgrade=${assembly.compatibility.downgradeReason}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function DelegationReviewScreen(props: {
  state: UiRuntimeState;
  listRows: number;
}): React.JSX.Element {
  const operatorState = props.state.activeSession.operatorState;
  const snapshot = buildOperatorDelegationWorkspace({
    sessionTitle: props.state.activeSession.name,
    profileLabel: props.state.activeProfile.label,
    workspaceLabel: props.state.activeSession.workspaceLabel,
    interactionMode: props.state.activeSession.interactionMode,
    actSubmode: props.state.activeSession.actSubmode,
    pendingWaitEventType: props.state.activeSession.pendingWaitFor?.eventType,
    lastRunStatus: props.state.activeSession.lastRunStatus,
    isActive: true,
    delegation: operatorState === undefined
      ? undefined
      : {
          childThreads: (operatorState.childThreads ?? []).map((child) => ({
            threadId: child.threadId,
            title: child.title,
            status: child.status,
            ...(child.waitEventType !== undefined ? { waitEventType: child.waitEventType } : {}),
            ...(child.errorMessage !== undefined ? { reason: child.errorMessage } : {}),
            ...(child.result !== undefined ? { result: child.result } : {}),
            ...(child.errorCode !== undefined ? { errorCode: child.errorCode } : {}),
            ...(child.references !== undefined ? { references: child.references } : {}),
          })),
          childOutcomes: (operatorState.childThreads ?? [])
            .filter((child) => child.outcomeSummary !== undefined || child.errorMessage !== undefined)
            .map((child) => ({
              threadId: child.threadId,
              title: child.title,
              status: child.delegationStatus ?? child.status,
              ...(child.result !== undefined ? { result: child.result } : {}),
              summary: child.outcomeSummary ?? child.errorMessage,
              ...(child.errorCode !== undefined ? { errorCode: child.errorCode } : {}),
              ...(child.references !== undefined ? { references: child.references } : {}),
            })),
          nextActionKind: operatorState.supervision?.nextAction,
          nextActionSummary: operatorState.nextAction,
          blockerSummary: operatorState.dominantBlocker ?? operatorState.blockReason?.summary,
          childBlockerReason: operatorState.childBlocker?.reason,
          fanInDisposition: operatorState.latestFanInDisposition === undefined
            ? undefined
            : {
                status: operatorState.latestFanInDisposition.status,
                ...(operatorState.latestFanInDisposition.checkpointId !== undefined
                  ? { checkpointId: operatorState.latestFanInDisposition.checkpointId }
                  : {}),
              ...(operatorState.latestFanInDisposition.summary !== undefined
                  ? { summary: operatorState.latestFanInDisposition.summary }
                  : {}),
              },
          inboxChildBlockers: operatorState.inbox?.childBlockers,
          missionDraft: undefined,
        },
  });
  const snapshotWithBack = applyStackAwareBackLabel(snapshot, props.state.navigationStack);
  return (
    <DelegationReviewView
      snapshot={snapshotWithBack}
      scroll={props.state.scroll.sessions}
      listRows={props.listRows}
      detailDrawerOpen={props.state.detailDrawer.open && props.state.detailDrawer.source === "delegation" && props.state.activeRegion === "details"}
    />
  );
}

function RecoveryCenterScreen(props: {
  state: UiRuntimeState;
  listRows: number;
}): React.JSX.Element {
  const operatorState = props.state.activeSession.operatorState;
  const snapshot = buildOperatorRecoveryCenter({
    sessionTitle: props.state.activeSession.name,
    profileLabel: props.state.activeProfile.label,
    workspaceLabel: props.state.activeSession.workspaceLabel,
    workspaceRoot: props.state.activeSession.workspaceRoot,
    interactionMode: props.state.activeSession.interactionMode,
    actSubmode: props.state.activeSession.actSubmode,
    pendingWaitEventType: props.state.activeSession.pendingWaitFor?.eventType,
    lastRunStatus: props.state.activeSession.lastRunStatus,
    isActive: true,
    recovery: operatorState === undefined
      ? undefined
      : {
          latestCheckpoint: operatorState.latestCheckpoint === undefined
            ? undefined
            : {
                checkpointId: operatorState.latestCheckpoint.checkpointId,
                status: operatorState.latestCheckpoint.status,
                recommendedAction: operatorState.latestCheckpoint.recommendedAction,
                reason: operatorState.latestCheckpoint.reason,
              },
          fanInDisposition: operatorState.latestFanInDisposition === undefined
            ? undefined
            : {
                status: operatorState.latestFanInDisposition.status,
                ...(operatorState.latestFanInDisposition.checkpointId !== undefined
                  ? { checkpointId: operatorState.latestFanInDisposition.checkpointId }
                  : {}),
                ...(operatorState.latestFanInDisposition.summary !== undefined
                  ? { summary: operatorState.latestFanInDisposition.summary }
                  : {}),
                ...(operatorState.latestFanInDisposition.at !== undefined
                  ? { at: operatorState.latestFanInDisposition.at }
                  : {}),
              },
          blockerSummary: operatorState.blockReason?.summary,
          activeWaitDetail: operatorState.wait?.prompt ?? operatorState.wait?.eventType,
          contextPosture: operatorState.contextPosture,
          latestReasoningMessage: operatorState.latestReasoning?.message,
          latestSteeringMessage: operatorState.latestSteering?.message,
          latestEvidenceIssues: operatorState.latestEvidenceRecovery?.latestIssues,
          latestEvidenceTerminalOutcome: operatorState.latestEvidenceRecovery?.terminalOutcome,
          latestPreview: props.state.activeSession.launchSummary ?? props.state.activeSession.lastMessagePreview,
          childOutcomes: (operatorState.childThreads ?? [])
            .map((child) => child.outcomeSummary ?? child.errorMessage)
            .filter((value): value is string => typeof value === "string" && value.length > 0),
        },
    checkpoints: props.state.workspaceCheckpoints,
  });
  const snapshotWithBack = applyStackAwareBackLabel(snapshot, props.state.navigationStack);
  return (
    <RecoveryCenterView
      snapshot={snapshotWithBack}
      scroll={props.state.scroll.sessions}
      listRows={props.listRows}
      detailDrawerOpen={props.state.detailDrawer.open && props.state.detailDrawer.source === "recovery" && props.state.activeRegion === "details"}
    />
  );
}

function McpWorkspaceScreen(props: {
  state: UiRuntimeState;
  listRows: number;
}): React.JSX.Element {
  const snapshot = buildOperatorMcpWorkspace({
    sessionTitle: props.state.activeSession.name,
    profileLabel: props.state.activeProfile.label,
    workspaceLabel: props.state.activeSession.workspaceLabel,
    interactionMode: props.state.activeSession.interactionMode,
    actSubmode: props.state.activeSession.actSubmode,
    pendingWaitEventType: props.state.activeSession.pendingWaitFor?.eventType,
    lastRunStatus: props.state.activeSession.lastRunStatus,
    isActive: true,
    status: props.state.mcpStatus,
  });
  const snapshotWithBack = applyStackAwareBackLabel(snapshot, props.state.navigationStack);
  return (
    <McpWorkspaceView
      snapshot={snapshotWithBack}
      scroll={props.state.scroll.sessions}
      listRows={props.listRows}
      detailDrawerOpen={props.state.detailDrawer.open && props.state.detailDrawer.source === "mcp" && props.state.activeRegion === "details"}
    />
  );
}

function CodeWorkspaceScreen(props: {
  state: UiRuntimeState;
  listRows: number;
}): React.JSX.Element {
  const snapshot = buildOperatorCodeWorkspace({
    sessionTitle: props.state.activeSession.name,
    profileLabel: props.state.activeProfile.label,
    workspaceLabel: props.state.activeSession.workspaceLabel,
    interactionMode: props.state.activeSession.interactionMode,
    actSubmode: props.state.activeSession.actSubmode,
    pendingWaitEventType: props.state.activeSession.pendingWaitFor?.eventType,
    lastRunStatus: props.state.activeSession.lastRunStatus,
    isActive: true,
    codeMode: props.state.activeProfile.codeMode,
    latestHint: props.state.activeSession.launchSummary ?? props.state.activeSession.lastMessagePreview,
    hasArtifacts: props.state.activeSession.hasArtifacts,
    hasSummary: props.state.activeSession.hasSummary,
  });
  const snapshotWithBack = applyStackAwareBackLabel(snapshot, props.state.navigationStack);
  return (
    <CodeWorkspaceView
      snapshot={snapshotWithBack}
      scroll={props.state.scroll.sessions}
      listRows={props.listRows}
      detailDrawerOpen={props.state.detailDrawer.open && props.state.detailDrawer.source === "code" && props.state.activeRegion === "details"}
    />
  );
}

function WorkspaceScreen(props: {
  state: UiRuntimeState;
  listRows: number;
}): React.JSX.Element {
  const discovered = props.state.sessions
    .filter((session) => session.workspaceId !== undefined || session.workspaceRoot !== undefined)
    .map((session) => ({
      workspaceId: session.workspaceId,
      label: session.workspaceLabel ?? session.workspaceId ?? session.workspaceRoot ?? "Workspace",
      rootPath: session.workspaceRoot,
      isCurrentBinding: session.sessionId === props.state.activeSession.sessionId,
      isLaunchWorkspace:
        props.state.activeSession.workspaceId !== undefined &&
        props.state.activeSession.workspaceId === session.workspaceId,
    }));
  const seenWorkspace = new Set<string>();
  const dedupedDiscovered = discovered.filter((workspace) => {
    const key = `${workspace.workspaceId ?? ""}::${workspace.rootPath ?? ""}`;
    if (seenWorkspace.has(key)) {
      return false;
    }
    seenWorkspace.add(key);
    return true;
  });
  const recentSessions = props.state.sessions
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)
    .map((session) => ({
      id: session.sessionId,
      title: session.name,
      profileLabel: session.profileLabel ?? session.profileId,
      workspaceLabel: session.workspaceLabel ?? "Detached workspace",
      interactionMode: session.interactionMode,
      actSubmode: session.actSubmode,
      launchSummary: session.launchSummary ?? "Launch summary missing",
      recommendedLabel: session.sessionId === props.state.activeSession.sessionId ? "Continue active" : "Resume",
      presetId: session.launchPresetId,
      templateId: session.launchTemplateId,
    }));
  const snapshot = buildOperatorWorkspaceJourney({
    sessionTitle: props.state.activeSession.name,
    profileLabel: props.state.activeProfile.label,
    workspaceLabel: props.state.activeSession.workspaceLabel,
    launchWorkspaceLabel: props.state.activeSession.workspaceLabel,
    interactionMode: props.state.activeSession.interactionMode,
    actSubmode: props.state.activeSession.actSubmode,
    pendingWaitEventType: props.state.activeSession.pendingWaitFor?.eventType,
    lastRunStatus: props.state.activeSession.lastRunStatus,
    isActive: true,
    discoveredWorkspaces: dedupedDiscovered,
    recentSessions,
  });
  const snapshotWithBack = applyStackAwareBackLabel(snapshot, props.state.navigationStack);
  return (
    <WorkspaceView
      snapshot={snapshotWithBack}
      scroll={props.state.scroll.sessions}
      listRows={props.listRows}
      detailDrawerOpen={props.state.detailDrawer.open && props.state.detailDrawer.source === "workspace" && props.state.activeRegion === "details"}
    />
  );
}

function applyStackAwareBackLabel<T extends {
  primaryActions: Array<{ id: string; label: string }>;
  secondaryActions: Array<{ id: string; label: string }>;
}>(snapshot: T, navigationStack: UiRuntimeState["navigationStack"]): T {
  const previousView = navigationStack[navigationStack.length - 1];
  const backLabel = previousView === undefined ? "Back to Chat" : `Back to ${formatViewBackLabel(previousView)}`;
  const mapAction = (action: { id: string; label: string }) => (
    action.id === "nav.back" ? { ...action, label: backLabel } : action
  );
  return {
    ...snapshot,
    primaryActions: snapshot.primaryActions.map(mapAction),
    secondaryActions: snapshot.secondaryActions.map(mapAction),
  };
}

function formatViewBackLabel(view: UiRuntimeState["activeView"]): string {
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

function HistoryScreen(props: {
  state: UiRuntimeState;
  controller: InkAppController;
  listRows: number;
}): React.JSX.Element {
  const entries = buildOperatorHistoryHome(
    props.state.sessions.map((session) => ({
      id: session.sessionId,
      title: session.name,
      updatedAt: session.updatedAt,
      interactionMode: session.interactionMode,
      actSubmode: session.actSubmode,
      pendingWaitEventType: session.pendingWaitFor?.eventType,
      lastRunStatus: session.lastRunStatus,
      lastPreview: session.lastMessagePreview,
      isActive: session.sessionId === props.state.activeSession.sessionId,
      profileLabel: session.profileLabel ?? session.profileId,
      workspaceLabel: session.workspaceLabel,
      launchSummary: session.launchSummary,
      hasArtifacts: session.hasArtifacts,
      hasSummary: session.hasSummary,
      restartAvailable: session.started,
    })),
  );
  const nextActions = buildOperatorHistoryNextActions(entries);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {props.state.sessionsSearchMode ? (
        <Box marginBottom={1}>
          <Text color={theme.muted}>search:</Text>
          <Text color={theme.text}> </Text>
          <ThemedTextInput
            value={props.state.sessionQuery}
            onChange={props.controller.setSessionQuery}
            placeholder="task, profile, workspace"
            focus
          />
        </Box>
      ) : null}
      <HistoryHomeView
        entries={entries}
        nextActions={nextActions}
        query={props.state.sessionQuery}
        scroll={props.state.scroll.sessions}
        listRows={props.listRows}
        detailDrawerOpen={props.state.detailDrawer.open && props.state.detailDrawer.source === "history" && props.state.activeRegion === "details"}
      />
    </Box>
  );
}

function SessionsScreen(props: {
  state: UiRuntimeState;
  controller: InkAppController;
  listRows: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {props.state.sessionsSearchMode ? (
        <Box marginBottom={1}>
          <Text color={theme.muted}>search:</Text>
          <Text color={theme.text}> </Text>
          <ThemedTextInput
            value={props.state.sessionQuery}
            onChange={props.controller.setSessionQuery}
            placeholder="name or id"
            focus
          />
        </Box>
      ) : null}
      <SessionsView
        sessions={props.state.sessions}
        activeSessionName={props.state.activeSession.name}
        query={props.state.sessionQuery}
        scroll={props.state.scroll.sessions}
        listRows={props.listRows}
        detailDrawerOpen={props.state.detailDrawer.open && props.state.detailDrawer.source === "sessions" && props.state.activeRegion === "details"}
      />
    </Box>
  );
}

function ChatScreen(props: {
  state: UiRuntimeState;
  controller: InkAppController;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <ChatView
        session={props.state.activeSession}
        transcript={props.state.transcript}
        runLogs={props.state.runLogs}
        scroll={props.state.scroll.chat}
        statusLine={props.state.statusLine}
        draft={props.state.chatDraft}
        running={props.state.running}
        composerFocused={props.state.activeRegion === "composer"}
        progress={props.state.latestProgressForSession}
        viewportColumns={props.state.viewport.columns}
        viewportRows={props.state.viewport.rows}
        unreadCount={props.state.chatUnreadCount ?? 0}
        highlightRunId={props.state.chatHighlightRunId}
        onDraftChange={props.controller.setDraft}
        onSubmit={props.controller.submitLine}
      />
    </Box>
  );
}

function TasksScreen(props: {
  state: UiRuntimeState;
  listRows: number;
}): React.JSX.Element {
  const tasks = props.state.sessions.filter(
    (session) => session.delegation?.parentSessionId === props.state.activeSession.sessionId,
  );
  return (
    <TasksView
      tasks={tasks}
      scroll={props.state.taskScroll}
      listRows={props.listRows}
      detailDrawerOpen={
        props.state.detailDrawer.open &&
        props.state.detailDrawer.source === "tasks" &&
        props.state.activeRegion === "details"
      }
    />
  );
}

function LogsScreen(props: {
  state: UiRuntimeState;
  controller: InkAppController;
  listRows: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {props.state.logsFilterMode ? (
        <Box marginBottom={1}>
          <Text color={theme.muted}>event:</Text>
          <Text color={theme.text}> </Text>
          <ThemedTextInput
            value={props.state.logFilters.eventQuery}
            onChange={props.controller.setLogEventQuery}
            placeholder="contains"
            focus
          />
        </Box>
      ) : null}
      <LogsView
        logs={props.state.runLogs}
        filters={props.state.logFilters}
        scroll={props.state.scroll.logs}
        listRows={props.listRows}
        detailDrawerOpen={props.state.detailDrawer.open && props.state.detailDrawer.source === "logs" && props.state.activeRegion === "details"}
      />
    </Box>
  );
}
