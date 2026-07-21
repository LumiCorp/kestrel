import {
  Activity,
  Folder,
  FlaskConical,
  GitCompareArrows,
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
  Plus,
  Send,
  ShieldCheck,
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
  DesktopBridgeInfo,
  DesktopCapabilityId,
  DesktopCapabilityView,
  DesktopReadinessItemId,
  DesktopAttachmentMetadata,
  DesktopFollowUpQueueEntry,
  DesktopOperatorControlRequest,
  DesktopOperatorInboxItem,
  DesktopRendererSettings,
  DesktopRunnerEvent,
  DesktopRuntimeHealth,
  DesktopThreadWorkspaceContext,
  RunTurnAttachment,
  DesktopRuntimeThreadInspection,
} from "../../src/contracts";
import { DiagnosticsWorkspace } from "./DiagnosticsWorkspace";
import { DiffWorkspace } from "./DiffWorkspace";
import { GitWorkspace } from "./GitWorkspace";
import { MessageContent } from "./MessageContent";
import { McpWorkspace } from "./McpWorkspace";
import { MissionControlWorkspace } from "./MissionControlWorkspace";
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
import { extractTerminalFailure } from "./runtimeCapabilityRecovery";
import {
  addRendererThread,
  appendRendererTranscript,
  acceptRendererPrompt,
  getRendererTurnContinuation,
  getTerminalWaitEventType,
  getTerminalWaitingPrompt,
  readDesktopRendererState,
  resolveRendererThreadProjectPath,
  selectRendererThread,
  serializeDesktopRendererState,
  setRendererTheme,
  toDesktopExecutionSelection,
  toDesktopRunHistory,
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
  const [bridgeInfo, setBridgeInfo] = useState<DesktopBridgeInfo>();
  const [draft, setDraft] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<
    RunTurnAttachment[]
  >([]);
  const [capabilities, setCapabilities] = useState<DesktopCapabilityView>();
  const [activeRuns, setActiveRuns] = useState<Record<string, ActiveRun>>({});
  const [threadViews, setThreadViews] = useState<Record<string, DesktopRuntimeThreadInspection>>({});
  const [runStreams, setRunStreams] = useState<Record<string, DesktopRunStreamItem[]>>({});
  const [attachments, setAttachments] = useState<Record<string, DesktopAttachmentMetadata>>({});
  const [operatorActionPending, setOperatorActionPending] = useState<Record<string, boolean>>({});
  const [historyNavigation, setHistoryNavigation] = useState<Record<string, { index: number; scratch: string }>>({});
  const [activity, setActivity] = useState("Ready");
  const [error, setError] = useState<string>();
  const [errorCapability, setErrorCapability] = useState<DesktopCapabilityId>();
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorWidth, setInspectorWidth] = useState(288);
  const [surface, setSurface] = useState<DesktopSurface>("chat");
  const [settingsTarget, setSettingsTarget] = useState<DesktopCapabilityId>();
  const [missionControlRevision, setMissionControlRevision] = useState(0);
  const [activeProjectPath, setActiveProjectPath] = useState<string>();
  const [threadWorkspaces, setThreadWorkspaces] = useState<
    Record<string, DesktopThreadWorkspaceContext>
  >({});
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const threadsRef = useRef<DesktopRendererState["threads"]>([]);
  const pendingTurnSubmissionsRef = useRef<Record<string, PendingTurnSubmission>>({});
  const acceptedTurnSessionsRef = useRef(new Set<string>());

  const activeThread = useMemo(
    () => state?.threads.find((thread) => thread.id === state.activeThreadId),
    [state],
  );
  const activeThreadWorkspace =
    activeThread === undefined
      ? undefined
      : threadWorkspaces[activeThread.sessionId];

  useEffect(() => {
    setComposerAttachments([]);
  }, [activeThread?.id]);
  const activeRun = activeThread === undefined
    ? undefined
    : activeRuns[activeThread.id] ?? (threadViews[activeThread.id]?.activeRun?.status === "RUNNING"
      ? {
          threadId: activeThread.id,
          sessionId: activeThread.sessionId,
          runId: threadViews[activeThread.id]?.activeRun?.runId,
        }
      : undefined);
  const composerPolicy = getDesktopComposerSubmissionPolicy({
    inboxItems: activeThread === undefined ? [] : threadViews[activeThread.id]?.inboxItems ?? [],
    runActive: activeRun !== undefined,
  });
  const activeRunStream = activeThread === undefined ? [] : runStreams[activeThread.id] ?? [];
  const conversationTimeline = activeThread === undefined
    ? []
    : projectDesktopConversationTimeline(activeThread.transcript, activeRunStream);

  useEffect(() => {
    threadsRef.current = state?.threads ?? [];
  }, [state?.threads]);

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      window.kestrelDesktop.getUiState(),
      window.kestrelDesktop.getSettings(),
      window.kestrelDesktop.getRuntimeHealth(),
      window.kestrelDesktop.getBridgeInfo(),
      window.kestrelDesktop.getCapabilities(),
    ]).then(([uiState, nextSettings, health, info, nextCapabilities]) => {
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
      void Promise.all(rendererState.threads.map(async (thread) => await refreshThreadAuthority(thread)))
        .catch(() => {});
      setSettings(nextSettings);
      setActiveProjectPath((current) => current ?? nextSettings.projects[0]?.path);
      setRuntimeHealth(health);
      setBridgeInfo(info);
      setCapabilities(nextCapabilities);
    }).catch((cause) => {
      if (disposed === false) {
        setError(errorMessage(cause));
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => window.kestrelDesktop.onRunnerEvent((event) => {
      setActivity(describeRunnerActivity(event));
      const rendererThread = event.sessionId === undefined
        ? undefined
        : threadsRef.current.find((thread) => thread.sessionId === event.sessionId);
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
          void refreshThreadAuthority(rendererThread).catch(() => {});
        }
      }
    }), []);

  useEffect(() => window.kestrelDesktop.onRuntimeHealth(setRuntimeHealth), []);

  useEffect(() => {
    const projectPath =
      activeThreadWorkspace?.sourceWorkspaceRoot ?? activeThread?.projectPath;
    if (projectPath !== undefined) {
      setActiveProjectPath(projectPath);
    }
  }, [
    activeThread?.id,
    activeThread?.projectPath,
    activeThreadWorkspace?.sourceWorkspaceRoot,
  ]);

  useEffect(() => {
    if (activeThread === undefined) {
      return;
    }
    let disposed = false;
    void window.kestrelDesktop
      .getOperatorThread(activeThread.sessionId)
      .then((inspection) => {
        const workspace = inspection.workspace;
        if (disposed || workspace === undefined) {
          return;
        }
        setThreadWorkspaces((current) => ({
          ...current,
          [activeThread.sessionId]: workspace,
        }));
      })
      .catch(() => {
        // A newly created Desktop conversation has no runtime thread until its first turn.
      });
    return () => {
      disposed = true;
    };
  }, [activeThread?.sessionId, missionControlRevision]);

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
        setError(`Desktop state could not be saved: ${errorMessage(cause)}`);
      });
  }, [state]);

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
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeThread?.transcript.length, activeRunStream, activity]);

  useEffect(() => {
    if (activeThread === undefined) return;
    void refreshThreadAuthority(activeThread).catch(() => {});
    void window.kestrelDesktop.listAttachments(localCoreThreadId(activeThread.sessionId))
      .then((listed) => setAttachments((current) => ({
        ...current,
        ...Object.fromEntries(listed.map((attachment) => [attachment.attachmentId, attachment])),
      })))
      .catch((cause) => setError(errorMessage(cause)));
  }, [activeThread?.id]);

  async function refreshThreadAuthority(thread: DesktopRendererState["threads"][number]): Promise<void> {
    try {
      const view = await window.kestrelDesktop.getOperatorThread(localCoreThreadId(thread.sessionId));
      setThreadViews((current) => ({ ...current, [thread.id]: view }));
      setActiveRuns((current) => {
        const next = { ...current };
        if (view.activeRun?.status === "RUNNING") {
          next[thread.id] = { threadId: thread.id, sessionId: thread.sessionId, runId: view.activeRun.runId };
        } else {
          delete next[thread.id];
        }
        return next;
      });
    } catch {
      // New renderer conversations do not have a Local Core thread until first submission.
    }
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
      ...(activeProjectPath !== undefined ? { activeProjectPath } : {}),
      projects: settings?.projects ?? [],
    });
    const submittedPendingWaitEventType = activeThread.pendingWaitEventType;
    const workspaceSetup = buildManagedWorkspaceSetup(activeThread);
    const submittedAttachments = composerAttachments;
    setDraft("");
    setComposerAttachments([]);
    setError(undefined);
    setErrorCapability(undefined);
    if (composerPolicy.mode === "reply_to_request") {
      const { item } = composerPolicy;
      pendingTurnSubmissionsRef.current[activeThread.sessionId] = { threadId, message, submittedAt, projectPath };
      setOperatorActionPending((current) => ({ ...current, [item.itemId]: true }));
      setActivity("Sending reply");
      try {
        const view = await window.kestrelDesktop.submitOperatorControl({
          action: "reply",
          threadId: localCoreThreadId(activeThread.sessionId),
          requestId: item.requestId,
          message,
          attachmentIds: activeThread.draftAttachmentIds,
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
        setActivity(view.activeRun?.status === "RUNNING" ? "Reply sent; run resumed" : "Reply sent");
      } catch (cause) {
        delete pendingTurnSubmissionsRef.current[activeThread.sessionId];
        setError(errorMessage(cause));
        setActivity("Reply not sent");
      } finally {
        acceptedTurnSessionsRef.current.delete(activeThread.sessionId);
        setOperatorActionPending((current) => ({ ...current, [item.itemId]: false }));
      }
      return;
    }
    if (composerPolicy.mode === "queue_follow_up") {
      setActivity("Queueing follow-up");
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
        setActivity("Follow-up queued");
      } catch (cause) {
        setError(errorMessage(cause));
        setActivity("Follow-up not queued");
      }
      return;
    }

    setActivity("Starting run");
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
        ...(submittedAttachments.length > 0
          ? { attachments: submittedAttachments }
          : {}),
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
        ...(projectPath !== undefined ? { projectPath } : {}),
        ...(activeThread.mode === "build" ? { actSubmode: "safe" } : {}),
        executionSelection: toDesktopExecutionSelection(activeThread, settings.apps),
      });
      const assistantText = extractTerminalMessage(terminal);
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
        setError(terminalError);
        setErrorCapability(terminalFailure?.capabilityId);
      }
      setActivity(
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
      setError(errorMessage(cause));
      setActivity("Run failed");
    } finally {
      delete pendingTurnSubmissionsRef.current[activeThread.sessionId];
      setActiveRuns((current) => { const next = { ...current }; delete next[threadId]; return next; });
      void refreshThreadAuthority(activeThread).catch(() => {});
    }
  }

  async function cancelActiveRun(): Promise<void> {
    if (activeRun === undefined) {
      return;
    }
    setActivity("Cancelling");
    try {
      await window.kestrelDesktop.cancelRun({
        sessionId: activeRun.sessionId,
        ...(activeRun.runId !== undefined ? { runId: activeRun.runId } : {}),
      });
    } catch (cause) {
      setError(errorMessage(cause));
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
    try {
      const file = await window.kestrelDesktop.readFile({
        rootPath,
        targetPath: filePath,
        ...(threadId !== undefined ? { threadId } : {}),
      });
      const attachmentBytes = new TextEncoder().encode(file.content);
      const attachment: RunTurnAttachment = {
        attachmentId: crypto.randomUUID(),
        threadId: activeThread.sessionId,
        filename: fileName(file.path),
        mimeType: desktopTextMimeType(file.language, file.viewKind),
        sizeBytes: attachmentBytes.byteLength,
        sha256: await sha256Hex(attachmentBytes),
        kind: "text",
        createdAt: new Date().toISOString(),
        text: file.content,
      };
      setComposerAttachments((current) =>
        [
          ...current.filter(
            (candidate) =>
              candidate.filename !== attachment.filename ||
              candidate.sha256 !== attachment.sha256,
          ),
          attachment,
        ].slice(-8),
      );
      if (intent === "ask") {
        setDraft((current) =>
          current.trim().length > 0
            ? current
            : `Please review the attached ${attachment.filename} in the context of this workspace.`,
        );
      }
      setSurface("chat");
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function attachTerminalOutput(
    text: string,
    terminal: import("../../src/contracts").DesktopUserTerminal,
  ): Promise<void> {
    if (activeThread === undefined || text.length === 0) {
      return;
    }
    const bytes = new TextEncoder().encode(text);
    const attachment: RunTurnAttachment = {
      attachmentId: crypto.randomUUID(),
      threadId: activeThread.sessionId,
      filename: `terminal-${terminal.terminalId.slice(0, 8)}.txt`,
      mimeType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      kind: "text",
      createdAt: new Date().toISOString(),
      text,
    };
    setComposerAttachments((current) => [...current, attachment].slice(-8));
    setDraft((current) =>
      current.trim().length > 0
        ? current
        : "Please review the attached terminal output.",
    );
    setSurface("chat");
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
    const match = /^data:image\/png;base64,(.+)$/u.exec(input.dataUrl);
    if (!match) throw new Error("Preview screenshot is not a PNG attachment.");
    const binary = atob(match[1]!);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (bytes.byteLength > 5 * 1024 * 1024)
      throw new Error("Preview screenshot exceeds the 5 MB attachment limit.");
    const attachment: RunTurnAttachment = {
      attachmentId: crypto.randomUUID(),
      threadId: activeThread.sessionId,
      filename: input.filename,
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      kind: "image",
      createdAt: new Date().toISOString(),
      data: match[1],
    };
    setComposerAttachments((current) => [...current, attachment].slice(-8));
    setDraft(
      [
        input.comment,
        "",
        `Preview evidence: run ${input.runId}`,
        `URL: ${input.url}`,
        ...(input.region
          ? [
              `Annotated region: x=${input.region.x.toFixed(3)}, y=${input.region.y.toFixed(3)}, width=${input.region.width.toFixed(3)}, height=${input.region.height.toFixed(3)}`,
            ]
          : []),
      ].join("\n"),
    );
    setSurface("chat");
    setError(undefined);
  }

  async function steerActiveRun(): Promise<void> {
    if (activeThread === undefined || activeRun === undefined || activeThread.draft.trim().length === 0) return;
    const message = activeThread.draft;
    setActivity("Applying steering");
    try {
      const view = await window.kestrelDesktop.submitOperatorControl({
        action: "steer",
        threadId: localCoreThreadId(activeThread.sessionId),
        message,
        attachmentIds: activeThread.draftAttachmentIds,
      });
      setThreadViews((current) => ({ ...current, [activeThread.id]: view }));
      setState((current) => current === undefined ? current : acceptRendererPrompt(current, activeThread.id, message));
      setActivity(view.latestSteering === undefined ? "Steering queued" : "Steering applied");
    } catch (cause) {
      setError(errorMessage(cause));
      setActivity("Steering not applied");
    }
  }

  async function selectAttachments(): Promise<void> {
    if (activeThread === undefined) return;
    try {
      const selected = await window.kestrelDesktop.selectAttachments(localCoreThreadId(activeThread.sessionId));
      if (selected.length === 0) return;
      setAttachments((current) => ({ ...current, ...Object.fromEntries(selected.map((entry) => [entry.attachmentId, entry])) }));
      setState((current) => current === undefined ? current : updateRendererDraftAttachments(
        current,
        activeThread.id,
        [...activeThread.draftAttachmentIds, ...selected.map((entry) => entry.attachmentId)].slice(0, 8),
      ));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function removeDraftAttachment(attachmentId: string): Promise<void> {
    if (activeThread === undefined) return;
    try {
      await window.kestrelDesktop.removeAttachment(localCoreThreadId(activeThread.sessionId), attachmentId);
      setState((current) => current === undefined ? current : updateRendererDraftAttachments(
        current,
        activeThread.id,
        activeThread.draftAttachmentIds.filter((id) => id !== attachmentId),
      ));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function submitOperatorAction(itemId: string, request: DesktopOperatorControlRequest): Promise<void> {
    if (activeThread === undefined || operatorActionPending[itemId] === true) return;
    setOperatorActionPending((current) => ({ ...current, [itemId]: true }));
    try {
      const view = await window.kestrelDesktop.submitOperatorControl(request);
      if (view.thread.threadId === localCoreThreadId(activeThread.sessionId)) {
        setThreadViews((current) => ({ ...current, [activeThread.id]: view }));
      } else {
        await refreshThreadAuthority(activeThread);
      }
      if (request.attachmentIds !== undefined && request.attachmentIds.length > 0) {
        setState((current) => current === undefined
          ? current
          : updateRendererDraftAttachments(current, activeThread.id, []));
      }
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
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
    setActivity("Restarting runtime");
    try {
      await window.kestrelDesktop.restartRuntime();
      setRuntimeHealth(await window.kestrelDesktop.getRuntimeHealth());
      setActivity("Ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setActivity("Runtime restart failed");
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
    setActiveProjectPath(project.path);
  }

  function startProjectConversation(projectPath: string): void {
    const defaultConfiguration = settings?.modelConfigurations.find(
      (configuration) => configuration.id === settings.defaultModelConfigurationId,
    );
    setState((current) => current === undefined
      ? current
      : addRendererThread(current, {
          projectPath,
          modelConfigurationId: defaultConfiguration?.id,
          modelConfigurationRevision: defaultConfiguration?.currentRevision,
          enabledAppIds: settings?.defaultEnabledAppIds,
        }));
    setSurface("chat");
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
        <p>{error ?? "Opening Kestrel"}</p>
      </main>
    );
  }

  const healthState = runtimeHealth?.state ?? "degraded";
  const selectedProject =
    settings?.projects.find((project) => project.path === activeProjectPath) ??
    settings?.projects[0];
  const threadProjectPath =
    activeThreadWorkspace?.sourceWorkspaceRoot ?? activeThread.projectPath;
  const threadProject = settings?.projects.find(
    (project) => project.path === threadProjectPath,
  );
  const activeProject =
    surface === "projects"
      ? selectedProject
      : (threadProject ?? selectedProject);
  const projectWorkspace =
    activeProject !== undefined &&
    activeThreadWorkspace?.sourceWorkspaceRoot === activeProject.path
      ? activeThreadWorkspace
      : undefined;
  const showInspector = surface === "chat" && inspectorOpen;
  return (
    <div className="desktop-app">
      <header className="titlebar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <img src={kestrelMarkUrl} alt="" />
          </span>
          <strong>Kestrel</strong>
        </div>
        <div
          className="titlebar-context"
          title={`${activeThread.title} · ${surfacePageTitle(surface)}`}
        >
          <strong className="titlebar-thread-title">
            {activeThread.title}
          </strong>
          <span className="titlebar-page-title">
            {surfacePageTitle(surface)}
          </span>
        </div>
        <div className="titlebar-actions">
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
              className="icon-button"
              type="button"
              title={inspectorOpen ? "Close context sidebar" : "Open context sidebar"}
              aria-label={inspectorOpen ? "Close context sidebar" : "Open context sidebar"}
              onClick={() => setInspectorOpen((open) => !open)}
            >
              <span className={`titlebar-status-dot health-${healthState}`} aria-hidden="true" />
              {inspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
            </button>
          ) : null}
        </div>
      </header>

      <div
        className={`workspace ${showInspector ? "with-inspector" : ""}`}
        style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
      >
        <aside className="conversation-rail" aria-label="Conversations">
          <nav className="surface-tabs" aria-label="Kestrel views">
            <button
              className={surface === "chat" ? "active" : ""}
              type="button"
              title="Conversations"
              aria-label="Conversations"
              onClick={() => setSurface("chat")}
            >
              <MessageSquare size={17} />
            </button>
            <button
              className={surface === "mission-control" ? "active" : ""}
              type="button"
              title="Mission control"
              aria-label="Mission control"
              onClick={() => setSurface("mission-control")}
            >
              <ListChecks size={17} />
            </button>
            <button
              className={surface === "projects" ? "active" : ""}
              type="button"
              title="Projects"
              aria-label="Projects"
              onClick={() => setSurface("projects")}
            >
              <Folder size={17} />
            </button>
            <button
              className={surface === "diff" ? "active" : ""}
              type="button"
              title="Diff"
              aria-label="Diff"
              onClick={() => setSurface("diff")}
            >
              <GitCompareArrows size={17} />
            </button>
            <button
              className={surface === "review" ? "active" : ""}
              type="button"
              title="Review"
              aria-label="Review"
              onClick={() => setSurface("review")}
            >
              <ShieldCheck size={17} />
            </button>
            <button
              className={surface === "validation" ? "active" : ""}
              type="button"
              title="Validation"
              aria-label="Validation"
              onClick={() => setSurface("validation")}
            >
              <FlaskConical size={17} />
            </button>
            <button
              className={surface === "git" ? "active" : ""}
              type="button"
              title="Git and pull requests"
              aria-label="Git and pull requests"
              onClick={() => setSurface("git")}
            >
              <GitPullRequest size={17} />
            </button>
            <button
              className={surface === "preview" ? "active" : ""}
              type="button"
              title="Preview"
              aria-label="Preview"
              onClick={() => setSurface("preview")}
            >
              <MonitorPlay size={17} />
            </button>
            <button
              className={surface === "terminal" ? "active" : ""}
              type="button"
              title="Terminal"
              aria-label="Terminal"
              onClick={() => setSurface("terminal")}
            >
              <TerminalSquare size={17} />
            </button>
            <button
              className={surface === "mcp" ? "active" : ""}
              type="button"
              title="MCP servers"
              aria-label="MCP servers"
              onClick={() => setSurface("mcp")}
            >
              <Plug size={17} />
            </button>
            <button className={surface === "settings" ? "active" : ""} type="button" title="Settings" aria-label="Settings" onClick={() => openCapabilitySettings()}>
              <Settings size={17} />
            </button>
            <button className={surface === "diagnostics" ? "active" : ""} type="button" title="Diagnostics" aria-label="Diagnostics" onClick={() => setSurface("diagnostics")}>
              <Wrench size={17} />
            </button>
          </nav>

          {surface === "chat" ? (
            <>
              <div className="rail-heading">
                <span>Conversations</span>
                <button
                  className="icon-button"
                  type="button"
                  title="New conversation"
                  aria-label="New conversation"
                  onClick={() => setState((current) => current === undefined
                    ? current
                    : addRendererThread(current, {
                        ...(activeProject?.path !== undefined
                          ? { projectPath: activeProject.path }
                          : {}),
                        modelConfigurationId: settings?.defaultModelConfigurationId,
                        modelConfigurationRevision: settings?.modelConfigurations.find(
                          (configuration) => configuration.id === settings.defaultModelConfigurationId,
                        )?.currentRevision,
                        enabledAppIds: settings?.defaultEnabledAppIds,
                      }))}
                >
                  <Plus size={17} />
                </button>
              </div>
              <nav className="thread-list">
                {state.threads.map((thread) => (
                  <button
                    className={`thread-row ${thread.id === state.activeThreadId ? "active" : ""}`}
                    key={thread.id}
                    type="button"
                    onClick={() => {
                      setState((current) =>
                        current === undefined
                          ? current
                          : selectRendererThread(current, thread.id),
                      );
                      if (thread.projectPath !== undefined) {
                        setActiveProjectPath(thread.projectPath);
                      }
                    }}
                  >
                    <span>{thread.title}</span>
                    <time>{formatThreadTime(thread.updatedAt)}</time>
                  </button>
                ))}
              </nav>
            </>
          ) : surface === "projects" ? (
            <>
              <div className="rail-heading">
                <span>Projects</span>
                <button
                  className="icon-button"
                  type="button"
                  title="Add project"
                  aria-label="Add project"
                  onClick={() =>
                    void addProject().catch((cause) =>
                      setError(errorMessage(cause)),
                    )
                  }
                >
                  <Plus size={17} />
                </button>
              </div>
              <nav className="thread-list project-rail-list">
                {settings?.projects.map((project) => (
                  <button
                    className={`thread-row ${project.path === activeProject?.path ? "active" : ""}`}
                    key={project.path}
                    type="button"
                    title={project.path}
                    onClick={() => setActiveProjectPath(project.path)}
                  >
                    <span>{project.label}</span>
                  </button>
                ))}
                {settings?.projects.length === 0 ? (
                  <p className="rail-empty">No projects</p>
                ) : null}
              </nav>
            </>
          ) : (
            <div className="rail-context">
              <span>
                {surface === "mission-control"
                  ? "Mission control"
                  : surface === "diff"
                    ? "Diff"
                    : surface === "review"
                      ? "Review"
                      : surface === "validation"
                        ? "Validation"
                        : surface === "git"
                          ? "Git and pull requests"
                          : surface === "preview"
                            ? "Preview"
                            : surface === "terminal"
                              ? "Terminal"
                              : surface === "mcp"
                                ? "MCP servers"
                                : "Diagnostics"}
              </span>
              <p>
                {surface === "mission-control" ||
                surface === "diff" ||
                surface === "review" ||
                surface === "validation" ||
                surface === "git" ||
                surface === "preview" ||
                surface === "terminal"
                  ? activeThread.title
                  : surface === "mcp"
                    ? "Local integrations"
                    : (runtimeHealth?.state ?? "unknown")}
              </p>
            </div>
          )}
        </aside>

        {surface === "chat" ? (
          <main className="conversation-pane" id="app-main">
          <section className="transcript" aria-label="Conversation transcript">
            {conversationTimeline.length === 0 ? (
              <div className="empty-transcript">
                <span className="brand-mark large">K</span>
                <h1>New conversation</h1>
              </div>
            ) : conversationTimeline.map((entry) => entry.type === "transcript" ? (
              <article className={`message message-${entry.line.role}`} key={entry.id}>
                <div className="message-meta">
                  <strong>{entry.line.role === "user" ? "You" : entry.line.role === "assistant" ? "Kestrel" : "System"}</strong>
                  <time>{formatMessageTime(entry.line.timestamp)}</time>
                </div>
                <MessageContent messageRole={entry.line.role} text={entry.line.text} />
              </article>
            ) : (
              <article className={`run-stream-item run-stream-${entry.item.kind} run-stream-${entry.item.status}`} key={entry.id}>
                <div className="message-meta">
                  <strong>{entry.item.label}</strong>
                  <time>{formatMessageTime(entry.item.timestamp)}</time>
                </div>
                <MessageContent messageRole="assistant" text={entry.item.text.length > 0 ? entry.item.text : "Reasoning…"} />
              </article>
            ))}
            <div ref={transcriptEndRef} />
          </section>

          <div className="activity-shell">
            <div className="activity-line" aria-live="polite" aria-atomic="true">
              <Activity size={14} aria-hidden="true" />
              <span>{activity}</span>
              {error !== undefined ? <span className="activity-error">{error}</span> : null}
              {errorCapability !== undefined ? <button className="secondary-button" type="button" onClick={() => openCapabilitySettings(errorCapability)}>Open capability settings</button> : null}
            </div>
          </div>

          {threadViews[activeThread.id]?.followUpQueue.items.length ? (
            <section className="follow-up-queue" aria-label="Queued follow-ups">
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
          ) : null}

          {threadViews[activeThread.id]?.inboxItems.map((item) => (
            <OperatorActionCard
              key={item.itemId}
              item={item}
              pending={operatorActionPending[item.itemId] === true}
              onAction={(request) => void submitOperatorAction(item.itemId, request)}
            />
          ))}

          <form className="composer" onSubmit={(event) => void submitTurn(event)}>
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
              <span>{activeThread.mode === "build" ? "Safe build" : modeLabel(activeThread.mode)}</span>
              <button className="icon-button" type="button" title="Attach files" aria-label="Attach files" disabled={activeThread.draftAttachmentIds.length >= 8} onClick={() => void selectAttachments()}>
                <Paperclip size={16} />
              </button>
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
                  <button type="button" disabled={activeThread.draft.trim().length === 0} onClick={() => void steerActiveRun()}>Steer now</button>
                  <button className="primary-icon-button" type="submit" title="Queue follow-up" aria-label="Queue follow-up" disabled={activeThread.draft.trim().length === 0}><Send size={17} /></button>
                  <button className="stop-button" type="button" title="Stop run" aria-label="Stop run" onClick={() => void cancelActiveRun()}><Square size={15} fill="currentColor" /></button>
                </>
              )}
            </div>
            </form>
          </main>
        ) : (
          <div className="surface-host">
            {error !== undefined ? <div className="surface-error" role="alert"><span>{error}</span>{errorCapability !== undefined ? <button type="button" onClick={() => openCapabilitySettings(errorCapability)}>Open capability settings</button> : null}</div> : null}
            {surface === "projects" ? (
              <ProjectWorkspace
                project={activeProject}
                threadId={activeThread.sessionId}
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
                onError={setError}
              />
            ) : surface === "mission-control" ? (
              <MissionControlWorkspace
                sessionId={activeThread.sessionId}
                project={activeProject}
                refreshVersion={missionControlRevision}
                onError={setError}
              />
            ) : surface === "diff" ? (
              <DiffWorkspace
                key={activeThread.id}
                sessionId={activeThread.sessionId}
                threadId={activeThread.sessionId}
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
                  const project = activeProject;
                  if (workspaceRoot && project)
                    void window.kestrelDesktop.openFileEditor({
                      projectPath: workspaceRoot,
                      filePath,
                      projectLabel: project.label,
                      threadId: activeThread.sessionId,
                      ...(lineNumber ? { lineNumber } : {}),
                    });
                }}
                onError={setError}
              />
            ) : surface === "terminal" ? (
              <TerminalWorkspace
                sessionId={activeThread.sessionId}
                threadId={activeThread.sessionId}
                onAttachOutput={attachTerminalOutput}
                onError={setError}
              />
            ) : surface === "review" ? (
              <ReviewWorkspace
                sessionId={activeThread.sessionId}
                threadId={activeThread.sessionId}
                defaultBaseRef={activeThread.workspaceBaseRef}
                onOpenFile={(filePath, lineNumber) => {
                  const workspaceRoot =
                    activeThreadWorkspace?.workspaceRoot ??
                    activeThread.projectPath;
                  const project = activeProject;
                  if (workspaceRoot && project)
                    void window.kestrelDesktop.openFileEditor({
                      projectPath: workspaceRoot,
                      filePath,
                      projectLabel: project.label,
                      threadId: activeThread.sessionId,
                      ...(lineNumber ? { lineNumber } : {}),
                    });
                }}
                onError={setError}
              />
            ) : surface === "validation" ? (
              <ValidationWorkspace
                sessionId={activeThread.sessionId}
                threadId={activeThread.sessionId}
                onOpenFile={(filePath, lineNumber) => {
                  const workspaceRoot =
                    activeThreadWorkspace?.workspaceRoot ??
                    activeThread.projectPath;
                  const project = activeProject;
                  if (workspaceRoot && project)
                    void window.kestrelDesktop.openFileEditor({
                      projectPath: workspaceRoot,
                      filePath,
                      projectLabel: project.label,
                      threadId: activeThread.sessionId,
                      ...(lineNumber ? { lineNumber } : {}),
                    });
                }}
                onError={setError}
              />
            ) : surface === "git" ? (
              <GitWorkspace
                sessionId={activeThread.sessionId}
                threadId={activeThread.sessionId}
                defaultBaseRef={activeThread.workspaceBaseRef}
                executionSelection={toDesktopExecutionSelection(activeThread, settings?.apps ?? [])}
                onError={setError}
              />
            ) : surface === "preview" ? (
              <PreviewWorkspace
                projectPath={activeThread.projectPath ?? activeProject?.path}
                threadId={activeThread.sessionId}
                onAttachVisualFeedback={attachVisualFeedback}
                onError={setError}
              />
            ) : surface === "mcp" ? (
              <McpWorkspace onError={setError} />
            ) : surface === "settings" ? (
              <SettingsWorkspace
                settings={settings!}
                initialCapabilityId={settingsTarget}
                onSettings={async (update) => {
                  const saved = await window.kestrelDesktop.saveSettings(update);
                  setSettings(saved);
                  setState((current) => current === undefined ? current : { ...current, theme: saved.appearanceTheme });
                  return saved;
                }}
                onCapabilitiesChange={setCapabilities}
                onOpenMcp={() => setSurface("mcp")}
                onAddProject={async () => { await addProject(); }}
                onRequestMicrophone={async () => { await window.kestrelDesktop.requestMicrophoneAccess(); }}
                onError={setError}
              />
            ) : (
              <DiagnosticsWorkspace
                runtimeHealth={runtimeHealth}
                onRuntimeHealth={setRuntimeHealth}
                onError={setError}
                onOpenReadinessSettings={openReadinessSettings}
              />
            )}
          </div>
        )}

        {showInspector && settings !== undefined ? (
          <ContextSidebar
            surface={surface}
            thread={activeThread}
            settings={settings}
            runtimeHealth={runtimeHealth}
            bridgeInfo={bridgeInfo}
            capabilities={capabilities}
            locked={activeRun !== undefined || activeThread.pendingWaitEventType !== undefined}
            activeProjectPath={activeProject?.path}
            onModelConfigurationChange={(id, revision) => setState((current) => current === undefined
              ? current
              : updateRendererThread(current, activeThread.id, (thread) => ({
                  ...thread,
                  modelConfigurationId: id,
                  modelConfigurationRevision: revision,
                })))}
            onAppToggle={(id, enabled) => setState((current) => current === undefined
              ? current
              : updateRendererThread(current, activeThread.id, (thread) => ({
                  ...thread,
                  enabledAppIds: enabled
                    ? [...new Set([...thread.enabledAppIds, id])]
                    : thread.enabledAppIds.filter((entry) => entry !== id),
                })))}
            onProjectChange={(path) => {
              setActiveProjectPath(path);
              setState((current) => current === undefined
                ? current
                : updateRendererThread(current, activeThread.id, (thread) => ({ ...thread, projectPath: path })));
            }}
            onAddProject={() => void addProject().catch((cause) => setError(errorMessage(cause)))}
            onRestartRuntime={() => void restartRuntime()}
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
    <section className={`operator-action-card operator-action-${item.kind}`} aria-label={item.title}>
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
  if (surface === "mcp") return "MCP servers";
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

function formatThreadTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatMessageTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
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
