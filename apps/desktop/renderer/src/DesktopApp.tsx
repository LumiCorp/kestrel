import {
  Folder,
  GitPullRequest,
  KeyRound,
  ListChecks,
  MessageSquare,
  Moon,
  MonitorPlay,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Plug,
  Search,
  Send,
  Settings,
  Square,
  Sun,
  TerminalSquare,
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

import type {
  DesktopCapabilityId,
  DesktopReadinessItemId,
  DesktopAttachmentMetadata,
  DesktopFollowUpQueueEntry,
  DesktopOperatorControlRequest,
  DesktopOperatorInboxItem,
  DesktopRendererSettings,
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
import { GitWorkspace } from "./GitWorkspace";
import { McpWorkspace } from "./McpWorkspace";
import { MissionControlWorkspace } from "./MissionControlWorkspace";
import {
  extractDesktopTerminalOutcome,
  getDesktopOutcomeHandoff,
  OutcomeHandoff,
  withDesktopOutcomeWorkspaceChanges,
} from "./outcomeHandoff";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { PreviewWorkspace } from "./PreviewWorkspace";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { TerminalWorkspace } from "./TerminalWorkspace";
import { ValidationWorkspace } from "./ValidationWorkspace";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { getDesktopComposerSubmissionPolicy } from "./composerPolicy";
import {
  describeDesktopRunnerActivity,
  projectDesktopConversationTimeline,
  projectDesktopRunStream,
  type DesktopRunStreamItem,
} from "./runStream";
import { ContextSidebar } from "./ContextSidebar";
import { ConversationExplorer } from "./ConversationExplorer";
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
  addRendererThread,
  addRendererDraftAttachment,
  archiveRendererThread,
  appendRendererTranscript,
  acceptRendererPrompt,
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

interface PendingTurnSubmission {
  threadId: string;
  message: string;
  submittedAt: string;
  projectPath?: string | undefined;
}

type DesktopSurface =
  | "chat"
  | "mission-control"
  | "projects"
  | "diff"
  | "review"
  | "validation"
  | "git"
  | "preview"
  | "terminal"
  | "mcp"
  | "settings"
  | "diagnostics";
const SURFACE_STATE_KEY = "kestrel:desktop:surface:v1" as const;
const INSPECTOR_STATE_KEY = "kestrel:desktop:inspector-open:v1" as const;
const INSPECTOR_WIDTH_KEY = "kestrel:desktop:inspector-width:v1" as const;

export function DesktopApp() {
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
  const [missionControlRevision, setMissionControlRevision] = useState(0);
  const [missionControlRunId, setMissionControlRunId] = useState<string>();
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>();
  const [timelineHasNewActivity, setTimelineHasNewActivity] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const timelineFollowingRef = useRef(true);
  const workNavigatorRef = useRef<HTMLElement>(null);
  const workNavigatorSearchRef = useRef<HTMLInputElement>(null);
  const workNavigatorTriggerRef = useRef<HTMLElement | null>(null);
  const workNavigatorFallbackRef = useRef<HTMLButtonElement>(null);
  const threadsRef = useRef<DesktopRendererState["threads"]>([]);
  const pendingTurnSubmissionsRef = useRef<Record<string, PendingTurnSubmission>>({});
  const acceptedTurnSessionsRef = useRef(new Set<string>());
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

  useEffect(() => {
    if (activeThread?.archivedAt !== undefined) setSurface("chat");
  }, [activeThread?.archivedAt]);

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
    : activeRuns[activeThread.id] ?? (threadViews[activeThread.id]?.activeRun?.status === "RUNNING"
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
  const composerPolicy = getDesktopComposerSubmissionPolicy({
    inboxItems: operatorInboxItems,
    runActive: activeRun !== undefined,
  });
  const operatorActionCardItems = operatorInboxItems.filter(
    (item) => item.kind !== "user_input_request",
  );
  const activeRunStream = activeThread === undefined ? [] : runStreams[activeThread.id] ?? [];
  const activeThreadFeedback = activeThread === undefined
    ? { activity: "Ready" }
    : threadFeedback[activeThread.id] ?? { activity: "Ready" };
  const conversationTimeline = activeThread === undefined
    ? []
    : projectDesktopConversationTimeline(activeThread.transcript, activeRunStream);

  useEffect(() => {
    threadsRef.current = state?.threads ?? [];
  }, [state?.threads]);

  function setActiveRuns(update: (current: Record<string, ActiveRun>) => Record<string, ActiveRun>): void {
    setAuthorityCaches((current) => ({ ...current, activeRuns: update(current.activeRuns) }));
  }

  function setThreadViews(update: (current: DesktopAuthorityCaches["threadViews"]) => DesktopAuthorityCaches["threadViews"]): void {
    setAuthorityCaches((current) => ({ ...current, threadViews: update(current.threadViews) }));
  }

  function setThreadActivity(threadId: string, activity: string): void {
    setThreadFeedback((current) => updateDesktopThreadFeedback(current, threadId, { activity }));
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
      window.kestrelDesktop.getUiState(),
      window.kestrelDesktop.getSettings(),
      window.kestrelDesktop.getRuntimeHealth(),
    ]).then(([uiState, nextSettings, health]) => {
      if (disposed) {
        return;
      }
      const defaultConfiguration = nextSettings.modelConfigurations.find(
        (configuration) => configuration.id === nextSettings.defaultModelConfigurationId,
      );
      const rendererState = readDesktopRendererState(uiState, {
        modelConfigurationId: defaultConfiguration?.id,
        modelConfigurationRevision: defaultConfiguration?.currentRevision,
        enabledAppIds: nextSettings.defaultEnabledAppIds,
        theme: nextSettings.appearanceTheme,
      });
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
      setSelectedProjectPath((current) => current ?? nextSettings.projects[0]?.path);
      setRuntimeHealth(health);
    }).catch((cause) => {
      if (disposed === false) {
        setSystemError(errorMessage(cause));
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => window.kestrelDesktop.onRunnerEvent((event) => {
      const rendererThread = event.sessionId === undefined
        ? undefined
        : threadsRef.current.find((thread) => thread.sessionId === event.sessionId);
      if (rendererThread !== undefined) {
        setThreadActivity(rendererThread.id, describeRunnerActivity(event));
      }
      if (event.type === "run.started" && rendererThread !== undefined) {
        const pendingSubmission = pendingTurnSubmissionsRef.current[rendererThread.sessionId];
        if (pendingSubmission !== undefined) {
          delete pendingTurnSubmissionsRef.current[rendererThread.sessionId];
          acceptedTurnSessionsRef.current.add(rendererThread.sessionId);
          setState((current) => {
            if (current === undefined) return current;
            const accepted = acceptRendererPrompt(current, pendingSubmission.threadId, pendingSubmission.message);
            const withUser = appendRendererTranscript(accepted, pendingSubmission.threadId, {
              role: "user",
              text: pendingSubmission.message,
              timestamp: pendingSubmission.submittedAt,
            });
            return updateRendererThread(withUser, pendingSubmission.threadId, (thread) => ({
              ...thread,
              pendingWaitEventType: undefined,
              ...(pendingSubmission.projectPath !== undefined ? { projectPath: pendingSubmission.projectPath } : {}),
            }));
          });
          setHistoryNavigation((current) => {
            const next = { ...current };
            delete next[pendingSubmission.threadId];
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
        setMissionControlRevision((value) => value + 1);
        if (rendererThread !== undefined && event.type !== "task.updated") {
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

  useEffect(() => {
    if (state === undefined) {
      return;
    }
    const resolvedTheme = state.theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : state.theme;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
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
  }, [activeThread?.id, missionControlRevision]);

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
    }
    return result;
  }

  async function submitTurn(event: FormEvent): Promise<void> {
    event.preventDefault();
    const message = activeThread?.draft ?? "";
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
    clearThreadError(threadId);
    if (composerPolicy.mode === "reply_to_request") {
      const { item } = composerPolicy;
      pendingTurnSubmissionsRef.current[activeThread.sessionId] = { threadId, message, submittedAt, projectPath };
      setOperatorActionPending((current) => ({ ...current, [item.itemId]: true }));
      setThreadActivity(threadId, "Sending reply");
      try {
        const view = await window.kestrelDesktop.submitOperatorControl({
          action: "reply",
          threadId: localCoreThreadId(activeThread.sessionId),
          completionMode: "accepted",
          requestId: item.requestId,
          message,
          attachmentIds: activeThread.draftAttachmentIds,
          interactionMode: activeThread.mode,
          ...(activeThread.mode === "build" ? { actSubmode: "safe" } : {}),
        });
        setThreadViews((current) => ({ ...current, [threadId]: view }));
        setActiveRuns((current) => {
          const next = { ...current };
          if (view.activeRun?.status === "RUNNING") {
            next[threadId] = {
              threadId,
              sessionId: activeThread.sessionId,
              runId: view.activeRun.runId,
            };
          } else {
            delete next[threadId];
          }
          return next;
        });
        if (pendingTurnSubmissionsRef.current[activeThread.sessionId] !== undefined) {
          delete pendingTurnSubmissionsRef.current[activeThread.sessionId];
          setState((current) => {
            if (current === undefined) return current;
            const accepted = acceptRendererPrompt(current, threadId, message);
            const withReply = appendRendererTranscript(accepted, threadId, {
              role: "user",
              text: message,
              timestamp: submittedAt,
            });
            return updateRendererThread(withReply, threadId, (thread) => ({
              ...thread,
              pendingWaitEventType: undefined,
            }));
          });
        }
        setHistoryNavigation((current) => { const next = { ...current }; delete next[threadId]; return next; });
        setThreadActivity(threadId, view.activeRun?.status === "RUNNING" ? "Reply sent; run resumed" : "Reply sent");
      } catch (cause) {
        delete pendingTurnSubmissionsRef.current[activeThread.sessionId];
        setThreadFailure(threadId, "Reply not sent", errorMessage(cause));
      } finally {
        acceptedTurnSessionsRef.current.delete(activeThread.sessionId);
        setOperatorActionPending((current) => ({ ...current, [item.itemId]: false }));
      }
      return;
    }
    if (composerPolicy.mode === "queue_follow_up") {
      setThreadActivity(threadId, "Queueing follow-up");
      try {
        const view = await window.kestrelDesktop.submitOperatorControl({
          action: "enqueue_follow_up",
          threadId: localCoreThreadId(activeThread.sessionId),
          followUpId: `follow-up-${crypto.randomUUID()}`,
          message,
          attachmentIds: activeThread.draftAttachmentIds,
          interactionMode: activeThread.mode,
          ...(activeThread.mode === "build" ? { actSubmode: "safe" } : {}),
        });
        setThreadViews((current) => ({ ...current, [threadId]: view }));
        setState((current) => current === undefined ? current : acceptRendererPrompt(current, threadId, message));
        setHistoryNavigation((current) => { const next = { ...current }; delete next[threadId]; return next; });
        setThreadActivity(threadId, "Follow-up queued");
      } catch (cause) {
        setThreadFailure(threadId, "Follow-up not queued", errorMessage(cause));
      }
      return;
    }

    setThreadActivity(threadId, "Starting run");
    pendingTurnSubmissionsRef.current[activeThread.sessionId] = { threadId, message, submittedAt, projectPath };
    setActiveRuns((current) => ({ ...current, [threadId]: { threadId, sessionId: activeThread.sessionId } }));

    try {
      const terminal = await window.kestrelDesktop.runTurn({
        sessionId: activeThread.sessionId,
        threadId: localCoreThreadId(activeThread.sessionId),
        message,
        eventType: continuation.eventType,
        ...(continuation.resumeFromWait === true
          ? { resumeFromWait: true }
          : {}),
        ...(continuation.resumeBlockedRun === true
          ? { resumeBlockedRun: true }
          : {}),
        history,
        interactionMode: activeThread.mode,
        workspaceMode: activeThread.workspaceMode,
        ...(activeThread.workspaceMode === "managed"
          ? { workspaceBaseRef: activeThread.workspaceBaseRef }
          : {}),
        attachmentIds: activeThread.draftAttachmentIds,
        ...(projectPath !== undefined
          ? { projectPath }
          : {}),
        ...(activeThread.workspaceMode === "managed" &&
        workspaceSetup !== undefined
          ? { workspaceSetup }
          : {}),
        ...(activeThread.mode === "build" ? { actSubmode: "safe" } : {}),
        executionSelection: toDesktopExecutionSelection(
          activeThread,
          settings.apps,
          settings.defaultEnabledAppIds,
        ),
      });
      const assistantText = extractTerminalMessage(terminal);
      const rawTerminalOutcome = extractDesktopTerminalOutcome(terminal);
      const terminalOutcome =
        rawTerminalOutcome?.terminalEvent === "run.completed" &&
        rawTerminalOutcome.resultStatus === "COMPLETED" &&
        projectPath !== undefined
          ? withDesktopOutcomeWorkspaceChanges(
              rawTerminalOutcome,
              await window.kestrelDesktop
                .getWorkspaceLifecycle(localCoreThreadId(activeThread.sessionId))
                .catch(() => ({ checkpoints: [] })),
            )
          : rawTerminalOutcome;
      const terminalFailure = extractTerminalFailure(terminal, settings?.selectedProvider);
      const terminalError = terminalFailure?.message;
      const pendingWaitEventType = getTerminalWaitEventType(terminal);
      const waitingPrompt = getTerminalWaitingPrompt(terminal);
      const terminalLine =
        assistantText !== undefined
          ? {
              role: "assistant" as const,
              text: assistantText,
              timestamp: new Date().toISOString(),
              ...(terminalOutcome !== undefined ? { data: terminalOutcome } : {}),
            }
          : terminalOutcome?.terminalEvent === "run.completed" &&
              terminalOutcome.resultStatus === "COMPLETED"
            ? {
                role: "system" as const,
                text: "Run completed.",
                timestamp: new Date().toISOString(),
                data: terminalOutcome,
              }
          : undefined;
      const acceptedFromEvent = acceptedTurnSessionsRef.current.delete(activeThread.sessionId);
      setState((current) => {
        if (current === undefined) return current;
        const withUser = acceptedFromEvent
          ? current
          : appendRendererTranscript(
              acceptRendererPrompt(current, threadId, message),
              threadId,
              { role: "user", text: message, timestamp: submittedAt },
            );
        const withTerminal = terminalLine === undefined ? withUser : appendRendererTranscript(withUser, threadId, terminalLine);
        return updateRendererThread(withTerminal, threadId, (thread) => ({
          ...thread,
          ...(projectPath !== undefined ? { projectPath } : {}),
          pendingWaitEventType,
        }));
      });
      setHistoryNavigation((current) => { const next = { ...current }; delete next[threadId]; return next; });
      if (terminalError !== undefined) {
        setThreadFailure(threadId, "Run failed", terminalError, terminalFailure?.capabilityId);
      }
      setThreadActivity(
        threadId,
        terminal.type === "run.failed"
          ? "Run failed"
          : pendingWaitEventType !== undefined
            ? `Waiting for ${pendingWaitEventType}`
            : terminal.type === "run.cancelled"
              ? "Cancelled"
              : "Ready",
      );
    } catch (cause) {
      if (submittedPendingWaitEventType !== undefined) {
        setState((current) =>
          current === undefined
            ? current
            : updateRendererThread(current, threadId, (thread) => ({
                ...thread,
                pendingWaitEventType: submittedPendingWaitEventType,
              })),
        );
      }
      delete pendingTurnSubmissionsRef.current[activeThread.sessionId];
      acceptedTurnSessionsRef.current.delete(activeThread.sessionId);
      setThreadFailure(threadId, "Run failed", errorMessage(cause));
    } finally {
      delete pendingTurnSubmissionsRef.current[activeThread.sessionId];
      setActiveRuns((current) => { const next = { ...current }; delete next[threadId]; return next; });
      void refreshThreadAuthority(activeThread).catch((cause) => {
        setThreadFailure(activeThread.id, "Thread status unavailable", errorMessage(cause));
      });
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

  async function attachTerminalOutput(
    text: string,
    terminal: import("../../src/contracts").DesktopUserTerminal,
  ): Promise<void> {
    if (activeThread === undefined || text.length === 0) {
      return;
    }
    const ownerThread = activeThread;
    if (ownerThread.draftAttachmentIds.length >= 8) {
      setThreadFailure(ownerThread.id, "Attachment not added", "A message can include at most 8 attachments.");
      return;
    }
    try {
      const bytes = new TextEncoder().encode(text);
      const attachment = await importGeneratedAttachment(ownerThread, {
        filename: `terminal-${terminal.terminalId.slice(0, 8)}.txt`,
        mimeType: "text/plain",
        sha256: await sha256Hex(bytes),
        bytes,
      });
      setState((current) => current === undefined ? current : addRendererDraftAttachment(current, ownerThread.id, {
        attachmentId: attachment.attachmentId,
        generatedDraft: "Please review the attached terminal output.",
      }));
      setSurface("chat");
      clearThreadError(ownerThread.id);
    } catch (cause) {
      setThreadFailure(ownerThread.id, "Attachment not added", errorMessage(cause));
    }
  }

  async function attachVisualFeedback(input: {
    dataUrl: string;
    filename: string;
    comment: string;
    runId: string;
    url: string;
    region?:
      | { x: number; y: number; width: number; height: number }
      | undefined;
  }): Promise<void> {
    if (activeThread === undefined) return;
    const ownerThread = activeThread;
    if (ownerThread.draftAttachmentIds.length >= 8) {
      setThreadFailure(ownerThread.id, "Attachment not added", "A message can include at most 8 attachments.");
      return;
    }
    try {
      const match = /^data:image\/png;base64,(.+)$/u.exec(input.dataUrl);
      if (!match) throw new Error("Preview screenshot is not a PNG attachment.");
      const binary = atob(match[1]!);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("Preview screenshot exceeds the 5 MB attachment limit.");
      const attachment = await importGeneratedAttachment(ownerThread, {
        filename: input.filename,
        mimeType: "image/png",
        sha256: await sha256Hex(bytes),
        bytes,
      });
      const prompt = [
        input.comment,
        "",
        `Preview evidence: run ${input.runId}`,
        `URL: ${input.url}`,
        ...(input.region
          ? [`Annotated region: x=${input.region.x.toFixed(3)}, y=${input.region.y.toFixed(3)}, width=${input.region.width.toFixed(3)}, height=${input.region.height.toFixed(3)}`]
          : []),
      ].join("\n");
      setState((current) => current === undefined ? current : addRendererDraftAttachment(current, ownerThread.id, {
        attachmentId: attachment.attachmentId,
        generatedDraft: prompt,
        replaceDraft: true,
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
      const view = await window.kestrelDesktop.submitOperatorControl({
        action: "steer",
        threadId: localCoreThreadId(ownerThread.sessionId),
        message,
        attachmentIds: ownerThread.draftAttachmentIds,
      });
      setThreadViews((current) => ({ ...current, [ownerThread.id]: view }));
      setState((current) => current === undefined ? current : acceptRendererPrompt(current, ownerThread.id, message));
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
      const view = await window.kestrelDesktop.submitOperatorControl(request);
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

  async function addProject(): Promise<void> {
    if (settings === undefined) {
      return;
    }
    const project = await window.kestrelDesktop.pickProjectFolder();
    if (project === undefined) {
      return;
    }
    const projects = [
      ...settings.projects.filter((entry) => entry.path !== project.path),
      project,
    ];
    const saved = await window.kestrelDesktop.saveSettings({ projects });
    setSettings(saved);
    setSelectedProjectPath(project.path);
  }

  function newConversation(projectPath: string | null = activeThreadWorkspace?.sourceWorkspaceRoot ?? activeThread?.projectPath ?? null): void {
    const defaultConfiguration = settings?.modelConfigurations.find(
      (configuration) => configuration.id === settings.defaultModelConfigurationId,
    );
    setState((current) => current === undefined ? current : addRendererThread(current, {
      ...(projectPath !== null ? { projectPath } : {}),
      modelConfigurationId: defaultConfiguration?.id,
      modelConfigurationRevision: defaultConfiguration?.currentRevision,
      enabledAppIds: settings?.defaultEnabledAppIds,
    }));
    setSurface("chat");
  }

  function startProjectConversation(projectPath: string): void {
    newConversation(projectPath);
  }

  function openWorkSurface(nextSurface: DesktopSurface): void {
    setMissionControlRunId(undefined);
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
    setMissionControlRunId(runId);
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
    setSettingsTarget(target);
    setSurface("settings");
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
  const archivedThreadSelected = activeThread.archivedAt !== undefined;
  const activeModelConfiguration = settings?.modelConfigurations.find(
    (configuration) => configuration.id === activeThread.modelConfigurationId,
  );
  const activeModelRevision = activeModelConfiguration?.revisions.find(
    (revision) => revision.revision === activeThread.modelConfigurationRevision,
  );
  const modelSelectionLocked = archivedThreadSelected
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
  const projectWorkspace =
    selectedProject !== undefined &&
    activeThreadWorkspace?.sourceWorkspaceRoot === selectedProject.path
      ? activeThreadWorkspace
      : undefined;
  const conversationProjectLabel = threadProject?.label
    ?? (threadProjectPath === undefined ? "No project" : "Unavailable project");
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
          <span>{conversationProjectLabel}</span>
        </button>
        <div
          className="titlebar-context"
          title={`${activeThread.title} · ${conversationProjectLabel} · ${surfacePageTitle(surface)}`}
        >
          <span className="titlebar-thread-context">
            <strong className="titlebar-thread-title">{activeThread.title}</strong>
            <small>{conversationProjectLabel}</small>
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
              className="details-button"
              type="button"
              title={inspectorOpen ? "Close details" : "Open details"}
              aria-label={inspectorOpen ? "Close details" : "Open details"}
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
            <span className="surface-tabs-heading">Work</span>
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
              disabled={archivedThreadSelected}
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
              <span>Project files</span>
            </button>
            <button
              className={surface === "git" ? "active" : ""}
              type="button"
              disabled={archivedThreadSelected}
              title="Git and pull requests"
              aria-label="Git and pull requests"
              onClick={() => openWorkSurface("git")}
            >
              <GitPullRequest size={17} />
              <span>Git and pull requests</span>
            </button>
            <button
              className={surface === "preview" ? "active" : ""}
              type="button"
              disabled={archivedThreadSelected}
              title="Preview"
              aria-label="Preview"
              onClick={() => openWorkSurface("preview")}
            >
              <MonitorPlay size={17} />
              <span>Preview</span>
            </button>
            <button
              className={surface === "terminal" ? "active" : ""}
              type="button"
              disabled={archivedThreadSelected}
              title="Terminal"
              aria-label="Terminal"
              onClick={() => openWorkSurface("terminal")}
            >
              <TerminalSquare size={17} />
              <span>Terminal</span>
            </button>
            <span className="surface-tabs-heading">Configure</span>
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
          </nav>

          <ConversationExplorer
              threads={state.threads}
              activeThreadId={state.activeThreadId}
              projects={settings?.projects ?? []}
              searchInputRef={workNavigatorSearchRef}
              onSelect={(threadId) => {
                setState((current) => current === undefined ? current : selectRendererThread(current, threadId));
                setSurface("chat");
                closeWorkNavigator();
              }}
              onNewConversation={() => {
                newConversation();
                closeWorkNavigator();
              }}
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
                    enabledAppIds: settings?.defaultEnabledAppIds,
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
            activity={activeThreadFeedback.activity}
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
                  onViewChecks={() => setSurface("validation")}
                  onInspectRun={inspectOutcomeRun}
                />
              );
            }}
            tail={(
              <>
                {!archivedThreadSelected && composerPolicy.mode === "reply_to_request" ? (
                  <li
                    className="timeline-entry timeline-entry-attention timeline-entry-user-request"
                    aria-live="assertive"
                  >
                    <TimelineMarker kind="attention" />
                    <section className="timeline-entry-content operator-action-card" aria-label={composerPolicy.item.title}>
                      <div>
                        <strong>Kestrel needs your input</strong>
                        <p>{composerPolicy.item.title}</p>
                        {composerPolicy.item.detail !== undefined ? <small>{composerPolicy.item.detail}</small> : null}
                      </div>
                    </section>
                  </li>
                ) : null}

                {!archivedThreadSelected && threadViews[activeThread.id]?.followUpQueue.items.length ? (
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
                      {threadViews[activeThread.id]?.followUpQueue.items.map((item, index) => (
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

                {!archivedThreadSelected ? operatorActionCardItems.map((item) => (
                  <OperatorActionCard
                    key={item.itemId}
                    item={item}
                    pending={operatorActionPending[item.itemId] === true}
                    onAction={(request) => void submitOperatorAction(item.itemId, request)}
                  />
                )) : null}

                {archivedThreadSelected ? (
                  <li className="timeline-entry timeline-entry-archived">
                    <TimelineMarker kind="attention" />
                    <section className="timeline-entry-content archived-conversation-banner" aria-label="Archived conversation">
                      <div><strong>Archived conversation</strong><span>This transcript is read-only.</span></div>
                      <button className="primary-button" type="button" onClick={() => {
                        setState((current) => current === undefined ? current : restoreRendererThread(current, activeThread.id));
                      }}>Restore conversation</button>
                    </section>
                  </li>
                ) : null}
              </>
            )}
          />

          {archivedThreadSelected ? null : <form className="composer" onSubmit={(event) => void submitTurn(event)}>
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
                if (event.key === "Enter" && event.shiftKey === false) {
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
                <label className="composer-model-selector">
                  <span>Model</span>
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
                  {activeModelRevision !== undefined ? <small title={activeModelRevision.policy.model}>{activeModelRevision.policy.model}</small> : null}
                </label>
                <span className="composer-mode-label">{activeThread.mode === "build" ? "Safe build" : modeLabel(activeThread.mode)}</span>
                <button className="icon-button" type="button" title="Attach files" aria-label="Attach files" disabled={activeThread.draftAttachmentIds.length >= 8} onClick={() => void selectAttachments()}>
                  <Paperclip size={16} />
                </button>
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
            </form>}
          </main>
        ) : (
          <div className="surface-host" inert={workNavigatorOpen ? true : undefined}>
            {systemError !== undefined ? <div className="surface-error" role="alert"><span>{systemError}</span></div> : null}
            {surfaceErrors[surface] !== undefined ? <div className="surface-error" role="alert"><span>{surfaceErrors[surface]}</span></div> : null}
            {surface === "projects" ? (
              <ProjectWorkspace
                project={selectedProject}
                threadId={localCoreThreadId(activeThread.sessionId)}
                workspace={projectWorkspace}
                openFiles={activeThread.openFiles}
                onChat={(project) => startProjectConversation(project.path)}
                onAttachFile={(filePath, rootPath, threadId, intent) =>
                  void attachWorkspaceFile(filePath, rootPath, threadId, intent)
                }
                onOpenFile={(filePath) =>
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
                  )
                }
                onError={(error) => setSurfaceError("projects", error)}
              />
            ) : surface === "mission-control" ? (
              <MissionControlWorkspace
                sessionId={activeThread.sessionId}
                project={threadProject}
                refreshVersion={missionControlRevision}
                initialRunId={missionControlRunId}
                onError={(error) => setSurfaceError("mission-control", error)}
              />
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
            ) : surface === "terminal" ? (
              <TerminalWorkspace
                sessionId={activeThread.sessionId}
                threadId={localCoreThreadId(activeThread.sessionId)}
                onAttachOutput={attachTerminalOutput}
                onError={(error) => setSurfaceError("terminal", error)}
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
            ) : surface === "git" ? (
              <GitWorkspace
                sessionId={activeThread.sessionId}
                threadId={localCoreThreadId(activeThread.sessionId)}
                defaultBaseRef={activeThread.workspaceBaseRef}
                executionSelection={toDesktopExecutionSelection(
                  activeThread,
                  settings?.apps ?? [],
                  settings?.defaultEnabledAppIds ?? [],
                )}
                onError={(error) => setSurfaceError("git", error)}
              />
            ) : surface === "preview" ? (
              <PreviewWorkspace
                projectPath={threadProjectPath}
                threadId={localCoreThreadId(activeThread.sessionId)}
                onAttachVisualFeedback={attachVisualFeedback}
                onError={(error) => setSurfaceError("preview", error)}
              />
            ) : surface === "mcp" ? (
              <McpWorkspace onError={(error) => setSurfaceError("mcp", error)} />
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
                    ...(update.defaultEnabledAppIds === undefined ? {} : {
                      threads: current.threads.map((thread) => ({
                        ...thread,
                        enabledAppIds: [...saved.defaultEnabledAppIds],
                      })),
                    }),
                  });
                  return saved;
                }}
                onOpenMcp={() => setSurface("mcp")}
                onAddProject={async () => { await addProject(); }}
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
  return readString(result?.assistantText);
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
  if (surface === "terminal") {
    return "Terminal";
  }
  if (surface === "diff") {
    return "Diff";
  }
  if (surface === "review") return "Review";
  if (surface === "validation") return "Validation";
  if (surface === "git") return "Git and pull requests";
  if (surface === "preview") return "Preview";
  if (surface === "mcp") return "Apps";
  return surface === "settings" ? "Settings" : "Diagnostics";
}

function parseDesktopSurface(value: string | undefined): DesktopSurface {
  return value === "mission-control" ||
    value === "projects" ||
    value === "diff" ||
    value === "review" ||
    value === "validation" ||
    value === "git" ||
    value === "preview" ||
    value === "terminal" ||
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
