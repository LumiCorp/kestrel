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
import { DiagnosticsWorkspace } from "./DiagnosticsWorkspace";
import { McpWorkspace } from "./McpWorkspace";
import { MissionControlWorkspace } from "./MissionControlWorkspace";
import { ProjectWorkspace } from "./ProjectWorkspace";
import {
  addRendererThread,
  appendRendererTranscript,
  readDesktopRendererState,
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
    ]).then(([uiState, nextSettings, health, info]) => {
      if (disposed) {
        return;
      }
      setState(readDesktopRendererState(uiState));
      setSettings(nextSettings);
      setActiveProjectPath((current) => current ?? nextSettings.projects[0]?.path);
      setRuntimeHealth(health);
      setBridgeInfo(info);
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
      .catch(() => undefined);
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
    setDraft("");
    setError(undefined);
    setActivity("Starting run");
    setActiveRun({
      threadId,
      sessionId: activeThread.sessionId,
    });
    setState((current) => current === undefined
      ? current
      : appendRendererTranscript(current, threadId, {
          role: "user",
          text: message,
          timestamp: submittedAt,
        }));

    try {
      const terminal = await window.kestrelDesktop.runTurn({
        sessionId: activeThread.sessionId,
        message,
        eventType: "user.message",
        history,
        interactionMode: activeThread.mode,
        ...(activeThread.mode === "build" ? { actSubmode: "safe" } : {}),
      });
      const assistantText = extractTerminalMessage(terminal);
      if (assistantText !== undefined) {
        setState((current) => current === undefined
          ? current
          : appendRendererTranscript(current, threadId, {
              role: "assistant",
              text: assistantText,
              timestamp: new Date().toISOString(),
            }));
      }
      setActivity(terminal.type === "run.cancelled" ? "Cancelled" : "Ready");
    } catch (cause) {
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
                  onClick={() => setState((current) => current === undefined ? current : addRendererThread(current))}
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
                    onClick={() => setState((current) => current === undefined
                      ? current
                      : selectRendererThread(current, thread.id))}
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
                <div className="message-body">{line.text}</div>
              </article>
            ))}
            <div ref={transcriptEndRef} />
          </section>

          <div className="activity-line" aria-live="polite">
            <Activity size={14} aria-hidden="true" />
            <span>{activity}</span>
            {error !== undefined ? <span className="activity-error">{error}</span> : null}
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
              <ProjectWorkspace project={activeProject} onError={setError} />
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
                <Settings size={15} aria-hidden="true" />
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
  if (event.type === "run.cancelled") {
    return "Run cancelled.";
  }
  if (event.type === "run.failed") {
    const payload = asRecord(event.payload);
    const error = asRecord(payload?.error);
    return readString(error?.message) ?? readString(payload?.message) ?? "The run failed.";
  }
  if (event.type !== "run.completed") {
    return undefined;
  }
  const result = asRecord(event.payload.result);
  const output = asRecord(result?.output);
  if (output?.status === "WAITING") {
    const waitFor = asRecord(output.waitFor);
    const eventType = readString(waitFor?.eventType);
    return eventType === undefined ? "Waiting for input." : `Waiting for ${eventType}.`;
  }
  return extractMessage(result?.finalizedPayload)
    ?? readString(output?.message)
    ?? (typeof output?.status === "string" ? output.status : undefined);
}

function extractMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value.trim() : undefined;
  }
  const record = asRecord(value);
  return readString(record?.message)
    ?? readString(record?.text)
    ?? readString(record?.content)
    ?? readString(asRecord(record?.data)?.plainText);
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
