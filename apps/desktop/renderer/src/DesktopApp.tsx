import {
  Activity,
  Folder,
  ListChecks,
  MessageSquare,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Plug,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Square,
  Sun,
  Wrench,
} from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  DesktopBridgeInfo,
  DesktopCapabilityId,
  DesktopReadinessItemId,
  DesktopRendererSettings,
  DesktopRunnerEvent,
  DesktopRuntimeHealth,
} from "../../src/contracts";
import type { ModelPolicyV1 } from "../../../../src/profile/modelPolicy";
import { DiagnosticsWorkspace } from "./DiagnosticsWorkspace";
import { MessageContent } from "./MessageContent";
import { McpWorkspace } from "./McpWorkspace";
import { MissionControlWorkspace } from "./MissionControlWorkspace";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { SettingsWorkspace } from "./SettingsWorkspace";
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
} from "./state";

interface ActiveRun {
  threadId: string;
  sessionId: string;
  runId?: string | undefined;
}

type DesktopSurface = "chat" | "mission-control" | "projects" | "mcp" | "settings" | "diagnostics";

export function DesktopApp() {
  const [state, setState] = useState<DesktopRendererState>();
  const [settings, setSettings] = useState<DesktopRendererSettings>();
  const [runtimeHealth, setRuntimeHealth] = useState<DesktopRuntimeHealth>();
  const [bridgeInfo, setBridgeInfo] = useState<DesktopBridgeInfo>();
  const [draft, setDraft] = useState("");
  const [modelPolicy, setModelPolicy] = useState<ModelPolicyV1>();
  const [activeRun, setActiveRun] = useState<ActiveRun>();
  const [activity, setActivity] = useState("Ready");
  const [error, setError] = useState<string>();
  const [errorCapability, setErrorCapability] = useState<DesktopCapabilityId>();
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [surface, setSurface] = useState<DesktopSurface>("chat");
  const [settingsTarget, setSettingsTarget] = useState<DesktopCapabilityId>();
  const [missionControlRevision, setMissionControlRevision] = useState(0);
  const [activeProjectPath, setActiveProjectPath] = useState<string>();
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const activeThread = useMemo(
    () => state?.threads.find((thread) => thread.id === state.activeThreadId),
    [state],
  );

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      window.kestrelDesktop.getUiState(),
      window.kestrelDesktop.getSettings(),
      window.kestrelDesktop.getRuntimeHealth(),
      window.kestrelDesktop.getBridgeInfo(),
      window.kestrelDesktop.getModelPolicy(),
    ]).then(([uiState, nextSettings, health, info, nextModelPolicy]) => {
      if (disposed) {
        return;
      }
      setState(readDesktopRendererState(uiState));
      setSettings(nextSettings);
      setActiveProjectPath((current) => current ?? nextSettings.projects[0]?.path);
      setRuntimeHealth(health);
      setBridgeInfo(info);
      setModelPolicy(nextModelPolicy);
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
      if (event.type === "run.started") {
        setActiveRun((current) => current === undefined
          ? current
          : {
              ...current,
              ...(event.runId !== undefined ? { runId: event.runId } : {}),
            });
      }
      if (
        event.type === "task.updated"
        || event.type === "run.completed"
        || event.type === "run.failed"
        || event.type === "run.cancelled"
      ) {
        setMissionControlRevision((value) => value + 1);
      }
    }), []);

  useEffect(() => window.kestrelDesktop.onRuntimeHealth(setRuntimeHealth), []);

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
      state === undefined
      || activeThread === undefined
      || message.trim().length === 0
      || activeRun !== undefined
    ) {
      return;
    }
    const submittedAt = new Date().toISOString();
    const threadId = activeThread.id;
    const history = toDesktopRunHistory(activeThread);
    const continuation = getRendererTurnContinuation(activeThread);
    const projectPath = resolveRendererThreadProjectPath({
      thread: activeThread,
      ...(activeProjectPath !== undefined ? { activeProjectPath } : {}),
      projects: settings?.projects ?? [],
    });
    const submittedPendingWaitEventType = activeThread.pendingWaitEventType;
    setDraft("");
    setError(undefined);
    setErrorCapability(undefined);
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
        interactionMode: activeThread.mode,
        ...(projectPath !== undefined
          ? { projectPath }
          : {}),
        ...(activeThread.mode === "build" ? { actSubmode: "safe" } : {}),
      });
      const assistantText = extractTerminalMessage(terminal);
      const terminalFailure = extractTerminalFailure(terminal, settings?.selectedProvider);
      const terminalError = terminalFailure?.message;
      const pendingWaitEventType = getTerminalWaitEventType(terminal);
      const waitingPrompt = getTerminalWaitingPrompt(terminal);
      const terminalLine = assistantText !== undefined
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
          const appended = appendRendererTranscript(current, threadId, terminalLine);
          return updateRendererThread(appended, threadId, (thread) => ({
            ...thread,
            pendingWaitEventType,
          }));
        });
      } else {
        setState((current) => current === undefined
          ? current
          : updateRendererThread(current, threadId, (thread) => ({
              ...thread,
              pendingWaitEventType,
            })));
      }
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
        setState((current) => current === undefined
          ? current
          : updateRendererThread(current, threadId, (thread) => ({
              ...thread,
              pendingWaitEventType: submittedPendingWaitEventType,
            })));
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
    setState((current) => current === undefined
      ? current
      : addRendererThread(current, { projectPath }));
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
        <span className="brand-mark">K</span>
        <p>{error ?? "Opening Kestrel"}</p>
      </main>
    );
  }

  const healthState = runtimeHealth?.state ?? "degraded";
  const activeProject = settings?.projects.find(
    (project) => project.path === activeProjectPath
  ) ?? settings?.projects[0];
  const showInspector = surface === "chat" && inspectorOpen;
  return (
    <div className="desktop-app">
      <header className="titlebar">
        <div className="brand-lockup">
          <span className="brand-mark">K</span>
          <strong>Kestrel</strong>
        </div>
        <div className="titlebar-context" title={surfaceTitle(surface, activeThread.title, activeProject?.label)}>
          {surfaceTitle(surface, activeThread.title, activeProject?.label)}
        </div>
        <div className="titlebar-actions">
          <span className={`health-indicator health-${healthState}`}>
            <span aria-hidden="true" />
            {healthState}
          </span>
          <button
            className="icon-button"
            type="button"
            title={state.theme === "dark" ? "Use light theme" : "Use dark theme"}
            aria-label={state.theme === "dark" ? "Use light theme" : "Use dark theme"}
            onClick={() => setState((current) => current === undefined
              ? current
              : setRendererTheme(current, current.theme === "dark" ? "light" : "dark"))}
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
              {inspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
            </button>
          ) : null}
        </div>
      </header>

      <div className={`workspace ${showInspector ? "with-inspector" : ""}`}>
        <aside className="conversation-rail" aria-label="Conversations">
          <nav className="surface-tabs" aria-label="Kestrel views">
            <button className={surface === "chat" ? "active" : ""} type="button" title="Conversations" aria-label="Conversations" onClick={() => setSurface("chat")}>
              <MessageSquare size={17} />
            </button>
            <button className={surface === "mission-control" ? "active" : ""} type="button" title="Mission control" aria-label="Mission control" onClick={() => setSurface("mission-control")}>
              <ListChecks size={17} />
            </button>
            <button className={surface === "projects" ? "active" : ""} type="button" title="Projects" aria-label="Projects" onClick={() => setSurface("projects")}>
              <Folder size={17} />
            </button>
            <button className={surface === "mcp" ? "active" : ""} type="button" title="MCP servers" aria-label="MCP servers" onClick={() => setSurface("mcp")}>
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
                      setState((current) => current === undefined
                        ? current
                        : selectRendererThread(current, thread.id));
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
                  onClick={() => void addProject().catch((cause) => setError(errorMessage(cause)))}
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
                {settings?.projects.length === 0 ? <p className="rail-empty">No projects</p> : null}
              </nav>
            </>
          ) : (
            <div className="rail-context">
              <span>{surface === "mission-control" ? "Mission control" : surface === "mcp" ? "MCP servers" : surface === "settings" ? "Settings" : "Diagnostics"}</span>
              <p>{surface === "mission-control" ? activeThread.title : surface === "mcp" ? "Local integrations" : surface === "settings" ? "Capabilities and readiness" : runtimeHealth?.state ?? "unknown"}</p>
            </div>
          )}
        </aside>

        {surface === "chat" ? (
          <main className="conversation-pane" id="app-main">
          <section className="transcript" aria-label="Conversation transcript">
            {activeThread.transcript.length === 0 ? (
              <div className="empty-transcript">
                <span className="brand-mark large">K</span>
                <h1>New conversation</h1>
              </div>
            ) : activeThread.transcript.map((line, index) => (
              <article className={`message message-${line.role}`} key={`${line.timestamp}-${index}`}>
                <div className="message-meta">
                  <strong>{line.role === "user" ? "You" : line.role === "assistant" ? "Kestrel" : "System"}</strong>
                  <time>{formatMessageTime(line.timestamp)}</time>
                </div>
                <MessageContent role={line.role} text={line.text} />
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
            <div className="composer-actions">
              <span>{activeThread.mode === "build" ? "Safe build" : modeLabel(activeThread.mode)}</span>
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
            {error !== undefined ? <div className="surface-error" role="alert"><span>{error}</span>{errorCapability !== undefined ? <button type="button" onClick={() => openCapabilitySettings(errorCapability)}>Open capability settings</button> : null}</div> : null}
            {surface === "projects" ? (
              <ProjectWorkspace
                project={activeProject}
                onChat={(project) => startProjectConversation(project.path)}
                onError={setError}
              />
            ) : surface === "mission-control" ? (
              <MissionControlWorkspace
                sessionId={activeThread.sessionId}
                project={activeProject}
                refreshVersion={missionControlRevision}
                onError={setError}
              />
            ) : surface === "mcp" ? (
              <McpWorkspace onError={setError} />
            ) : surface === "settings" ? (
              <SettingsWorkspace
                initialCapabilityId={settingsTarget}
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

        {showInspector ? (
          <aside className="inspector" aria-label="Desktop status">
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
                <div><dt>Status</dt><dd>{runtimeHealth?.state ?? "unknown"}</dd></div>
                <div><dt>Bridge</dt><dd>v{bridgeInfo?.version ?? "-"}</dd></div>
                <div><dt>Process</dt><dd>{runtimeHealth?.running === true ? "running" : "stopped"}</dd></div>
              </dl>
              <p className="status-summary">{runtimeHealth?.summary ?? "Runtime status unavailable."}</p>
            </section>

            <section className="inspector-section">
              <div className="section-heading">
                <span>Apps</span>
              </div>
              <button
                className="app-readiness-row"
                type="button"
                onClick={() => openCapabilitySettings("tools.weather")}
              >
                <span className="app-readiness-copy">
                  <strong>Weather</strong>
                  <small>Open-Meteo + Visual Crossing fallback</small>
                </span>
                <span className="provider-status">
                  <span aria-hidden="true" />
                  View readiness
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
                  onClick={() => void addProject().catch((cause) => setError(errorMessage(cause)))}
                >
                  <Folder size={16} />
                </button>
              </div>
              <div className="project-list">
                {settings?.projects.length === 0 ? (
                  <span className="muted">No projects</span>
                ) : settings?.projects.map((project) => (
                  <div className="project-row" key={project.path} title={project.path}>
                    <Folder size={14} />
                    <span>{project.label}</span>
                  </div>
                ))}
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
                  onClick={() => settings !== undefined && openCapabilitySettings(`model.${settings.selectedProvider}`)}
                >
                  <Settings size={15} aria-hidden="true" />
                </button>
              </div>
              <div className="provider-status">
                <span aria-hidden="true" />
                {settings?.selectedProvider ?? "Provider unavailable"}
              </div>
              {modelPolicy !== undefined ? (
                <p className="provider-model" title={modelPolicy.model}>{modelPolicy.model}</p>
              ) : null}
              <button className="secondary-button" type="button" onClick={() => settings !== undefined && openCapabilitySettings(`model.${settings.selectedProvider}`)}>
                Open capability settings
              </button>
            </section>
          </aside>
        ) : null}
      </div>

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
    if (update?.contentState === "not_retained") return "Provider reasoning was not retained";
    const label = update?.format === "summary"
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
    event.type === "run.tool.started"
    || event.type === "run.tool.completed"
    || event.type === "run.tool.failed"
  ) {
    const payload = asRecord(event.payload);
    const update = asRecord(payload?.update);
    return readString(update?.toolName)
      ?? readString(payload?.toolName)
      ?? "Using tool";
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
    return ;
  }
  const result = asRecord(event.payload.result);
  return readString(result?.assistantText);
}

export function extractTerminalFailure(
  event: DesktopRunnerEvent,
  selectedProvider: DesktopRendererSettings["selectedProvider"] | undefined,
): { message: string; capabilityId?: DesktopCapabilityId | undefined } | undefined {
  if (event.type !== "run.failed") {
    return ;
  }
  const error = asRecord(event.payload.error);
  const code = readString(error?.code);
  const details = asRecord(error?.details);
  const explicitCapabilityId = readDesktopCapabilityId(details?.capabilityId);
  return {
    message: readString(error?.message) ?? code ?? "Run failed.",
    capabilityId: explicitCapabilityId ?? capabilityForRuntimeFailureCode(code, selectedProvider),
  };
}

function capabilityForRuntimeFailureCode(
  code: string | undefined,
  selectedProvider: DesktopRendererSettings["selectedProvider"] | undefined,
): DesktopCapabilityId | undefined {
  if (code === "IO_MODEL_FAILED" || code === "IO_MODEL_TIMEOUT" || code === "MODEL_POLICY_INVALID") {
    return selectedProvider === undefined ? undefined : `model.${selectedProvider}`;
  }
  if (MCP_FAILURE_CODES.has(code ?? "")) return "connections.mcp";
  if (DEV_SHELL_FAILURE_CODES.has(code ?? "")) return "local.developer_shell";
  if (DATABASE_FAILURE_CODES.has(code ?? "")) return "data.database";
  if (code === "STORE_SQLITE_INIT_FAILED") return "data.database";
  return ;
}

const MCP_FAILURE_CODES = new Set([
  "MCP_CLIENT_METHOD_MISSING", "MCP_ENV_VAR_REQUIRED", "MCP_HEADER_ENV_REQUIRED",
  "MCP_HTTP_TRANSPORT_UNAVAILABLE", "MCP_PRECHECK_FAILED", "MCP_SDK_CLIENT_MISSING",
  "MCP_SSE_TRANSPORT_UNAVAILABLE", "MCP_STDIO_TRANSPORT_UNAVAILABLE", "MCP_TOOL_UNAVAILABLE",
  "MCP_HOSTED_SCOPE_UNAVAILABLE", "MCP_TOOL_NAME_COLLISION",
]);
const DEV_SHELL_FAILURE_CODES = new Set([
  "DEV_SHELL_COMMAND_INVALID", "DEV_SHELL_CWD_NOT_FOUND", "DEV_SHELL_CWD_OUTSIDE_WORKSPACE",
  "DEV_SHELL_PATH_OUTSIDE_WORKSPACE", "DEV_SHELL_PROCESS_NOT_FOUND", "DEV_SHELL_PROCESS_NOT_RUNNING",
  "DEV_SHELL_SHELL_UNAVAILABLE", "DEV_SHELL_SOURCE_WRITE_AUTHORITY_DENIED", "DEV_SHELL_WORKSPACE_NOT_FOUND",
  "DEV_SHELL_SERVICE_REQUEST_FAILED", "DEV_SHELL_SERVICE_UNAVAILABLE", "DEV_SHELL_MIGRATION_FAILED",
]);
const DATABASE_FAILURE_CODES = new Set([
  "STORE_DATABASE_URL_REQUIRED", "STORE_ENSURE_SESSION_FAILED", "STORE_SCHEMA_V3_REQUIRED",
  "DATABASE_UNREACHABLE", "DATABASE_URL_INVALID", "LOCAL_CORE_DATABASE_BLOCKED",
  "LOCAL_CORE_EXTERNAL_DATABASE_INIT_FAILED", "LOCAL_CORE_EXTERNAL_DATABASE_URL_REQUIRED",
  "LOCAL_CORE_PGLITE_INIT_FAILED", "LOCAL_CORE_MIGRATIONS_BLOCKED", "LOCAL_CORE_MIGRATION_FAILED",
]);

function readDesktopCapabilityId(value: unknown): DesktopCapabilityId | undefined {
  const ids: DesktopCapabilityId[] = [
    "model.openrouter", "model.openai", "model.anthropic", "model.ollama", "model.lmstudio",
    "tools.internet.tavily", "tools.weather", "tools.network.free", "local.filesystem",
    "local.developer_shell", "local.sandbox_code", "connections.mcp", "data.workspace",
    "data.database", "permission.microphone",
  ];
  return typeof value === "string" && ids.includes(value as DesktopCapabilityId) ? value as DesktopCapabilityId : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function modeLabel(mode: RendererMode): string {
  return mode === "chat" ? "Chat" : mode === "plan" ? "Plan" : "Build";
}

function surfaceTitle(
  surface: DesktopSurface,
  threadTitle: string,
  projectLabel: string | undefined
) {
  if (surface === "chat") {
    return threadTitle;
  }
  if (surface === "projects") {
    return projectLabel ?? "Projects";
  }
  if (surface === "mission-control") {
    return "Mission control";
  }
  return surface === "mcp" ? "MCP servers" : surface === "settings" ? "Settings" : "Diagnostics";
}

function formatThreadTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatMessageTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
