import type { LocalCoreCredentialStoreStatus } from "../localCore/credentialStore.js";
import type { LocalCoreCredentialId } from "../localCore/credentialStore.js";
import { DEFAULT_MODEL_BY_PROVIDER } from "../profile/modelDefaults.js";
import type { ModelProviderId } from "../profile/runtimeProfile.js";
import type {
  DesktopCapability,
  DesktopCapabilityId,
  DesktopCapabilityReadiness,
  DesktopCapabilityView,
  DesktopMcpServerConfig,
  DesktopMicrophoneAccessState,
  DesktopSettings,
} from "./contracts.js";

export interface DesktopCapabilityProbeResults {
  filesystemAccessible: boolean;
  shellAvailable: boolean;
  shellPath?: string | undefined;
  executablePath?: string | undefined;
  languageRuntimes: { name: string; available: boolean }[];
  packageManagers: { name: string; available: boolean }[];
  dockerInstalled: boolean;
  dockerDaemonReachable: boolean;
  dockerImages: { name: string; available: boolean }[];
  databaseReady: boolean;
  microphone: DesktopMicrophoneAccessState;
  mcpServers: DesktopMcpServerConfig[];
  localModelProviders: Record<"ollama" | "lmstudio", boolean>;
}

export interface ResolveDesktopCapabilityViewInput {
  settings: DesktopSettings;
  credentials: LocalCoreCredentialStoreStatus;
  probes: DesktopCapabilityProbeResults;
  now?: Date | undefined;
}

export interface DesktopCapabilityRegistration {
  id: DesktopCapabilityId;
  settingKeys: readonly string[];
  credentialId?: LocalCoreCredentialId | undefined;
  modelProvider?: ModelProviderId | undefined;
  capabilityPack?: "balanced" | "filesystem" | "dev_shell" | "sandbox_code" | undefined;
  verification: "hosted_model" | "local_model" | "tavily" | "visual_crossing" | "external_database" | "none";
  restartRuntime: boolean;
}

export const DESKTOP_CAPABILITY_REGISTRATIONS: readonly DesktopCapabilityRegistration[] = Object.freeze([
  registration("model.openrouter", ["model", "baseUrl", "siteUrl", "appName"], "hosted_model", {
    credentialId: "provider.openrouter.default", modelProvider: "openrouter",
  }),
  registration("model.openai", ["model", "baseUrl", "organizationId", "projectId"], "hosted_model", {
    credentialId: "provider.openai.default", modelProvider: "openai",
  }),
  registration("model.anthropic", ["model", "baseUrl", "apiVersion"], "hosted_model", {
    credentialId: "provider.anthropic.default", modelProvider: "anthropic",
  }),
  registration("model.ollama", ["model", "baseUrl"], "local_model", { modelProvider: "ollama" }),
  registration("model.lmstudio", ["model", "baseUrl"], "local_model", { modelProvider: "lmstudio" }),
  registration("tools.internet.tavily", ["baseUrl", "projectId", "httpProxy", "httpsProxy"], "tavily", {
    credentialId: "tool.tavily.default", capabilityPack: "balanced",
  }),
  registration("tools.weather", [], "visual_crossing", {
    credentialId: "tool.visual-crossing.default", capabilityPack: "balanced",
  }),
  registration("tools.network.free", [], "none", { capabilityPack: "balanced" }),
  registration("local.filesystem", [], "none", { capabilityPack: "filesystem" }),
  registration("local.developer_shell", ["shellPath", "path", "envMode", "allowedEnvNames", "approvalPolicy"], "none", { capabilityPack: "dev_shell" }),
  registration("local.sandbox_code", [], "none", { capabilityPack: "sandbox_code" }),
  registration("connections.mcp", [], "none", {}, false),
  registration("data.workspace", [], "none", {}, false),
  registration("data.database", ["mode"], "external_database", {
    credentialId: "data.database.external",
  }, true),
  registration("permission.microphone", [], "none", {}, false),
]);

export function getDesktopCapabilityRegistration(
  id: DesktopCapabilityId,
): DesktopCapabilityRegistration {
  const registration = DESKTOP_CAPABILITY_REGISTRATIONS.find((entry) => entry.id === id);
  if (registration === undefined) {
    throw new Error(`Desktop capability '${id}' is not registered.`);
  }
  return registration;
}

