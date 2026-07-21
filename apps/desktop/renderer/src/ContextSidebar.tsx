import { Folder, Plus, RefreshCw } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type {
  DesktopBridgeInfo,
  DesktopCapabilityView,
  DesktopRendererSettings,
  DesktopRuntimeHealth,
} from "../../src/contracts";
import type { RendererThread } from "./state";

export function ContextSidebar(props: {
  surface: string;
  thread: RendererThread;
  settings: DesktopRendererSettings;
  runtimeHealth?: DesktopRuntimeHealth | undefined;
  bridgeInfo?: DesktopBridgeInfo | undefined;
  capabilities?: DesktopCapabilityView | undefined;
  locked: boolean;
  activeProjectPath?: string | undefined;
  onModelConfigurationChange: (id: string, revision: number) => void;
  onAppToggle: (id: string, enabled: boolean) => void;
  onProjectChange: (path: string) => void;
  onAddProject: () => void;
  onRestartRuntime: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const activeConfiguration = props.settings.modelConfigurations.find(
    (configuration) => configuration.id === props.thread.modelConfigurationId,
  );
  const activeRevision = activeConfiguration?.revisions.find(
    (revision) => revision.revision === props.thread.modelConfigurationRevision,
  );
  const providerReadiness = props.settings.providerReadiness.find(
    (entry) => entry.provider === activeRevision?.policy.provider,
  );
  const enabledApps = new Set(props.thread.enabledAppIds);
  const weatherCapability = props.capabilities?.capabilities.find((entry) => entry.id === "tools.weather");
  const healthState = props.runtimeHealth?.state ?? "degraded";

  return (
    <aside className="inspector contextual-sidebar" aria-label="Context sidebar">
      <div className="sidebar-resize-handle" onPointerDown={props.onResizeStart} aria-hidden="true" />
      <div className="context-sidebar-scroll">
        {props.surface === "chat" ? (
          <>
            <section className="inspector-section compact-section">
              <div className="section-heading"><span>Model</span></div>
              <select
                aria-label="Model configuration"
                disabled={props.locked}
                value={`${props.thread.modelConfigurationId}@${props.thread.modelConfigurationRevision}`}
                onChange={(event) => {
                  const separator = event.target.value.lastIndexOf("@");
                  const id = event.target.value.slice(0, separator);
                  const revisionValue = event.target.value.slice(separator + 1);
                  const configuration = props.settings.modelConfigurations.find(
                    (entry) => entry.id === id,
                  );
                  const revision = Number(revisionValue);
                  if (configuration !== undefined && Number.isSafeInteger(revision)) {
                    props.onModelConfigurationChange(configuration.id, revision);
                  }
                }}
              >
                {activeConfiguration !== undefined
                  && (activeConfiguration.archivedAt !== undefined
                    || activeConfiguration.currentRevision !== props.thread.modelConfigurationRevision) ? (
                    <option value={`${activeConfiguration.id}@${props.thread.modelConfigurationRevision}`}>
                      {activeConfiguration.name} · revision {props.thread.modelConfigurationRevision}
                    </option>
                  ) : null}
                {props.settings.modelConfigurations
                  .filter((configuration) => configuration.archivedAt === undefined)
                  .map((configuration) => (
                    <option key={configuration.id} value={`${configuration.id}@${configuration.currentRevision}`}>
                      {configuration.name}
                    </option>
                  ))}
              </select>
              {activeRevision !== undefined ? (
                <p className="provider-model" title={activeRevision.policy.model}>
                  {activeRevision.policy.model}
                </p>
              ) : null}
              {providerReadiness !== undefined ? (
                <p className={`provider-status ${providerReadiness.configured ? "" : "needs-credential"}`}>
                  <span aria-hidden="true" />
                  {providerReadiness.configured ? "Provider ready" : "Credential required"}
                </p>
              ) : null}
              {props.locked ? <p className="compact-note">Locked while this conversation is active.</p> : null}
            </section>

            <section className="inspector-section compact-section">
              <div className="section-heading"><span>Apps</span></div>
              <div className="compact-check-list">
                {props.settings.apps.map((app) => (
                  <label key={app.id}>
                    <span><strong>{app.label}</strong><small>{app.description}</small></span>
                    <input
                      type="checkbox"
                      checked={enabledApps.has(app.id)}
                      disabled={props.locked}
                      onChange={(event) => props.onAppToggle(app.id, event.target.checked)}
                    />
                  </label>
                ))}
              </div>
              {enabledApps.has("weather") ? (
                <p className={`provider-status ${weatherCapability?.readiness === "ready" ? "" : "needs-credential"}`}>
                  <span aria-hidden="true" />
                  {weatherCapability?.readiness === "ready" ? "Weather fallback ready" : "Weather free provider"}
                </p>
              ) : null}
            </section>
          </>
        ) : (
          <section className="inspector-section compact-section">
            <div className="section-heading"><span>Context</span></div>
            <p className="context-title">{surfaceLabel(props.surface)}</p>
            <p className="compact-note">{surfaceDescription(props.surface)}</p>
          </section>
        )}

        <section className="inspector-section compact-section">
          <div className="section-heading">
            <span>Project</span>
            <button className="icon-button" type="button" aria-label="Add project" title="Add project" onClick={props.onAddProject}>
              <Plus size={15} />
            </button>
          </div>
          {props.settings.projects.length > 0 ? (
            <label className="compact-select-row">
              <Folder size={14} />
              <select
                aria-label="Active project"
                value={props.activeProjectPath ?? props.settings.projects[0]?.path}
                onChange={(event) => props.onProjectChange(event.target.value)}
              >
                {props.settings.projects.map((project) => (
                  <option key={project.path} value={project.path}>{project.label}</option>
                ))}
              </select>
            </label>
          ) : <p className="compact-note">No project registered.</p>}
        </section>
      </div>

      <section className="global-status-strip">
        <span className={`status-dot health-${healthState}`} aria-hidden="true" />
        <span><strong>{healthState}</strong><small>Bridge v{props.bridgeInfo?.version ?? "–"}</small></span>
        <button className="icon-button" type="button" title="Restart runtime" aria-label="Restart runtime" onClick={props.onRestartRuntime}>
          <RefreshCw size={14} />
        </button>
      </section>
    </aside>
  );
}

function surfaceLabel(surface: string): string {
  if (surface === "mission-control") return "Mission control";
  if (surface === "projects") return "Projects";
  if (surface === "mcp") return "MCP servers";
  if (surface === "settings") return "Settings";
  return "Diagnostics";
}

function surfaceDescription(surface: string): string {
  if (surface === "mission-control") return "Run and task context for the active conversation.";
  if (surface === "projects") return "Files and actions for the selected project.";
  if (surface === "mcp") return "Configured local integrations.";
  if (surface === "settings") return "Application-wide configuration.";
  return "Runtime health and support information.";
}
