import { CheckCircle2, Circle, CircleAlert, RefreshCw, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type {
  DesktopCapability,
  DesktopCapabilityCategory,
  DesktopCapabilityView,
  DesktopCapabilityId,
  DesktopModelProvider,
  DesktopRendererSettings,
  DesktopRendererSettingsUpdate,
} from "../../src/contracts";
import {
  appendDesktopModelConfigurationRevision,
  createDesktopModelConfiguration,
} from "../../../../src/desktopShell/configuration";
import { keepFocusInsideDialog } from "./dialogFocus";

const CATEGORY_ORDER: DesktopCapabilityCategory[] = [
  "models",
  "tools_services",
  "local_capabilities",
  "connections",
  "workspace_data",
  "permissions",
];

const CATEGORY_LABELS: Record<DesktopCapabilityCategory, string> = {
  models: "Models",
  tools_services: "Tools & services",
  local_capabilities: "Local capabilities",
  connections: "Connections",
  workspace_data: "Workspace & data",
  permissions: "Permissions",
};

interface SettingsWorkspaceProps {
  settings: DesktopRendererSettings;
  initialCapabilityId?: DesktopCapabilityId | undefined;
  onSettings: (update: DesktopRendererSettingsUpdate) => Promise<DesktopRendererSettings>;
  onCapabilitiesChange?: ((view: DesktopCapabilityView) => void) | undefined;
  onOpenMcp: () => void;
  onAddProject: () => Promise<void>;
  onRequestMicrophone: () => Promise<void>;
  onError: (message: string | undefined) => void;
}

export function SettingsWorkspace({
  settings,
  initialCapabilityId,
  onSettings,
  onCapabilitiesChange,
  onOpenMcp,
  onAddProject,
  onRequestMicrophone,
  onError,
}: SettingsWorkspaceProps) {
  const [view, setView] = useState<DesktopCapabilityView>();
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<DesktopCapability>();
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [credential, setCredential] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmingCredentialRemoval, setConfirmingCredentialRemoval] = useState(false);
  const [openedTarget, setOpenedTarget] = useState<DesktopCapabilityId>();
  const [selectedId, setSelectedId] = useState(settings.defaultModelConfigurationId);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<DesktopModelProvider>("openrouter");
  const [model, setModel] = useState("");
  const [timeout, setTimeoutValue] = useState("");
  const [vision, setVision] = useState(false);
  const [stageOverrides, setStageOverrides] = useState("{}");
  const [apiKey, setApiKey] = useState("");
  const [catalog, setCatalog] = useState<string[]>([]);
  const dialogRef = useRef<HTMLFormElement>(null);
  const savingRef = useRef(false);
  const grouped = useMemo(() => new Map(CATEGORY_ORDER.map((category) => [
    category,
    view?.capabilities.filter((capability) => capability.category === category) ?? [],
  ])), [view]);
  const readinessSummary = useMemo(() => summarizeReadiness(view?.capabilities ?? []), [view]);
  const selected = useMemo(
    () => settings.modelConfigurations.find((entry) => entry.id === selectedId),
    [settings.modelConfigurations, selectedId],
  );

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const revision = selected?.revisions.find((entry) => entry.revision === selected.currentRevision);
    setName(selected?.name ?? "");
    setProvider(revision?.policy.provider ?? "openrouter");
    setModel(revision?.policy.model ?? "");
    setTimeoutValue(revision?.policy.modelTimeoutMs?.toString() ?? "");
    setVision(revision?.policy.modelCapabilities.visionInputEnabled ?? false);
    setStageOverrides(JSON.stringify(revision?.policy.modelByStage ?? {}, null, 2));
  }, [selected]);

  useEffect(() => {
    let disposed = false;
    void window.kestrelDesktop.getModelCatalog(provider).then((result) => {
      if (!disposed) setCatalog(result.models);
    }).catch(() => {
      if (!disposed) setCatalog([]);
    });
    return () => { disposed = true; };
  }, [provider]);

  useEffect(() => {
    if (initialCapabilityId === undefined || initialCapabilityId === openedTarget || view === undefined) return;
    const target = view.capabilities.find((capability) => capability.id === initialCapabilityId);
    if (target !== undefined && isConfigurable(target)) openEditor(target);
    setOpenedTarget(initialCapabilityId);
  }, [initialCapabilityId, openedTarget, view]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    if (editing === undefined) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && savingRef.current === false) closeEditor();
      keepFocusInsideDialog(event, dialogRef.current);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [editing?.id]);

  async function refresh(): Promise<void> {
    setLoading(true);
    onError(undefined);
    try {
      const nextView = await window.kestrelDesktop.getCapabilities();
      setView(nextView);
      onCapabilitiesChange?.(nextView);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function runAction(action: (() => void | Promise<void>) | undefined): Promise<void> {
    if (action === undefined) return;
    setNotice(undefined);
    onError(undefined);
    try {
      await action();
      await refresh();
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  function actionFor(capability: DesktopCapability): (() => void | Promise<void>) | undefined {
    if (capability.id === "connections.mcp") return onOpenMcp;
    if (isConfigurable(capability)) return () => openEditor(capability);
    if (capability.id === "data.workspace") return onAddProject;
    if (capability.id === "permission.microphone") return onRequestMicrophone;
    return;
  }

  function openEditor(capability: DesktopCapability): void {
    setEditing(capability);
    setCredential("");
    setEditorError(undefined);
    setConfirmingCredentialRemoval(false);
    setDraft({
      ...Object.fromEntries(capability.settings
        .filter((field) => field.secret === false)
        .map((field) => [field.key, field.value ?? ""])),
      enabled: capability.enabled,
    });
  }

  function closeEditor(): void {
    setEditing(undefined);
    setCredential("");
    setEditorError(undefined);
    setConfirmingCredentialRemoval(false);
  }

  async function saveConfiguration(): Promise<void> {
    if (editing === undefined) return;
    setSaving(true);
    setEditorError(undefined);
    onError(undefined);
    try {
      const settings = Object.fromEntries(
        editing.settings
          .filter((field) => field.secret === false)
          .map((field) => {
            const value = draft[field.key];
            return [field.key, typeof value === "string" && value.trim().length === 0 ? null : value ?? null];
          }),
      );
      const result = await window.kestrelDesktop.configureCapability({
        capabilityId: editing.id,
        ...(supportsEnablement(editing) ? { enabled: draft.enabled === true } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(credential.trim().length > 0 ? { credential: credential.trim() } : {}),
      });
      setView(result.view);
      onCapabilitiesChange?.(result.view);
      setNotice(`${editing.name} was verified and applied${result.runtimeRestarted ? "; the runtime restarted with the new configuration" : ""}.`);
      closeEditor();
    } catch (error) {
      setEditorError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function removeCredential(): Promise<void> {
    if (editing === undefined) return;
    setSaving(true);
    setEditorError(undefined);
    try {
      const capabilityName = editing.name;
      const result = await window.kestrelDesktop.configureCapability({
        capabilityId: editing.id,
        credential: null,
      });
      setView(result.view);
      onCapabilitiesChange?.(result.view);
      setNotice(`${capabilityName} credential removed.`);
      closeEditor();
    } catch (error) {
      setEditorError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveModel(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (name.trim().length === 0 || model.trim().length === 0) {
      onError("A name and model ID are required.");
      return;
    }
    setSaving(true);
    onError(undefined);
    try {
      const parsedStageOverrides = JSON.parse(stageOverrides) as unknown;
      if (typeof parsedStageOverrides !== "object" || parsedStageOverrides === null || Array.isArray(parsedStageOverrides)) {
        throw new Error("Stage overrides must be a JSON object.");
      }
      if (apiKey.trim().length > 0) {
        const result = await window.kestrelDesktop.configureCapability({
          capabilityId: `model.${provider}`,
          enabled: true,
          settings: { model: model.trim() },
          credential: apiKey.trim(),
        });
        setView(result.view);
        onCapabilitiesChange?.(result.view);
        setApiKey("");
      }
      const base = selected ?? createDesktopModelConfiguration({
        version: 1,
        provider,
        model: model.trim(),
        modelByStage: {},
        modelCapabilities: { visionInputEnabled: vision },
      }, {
        id: crypto.randomUUID(),
        name: name.trim(),
        createdAt: new Date().toISOString(),
      });
      const current = base.revisions.find((entry) => entry.revision === base.currentRevision)!.policy;
      const { modelTimeoutMs: _currentTimeout, ...currentWithoutTimeout } = current;
      const nextPolicy = {
        ...currentWithoutTimeout,
        provider,
        model: model.trim(),
        modelByStage: parsedStageOverrides as Record<string, string>,
        ...(timeout.trim().length > 0 ? { modelTimeoutMs: Number(timeout) } : {}),
        modelCapabilities: { visionInputEnabled: vision },
      };
      const next = selected === undefined
        ? { ...base, name: name.trim(), revisions: [{ ...base.revisions[0]!, policy: nextPolicy }] }
        : { ...appendDesktopModelConfigurationRevision(base, nextPolicy), name: name.trim() };
      await onSettings({
        modelConfigurations: selected === undefined
          ? [...settings.modelConfigurations, next]
          : settings.modelConfigurations.map((entry) => entry.id === next.id ? next : entry),
      });
      setSelectedId(next.id);
      setNotice(`${next.name} configuration saved.`);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="surface-pane settings-surface" id="app-main">
      <header className="surface-header">
        <div>
          <span className="surface-kicker">Desktop authority</span>
          <h1>Settings</h1>
          <p>Understand what Kestrel can use, what is ready, and what needs setup.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin" : undefined} aria-hidden="true" />
          {loading ? "Checking…" : "Refresh readiness"}
        </button>
      </header>

      {view !== undefined ? (
        <>
          <div className="settings-authority-note">
            <Settings2 size={17} aria-hidden="true" />
            <span>
              Credentials are {view.credentialStore.available ? "stored securely by Local Core" : "unavailable on this system"} and are never returned to this screen.
            </span>
          </div>
          <div className="capability-summary" aria-label="Capability readiness summary">
            <span><CheckCircle2 size={15} aria-hidden="true" /><strong>{readinessSummary.ready}</strong> ready</span>
            <span><CircleAlert size={15} aria-hidden="true" /><strong>{readinessSummary.attention}</strong> need attention</span>
            <span><Circle size={15} aria-hidden="true" /><strong>{readinessSummary.inactive}</strong> inactive or optional</span>
          </div>
          <nav className="settings-category-nav" aria-label="Settings categories">
            {CATEGORY_ORDER.map((category) => (
              <a href={`#settings-${category}`} key={category}>{CATEGORY_LABELS[category]}</a>
            ))}
          </nav>
        </>
      ) : null}

      {notice !== undefined ? <p className="settings-notice" role="status">{notice}</p> : null}

      <div className="settings-sections" aria-busy={loading}>
        {CATEGORY_ORDER.map((category) => {
          const capabilities = grouped.get(category) ?? [];
          return (
            <section className="settings-section" key={category} aria-labelledby={`settings-${category}-title`} id={`settings-${category}`}>
              <div className="settings-section-heading">
                <h2 id={`settings-${category}-title`}>{CATEGORY_LABELS[category]}</h2>
                <span>{capabilities.length} {capabilities.length === 1 ? "capability" : "capabilities"}</span>
              </div>
              <div className="capability-card-list">
                {capabilities.map((capability) => {
                  const action = actionFor(capability);
                  const CapabilityIcon = readinessIcon(capability.readiness);
                  return (
                    <article className="capability-card" data-readiness={capability.readiness} key={capability.id}>
                      <div className="capability-card-main">
                        <div className="capability-title-row">
                          <CapabilityIcon size={17} aria-hidden="true" />
                          <div>
                            <h3>{capability.name}</h3>
                            <p>{capability.description}</p>
                          </div>
                        </div>
                        <p className="capability-detail">{capability.detail}</p>
                        {capability.lastVerifiedAt !== undefined ? (
                          <p className="capability-verification-time">Last verified {new Date(capability.lastVerifiedAt).toLocaleString()}</p>
                        ) : null}
                        {capability.toolNames.length > 0 ? (
                          <p className="capability-tools">
                            <strong>{capability.toolNames.length} tool{capability.toolNames.length === 1 ? "" : "s"}</strong>
                            <span title={capability.toolNames.join(", ")}>{summarizeTools(capability.toolNames)}</span>
                          </p>
                        ) : null}
                      </div>
                      <div className="capability-card-actions">
                        <span className={`capability-readiness readiness-${capability.readiness}`}>
                          {readinessLabel(capability.readiness)}
                        </span>
                        {action !== undefined ? (
                          <button className="secondary-button" type="button" onClick={() => void runAction(action)}>
                            {actionLabel(capability)}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <section className="settings-section" aria-labelledby="model-configurations-title">
        <div className="settings-section-heading">
          <div>
            <h2 id="model-configurations-title">Conversation model configurations</h2>
            <p>Named, revisioned model choices used by the contextual sidebar.</p>
          </div>
        </div>
        <div className="settings-content model-settings-grid">
          <div className="settings-list">
            {settings.modelConfigurations.map((configuration) => (
              <button key={configuration.id} type="button" className={selectedId === configuration.id ? "active" : ""} onClick={() => setSelectedId(configuration.id)}>
                <strong>{configuration.name}</strong>
                <small>{configuration.revisions.find((entry) => entry.revision === configuration.currentRevision)?.policy.model}</small>
                {configuration.id === settings.defaultModelConfigurationId ? <span>Default</span> : null}
              </button>
            ))}
            <button type="button" className={selected === undefined ? "active" : ""} onClick={() => {
              setSelectedId("");
              setName("New model");
              setProvider("openrouter");
              setModel("");
              setTimeoutValue("");
              setVision(false);
              setStageOverrides("{}");
            }}>+ Add model</button>
          </div>
          <form className="settings-form" onSubmit={(event) => void saveModel(event)}>
            <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as DesktopModelProvider)}>
              <option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="ollama">Ollama</option><option value="lmstudio">LM Studio</option>
            </select></label>
            <label>Model ID<input list="model-catalog" value={model} onChange={(event) => setModel(event.target.value)} /></label>
            <datalist id="model-catalog">{catalog.map((entry) => <option key={entry} value={entry} />)}</datalist>
            {provider === "openrouter" || provider === "openai" || provider === "anthropic" ? (
              <label>Provider API key<input type="password" autoComplete="off" value={apiKey} placeholder="Leave blank to keep the stored key" onChange={(event) => setApiKey(event.target.value)} /></label>
            ) : null}
            <details><summary>Advanced policy</summary>
              <label>Timeout (ms)<input inputMode="numeric" value={timeout} onChange={(event) => setTimeoutValue(event.target.value.replace(/\D/g, ""))} /></label>
              <label className="settings-check"><input type="checkbox" checked={vision} onChange={(event) => setVision(event.target.checked)} />Enable vision input</label>
              <label>Stage overrides (JSON)<textarea rows={5} value={stageOverrides} onChange={(event) => setStageOverrides(event.target.value)} /></label>
            </details>
            <div className="settings-form-actions">
              {selected !== undefined && selected.id !== settings.defaultModelConfigurationId ? <button type="button" onClick={() => void onSettings({ defaultModelConfigurationId: selected.id })}>Make default</button> : null}
              {selected !== undefined && selected.id !== settings.defaultModelConfigurationId ? <button type="button" onClick={() => void onSettings({ modelConfigurations: settings.modelConfigurations.map((entry) => entry.id === selected.id ? { ...entry, archivedAt: new Date().toISOString() } : entry) })}>Archive</button> : null}
              <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save model"}</button>
            </div>
          </form>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="desktop-preferences-title">
        <div className="settings-section-heading"><h2 id="desktop-preferences-title">Desktop preferences</h2></div>
        <div className="settings-content settings-card">
          <div className="settings-form">
            <strong>Default Apps for new conversations</strong>
            {settings.apps.map((app) => (
              <label className="settings-check" key={app.id}>
                <input
                  type="checkbox"
                  checked={settings.defaultEnabledAppIds.includes(app.id)}
                  onChange={(event) => void onSettings({
                    defaultEnabledAppIds: event.target.checked
                      ? [...new Set([...settings.defaultEnabledAppIds, app.id])]
                      : settings.defaultEnabledAppIds.filter((id) => id !== app.id),
                  })}
                />
                Enable {app.label}
              </label>
            ))}
          </div>
          <div className="appearance-options">
            {(["system", "light", "dark"] as const).map((theme) => <label key={theme}><input type="radio" name="theme" checked={settings.appearanceTheme === theme} onChange={() => void onSettings({ appearanceTheme: theme })} />{theme[0]!.toUpperCase() + theme.slice(1)}</label>)}
          </div>
        </div>
      </section>

      {editing !== undefined ? (
        <div className="dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && saving === false) closeEditor();
        }}>
          <form
            className="provider-dialog capability-dialog"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="capability-dialog-title"
            aria-describedby="capability-dialog-description"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              void saveConfiguration();
            }}
          >
            <div className="provider-dialog-header">
              <div>
                <span className="surface-kicker">{CATEGORY_LABELS[editing.category]}</span>
                <h2 id="capability-dialog-title">{editing.name}</h2>
                <p id="capability-dialog-description">{editing.verificationStrategy}</p>
              </div>
              <button className="icon-button" type="button" aria-label="Close capability settings" disabled={saving} onClick={closeEditor}>
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            {supportsEnablement(editing) ? (
              <label className="capability-toggle-field">
                <input
                  data-autofocus
                  type="checkbox"
                  checked={draft.enabled === true}
                  onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
                />
                <span>{editing.category === "models" ? "Use as active model provider" : "Enable this capability pack"}</span>
              </label>
            ) : null}
            {editing.settings.map((field, index) => {
              const credentialStored = field.secret && editing.requirements.some((requirement) => requirement.kind === "credential" && requirement.satisfied);
              const controlId = `capability-setting-${field.key}`;
              return (
                <label className="provider-dialog-field" htmlFor={controlId} key={field.key}>
                  <span>{field.label}{field.required && credentialStored === false ? " *" : ""}{credentialStored ? <small>Stored securely</small> : null}</span>
                  {field.kind === "select" ? (
                    <select
                      id={controlId}
                      data-autofocus={supportsEnablement(editing) === false && index === 0 ? true : undefined}
                      value={String(draft[field.key] ?? field.value ?? "")}
                      onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                    >
                      {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  ) : (
                    <input
                      id={controlId}
                      data-autofocus={supportsEnablement(editing) === false && index === 0 ? true : undefined}
                      type={field.secret ? "password" : field.kind === "url" ? "url" : "text"}
                      value={field.secret ? credential : String(draft[field.key] ?? "")}
                      placeholder={field.secret ? credentialStored ? "Enter a new value to replace" : "Enter credential" : field.placeholder}
                      autoComplete="off"
                      required={field.required && credentialStored === false}
                      onChange={(event) => field.secret
                        ? setCredential(event.target.value)
                        : setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                    />
                  )}
                </label>
              );
            })}
            <p className="provider-dialog-note">{editing.runtimeApplication}</p>
            {editorError !== undefined ? <p className="provider-dialog-error" role="alert">{editorError}</p> : null}
            <div className="provider-dialog-actions provider-dialog-actions-split">
              {editing.requirements.some((requirement) => requirement.kind === "credential" && requirement.satisfied) ? (
                confirmingCredentialRemoval ? (
                  <div className="destructive-confirmation">
                    <button className="secondary-button" type="button" disabled={saving} onClick={() => setConfirmingCredentialRemoval(false)}>Cancel</button>
                    <button className="provider-dialog-remove" type="button" disabled={saving} onClick={() => void removeCredential()}>Confirm removal</button>
                  </div>
                ) : (
                  <button className="provider-dialog-remove" type="button" disabled={saving} onClick={() => setConfirmingCredentialRemoval(true)}>
                    Remove credential
                  </button>
                )
              ) : <span />}
              <button className="provider-dialog-save" type="submit" disabled={saving}>
                {saving ? "Verifying…" : "Verify and apply"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function supportsEnablement(capability: DesktopCapability): boolean {
  return capability.category === "models"
    || capability.id === "tools.network.free"
    || capability.id === "local.filesystem"
    || capability.id === "local.developer_shell"
    || capability.id === "local.sandbox_code";
}

function isConfigurable(capability: DesktopCapability): boolean {
  return capability.settings.length > 0 || supportsEnablement(capability);
}

function readinessLabel(readiness: DesktopCapability["readiness"]): string {
  if (readiness === "setup_required") return "Setup required";
  if (readiness === "verification_failed") return "Verification failed";
  return readiness.charAt(0).toUpperCase() + readiness.slice(1);
}

function readinessIcon(readiness: DesktopCapability["readiness"]): typeof CheckCircle2 {
  if (readiness === "ready") return CheckCircle2;
  if (readiness === "setup_required" || readiness === "verification_failed" || readiness === "unavailable") return CircleAlert;
  return Circle;
}

function actionLabel(capability: DesktopCapability): string {
  if (capability.id === "connections.mcp") return "Manage Apps";
  if (capability.id === "data.workspace") return "Add project";
  if (capability.id === "permission.microphone") return "Request access";
  if (capability.readiness === "setup_required" || capability.readiness === "verification_failed") return "Set up";
  return "Configure";
}

function summarizeReadiness(capabilities: DesktopCapability[]): { ready: number; attention: number; inactive: number } {
  return capabilities.reduce((summary, capability) => {
    if (capability.readiness === "ready") summary.ready += 1;
    else if (capability.readiness === "setup_required" || capability.readiness === "verification_failed" || capability.readiness === "unavailable") summary.attention += 1;
    else summary.inactive += 1;
    return summary;
  }, { ready: 0, attention: 0, inactive: 0 });
}

function summarizeTools(toolNames: string[]): string {
  const visible = toolNames.slice(0, 4);
  return toolNames.length > visible.length
    ? `${visible.join(", ")} +${toolNames.length - visible.length} more`
    : visible.join(", ");
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