const TAVILY_TOOLS = [
  "internet.search",
  "internet.search_advanced",
  "internet.news",
  "internet.images",
  "internet.extract",
  "internet.crawl",
  "internet.map",
  "internet.research",
  "internet.research_status",
  "internet.usage",
];

const FREE_NETWORK_TOOLS = [
  "time.current",
  "time.convert",
  "geo.geocode",
  "finance.exchange_rates",
];

const FILESYSTEM_TOOLS = [
  "fs.list_directory",
  "fs.read_text",
  "fs.search_text",
  "artifact.read",
];

const MODEL_CAPABILITIES = [
  {
    id: "model.openrouter" as const,
    provider: "openrouter" as const,
    name: "OpenRouter",
    description: "Hosted access to models available through OpenRouter.",
    credentialId: "provider.openrouter.default" as const,
    fields: [
      field("model", "Model", "text", true, false, "z-ai/glm-5.2"),
      field("apiKey", "API key", "secret", true, true),
      field("baseUrl", "Base URL", "url", false, false, "https://openrouter.ai"),
      field("siteUrl", "Site URL", "url", false, false),
      field("appName", "Application name", "text", false, false),
    ],
  },
  {
    id: "model.openai" as const,
    provider: "openai" as const,
    name: "OpenAI",
    description: "Hosted access to OpenAI models.",
    credentialId: "provider.openai.default" as const,
    fields: [
      field("model", "Model", "text", true, false),
      field("apiKey", "API key", "secret", true, true),
      field("baseUrl", "Base URL", "url", false, false, "https://api.openai.com"),
      field("organizationId", "Organization ID", "text", false, false),
      field("projectId", "Project ID", "text", false, false),
    ],
  },
  {
    id: "model.anthropic" as const,
    provider: "anthropic" as const,
    name: "Anthropic",
    description: "Hosted access to Anthropic models.",
    credentialId: "provider.anthropic.default" as const,
    fields: [
      field("model", "Model", "text", true, false),
      field("apiKey", "API key", "secret", true, true),
      field("baseUrl", "Base URL", "url", false, false, "https://api.anthropic.com"),
      field("apiVersion", "API version", "text", false, false),
    ],
  },
  {
    id: "model.ollama" as const,
    provider: "ollama" as const,
    name: "Ollama",
    description: "Models served by a local Ollama installation.",
    fields: [
      field("model", "Model", "text", true, false),
      field("baseUrl", "Base URL", "url", true, false, "http://127.0.0.1:11434"),
    ],
  },
  {
    id: "model.lmstudio" as const,
    provider: "lmstudio" as const,
    name: "LM Studio",
    description: "Models served by a local LM Studio endpoint.",
    fields: [
      field("model", "Model", "text", true, false),
      field("baseUrl", "Base URL", "url", true, false, "http://127.0.0.1:1234"),
    ],
  },
] as const;

