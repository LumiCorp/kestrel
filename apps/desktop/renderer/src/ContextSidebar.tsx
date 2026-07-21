import { Folder, Plus, RefreshCw, Settings } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type {
  DesktopBridgeInfo,
  DesktopCapabilityId,
  DesktopRendererSettings,
  DesktopRuntimeHealth,
} from "../../src/contracts";
import type { ModelPolicyV1 } from "../../../../src/profile/modelPolicy";

export function ContextSidebar(props: {
  surface: string;
  settings: DesktopRendererSettings;
  modelPolicy?: ModelPolicyV1 | undefined;
  runtimeHealth?: DesktopRuntimeHealth | undefined;
  bridgeInfo?: DesktopBridgeInfo | undefined;
  activeProjectPath?: string | undefined;
  onProjectChange: (path: string) => void;
  onAddProject: () => void;
  onRestartRuntime: () => void;
  onOpenCapability: (id?: DesktopCapabilityId) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const healthState = props.runtimeHealth?.state ?? "degraded";

  return (
    <aside className="inspector contextual-sidebar" aria-label="Context sidebar">
      <div className="sidebar-resize-handle" onPointerDown={props.onResizeStart} aria-hidden="true" />
      <div className="context-sidebar-scroll">
        {props.surface === "chat" ? (
          <>
            <section className="inspector-section compact-section">
              <div className="section-heading">
                <span>Provider</span>
                <button
                  className="icon-button"
                  type="button"
                  title="Configure provider and model"
                  aria-label="Configure provider and model"
                  onClick={() => props.onOpenCapability(`model.${props.settings.selectedProvider}`)}
                >
                  <Settings size={15} aria-hidden="true" />
                </button>
              </div>
              <p className="provider-model" title={props.modelPolicy?.model}>
                {props.modelPolicy?.model ?? props.settings.selectedProvider}
              </p>
              <p className="provider-status">
                <span aria-hidden="true" />
                {props.settings.selectedProvider}
              </p>
            </section>

            <section className="inspector-section compact-section">
              <div className="section-heading"><span>Apps</span></div>
              <button
                className="app-readiness-row"
                type="button"
                onClick={() => props.onOpenCapability("tools.weather")}
              >
                <span className="app-readiness-copy">
                  <strong>Weather</strong>
                  <small>Open-Meteo + Visual Crossing fallback</small>
                </span>
                <span className="provider-status"><span aria-hidden="true" />View readiness</span>
              </button>
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
  if (surface === "settings") return "Application-wide capability configuration.";
  return "Runtime health and support information.";
}
