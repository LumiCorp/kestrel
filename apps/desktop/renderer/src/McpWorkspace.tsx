import { KeyRound, Pencil, Plug, Plus, RefreshCw, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  DesktopMcpDiscoveryResult,
  DesktopMcpServerConfig,
  DesktopMcpServerMutationInput,
} from "../../src/contracts";
import { keepFocusInsideDialog } from "./dialogFocus";

type McpTransport = DesktopMcpServerMutationInput["transport"];
type McpCredentialInput = NonNullable<DesktopMcpServerMutationInput["credentials"]>[number];

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
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<McpServerDraft>(() => emptyMcpDraft());
  const [editorError, setEditorError] = useState<string>();
  const [editingServerId, setEditingServerId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const loadingRef = useRef(false);
  const editorRef = useRef<HTMLFormElement>(null);
  const selected = useMemo(
    () => result?.servers.find((server) => server.id === selectedId)
      ?? result?.servers[0],
    [result, selectedId],
  );
  const editingServer = result?.servers.find((server) => server.id === editingServerId && server.sourceKind === "desktop-managed");

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    if (editorOpen === false) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
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
      setSelectedId((current) => discovered.servers.some((server) => server.id === current)
        ? current
        : discovered.servers[0]?.id);
      onError(undefined);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  async function saveServer(input: DesktopMcpServerMutationInput, successMessage?: string): Promise<boolean> {
    setLoading(true);
    setEditorError(undefined);
    try {
      const next = await window.kestrelDesktop.saveMcpServer(input);
      setResult(next);
      setSelectedId(input.id);
      setEditorOpen(false);
      setConfirmingRemove(false);
      setNotice(successMessage ?? `${input.name} was verified and applied to the Desktop runtime.`);
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
      setSelectedId(undefined);
      setConfirmingRemove(false);
      setNotice(`${server.name} was removed from Desktop and its stored credentials were deleted.`);
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
    const bearer = server.credentials?.find((binding) => binding.kind === "bearer");
    setDraft({
      id: server.id,
      name: server.name,
      transport: server.transport,
      target: server.transport === "stdio" ? server.command ?? "" : server.url ?? "",
      args: server.args?.join("\n") ?? "",
      bearer: "",
      bearerCredentialId: bearer?.credentialId,
      bearerEnvKey: bearer?.envKey,
      credentials: server.credentials
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

  function updateCredential(index: number, patch: Partial<McpCredentialDraft>): void {
    setDraft((current) => ({
      ...current,
      credentials: current.credentials.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry),
    }));
  }

  function removeCredentialRow(index: number): void {
    setDraft((current) => ({
      ...current,
      credentials: current.credentials.filter((_, entryIndex) => entryIndex !== index),
    }));
  }

  async function submitEditor(): Promise<void> {
    const existing = editingServer;
    if (existing === undefined && result?.servers.some((server) => server.id === draft.id.trim())) {
      setEditorError("That server ID already exists. Select the server and use Edit instead.");
      return;
    }
    const namedCredentials: McpCredentialInput[] = draft.credentials
      .filter((entry) => entry.name.trim().length > 0)
      .map((entry) => ({
        kind: draft.transport === "stdio" ? "environment" : "header",
        name: entry.name.trim(),
        ...(entry.credentialId !== undefined ? { credentialId: entry.credentialId } : {}),
        ...(entry.envKey !== undefined ? { envKey: entry.envKey } : {}),
        ...(entry.secret.trim().length > 0 ? { secret: entry.secret.trim() } : {}),
      }));
    const credentials: McpCredentialInput[] = [
      ...(draft.transport !== "stdio" && (draft.bearer.trim().length > 0 || draft.bearerCredentialId !== undefined)
        ? [{
          kind: "bearer" as const,
          ...(draft.bearerCredentialId !== undefined ? { credentialId: draft.bearerCredentialId } : {}),
          ...(draft.bearerEnvKey !== undefined ? { envKey: draft.bearerEnvKey } : {}),
          ...(draft.bearer.trim().length > 0 ? { secret: draft.bearer.trim() } : {}),
        }]
        : []),
      ...namedCredentials,
    ];
    await saveServer({
      id: draft.id.trim(),
      name: draft.name.trim() || draft.id.trim(),
      transport: draft.transport,
      ...(draft.transport === "stdio"
        ? { command: draft.target.trim(), args: draft.args.split(/\r?\n/u).map((arg) => arg.trim()).filter((arg) => arg.length > 0) }
        : { url: draft.target.trim() }),
      credentials,
      toolPolicies: existing === undefined ? undefined : buildMcpMutationInput(existing, true).toolPolicies,
      enabled: true,
    });
  }

  return (
    <main className="surface-pane mcp-surface" id="app-main">
      <header className="surface-header">
        <div>
          <span className="surface-kicker">Integrations</span>
          <h1>MCP servers</h1>
          <p>{result === undefined ? "Local discovery" : `Scanned ${formatTime(result.discoveredAt)}`}</p>
        </div>
        <div className="surface-header-actions">
          <button className="secondary-button" type="button" disabled={loading} onClick={beginAdd}><Plus size={15} aria-hidden="true" /> Add server</button>
          <button className="icon-button" type="button" title="Refresh MCP discovery" aria-label="Refresh MCP discovery" disabled={loading} onClick={() => void refresh()}><RefreshCw size={16} className={loading ? "spin" : undefined} /></button>
        </div>
      </header>

      {notice !== undefined ? <p className="settings-notice mcp-notice" role="status">{notice}</p> : null}

      <div className="mcp-grid" aria-busy={loading}>
        <section className="workspace-panel" aria-label="Discovered MCP servers">
          <div className="panel-toolbar">
            <span>Available servers</span>
            <span className="toolbar-status">{result?.servers.length ?? 0}</span>
          </div>
          <div className="mcp-list">
            {result?.servers.map((server) => (
              <button
                type="button"
                className={`mcp-row ${server.id === selected?.id ? "active" : ""}`}
                key={server.id}
                onClick={() => {
                  setSelectedId(server.id);
                  setConfirmingRemove(false);
                }}
              >
                <Plug size={16} aria-hidden="true" />
                <span>
                  <strong>{server.name}</strong>
                  <small>{server.transport} · {server.source}</small>
                </span>
                <span className={`mcp-enabled ${server.sourceKind === "desktop-managed" && server.enabled ? "enabled" : ""}`}>
                  {server.sourceKind === "desktop-managed" ? server.enabled ? "Enabled" : "Disabled" : "Discovered"}
                </span>
              </button>
            ))}
            {result !== undefined && result.servers.length === 0 ? (
              <div className="panel-empty large-empty">
                <Plug size={22} aria-hidden="true" />
                <strong>No MCP servers found</strong>
                <span>Add a server here or refresh after installing one locally.</span>
              </div>
            ) : null}
          </div>
        </section>

        <section className="workspace-panel mcp-detail" aria-label="MCP server detail">
          <div className="panel-toolbar">
            <span>Server details</span>
            {selected?.toolCount !== undefined ? (
              <span className="toolbar-status">{selected.toolCount} {selected.toolCount === 1 ? "tool" : "tools"}</span>
            ) : null}
          </div>
          {selected === undefined ? (
            <div className="panel-empty large-empty">
              <Wrench size={22} aria-hidden="true" />
              <span>Select a server</span>
            </div>
          ) : (
            <McpServerDetail
              server={selected}
              loading={loading}
              confirmingRemove={confirmingRemove}
              onConfirmRemove={() => setConfirmingRemove(true)}
              onCancelRemove={() => setConfirmingRemove(false)}
              onSave={(enabled) => void saveServer(
                buildMcpMutationInput(selected, enabled),
                `${selected.name} was ${enabled ? "verified and enabled" : "disabled"}.`,
              )}
              onEdit={() => beginEdit(selected)}
              onPolicyChange={(toolName, approvalMode, allowedInteractionModes) => {
                const input = buildMcpMutationInput(selected, selected.enabled);
                input.toolPolicies = { ...input.toolPolicies, [toolName]: { approvalMode, allowedInteractionModes } };
                void saveServer(input, `${toolName} policy was applied.`);
              }}
              onRemove={() => void removeServer(selected)}
            />
          )}
        </section>
      </div>

      {result !== undefined && result.diagnostics.some((entry) => entry.status === "invalid" || entry.status === "error") ? (
        <section className="diagnostic-strip" aria-label="MCP discovery diagnostics">
          {result.diagnostics
            .filter((entry) => entry.status === "invalid" || entry.status === "error")
            .map((entry) => (
              <div key={`${entry.source}-${entry.path}`}>
                <strong>{entry.source}</strong>
                <span>{entry.message ?? entry.status}</span>
              </div>
            ))}
        </section>
      ) : null}

      {editorOpen ? (
        <div className="dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeEditor();
        }}>
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
                <span className="surface-kicker">MCP connection</span>
                <h2 id="mcp-editor-title">{editingServer === undefined ? "Add server" : `Edit ${editingServer.name}`}</h2>
                <p id="mcp-editor-description">Kestrel verifies the connection and tool inventory before applying it to the runtime.</p>
              </div>
              <button className="icon-button" type="button" aria-label="Close MCP server editor" disabled={loading} onClick={closeEditor}><X size={17} /></button>
            </div>

            <div className="mcp-editor-grid">
              <label className="provider-dialog-field">
                <span>Server ID *</span>
                <input autoFocus value={draft.id} disabled={editingServer !== undefined} required placeholder="company-tools" onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
              </label>
              <label className="provider-dialog-field">
                <span>Display name</span>
                <input value={draft.name} placeholder="Company tools" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className="provider-dialog-field">
                <span>Transport *</span>
                <select value={draft.transport} onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value as McpTransport }))}>
                  <option value="stdio">Local command (stdio)</option>
                  <option value="http">Streamable HTTP</option>
                  <option value="sse">Server-sent events (SSE)</option>
                </select>
              </label>
            </div>

            <label className="provider-dialog-field">
              <span>{draft.transport === "stdio" ? "Command" : "Server URL"} *</span>
              <input type={draft.transport === "stdio" ? "text" : "url"} required placeholder={draft.transport === "stdio" ? "npx" : "https://mcp.example.com"} value={draft.target} onChange={(event) => setDraft((current) => ({ ...current, target: event.target.value }))} />
            </label>
            {draft.transport === "stdio" ? (
              <label className="provider-dialog-field">
                <span>Command arguments <small>One per line</small></span>
                <textarea rows={3} placeholder={"-y\n@company/mcp-server"} value={draft.args} onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))} />
              </label>
            ) : (
              <label className="provider-dialog-field">
                <span>Bearer token {draft.bearerCredentialId !== undefined ? <small>Stored securely</small> : <small>Optional</small>}</span>
                <input type="password" autoComplete="off" placeholder={draft.bearerCredentialId !== undefined ? "Enter a new token to replace" : "Enter token"} value={draft.bearer} onChange={(event) => setDraft((current) => ({ ...current, bearer: event.target.value }))} />
              </label>
            )}

            <section className="mcp-credential-editor" aria-labelledby="mcp-credentials-title">
              <div>
                <span>
                  <KeyRound size={15} aria-hidden="true" />
                  <strong id="mcp-credentials-title">{draft.transport === "stdio" ? "Environment credentials" : "Header credentials"}</strong>
                </span>
                <button className="secondary-button compact-button" type="button" onClick={() => setDraft((current) => ({ ...current, credentials: [...current.credentials, { key: crypto.randomUUID(), name: "", secret: "" }] }))}>
                  <Plus size={13} aria-hidden="true" /> Add credential
                </button>
              </div>
              <p>Values are write-only and stored by Local Core. They are never returned to this screen.</p>
              {draft.credentials.map((entry, index) => (
                <div className="mcp-credential-row" key={entry.key}>
                  <label>
                    <span>{draft.transport === "stdio" ? "Variable" : "Header"}</span>
                    <input value={entry.name} required placeholder={draft.transport === "stdio" ? "API_TOKEN" : "X-API-Key"} onChange={(event) => updateCredential(index, { name: event.target.value })} />
                  </label>
                  <label>
                    <span>Secret {entry.credentialId !== undefined ? <small>Stored securely</small> : null}</span>
                    <input type="password" autoComplete="off" required={entry.credentialId === undefined} placeholder={entry.credentialId !== undefined ? "Enter a new value to replace" : "Enter secret"} value={entry.secret} onChange={(event) => updateCredential(index, { secret: event.target.value })} />
                  </label>
                  <button className="icon-button danger-icon-button" type="button" aria-label={`Remove ${entry.name || "credential"}`} onClick={() => removeCredentialRow(index)}><Trash2 size={14} /></button>
                </div>
              ))}
            </section>

            {editorError !== undefined ? <p className="provider-dialog-error" role="alert">{editorError}</p> : null}
            <p className="provider-dialog-note">Saving verifies health and tool discovery, stores credential references, and refreshes the effective Desktop runtime profile.</p>
            <div className="provider-dialog-actions">
              <button className="secondary-button" type="button" disabled={loading} onClick={closeEditor}>Cancel</button>
              <button className="provider-dialog-save" type="submit" disabled={loading}>{loading ? "Verifying…" : "Verify and activate"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

interface McpServerDetailProps {
  server: DesktopMcpServerConfig;
  loading: boolean;
  confirmingRemove: boolean;
  onSave: (enabled: boolean) => void;
  onEdit: () => void;
  onPolicyChange: (toolName: string, approvalMode: "auto" | "ask", modes: ("chat" | "plan" | "build")[]) => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}

function McpServerDetail({
  server,
  loading,
  confirmingRemove,
  onSave,
  onEdit,
  onPolicyChange,
  onConfirmRemove,
  onCancelRemove,
  onRemove,
}: McpServerDetailProps) {
  const managed = server.sourceKind === "desktop-managed";
  return (
    <div className="mcp-detail-body">
      <div>
        <span className="surface-kicker">{server.transport}</span>
        <h2>{server.name}</h2>
        <p>{server.sourcePath ?? server.source}</p>
      </div>
      <dl className="detail-list">
        <div><dt>Desktop status</dt><dd>{managed ? server.enabled ? "Enabled" : "Disabled" : "Discovered — not active"}</dd></div>
        <div><dt>Source</dt><dd>{server.sourceKind ?? server.source}</dd></div>
        {server.command !== undefined ? <div><dt>Command</dt><dd><code>{server.command}</code></dd></div> : null}
        {server.url !== undefined ? <div><dt>URL</dt><dd>{safeMcpEndpointDisplay(server.url)}</dd></div> : null}
        {server.workingDirectory !== undefined ? <div><dt>Working directory</dt><dd>{server.workingDirectory}</dd></div> : null}
        {server.verifiedAt !== undefined ? <div><dt>Last verified</dt><dd>{new Date(server.verifiedAt).toLocaleString()}</dd></div> : null}
        {server.credentials !== undefined && server.credentials.length > 0 ? <div><dt>Credentials</dt><dd>{server.credentials.map((binding) => `${binding.kind}${binding.name !== undefined ? `:${binding.name}` : ""} · ${binding.configured ? "stored securely" : "setup required"}`).join(", ")}</dd></div> : null}
      </dl>
      {server.setupWarning !== undefined ? <p className="inline-warning">{server.setupWarning}</p> : null}
      <div className="mcp-server-actions">
        {managed ? (
          confirmingRemove ? (
            <div className="destructive-confirmation">
              <button className="secondary-button" type="button" disabled={loading} onClick={onCancelRemove}>Cancel</button>
              <button className="danger-button" type="button" disabled={loading} onClick={onRemove}>Confirm removal</button>
            </div>
          ) : (
            <div>
              <button className="danger-button subtle-danger-button" type="button" disabled={loading} onClick={onConfirmRemove}><Trash2 size={14} /> Remove</button>
              <button className="secondary-button" type="button" disabled={loading} onClick={onEdit}><Pencil size={14} /> Edit</button>
            </div>
          )
        ) : <span />}
        <button className="primary-button" type="button" disabled={loading} onClick={() => onSave(managed ? !server.enabled : true)}>
          {managed ? server.enabled ? "Disable" : "Verify and enable" : "Import, verify, and enable"}
        </button>
      </div>
      <div className="mcp-tool-heading">
        <div><Wrench size={15} aria-hidden="true" /><strong>Tool policies</strong></div>
        <span>{managed ? "Changes apply immediately" : "Import this server to configure policies"}</span>
      </div>
      <div className="tool-list">
        {server.tools?.map((tool) => (
          <div key={tool.name}>
            <Wrench size={14} aria-hidden="true" />
            <span className="mcp-tool-copy"><strong>{tool.name}</strong>{tool.description !== undefined ? <small>{tool.description}</small> : null}</span>
            <label className="mcp-policy-field"><span>Approval</span><select aria-label={`Approval for ${tool.name}`} value={tool.approvalMode ?? "ask"} disabled={loading || managed === false} onChange={(event) => onPolicyChange(tool.name, event.target.value as "auto" | "ask", tool.allowedInteractionModes ?? ["build"])}><option value="ask">Ask every time</option><option value="auto">Automatic</option></select></label>
            <label className="mcp-policy-field"><span>Available in</span><select aria-label={`Available modes for ${tool.name}`} value={(tool.allowedInteractionModes ?? ["build"]).join(",")} disabled={loading || managed === false} onChange={(event) => onPolicyChange(tool.name, tool.approvalMode ?? "ask", event.target.value.split(",") as ("chat" | "plan" | "build")[])}><option value="build">Build only</option><option value="plan,build">Plan and build</option><option value="chat,plan,build">All modes</option></select></label>
          </div>
        ))}
        {server.tools !== undefined && server.tools.length === 0 ? <p className="panel-empty">No tool inventory reported</p> : null}
      </div>
    </div>
  );
}

export function buildMcpMutationInput(server: DesktopMcpServerConfig, enabled: boolean): DesktopMcpServerMutationInput {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    ...(server.transport === "stdio" ? { command: server.command!, args: server.args } : { url: server.url! }),
    credentials: server.credentials?.map((binding) => ({
      kind: binding.kind,
      ...(binding.name !== undefined ? { name: binding.name } : {}),
      credentialId: binding.credentialId,
      envKey: binding.envKey,
    })),
    toolPolicies: Object.fromEntries((server.tools ?? []).map((tool) => [tool.name, {
      approvalMode: tool.approvalMode ?? "ask",
      allowedInteractionModes: tool.allowedInteractionModes ?? ["build"],
    }])),
    enabled,
  };
}

function emptyMcpDraft(): McpServerDraft {
  return { id: "", name: "", transport: "stdio", target: "", args: "", bearer: "", credentials: [] };
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