export function resolveDesktopCapabilityView(
  input: ResolveDesktopCapabilityViewInput,
): DesktopCapabilityView {
  const configured = new Map(
    input.credentials.credentials.map((credential) => [credential.id, credential.configured]),
  );
  const settings = input.settings;
  const capabilities: DesktopCapability[] = MODEL_CAPABILITIES.map((definition) => {
    const enabled = settings.selectedProvider === definition.provider;
    const credentialRequired = "credentialId" in definition;
    const credentialConfigured = credentialRequired
      ? configured.get(definition.credentialId) === true
      : true;
    const readiness: DesktopCapabilityReadiness = enabled === false
      ? "disabled"
      : credentialConfigured === false
        ? input.credentials.available ? "setup_required" : "unavailable"
        : definition.provider === "ollama" || definition.provider === "lmstudio"
          ? input.probes.localModelProviders[definition.provider] ? "ready" : "setup_required"
          : "ready";
    return {
      id: definition.id,
      category: "models",
      name: definition.name,
      description: definition.description,
      toolNames: [],
      enabled,
      readiness,
      detail: modelReadinessDetail(readiness, definition.name, credentialRequired),
      requirements: [
        ...(credentialRequired ? [{
          kind: "credential" as const,
          label: `${definition.name} API key`,
          satisfied: credentialConfigured,
          detail: credentialConfigured ? "Stored by Local Core." : "Save and verify a key in Desktop.",
        }] : []),
        ...(definition.provider === "ollama" || definition.provider === "lmstudio" ? [{
          kind: "connectivity" as const,
          label: "Local provider endpoint",
          satisfied: input.probes.localModelProviders[definition.provider],
          detail: input.probes.localModelProviders[definition.provider]
            ? "Endpoint is reachable and the configured model is available."
            : "Connectivity and model availability must be verified before use.",
        }] : []),
      ],
      settings: definition.fields.map((entry) => ({
        ...entry,
        ...modelFieldValue(definition.provider, entry.key, settings),
      })),
      verificationStrategy: credentialRequired
        ? "Verify the proposed credential and endpoint before replacing the authoritative credential."
        : "Connect to the local endpoint and confirm the configured model is available.",
      runtimeApplication: "Apply to Local Core, refresh the effective Desktop runtime profile, and restart the runner automatically when required.",
      settingsSection: `settings/models/${definition.provider}`,
    };
  });

  const tavilyConfigured = configured.get("tool.tavily.default") === true;
  capabilities.push({
    id: "tools.internet.tavily",
    category: "tools_services",
    name: "Internet tools",
    description: "Search, news, extraction, crawling, mapping, images, and research powered by Tavily.",
    toolNames: [...TAVILY_TOOLS],
    enabled: settings.capabilityPacks.includes("balanced"),
    readiness: settings.capabilityPacks.includes("balanced") === false
      ? "disabled"
      : tavilyConfigured ? "ready" : input.credentials.available ? "setup_required" : "unavailable",
    detail: tavilyConfigured
      ? "Tavily credential is stored; the internet tool family is configured."
      : "A Tavily API key must be saved and verified before these tools are selected.",
    requirements: [{
      kind: "credential",
      label: "Tavily API key",
      satisfied: tavilyConfigured,
    }, {
      kind: "connectivity",
      label: "Internet connectivity",
      satisfied: true,
      detail: "Required at execution time.",
    }],
    settings: [
      field("apiKey", "API key", "secret", true, true),
      withFieldValue(field("baseUrl", "Base URL", "url", false, false), settings.tavilyBaseUrl),
      withFieldValue(field("projectId", "Project ID", "text", false, false), settings.tavilyProject),
      withFieldValue(field("httpProxy", "HTTP proxy", "url", false, false), settings.tavilyHttpProxy),
      withFieldValue(field("httpsProxy", "HTTPS proxy", "url", false, false), settings.tavilyHttpsProxy),
    ],
    verificationStrategy: "Verify the proposed credential with Tavily before replacing the authoritative credential.",
    runtimeApplication: "Refresh Local Core provider configuration and restart the runner automatically.",
    settingsSection: "settings/tools-services/internet",
  });

  const visualCrossingConfigured = configured.get("tool.visual-crossing.default") === true;
  capabilities.push({
    id: "tools.weather",
    category: "tools_services",
    name: "Weather",
    description: "Open-Meteo weather with optional Visual Crossing failover.",
    toolNames: ["weather.current", "weather.forecast"],
    enabled: settings.capabilityPacks.includes("balanced"),
    readiness: settings.capabilityPacks.includes("balanced") ? (visualCrossingConfigured ? "ready" : "optional") : "disabled",
    detail: visualCrossingConfigured
      ? "Open-Meteo and the verified Visual Crossing fallback are available."
      : "Open-Meteo is ready without credentials; Visual Crossing is optional.",
    requirements: [{ kind: "connectivity", label: "Internet connectivity", satisfied: true }, {
      kind: "credential",
      label: "Visual Crossing API key (optional)",
      satisfied: visualCrossingConfigured,
    }],
    settings: [field("visualCrossingApiKey", "Visual Crossing API key", "secret", false, true)],
    verificationStrategy: "Verify a proposed Visual Crossing key before replacing the last working key.",
    runtimeApplication: "Refresh Local Core provider configuration and restart the runner automatically.",
    settingsSection: "settings/tools-services/weather",
  });

  capabilities.push(
    simpleCapability({
      id: "tools.network.free", category: "tools_services", name: "Free network tools",
      description: "Time, geocoding, and exchange-rate tools that need connectivity but no account.",
      toolNames: FREE_NETWORK_TOOLS, enabled: settings.capabilityPacks.includes("balanced"),
      readiness: settings.capabilityPacks.includes("balanced") ? "ready" : "disabled",
      detail: "No credential is required. Internet connectivity is required at execution time.",
      requirementKind: "connectivity", requirementLabel: "Internet connectivity",
      verificationStrategy: "Perform a bounded service request when the capability is used.",
      settingsSection: "settings/tools-services/free-network",
    }),
    simpleCapability({
      id: "local.filesystem", category: "local_capabilities", name: "Filesystem",
      description: "Read and search files within registered project boundaries.", toolNames: FILESYSTEM_TOOLS,
      enabled: settings.capabilityPacks.includes("filesystem"),
      readiness: settings.capabilityPacks.includes("filesystem") === false ? "disabled" : input.probes.filesystemAccessible ? "ready" : "setup_required",
      detail: input.probes.filesystemAccessible ? "At least one registered project is accessible." : "Add an accessible project before using filesystem tools.",
      requirementKind: "local_prerequisite", requirementLabel: "Accessible registered project",
      requirementSatisfied: input.probes.filesystemAccessible,
      verificationStrategy: "Validate registered project paths and access before assembling filesystem tools.",
      settingsSection: "settings/local-capabilities/filesystem",
    }),
    simpleCapability({
      id: "local.developer_shell", category: "local_capabilities", name: "Developer shell",
      description: "Run approved commands using the host shell and local developer tools.", toolNames: ["devshell.exec", "devshell.write_stdin"],
      enabled: settings.capabilityPacks.includes("dev_shell"),
      readiness: settings.capabilityPacks.includes("dev_shell") === false ? "disabled" : input.probes.shellAvailable ? "ready" : "unavailable",
      detail: input.probes.shellAvailable
        ? `Shell ${input.probes.shellPath ?? "available"}; ${input.probes.languageRuntimes.filter((entry) => entry.available).map((entry) => entry.name).join(", ") || "no language runtimes"}; ${input.probes.packageManagers.filter((entry) => entry.available).map((entry) => entry.name).join(", ") || "no package managers"}. Approval policy: ${settings.approvalPolicyPackId}.`
        : "No accessible host shell was found. Configure an executable shell path and PATH.",
      requirementKind: "local_prerequisite", requirementLabel: "Accessible host shell", requirementSatisfied: input.probes.shellAvailable,
      verificationStrategy: "Resolve and access-check the configured host shell before runtime assembly.",
      settingsSection: "settings/local-capabilities/developer-shell",
      settings: [
        withFieldValue(field("shellPath", "Host shell", "text", false, false, "/bin/zsh"), settings.developerShellPath),
        withFieldValue(field("path", "Executable PATH", "text", false, false, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"), settings.developerPath),
        { ...field("envMode", "Environment policy", "select", true, false), value: settings.developerShellEnvMode, options: [{ value: "inherit", label: "Inherit host environment" }, { value: "allowlist", label: "Allow listed variables only" }] },
        withFieldValue(field("allowedEnvNames", "Allowed environment names", "text", false, false, "CI, NODE_ENV"), settings.developerShellAllowedEnvNames.join(", ")),
        { ...field("approvalPolicy", "Command approval policy", "select", true, false), value: settings.approvalPolicyPackId, options: [{ value: "dev", label: "Developer" }, { value: "production", label: "Production" }, { value: "ci_bot", label: "CI bot" }] },
      ],
    }),
    simpleCapability({
      id: "local.sandbox_code", category: "local_capabilities", name: "Sandboxed code execution",
      description: "Execute code in an isolated Docker-backed sandbox.", toolNames: ["code.execute"],
      enabled: settings.capabilityPacks.includes("sandbox_code"),
      readiness: settings.capabilityPacks.includes("sandbox_code") === false ? "disabled" : input.probes.dockerDaemonReachable ? "ready" : "setup_required",
      detail: input.probes.dockerDaemonReachable
        ? `Docker CLI and daemon are reachable. Sandbox images: ${input.probes.dockerImages.filter((image) => image.available).length}/${input.probes.dockerImages.length} available; missing images are pulled on first approved execution.`
        : input.probes.dockerInstalled ? "Docker is installed, but its daemon is not reachable. Start Docker Desktop and refresh readiness." : "Docker is not installed or is not on PATH. Install Docker Desktop, start it, then refresh readiness.",
      requirementKind: "local_prerequisite", requirementLabel: "Docker CLI and reachable daemon", requirementSatisfied: input.probes.dockerDaemonReachable,
      verificationStrategy: "Check the Docker CLI, daemon, and execution prerequisites before exposing code.execute.",
      settingsSection: "settings/local-capabilities/sandbox-code",
    }),
  );

  const activeMcp = input.probes.mcpServers.filter(
    (server) => server.enabled && server.sourceKind === "desktop-managed",
  );
  const discoveredMcp = input.probes.mcpServers.filter(
    (server) => server.sourceKind !== "desktop-managed",
  );
  capabilities.push(simpleCapability({
    id: "connections.mcp", category: "connections", name: "Apps",
    description: "Additional Apps connected locally or through a hosted service.",
    toolNames: activeMcp.flatMap((server) => server.tools?.map((tool) => tool.name) ?? []),
    enabled: activeMcp.length > 0,
    readiness: activeMcp.length > 0 ? "ready" : discoveredMcp.length > 0 ? "setup_required" : "disabled",
    detail: activeMcp.length > 0
      ? `${activeMcp.length} verified App${activeMcp.length === 1 ? " is" : "s are"} active for Desktop conversations.`
      : discoveredMcp.length > 0
        ? `${discoveredMcp.length} App${discoveredMcp.length === 1 ? " is" : "s are"} available to import and verify.`
        : "No custom Apps are active for Desktop conversations.",
    requirementKind: "configuration", requirementLabel: "Enabled and verified Custom App",
    requirementSatisfied: activeMcp.length > 0,
    verificationStrategy: "Connect, inspect capabilities, and preserve approval policy before activating an App.",
    settingsSection: "settings/connections/mcp",
  }));

  capabilities.push(
    simpleCapability({
      id: "data.workspace", category: "workspace_data", name: "Workspace and projects",
      description: "Registered project roots and package-manager preferences.", toolNames: [], enabled: true,
      readiness: input.probes.filesystemAccessible ? "ready" : "setup_required",
      detail: input.probes.filesystemAccessible ? `${settings.projects.length} project${settings.projects.length === 1 ? "" : "s"} registered.` : "Register an accessible project.",
      requirementKind: "configuration", requirementLabel: "Registered project", requirementSatisfied: input.probes.filesystemAccessible,
      verificationStrategy: "Resolve paths, validate access, and enforce project boundaries.", settingsSection: "settings/workspace-data/projects",
    }),
    {
      id: "data.database", category: "workspace_data", name: "Runtime database",
      description: "Local Core managed storage for Desktop runtime data.", toolNames: [], enabled: true,
      readiness: input.probes.databaseReady ? "ready" : "setup_required",
      detail: input.probes.databaseReady
        ? settings.databaseMode === "external" ? "External PostgreSQL is verified and active." : "Managed local database is ready."
        : settings.databaseMode === "external" ? "Enter and verify the external PostgreSQL connection URL." : "Managed local database requires attention.",
      requirements: [{
        kind: "configuration", label: settings.databaseMode === "external" ? "Validated external PostgreSQL" : "Validated managed database",
        satisfied: input.probes.databaseReady,
      }, ...(settings.databaseMode === "external" ? [{
        kind: "credential" as const,
        label: "External database connection URL",
        satisfied: configured.get("data.database.external") === true,
      }] : [])],
      settings: [{
        key: "mode", label: "Storage mode", kind: "select", required: true, secret: false,
        value: settings.databaseMode,
        options: [
          { value: "default", label: "Managed local storage" },
          { value: "external", label: "External PostgreSQL" },
        ],
      }, field("connectionUrl", "PostgreSQL connection URL", "secret", settings.databaseMode === "external", true, "postgresql://…")],
      verificationStrategy: "Connect to PostgreSQL, validate the runtime schema boundary, then store the URL in Keychain before switching Local Core.",
      runtimeApplication: "Apply through Local Core and restart the effective Desktop runtime automatically.",
      settingsSection: "settings/workspace-data/database",
    },
    simpleCapability({
      id: "permission.microphone", category: "permissions", name: "Microphone",
      description: "macOS microphone access for voice-capable Desktop features.", toolNames: [], enabled: input.probes.microphone === "granted",
      readiness: input.probes.microphone === "granted" ? "ready" : input.probes.microphone === "not-determined" ? "setup_required" : "unavailable",
      detail: `Operating-system permission is ${input.probes.microphone}.`,
      requirementKind: "permission", requirementLabel: "Microphone permission", requirementSatisfied: input.probes.microphone === "granted",
      verificationStrategy: "Read the operating-system permission state and offer the native request or recovery path.", settingsSection: "settings/permissions/microphone",
    }),
  );

  return {
    capabilities: capabilities.map((capability) => ({
      ...capability,
      ...(settings.capabilityVerifications[capability.id] !== undefined
        ? { lastVerifiedAt: settings.capabilityVerifications[capability.id] }
        : {}),
    })),
    credentialStore: {
      available: input.credentials.available,
      backend: input.credentials.backend === "macos_keychain" ? "macos_keychain" : "unavailable",
    },
    refreshedAt: (input.now ?? new Date()).toISOString(),
  };
}

function field(
  key: string,
  label: string,
  kind: "text" | "url" | "secret" | "boolean" | "select",
  required: boolean,
  secret: boolean,
  placeholder?: string,
) {
  return { key, label, kind, required, secret, ...(placeholder !== undefined ? { placeholder } : {}) };
}

function withFieldValue<T extends ReturnType<typeof field>>(
  input: T,
  value: string | undefined,
): T & { value?: string | undefined } {
  return { ...input, ...(value !== undefined ? { value } : {}) };
}

function modelFieldValue(
  provider: ModelProviderId,
  key: string,
  settings: DesktopSettings,
): { value?: string | undefined } {
  const values: Record<ModelProviderId, Record<string, string | undefined>> = {
    openrouter: {
      model: settings.openrouterModel,
      baseUrl: settings.openrouterBaseUrl,
      siteUrl: settings.openrouterSiteUrl,
      appName: settings.openrouterAppName,
    },
    openai: {
      model: settings.openaiModel,
      baseUrl: settings.openaiBaseUrl,
      organizationId: settings.openaiOrgId,
      projectId: settings.openaiProjectId,
    },
    anthropic: {
      model: settings.anthropicModel,
      baseUrl: settings.anthropicBaseUrl,
      apiVersion: settings.anthropicVersion,
    },
    ollama: { model: settings.ollamaModel, baseUrl: settings.ollamaBaseUrl },
    lmstudio: { model: settings.lmstudioModel, baseUrl: settings.lmstudioBaseUrl },
  };
  const value = values[provider][key] ?? (key === "model" ? DEFAULT_MODEL_BY_PROVIDER[provider] : undefined);
  return value !== undefined ? { value } : {};
}

function registration(
  id: DesktopCapabilityId,
  settingKeys: readonly string[],
  verification: DesktopCapabilityRegistration["verification"],
  options: Pick<DesktopCapabilityRegistration, "credentialId" | "modelProvider" | "capabilityPack">,
  restartRuntime = true,
): DesktopCapabilityRegistration {
  return Object.freeze({ id, settingKeys: Object.freeze([...settingKeys]), verification, restartRuntime, ...options });
}

function modelReadinessDetail(
  readiness: DesktopCapabilityReadiness,
  name: string,
  credentialRequired: boolean,
): string {
  if (readiness === "disabled") return `${name} is not the active model provider.`;
  if (readiness === "ready") {
    return credentialRequired
      ? `${name} credential is stored. Verify connectivity before a new credential replaces it.`
      : `${name} is reachable and the configured model is available.`;
  }
  if (readiness === "unavailable") return "Secure credential storage is unavailable.";
  return readiness === "setup_required"
    ? `${name} requires setup or connectivity verification.`
    : `${name} verification failed.`;
}

function simpleCapability(input: {
  id: DesktopCapabilityId;
  category: DesktopCapability["category"];
  name: string;
  description: string;
  toolNames: string[];
  enabled: boolean;
  readiness: DesktopCapabilityReadiness;
  detail: string;
  requirementKind: DesktopCapability["requirements"][number]["kind"];
  requirementLabel: string;
  requirementSatisfied?: boolean | undefined;
  verificationStrategy: string;
  settingsSection: string;
  settings?: DesktopCapability["settings"] | undefined;
}): DesktopCapability {
  return {
    id: input.id,
    category: input.category,
    name: input.name,
    description: input.description,
    toolNames: [...input.toolNames],
    enabled: input.enabled,
    readiness: input.readiness,
    detail: input.detail,
    requirements: [{
      kind: input.requirementKind,
      label: input.requirementLabel,
      satisfied: input.requirementSatisfied ?? input.readiness === "ready",
    }],
    settings: input.settings ?? [],
    verificationStrategy: input.verificationStrategy,
    runtimeApplication: "Apply through Local Core and refresh the effective Desktop runtime automatically.",
    settingsSection: input.settingsSection,
  };
}
