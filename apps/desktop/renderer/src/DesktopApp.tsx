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
  Plug,
  Plus,
  RefreshCw,
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
  DesktopCredentialedModelProvider,
  DesktopRendererSettings,
  DesktopRunnerEvent,
  DesktopRuntimeHealth,
  DesktopThreadWorkspaceContext,
  DesktopToolCredentialStatus,
  RunTurnAttachment,
} from "../../src/contracts";
import type { ModelPolicyV1 } from "../../../../src/profile/modelPolicy";
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
import {
  addRendererThread,
  appendRendererTranscript,
  getRendererTurnContinuation,
  getTerminalWaitEventType,
  getTerminalWaitingPrompt,
  readDesktopRendererState,
  resolveRendererThreadProjectPath,
  selectRendererThread,
  serializeDesktopRendererState,
  setRendererTheme,
  toDesktopRunHistory,
  updateRendererThread,
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
  | "git"
  | "preview"
  | "terminal"
  | "mcp"
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
  const [providerApiKey, setProviderApiKey] = useState("");
  const [modelPolicy, setModelPolicy] = useState<ModelPolicyV1>();
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [providerDraft, setProviderDraft] =
    useState<DesktopRendererSettings["selectedProvider"]>("openrouter");
  const [modelDraft, setModelDraft] = useState("");
  const [providerSettingsSaving, setProviderSettingsSaving] = useState(false);
  const [providerSettingsError, setProviderSettingsError] = useState<string>();
  const [weatherCredential, setWeatherCredential] =
    useState<DesktopToolCredentialStatus>();
  const [weatherSettingsOpen, setWeatherSettingsOpen] = useState(false);
  const [weatherApiKey, setWeatherApiKey] = useState("");
  const [weatherSettingsSaving, setWeatherSettingsSaving] = useState(false);
  const [weatherSettingsError, setWeatherSettingsError] = useState<string>();
  const [activeRun, setActiveRun] = useState<ActiveRun>();
  const [activity, setActivity] = useState("Ready");
  const [error, setError] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorWidth, setInspectorWidth] = useState(288);
  const [surface, setSurface] = useState<DesktopSurface>("chat");
  const [missionControlRevision, setMissionControlRevision] = useState(0);
  const [activeProjectPath, setActiveProjectPath] = useState<string>();
  const [threadWorkspaces, setThreadWorkspaces] = useState<
    Record<string, DesktopThreadWorkspaceContext>
  >({});
  const transcriptEndRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      window.kestrelDesktop.getUiState(),
      window.kestrelDesktop.getSettings(),
      window.kestrelDesktop.getRuntimeHealth(),
      window.kestrelDesktop.getBridgeInfo(),
      window.kestrelDesktop.getModelPolicy(),
      window.kestrelDesktop.getToolCredentialStatus("visual-crossing"),
    ])
      .then(
        ([
          uiState,
          nextSettings,
          health,
          info,
          nextModelPolicy,
          nextWeatherCredential,
        ]) => {
          if (disposed) {
            return;
          }
          const rendererState = readDesktopRendererState(uiState);
          setState(rendererState);
          setSurface(
            parseDesktopSurface(rendererState.entries[SURFACE_STATE_KEY]),
          );
          setInspectorOpen(
            rendererState.entries[INSPECTOR_STATE_KEY] !== "false",
          );
          setInspectorWidth(
            clampInspectorWidth(
              Number(rendererState.entries[INSPECTOR_WIDTH_KEY]),
            ),
          );
          setSettings(nextSettings);
          setActiveProjectPath(
            (current) => current ?? nextSettings.projects[0]?.path,
          );
          setRuntimeHealth(health);
          setBridgeInfo(info);
          setModelPolicy(nextModelPolicy);
          setWeatherCredential(nextWeatherCredential);
        },
      )
      .catch((cause) => {
        if (disposed === false) {
          setError(errorMessage(cause));
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    setState((current) =>
      current === undefined
        ? current
        : {
            ...current,
            entries: {
              ...current.entries,
              [SURFACE_STATE_KEY]: surface,
              [INSPECTOR_STATE_KEY]: String(inspectorOpen),
              [INSPECTOR_WIDTH_KEY]: String(inspectorWidth),
            },
          },
    );
  }, [surface, inspectorOpen, inspectorWidth]);

  useEffect(
    () =>
      window.kestrelDesktop.onRunnerEvent((event) => {
        setActivity(describeRunnerActivity(event));
        if (event.type === "run.started") {
          setActiveRun((current) =>
            current === undefined
              ? current
              : {
                  ...current,
                  ...(event.runId !== undefined ? { runId: event.runId } : {}),
                },
          );
        }
        if (
          event.type === "task.updated" ||
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled"
        ) {
          setMissionControlRevision((value) => value + 1);
        }
      }),
    [],
  );

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
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = state.theme;
    void window.kestrelDesktop
      .saveUiState(serializeDesktopRendererState(state))
      .catch((cause) => {
        setError(`Desktop state could not be saved: ${errorMessage(cause)}`);
      });
  }, [state]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeThread?.transcript.length, activity]);

  async function submitTurn(event: FormEvent): Promise<void> {
    event.preventDefault();
    const message = draft;
    if (
      state === undefined ||
      activeThread === undefined ||
      message.trim().length === 0 ||
      activeRun !== undefined
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
    setActivity("Starting run");
    setActiveRun({
      threadId,
      sessionId: activeThread.sessionId,
    });
    setState((current) => {
      if (current === undefined) {
        return current;
      }
      const appended = appendRendererTranscript(current, threadId, {
        role: "user",
        text: message,
        timestamp: submittedAt,
        ...(submittedAttachments.length > 0
          ? { attachments: submittedAttachments }
          : {}),
      });
      return updateRendererThread(appended, threadId, (thread) => ({
        ...thread,
        ...(projectPath !== undefined ? { projectPath } : {}),
        pendingWaitEventType: undefined,
      }));
    });

    try {
      const terminal = await window.kestrelDesktop.runTurn({
        sessionId: activeThread.sessionId,
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
        ...(activeThread.workspaceMode === "managed" &&
        workspaceSetup !== undefined
          ? { workspaceSetup }
          : {}),
        ...(projectPath !== undefined ? { projectPath } : {}),
        ...(activeThread.mode === "build" ? { actSubmode: "safe" } : {}),
      });
      const assistantText = extractTerminalMessage(terminal);
      const terminalError = extractTerminalError(terminal);
      const pendingWaitEventType = getTerminalWaitEventType(terminal);
      const waitingPrompt = getTerminalWaitingPrompt(terminal);
      const terminalLine =
        assistantText !== undefined
          ? {
              role: "assistant" as const,
              text: assistantText,
              timestamp: new Date().toISOString(),
            }
          : waitingPrompt !== undefined
            ? {
                role: "system" as const,
                text: waitingPrompt.text,
                timestamp: new Date().toISOString(),
                data: {
                  kind: "runtime.waiting_prompt" as const,
                  runId: waitingPrompt.runId,
                },
              }
            : undefined;
      if (terminalLine !== undefined) {
        setState((current) => {
          if (current === undefined) {
            return current;
          }
          const appended = appendRendererTranscript(
            current,
            threadId,
            terminalLine,
          );
          return updateRendererThread(appended, threadId, (thread) => ({
            ...thread,
            pendingWaitEventType,
          }));
        });
      } else {
        setState((current) =>
          current === undefined
            ? current
            : updateRendererThread(current, threadId, (thread) => ({
                ...thread,
                pendingWaitEventType,
              })),
        );
      }
      if (terminalError !== undefined) {
        setError(terminalError);
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
      setError(errorMessage(cause));
      setActivity("Run failed");
    } finally {
      setActiveRun(undefined);
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
    setState((current) =>
      current === undefined
        ? current
        : addRendererThread(current, { projectPath }),
    );
    setSurface("chat");
  }

  async function updateProvider(
    selectedProvider: DesktopRendererSettings["selectedProvider"],
  ): Promise<void> {
    if (settings === undefined) {
      return;
    }
    setProviderApiKey("");
    const saved = await window.kestrelDesktop.saveSettings({
      selectedProvider,
    });
    setSettings(saved);
  }

  async function saveProviderCredential(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (
      settings === undefined ||
      isCredentialedProvider(settings.selectedProvider) === false ||
      providerApiKey.trim().length === 0
    ) {
      return;
    }
    setActivity("Applying provider credential");
    try {
      const saved = await window.kestrelDesktop.saveProviderCredential({
        provider: settings.selectedProvider,
        apiKey: providerApiKey,
      });
      setSettings(saved);
      setProviderApiKey("");
      setActivity("Ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setActivity("Provider setup failed");
    }
  }

  async function openProviderSettings(): Promise<void> {
    setProviderSettingsError(undefined);
    setProviderApiKey("");
    try {
      const [nextSettings, nextModelPolicy] = await Promise.all([
        window.kestrelDesktop.getSettings(),
        window.kestrelDesktop.getModelPolicy(),
      ]);
      setSettings(nextSettings);
      setModelPolicy(nextModelPolicy);
      setProviderDraft(nextModelPolicy.provider);
      setModelDraft(nextModelPolicy.model);
      setProviderSettingsOpen(true);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function saveProviderSettings(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (modelPolicy === undefined || modelDraft.trim().length === 0) {
      setProviderSettingsError("Model ID is required.");
      return;
    }
    setProviderSettingsSaving(true);
    setProviderSettingsError(undefined);
    try {
      if (
        isCredentialedProvider(providerDraft) &&
        providerApiKey.trim().length > 0
      ) {
        await window.kestrelDesktop.saveProviderCredential({
          provider: providerDraft,
          apiKey: providerApiKey,
        });
      }
      const savedPolicy = await window.kestrelDesktop.saveModelPolicy({
        ...modelPolicy,
        provider: providerDraft,
        model: modelDraft.trim(),
      });
      const savedSettings = await window.kestrelDesktop.getSettings();
      setModelPolicy(savedPolicy);
      setSettings(savedSettings);
      setProviderApiKey("");
      setProviderSettingsOpen(false);
      setRuntimeHealth(await window.kestrelDesktop.getRuntimeHealth());
      setActivity("Ready");
    } catch (cause) {
      setProviderSettingsError(errorMessage(cause));
    } finally {
      setProviderSettingsSaving(false);
    }
  }

  function openWeatherSettings(): void {
    setWeatherApiKey("");
    setWeatherSettingsError(undefined);
    setWeatherSettingsOpen(true);
  }

  async function saveWeatherCredential(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (weatherApiKey.trim().length === 0) return;
    setWeatherSettingsSaving(true);
    setWeatherSettingsError(undefined);
    try {
      const status = await window.kestrelDesktop.saveToolCredential({
        provider: "visual-crossing",
        apiKey: weatherApiKey,
      });
      setWeatherCredential(status);
      setWeatherApiKey("");
      setWeatherSettingsOpen(false);
      setActivity("Weather fallback ready");
    } catch (cause) {
      setWeatherSettingsError(errorMessage(cause));
    } finally {
      setWeatherSettingsSaving(false);
    }
  }

  async function removeWeatherCredential(): Promise<void> {
    setWeatherSettingsSaving(true);
    setWeatherSettingsError(undefined);
    try {
      const status =
        await window.kestrelDesktop.deleteToolCredential("visual-crossing");
      setWeatherCredential(status);
      setWeatherApiKey("");
      setActivity("Weather fallback removed");
    } catch (cause) {
      setWeatherSettingsError(errorMessage(cause));
    } finally {
      setWeatherSettingsSaving(false);
    }
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
          <span className={`health-indicator health-${healthState}`}>
            <span aria-hidden="true" />
            {healthState}
          </span>
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
              title={inspectorOpen ? "Close inspector" : "Open inspector"}
              aria-label={inspectorOpen ? "Close inspector" : "Open inspector"}
              onClick={() => setInspectorOpen((open) => !open)}
            >
              {inspectorOpen ? (
                <PanelRightClose size={17} />
              ) : (
                <PanelRightOpen size={17} />
              )}
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
            <button
              className={surface === "diagnostics" ? "active" : ""}
              type="button"
              title="Diagnostics"
              aria-label="Diagnostics"
              onClick={() => setSurface("diagnostics")}
            >
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
                  onClick={() =>
                    setState((current) =>
                      current === undefined
                        ? current
                        : addRendererThread(current, {
                            ...(activeProject?.path !== undefined
                              ? { projectPath: activeProject.path }
                              : {}),
                          }),
                    )
                  }
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
            <section
              className="transcript"
              aria-label="Conversation transcript"
            >
              {activeThread.transcript.length === 0 ? (
                <div className="empty-transcript">
                  <span className="brand-mark large" aria-hidden="true">
                    <img src={kestrelMarkUrl} alt="" />
                  </span>
                  <h1>New conversation</h1>
                </div>
              ) : (
                activeThread.transcript.map((line, index) => (
                  <article
                    className={`message message-${line.role}`}
                    key={`${line.timestamp}-${index}`}
                  >
                    <div className="message-meta">
                      <strong>
                        {line.role === "user"
                          ? "You"
                          : line.role === "assistant"
                            ? "Kestrel"
                            : "System"}
                      </strong>
                      <time>{formatMessageTime(line.timestamp)}</time>
                    </div>
                    <MessageContent role={line.role} text={line.text} />
                    {line.attachments !== undefined &&
                    line.attachments.length > 0 ? (
                      <div className="message-attachments">
                        {line.attachments.map((attachment) => (
                          <span key={attachment.attachmentId}>
                            {attachment.filename} ·{" "}
                            {formatBytes(attachment.sizeBytes)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))
              )}
              <div ref={transcriptEndRef} />
            </section>

            <div className="activity-shell">
              <div
                className="activity-line"
                aria-live="polite"
                aria-atomic="true"
              >
                <Activity size={14} aria-hidden="true" />
                <span>{activity}</span>
                {error !== undefined ? (
                  <span className="activity-error">{error}</span>
                ) : null}
              </div>
            </div>

            <form
              className="composer"
              onSubmit={(event) => void submitTurn(event)}
            >
              <div className="mode-segment" aria-label="Interaction mode">
                {(["chat", "plan", "build"] as const).map((mode) => (
                  <button
                    className={activeThread.mode === mode ? "active" : ""}
                    key={mode}
                    type="button"
                    onClick={() =>
                      setState((current) =>
                        current === undefined
                          ? current
                          : updateRendererThread(
                              current,
                              activeThread.id,
                              (thread) => ({ ...thread, mode }),
                            ),
                      )
                    }
                  >
                    {modeLabel(mode)}
                  </button>
                ))}
              </div>
              <textarea
                aria-label="Message"
                placeholder="Message Kestrel"
                rows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.shiftKey === false) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              {composerAttachments.length > 0 ? (
                <div
                  className="composer-attachments"
                  aria-label="Attached files"
                >
                  {composerAttachments.map((attachment) => (
                    <span key={attachment.attachmentId}>
                      {attachment.filename}
                      <button
                        type="button"
                        aria-label={`Remove ${attachment.filename}`}
                        onClick={() =>
                          setComposerAttachments((current) =>
                            current.filter(
                              (candidate) =>
                                candidate.attachmentId !==
                                attachment.attachmentId,
                            ),
                          )
                        }
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="composer-actions">
                <span>
                  {activeThread.mode === "build"
                    ? "Safe build"
                    : modeLabel(activeThread.mode)}
                </span>
                {activeRun === undefined ? (
                  <button
                    className="primary-icon-button"
                    type="submit"
                    title="Send message"
                    aria-label="Send message"
                    disabled={draft.trim().length === 0}
                  >
                    <Send size={17} />
                  </button>
                ) : (
                  <button
                    className="stop-button"
                    type="button"
                    title="Stop run"
                    aria-label="Stop run"
                    onClick={() => void cancelActiveRun()}
                  >
                    <Square size={15} fill="currentColor" />
                  </button>
                )}
              </div>
            </form>
          </main>
        ) : (
          <div className="surface-host">
            {error !== undefined ? (
              <div className="surface-error" role="alert">
                {error}
              </div>
            ) : null}
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
            ) : (
              <DiagnosticsWorkspace
                runtimeHealth={runtimeHealth}
                onRuntimeHealth={setRuntimeHealth}
                onError={setError}
              />
            )}
          </div>
        )}

        {showInspector ? (
          <div
            className="inspector-resizer"
            role="separator"
            aria-label="Resize inspector"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const move = (moveEvent: PointerEvent) =>
                setInspectorWidth(
                  clampInspectorWidth(window.innerWidth - moveEvent.clientX),
                );
              const stop = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", stop);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", stop);
            }}
          />
        ) : null}
        {showInspector ? (
          <aside className="inspector" aria-label="Desktop status">
            <section className="inspector-section">
              <div className="section-heading">
                <span>Workspace</span>
              </div>
              <dl className="status-list">
                <div>
                  <dt>Mode</dt>
                  <dd>{activeThreadWorkspace?.kind ?? "local"}</dd>
                </div>
                <div>
                  <dt>Project</dt>
                  <dd>
                    {activeThreadWorkspace?.label ??
                      activeProject?.label ??
                      "Unscoped"}
                  </dd>
                </div>
                <div>
                  <dt>State</dt>
                  <dd>
                    {activeThreadWorkspace?.dirty === true
                      ? "dirty"
                      : activeThreadWorkspace?.dirty === false
                        ? "clean"
                        : "unknown"}
                  </dd>
                </div>
              </dl>
              <p
                className="status-summary"
                title={
                  activeThreadWorkspace?.workspaceRoot ?? activeProject?.path
                }
              >
                {activeThreadWorkspace?.workspaceRoot ??
                  activeProject?.path ??
                  "No workspace selected"}
              </p>
              {activeThreadWorkspace?.kind === "managed" ? (
                <p
                  className="status-summary"
                  title={activeThreadWorkspace.sourceWorkspaceRoot}
                >
                  Source: {activeThreadWorkspace.sourceWorkspaceRoot}
                </p>
              ) : null}
            </section>

            <section className="inspector-section">
              <div className="section-heading">
                <span>Runtime</span>
                <button
                  className="icon-button"
                  type="button"
                  title="Restart runtime"
                  aria-label="Restart runtime"
                  onClick={() => void restartRuntime()}
                >
                  <RefreshCw size={16} />
                </button>
              </div>
              <dl className="status-list">
                <div>
                  <dt>Status</dt>
                  <dd>{runtimeHealth?.state ?? "unknown"}</dd>
                </div>
                <div>
                  <dt>Bridge</dt>
                  <dd>v{bridgeInfo?.version ?? "-"}</dd>
                </div>
                <div>
                  <dt>Process</dt>
                  <dd>
                    {runtimeHealth?.running === true ? "running" : "stopped"}
                  </dd>
                </div>
              </dl>
              <p className="status-summary">
                {runtimeHealth?.summary ?? "Runtime status unavailable."}
              </p>
            </section>

            <section className="inspector-section">
              <div className="section-heading">
                <span>Apps</span>
              </div>
              <button
                className="app-readiness-row"
                type="button"
                onClick={openWeatherSettings}
              >
                <span className="app-readiness-copy">
                  <strong>Weather</strong>
                  <small>Open-Meteo + Visual Crossing fallback</small>
                </span>
                <span
                  className={`provider-status ${weatherCredential?.configured ? "" : "needs-credential"}`}
                >
                  <span aria-hidden="true" />
                  {weatherCredential?.configured
                    ? "Fallback ready"
                    : "Free provider only"}
                </span>
              </button>
            </section>

            <section className="inspector-section">
              <div className="section-heading">
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
                  <Folder size={16} />
                </button>
              </div>
              <div className="project-list">
                {settings?.projects.length === 0 ? (
                  <span className="muted">No projects</span>
                ) : (
                  settings?.projects.map((project) => (
                    <div
                      className="project-row"
                      key={project.path}
                      title={project.path}
                    >
                      <Folder size={14} />
                      <span>{project.label}</span>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="inspector-section">
              <div className="section-heading">
                <span>Provider</span>
                <button
                  className="icon-button"
                  type="button"
                  title="Configure provider and model"
                  aria-label="Configure provider and model"
                  onClick={() => void openProviderSettings()}
                >
                  <Settings size={15} aria-hidden="true" />
                </button>
              </div>
              <select
                aria-label="Model provider"
                value={settings?.selectedProvider ?? "openrouter"}
                onChange={(event) =>
                  void updateProvider(
                    event.target
                      .value as DesktopRendererSettings["selectedProvider"],
                  ).catch((cause) => setError(errorMessage(cause)))
                }
              >
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama</option>
                <option value="lmstudio">LM Studio</option>
              </select>
              <div
                className={`provider-status ${settings?.providerCredentialConfigured === false ? "needs-credential" : ""}`}
              >
                <span aria-hidden="true" />
                {settings?.providerCredentialConfigured === false
                  ? "Credential required"
                  : "Provider ready"}
              </div>
              {modelPolicy !== undefined ? (
                <p className="provider-model" title={modelPolicy.model}>
                  {modelPolicy.model}
                </p>
              ) : null}
              {settings?.providerCredentialConfigured === false &&
              isCredentialedProvider(settings.selectedProvider) ? (
                <form
                  className="provider-credential"
                  onSubmit={(event) => void saveProviderCredential(event)}
                >
                  <input
                    aria-label={`${providerLabel(settings.selectedProvider)} API key`}
                    autoComplete="off"
                    name="provider-api-key"
                    placeholder="API key"
                    type="password"
                    value={providerApiKey}
                    onChange={(event) => setProviderApiKey(event.target.value)}
                  />
                  <button
                    className="icon-button"
                    type="submit"
                    title="Save provider credential"
                    aria-label="Save provider credential"
                    disabled={providerApiKey.trim().length === 0}
                  >
                    <KeyRound size={16} />
                  </button>
                </form>
              ) : null}
            </section>
          </aside>
        ) : null}
      </div>

      {providerSettingsOpen && modelPolicy !== undefined ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              providerSettingsSaving === false
            ) {
              setProviderSettingsOpen(false);
            }
          }}
        >
          <form
            className="provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-dialog-title"
            onSubmit={(event) => void saveProviderSettings(event)}
          >
            <div className="provider-dialog-header">
              <div>
                <h2 id="provider-dialog-title">Model provider</h2>
                <p>Choose the provider and model used for new runs.</p>
              </div>
              <button
                className="icon-button"
                type="button"
                title="Close model provider settings"
                aria-label="Close model provider settings"
                disabled={providerSettingsSaving}
                onClick={() => setProviderSettingsOpen(false)}
              >
                <X size={17} />
              </button>
            </div>

            <label className="provider-dialog-field">
              <span>Provider</span>
              <select
                aria-label="Configured model provider"
                value={providerDraft}
                onChange={(event) => {
                  setProviderDraft(
                    event.target
                      .value as DesktopRendererSettings["selectedProvider"],
                  );
                  setProviderApiKey("");
                }}
              >
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama</option>
                <option value="lmstudio">LM Studio</option>
              </select>
            </label>

            <label className="provider-dialog-field">
              <span>Model ID</span>
              <input
                aria-label="Model ID"
                autoComplete="off"
                value={modelDraft}
                onChange={(event) => setModelDraft(event.target.value)}
                placeholder="Provider model ID"
              />
            </label>

            {isCredentialedProvider(providerDraft) ? (
              <label className="provider-dialog-field">
                <span>API key</span>
                <input
                  aria-label={`${providerLabel(providerDraft)} API key`}
                  autoComplete="off"
                  type="password"
                  value={providerApiKey}
                  onChange={(event) => setProviderApiKey(event.target.value)}
                  placeholder={
                    settings?.selectedProvider === providerDraft &&
                    settings.providerCredentialConfigured
                      ? "Leave blank to keep saved key"
                      : "Enter API key"
                  }
                />
              </label>
            ) : null}

            {providerSettingsError !== undefined ? (
              <div className="provider-dialog-error" role="alert">
                {providerSettingsError}
              </div>
            ) : null}

            <div className="provider-dialog-actions">
              <button
                type="button"
                disabled={providerSettingsSaving}
                onClick={() => setProviderSettingsOpen(false)}
              >
                Cancel
              </button>
              <button
                className="provider-dialog-save"
                type="submit"
                disabled={
                  providerSettingsSaving || modelDraft.trim().length === 0
                }
              >
                {providerSettingsSaving ? "Applying…" : "Apply"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {weatherSettingsOpen ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              weatherSettingsSaving === false
            ) {
              setWeatherSettingsOpen(false);
            }
          }}
        >
          <form
            className="provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="weather-dialog-title"
            onSubmit={(event) => void saveWeatherCredential(event)}
          >
            <div className="provider-dialog-header">
              <div>
                <h2 id="weather-dialog-title">Weather providers</h2>
                <p>
                  Open-Meteo is always available. Add Visual Crossing as a
                  verified fallback.
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                title="Close Weather settings"
                aria-label="Close Weather settings"
                disabled={weatherSettingsSaving}
                onClick={() => setWeatherSettingsOpen(false)}
              >
                <X size={17} />
              </button>
            </div>

            <div className="credential-readiness-card">
              <div>
                <strong>Open-Meteo</strong>
                <span>Primary provider · no key required</span>
              </div>
              <span className="credential-state ready">Ready</span>
            </div>
            <div className="credential-readiness-card">
              <div>
                <strong>Visual Crossing</strong>
                <span>Fallback provider · stored in macOS Keychain</span>
              </div>
              <span
                className={`credential-state ${weatherCredential?.configured ? "ready" : "optional"}`}
              >
                {weatherCredential?.configured ? "Ready" : "Optional"}
              </span>
            </div>

            {weatherCredential?.available === false ? (
              <div className="provider-dialog-error" role="alert">
                Secure credential storage is unavailable on this system.
              </div>
            ) : (
              <label className="provider-dialog-field">
                <span>Visual Crossing API key</span>
                <input
                  aria-label="Visual Crossing API key"
                  autoComplete="off"
                  type="password"
                  value={weatherApiKey}
                  onChange={(event) => setWeatherApiKey(event.target.value)}
                  placeholder={
                    weatherCredential?.configured
                      ? "Enter a new key to replace the saved key"
                      : "Paste your Visual Crossing API key"
                  }
                />
              </label>
            )}

            <p className="provider-dialog-note">
              Kestrel tests the key before saving it. The key is never returned
              to this window.
            </p>

            {weatherSettingsError !== undefined ? (
              <div className="provider-dialog-error" role="alert">
                {weatherSettingsError}
              </div>
            ) : null}

            <div className="provider-dialog-actions provider-dialog-actions-split">
              {weatherCredential?.configured ? (
                <button
                  className="provider-dialog-remove"
                  type="button"
                  disabled={weatherSettingsSaving}
                  onClick={() => void removeWeatherCredential()}
                >
                  Remove fallback
                </button>
              ) : (
                <span />
              )}
              <div>
                <button
                  type="button"
                  disabled={weatherSettingsSaving}
                  onClick={() => setWeatherSettingsOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="provider-dialog-save"
                  type="submit"
                  disabled={
                    weatherSettingsSaving ||
                    weatherCredential?.available === false ||
                    weatherApiKey.trim().length === 0
                  }
                >
                  {weatherSettingsSaving
                    ? "Verifying…"
                    : weatherCredential?.configured
                      ? "Verify and replace"
                      : "Verify and save"}
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function describeRunnerActivity(event: DesktopRunnerEvent): string {
  if (event.type === "run.started") {
    return "Running";
  }
  if (event.type === "run.progress") {
    return "Runtime active";
  }
  if (event.type === "run.agent_progress") {
    const update = asRecord(event.payload.update);
    return `Agent progress: ${readString(update?.message) ?? "Working"}`;
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

function extractTerminalError(event: DesktopRunnerEvent): string | undefined {
  if (event.type !== "run.failed") {
    return;
  }
  const error = asRecord(event.payload.error);
  return readString(error?.message) ?? readString(error?.code) ?? "Run failed.";
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
  return surface === "mcp" ? "MCP servers" : "Diagnostics";
}

function isCredentialedProvider(
  provider: DesktopRendererSettings["selectedProvider"],
): provider is DesktopCredentialedModelProvider {
  return (
    provider === "openrouter" ||
    provider === "openai" ||
    provider === "anthropic"
  );
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
