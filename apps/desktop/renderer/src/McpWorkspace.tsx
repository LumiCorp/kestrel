import {
  KESTREL_STANDARD_APP_MANIFESTS,
  type KestrelAppManifest,
} from "@kestrel-agents/protocol";
import {
  KeyRound,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  DesktopMcpDiscoveryResult,
  DesktopMcpServerConfig,
  DesktopMcpServerMutationInput,
} from "../../src/contracts";
import {
  getDesktopAppDefinition,
  getDesktopStandardAppConnection,
} from "../../../../src/desktopShell/configuration";
import { keepFocusInsideDialog } from "./dialogFocus";

const DESKTOP_STANDARD_APPS = KESTREL_STANDARD_APP_MANIFESTS;

type McpTransport = DesktopMcpServerMutationInput["transport"];
type McpCredentialInput = NonNullable<
  DesktopMcpServerMutationInput["credentials"]
>[number];

interface McpCredentialDraft {
  key: string;
  name: string;
  secret: string;
  credentialId?: `mcp.${string}` | undefined;
  envKey?: string | undefined;
}

interface McpServerDraft {
  id: string;
  name: string;
  transport: McpTransport;
  target: string;
  args: string;
  bearer: string;
  bearerCredentialId?: `mcp.${string}` | undefined;
  bearerEnvKey?: string | undefined;
  credentials: McpCredentialDraft[];
}

interface McpWorkspaceProps {
  onError: (message: string | undefined) => void;
}

