import {
  ChevronDown,
  Folder,
  KeyRound,
  ListChecks,
  MessageSquare,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Plug,
  Search,
  Send,
  Settings,
  Square,
  Sun,
  Wrench,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  runnerStructuredReviewOptionLabel,
  type RunnerStructuredReviewOptionId,
} from "@kestrel-agents/protocol";
import {
  createModeSwitchRetryGuard,
  resolveConversationComposerKeyboardAction,
  resolveConversationModeSwitch,
} from "@kestrel-agents/conversation";

import type {
  DesktopCapabilityId,
  DesktopReadinessItemId,
  DesktopAttachmentMetadata,
  DesktopFollowUpQueueEntry,
  DesktopOperatorControlRequest,
  DesktopOperatorControlResult,
  DesktopOperatorInboxItem,
  DesktopRendererSettings,
  DesktopMcpDiscoveryResult,
  DesktopMissionControlProjectResponse,
  DesktopProjectRegistration,
  DesktopRunnerEvent,
  DesktopRuntimeHealth,
  DesktopThreadAuthorityResult,
} from "../../src/contracts";
import { DiagnosticsWorkspace } from "./DiagnosticsWorkspace";
import {
  ConversationTimeline,
  TimelineMarker,
} from "./ConversationTimeline";
import { DiffWorkspace } from "./DiffWorkspace";
import { McpWorkspace } from "./McpWorkspace";
import { UnifiedMissionControlWorkspace } from "./UnifiedMissionControlWorkspace";
import {
  extractDesktopTerminalOutcome,
  getDesktopOutcomeHandoff,
  OutcomeHandoff,
  withDesktopOutcomeWorkspaceChanges,
} from "./outcomeHandoff";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { ValidationWorkspace } from "./ValidationWorkspace";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { ConversationWorkflowControl } from "./ConversationWorkflowControl";
import type { DesktopAppsNavigationRequest, DesktopAppsNavigationTarget } from "./appsNavigation";
import { getDesktopComposerSubmissionPolicy } from "./composerPolicy";
import {
  markDesktopFollowUpStarted,
  projectDesktopConversationSubmission,
  projectDesktopStartingFollowUps,
  queuedDesktopFollowUps,
  recoverDesktopConversationSubmissionDisposition,
  resolveDesktopStartedSubmission,
  revertDesktopConversationSubmission,
  type DesktopConversationSubmissionIdentity,
} from "./conversationSubmission";
import { adaptDesktopConversation } from "./conversationAdapter";
import { loadDesktopUiState } from "./uiStateBootstrap";
import {
  describeDesktopRunnerActivity,
  projectDesktopConversationTimeline,
  projectDesktopRunStream,
  type DesktopRunStreamItem,
} from "./runStream";
import { ContextSidebar } from "./ContextSidebar";
import { ConversationExplorer } from "./ConversationExplorer";
import {
  isDesktopThreadProjectUnavailable,
  projectDesktopWorkNavigator,
  resolveDesktopSelectedProjectPath,
  resolveDesktopThreadNavigationStates,
} from "./workNavigator";
import { keepFocusInsideDialog } from "./dialogFocus";
import { withoutDesktopActiveRun } from "./cancellationState";
import {
  clearDesktopThreadError,
  updateDesktopThreadFeedback,
  type DesktopThreadFeedback,
} from "./feedbackState";
import {
  reconcileDesktopThreadAuthority,
  type DesktopAuthorityCaches,
} from "./threadAuthorityState";
import { extractTerminalFailure } from "./runtimeCapabilityRecovery";
import {
  getDesktopTerminalDeliveryError,
  projectDesktopTerminalMessage,
} from "./terminalProjection";
import {
  addRendererThread,
  ensureRendererThread,
  addRendererDraftAttachment,
  archiveRendererThread,
  appendRendererTranscript,
  acceptRendererPrompt,
  applyDesktopOnboardingHandoff,
  getRendererTurnContinuation,
  getRendererThreadArchiveBlockReason,
  getTerminalWaitEventType,
  getTerminalWaitingPrompt,
  readDesktopRendererState,
  renameRendererThread,
  resolveRendererThreadProjectPath,
  restoreRendererThread,
  selectRendererThread,
  serializeDesktopRendererState,
  setRendererTheme,
  toDesktopExecutionSelection,
  toDesktopRunHistory,
  undoArchiveRendererThread,
  updateRendererThread,
  updateRendererDraft,
  updateRendererDraftAttachments,
  type DesktopRendererState,
  type RendererMode,
  type RendererThread,
} from "./state";

const kestrelMarkUrl = new URL(
  "../../../docs/public/brand/kestrel-mark.png",
  import.meta.url,
).href;

interface ActiveRun {
  threadId: string;
  sessionId: string;
  runId?: string | undefined;
}

type DesktopSurface =
  | "chat"
  | "mission-control"
  | "projects"
  | "diff"
  | "review"
  | "validation"
  | "mcp"
  | "settings"
  | "diagnostics";
const SURFACE_STATE_KEY = "kestrel:desktop:surface:v1" as const;
const INSPECTOR_STATE_KEY = "kestrel:desktop:inspector-open:v1" as const;
const INSPECTOR_WIDTH_KEY = "kestrel:desktop:inspector-width:v1" as const;
const SELECTED_PROJECT_KEY = "kestrel:desktop:selected-project:v1" as const;

