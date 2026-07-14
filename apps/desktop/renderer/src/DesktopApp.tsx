import {
  Activity,
  Folder,
  KeyRound,
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
  X,
} from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import React from "react";

import type {
  DesktopBridgeInfo,
  DesktopCredentialedModelProvider,
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

type DesktopSurface = "chat" | "mission-control" | "projects" | "mcp" | "diagnostics";

export function DesktopApp() {
  const [state, setState] = useState<DesktopRendererState>();
  const [settings, setSettings] = useState<DesktopRendererSettings>();
  const [runtimeHealth, setRuntimeHealth] = useState<DesktopRuntimeHealth>();
  const [bridgeInfo, setBridgeInfo] = useState<DesktopBridgeInfo>();
  const [draft, setDraft] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [modelPolicy, setModelPolicy] = useState<ModelPolicyV1>();
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [providerDraft, setProviderDraft] = useState<DesktopRendererSettings["selectedProvider"]>("openrouter");
  const [modelDraft, setModelDraft] = useState("");
  const [providerSettingsSaving, setProviderSettingsSaving] = useState(false);
  const [providerSettingsError, setProviderSettingsError] = useState<string>();
  const [activeRun, setActiveRun] = useState<ActiveRun>();
  const [activity, setActivity] = useState("Ready");
  const [error, setError] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [surface, setSurface] = useState<DesktopSurface>("chat");
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

  useEffect(() => {
    return window.kestrelDesktop.onRunnerEvent((event) => {
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
    });
  }, []);

  useEffect(() => {
    return window.kestrelDesktop.onRuntimeHealth(setRuntimeHealth);
  }, []);

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
      const terminalError = extractTerminalError(terminal);
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

  async function updateProvider(
    selectedProvider: DesktopRendererSettings["selectedProvider"],
  ): Promise<void> {
    if (settings === undefined) {
      return;
    }
    setProviderApiKey("");
    const saved = await window.kestrelDesktop.saveSettings({ selectedProvider });
    setSettings(saved);
  }

  async function saveProviderCredential(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (
      settings === undefined
      || isCredentialedProvider(settings.selectedProvider) === false
      || providerApiKey.trim().length === 0
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
      if (isCredentialedProvider(providerDraft) && providerApiKey.trim().length > 0) {
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
              <span>{surface === "mission-control" ? "Mission control" : surface === "mcp" ? "MCP servers" : "Diagnostics"}</span>
              <p>{surface === "mission-control" ? activeThread.title : surface === "mcp" ? "Local integrations" : runtimeHealth?.state ?? "unknown"}</p>
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
            {error !== undefined ? <div className="surface-error" role="alert">{error}</div> : null}
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
                  onClick={() => void openProviderSettings()}
                >
                  <Settings size={15} aria-hidden="true" />
                </button>
              </div>
              <select
                aria-label="Model provider"
                value={settings?.selectedProvider ?? "openrouter"}
                onChange={(event) => void updateProvider(
                  event.target.value as DesktopRendererSettings["selectedProvider"],
                ).catch((cause) => setError(errorMessage(cause)))}
              >
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama</option>
                <option value="lmstudio">LM Studio</option>
              </select>
              <div className={`provider-status ${settings?.providerCredentialConfigured === false ? "needs-credential" : ""}`}>
                <span aria-hidden="true" />
                {settings?.providerCredentialConfigured === false ? "Credential required" : "Provider ready"}
              </div>
              {modelPolicy !== undefined ? (
                <p className="provider-model" title={modelPolicy.model}>{modelPolicy.model}</p>
              ) : null}
              {settings?.providerCredentialConfigured === false
                && isCredentialedProvider(settings.selectedProvider) ? (
                  <form className="provider-credential" onSubmit={(event) => void saveProviderCredential(event)}>
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
            if (event.target === event.currentTarget && providerSettingsSaving === false) {
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
                  setProviderDraft(event.target.value as DesktopRendererSettings["selectedProvider"]);
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
                    settings?.selectedProvider === providerDraft
                    && settings.providerCredentialConfigured
                      ? "Leave blank to keep saved key"
                      : "Enter API key"
                  }
                />
              </label>
            ) : null}

            {providerSettingsError !== undefined ? (
              <div className="provider-dialog-error" role="alert">{providerSettingsError}</div>
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
                disabled={providerSettingsSaving || modelDraft.trim().length === 0}
              >
                {providerSettingsSaving ? "Applying…" : "Apply"}
              </button>
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
    const update = asRecord(event.payload.update);
    return readString(update?.message) ?? readString(update?.summary) ?? "Working";
  }
  if (event.type === "run.reasoning") {
    const update = asRecord(event.payload.update);
    return readString(update?.message) ?? readString(update?.summary) ?? "Thinking";
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
    return undefined;
  }
  const result = asRecord(event.payload.result);
  return readString(result?.assistantText);
}

function extractTerminalError(event: DesktopRunnerEvent): string | undefined {
  if (event.type !== "run.failed") {
    return undefined;
  }
  const error = asRecord(event.payload.error);
  return readString(error?.message) ?? readString(error?.code) ?? "Run failed.";
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
  return surface === "mcp" ? "MCP servers" : "Diagnostics";
}

function isCredentialedProvider(
  provider: DesktopRendererSettings["selectedProvider"],
): provider is DesktopCredentialedModelProvider {
  return provider === "openrouter" || provider === "openai" || provider === "anthropic";
}

function providerLabel(provider: DesktopRendererSettings["selectedProvider"]): string {
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
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