export function McpWorkspace({ onError }: McpWorkspaceProps) {
  const [result, setResult] = useState<DesktopMcpDiscoveryResult>();
  const [selectedId, setSelectedId] = useState<string>(
    `app:${DESKTOP_STANDARD_APPS[0]?.id ?? ""}`,
  );
  const [loading, setLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<McpServerDraft>(() => emptyMcpDraft());
  const [editorError, setEditorError] = useState<string>();
  const [editingServerId, setEditingServerId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const loadingRef = useRef(false);
  const editorRef = useRef<HTMLFormElement>(null);
  const selectedStandardApp = useMemo(
    () => DESKTOP_STANDARD_APPS.find((app) => `app:${app.id}` === selectedId),
    [selectedId],
  );
  const selected = useMemo(
    () =>
      selectedStandardApp !== undefined
        ? result?.servers.find(
            (server) => server.appId === selectedStandardApp.id,
          )
        : result?.servers.find(
            (server) => `server:${server.id}` === selectedId,
          ),
    [result, selectedId, selectedStandardApp],
  );
  const editingServer = result?.servers.find(
    (server) =>
      server.id === editingServerId && server.sourceKind === "desktop-managed",
  );

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    if (editorOpen === false) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && loadingRef.current === false) closeEditor();
      keepFocusInsideDialog(event, editorRef.current);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [editorOpen]);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const discovered = await window.kestrelDesktop.discoverMcpServers();
      setResult(discovered);
      setSelectedId((current) =>
        DESKTOP_STANDARD_APPS.some((app) => `app:${app.id}` === current) ||
        discovered.servers.some((server) => `server:${server.id}` === current)
          ? current
          : `app:${DESKTOP_STANDARD_APPS[0]?.id ?? ""}`,
      );
      onError(undefined);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  async function saveServer(
    input: DesktopMcpServerMutationInput,
    successMessage?: string,
  ): Promise<boolean> {
    setLoading(true);
    setEditorError(undefined);
    try {
      const next = await window.kestrelDesktop.saveMcpServer(input);
      setResult(next);
      setSelectedId(
        input.appId !== undefined ? `app:${input.appId}` : `server:${input.id}`,
      );
      setEditorOpen(false);
      setConfirmingRemove(false);
      setNotice(
        successMessage ??
          `${input.name} was verified and applied to the Desktop runtime.`,
      );
      onError(undefined);
      return true;
    } catch (cause) {
      const message = errorMessage(cause);
      if (editorOpen) setEditorError(message);
      else onError(message);
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function removeServer(server: DesktopMcpServerConfig): Promise<void> {
    setLoading(true);
    try {
      setResult(await window.kestrelDesktop.deleteMcpServer(server.id));
      setSelectedId(
        server.appId !== undefined
          ? `app:${server.appId}`
          : `app:${DESKTOP_STANDARD_APPS[0]?.id ?? ""}`,
      );
      setConfirmingRemove(false);
      setNotice(
        `${server.name} was removed from Desktop and its stored credentials were deleted.`,
      );
      onError(undefined);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  function beginAdd(): void {
    setDraft(emptyMcpDraft());
    setEditingServerId(undefined);
    setEditorError(undefined);
    setEditorOpen(true);
  }

  function beginEdit(server: DesktopMcpServerConfig): void {
    const bearer = server.credentials?.find(
      (binding) => binding.kind === "bearer",
    );
    setDraft({
      id: server.id,
      name: server.name,
      transport: server.transport,
      target:
        server.transport === "stdio"
          ? (server.command ?? "")
          : (server.url ?? ""),
      args: server.args?.join("\n") ?? "",
      bearer: "",
      bearerCredentialId: bearer?.credentialId,
      bearerEnvKey: bearer?.envKey,
      credentials:
        server.credentials
          ?.filter((binding) => binding.kind !== "bearer")
          .map((binding) => ({
            key: binding.credentialId,
            name: binding.name ?? "",
            secret: "",
            credentialId: binding.credentialId,
            envKey: binding.envKey,
          })) ?? [],
    });
    setEditingServerId(server.id);
    setEditorError(undefined);
    setEditorOpen(true);
  }

  function closeEditor(): void {
    if (loading) return;
    setEditorOpen(false);
    setEditorError(undefined);
  }

  function updateCredential(
    index: number,
    patch: Partial<McpCredentialDraft>,
  ): void {
    setDraft((current) => ({
      ...current,
      credentials: current.credentials.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    }));
  }

  function removeCredentialRow(index: number): void {
    setDraft((current) => ({
      ...current,
      credentials: current.credentials.filter(
        (_, entryIndex) => entryIndex !== index,
      ),
    }));
  }

  async function submitEditor(): Promise<void> {
    const existing = editingServer;
    if (
      existing === undefined &&
      result?.servers.some((server) => server.id === draft.id.trim())
    ) {
      setEditorError(
        "That App ID already exists. Select the App and use Edit instead.",
      );
      return;
    }
    const namedCredentials: McpCredentialInput[] = draft.credentials
      .filter((entry) => entry.name.trim().length > 0)
      .map((entry) => ({
        kind: draft.transport === "stdio" ? "environment" : "header",
        name: entry.name.trim(),
        ...(entry.credentialId !== undefined
          ? { credentialId: entry.credentialId }
          : {}),
        ...(entry.envKey !== undefined ? { envKey: entry.envKey } : {}),
        ...(entry.secret.trim().length > 0
          ? { secret: entry.secret.trim() }
          : {}),
      }));
    const credentials: McpCredentialInput[] = [
      ...(draft.transport !== "stdio" &&
      (draft.bearer.trim().length > 0 || draft.bearerCredentialId !== undefined)
        ? [
            {
              kind: "bearer" as const,
              ...(draft.bearerCredentialId !== undefined
                ? { credentialId: draft.bearerCredentialId }
                : {}),
              ...(draft.bearerEnvKey !== undefined
                ? { envKey: draft.bearerEnvKey }
                : {}),
              ...(draft.bearer.trim().length > 0
                ? { secret: draft.bearer.trim() }
                : {}),
            },
          ]
        : []),
      ...namedCredentials,
    ];
    await saveServer({
      id: draft.id.trim(),
      name: draft.name.trim() || draft.id.trim(),
      transport: draft.transport,
      ...(draft.transport === "stdio"
        ? {
            command: draft.target.trim(),
            args: draft.args
              .split(/\r?\n/u)
              .map((arg) => arg.trim())
              .filter((arg) => arg.length > 0),
          }
        : { url: draft.target.trim() }),
      credentials,
      toolPolicies:
        existing === undefined
          ? undefined
          : buildMcpMutationInput(existing, true).toolPolicies,
      enabled: true,
    });
  }

  return (
    <main className="surface-pane mcp-surface" id="app-main">
      <header className="surface-header">
        <div>
          <span className="surface-kicker">Capabilities</span>
          <h1>Apps</h1>
          <p>
            {result === undefined
              ? "Finding available Apps"
              : `Updated ${formatTime(result.discoveredAt)}`}
          </p>
        </div>
        <div className="surface-header-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={loading}
            onClick={beginAdd}
          >
            <Plus size={15} aria-hidden="true" /> Add Custom App
          </button>
          <button
            className="icon-button"
            type="button"
            title="Refresh Apps"
            aria-label="Refresh Apps"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} className={loading ? "spin" : undefined} />
          </button>
        </div>
      </header>

      {notice !== undefined ? (
        <p className="settings-notice mcp-notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="mcp-grid" aria-busy={loading}>
        <section className="workspace-panel" aria-label="Available Apps">
          <div className="panel-toolbar">
            <span>Available Apps</span>
            <span className="toolbar-status">
              {DESKTOP_STANDARD_APPS.length +
                (result?.servers.filter((server) => server.appId === undefined)
                  .length ?? 0)}
            </span>
          </div>
          <div className="mcp-list">
            {DESKTOP_STANDARD_APPS.map((app) => {
              const connection = result?.servers.find(
                (server) => server.appId === app.id,
              );
              const workflowDependencies =
                app.category === "workflow"
                  ? getDesktopWorkflowDependencies(app, result?.servers ?? [])
                  : [];
              const workflowReady = workflowDependencies.every(
                (dependency) => dependency.ready,
              );
              return (
                <button
                  type="button"
                  className={`mcp-row ${selectedId === `app:${app.id}` ? "active" : ""}`}
                  key={app.id}
                  onClick={() => {
                    setSelectedId(`app:${app.id}`);
                    setConfirmingRemove(false);
                  }}
                >
                  <Plug size={16} aria-hidden="true" />
                  <span>
                    <strong>{app.name}</strong>
                    <small>
                      {app.capabilityPacks.length}{" "}
                      {app.capabilityPacks.length === 1
                        ? "capability pack"
                        : "capability packs"}
                    </small>
                  </span>
                  <span
                    className={`mcp-enabled ${connection?.enabled ? "enabled" : ""}`}
                  >
                    {app.category === "workflow"
                      ? workflowReady
                        ? "Ready"
                        : `Needs ${workflowDependencies.filter((dependency) => !dependency.ready).length} Apps`
                      : app.category === "built_in"
                        ? getDesktopAppDefinition(app.id) !== undefined
                          ? "Included"
                          : "Kestrel One"
                        : connection === undefined
                          ? getDesktopStandardAppConnection(app.id) !==
                            undefined
                            ? "Available"
                            : "Not connected"
                          : connection.enabled
                            ? "Connected"
                            : "Disabled"}
                  </span>
                </button>
              );
            })}
            {result?.servers
              .filter((server) => server.appId === undefined)
              .map((server) => (
                <button
                  type="button"
                  className={`mcp-row ${selectedId === `server:${server.id}` ? "active" : ""}`}
                  key={server.id}
                  onClick={() => {
                    setSelectedId(`server:${server.id}`);
                    setConfirmingRemove(false);
                  }}
                >
                  <Plug size={16} aria-hidden="true" />
                  <span>
                    <strong>{server.name}</strong>
                    <small>
                      {server.toolCount ?? 0}{" "}
                      {server.toolCount === 1 ? "capability" : "capabilities"}
                    </small>
                  </span>
                  <span
                    className={`mcp-enabled ${server.sourceKind === "desktop-managed" && server.enabled ? "enabled" : ""}`}
                  >
                    {server.sourceKind === "desktop-managed"
                      ? server.enabled
                        ? "Enabled"
                        : "Disabled"
                      : "Discovered"}
                  </span>
                </button>
              ))}
          </div>
        </section>

        <section
          className="workspace-panel mcp-detail"
          aria-label="App details"
        >
          <div className="panel-toolbar">
            <span>App details</span>
            {selected?.toolCount !== undefined ? (
              <span className="toolbar-status">
                {selected.toolCount}{" "}
                {selected.toolCount === 1 ? "tool" : "tools"}
              </span>
            ) : null}
          </div>
          {selectedStandardApp !== undefined ? (
            <StandardAppDetail
              app={selectedStandardApp}
              server={selected}
              loading={loading}
              confirmingRemove={confirmingRemove}
              onConnect={(input) =>
                void saveServer(
                  input,
                  `${selectedStandardApp.name} was verified and connected.`,
                )
              }
              servers={result?.servers ?? []}
              onConfirmRemove={() => setConfirmingRemove(true)}
              onCancelRemove={() => setConfirmingRemove(false)}
              onRemove={() =>
                selected !== undefined ? void removeServer(selected) : undefined
              }
              onSave={(enabled) =>
                selected !== undefined
                  ? void saveServer(
                      buildMcpMutationInput(selected, enabled),
                      `${selectedStandardApp.name} was ${enabled ? "verified and enabled" : "disabled"}.`,
                    )
                  : undefined
              }
              onPolicyChange={(
                toolName,
                approvalMode,
                allowedInteractionModes,
              ) => {
                if (selected === undefined) return;
                const input = buildMcpMutationInput(selected, selected.enabled);
                input.toolPolicies = {
                  ...input.toolPolicies,
                  [toolName]: { approvalMode, allowedInteractionModes },
                };
                void saveServer(input, `${toolName} policy was applied.`);
              }}
            />
          ) : selected === undefined ? (
            <div className="panel-empty large-empty">
              <Wrench size={22} aria-hidden="true" />
              <span>Select an App</span>
            </div>
          ) : (
            <McpServerDetail
              server={selected}
              loading={loading}
              confirmingRemove={confirmingRemove}
              onConfirmRemove={() => setConfirmingRemove(true)}
              onCancelRemove={() => setConfirmingRemove(false)}
              onSave={(enabled) =>
                void saveServer(
                  buildMcpMutationInput(selected, enabled),
                  `${selected.name} was ${enabled ? "verified and enabled" : "disabled"}.`,
                )
              }
              onEdit={() => beginEdit(selected)}
              onPolicyChange={(
                toolName,
                approvalMode,
                allowedInteractionModes,
              ) => {
                const input = buildMcpMutationInput(selected, selected.enabled);
                input.toolPolicies = {
                  ...input.toolPolicies,
                  [toolName]: { approvalMode, allowedInteractionModes },
                };
                void saveServer(input, `${toolName} policy was applied.`);
              }}
              onRemove={() => void removeServer(selected)}
            />
          )}
        </section>
      </div>

      {result !== undefined &&
      result.diagnostics.some(
        (entry) => entry.status === "invalid" || entry.status === "error",
      ) ? (
        <section
          className="diagnostic-strip"
          aria-label="Custom App diagnostics"
        >
          {result.diagnostics
            .filter(
              (entry) => entry.status === "invalid" || entry.status === "error",
            )
            .map((entry) => (
              <div key={`${entry.source}-${entry.path}`}>
                <strong>{entry.source}</strong>
                <span>{entry.message ?? entry.status}</span>
              </div>
            ))}
        </section>
      ) : null}

      {editorOpen ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditor();
          }}
        >
          <form
            className="provider-dialog mcp-editor-dialog"
            ref={editorRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-editor-title"
            aria-describedby="mcp-editor-description"
            aria-busy={loading}
            onSubmit={(event) => {
              event.preventDefault();
              void submitEditor();
            }}
          >
            <div className="provider-dialog-header">
              <div>
                <span className="surface-kicker">Custom App</span>
                <h2 id="mcp-editor-title">
                  {editingServer === undefined
                    ? "Add Custom App"
                    : `Edit ${editingServer.name}`}
                </h2>
                <p id="mcp-editor-description">
                  Kestrel verifies the connection and capabilities before making
                  the App available to agents.
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close Custom App editor"
                disabled={loading}
                onClick={closeEditor}
              >
                <X size={17} />
              </button>
            </div>

            <div className="mcp-editor-grid">
              <label className="provider-dialog-field">
                <span>App ID *</span>
                <input
                  autoFocus
                  value={draft.id}
                  disabled={editingServer !== undefined}
                  required
                  placeholder="company-tools"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      id: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="provider-dialog-field">
                <span>Display name</span>
                <input
                  value={draft.name}
                  placeholder="Company tools"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="provider-dialog-field">
                <span>Runs *</span>
                <select
                  value={draft.transport}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      transport: event.target.value as McpTransport,
                    }))
                  }
                >
                  <option value="stdio">On this device</option>
                  <option value="http">Hosted service</option>
                  <option value="sse">Hosted service (legacy)</option>
                </select>
              </label>
            </div>

            <label className="provider-dialog-field">
              <span>
                {draft.transport === "stdio" ? "Command" : "App URL"} *
              </span>
              <input
                type={draft.transport === "stdio" ? "text" : "url"}
                required
                placeholder={
                  draft.transport === "stdio"
                    ? "npx"
                    : "https://apps.example.com"
                }
                value={draft.target}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    target: event.target.value,
                  }))
                }
              />
            </label>
            {draft.transport === "stdio" ? (
              <label className="provider-dialog-field">
                <span>
                  Command arguments <small>One per line</small>
                </span>
                <textarea
                  rows={3}
                  placeholder={"-y\n@company/agent-app"}
                  value={draft.args}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      args: event.target.value,
                    }))
                  }
                />
              </label>
            ) : (
              <label className="provider-dialog-field">
                <span>
                  Bearer token{" "}
                  {draft.bearerCredentialId !== undefined ? (
                    <small>Stored securely</small>
                  ) : (
                    <small>Optional</small>
                  )}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={
                    draft.bearerCredentialId !== undefined
                      ? "Enter a new token to replace"
                      : "Enter token"
                  }
                  value={draft.bearer}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      bearer: event.target.value,
                    }))
                  }
                />
              </label>
            )}

            <section
              className="mcp-credential-editor"
              aria-labelledby="mcp-credentials-title"
            >
              <div>
                <span>
                  <KeyRound size={15} aria-hidden="true" />
                  <strong id="mcp-credentials-title">
                    {draft.transport === "stdio"
                      ? "Environment credentials"
                      : "Header credentials"}
                  </strong>
                </span>
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      credentials: [
                        ...current.credentials,
                        { key: crypto.randomUUID(), name: "", secret: "" },
                      ],
                    }))
                  }
                >
                  <Plus size={13} aria-hidden="true" /> Add credential
                </button>
              </div>
              <p>
                Values are write-only and stored by Local Core. They are never
                returned to this screen.
              </p>
              {draft.credentials.map((entry, index) => (
                <div className="mcp-credential-row" key={entry.key}>
                  <label>
                    <span>
                      {draft.transport === "stdio" ? "Variable" : "Header"}
                    </span>
                    <input
                      value={entry.name}
                      required
                      placeholder={
                        draft.transport === "stdio" ? "API_TOKEN" : "X-API-Key"
                      }
                      onChange={(event) =>
                        updateCredential(index, { name: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>
                      Secret{" "}
                      {entry.credentialId !== undefined ? (
                        <small>Stored securely</small>
                      ) : null}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      required={entry.credentialId === undefined}
                      placeholder={
                        entry.credentialId !== undefined
                          ? "Enter a new value to replace"
                          : "Enter secret"
                      }
                      value={entry.secret}
                      onChange={(event) =>
                        updateCredential(index, { secret: event.target.value })
                      }
                    />
                  </label>
                  <button
                    className="icon-button danger-icon-button"
                    type="button"
                    aria-label={`Remove ${entry.name || "credential"}`}
                    onClick={() => removeCredentialRow(index)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </section>

            {editorError !== undefined ? (
              <p className="provider-dialog-error" role="alert">
                {editorError}
              </p>
            ) : null}
            <p className="provider-dialog-note">
              Saving verifies the App and its capabilities, stores credential
              references, and makes it available to Desktop agents.
            </p>
            <div className="provider-dialog-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={loading}
                onClick={closeEditor}
              >
                Cancel
              </button>
              <button
                className="provider-dialog-save"
                type="submit"
                disabled={loading}
              >
                {loading ? "Verifying…" : "Verify and activate"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

interface StandardAppDetailProps {
  app: KestrelAppManifest;
  server: DesktopMcpServerConfig | undefined;
  servers: readonly DesktopMcpServerConfig[];
  loading: boolean;
  confirmingRemove: boolean;
  onConnect: (input: DesktopMcpServerMutationInput) => void;
  onSave: (enabled: boolean) => void;
  onPolicyChange: (
    toolName: string,
    approvalMode: "auto" | "ask",
    modes: ("chat" | "plan" | "build")[],
  ) => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}

function StandardAppDetail({
  app,
  server,
  servers,
  loading,
  confirmingRemove,
  onConnect,
  onSave,
  onPolicyChange,
  onConfirmRemove,
  onCancelRemove,
  onRemove,
}: StandardAppDetailProps) {
  const [secret, setSecret] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [selectedCapabilityPacks, setSelectedCapabilityPacks] = useState<
    string[]
  >([]);
  const connection = getDesktopStandardAppConnection(app.id);
  useEffect(() => {
    setSecret("");
    setConnecting(false);
    setConnectionError(undefined);
    setSelectedCapabilityPacks([]);
  }, [app.id, server?.id]);

  async function connectAuthorizedApp(): Promise<void> {
    if (connection?.kind !== "authorization") return;
    setConnecting(true);
    setConnectionError(undefined);
    try {
      let session = await window.kestrelDesktop.startStandardAppConnection({
        appId: app.id,
        ...(connection.capabilityPackScopes !== undefined
          ? { capabilityPacks: selectedCapabilityPacks }
          : {}),
      });
      while (session.state === "awaiting_user") {
        await waitForAppConnectionPoll();
        session = await window.kestrelDesktop.getStandardAppConnectionStatus(
          session.sessionId,
        );
      }
      if (session.state !== "complete") {
        throw new Error(
          session.error ??
            (session.state === "expired"
              ? "The connection window expired. Try connecting again."
              : `Could not connect ${app.name}.`),
        );
      }
      onConnect({
        id: `standard.${app.id}`,
        appId: app.id,
        name: app.name,
        transport: "http",
        url: connection.url,
        oauthCredentialPrefix: connection.credentialPrefix,
        ...(connection.capabilityPackScopes !== undefined
          ? { capabilityPacks: selectedCapabilityPacks }
          : {}),
        enabled: true,
      });
    } catch (cause) {
      setConnectionError(errorMessage(cause));
    } finally {
      setConnecting(false);
    }
  }
  if (app.category === "workflow") {
    const dependencies = getDesktopWorkflowDependencies(app, servers);
    const ready = dependencies.every((dependency) => dependency.ready);
    return (
      <div className="mcp-detail-body">
        <div>
          <span className="surface-kicker">Workflow App</span>
          <h2>{app.name}</h2>
          <p>{app.description}</p>
        </div>
        <dl className="detail-list">
          <div>
            <dt>Desktop status</dt>
            <dd>{ready ? "Ready" : "Dependencies required"}</dd>
          </div>
          <div>
            <dt>Permissions</dt>
            <dd>Uses only Apps selected for the conversation</dd>
          </div>
        </dl>
        <div className="mcp-tool-heading">
          <div>
            <Wrench size={15} aria-hidden="true" />
            <strong>Required Apps</strong>
          </div>
          <span>Workflow Apps never grant additional access</span>
        </div>
        <div className="tool-list">
          {dependencies.map((dependency) => (
            <div key={dependency.role}>
              <Plug size={14} aria-hidden="true" />
              <span className="mcp-tool-copy">
                <strong>{dependency.role}</strong>
                <small>
                  {dependency.ready
                    ? `Ready: ${dependency.readyNames.join(" or ")}`
                    : `Connect and select ${dependency.alternativeNames.join(" or ")}`}
                </small>
              </span>
            </div>
          ))}
        </div>
        <p className={ready ? "provider-dialog-note" : "inline-warning"}>
          {ready
            ? "Select this Workflow App and its required Apps in a conversation to coordinate the workflow."
            : "Connect the missing Apps before using this workflow in a conversation."}
        </p>
      </div>
    );
  }
  if (app.category === "built_in") {
    const included = getDesktopAppDefinition(app.id) !== undefined;
    return (
      <div className="mcp-detail-body">
        <div>
          <span className="surface-kicker">
            {included ? "Included App" : "Kestrel One App"}
          </span>
          <h2>{app.name}</h2>
          <p>{app.description}</p>
        </div>
        <dl className="detail-list">
          <div>
            <dt>Desktop status</dt>
            <dd>{included ? "Included" : "Not available in this build"}</dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>No connection required</dd>
          </div>
        </dl>
        <div className="mcp-tool-heading">
          <div>
            <Wrench size={15} aria-hidden="true" />
            <strong>Capabilities</strong>
          </div>
          <span>Governed by the active conversation and Project</span>
        </div>
        <div className="tool-list">
          {app.capabilityPacks.map((pack) => (
            <div key={pack.key}>
              <Wrench size={14} aria-hidden="true" />
              <span className="mcp-tool-copy">
                <strong>{pack.name}</strong>
                <small>{pack.description}</small>
              </span>
            </div>
          ))}
        </div>
        {included ? null : (
          <p className="inline-warning">
            This included App is currently available in Kestrel One, but not in
            Kestrel Desktop.
          </p>
        )}
      </div>
    );
  }
  if (server !== undefined) {
    const policyManagedByConversation =
      connection?.kind === "authorization" && connection.runtime === "native";
    return (
      <McpServerDetail
        confirmingRemove={confirmingRemove}
        loading={loading}
        manifest={app}
        onCancelRemove={onCancelRemove}
        onConfirmRemove={onConfirmRemove}
        onPolicyChange={onPolicyChange}
        onRemove={onRemove}
        onSave={onSave}
        policyManagedByConversation={policyManagedByConversation}
        server={server}
      />
    );
  }
  return (
    <div className="mcp-detail-body">
      <div>
        <span className="surface-kicker">Standard App</span>
        <h2>{app.name}</h2>
        <p>{app.description}</p>
      </div>
      <div className="mcp-tool-heading">
        <div>
          <Wrench size={15} aria-hidden="true" />
          <strong>Capabilities</strong>
        </div>
        <span>Choose what agents may use after connecting</span>
      </div>
      <div className="tool-list">
        {app.capabilityPacks.map((pack) => (
          <div key={pack.key}>
            <Wrench size={14} aria-hidden="true" />
            <span className="mcp-tool-copy">
              <strong>{pack.name}</strong>
              <small>{pack.description}</small>
            </span>
          </div>
        ))}
      </div>
      {connection?.kind === "token" ? (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            onConnect({
              id: `standard.${app.id}`,
              appId: app.id,
              name: app.name,
              transport: "http",
              url: connection.url,
              credentials: [{ kind: "bearer", secret }],
              enabled: true,
            });
          }}
        >
          <label>
            {connection.credentialLabel}
            <input
              autoComplete="off"
              onChange={(event) => setSecret(event.target.value)}
              placeholder={connection.credentialPlaceholder}
              required
              type="password"
              value={secret}
            />
          </label>
          <p className="provider-dialog-note">
            Kestrel stores this connection securely, verifies its capabilities,
            and keeps connection details out of agent conversations.
          </p>
          <button
            className="primary-button"
            disabled={loading || !secret.trim()}
            type="submit"
          >
            {loading ? "Connecting…" : `Connect ${app.name}`}
          </button>
        </form>
      ) : connection?.kind === "authorization" ? (
        <div className="settings-form">
          {connection.capabilityPackScopes !== undefined ? (
            <fieldset>
              <legend>Choose capabilities</legend>
              {app.capabilityPacks
                .filter(
                  (pack) =>
                    connection.capabilityPackScopes?.[pack.key] !== undefined,
                )
                .map((pack) => (
                  <label key={pack.key}>
                    <input
                      checked={selectedCapabilityPacks.includes(pack.key)}
                      disabled={loading || connecting}
                      onChange={(event) =>
                        setSelectedCapabilityPacks((current) =>
                          event.target.checked
                            ? [...current, pack.key]
                            : current.filter((key) => key !== pack.key),
                        )
                      }
                      type="checkbox"
                    />
                    <span>
                      {pack.name}
                      <small>{pack.description}</small>
                    </span>
                  </label>
                ))}
            </fieldset>
          ) : null}
          <p className="provider-dialog-note">
            Kestrel will open {app.name} so you can approve the connection, then
            verify the available capabilities before activating it.
          </p>
          {connectionError !== undefined ? (
            <p className="inline-warning">{connectionError}</p>
          ) : null}
          <button
            className="primary-button"
            disabled={
              loading ||
              connecting ||
              (connection.capabilityPackScopes !== undefined &&
                selectedCapabilityPacks.length === 0)
            }
            onClick={() => void connectAuthorizedApp()}
            type="button"
          >
            {connecting ? "Connecting…" : `Connect ${app.name}`}
          </button>
        </div>
      ) : (
        <p className="inline-warning">
          This App is available in Kestrel One. A Desktop connection is not yet
          available in this build.
        </p>
      )}
    </div>
  );
}

interface McpServerDetailProps {
  server: DesktopMcpServerConfig;
  manifest?: KestrelAppManifest | undefined;
  loading: boolean;
  confirmingRemove: boolean;
  onSave: (enabled: boolean) => void;
  onEdit?: (() => void) | undefined;
  policyManagedByConversation?: boolean | undefined;
  onPolicyChange: (
    toolName: string,
    approvalMode: "auto" | "ask",
    modes: ("chat" | "plan" | "build")[],
  ) => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}

function McpServerDetail({
  server,
  manifest,
  loading,
  confirmingRemove,
  onSave,
  onEdit,
  policyManagedByConversation = false,
  onPolicyChange,
  onConfirmRemove,
  onCancelRemove,
  onRemove,
}: McpServerDetailProps) {
  const managed = server.sourceKind === "desktop-managed";
  return (
    <div className="mcp-detail-body">
      <div>
        <span className="surface-kicker">
          {manifest === undefined ? "Custom App" : "Standard App"}
        </span>
        <h2>{manifest?.name ?? server.name}</h2>
        <p>
          {manifest?.description ??
            `${server.toolCount ?? 0} ${server.toolCount === 1 ? "capability" : "capabilities"}`}
        </p>
      </div>
      <dl className="detail-list">
        <div>
          <dt>Desktop status</dt>
          <dd>
            {managed
              ? server.enabled
                ? "Enabled"
                : "Disabled"
              : "Discovered — not active"}
          </dd>
        </div>
        {server.verifiedAt !== undefined ? (
          <div>
            <dt>Last verified</dt>
            <dd>{new Date(server.verifiedAt).toLocaleString()}</dd>
          </div>
        ) : null}
        {server.credentials !== undefined && server.credentials.length > 0 ? (
          <div>
            <dt>Connection</dt>
            <dd>
              {server.credentials.every((binding) => binding.configured)
                ? "Credentials stored securely"
                : "Setup required"}
            </dd>
          </div>
        ) : null}
        {server.oauthCredentialPrefix !== undefined ? (
          <div>
            <dt>Connection</dt>
            <dd>Connected securely</dd>
          </div>
        ) : null}
        {manifest !== undefined && (server.capabilityPacks?.length ?? 0) > 0 ? (
          <div>
            <dt>Enabled capabilities</dt>
            <dd>
              {server.capabilityPacks
                ?.map(
                  (key) =>
                    manifest.capabilityPacks.find((pack) => pack.key === key)
                      ?.name ?? key,
                )
                .join(", ")}
            </dd>
          </div>
        ) : null}
      </dl>
      {server.setupWarning !== undefined ? (
        <p className="inline-warning">{server.setupWarning}</p>
      ) : null}
      <div className="mcp-server-actions">
        {managed ? (
          confirmingRemove ? (
            <div className="destructive-confirmation">
              <button
                className="secondary-button"
                type="button"
                disabled={loading}
                onClick={onCancelRemove}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={loading}
                onClick={onRemove}
              >
                Confirm removal
              </button>
            </div>
          ) : (
            <div>
              <button
                className="danger-button subtle-danger-button"
                type="button"
                disabled={loading}
                onClick={onConfirmRemove}
              >
                <Trash2 size={14} /> Remove
              </button>
              {onEdit !== undefined ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={loading}
                  onClick={onEdit}
                >
                  <Pencil size={14} /> Edit
                </button>
              ) : null}
            </div>
          )
        ) : (
          <span />
        )}
        <button
          className="primary-button"
          type="button"
          disabled={loading}
          onClick={() => onSave(managed ? !server.enabled : true)}
        >
          {managed
            ? server.enabled
              ? "Disable"
              : "Verify and enable"
            : "Add, verify, and enable"}
        </button>
      </div>
      <div className="mcp-tool-heading">
        <div>
          <Wrench size={15} aria-hidden="true" />
          <strong>Capabilities</strong>
        </div>
        <span>
          {policyManagedByConversation
            ? "Approvals follow the active conversation policy"
            : managed
            ? "Changes apply immediately"
            : "Add this App to configure access"}
        </span>
      </div>
      {manifest !== undefined ? (
        <div className="tool-list">
          {manifest.capabilityPacks.map((pack) => (
            <div key={pack.key}>
              <Wrench size={14} aria-hidden="true" />
              <span className="mcp-tool-copy">
                <strong>{pack.name}</strong>
                <small>{pack.description}</small>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="tool-list">
        {server.tools?.map((tool) => (
          <div key={tool.name}>
            <Wrench size={14} aria-hidden="true" />
            <span className="mcp-tool-copy">
              <strong>{tool.name}</strong>
              {tool.description !== undefined ? (
                <small>{tool.description}</small>
              ) : null}
            </span>
            <label className="mcp-policy-field">
              <span>Approval</span>
              <select
                aria-label={`Approval for ${tool.name}`}
                value={tool.approvalMode ?? "ask"}
                disabled={
                  loading || managed === false || policyManagedByConversation
                }
                onChange={(event) =>
                  onPolicyChange(
                    tool.name,
                    event.target.value as "auto" | "ask",
                    tool.allowedInteractionModes ?? ["build"],
                  )
                }
              >
                <option value="ask">Ask every time</option>
                <option value="auto">Automatic</option>
              </select>
            </label>
            <label className="mcp-policy-field">
              <span>Available in</span>
              <select
                aria-label={`Available modes for ${tool.name}`}
                value={(tool.allowedInteractionModes ?? ["build"]).join(",")}
                disabled={
                  loading || managed === false || policyManagedByConversation
                }
                onChange={(event) =>
                  onPolicyChange(
                    tool.name,
                    tool.approvalMode ?? "ask",
                    event.target.value.split(",") as (
                      | "chat"
                      | "plan"
                      | "build"
                    )[],
                  )
                }
              >
                <option value="build">Build only</option>
                <option value="plan,build">Plan and build</option>
                <option value="chat,plan,build">All modes</option>
              </select>
            </label>
          </div>
        ))}
        {server.tools !== undefined && server.tools.length === 0 ? (
          <p className="panel-empty">No capabilities reported</p>
        ) : null}
      </div>
    </div>
  );
}

export function buildMcpMutationInput(
  server: DesktopMcpServerConfig,
  enabled: boolean,
): DesktopMcpServerMutationInput {
  return {
    id: server.id,
    ...(server.appId !== undefined ? { appId: server.appId } : {}),
    name: server.name,
    transport: server.transport,
    ...(server.transport === "stdio"
      ? { command: server.command!, args: server.args }
      : { url: server.url! }),
    credentials: server.credentials?.map((binding) => ({
      kind: binding.kind,
      ...(binding.name !== undefined ? { name: binding.name } : {}),
      credentialId: binding.credentialId,
      envKey: binding.envKey,
    })),
    ...(server.oauthCredentialPrefix !== undefined
      ? { oauthCredentialPrefix: server.oauthCredentialPrefix }
      : {}),
    ...(server.capabilityPacks !== undefined
      ? { capabilityPacks: [...server.capabilityPacks] }
      : {}),
    toolPolicies: Object.fromEntries(
      (server.tools ?? []).map((tool) => [
        tool.name,
        {
          approvalMode: tool.approvalMode ?? "ask",
          allowedInteractionModes: tool.allowedInteractionModes ?? ["build"],
        },
      ]),
    ),
    enabled,
  };
}

function emptyMcpDraft(): McpServerDraft {
  return {
    id: "",
    name: "",
    transport: "stdio",
    target: "",
    args: "",
    bearer: "",
    credentials: [],
  };
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function safeMcpEndpointDisplay(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "Configured endpoint";
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function waitForAppConnectionPoll(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));
}

function getDesktopWorkflowDependencies(
  app: KestrelAppManifest,
  servers: readonly DesktopMcpServerConfig[],
) {
  const capabilityPacksByAppId = new Map<string, Set<string>>();
  for (const server of servers) {
    if (
      server.enabled &&
      server.appId !== undefined &&
      (server.toolCount ?? 0) > 0
    ) {
      const manifest = KESTREL_STANDARD_APP_MANIFESTS.find(
        (candidate) => candidate.id === server.appId,
      );
      capabilityPacksByAppId.set(
        server.appId,
        new Set(
          server.capabilityPacks ??
            manifest?.capabilityPacks.map((pack) => pack.key) ??
            [],
        ),
      );
    }
  }
  return (app.dependencies ?? []).map((dependency) => {
    const readyIds = dependency.appIds.filter((appId) => {
      const configuredPacks = capabilityPacksByAppId.get(appId);
      if (configuredPacks === undefined) return false;
      const requiredPacks = dependency.requiredCapabilityPacks?.[appId];
      return (
        !requiredPacks?.length ||
        requiredPacks.some((pack) => configuredPacks.has(pack))
      );
    });
    return {
      role: dependency.role,
      ready: readyIds.length >= dependency.minimum,
      readyNames: readyIds.map(
        (appId) =>
          KESTREL_STANDARD_APP_MANIFESTS.find(
            (manifest) => manifest.id === appId,
          )?.name ?? appId,
      ),
      alternativeNames: dependency.appIds.map(
        (appId) =>
          KESTREL_STANDARD_APP_MANIFESTS.find(
            (manifest) => manifest.id === appId,
          )?.name ?? appId,
      ),
    };
  });
}
