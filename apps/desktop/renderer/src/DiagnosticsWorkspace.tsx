import {
  Clipboard,
  Database,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";

import type {
  DesktopBootState,
  DesktopDatabaseStatus,
  DesktopRuntimeHealth,
  DesktopRuntimeStatus,
  DesktopReadinessItemId,
} from "../../src/contracts";

export function DiagnosticsWorkspace(props: {
  runtimeHealth: DesktopRuntimeHealth | undefined;
  onRuntimeHealth: (health: DesktopRuntimeHealth) => void;
  onError: (message: string | undefined) => void;
  onOpenReadinessSettings: (itemId: DesktopReadinessItemId) => void;
}) {
  const [database, setDatabase] = useState<DesktopDatabaseStatus>();
  const [runtime, setRuntime] = useState<DesktopRuntimeStatus>();
  const [boot, setBoot] = useState<DesktopBootState>();
  const [notice, setNotice] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setBusyAction("refresh");
    try {
      const [health, databaseStatus, runtimeStatus, bootState] = await Promise.all([
        window.kestrelDesktop.getRuntimeHealth(),
        window.kestrelDesktop.getDatabaseStatus(),
        window.kestrelDesktop.getRuntimeStatus(),
        window.kestrelDesktop.getBootState(),
      ]);
      props.onRuntimeHealth(health);
      setDatabase(databaseStatus);
      setRuntime(runtimeStatus);
      setBoot(bootState);
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function runAction(id: string, action: () => Promise<unknown>) {
    setBusyAction(id);
    setNotice(undefined);
    try {
      await action();
      setNotice(actionNotice(id));
      await refresh();
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function copySupportBundle() {
    setBusyAction("support");
    try {
      const bundle = await window.kestrelDesktop.getSupportBundle();
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      setNotice("Support bundle copied.");
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function resetRuntimeStore() {
    if (window.confirm("Archive the current runtime store and start with a clean store?") === false) {
      return;
    }
    await runAction("reset-store", () => window.kestrelDesktop.resetRuntimeStore());
  }

  return (
    <main className="surface-pane diagnostics-surface" id="app-main">
      <header className="surface-header">
        <div>
          <span className="surface-kicker">Local Core</span>
          <h1>Diagnostics</h1>
          <p>{props.runtimeHealth?.summary ?? "Runtime status unavailable"}</p>
        </div>
        <button
          className="icon-button"
          type="button"
          title="Refresh diagnostics"
          aria-label="Refresh diagnostics"
          disabled={busyAction !== undefined}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </button>
      </header>

      {notice !== undefined ? <div className="notice-strip" role="status">{notice}</div> : null}

      <div className="diagnostics-grid">
        <section className="workspace-panel" aria-label="Runtime diagnostics">
          <div className="panel-toolbar"><span>Runtime</span></div>
          <div className="diagnostic-body">
            <dl className="detail-list">
              <div><dt>State</dt><dd>{props.runtimeHealth?.state ?? "unknown"}</dd></div>
              <div><dt>Process</dt><dd>{runtime?.running === true ? `Running · ${runtime.pid ?? "PID unavailable"}` : "Stopped"}</dd></div>
              <div><dt>Boot phase</dt><dd>{boot?.phase ?? "unknown"}</dd></div>
              <div><dt>Code</dt><dd>{props.runtimeHealth?.code ?? "-"}</dd></div>
            </dl>
            <div className="action-row">
              <button
                type="button"
                disabled={busyAction !== undefined}
                onClick={() => void runAction("restart-runtime", () => window.kestrelDesktop.restartRuntime())}
              >
                <RefreshCw size={15} /> Restart runtime
              </button>
              <button type="button" onClick={() => void window.kestrelDesktop.openDiagnostics()}>
                <ExternalLink size={15} /> Open logs
              </button>
              <button
                type="button"
                className="danger-action"
                disabled={busyAction !== undefined}
                onClick={() => void resetRuntimeStore()}
              >
                <RotateCcw size={15} /> Reset store
              </button>
            </div>
          </div>
        </section>

        <section className="workspace-panel" aria-label="Database diagnostics">
          <div className="panel-toolbar"><span>Database</span></div>
          <div className="diagnostic-body">
            <dl className="detail-list">
              <div><dt>State</dt><dd>{database?.state ?? "unknown"}</dd></div>
              <div><dt>Mode</dt><dd>{database?.managed === true ? "Local Core" : "External"}</dd></div>
              <div><dt>Process</dt><dd>{database?.running === true ? "Running" : "Stopped"}</dd></div>
              <div><dt>Database</dt><dd>{database?.database ?? "-"}</dd></div>
            </dl>
            {database?.lastError !== undefined ? (
              <p className="inline-warning">{database.lastError.code}: {database.lastError.message}</p>
            ) : null}
            <div className="action-row">
              <button
                type="button"
                disabled={busyAction !== undefined || database?.managed !== true}
                onClick={() => void runAction("restart-database", () => window.kestrelDesktop.restartDatabase())}
              >
                <Database size={15} /> Restart
              </button>
              <button
                type="button"
                disabled={database?.managed !== true}
                onClick={() => void window.kestrelDesktop.revealDatabaseFiles("data")}
              >
                <FolderOpen size={15} /> Data
              </button>
            </div>
          </div>
        </section>

        <section className="workspace-panel readiness-panel" aria-label="Readiness checks">
          <div className="panel-toolbar">
            <span>Readiness</span>
            <span className="toolbar-status">{boot?.readiness?.summary.state ?? "unknown"}</span>
          </div>
          <div className="readiness-list">
            {boot?.readiness?.items.map((item) => (
              <div key={item.id}>
                <span className={`readiness-dot state-${item.state}`} aria-hidden="true" />
                <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                <em>{item.state}</em>
                {item.action?.command === "open_settings" ? (
                  <button className="secondary-button" type="button" onClick={() => props.onOpenReadinessSettings(item.id)}>{item.action.label}</button>
                ) : null}
              </div>
            ))}
            {boot?.readiness === undefined ? <p className="panel-empty">No readiness report</p> : null}
          </div>
        </section>

        <section className="workspace-panel support-panel" aria-label="Support actions">
          <div className="panel-toolbar"><span>Support</span></div>
          <div className="diagnostic-body">
            <div className="action-row vertical-actions">
              <button type="button" disabled={busyAction !== undefined} onClick={() => void copySupportBundle()}>
                <Clipboard size={15} /> Copy support bundle
              </button>
              <button type="button" onClick={() => void window.kestrelDesktop.revealDatabaseFiles("log")} disabled={database?.managed !== true}>
                <FolderOpen size={15} /> Reveal database log
              </button>
              <button type="button" onClick={() => void window.kestrelDesktop.restartApp()}>
                <RefreshCw size={15} /> Restart Kestrel
              </button>
            </div>
          </div>
        </section>
      </div>

      {runtime !== undefined && (runtime.recentStderr.length > 0 || runtime.recentStdout.length > 0) ? (
        <section className="runtime-tail" aria-label="Recent runtime output">
          <div className="panel-toolbar"><span>Recent runtime output</span><span className="toolbar-status">{runtime.logPath}</span></div>
          <pre>{(runtime.recentStderr.length > 0 ? runtime.recentStderr : runtime.recentStdout).slice(-12).join("\n")}</pre>
        </section>
      ) : null}
    </main>
  );
}

function actionNotice(id: string) {
  if (id === "restart-runtime") {
    return "Runtime restarted.";
  }
  if (id === "restart-database") {
    return "Database restarted.";
  }
  if (id === "repair-database") {
    return "Database repair completed.";
  }
  return "Runtime store reset completed.";
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
