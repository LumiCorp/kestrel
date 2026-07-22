import {
  CheckCircle2,
  ChevronRight,
  Circle,
  CloudSun,
  ExternalLink,
  Globe2,
  KeyRound,
  LockKeyhole,
  Network,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  DesktopCapability,
  DesktopCapabilityView,
  DesktopMcpDiscoveryResult,
  DesktopMcpServerConfig,
  DesktopMcpServerMutationInput,
} from "../../src/contracts";

const EXA_CONNECTOR_ID = "prebuilt.exa";
const EXA_CONNECTOR_URL = "https://mcp.exa.ai/mcp";
const EXA_CONNECTOR_DOCS_URL = "https://exa.ai/mcp";
const TAVILY_DOCS_URL = "https://docs.tavily.com/documentation/quickstart";

interface ToolServicesSettingsProps {
  capabilities: DesktopCapability[];
  credentialStoreAvailable: boolean;
  onCapabilitiesChange: (view: DesktopCapabilityView) => void;
  onNotice: (message: string) => void;
  onOpenMcp: () => void;
  onError: (message: string | undefined) => void;
}

export function ToolServicesSettings({
  capabilities,
  credentialStoreAvailable,
  onCapabilitiesChange,
  onNotice,
  onOpenMcp,
  onError,
}: ToolServicesSettingsProps) {
  const [selectedId, setSelectedId] = useState(EXA_CONNECTOR_ID);
  const [mcpResult, setMcpResult] = useState<DesktopMcpDiscoveryResult>();
  const [credential, setCredential] = useState("");
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string>();

  const selectedCapability = capabilities.find((capability) => capability.id === selectedId);
  const exaServer = mcpResult?.servers.find((server) => server.id === EXA_CONNECTOR_ID);
  const exaConnected = exaServer?.sourceKind === "desktop-managed" && exaServer.enabled;
  const orderedCapabilities = useMemo(() => {
    const order = ["tools.internet.tavily", "tools.weather", "tools.network.free"];
    return [...capabilities].sort((left, right) => {
      const leftIndex = order.indexOf(left.id);
      const rightIndex = order.indexOf(right.id);
      return (leftIndex === -1 ? order.length : leftIndex) - (rightIndex === -1 ? order.length : rightIndex);
    });
  }, [capabilities]);

  useEffect(() => {
    let disposed = false;
    void window.kestrelDesktop.discoverMcpServers().then((result) => {
      if (!disposed) setMcpResult(result);
    }).catch(() => {
      if (!disposed) setMcpResult(undefined);
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    setCredential("");
    setInlineError(undefined);
    setDraft(Object.fromEntries((selectedCapability?.settings ?? [])
      .filter((field) => field.secret === false)
      .map((field) => [field.key, field.value ?? ""])));
  }, [selectedId, selectedCapability]);

  async function configureCapability(capability: DesktopCapability, enabled?: boolean): Promise<void> {
    setBusy(true);
    setInlineError(undefined);
    onError(undefined);
    try {
      const settings = Object.fromEntries(capability.settings
        .filter((field) => field.secret === false)
        .map((field) => {
          const value = draft[field.key];
          return [field.key, typeof value === "string" && value.trim().length === 0 ? null : value ?? null];
        }));
      const result = await window.kestrelDesktop.configureCapability({
        capabilityId: capability.id,
        ...(enabled !== undefined ? { enabled } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(credential.trim().length > 0 ? { credential: credential.trim() } : {}),
      });
      onCapabilitiesChange(result.view);
      setCredential("");
      onNotice(`${toolServiceName(capability)} was verified and applied${result.runtimeRestarted ? "; the runtime restarted with the new configuration" : ""}.`);
    } catch (cause) {
      setInlineError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function connectExa(): Promise<void> {
    setBusy(true);
    setInlineError(undefined);
    onError(undefined);
    try {
      const result = await window.kestrelDesktop.saveMcpServer(buildExaMcpMutationInput(exaServer));
      setMcpResult(result);
      onCapabilitiesChange(await window.kestrelDesktop.getCapabilities());
      onNotice("Exa was verified and connected through its hosted MCP server.");
    } catch (cause) {
      setInlineError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section tool-services-section" aria-labelledby="settings-tools_services-title" id="settings-tools_services">
      <div className="tool-services-shell">
        <div className="connector-directory">
          <div className="connector-directory-heading">
            <h2 id="settings-tools_services-title">Tools &amp; services</h2>
            <p>Configure the tools Kestrel can use.</p>
          </div>
          <div className="connector-list" role="list" aria-label="Prebuilt tool connectors">
            <ConnectorRow
              active={selectedId === "tools.internet.tavily"}
              description="Search, news, extraction, images, and research"
              icon={Globe2}
              name="Tavily"
              status={capabilityStatus(capabilities.find((capability) => capability.id === "tools.internet.tavily"))}
              onSelect={() => setSelectedId("tools.internet.tavily")}
            />
            <ConnectorRow
              active={selectedId === EXA_CONNECTOR_ID}
              description="Search, contents, code context, and research"
              icon={Globe2}
              name="Exa"
              status={exaConnected ? "Connected and verified" : "Not connected"}
              onSelect={() => setSelectedId(EXA_CONNECTOR_ID)}
            />
            {orderedCapabilities
              .filter((capability) => capability.id !== "tools.internet.tavily")
              .map((capability) => (
                <ConnectorRow
                  active={selectedId === capability.id}
                  description={capability.id === "tools.weather"
                    ? "Current conditions and forecasts"
                    : capability.description}
                  icon={capability.id === "tools.weather" ? CloudSun : Network}
                  key={capability.id}
                  name={toolServiceName(capability)}
                  status={capabilityStatus(capability)}
                  onSelect={() => setSelectedId(capability.id)}
                />
              ))}
          </div>
          <div className="connector-directory-footer">
            <strong>Need another connector?</strong>
            <p>Add and verify any compatible MCP server.</p>
            <button className="link-button" type="button" onClick={onOpenMcp}>Manage connectors</button>
          </div>
        </div>

        <div className="connector-setup" aria-live="polite">
          {selectedId === EXA_CONNECTOR_ID ? (
            <ExaSetup
              busy={busy}
              connected={exaConnected}
              error={inlineError}
              server={exaServer}
              onConnect={() => void connectExa()}
              onManage={onOpenMcp}
            />
          ) : selectedCapability !== undefined ? (
            <CapabilitySetup
              busy={busy}
              capability={selectedCapability}
              credential={credential}
              credentialStoreAvailable={credentialStoreAvailable}
              draft={draft}
              error={inlineError}
              onCredentialChange={setCredential}
              onDraftChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))}
              onSave={(enabled) => void configureCapability(selectedCapability, enabled)}
            />
          ) : (
            <div className="connector-setup-empty">Select a connector to review its setup.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function ConnectorRow({
  active,
  description,
  icon: Icon,
  name,
  status,
  onSelect,
}: {
  active: boolean;
  description: string;
  icon: typeof Globe2;
  name: string;
  status: string;
  onSelect: () => void;
}) {
  const ready = status === "Connected and verified" || status === "Ready";
  return (
    <div role="listitem">
      <button className={`connector-row ${active ? "active" : ""}`} type="button" onClick={onSelect}>
        <span className="connector-row-icon"><Icon size={20} aria-hidden="true" /></span>
        <span className="connector-row-copy">
          <strong>{name}</strong>
          <span className={`connector-row-status ${ready ? "ready" : ""}`}>
            {ready ? <CheckCircle2 size={13} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />}
            {status}
          </span>
          <small>{description}</small>
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function ExaSetup({
  busy,
  connected,
  error,
  server,
  onConnect,
  onManage,
}: {
  busy: boolean;
  connected: boolean;
  error?: string | undefined;
  server?: DesktopMcpServerConfig | undefined;
  onConnect: () => void;
  onManage: () => void;
}) {
  const tools = server?.tools?.map((tool) => tool.name) ?? [
    "Web and code search",
    "Page contents",
    "Company research",
    "Deep research",
  ];
  return (
    <>
      <header className="connector-setup-header">
        <span className="surface-kicker">Prebuilt connector</span>
        <h3>{connected ? "Exa" : "Connect Exa"}</h3>
        <p>Exa provides web, code, and research tools through its official hosted MCP server.</p>
      </header>
      <SetupStep number={1} title="Review the Exa connector">
        <p>Exa’s hosted connector is ready to use without installing a local package.</p>
        <button className="connector-external-link" type="button" onClick={() => void window.kestrelDesktop.openExternal(EXA_CONNECTOR_DOCS_URL)}>
          View Exa MCP details <ExternalLink size={13} aria-hidden="true" />
        </button>
      </SetupStep>
      <SetupStep number={2} title={connected ? "Connection verified" : "Connect the hosted server"}>
        <p>{connected
          ? `Verified ${server?.verifiedAt !== undefined ? new Date(server.verifiedAt).toLocaleString() : "by Local Core"}.`
          : "Kestrel will verify the endpoint and inspect its tool inventory before enabling it."}</p>
        <div className="connector-security-note">
          <LockKeyhole size={15} aria-hidden="true" />
          <span>No API key is required by Exa’s hosted MCP connector.</span>
        </div>
      </SetupStep>
      <SetupStep number={3} title="Use Exa in Kestrel">
        <p>{connected ? `${tools.length} tools are available with approval required by default.` : "Connecting enables these capabilities:"}</p>
        <ul className="connector-capability-list">
          {tools.slice(0, 6).map((tool) => <li key={tool}><CheckCircle2 size={14} aria-hidden="true" />{humanizeToolName(tool)}</li>)}
        </ul>
      </SetupStep>
      {error !== undefined ? <p className="connector-inline-error" role="alert">{error}</p> : null}
      <div className="connector-setup-actions">
        <button className="primary-button" type="button" disabled={busy} onClick={connected ? onManage : onConnect}>
          {busy ? "Verifying…" : connected ? "Manage Exa" : "Verify and connect"}
        </button>
      </div>
    </>
  );
}

function CapabilitySetup({
  busy,
  capability,
  credential,
  credentialStoreAvailable,
  draft,
  error,
  onCredentialChange,
  onDraftChange,
  onSave,
}: {
  busy: boolean;
  capability: DesktopCapability;
  credential: string;
  credentialStoreAvailable: boolean;
  draft: Record<string, string | boolean>;
  error?: string | undefined;
  onCredentialChange: (value: string) => void;
  onDraftChange: (key: string, value: string | boolean) => void;
  onSave: (enabled?: boolean) => void;
}) {
  if (capability.id === "tools.network.free") {
    return (
      <>
        <header className="connector-setup-header">
          <span className="surface-kicker">Built in</span>
          <h3>Free network tools</h3>
          <p>Time, geocoding, exchange-rate, and Hacker News tools that need no account.</p>
        </header>
        <SetupStep number={1} title="No account required"><p>These tools use public services and never ask for a credential.</p></SetupStep>
        <SetupStep number={2} title="Available at execution time"><p>Kestrel checks connectivity when a tool runs.</p></SetupStep>
        <SetupStep number={3} title="Choose availability"><p>{capability.enabled ? "This tool family is enabled." : "Enable this tool family for Kestrel conversations."}</p></SetupStep>
        {error !== undefined ? <p className="connector-inline-error" role="alert">{error}</p> : null}
        <div className="connector-setup-actions">
          <button className="primary-button" type="button" disabled={busy} onClick={() => onSave(!capability.enabled)}>
            {busy ? "Applying…" : capability.enabled ? "Disable tools" : "Enable tools"}
          </button>
        </div>
      </>
    );
  }

  const tavily = capability.id === "tools.internet.tavily";
  const credentialField = capability.settings.find((field) => field.secret);
  const credentialStored = capability.requirements.some((requirement) => requirement.kind === "credential" && requirement.satisfied);
  const name = toolServiceName(capability);
  return (
    <>
      <header className="connector-setup-header">
        <span className="surface-kicker">Prebuilt connector</span>
        <h3>{credentialStored ? name : `Connect ${name}`}</h3>
        <p>{capability.description}</p>
      </header>
      <SetupStep number={1} title={tavily ? "Create or find your Tavily API key" : "Optional provider fallback"}>
        <p>{tavily ? "You’ll need a Tavily API key to connect." : "Open-Meteo works without an account. Add Visual Crossing only when you want a verified fallback."}</p>
        {tavily ? (
          <button className="connector-external-link" type="button" onClick={() => void window.kestrelDesktop.openExternal(TAVILY_DOCS_URL)}>
            Get a Tavily API key <ExternalLink size={13} aria-hidden="true" />
          </button>
        ) : null}
      </SetupStep>
      <SetupStep number={2} title={credentialStored ? `Replace the stored ${name} key` : `Paste your ${name} API key`}>
        {credentialField !== undefined ? (
          <label className="connector-credential-field">
            <span>{credentialField.label}</span>
            <input
              type="password"
              autoComplete="off"
              value={credential}
              placeholder={credentialStored ? "Leave blank to keep the stored key" : "Enter API key"}
              onChange={(event) => onCredentialChange(event.target.value)}
            />
          </label>
        ) : null}
        <div className="connector-security-note">
          <KeyRound size={15} aria-hidden="true" />
          <span>{credentialStoreAvailable ? "Stored securely by Local Core and never returned to this screen." : "Secure credential storage is unavailable on this system."}</span>
        </div>
        {capability.settings.some((field) => field.secret === false) ? (
          <details className="connector-advanced-settings">
            <summary>Advanced settings</summary>
            <div>
              {capability.settings.filter((field) => field.secret === false).map((field) => (
                <label key={field.key}>
                  <span>{field.label}</span>
                  <input
                    type={field.kind === "url" ? "url" : "text"}
                    value={String(draft[field.key] ?? "")}
                    placeholder={field.placeholder}
                    onChange={(event) => onDraftChange(field.key, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </details>
        ) : null}
      </SetupStep>
      <SetupStep number={3} title="Verify and enable">
        <p>Kestrel verifies the proposed credential before replacing the last working configuration.</p>
        <ul className="connector-capability-list">
          {summarizeCapabilityNames(capability).map((entry) => <li key={entry}><CheckCircle2 size={14} aria-hidden="true" />{entry}</li>)}
        </ul>
      </SetupStep>
      {error !== undefined ? <p className="connector-inline-error" role="alert">{error}</p> : null}
      <div className="connector-setup-actions">
        <button
          className="primary-button"
          type="button"
          disabled={busy || (!credentialStored && credential.trim().length === 0)}
          onClick={() => onSave(capability.enabled || tavily ? undefined : true)}
        >
          {busy ? "Verifying…" : credentialStored ? "Verify and apply" : "Verify and connect"}
        </button>
      </div>
    </>
  );
}

function SetupStep({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <section className="connector-setup-step">
      <span className="connector-step-number" aria-hidden="true">{number}</span>
      <div><h4>{title}</h4>{children}</div>
    </section>
  );
}

export function buildExaMcpMutationInput(server?: DesktopMcpServerConfig | undefined): DesktopMcpServerMutationInput {
  return {
    id: EXA_CONNECTOR_ID,
    name: "Exa",
    transport: "http",
    url: EXA_CONNECTOR_URL,
    toolPolicies: server === undefined ? undefined : Object.fromEntries((server.tools ?? []).map((tool) => [tool.name, {
      approvalMode: tool.approvalMode ?? "ask",
      allowedInteractionModes: tool.allowedInteractionModes ?? ["build"],
    }])),
    enabled: true,
  };
}

function toolServiceName(capability: DesktopCapability): string {
  if (capability.id === "tools.internet.tavily") return "Tavily";
  if (capability.id === "tools.network.free") return "Free network tools";
  return capability.name;
}

function capabilityStatus(capability?: DesktopCapability | undefined): string {
  if (capability === undefined) return "Unavailable";
  if (capability.readiness === "ready" || capability.readiness === "optional") return "Ready";
  if (capability.readiness === "setup_required" || capability.readiness === "verification_failed") return "Not connected";
  if (capability.readiness === "disabled") return "Disabled";
  return "Unavailable";
}

function summarizeCapabilityNames(capability: DesktopCapability): string[] {
  if (capability.id === "tools.internet.tavily") return ["Search and news", "Extraction and crawling", "Images and research"];
  if (capability.id === "tools.weather") return ["Current conditions", "Forecasts"];
  return capability.toolNames.slice(0, 4).map(humanizeToolName);
}

function humanizeToolName(value: string): string {
  const name = value.split(".").at(-1) ?? value;
  return name.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
