import { Plug, RefreshCw, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  DesktopMcpDiscoveryResult,
  DesktopMcpServerConfig,
} from "../../src/contracts";

export function McpWorkspace(props: {
  onError: (message: string | undefined) => void;
}) {
  const [result, setResult] = useState<DesktopMcpDiscoveryResult>();
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const selected = useMemo(
    () => result?.servers.find((server) => server.id === selectedId)
      ?? result?.servers[0],
    [result, selectedId]
  );

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const discovered = await window.kestrelDesktop.discoverMcpServers();
      setResult(discovered);
      setSelectedId((current) => discovered.servers.some((server) => server.id === current)
        ? current
        : discovered.servers[0]?.id);
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="surface-pane mcp-surface" id="app-main">
      <header className="surface-header">
        <div>
          <span className="surface-kicker">Integrations</span>
          <h1>MCP servers</h1>
          <p>{result === undefined ? "Local discovery" : `Scanned ${formatTime(result.discoveredAt)}`}</p>
        </div>
        <button
          className="icon-button"
          type="button"
          title="Refresh MCP discovery"
          aria-label="Refresh MCP discovery"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </button>
      </header>

      <div className="mcp-grid">
        <section className="workspace-panel" aria-label="Discovered MCP servers">
          <div className="panel-toolbar">
            <span>Discovered</span>
            <span className="toolbar-status">{result?.servers.length ?? 0}</span>
          </div>
          <div className="mcp-list">
            {result?.servers.map((server) => (
              <button
                type="button"
                className={`mcp-row ${server.id === selected?.id ? "active" : ""}`}
                key={server.id}
                onClick={() => setSelectedId(server.id)}
              >
                <Plug size={16} />
                <span>
                  <strong>{server.name}</strong>
                  <small>{server.transport} · {server.source}</small>
                </span>
                <span className={`mcp-enabled ${server.enabled ? "enabled" : ""}`}>
                  {server.enabled ? "enabled" : "disabled"}
                </span>
              </button>
            ))}
            {result !== undefined && result.servers.length === 0 ? (
              <div className="panel-empty large-empty">
                <Plug size={22} aria-hidden="true" />
                <span>No local MCP servers found</span>
              </div>
            ) : null}
          </div>
        </section>

        <section className="workspace-panel mcp-detail" aria-label="MCP server detail">
          <div className="panel-toolbar">
            <span>Server</span>
            {selected?.toolCount !== undefined ? (
              <span className="toolbar-status">{selected.toolCount} tools</span>
            ) : null}
          </div>
          {selected === undefined ? (
            <div className="panel-empty large-empty">
              <Wrench size={22} aria-hidden="true" />
              <span>Select a server</span>
            </div>
          ) : (
            <McpServerDetail server={selected} />
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
    </main>
  );
}

function McpServerDetail(props: { server: DesktopMcpServerConfig }) {
  const server = props.server;
  return (
    <div className="mcp-detail-body">
      <div>
        <span className="surface-kicker">{server.transport}</span>
        <h2>{server.name}</h2>
        <p>{server.sourcePath ?? server.source}</p>
      </div>
      <dl className="detail-list">
        <div><dt>Status</dt><dd>{server.enabled ? "Enabled" : "Disabled"}</dd></div>
        <div><dt>Source</dt><dd>{server.sourceKind ?? server.source}</dd></div>
        {server.command !== undefined ? <div><dt>Command</dt><dd><code>{server.command}</code></dd></div> : null}
        {server.url !== undefined ? <div><dt>URL</dt><dd>{safeMcpEndpointDisplay(server.url)}</dd></div> : null}
        {server.workingDirectory !== undefined ? <div><dt>Working directory</dt><dd>{server.workingDirectory}</dd></div> : null}
      </dl>
      {server.setupWarning !== undefined ? (
        <p className="inline-warning">{server.setupWarning}</p>
      ) : null}
      <div className="tool-list">
        {server.tools?.map((tool) => (
          <div key={tool.name}>
            <Wrench size={14} />
            <span><strong>{tool.name}</strong>{tool.description !== undefined ? <small>{tool.description}</small> : null}</span>
          </div>
        ))}
        {server.tools !== undefined && server.tools.length === 0 ? (
          <p className="panel-empty">No tool inventory reported</p>
        ) : null}
      </div>
    </div>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function safeMcpEndpointDisplay(value: string) {
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

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