export function DesktopApp(props: {
  onboardingHandoff?: {
    id: string;
    projectPath: string;
  } | undefined;
} = {}) {
  const [state, setState] = useState<DesktopRendererState>();
  const [settings, setSettings] = useState<DesktopRendererSettings>();
  const [runtimeHealth, setRuntimeHealth] = useState<DesktopRuntimeHealth>();
  const [authorityCaches, setAuthorityCaches] = useState<DesktopAuthorityCaches>({
    activeRuns: {},
    threadViews: {},
    threadWorkspaces: {},
    authorityStatuses: {},
  });
  const [runStreams, setRunStreams] = useState<Record<string, DesktopRunStreamItem[]>>({});
  const [attachments, setAttachments] = useState<Record<string, DesktopAttachmentMetadata>>({});
  const [operatorActionPending, setOperatorActionPending] = useState<Record<string, boolean>>({});
  const [historyNavigation, setHistoryNavigation] = useState<Record<string, { index: number; scratch: string }>>({});
  const [threadFeedback, setThreadFeedback] = useState<Record<string, DesktopThreadFeedback>>({});
  const [surfaceErrors, setSurfaceErrors] = useState<Partial<Record<DesktopSurface, string>>>({});
  const [systemError, setSystemError] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(() => readDesktopSidebarState(INSPECTOR_STATE_KEY, false));
  const [workNavigatorOpen, setWorkNavigatorOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(() => readDesktopSidebarWidth());
  const [surface, setSurface] = useState<DesktopSurface>("chat");
  const [settingsTarget, setSettingsTarget] = useState<DesktopCapabilityId>();
  const [appsNavigationRequest, setAppsNavigationRequest] = useState<DesktopAppsNavigationRequest>({ requestId: 0 });
  const [appsDiscovery, setAppsDiscovery] = useState<DesktopMcpDiscoveryResult>();
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>();
  const [missionControlProjectPath, setMissionControlProjectPath] = useState<string>();
  const [selectedProjectPersistenceReady, setSelectedProjectPersistenceReady] = useState(false);
  const [newConversationRequestId, setNewConversationRequestId] = useState(0);
  const [timelineHasNewActivity, setTimelineHasNewActivity] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const timelineFollowingRef = useRef(true);
  const workNavigatorRef = useRef<HTMLElement>(null);
  const workNavigatorSearchRef = useRef<HTMLInputElement>(null);
  const workNavigatorTriggerRef = useRef<HTMLElement | null>(null);
  const workNavigatorFallbackRef = useRef<HTMLButtonElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const threadsRef = useRef<DesktopRendererState["threads"]>([]);
  const pendingTurnSubmissionsRef = useRef(new Map<string, DesktopConversationSubmissionIdentity>());
  const queuedTurnSubmissionsRef = useRef(new Map<string, DesktopConversationSubmissionIdentity>());
  const startedConversationMessagesRef = useRef(new Set<string>());
  const composerDispatchingRef = useRef(false);
  const modeSwitchRetryGuardRef = useRef(createModeSwitchRetryGuard());
  const uiStatePersistenceEnabledRef = useRef(true);
  const { activeRuns, threadViews, threadWorkspaces, authorityStatuses } = authorityCaches;

  const activeThread = useMemo(
    () => state?.threads.find((thread) => thread.id === state.activeThreadId),
    [state],
  );
  const activeThreadWorkspace =
    activeThread === undefined
      ? undefined
      : threadWorkspaces[activeThread.sessionId];
  const activeThreadAuthorityStatus = activeThread === undefined
    ? undefined
    : authorityStatuses[activeThread.id];
  const archivedThreadSelected = activeThread?.archivedAt !== undefined;
  const unavailableProjectThreadSelected = activeThread !== undefined && settings !== undefined
    ? isDesktopThreadProjectUnavailable(activeThread, settings.projects)
    : false;
  const threadReadOnlySelected = archivedThreadSelected || unavailableProjectThreadSelected;

  useEffect(() => {
    if (threadReadOnlySelected && isConversationOwnedSurface(surface)) {
      setSurface("chat");
    }
  }, [surface, threadReadOnlySelected]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openWorkNavigator();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (workNavigatorOpen) workNavigatorSearchRef.current?.focus();
  }, [workNavigatorOpen]);
  const activeRun = activeThread === undefined
    ? undefined
    : activeRuns[activeThread.id] ?? (
      threadViews[activeThread.id]?.activeRun?.status === "RUNNING" ||
      threadViews[activeThread.id]?.activeRun?.status === "WAITING"
      ? {
          threadId: activeThread.id,
          sessionId: activeThread.sessionId,
          runId: threadViews[activeThread.id]?.activeRun?.runId,
        }
      : undefined);
  const operatorInboxItems = activeThread === undefined
    ? []
    : (threadViews[activeThread.id]?.inboxItems ?? []).filter(
        (item) => item.kind !== "stalled_thread_attention" || activeRun === undefined,
      );
  const activeConversation = activeThread === undefined
    ? undefined
    : adaptDesktopConversation({
        threadId: activeThread.id,
        transcript: activeThread.transcript,
        turns: threadViews[activeThread.id]?.conversationTurns ?? [],
        messageRoutes: threadViews[activeThread.id]?.conversationMessageRoutes ?? [],
        inboxItems: operatorInboxItems,
        followUpQueue: threadViews[activeThread.id]?.followUpQueue,
        activeRunId: activeRun?.runId,
      });
  const composerPolicy = getDesktopComposerSubmissionPolicy({
    inboxItems: operatorInboxItems,
    runActive: activeRun !== undefined,
    conversation: activeConversation?.snapshot,
  });
  const modeSwitchPresentation = activeThread !== undefined && composerPolicy.mode === "reply_to_request"
    ? resolveConversationModeSwitch({
        recommendationId: composerPolicy.item.requestId,
        originatingMessageId: activeConversation?.snapshot.turns.find(
          (turn) => turn.id === composerPolicy.item.turnId,
        )?.inputMessageId ?? "",
        fromMode: activeThread.mode,
        reason: composerPolicy.item.title,
        metadata: composerPolicy.item.metadata,
      })
    : undefined;
  const operatorActionCardItems = operatorInboxItems.filter(
    (item) => item.kind !== "user_input_request",
  );
  const activeRunStream = activeThread === undefined ? [] : runStreams[activeThread.id] ?? [];
  const activeThreadFeedback = activeThread === undefined
    ? { activity: "Ready" }
    : threadFeedback[activeThread.id] ?? { activity: "Ready" };
  const activeLifecycleActivity = modeSwitchPresentation !== undefined
    ? "Mode change required"
    : composerPolicy.mode === "select_evaluation_option"
    ? "Waiting for your decision"
    : composerPolicy.mode === "reply_to_request"
      ? "Waiting for your input"
      : activeThreadFeedback.activity;
  const conversationTimeline = activeThread === undefined
    ? []
    : projectDesktopConversationTimeline(
        activeThread.transcript,
        activeRunStream,
        threadViews[activeThread.id]?.conversationTurns ?? [],
        threadViews[activeThread.id]?.conversationMessageRoutes ?? [],
      );
  const threadNavigation = useMemo(() => resolveDesktopThreadNavigationStates({
    threads: state?.threads ?? [],
    threadViews,
    activeRuns,
    authorityStatuses,
    feedback: threadFeedback,
  }), [state?.threads, threadViews, activeRuns, authorityStatuses, threadFeedback]);
  const workNavigatorProjection = useMemo(() => projectDesktopWorkNavigator({
    threads: state?.threads ?? [],
    projects: settings?.projects ?? [],
    navigation: threadNavigation,
    archived: false,
  }), [state?.threads, settings?.projects, threadNavigation]);

  useEffect(() => {
    threadsRef.current = state?.threads ?? [];
  }, [state?.threads]);

  function setActiveRuns(update: (current: Record<string, ActiveRun>) => Record<string, ActiveRun>): void {
    setAuthorityCaches((current) => ({ ...current, activeRuns: update(current.activeRuns) }));
  }

  function setThreadViews(update: (current: DesktopAuthorityCaches["threadViews"]) => DesktopAuthorityCaches["threadViews"]): void {
    setAuthorityCaches((current) => ({ ...current, threadViews: update(current.threadViews) }));
  }

  function setThreadActivity(threadId: string, activity: string, activityUpdatedAt = new Date().toISOString()): void {
    setThreadFeedback((current) => updateDesktopThreadFeedback(current, threadId, { activity, activityUpdatedAt }));
  }

  function clearThreadError(threadId: string): void {
    setThreadFeedback((current) => clearDesktopThreadError(current, threadId));
  }

  function setThreadFailure(
    threadId: string,
    activity: string,
    error: string,
    errorCapability?: DesktopCapabilityId | undefined,
  ): void {
    setThreadFeedback((current) => updateDesktopThreadFeedback(current, threadId, {
      activity,
      activityUpdatedAt: new Date().toISOString(),
      error,
      ...(errorCapability !== undefined ? { errorCapability } : { errorCapability: undefined }),
    }));
  }

  function setSurfaceError(owner: DesktopSurface, error: string | undefined): void {
    setSurfaceErrors((current) => {
      const next = { ...current };
      if (error === undefined) delete next[owner];
      else next[owner] = error;
      return next;
    });
  }

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      loadDesktopUiState(() => window.kestrelDesktop.getUiState()),
      window.kestrelDesktop.getSettings(),
      window.kestrelDesktop.getRuntimeHealth(),
    ]).then(async ([uiStateBootstrap, loadedSettings, health]) => {
      if (disposed) {
        return;
      }
      uiStatePersistenceEnabledRef.current = uiStateBootstrap.persistenceEnabled;
      let nextSettings = loadedSettings;
      const defaultConfiguration = nextSettings.modelConfigurations.find(
        (configuration) => configuration.id === nextSettings.defaultModelConfigurationId,
      );
      let rendererState = readDesktopRendererState(uiStateBootstrap.state, {
        projectPath:
          props.onboardingHandoff?.projectPath ??
          nextSettings.defaultProjectPath ??
          nextSettings.projects[0]?.path,
        modelConfigurationId: defaultConfiguration?.id,
        modelConfigurationRevision: defaultConfiguration?.currentRevision,
        legacyDefaultWorkflowAppIds: nextSettings.legacyDefaultWorkflowAppIds,
        theme: nextSettings.appearanceTheme,
      });
      if (props.onboardingHandoff !== undefined) {
        rendererState = applyDesktopOnboardingHandoff(rendererState, {
          ...props.onboardingHandoff,
          replaceInitialThread: uiStateBootstrap.state === null,
          ...(defaultConfiguration !== undefined
            ? {
                modelConfigurationId: defaultConfiguration.id,
                modelConfigurationRevision:
                  defaultConfiguration.currentRevision,
              }
            : {}),
        });
      }
      if (
        nextSettings.legacyDefaultWorkflowAppIds !== undefined &&
        uiStatePersistenceEnabledRef.current
      ) {
        await window.kestrelDesktop.saveUiState(serializeDesktopRendererState(rendererState));
        if (disposed) return;
        nextSettings = await window.kestrelDesktop.saveSettings({
          defaultEnabledBuiltInAppIds: nextSettings.defaultEnabledBuiltInAppIds,
        });
      }
      setState(rendererState);
      void (async () => {
        for (const thread of rendererState.threads) {
          if (disposed) return;
          if (thread.id === rendererState.activeThreadId) continue;
          try {
            await refreshThreadAuthority(thread);
          } catch (cause) {
            setThreadFailure(thread.id, "Thread status unavailable", errorMessage(cause));
          }
        }
      })();
      setSettings(nextSettings);
      setSelectedProjectPath(
        (current) =>
          current ?? resolveDesktopSelectedProjectPath({
            projects: nextSettings.projects,
            storedProjectPath: readStoredSelectedProjectPath(),
            activeThreadProjectPath: props.onboardingHandoff?.projectPath,
            defaultProjectPath: nextSettings.defaultProjectPath,
          }),
      );
      setSelectedProjectPersistenceReady(true);
      setRuntimeHealth(health);
    }).catch((cause) => {
      if (disposed === false) {
        setSystemError(errorMessage(cause));
      }
    });
    return () => {
      disposed = true;
    };
  }, [props.onboardingHandoff?.id, props.onboardingHandoff?.projectPath]);

  useEffect(() => {
    let disposed = false;
    void window.kestrelDesktop.discoverMcpServers().then((result) => {
      if (!disposed) setAppsDiscovery(result);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, []);

  useEffect(() => window.kestrelDesktop.onRunnerEvent((event) => {
      const rendererThread = event.sessionId === undefined
        ? undefined
        : threadsRef.current.find((thread) => thread.sessionId === event.sessionId);
      if (rendererThread !== undefined && event.type !== "run.completed") {
        setThreadActivity(rendererThread.id, describeRunnerActivity(event), event.ts);
      }
      if (event.type === "run.started" && rendererThread !== undefined) {
        const sourceMessageId = readString(event.payload.sourceMessageId);
        const promotedSubmission = resolveDesktopStartedSubmission({
          sourceMessageId,
          sessionId: rendererThread.sessionId,
          pending: [...pendingTurnSubmissionsRef.current.values()],
          queued: [...queuedTurnSubmissionsRef.current.values()],
        });
        const startedMessageId = sourceMessageId ?? promotedSubmission?.messageId;
        if (
          promotedSubmission !== undefined
          && pendingTurnSubmissionsRef.current.has(promotedSubmission.messageId)
        ) {
          startedConversationMessagesRef.current.add(promotedSubmission.messageId);
        }
        if (startedMessageId !== undefined) {
          queuedTurnSubmissionsRef.current.delete(startedMessageId);
          setThreadViews((current) => {
            const view = current[rendererThread.id];
            return view === undefined
              ? current
              : {
                  ...current,
                  [rendererThread.id]: {
                    ...view,
                    followUpQueue: {
                      ...view.followUpQueue,
                      items: markDesktopFollowUpStarted(
                        view.followUpQueue.items,
                        startedMessageId,
                      ),
                    },
                  },
                };
          });
        }
        if (promotedSubmission !== undefined) {
          setState((current) => {
            if (current === undefined) return current;
            const withUser = projectDesktopConversationSubmission(current, {
              threadId: promotedSubmission.threadId,
              messageId: promotedSubmission.messageId,
              message: promotedSubmission.message,
              submittedAt: promotedSubmission.submittedAt,
              // The start event can precede the authoritative route/turn response.
              // Keep the message provisional until that response installs ownership
              // so the timeline projector cannot reclassify it as historical state.
              disposition: "submitting",
            });
            return updateRendererThread(withUser, promotedSubmission.threadId, (thread) => ({
              ...thread,
              pendingWaitEventType: undefined,
              ...(promotedSubmission.projectPath !== undefined ? { projectPath: promotedSubmission.projectPath } : {}),
            }));
          });
          setHistoryNavigation((current) => {
            const next = { ...current };
            delete next[promotedSubmission.threadId];
            return next;
          });
        }
        setActiveRuns((current) => ({
          ...current,
          [rendererThread.id]: {
            threadId: rendererThread.id,
            sessionId: rendererThread.sessionId,
            ...(event.runId !== undefined ? { runId: event.runId } : {}),
          },
        }));
      }
      if (rendererThread !== undefined) {
        setRunStreams((current) => ({
          ...current,
          [rendererThread.id]: projectDesktopRunStream(current[rendererThread.id] ?? [], event),
        }));
      }
      if (event.type === "task.updated" && rendererThread !== undefined && event.payload.dialogMessage !== undefined) {
        const message = event.payload.dialogMessage;
        setState((current) => current === undefined ? current : appendRendererTranscript(current, rendererThread.id, {
          role: message.sender === "system" ? "system" : "assistant",
          text: message.text,
          timestamp: message.createdAt,
          dialog: {
            messageId: message.messageId,
            dialogId: message.dialogId,
            ...(message.parentRunId !== undefined ? { parentRunId: message.parentRunId } : {}),
            name: message.name,
            childSessionId: message.childSessionId,
            sender: message.sender,
            ...(message.status !== undefined ? { status: message.status } : {}),
          },
        }));
      }
      if (
        event.type === "task.updated"
        || event.type === "run.completed"
        || event.type === "run.failed"
        || event.type === "run.cancelled"
      ) {
        if (rendererThread !== undefined && event.type !== "task.updated") {
          const result = asRecord(event.payload.result);
          const output = asRecord(result?.output);
          const runId = event.runId ?? readString(output?.runId);
          if (runId !== undefined) {
            const status = readString(output?.status)
              ?? (event.type === "run.failed"
                ? "FAILED"
                : event.type === "run.cancelled"
                  ? "CANCELLED"
                  : "COMPLETED");
            const assistantText = typeof result?.assistantText === "string" ? result.assistantText : null;
            const terminalFailure = extractTerminalFailure(event, undefined);
            const deliveryError = getDesktopTerminalDeliveryError({ assistantText, status });
            const pending = [...pendingTurnSubmissionsRef.current.values()].find(
              (submission) => submission.sessionId === rendererThread.sessionId,
            );
            if (pending !== undefined) {
              pendingTurnSubmissionsRef.current.delete(pending.messageId);
            }
            setState((current) => {
              if (current === undefined) return current;
              const projection = projectDesktopTerminalMessage(current, {
                threadId: rendererThread.id,
                runId,
                assistantText,
                status,
                timestamp: event.ts,
                ...(pending !== undefined ? {
                  pendingUser: {
                    text: pending.message,
                    timestamp: pending.submittedAt,
                    messageId: pending.messageId,
                  },
                } : {}),
                pendingWaitEventType: getTerminalWaitEventType(event),
                waitingPrompt: getTerminalWaitingPrompt(event)?.text,
                ...(terminalFailure !== undefined
                  ? { failureMessage: terminalFailure.message }
                  : {}),
                data: extractDesktopTerminalOutcome(event),
              });
              console.info(`terminal_message.${projection.outcome === "contract_failure"
                ? "recovery_failed"
                : projection.outcome === "duplicate"
                  ? "duplicate_suppressed"
                  : "projected"}`, {
                threadId: rendererThread.id,
                runId,
                count: 1,
              });
              return projection.state;
            });
            if (terminalFailure !== undefined) {
              setThreadFailure(
                rendererThread.id,
                "Run failed",
                terminalFailure.message,
                terminalFailure.capabilityId,
              );
            } else if (deliveryError !== undefined) {
              setThreadFailure(rendererThread.id, "Final response unavailable", deliveryError);
            } else {
              setThreadActivity(
                rendererThread.id,
                getTerminalWaitEventType(event) === undefined ? "Ready" : `Waiting for ${getTerminalWaitEventType(event)}`,
              );
            }
          }
          setActiveRuns((current) => {
            const next = { ...current };
            delete next[rendererThread.id];
            return next;
          });
          void refreshThreadAuthority(rendererThread).catch((cause) => {
            setThreadFailure(rendererThread.id, "Thread status unavailable", errorMessage(cause));
          });
        }
      }
    }), []);

  useEffect(() => window.kestrelDesktop.onRuntimeHealth(setRuntimeHealth), []);

  useEffect(
    () =>
      window.kestrelDesktop.onCommand((command) => {
        if (command === "add-project") {
          void addProject();
          return;
        }
        if (command === "new-thread") {
          requestNewConversation();
          return;
        }
        if (command === "stop-agent") {
          void cancelActiveRun();
          return;
        }
        if (command === "restart-runtime") {
          void window.kestrelDesktop.restartRuntime();
          return;
        }
        if (command === "settings") {
          openCapabilitySettings();
          return;
        }
        if (command === "toggle-left-sidebar") {
          setWorkNavigatorOpen((current) => !current);
          return;
        }
        if (command === "toggle-right-sidebar") {
          setInspectorOpen((current) => !current);
          return;
        }
        if (command === "uninstall") {
          openCapabilitySettings();
        }
      }),
    [activeThread],
  );

  useEffect(() => {
    if (state === undefined) {
      return;
    }
    const resolvedTheme = state.theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : state.theme;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    if (uiStatePersistenceEnabledRef.current === false) {
      return;
    }
    void window.kestrelDesktop
      .saveUiState(serializeDesktopRendererState(state))
      .catch((cause) => {
        setSystemError(`Desktop state could not be saved: ${errorMessage(cause)}`);
      });
  }, [state]);

  useEffect(() => {
    writeDesktopSidebarState(INSPECTOR_STATE_KEY, inspectorOpen);
  }, [inspectorOpen]);

  useEffect(() => {
    if (!selectedProjectPersistenceReady) return;
    writeDesktopSelectedProjectPath(selectedProjectPath);
  }, [selectedProjectPath, selectedProjectPersistenceReady]);

  useEffect(() => {
    if (settings === undefined) return;
    if (selectedProjectPath !== undefined && settings.projects.some((project) => project.path === selectedProjectPath)) return;
    const next = resolveDesktopSelectedProjectPath({
      projects: settings.projects,
      activeThreadProjectPath: activeThread?.projectPath,
      defaultProjectPath: settings.defaultProjectPath,
    });
    if (next !== selectedProjectPath) setSelectedProjectPath(next);
  }, [settings?.projects, settings?.defaultProjectPath, activeThread?.projectPath, selectedProjectPath]);

  useEffect(() => {
    try {
      window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth));
    } catch {
      // Sidebar preferences are optional; the workspace remains usable without them.
    }
  }, [inspectorWidth]);

  useEffect(() => {
    if (state?.theme !== "system") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applySystemTheme = () => {
      const theme = media.matches ? "dark" : "light";
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    };
    media.addEventListener("change", applySystemTheme);
    return () => media.removeEventListener("change", applySystemTheme);
  }, [state?.theme]);

  useEffect(() => {
    if (timelineFollowingRef.current) {
      transcriptEndRef.current?.scrollIntoView({ block: "end" });
      setTimelineHasNewActivity(false);
      return;
    }
    setTimelineHasNewActivity(true);
  }, [activeThread?.transcript.length, activeRunStream, activeThreadFeedback.activity]);

  useEffect(() => {
    const end = transcriptEndRef.current;
    const root = end?.parentElement;
    if (end === null || root === null || root === undefined) return;
    timelineFollowingRef.current = true;
    setTimelineHasNewActivity(false);
    end.scrollIntoView({ block: "end" });
    const observer = new IntersectionObserver(
      ([entry]) => {
        const following = entry?.isIntersecting === true;
        timelineFollowingRef.current = following;
        if (following) setTimelineHasNewActivity(false);
      },
      { root, threshold: 1 },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [activeThread?.id, surface]);

  useEffect(() => {
    if (activeThread === undefined) return;
    void refreshThreadAuthority(activeThread).catch((cause) => {
      setThreadFailure(activeThread.id, "Thread status unavailable", errorMessage(cause));
    });
  }, [activeThread?.id]);

  useEffect(() => {
    if (
      activeThread === undefined
      || runtimeHealth?.state !== "healthy"
      || activeThreadAuthorityStatus !== "available"
    ) return;
    let disposed = false;
    void window.kestrelDesktop.listAttachments(localCoreThreadId(activeThread.sessionId))
      .then((listed) => {
        if (disposed) return;
        setAttachments((current) => ({
          ...current,
          ...Object.fromEntries(listed.map((attachment) => [attachment.attachmentId, attachment])),
        }));
      })
      .catch(() => {
        // Background attachment hydration is optional. Explicit attachment
        // actions still surface failures when the user invokes them.
      });
    return () => {
      disposed = true;
    };
  }, [activeThread?.id, activeThreadAuthorityStatus, runtimeHealth?.state]);

  async function refreshThreadAuthority(thread: DesktopRendererState["threads"][number]): Promise<DesktopThreadAuthorityResult> {
    const result = await window.kestrelDesktop.inspectThreadAuthority(localCoreThreadId(thread.sessionId));
    setAuthorityCaches((current) => reconcileDesktopThreadAuthority({
      caches: current,
      rendererThreadId: thread.id,
      sessionId: thread.sessionId,
      result,
    }));
    if (result.status === "available") {
      setState((current) =>
        current === undefined
          ? current
          : projectDesktopStartingFollowUps(
              current,
              thread.id,
              result.view.followUpQueue.items,
            ),
      );
      const dialogMessages = (result.view.dialogs ?? [])
        .flatMap((dialog) => dialog.messages)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      if (dialogMessages.length > 0) {
        setState((current) =>
          dialogMessages.reduce(
            (next, message) =>
              next === undefined
                ? next
                : appendRendererTranscript(next, thread.id, {
                    role:
                      message.sender === "system" ? "system" : "assistant",
                    text: message.text,
                    timestamp: message.createdAt,
                    dialog: {
                      messageId: message.messageId,
                      dialogId: message.dialogId,
                      ...(message.parentRunId !== undefined ? { parentRunId: message.parentRunId } : {}),
                      name: message.name,
                      childSessionId: message.childSessionId,
                      sender: message.sender,
                      ...(message.status !== undefined
                        ? { status: message.status }
                        : {}),
                    },
                  }),
            current,
          ),
        );
      }
      await recoverConversationMessages(thread).catch(() => {
        setThreadActivity(thread.id, "Conversation history is partially available");
      });
      await recoverConversationActivity(thread).catch(() => {
        setThreadActivity(thread.id, "Conversation history is partially available");
      });
    }
    return result;
  }

  async function recoverConversationActivity(
    thread: DesktopRendererState["threads"][number],
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await window.kestrelDesktop.listConversationActivity(
        thread.sessionId,
        cursor,
        500,
      );
      setRunStreams((current) => ({
        ...current,
        [thread.id]: page.events.reduce(
          projectDesktopRunStream,
          current[thread.id] ?? [],
        ),
      }));
      cursor = page.hasMore ? page.nextCursor : undefined;
      if (page.hasMore && cursor === undefined) {
        throw new Error("Conversation activity pagination did not return a cursor.");
      }
    } while (cursor !== undefined);
  }

  async function recoverConversationMessages(
    thread: DesktopRendererState["threads"][number],
  ): Promise<void> {
    const applyPage = (
      page: Awaited<ReturnType<typeof window.kestrelDesktop.listConversationMessages>>,
      resetCursor = false,
    ) => {
      setState((current) => {
        if (current === undefined) return current;
        let next = current;
        let recovered = 0;
        for (const message of page.messages) {
          const output = asRecord(message.result.output);
          const projection = projectDesktopTerminalMessage(next, {
            threadId: thread.id,
            runId: message.runId,
            turnId: message.turnId,
            assistantText: message.result.assistantText,
            status: readString(output?.status) ?? "COMPLETED",
            timestamp: message.completedAt,
            data: {
              kind: "desktop.terminal-outcome.v1",
              runId: message.runId,
              terminalEvent: "run.completed",
              resultStatus: readString(output?.status) ?? "COMPLETED",
            },
          });
          next = projection.state;
          if (projection.outcome === "projected") recovered += 1;
        }
        next = updateRendererThread(next, thread.id, (entry) => ({
          ...entry,
          ...(page.nextCursor !== undefined || resetCursor
            ? { terminalMessageCursor: page.nextCursor }
            : {}),
        }));
        console.info("terminal_message.recovered", {
          threadId: thread.id,
          count: recovered,
        });
        return next;
      });
    };
    let cursor = thread.terminalMessageCursor;
    try {
      while (true) {
        const page = await window.kestrelDesktop.listConversationMessages(
          localCoreThreadId(thread.sessionId),
          cursor,
          100,
        );
        applyPage(page);
        if (!page.hasMore || page.nextCursor === undefined) return;
        cursor = page.nextCursor;
      }
    } catch (cause) {
      if (cursor !== undefined) {
        try {
          const page = await window.kestrelDesktop.listConversationMessages(
            localCoreThreadId(thread.sessionId),
            undefined,
            500,
          );
          applyPage(page, true);
          console.info("terminal_message.recovery_failed", {
            threadId: thread.id,
            count: 1,
          });
          return;
        } catch {
          // Preserve the original failure below.
        }
      }
      console.info("terminal_message.recovery_failed", {
        threadId: thread.id,
        count: 1,
      });
      throw cause;
    }
  }

  function projectOperatorControlResult(
    rendererThreadId: string,
    response: DesktopOperatorControlResult,
  ): void {
    const result = response.result;
    const runId = response.runId ?? readString(result?.output.runId);
    if (result === undefined || runId === undefined) return;
    const pendingWaitEventType = readString(asRecord(result.output.waitFor)?.eventType);
    const failureMessage = getDesktopTerminalFailureMessage(result.output);
    const waitingPrompt = getDesktopTerminalWaitingPrompt(result.output.waitFor);
    const deliveryError = getDesktopTerminalDeliveryError({
      assistantText: result.assistantText,
      status: result.output.status,
    });
    setState((current) => current === undefined ? current : projectDesktopTerminalMessage(current, {
      threadId: rendererThreadId,
      runId,
      assistantText: result.assistantText,
      status: result.output.status,
      timestamp: new Date().toISOString(),
      pendingWaitEventType,
      waitingPrompt,
      failureMessage,
    }).state);
    if (deliveryError !== undefined) {
      setThreadFailure(rendererThreadId, "Final response unavailable", deliveryError);
    } else if (result.output.status === "FAILED") {
      setThreadFailure(rendererThreadId, "Run failed", failureMessage ?? "Run failed.");
    } else if (result.output.status === "WAITING") {
      setThreadActivity(
        rendererThreadId,
        "Waiting for your input",
      );
    }
  }

  async function submitTurn(
    event?: FormEvent,
    override?: { message: string; mode: RendererMode },
  ): Promise<void> {
    event?.preventDefault();
    const message = override?.message ?? activeThread?.draft ?? "";
    if (
      state === undefined
      || activeThread === undefined
      || message.trim().length === 0
      || settings === undefined
    ) {
      return;
    }
    const submittedAt = new Date().toISOString();
    const threadId = activeThread.id;
    const history = toDesktopRunHistory(activeThread);
    const continuation = getRendererTurnContinuation(activeThread);
    const projectPath = resolveRendererThreadProjectPath({
      thread: activeThread,
      ...(activeThreadWorkspace !== undefined
        ? {
            authoritativeProjectPath: activeThreadWorkspace.sourceWorkspaceRoot,
          }
        : {}),
    });
    const submittedPendingWaitEventType = activeThread.pendingWaitEventType;
    const workspaceSetup = buildManagedWorkspaceSetup(activeThread);
    const submissionMode = override?.mode ?? activeThread.mode;
    const submittedAttachmentIds = override === undefined ? [...activeThread.draftAttachmentIds] : [];
    if (composerDispatchingRef.current) return;
    composerDispatchingRef.current = true;
    queueMicrotask(() => {
      composerDispatchingRef.current = false;
    });
    clearThreadError(threadId);
    const messageId = crypto.randomUUID();
    pendingTurnSubmissionsRef.current.set(messageId, {
      threadId,
      sessionId: activeThread.sessionId,
      messageId,
      message,
      submittedAt,
      projectPath,
    });
    const optimisticInTranscript = composerPolicy.mode !== "queue_follow_up";
    if (optimisticInTranscript) {
      setState((current) => current === undefined
        ? current
        : projectDesktopConversationSubmission(current, {
            threadId,
            messageId,
            message,
            submittedAt,
            disposition: "submitting",
          }));
    } else if (override === undefined) {
      setState((current) => current === undefined
        ? current
        : updateRendererThread(current, threadId, (thread) => ({
            ...thread,
            draft: "",
            draftAttachmentIds: [],
          })));
    }
    setThreadActivity(threadId, "Routing message");
    let authorityRefreshAttempted = false;
    try {
      const routed = await window.kestrelDesktop.submitConversationMessage({
        sessionId: activeThread.sessionId,
        threadId: localCoreThreadId(activeThread.sessionId),
        messageId,
        message,
        history,
        interactionMode: submissionMode,
        workspaceMode: activeThread.workspaceMode,
        ...(activeThread.workspaceMode === "managed"
          ? { workspaceBaseRef: activeThread.workspaceBaseRef }
          : {}),
        attachmentIds: submittedAttachmentIds,
        ...(projectPath !== undefined ? { projectPath } : {}),
        ...(activeThread.workspaceMode === "managed" && workspaceSetup !== undefined
          ? { workspaceSetup }
          : {}),
        ...(submissionMode === "build" ? { actSubmode: "safe" } : {}),
        executionSelection: toDesktopExecutionSelection(
          activeThread,
          settings.apps,
        ),
      });
      const observedStart = startedConversationMessagesRef.current.delete(messageId);
      const startedBeforeRoute = routed.disposition === "queued" && observedStart;
      const projectedDisposition = startedBeforeRoute ? "started" : routed.disposition;
      if (routed.disposition === "queued" && !startedBeforeRoute) {
        queuedTurnSubmissionsRef.current.set(messageId, {
          threadId,
          sessionId: activeThread.sessionId,
          messageId,
          message,
          submittedAt,
          projectPath,
        });
      } else {
        queuedTurnSubmissionsRef.current.delete(messageId);
      }
      setThreadViews((current) => ({
        ...current,
        [threadId]: startedBeforeRoute
          ? {
              ...routed.view,
              followUpQueue: {
                ...routed.view.followUpQueue,
                items: markDesktopFollowUpStarted(
                  routed.view.followUpQueue.items,
                  messageId,
                ),
              },
            }
          : routed.view,
      }));
      setState((current) => {
        if (current === undefined) return current;
        const accepted = projectDesktopConversationSubmission(current, {
          threadId,
          messageId,
          message,
          submittedAt,
          disposition: projectedDisposition,
        });
        return updateRendererThread(accepted, threadId, (thread) => ({
          ...thread,
          ...(projectPath !== undefined ? { projectPath } : {}),
          ...(routed.disposition === "replied" ? { pendingWaitEventType: undefined } : {}),
        }));
      });
      setActiveRuns((current) => {
        const next = { ...current };
        if (routed.view.activeRun?.status === "RUNNING") {
          next[threadId] = {
            threadId,
            sessionId: activeThread.sessionId,
            runId: routed.view.activeRun.runId,
          };
        } else {
          delete next[threadId];
        }
        return next;
      });
      setHistoryNavigation((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setThreadActivity(
        threadId,
        routed.disposition === "queued"
          ? "Queued behind current work"
          : routed.view.activeRun?.status === "WAITING"
            ? "Waiting for your input"
            : routed.disposition === "replied"
              ? "Reply sent"
              : "Message sent",
      );
    } catch (cause) {
      let recoveredDisposition = recoverDesktopConversationSubmissionDisposition({
        messageId,
        observedStart: startedConversationMessagesRef.current.delete(messageId),
        routes: [],
      });
      if (recoveredDisposition === undefined) {
        try {
          authorityRefreshAttempted = true;
          const authority = await refreshThreadAuthority(activeThread);
          if (authority.status === "available") {
            recoveredDisposition = recoverDesktopConversationSubmissionDisposition({
              messageId,
              observedStart: false,
              routes: authority.view.conversationMessageRoutes ?? [],
            });
          }
        } catch {
          // Preserve the original submission failure when authority cannot be checked.
        }
      }
      if (recoveredDisposition !== undefined) {
        if (recoveredDisposition === "queued") {
          queuedTurnSubmissionsRef.current.set(messageId, {
            threadId,
            sessionId: activeThread.sessionId,
            messageId,
            message,
            submittedAt,
            projectPath,
          });
        }
        setState((current) => current === undefined
          ? current
          : projectDesktopConversationSubmission(current, {
              threadId,
              messageId,
              message,
              submittedAt,
              disposition: recoveredDisposition,
            }));
        setThreadActivity(
          threadId,
          recoveredDisposition === "queued" ? "Queued behind current work" : "Message sent",
        );
      } else {
        setState((current) => {
          if (current === undefined) return current;
          const reverted = optimisticInTranscript
            ? revertDesktopConversationSubmission(current, threadId, messageId)
            : current;
          if (override !== undefined) return reverted;
          return updateRendererThread(reverted, threadId, (thread) =>
            thread.draft.length === 0 && thread.draftAttachmentIds.length === 0
              ? {
                  ...thread,
                  draft: message,
                  draftAttachmentIds: submittedAttachmentIds,
                }
              : thread);
        });
      }
      if (recoveredDisposition === undefined && submittedPendingWaitEventType !== undefined) {
        setState((current) => current === undefined
          ? current
          : updateRendererThread(current, threadId, (thread) => ({
              ...thread,
              pendingWaitEventType: submittedPendingWaitEventType,
            })));
      }
      if (recoveredDisposition === undefined) {
        setThreadFailure(threadId, "Message not sent", errorMessage(cause));
      }
    } finally {
      pendingTurnSubmissionsRef.current.delete(messageId);
      if (!authorityRefreshAttempted) {
        void refreshThreadAuthority(activeThread).catch((cause) => {
          setThreadFailure(activeThread.id, "Thread status unavailable", errorMessage(cause));
        });
      }
    }
    return;

  }

  async function acceptModeSwitch(): Promise<void> {
    if (activeThread === undefined || modeSwitchPresentation === undefined) return;
    await modeSwitchRetryGuardRef.current.run({
      recommendationId: modeSwitchPresentation.recommendationId,
      mode: modeSwitchPresentation.toMode,
      switchMode: (mode) => {
        setState((current) => current === undefined
          ? current
          : updateRendererThread(current, activeThread.id, (thread) => ({ ...thread, mode })));
      },
      retry: () => submitTurn(undefined, {
        message: `/mode ${modeSwitchPresentation.toMode}`,
        mode: modeSwitchPresentation.toMode,
      }),
    });
  }

  async function submitEvaluationOption(optionId: RunnerStructuredReviewOptionId): Promise<void> {
    if (
      state === undefined ||
      activeThread === undefined ||
      composerPolicy.mode !== "select_evaluation_option"
    ) {
      return;
    }
    const { item } = composerPolicy;
    const message = optionId;
    const threadId = activeThread.id;
    clearThreadError(threadId);
    setOperatorActionPending((current) => ({ ...current, [item.itemId]: true }));
    setThreadActivity(threadId, "Submitting recovery choice");
    try {
      const controlResult = await window.kestrelDesktop.submitOperatorControl({
        action: "reply",
        threadId: localCoreThreadId(activeThread.sessionId),
        completionMode: "accepted",
        requestId: item.requestId,
        recoveryOptionId: optionId,
        message,
        interactionMode: activeThread.mode,
        ...(activeThread.mode === "build" ? { actSubmode: "safe" } : {}),
      });
      setThreadViews((current) => ({
        ...current,
        [threadId]: controlResult.view,
      }));
      setState((current) => current === undefined
        ? current
        : updateRendererThread(current, threadId, (thread) => ({
            ...thread,
            pendingWaitEventType: undefined,
          })));
      projectOperatorControlResult(threadId, controlResult);
      setThreadActivity(threadId, "Recovery choice submitted");
    } catch (cause) {
      setThreadFailure(threadId, "Recovery choice not submitted", errorMessage(cause));
      void refreshThreadAuthority(activeThread).catch(() => {
        // Preserve the recovery submission error; the next authority refresh can retry.
      });
    } finally {
      setOperatorActionPending((current) => ({ ...current, [item.itemId]: false }));
    }
  }

  async function cancelActiveRun(): Promise<void> {
    if (activeRun === undefined || activeThread === undefined) {
      return;
    }
    const cancelledThread = activeThread;
    clearThreadError(cancelledThread.id);
    setThreadActivity(cancelledThread.id, "Cancelling");
    try {
      const result = await window.kestrelDesktop.cancelRun({
        sessionId: activeRun.sessionId,
        ...(activeRun.runId !== undefined ? { runId: activeRun.runId } : {}),
      });
      if (result.status === "finalizing") {
        clearThreadError(cancelledThread.id);
        setThreadActivity(cancelledThread.id, "Finalizing");
        await refreshThreadAuthority(cancelledThread);
        return;
      }
      if (result.status === "run_changed") {
        setActiveRuns((current) => ({
          ...current,
          [cancelledThread.id]: {
            threadId: cancelledThread.id,
            sessionId: cancelledThread.sessionId,
            ...(result.activeRunId !== undefined
              ? { runId: result.activeRunId }
              : {}),
          },
        }));
        clearThreadError(cancelledThread.id);
        setThreadActivity(cancelledThread.id, "Run changed; stop again");
        await refreshThreadAuthority(cancelledThread);
        return;
      }
      setActiveRuns((current) => {
        const next = { ...current };
        delete next[cancelledThread.id];
        return next;
      });
      setThreadViews((current) => {
        const view = current[cancelledThread.id];
        return view === undefined
          ? current
          : {
              ...current,
              [cancelledThread.id]: withoutDesktopActiveRun(view),
            };
      });
      clearThreadError(cancelledThread.id);
      setThreadActivity(cancelledThread.id, result.status === "already_stopped" ? "Ready" : "Cancelled");
      await refreshThreadAuthority(cancelledThread);
    } catch (cause) {
      setThreadFailure(cancelledThread.id, "Cancel failed", errorMessage(cause));
    }
  }

  async function attachWorkspaceFile(
    filePath: string,
    rootPath: string,
    threadId: string | undefined,
    intent: "attach" | "ask",
  ): Promise<void> {
    if (activeThread === undefined) {
      return;
    }
    const ownerThread = activeThread;
    if (ownerThread.draftAttachmentIds.length >= 8) {
      setThreadFailure(ownerThread.id, "Attachment not added", "A message can include at most 8 attachments.");
      return;
    }
    try {
      const file = await window.kestrelDesktop.readFile({
        rootPath,
        targetPath: filePath,
        ...(threadId !== undefined ? { threadId } : {}),
      });
      const attachmentBytes = new TextEncoder().encode(file.content);
      const attachment = await importGeneratedAttachment(ownerThread, {
        filename: fileName(file.path),
        mimeType: desktopTextMimeType(file.language, file.viewKind),
        sha256: await sha256Hex(attachmentBytes),
        bytes: attachmentBytes,
      });
      setState((current) => current === undefined ? current : addRendererDraftAttachment(current, ownerThread.id, {
        attachmentId: attachment.attachmentId,
        ...(intent === "ask" ? { generatedDraft: `Please review the attached ${attachment.filename} in the context of this workspace.` } : {}),
      }));
      setSurface("chat");
      clearThreadError(ownerThread.id);
    } catch (cause) {
      setThreadFailure(ownerThread.id, "Attachment not added", errorMessage(cause));
    }
  }

  async function importGeneratedAttachment(
    thread: RendererThread,
    input: { filename: string; mimeType: string; bytes: Uint8Array; sha256: string },
  ): Promise<DesktopAttachmentMetadata> {
    const attachment = await window.kestrelDesktop.importAttachment({
      threadId: localCoreThreadId(thread.sessionId),
      filename: input.filename,
      mimeType: input.mimeType,
      data: bytesToBase64(input.bytes),
      sha256: input.sha256,
    });
    setAttachments((current) => ({ ...current, [attachment.attachmentId]: attachment }));
    return attachment;
  }

  async function steerActiveRun(): Promise<void> {
    if (activeThread === undefined || activeRun === undefined || activeThread.draft.trim().length === 0) return;
    const ownerThread = activeThread;
    const message = ownerThread.draft;
    clearThreadError(ownerThread.id);
    setThreadActivity(ownerThread.id, "Applying steering");
    try {
      const controlResult = await window.kestrelDesktop.submitOperatorControl({
        action: "steer",
        threadId: localCoreThreadId(ownerThread.sessionId),
        message,
        attachmentIds: ownerThread.draftAttachmentIds,
      });
      const view = controlResult.view;
      setThreadViews((current) => ({ ...current, [ownerThread.id]: view }));
      setState((current) => current === undefined ? current : acceptRendererPrompt(current, ownerThread.id, message));
      projectOperatorControlResult(ownerThread.id, controlResult);
      setThreadActivity(ownerThread.id, view.latestSteering === undefined ? "Steering queued" : "Steering applied");
    } catch (cause) {
      setThreadFailure(ownerThread.id, "Steering not applied", errorMessage(cause));
    }
  }

  async function selectAttachments(): Promise<void> {
    if (activeThread === undefined) return;
    const ownerThread = activeThread;
    try {
      const selected = await window.kestrelDesktop.selectAttachments(localCoreThreadId(ownerThread.sessionId));
      if (selected.length === 0) return;
      setAttachments((current) => ({ ...current, ...Object.fromEntries(selected.map((entry) => [entry.attachmentId, entry])) }));
      setState((current) => current === undefined ? current : updateRendererDraftAttachments(
        current,
        ownerThread.id,
        [...ownerThread.draftAttachmentIds, ...selected.map((entry) => entry.attachmentId)].slice(0, 8),
      ));
      clearThreadError(ownerThread.id);
    } catch (cause) {
      setThreadFailure(ownerThread.id, "Attachment not added", errorMessage(cause));
    }
  }

  async function removeDraftAttachment(attachmentId: string): Promise<void> {
    if (activeThread === undefined) return;
    const ownerThread = activeThread;
    try {
      await window.kestrelDesktop.removeAttachment(localCoreThreadId(ownerThread.sessionId), attachmentId);
      setState((current) => current === undefined ? current : updateRendererDraftAttachments(
        current,
        ownerThread.id,
        ownerThread.draftAttachmentIds.filter((id) => id !== attachmentId),
      ));
      clearThreadError(ownerThread.id);
    } catch (cause) {
      setThreadFailure(ownerThread.id, "Attachment not removed", errorMessage(cause));
    }
  }

  async function submitOperatorAction(itemId: string, request: DesktopOperatorControlRequest): Promise<void> {
    if (activeThread === undefined || operatorActionPending[itemId] === true) return;
    const ownerThread = activeThread;
    setOperatorActionPending((current) => ({ ...current, [itemId]: true }));
    try {
      const controlResult = await window.kestrelDesktop.submitOperatorControl(request);
      const view = controlResult.view;
      if (view.thread.threadId === localCoreThreadId(ownerThread.sessionId)) {
        setThreadViews((current) => ({ ...current, [ownerThread.id]: view }));
      } else {
        await refreshThreadAuthority(ownerThread);
      }
      if (request.attachmentIds !== undefined && request.attachmentIds.length > 0) {
        setState((current) => current === undefined
          ? current
          : updateRendererDraftAttachments(current, ownerThread.id, []));
      }
      clearThreadError(ownerThread.id);
      projectOperatorControlResult(ownerThread.id, controlResult);
    } catch (cause) {
      setThreadFailure(ownerThread.id, "Action failed", errorMessage(cause));
    } finally {
      setOperatorActionPending((current) => ({ ...current, [itemId]: false }));
    }
  }

  function navigatePromptHistory(threadId: string, direction: -1 | 1): boolean {
    const thread = state?.threads.find((entry) => entry.id === threadId);
    if (thread === undefined || thread.promptHistory.length === 0) return false;
    const current = historyNavigation[threadId];
    if (current === undefined && direction === 1) return false;
    const navigation = current ?? { index: thread.promptHistory.length, scratch: thread.draft };
    const nextIndex = navigation.index + direction;
    if (nextIndex < 0) return true;
    if (nextIndex >= thread.promptHistory.length) {
      setState((value) => value === undefined ? value : updateRendererDraft(value, threadId, navigation.scratch));
      setHistoryNavigation((value) => { const next = { ...value }; delete next[threadId]; return next; });
      return true;
    }
    setState((value) => value === undefined ? value : updateRendererDraft(value, threadId, thread.promptHistory[nextIndex]!));
    setHistoryNavigation((value) => ({ ...value, [threadId]: { ...navigation, index: nextIndex } }));
    return true;
  }

  async function restartRuntime(): Promise<void> {
    const ownerThreadId = activeThread?.id;
    if (ownerThreadId !== undefined) setThreadActivity(ownerThreadId, "Restarting runtime");
    setSystemError(undefined);
    try {
      await window.kestrelDesktop.restartRuntime();
      setRuntimeHealth(await window.kestrelDesktop.getRuntimeHealth());
      if (ownerThreadId !== undefined) setThreadActivity(ownerThreadId, "Ready");
    } catch (cause) {
      setSystemError(errorMessage(cause));
      if (ownerThreadId !== undefined) setThreadActivity(ownerThreadId, "Runtime restart failed");
    }
  }

  async function addProject(): Promise<DesktopProjectRegistration | undefined> {
    if (settings === undefined) {
      return undefined;
    }
    const project = await window.kestrelDesktop.pickProjectFolder();
    if (project === undefined) {
      return undefined;
    }
    const projects = [
      ...settings.projects.filter((entry) => entry.path !== project.path),
      project,
    ];
    const saved = await window.kestrelDesktop.saveSettings({ projects });
    setSettings(saved);
    setSelectedProjectPath(project.path);
    return project;
  }

  function createConversationForProject(projectPath: string | null): void {
    const defaultConfiguration = settings?.modelConfigurations.find(
      (configuration) => configuration.id === settings.defaultModelConfigurationId,
    );
    setState((current) => current === undefined ? current : addRendererThread(current, {
      ...(projectPath !== null ? { projectPath } : {}),
      modelConfigurationId: defaultConfiguration?.id,
      modelConfigurationRevision: defaultConfiguration?.currentRevision,
      enabledWorkflowAppIds: [],
    }));
    if (projectPath !== null) setSelectedProjectPath(projectPath);
    setSurface("chat");
    closeWorkNavigator(false);
    requestAnimationFrame(() => composerTextareaRef.current?.focus());
  }

  function requestNewConversation(): void {
    openWorkNavigator();
    setNewConversationRequestId((current) => current + 1);
  }

  async function addProjectAndCreate(): Promise<void> {
    const project = await addProject();
    if (project !== undefined) createConversationForProject(project.path);
  }

  function startProjectConversation(projectPath: string): void {
    createConversationForProject(projectPath);
  }

  function openProjectHub(projectPath: string): void {
    setSelectedProjectPath(projectPath);
    setSurface("projects");
    closeWorkNavigator();
  }

  function openMissionControlConversation(sessionId: string): void {
    const matches = state?.threads.filter(
      (thread) => thread.sessionId === sessionId,
    ) ?? [];
    if (matches.length !== 1) {
      setSurfaceError(
        "mission-control",
        matches.length === 0
          ? "The linked conversation is not available in this Desktop window."
          : "The linked conversation identity is ambiguous.",
      );
      return;
    }
    setState((current) =>
      current === undefined
        ? current
        : selectRendererThread(current, matches[0]!.id),
    );
    const projectPath = matches[0]!.projectPath;
    if (projectPath !== undefined && settings?.projects.some((project) => project.path === projectPath)) {
      setSelectedProjectPath(projectPath);
    }
    setSurface("chat");
  }

  function registerMissionControlConversations(
    response: DesktopMissionControlProjectResponse,
    projectPath: string,
  ): void {
    const defaultConfiguration = settings?.modelConfigurations.find(
      (configuration) => configuration.id === settings.defaultModelConfigurationId,
    );
    setState((current) => {
      if (current === undefined) return current;
      let next = current;
      for (const item of Object.values(response.project.document.items)) {
        for (const attempt of item.attempts) {
          next = ensureRendererThread(next, {
            sessionId: attempt.requestedSessionId,
            title: item.title,
            titleLocked: true,
            projectPath,
            modelConfigurationId: defaultConfiguration?.id,
            modelConfigurationRevision: defaultConfiguration?.currentRevision,
            enabledWorkflowAppIds: [],
            rawState: {
              missionControl: {
                projectId: response.projectId,
                itemId: item.id,
                attemptId: attempt.id,
              },
            },
          });
        }
      }
      return next;
    });
  }

  function openWorkSurface(nextSurface: DesktopSurface): void {
    if (nextSurface === "mission-control") {
      const projectPath = selectedProjectPath
        ?? activeThread?.projectPath
        ?? settings?.projects[0]?.path;
      if (projectPath !== undefined) setMissionControlProjectPath(projectPath);
    }
    setSurface(nextSurface);
    closeWorkNavigator();
  }

  function reviewOutcomeChanges(runId: string): void {
    if (activeThread === undefined) return;
    setState((current) => current === undefined ? current : updateRendererThread(
      current,
      activeThread.id,
      (thread) => ({ ...thread, diffScopeKind: "latest_run", diffRevision: runId }),
    ));
    setSurface("diff");
  }

  function inspectOutcomeRun(runId: string): void {
    void runId;
    const projectPath = activeThread?.projectPath ?? selectedProjectPath;
    if (projectPath !== undefined) setMissionControlProjectPath(projectPath);
    setSurface("mission-control");
  }

  function openWorkNavigator(trigger?: HTMLElement): void {
    workNavigatorTriggerRef.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setWorkNavigatorOpen(true);
  }

  function closeWorkNavigator(restoreFocus = true): void {
    setWorkNavigatorOpen(false);
    if (restoreFocus) requestAnimationFrame(() => {
      const trigger = workNavigatorTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else workNavigatorFallbackRef.current?.focus();
    });
  }

  function openCapabilitySettings(target?: DesktopCapabilityId): void {
    if (
      target === "tools.internet.tavily" ||
      target === "tools.weather" ||
      target === "tools.network.free" ||
      target === "connections.mcp"
    ) {
      openApps(target === undefined ? undefined : { kind: "capability", capabilityId: target });
      return;
    }
    setSettingsTarget(target);
    setSurface("settings");
  }

  function openApps(target?: DesktopAppsNavigationTarget): void {
    setAppsNavigationRequest((current) => ({ requestId: current.requestId + 1, ...(target ? { target } : {}) }));
    setSurface("mcp");
  }

  function openReadinessSettings(itemId: DesktopReadinessItemId): void {
    if (itemId === "provider" && settings !== undefined) openCapabilitySettings(`model.${settings.selectedProvider}`);
    else if (itemId === "database") openCapabilitySettings("data.database");
    else if (itemId === "projects") openCapabilitySettings("data.workspace");
    else openCapabilitySettings();
  }
  if (state === undefined || activeThread === undefined) {
    return (
      <main className="loading-shell">
        <span className="brand-mark" aria-hidden="true">
          <img src={kestrelMarkUrl} alt="" />
        </span>
        <p>{systemError ?? "Opening Kestrel"}</p>
      </main>
    );
  }

  const healthState = runtimeHealth?.state ?? "degraded";
  const healthLabel = runtimeHealthLabel(healthState);
  const detailsLabel = `${inspectorOpen ? "Close" : "Open"} details${healthState === "healthy" ? "" : `, ${healthLabel}`}`;
  const activeModelConfiguration = settings?.modelConfigurations.find(
    (configuration) => configuration.id === activeThread.modelConfigurationId,
  );
  const activeModelRevision = activeModelConfiguration?.revisions.find(
    (revision) => revision.revision === activeThread.modelConfigurationRevision,
  );
  const modelSelectionLocked = threadReadOnlySelected
    || activeRun !== undefined
    || activeThread.pendingWaitEventType !== undefined;
  const selectedProject =
    settings?.projects.find((project) => project.path === selectedProjectPath) ??
    settings?.projects[0];
  const threadProjectPath =
    activeThreadWorkspace?.sourceWorkspaceRoot ?? activeThread.projectPath;
  const threadProject = settings?.projects.find(
    (project) => project.path === threadProjectPath,
  );
  const missionControlProject = settings?.projects.find(
    (project) => project.path === missionControlProjectPath,
  );
  const projectWorkspace =
    selectedProject !== undefined &&
    activeThreadWorkspace?.sourceWorkspaceRoot === selectedProject.path
      ? activeThreadWorkspace
      : undefined;
  const projectConversationMatchesActiveThread = selectedProject?.path === activeThread.projectPath;
  const conversationProjectLabel = threadProject?.label
    ?? (threadProjectPath === undefined ? "No project" : "Unavailable project");
  const selectedProjectLabel = selectedProject?.label ?? "No project";
  const titlebarProjectLabel = surface === "projects"
    ? selectedProjectLabel
    : surface === "mission-control"
      ? missionControlProject?.label ?? "No project"
      : conversationProjectLabel;
  const showInspector = surface === "chat" && inspectorOpen;
  return (
    <div className="desktop-app">
      <header className="titlebar" inert={workNavigatorOpen ? true : undefined}>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <img src={kestrelMarkUrl} alt="" />
          </span>
          <strong>Kestrel</strong>
        </div>
        <button
          className="project-switcher"
          type="button"
          title="Find work and switch projects"
          onClick={(event) => openWorkNavigator(event.currentTarget)}
        >
          <Folder size={16} aria-hidden="true" />
          <span>{titlebarProjectLabel}</span>
        </button>
        <div
          className="titlebar-context"
          title={`${activeThread.title} · ${titlebarProjectLabel} · ${surfacePageTitle(surface)}`}
        >
          <span className="titlebar-thread-context">
            <strong className="titlebar-thread-title">{activeThread.title}</strong>
          </span>
          {surface === "chat" ? null : <span className="titlebar-page-title">{surfacePageTitle(surface)}</span>}
        </div>
        <div className="titlebar-actions">
          <button
            className="topbar-find"
            ref={workNavigatorFallbackRef}
            type="button"
            title="Find work (Command-K)"
            onClick={(event) => openWorkNavigator(event.currentTarget)}
          >
            <Search size={16} aria-hidden="true" />
            <span>Find work</span>
            <kbd>⌘K</kbd>
          </button>
          <button
            className="icon-button"
            type="button"
            title={
              state.theme === "dark" ? "Use light theme" : "Use dark theme"
            }
            aria-label={
              state.theme === "dark" ? "Use light theme" : "Use dark theme"
            }
            onClick={() =>
              setState((current) =>
                current === undefined
                  ? current
                  : setRendererTheme(
                      current,
                      current.theme === "dark" ? "light" : "dark",
                    ),
              )
            }
          >
            {state.theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          {surface === "chat" ? (
            <button
              className={`details-button ${healthState === "healthy" ? "" : "needs-attention"}`}
              type="button"
              title={detailsLabel}
              aria-label={detailsLabel}
              aria-controls="context-sidebar"
              aria-expanded={inspectorOpen}
              onClick={() => setInspectorOpen((open) => !open)}
            >
              <span className={`titlebar-status-dot health-${healthState}`} aria-hidden="true" />
              {inspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
              <span>Details</span>
            </button>
          ) : null}
        </div>
      </header>

      {workNavigatorOpen ? (
        <button
          className="work-navigator-scrim"
          type="button"
          aria-label="Close find work"
          onClick={() => closeWorkNavigator()}
        />
      ) : null}

      <div
        className={`workspace ${showInspector ? "with-inspector" : ""}`}
        style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
      >
        <aside
          className={`conversation-rail work-navigator ${workNavigatorOpen ? "open" : ""}`}
          aria-label="Find work"
          aria-hidden={!workNavigatorOpen}
          aria-modal={workNavigatorOpen ? true : undefined}
          ref={workNavigatorRef}
          role="dialog"
          onKeyDown={(event) => {
            if (event.key === "Escape" && (event.target as HTMLElement).closest('[role="dialog"]') === event.currentTarget) {
              event.preventDefault();
              closeWorkNavigator();
              return;
            }
            keepFocusInsideDialog(event.nativeEvent, workNavigatorRef.current);
          }}
        >
          <nav className="surface-tabs" aria-label="Kestrel views">
            <div className="surface-tabs-section" role="group" aria-labelledby="work-navigation-heading">
              <span className="surface-tabs-heading" id="work-navigation-heading">Work</span>
              <button
                className={surface === "chat" ? "active" : ""}
                type="button"
                title="Conversations"
                aria-label="Conversations"
                onClick={() => openWorkSurface("chat")}
              >
                <MessageSquare size={17} />
                <span>Conversation</span>
              </button>
              <button
                className={surface === "mission-control" ? "active" : ""}
                type="button"
                title="Mission control"
                aria-label="Mission control"
                onClick={() => openWorkSurface("mission-control")}
              >
                <ListChecks size={17} />
                <span>Mission control</span>
              </button>
              <button
                className={surface === "projects" ? "active" : ""}
                type="button"
                title="Projects"
                aria-label="Projects"
                onClick={() => openWorkSurface("projects")}
              >
                <Folder size={17} />
                <span>Projects</span>
              </button>
            </div>
            <div
              className="surface-tabs-section surface-tabs-configure"
              role="group"
              aria-labelledby="configure-navigation-heading"
            >
              <span className="surface-tabs-heading" id="configure-navigation-heading">Configure</span>
              <button
                className={surface === "mcp" ? "active" : ""}
                type="button"
                title="Apps"
                aria-label="Apps"
                onClick={() => openWorkSurface("mcp")}
              >
                <Plug size={17} />
                <span>Apps</span>
              </button>
              <button className={surface === "settings" ? "active" : ""} type="button" title="Settings" aria-label="Settings" onClick={() => { openCapabilitySettings(); closeWorkNavigator(); }}>
                <Settings size={17} />
                <span>Settings</span>
              </button>
              <button className={surface === "diagnostics" ? "active" : ""} type="button" title="Diagnostics" aria-label="Diagnostics" onClick={() => openWorkSurface("diagnostics")}>
                <Wrench size={17} />
                <span>Diagnostics</span>
              </button>
            </div>
          </nav>

          <ConversationExplorer
              threads={state.threads}
              activeThreadId={state.activeThreadId}
              projects={settings?.projects ?? []}
              navigation={threadNavigation}
              selectedProjectPath={selectedProjectPath}
              newConversationRequestId={newConversationRequestId}
              searchInputRef={workNavigatorSearchRef}
              onSelect={(threadId) => {
                const selectedThread = state.threads.find((thread) => thread.id === threadId);
                if (selectedThread?.projectPath !== undefined && settings?.projects.some((project) => project.path === selectedThread.projectPath)) {
                  setSelectedProjectPath(selectedThread.projectPath);
                }
                setState((current) => current === undefined ? current : selectRendererThread(current, threadId));
                setSurface("chat");
                closeWorkNavigator();
              }}
              onSelectProject={openProjectHub}
              onNewConversation={createConversationForProject}
              onAddProjectAndCreate={addProjectAndCreate}
              onRename={(threadId, title) => setState((current) => current === undefined ? current : renameRendererThread(current, threadId, title))}
              onArchive={async (threadId) => {
                const thread = threadsRef.current.find((candidate) => candidate.id === threadId);
                if (thread === undefined) return { status: "blocked", message: "This conversation is no longer available." };
                const cachedView = threadViews[thread.id];
                const immediateReason = getRendererThreadArchiveBlockReason(thread, {
                  runActive: activeRuns[thread.id] !== undefined || cachedView?.activeRun?.status === "RUNNING",
                  runtimeWaiting: cachedView?.activeRun?.status === "WAITING" || cachedView?.thread.status === "WAITING",
                  actionableOperatorRequest: cachedView?.inboxItems.some((item) => item.actionable !== false) === true,
                });
                if (immediateReason !== undefined) return { status: "blocked", message: immediateReason };
                try {
                  const authority = await refreshThreadAuthority(thread);
                  if (authority.status === "available") {
                    const reason = getRendererThreadArchiveBlockReason(thread, {
                      runActive: authority.view.activeRun?.status === "RUNNING",
                      runtimeWaiting: authority.view.activeRun?.status === "WAITING" || authority.view.thread.status === "WAITING",
                      actionableOperatorRequest: authority.view.inboxItems.some((item) => item.actionable !== false),
                    });
                    if (reason !== undefined) return { status: "blocked", message: reason };
                  }
                  const defaultConfiguration = settings?.modelConfigurations.find((configuration) => configuration.id === settings.defaultModelConfigurationId);
                  setState((current) => current === undefined ? current : archiveRendererThread(current, threadId, {
                    modelConfigurationId: defaultConfiguration?.id,
                    modelConfigurationRevision: defaultConfiguration?.currentRevision,
                    enabledWorkflowAppIds: [],
                  }));
                  setSurface("chat");
                  return { status: "archived" };
                } catch {
                  return { status: "blocked", message: "Kestrel could not confirm that this conversation is idle. Try again when Local Core is available." };
                }
              }}
              onUndoArchive={(threadId, removeReplacement) => {
                setState((current) => current === undefined ? current : undoArchiveRendererThread(current, threadId, removeReplacement));
                setSurface("chat");
              }}
              onRestore={(threadId) => {
                setState((current) => current === undefined ? current : restoreRendererThread(current, threadId));
                setSurface("chat");
              }}
            />
        </aside>

        {surface === "chat" ? (
          <main className="conversation-pane" id="app-main" inert={workNavigatorOpen ? true : undefined}>
          <ConversationTimeline
            items={conversationTimeline}
            active={activeRun !== undefined}
            waiting={threadViews[activeThread.id]?.activeRun?.status === "WAITING"}
            activity={activeLifecycleActivity}
            error={activeThreadFeedback.error}
            systemError={systemError}
            errorAction={activeThreadFeedback.errorCapability !== undefined ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => openCapabilitySettings(activeThreadFeedback.errorCapability)}
              >
                Open capability settings
              </button>
            ) : undefined}
            endRef={transcriptEndRef}
            showNewActivity={timelineHasNewActivity}
            onFollowNewActivity={() => {
              timelineFollowingRef.current = true;
              setTimelineHasNewActivity(false);
              transcriptEndRef.current?.scrollIntoView({
                block: "end",
                behavior: "smooth",
              });
            }}
            messageSupplement={(entry) => {
              const outcome = getDesktopOutcomeHandoff(entry.line.data);
              return outcome === undefined ? null : (
                <OutcomeHandoff
                  outcome={outcome}
                  hasWorkspace={threadProjectPath !== undefined}
                  onReviewChanges={reviewOutcomeChanges}
                  onInspectRun={inspectOutcomeRun}
                />
              );
            }}
            tail={(
              <>
                {!threadReadOnlySelected && queuedDesktopFollowUps(threadViews[activeThread.id]?.followUpQueue.items ?? []).length ? (
                  <li className="timeline-entry timeline-entry-queue">
                    <TimelineMarker kind="queue" />
                    <section className="timeline-entry-content follow-up-queue" aria-label="Queued follow-ups">
                      <div className="queue-heading">
                        <strong>Queued follow-ups</strong>
                        {threadViews[activeThread.id]?.followUpQueue.state === "paused" ? (
                          <button type="button" onClick={() => void submitOperatorAction("resume-queue", {
                            action: "resume_follow_up_queue",
                            threadId: localCoreThreadId(activeThread.sessionId),
                          })}>Resume queue</button>
                        ) : null}
                      </div>
                      {queuedDesktopFollowUps(threadViews[activeThread.id]?.followUpQueue.items ?? []).map((item, index) => (
                        <QueuedFollowUpCard
                          key={item.followUpId}
                          item={item}
                          index={index}
                          threadId={localCoreThreadId(activeThread.sessionId)}
                          pending={operatorActionPending[item.followUpId] === true}
                          onAction={(request) => void submitOperatorAction(item.followUpId, request)}
                        />
                      ))}
                    </section>
                  </li>
                ) : null}

                {!threadReadOnlySelected ? operatorActionCardItems.map((item) => (
                  <OperatorActionCard
                    key={item.itemId}
                    item={item}
                    pending={operatorActionPending[item.itemId] === true}
                    onAction={(request) => void submitOperatorAction(item.itemId, request)}
                  />
                )) : null}

                {threadReadOnlySelected ? (
                  <li className="timeline-entry timeline-entry-archived">
                    <TimelineMarker kind="attention" />
                    <section
                      className="timeline-entry-content archived-conversation-banner"
                      aria-label={archivedThreadSelected ? "Archived conversation" : "Unavailable project conversation"}
                    >
                      <div>
                        <strong>{archivedThreadSelected ? "Archived conversation" : "Project unavailable"}</strong>
                        <span>
                          {archivedThreadSelected
                            ? "This transcript is read-only."
                            : "This conversation is read-only because its project is no longer registered."}
                        </span>
                      </div>
                      {archivedThreadSelected ? (
                        <button className="primary-button" type="button" onClick={() => {
                          setState((current) => current === undefined ? current : restoreRendererThread(current, activeThread.id));
                        }}>Restore conversation</button>
                      ) : null}
                    </section>
                  </li>
                ) : null}
              </>
            )}
          />

          {threadReadOnlySelected ? null : (
            <>
            {modeSwitchPresentation !== undefined ? (
              <section className="composer mode-switch-composer" aria-label="Mode change required">
                <div className="recovery-option-copy">
                  <strong>Continue in {modeLabel(modeSwitchPresentation.toMode)}</strong>
                  <span>{modeSwitchPresentation.reason}</span>
                </div>
                <div className="recovery-option-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void acceptModeSwitch()}
                  >
                    Switch to {modeLabel(modeSwitchPresentation.toMode)} and continue
                  </button>
                </div>
              </section>
            ) : composerPolicy.mode === "select_evaluation_option" ? (
            <section className="composer recovery-option-composer" aria-label="Evaluation options">
              <div className="recovery-option-copy">
                <strong>Result requires review</strong>
                <span>Choose how to handle the withheld result.</span>
                {composerPolicy.evaluationTechnicalDisclosure !== undefined ? (
                  <details>
                    <summary>Technical details</summary>
                    <EvaluationTechnicalDisclosure value={composerPolicy.evaluationTechnicalDisclosure} />
                  </details>
                ) : null}
              </div>
              <div className="recovery-option-actions">
                {composerPolicy.allowedOptionIds.map((optionId) => (
                  <button
                    className="primary-button"
                    key={optionId}
                    type="button"
                    disabled={operatorActionPending[composerPolicy.item.itemId] === true}
                    onClick={() => void submitEvaluationOption(optionId)}
                  >
                    {runnerStructuredReviewOptionLabel("evaluation_review", optionId)}
                  </button>
                ))}
              </div>
            </section>
            ) : composerPolicy.mode === "invalid_review" ? (
              <section className="composer recovery-option-composer" aria-label="Invalid review request">
                <div className="recovery-option-copy">
                  <strong>This request cannot be answered safely</strong>
                  <span>{composerPolicy.error}</span>
                </div>
                <div className="recovery-option-actions">
                  <button className="primary-button" type="button" onClick={() => void cancelActiveRun()}>
                    End waiting turn
                  </button>
                </div>
              </section>
            ) : (
            <form
            className={`composer ${composerFocused || activeThread.draft.trim().length > 0 || activeThread.draftAttachmentIds.length > 0 ? "composer-expanded" : ""}`}
            onBlur={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
                return;
              }
              setComposerFocused(false);
            }}
            onFocus={() => setComposerFocused(true)}
            onSubmit={(event) => void submitTurn(event)}
          >
            <div className="mode-segment" aria-label="Interaction mode">
              {(["chat", "plan", "build"] as const).map((mode) => (
                <button
                  className={activeThread.mode === mode ? "active" : ""}
                  key={mode}
                  type="button"
                  onClick={() => setState((current) => current === undefined
                    ? current
                    : updateRendererThread(current, activeThread.id, (thread) => ({ ...thread, mode })))}
                >
                  {modeLabel(mode)}
                </button>
              ))}
            </div>
            <textarea
              ref={composerTextareaRef}
              aria-label="Message"
              placeholder={composerPolicy.mode === "reply_to_request" ? "Reply to Kestrel" : "Message Kestrel"}
              rows={3}
              value={activeThread.draft}
              onChange={(event) => {
                setState((current) => current === undefined ? current : updateRendererDraft(current, activeThread.id, event.target.value));
                setHistoryNavigation((current) => { const next = { ...current }; delete next[activeThread.id]; return next; });
              }}
              onKeyDown={(event) => {
                if (event.altKey === false && event.ctrlKey === false && event.metaKey === false && event.shiftKey === false) {
                  const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
                  const atEnd = event.currentTarget.selectionStart === activeThread.draft.length && event.currentTarget.selectionEnd === activeThread.draft.length;
                  if (event.key === "ArrowUp" && atStart && navigatePromptHistory(activeThread.id, -1)) { event.preventDefault(); return; }
                  if (event.key === "ArrowDown" && atEnd && navigatePromptHistory(activeThread.id, 1)) { event.preventDefault(); return; }
                }
                if (resolveConversationComposerKeyboardAction({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  isComposing: event.nativeEvent.isComposing,
                }) === "submit") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            {activeThread.draftAttachmentIds.length > 0 ? (
              <div className="attachment-chips" aria-label="Message attachments">
                {activeThread.draftAttachmentIds.map((attachmentId) => (
                  <span className="attachment-chip" key={attachmentId}>
                    {attachments[attachmentId]?.filename ?? "Attachment"}
                    <button type="button" aria-label={`Remove ${attachments[attachmentId]?.filename ?? "attachment"}`} onClick={() => void removeDraftAttachment(attachmentId)}><X size={12} /></button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="composer-actions">
              <div className="composer-actions-left">
                <div className="composer-model-selector">
                  <select
                    aria-label="Conversation model"
                    disabled={modelSelectionLocked}
                    value={`${activeThread.modelConfigurationId}@${activeThread.modelConfigurationRevision}`}
                    onChange={(event) => {
                      const separator = event.target.value.lastIndexOf("@");
                      const id = event.target.value.slice(0, separator);
                      const revision = Number(event.target.value.slice(separator + 1));
                      const configuration = settings?.modelConfigurations.find((entry) => entry.id === id);
                      if (configuration === undefined || Number.isSafeInteger(revision) === false) return;
                      setState((current) => current === undefined
                        ? current
                        : updateRendererThread(current, activeThread.id, (thread) => ({
                            ...thread,
                            modelConfigurationId: configuration.id,
                            modelConfigurationRevision: revision,
                          })));
                    }}
                  >
                    {activeModelConfiguration !== undefined &&
                    (activeModelConfiguration.archivedAt !== undefined ||
                      activeModelConfiguration.currentRevision !== activeThread.modelConfigurationRevision) ? (
                      <option value={`${activeModelConfiguration.id}@${activeThread.modelConfigurationRevision}`}>
                        {activeModelConfiguration.name} · revision {activeThread.modelConfigurationRevision}
                      </option>
                    ) : null}
                    {settings?.modelConfigurations
                      .filter((configuration) => configuration.archivedAt === undefined)
                      .map((configuration) => (
                        <option key={configuration.id} value={`${configuration.id}@${configuration.currentRevision}`}>
                          {configuration.name}
                        </option>
                      ))}
                  </select>
                  <ChevronDown
                    className="composer-model-chevron"
                    size={14}
                    aria-hidden="true"
                  />
                  {activeModelRevision !== undefined ? <small title={activeModelRevision.policy.model}>{activeModelRevision.policy.model}</small> : null}
                </div>
                <button className="icon-button" type="button" title="Attach files" aria-label="Attach files" disabled={activeThread.draftAttachmentIds.length >= 8} onClick={() => void selectAttachments()}>
                  <Paperclip size={16} />
                </button>
                <ConversationWorkflowControl
                  selectedIds={activeThread.enabledWorkflowAppIds}
                  servers={appsDiscovery?.servers ?? []}
                  onChange={(enabledWorkflowAppIds) =>
                    setState((current) => current === undefined
                      ? current
                      : updateRendererThread(current, activeThread.id, (thread) => ({
                          ...thread,
                          enabledWorkflowAppIds,
                        })))}
                  onSetup={(workflowId) => openApps({ kind: "workflow", workflowId })}
                />
              </div>
              <div className="composer-actions-right">
                {composerPolicy.mode === "reply_to_request" ? (
                  <button
                    className="primary-icon-button"
                    type="submit"
                    title="Reply to request"
                    aria-label="Reply to request"
                    disabled={activeThread.draft.trim().length === 0 || operatorActionPending[composerPolicy.item.itemId] === true}
                  >
                    <Send size={17} />
                  </button>
                ) : activeRun === undefined ? (
                  <button
                    className="primary-icon-button"
                    type="submit"
                    title="Send message"
                    aria-label="Send message"
                    disabled={activeThread.draft.trim().length === 0}
                  >
                    <Send size={17} />
                  </button>
                ) : (
                  <>
                    <button className="composer-steer-button" type="button" disabled={activeThread.draft.trim().length === 0} onClick={() => void steerActiveRun()}>Steer now</button>
                    <button className="primary-icon-button" type="submit" title="Queue follow-up" aria-label="Queue follow-up" disabled={activeThread.draft.trim().length === 0}><Send size={17} /></button>
                    <button className="stop-button" type="button" title="Stop run" aria-label="Stop run" onClick={() => void cancelActiveRun()}><Square size={15} fill="currentColor" /></button>
                  </>
                )}
              </div>
            </div>
            </form>
            )}
            </>
          )}
          </main>
        ) : (
          <div className="surface-host" inert={workNavigatorOpen ? true : undefined}>
            {systemError !== undefined ? <div className="surface-error" role="alert"><span>{systemError}</span></div> : null}
            {surfaceErrors[surface] !== undefined ? <div className="surface-error" role="alert"><span>{surfaceErrors[surface]}</span></div> : null}
            {surface === "projects" ? (
              <ProjectWorkspace
                project={selectedProject}
                threads={workNavigatorProjection.groups.find((group) => group.projectPath === selectedProject?.path)?.threads ?? []}
                threadId={localCoreThreadId(activeThread.sessionId)}
                workspace={projectWorkspace}
                openFiles={projectConversationMatchesActiveThread ? activeThread.openFiles : []}
                onChat={(project) => startProjectConversation(project.path)}
                onSelectThread={(threadId) => {
                  setState((current) => current === undefined ? current : selectRendererThread(current, threadId));
                  setSurface("chat");
                }}
                onAttachFile={projectConversationMatchesActiveThread ? (filePath, rootPath, threadId, intent) =>
                  void attachWorkspaceFile(filePath, rootPath, threadId, intent) : undefined
                }
                onOpenFile={projectConversationMatchesActiveThread ? (filePath) =>
                  setState((current) =>
                    current === undefined
                      ? current
                      : updateRendererThread(
                          current,
                          activeThread.id,
                          (thread) => ({
                            ...thread,
                            openFiles: [
                              ...thread.openFiles.filter(
                                (candidate) => candidate !== filePath,
                              ),
                              filePath,
                            ].slice(-20),
                          }),
                        ),
                  ) : undefined
                }
                onError={(error) => setSurfaceError("projects", error)}
              />
            ) : surface === "mission-control" ? (
              missionControlProject?.id !== undefined ? (
                <UnifiedMissionControlWorkspace
                  key={missionControlProject.id}
                  project={{ ...missionControlProject, id: missionControlProject.id }}
                  runtimeHealth={runtimeHealth ?? {
                    state: "degraded",
                    connection: "connecting",
                    summary: "Connecting to Kestrel Local Core…",
                    running: false,
                  }}
                  projects={(settings?.projects ?? []).flatMap((project) =>
                    project.id === undefined ? [] : [{ ...project, id: project.id }]
                  )}
                  onProjectChange={(projectPath) => {
                    setMissionControlProjectPath(projectPath);
                    setSelectedProjectPath(projectPath);
                  }}
                  onProjectResponse={(response) =>
                    registerMissionControlConversations(
                      response,
                      missionControlProject.path,
                    )}
                  onReturnToConversation={() => setSurface("chat")}
                  onOpenConversation={openMissionControlConversation}
                  onError={(error) => setSurfaceError("mission-control", error)}
                />
              ) : (
                <main className="surface-pane unified-mission-control" id="app-main">
                  <section className="unified-mission-empty">
                    <h1>Mission Control</h1>
                    <p>Choose an available project to view and manage its work.</p>
                    {selectedProject?.id !== undefined ? (
                      <button
                        type="button"
                        onClick={() => setMissionControlProjectPath(selectedProject.path)}
                      >
                        Open {selectedProject.label}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void addProject().then((project) => {
                          if (project !== undefined) setMissionControlProjectPath(project.path);
                        })}
                      >
                        Add a project
                      </button>
                    )}
                  </section>
                </main>
              )
            ) : surface === "diff" ? (
              <DiffWorkspace
                key={`${activeThread.id}:${activeThread.diffScopeKind}:${activeThread.diffRevision}`}
                sessionId={activeThread.sessionId}
                threadId={localCoreThreadId(activeThread.sessionId)}
                projectPath={activeThread.projectPath}
                defaultBaseRef={activeThread.workspaceBaseRef}
                initialScopeKind={activeThread.diffScopeKind}
                initialRevision={activeThread.diffRevision}
                initialView={activeThread.diffView}
                onPreferencesChange={(preferences) =>
                  setState((current) =>
                    current === undefined
                      ? current
                      : updateRendererThread(
                          current,
                          activeThread.id,
                          (thread) => ({
                            ...thread,
                            diffScopeKind: preferences.scopeKind,
                            diffRevision: preferences.revision,
                            diffView: preferences.view,
                          }),
                        ),
                  )
                }
                onOpenFile={(filePath, lineNumber) => {
                  const workspaceRoot =
                    activeThreadWorkspace?.workspaceRoot ??
                    activeThread.projectPath;
                  const project = threadProject;
                  if (workspaceRoot && project)
                    void window.kestrelDesktop.openFileEditor({
                      projectPath: workspaceRoot,
                      filePath,
                      projectLabel: project.label,
                      threadId: localCoreThreadId(activeThread.sessionId),
                      ...(lineNumber ? { lineNumber } : {}),
                    });
                }}
                onError={(error) => setSurfaceError("diff", error)}
              />
            ) : surface === "review" ? (
              <ReviewWorkspace
                sessionId={activeThread.sessionId}
                threadId={localCoreThreadId(activeThread.sessionId)}
                defaultBaseRef={activeThread.workspaceBaseRef}
                onOpenFile={(filePath, lineNumber) => {
                  const workspaceRoot =
                    activeThreadWorkspace?.workspaceRoot ??
                    activeThread.projectPath;
                  const project = threadProject;
                  if (workspaceRoot && project)
                    void window.kestrelDesktop.openFileEditor({
                      projectPath: workspaceRoot,
                      filePath,
                      projectLabel: project.label,
                      threadId: localCoreThreadId(activeThread.sessionId),
                      ...(lineNumber ? { lineNumber } : {}),
                    });
                }}
                onError={(error) => setSurfaceError("review", error)}
              />
            ) : surface === "validation" ? (
              <ValidationWorkspace
                sessionId={activeThread.sessionId}
                threadId={localCoreThreadId(activeThread.sessionId)}
                onOpenFile={(filePath, lineNumber) => {
                  const workspaceRoot =
                    activeThreadWorkspace?.workspaceRoot ??
                    activeThread.projectPath;
                  const project = threadProject;
                  if (workspaceRoot && project)
                    void window.kestrelDesktop.openFileEditor({
                      projectPath: workspaceRoot,
                      filePath,
                      projectLabel: project.label,
                      threadId: localCoreThreadId(activeThread.sessionId),
                      ...(lineNumber ? { lineNumber } : {}),
                    });
                }}
                onError={(error) => setSurfaceError("validation", error)}
              />
            ) : surface === "mcp" ? (
              <McpWorkspace
                settings={settings!}
                currentWorkflowIds={activeThread.enabledWorkflowAppIds}
                navigationRequest={appsNavigationRequest}
                onSettings={async (update) => {
                  const saved = await window.kestrelDesktop.saveSettings(update);
                  setSettings(saved);
                  return saved;
                }}
                onWorkflowChange={(enabledWorkflowAppIds) =>
                  setState((current) => current === undefined ? current : updateRendererThread(
                    current,
                    activeThread.id,
                    (thread) => ({ ...thread, enabledWorkflowAppIds }),
                  ))}
                onDiscoveryChange={(result) => {
                  setAppsDiscovery(result);
                  void window.kestrelDesktop.getSettings().then(setSettings).catch(() => undefined);
                }}
                onError={(error) => setSurfaceError("mcp", error)}
              />
            ) : surface === "settings" ? (
              <SettingsWorkspace
                settings={settings!}
                initialCapabilityId={settingsTarget}
                onSettings={async (update) => {
                  const saved = await window.kestrelDesktop.saveSettings(update);
                  setSettings(saved);
                  setState((current) => current === undefined ? current : {
                    ...current,
                    theme: saved.appearanceTheme,
                  });
                  return saved;
                }}
                onOpenApps={openApps}
                onAddProject={async () => { await addProject(); }}
                onCreateUninstallPlan={async (scope, options) =>
                  await window.kestrelDesktop.createUninstallPlan({ scope, options })}
                onApplyUninstallPlan={async (input) =>
                  await window.kestrelDesktop.applyUninstallPlan(input)}
                onRequestMicrophone={async () => { await window.kestrelDesktop.requestMicrophoneAccess(); }}
                onError={(error) => setSurfaceError("settings", error)}
              />
            ) : (
              <DiagnosticsWorkspace
                runtimeHealth={runtimeHealth}
                onRuntimeHealth={setRuntimeHealth}
                onError={(error) => setSurfaceError("diagnostics", error)}
                onOpenReadinessSettings={openReadinessSettings}
              />
            )}
          </div>
        )}

        {showInspector && settings !== undefined ? (
          <ContextSidebar
            thread={activeThread}
            activeRun={activeRun !== undefined}
            inboxItems={operatorInboxItems}
            activity={activeThreadFeedback.activity}
            error={activeThreadFeedback.error}
            errorCapability={activeThreadFeedback.errorCapability}
            onOpenSettings={openCapabilitySettings}
            inert={workNavigatorOpen}
            onResizeStart={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const startX = event.clientX;
              const startWidth = inspectorWidth;
              const move = (pointerEvent: PointerEvent) => {
                setInspectorWidth(clampInspectorWidth(startWidth + startX - pointerEvent.clientX));
              };
              const stop = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", stop);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", stop, { once: true });
            }}
          />
        ) : null}
      </div>

    </div>
  );
}

function EvaluationTechnicalDisclosure({ value }: { value: Record<string, unknown> }) {
  const candidate = typeof value.candidate === "string" ? value.candidate : "";
  const score = typeof value.score === "number" ? value.score : undefined;
  const confidence = typeof value.confidence === "number" ? value.confidence : undefined;
  const rationale = typeof value.rationale === "string" ? value.rationale : undefined;
  const assertions = Array.isArray(value.assertions) ? value.assertions : [];
  const evidenceReferences = Array.isArray(value.evidenceReferences)
    ? value.evidenceReferences.filter((entry): entry is string => typeof entry === "string")
    : [];
  return (
    <div className="evaluation-technical-disclosure">
      <pre>{candidate}</pre>
      {score !== undefined ? <span>Score: {score.toFixed(2)}{confidence !== undefined ? ` · Confidence: ${confidence.toFixed(2)}` : ""}</span> : null}
      {rationale !== undefined ? <p>{rationale}</p> : null}
      {assertions.length > 0 ? <pre>{JSON.stringify(assertions, null, 2)}</pre> : null}
      {evidenceReferences.length > 0 ? <span>Evidence: {evidenceReferences.join(", ")}</span> : null}
    </div>
  );
}

function QueuedFollowUpCard({
  item,
  index,
  threadId,
  pending,
  onAction,
}: {
  item: DesktopFollowUpQueueEntry;
  index: number;
  threadId: string;
  pending: boolean;
  onAction: (request: DesktopOperatorControlRequest) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState(item.message);
  const disabled = pending || item.state === "starting";
  return (
    <div className="queue-item">
      <span>{index + 1}</span>
      {editing ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (message.trim().length === 0) return;
          onAction({ action: "edit_follow_up", threadId, followUpId: item.followUpId, message });
          setEditing(false);
        }}>
          <input aria-label={`Edit queued follow-up ${index + 1}`} value={message} onChange={(event) => setMessage(event.target.value)} />
          <button type="submit" disabled={disabled || message.trim().length === 0}>Save</button>
          <button type="button" onClick={() => { setMessage(item.message); setEditing(false); }}>Cancel</button>
        </form>
      ) : <p>{item.message}</p>}
      <button type="button" disabled={disabled || editing} onClick={() => setEditing(true)}>Edit</button>
      <button type="button" aria-label={`Cancel queued follow-up ${index + 1}`} disabled={disabled} onClick={() => onAction({
        action: "cancel_follow_up",
        threadId,
        followUpId: item.followUpId,
      })}><X size={14} /></button>
    </div>
  );
}

function OperatorActionCard({
  item,
  pending,
  onAction,
}: {
  item: DesktopOperatorInboxItem;
  pending: boolean;
  onAction: (request: DesktopOperatorControlRequest) => void;
}) {
  if (item.actionable === false && item.kind !== "compatibility_downgrade_attention") return null;
  const base = { threadId: item.threadId };
  const proposalId = readString(item.metadata?.proposalId);
  const checkpointAction = isCheckpointAction(item.recommendedAction) ? item.recommendedAction : undefined;
  return (
    <li
      className={`timeline-entry timeline-entry-attention operator-action-${item.kind}`}
      aria-label={item.title}
      aria-live="assertive"
    >
      <TimelineMarker kind="attention" />
      <section className="timeline-entry-content operator-action-card">
        <div><strong>{operatorCardLabel(item.kind)}</strong><p>{item.title}</p>{item.detail !== undefined ? <small>{item.detail}</small> : null}</div>
        <div className="operator-action-buttons">
          {item.kind === "approval_request" && item.requestId !== undefined ? <>
            <button type="button" disabled={pending} onClick={() => onAction({ action: "approve", ...base, requestId: item.requestId })}>Approve</button>
            <button type="button" disabled={pending} onClick={() => onAction({ action: "reject", ...base, requestId: item.requestId })}>Reject</button>
          </> : null}
          {item.kind === "context_checkpoint" && item.checkpointId !== undefined && checkpointAction !== undefined ? (
            <button type="button" disabled={pending} onClick={() => onAction({ action: "resolve_context_checkpoint", ...base, checkpointId: item.checkpointId, actionValue: checkpointAction })}>{checkpointAction.replaceAll("_", " ")}</button>
          ) : null}
          {item.kind === "assembly_change_proposal" && proposalId !== undefined ? <>
            <button type="button" disabled={pending} onClick={() => onAction({ action: "approve_assembly_change", ...base, proposalId })}>Approve change</button>
            <button type="button" disabled={pending} onClick={() => onAction({ action: "reject_assembly_change", ...base, proposalId })}>Reject change</button>
          </> : null}
          {item.kind === "child_thread_blocker" && item.childThreadId !== undefined ? (
            <button type="button" disabled={pending} onClick={() => onAction({ action: "focus_thread", threadId: item.childThreadId! })}>Focus child</button>
          ) : null}
          {item.kind === "stalled_thread_attention" ? (
            <>
              <button type="button" disabled={pending} onClick={() => onAction({ action: "retry", ...base })}>Retry</button>
              <button type="button" disabled={pending} onClick={() => onAction({ action: "continue_waiting", ...base })}>Continue waiting</button>
            </>
          ) : null}
          {item.kind === "fan_in_checkpoint" && item.checkpointId !== undefined ? <>
            <button type="button" disabled={pending} onClick={() => onAction({ action: "resolve_fan_in_checkpoint", ...base, checkpointId: item.checkpointId, actionValue: "accept" })}>Accept</button>
            <button type="button" disabled={pending} onClick={() => onAction({ action: "resolve_fan_in_checkpoint", ...base, checkpointId: item.checkpointId, actionValue: "defer" })}>Defer</button>
          </> : null}
          {(item.kind === "child_outcome_review" || item.kind === "compatibility_downgrade_attention") ? (
            <button type="button" disabled={pending} onClick={() => onAction({ action: "focus_thread", threadId: item.childThreadId ?? item.threadId })}>Focus thread</button>
          ) : null}
        </div>
      </section>
    </li>
  );
}

function localCoreThreadId(sessionId: string): string {
  return `thread-main:${sessionId}`;
}

function operatorCardLabel(kind: DesktopOperatorInboxItem["kind"]): string {
  return kind.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function isCheckpointAction(value: string | undefined): value is NonNullable<DesktopOperatorControlRequest["actionValue"]> {
  return value === "continue" || value === "compact" || value === "summarize_forward" || value === "handoff" || value === "split_into_child_thread" || value === "operator_checkpoint";
}

function describeRunnerActivity(event: DesktopRunnerEvent): string {
  if (event.type === "run.started") {
    return "Running";
  }
  const liveActivity = describeDesktopRunnerActivity(event);
  if (liveActivity.length > 0) {
    return liveActivity;
  }
  if (event.type === "run.model.reasoning.delta") {
    const update = asRecord(event.payload.update);
    if (update?.contentState === "not_retained")
      return "Provider reasoning was not retained";
    const label =
      update?.format === "summary"
        ? "Provider reasoning summary"
        : update?.format === "provider_thinking"
          ? "Provider-visible thinking"
          : "Provider reasoning";
    return `${label} (attempt ${String(update?.attempt ?? 1)}): ${readString(update?.delta) ?? "Thinking"}`;
  }
  if (event.type === "run.model.reasoning.unavailable") {
    return "Provider reasoning unavailable for this model";
  }
  if (
    event.type === "run.tool.started" ||
    event.type === "run.tool.completed" ||
    event.type === "run.tool.failed"
  ) {
    const payload = asRecord(event.payload);
    const update = asRecord(payload?.update);
    return (
      readString(update?.toolName) ??
      readString(payload?.toolName) ??
      "Using tool"
    );
  }
  if (event.type === "run.completed") {
    return "Ready";
  }
  if (event.type === "run.failed") {
    return "Run failed";
  }
  if (event.type === "run.cancelled") {
    return "Cancelled";
  }
  return "Working";
}

function extractTerminalMessage(event: DesktopRunnerEvent): string | undefined {
  if (event.type !== "run.completed") {
    return;
  }
  const result = asRecord(event.payload.result);
  return typeof result?.assistantText === "string" ? result.assistantText : undefined;
}

function getDesktopTerminalFailureMessage(output: unknown): string | undefined {
  const errors = asRecord(output)?.errors;
  if (!Array.isArray(errors)) return undefined;
  return readString(asRecord(errors[0])?.message);
}

function getDesktopTerminalWaitingPrompt(waitFor: unknown): string | undefined {
  const record = asRecord(waitFor);
  return readString(record?.prompt) ?? readString(asRecord(record?.interaction)?.prompt);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function modeLabel(mode: RendererMode): string {
  return mode === "chat" ? "Chat" : mode === "plan" ? "Plan" : "Build";
}

function runtimeHealthLabel(state: DesktopRuntimeHealth["state"]): string {
  if (state === "healthy") return "Runtime ready";
  if (state === "blocked") return "Runtime blocked";
  return "Runtime degraded";
}

function surfacePageTitle(surface: DesktopSurface): string {
  if (surface === "chat") {
    return "Conversation";
  }
  if (surface === "projects") {
    return "Projects";
  }
  if (surface === "mission-control") {
    return "Mission control";
  }
  if (surface === "diff") {
    return "Diff";
  }
  if (surface === "review") return "Review";
  if (surface === "validation") return "Validation";
  if (surface === "mcp") return "Apps";
  return surface === "settings" ? "Settings" : "Diagnostics";
}

function isConversationOwnedSurface(surface: DesktopSurface): boolean {
  return surface === "diff" || surface === "review" || surface === "validation";
}

function parseDesktopSurface(value: string | undefined): DesktopSurface {
  return value === "mission-control" ||
    value === "projects" ||
    value === "diff" ||
    value === "review" ||
    value === "validation" ||
    value === "mcp" ||
    value === "settings" ||
    value === "diagnostics"
    ? value
    : "chat";
}

function clampInspectorWidth(value: number): number {
  return Number.isFinite(value)
    ? Math.max(240, Math.min(520, Math.round(value)))
    : 288;
}

function readDesktopSidebarState(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function writeDesktopSidebarState(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Sidebar preferences are optional; the workspace remains usable without them.
  }
}

function readStoredSelectedProjectPath(): string | undefined {
  try {
    const stored = window.localStorage.getItem(SELECTED_PROJECT_KEY);
    return stored ?? undefined;
  } catch {
    return undefined;
  }
}

function writeDesktopSelectedProjectPath(projectPath: string | undefined): void {
  try {
    if (projectPath === undefined) window.localStorage.removeItem(SELECTED_PROJECT_KEY);
    else window.localStorage.setItem(SELECTED_PROJECT_KEY, projectPath);
  } catch {
    // Project context persistence is optional; project selection remains usable.
  }
}

function readDesktopSidebarWidth(): number {
  try {
    const storedWidth = window.localStorage.getItem(INSPECTOR_WIDTH_KEY);
    return storedWidth === null ? 288 : clampInspectorWidth(Number(storedWidth));
  } catch {
    return 288;
  }
}

function providerLabel(
  provider: DesktopRendererSettings["selectedProvider"],
): string {
  if (provider === "openrouter") {
    return "OpenRouter";
  }
  if (provider === "openai") {
    return "OpenAI";
  }
  if (provider === "anthropic") {
    return "Anthropic";
  }
  return provider === "ollama" ? "Ollama" : "LM Studio";
}

function formatBytes(value: number): string {
  return value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/u).at(-1) ?? filePath;
}

function desktopTextMimeType(
  language: string | undefined,
  viewKind: string,
): string {
  if (viewKind === "markdown") {
    return "text/markdown";
  }
  if (language === "json") {
    return "application/json";
  }
  return "text/plain";
}

async function sha256Hex(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function buildManagedWorkspaceSetup(thread: RendererThread) {
  const approvedIgnoredFiles = thread.workspaceSetupIgnoredFiles
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const executable = thread.workspaceSetupExecutable.trim();
  const args = thread.workspaceSetupArgs
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (approvedIgnoredFiles.length === 0 && executable.length === 0) {
    return;
  }
  return {
    approvedIgnoredFiles,
    steps:
      executable.length === 0
        ? []
        : [
            {
              id: "desktop-environment-setup",
              label: "Desktop environment setup",
              executable,
              args,
            },
          ],
  };
}
