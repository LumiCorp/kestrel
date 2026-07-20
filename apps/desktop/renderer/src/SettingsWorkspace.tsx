import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  DesktopCredentialedModelProvider,
  DesktopModelConfiguration,
  DesktopModelProvider,
  DesktopRendererSettings,
  DesktopRendererSettingsUpdate,
  DesktopToolCredentialStatus,
} from "../../src/contracts";
import {
  appendDesktopModelConfigurationRevision,
  createDesktopModelConfiguration,
} from "../../../../src/desktopShell/configuration";

type SettingsSection = "models" | "apps" | "appearance";

export function SettingsWorkspace(props: {
  settings: DesktopRendererSettings;
  weatherCredential?: DesktopToolCredentialStatus | undefined;
  onSettings: (update: DesktopRendererSettingsUpdate) => Promise<void>;
  onProviderCredential: (provider: DesktopCredentialedModelProvider, apiKey: string) => Promise<void>;
  onWeatherCredential: (apiKey: string) => Promise<void>;
  onRemoveWeatherCredential: () => Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const [section, setSection] = useState<SettingsSection>("models");
  const [selectedId, setSelectedId] = useState(props.settings.defaultModelConfigurationId);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<DesktopModelProvider>("openrouter");
  const [model, setModel] = useState("");
  const [timeout, setTimeoutValue] = useState("");
  const [vision, setVision] = useState(false);
  const [stageOverrides, setStageOverrides] = useState("{}");
  const [apiKey, setApiKey] = useState("");
  const [weatherKey, setWeatherKey] = useState("");
  const [catalog, setCatalog] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const selected = useMemo(
    () => props.settings.modelConfigurations.find((entry) => entry.id === selectedId),
    [props.settings.modelConfigurations, selectedId],
  );

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

  async function saveModel(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (name.trim().length === 0 || model.trim().length === 0) {
      props.onError("A name and model ID are required.");
      return;
    }
    setSaving(true);
    props.onError(undefined);
    try {
      if (isCredentialedProvider(provider) && apiKey.trim().length > 0) {
        await props.onProviderCredential(provider, apiKey.trim());
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
      const parsedStageOverrides = JSON.parse(stageOverrides) as unknown;
      if (typeof parsedStageOverrides !== "object" || parsedStageOverrides === null || Array.isArray(parsedStageOverrides)) {
        throw new Error("Stage overrides must be a JSON object.");
      }
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
      const configurations = selected === undefined
        ? [...props.settings.modelConfigurations, next]
        : props.settings.modelConfigurations.map((entry) => entry.id === next.id ? next : entry);
      await props.onSettings({ modelConfigurations: configurations });
      setSelectedId(next.id);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="settings-workspace surface-pane">
      <header className="surface-header">
        <div><span className="surface-kicker">Application</span><h1>Settings</h1><p>Models, apps, and appearance.</p></div>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {(["models", "apps", "appearance"] as const).map((item) => (
            <button key={item} type="button" className={section === item ? "active" : ""} onClick={() => setSection(item)}>
              {item[0]!.toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>

        {section === "models" ? (
          <div className="settings-content model-settings-grid">
            <div className="settings-list">
              {props.settings.modelConfigurations.map((configuration) => (
                <button key={configuration.id} type="button" className={selectedId === configuration.id ? "active" : ""} onClick={() => setSelectedId(configuration.id)}>
                  <strong>{configuration.name}</strong>
                  <small>{configuration.revisions.find((entry) => entry.revision === configuration.currentRevision)?.policy.model}</small>
                  {configuration.id === props.settings.defaultModelConfigurationId ? <span>Default</span> : null}
                </button>
              ))}
              <button type="button" className={selected === undefined ? "active" : ""} onClick={() => {
                setSelectedId(""); setName("New model"); setProvider("openrouter"); setModel(""); setTimeoutValue(""); setVision(false); setStageOverrides("{}");
              }}>+ Add model</button>
            </div>
            <form className="settings-form" onSubmit={(event) => void saveModel(event)}>
              <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as DesktopModelProvider)}>
                <option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="ollama">Ollama</option><option value="lmstudio">LM Studio</option>
              </select></label>
              <label>Model ID<input list="model-catalog" value={model} onChange={(event) => setModel(event.target.value)} /></label>
              <datalist id="model-catalog">{catalog.map((entry) => <option key={entry} value={entry} />)}</datalist>
              {isCredentialedProvider(provider) ? <label>Provider API key<input type="password" autoComplete="off" value={apiKey} placeholder="Leave blank to keep current key" onChange={(event) => setApiKey(event.target.value)} /></label> : null}
              <details><summary>Advanced policy</summary>
                <label>Timeout (ms)<input inputMode="numeric" value={timeout} onChange={(event) => setTimeoutValue(event.target.value.replace(/\D/g, ""))} /></label>
                <label className="settings-check"><input type="checkbox" checked={vision} onChange={(event) => setVision(event.target.checked)} />Enable vision input</label>
                <label>Stage overrides (JSON)<textarea rows={5} value={stageOverrides} onChange={(event) => setStageOverrides(event.target.value)} /></label>
              </details>
              <div className="settings-form-actions">
                {selected !== undefined && selected.id !== props.settings.defaultModelConfigurationId ? <button type="button" onClick={() => void props.onSettings({ defaultModelConfigurationId: selected.id })}>Make default</button> : null}
                {selected !== undefined && selected.id !== props.settings.defaultModelConfigurationId ? <button type="button" onClick={() => void props.onSettings({ modelConfigurations: props.settings.modelConfigurations.map((entry) => entry.id === selected.id ? { ...entry, archivedAt: new Date().toISOString() } : entry) })}>Archive</button> : null}
                <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save model"}</button>
              </div>
            </form>
          </div>
        ) : section === "apps" ? (
          <div className="settings-content">
            <section className="settings-card"><h2>Weather</h2><p>Open-Meteo current conditions and forecasts, with optional Visual Crossing fallback.</p>
              <label className="settings-check"><input type="checkbox" checked={props.settings.defaultEnabledAppIds.includes("weather")} onChange={(event) => void props.onSettings({ defaultEnabledAppIds: event.target.checked ? ["weather"] : [] })} />Enable by default for new conversations</label>
              <form className="inline-credential-form" onSubmit={(event) => { event.preventDefault(); if (weatherKey.trim()) void props.onWeatherCredential(weatherKey.trim()).then(() => setWeatherKey("")); }}>
                <input type="password" value={weatherKey} placeholder="Visual Crossing API key" onChange={(event) => setWeatherKey(event.target.value)} />
                <button type="submit">Save key</button>
                {props.weatherCredential?.configured ? <button type="button" onClick={() => void props.onRemoveWeatherCredential()}>Remove</button> : null}
              </form>
            </section>
          </div>
        ) : (
          <div className="settings-content"><section className="settings-card"><h2>Appearance</h2><div className="appearance-options">
            {(["system", "light", "dark"] as const).map((theme) => <label key={theme}><input type="radio" name="theme" checked={props.settings.appearanceTheme === theme} onChange={() => void props.onSettings({ appearanceTheme: theme })} />{theme[0]!.toUpperCase() + theme.slice(1)}</label>)}
          </div></section></div>
        )}
      </div>
    </main>
  );
}

function isCredentialedProvider(provider: DesktopModelProvider): provider is DesktopCredentialedModelProvider {
  return provider === "openrouter" || provider === "openai" || provider === "anthropic";
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
