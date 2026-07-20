export type DesktopRuntimeHealthState = "healthy" | "degraded" | "blocked";
export type DesktopDatabaseState = "starting" | "healthy" | "degraded" | "blocked";
export interface DesktopDatabaseStatus {
    state: DesktopDatabaseState;
    summary: string;
    managed: boolean;
    initialized: boolean;
    running: boolean;
    host?: string | undefined;
    port?: number | undefined;
    database?: string | undefined;
    logPath?: string | undefined;
    lastError?: {
        code: string;
        message: string;
        details?: Record<string, unknown> | undefined;
    } | undefined;
}
export interface DesktopRuntimeHealth {
    state: DesktopRuntimeHealthState;
    summary: string;
    code?: string | undefined;
    details?: string | undefined;
    running: boolean;
    logPath?: string | undefined;
    database?: DesktopDatabaseStatus | undefined;
}
export type DesktopBootPhase = "idle" | "starting_database" | "starting_runtime" | "starting_web" | "ready" | "failed";
export type DesktopReadinessItemId = "resources" | "settings" | "provider" | "database" | "runner" | "web" | "bridge" | "projects";
export type DesktopReadinessState = "ready" | "starting" | "degraded" | "blocked" | "unknown" | "not_applicable";
export interface DesktopReadinessAction {
    label: string;
    command: "open_settings" | "open_logs" | "restart_runtime" | "restart_database" | "repair_database" | "add_project" | "copy_help_packet" | "reinstall_desktop";
}
export interface DesktopReadinessItem {
    id: DesktopReadinessItemId;
    label: string;
    state: DesktopReadinessState;
    detail: string;
    evidence?: string | undefined;
    action?: DesktopReadinessAction | undefined;
}
export interface DesktopReadinessSummary {
    state: Exclude<DesktopReadinessState, "not_applicable">;
    title: string;
    detail: string;
}
export interface DesktopReadinessView {
    summary: DesktopReadinessSummary;
    items: DesktopReadinessItem[];
}
export interface DesktopBootEvent {
    at: string;
    phase: DesktopBootPhase;
    message: string;
}
export interface DesktopBootState {
    phase: DesktopBootPhase;
    message: string;
    code?: string | undefined;
    webUrl?: string | undefined;
    details?: string | undefined;
    database?: DesktopDatabaseStatus | undefined;
    readiness?: DesktopReadinessView | undefined;
    timeline?: DesktopBootEvent[] | undefined;
    startedAt?: string | undefined;
    updatedAt?: string | undefined;
}
export interface DesktopRuntimeStoreReset {
    storePath: string;
    archivedStorePath?: string | undefined;
    resetAt: string;
}
export interface DesktopProjectRegistration {
    path: string;
    label: string;
}
export type DesktopPackageManager = "npm" | "pnpm";
export interface DesktopProjectLauncherScript {
    name: string;
    command: string;
}
export interface DesktopProjectLauncherDescriptor {
    projectPath: string;
    manifestPath: string;
    scripts: DesktopProjectLauncherScript[];
    packageManager?: DesktopPackageManager | undefined;
    packageManagerSelectionRequired: boolean;
    unsupportedPackageManager?: string | undefined;
}
export type DesktopManagedProjectRunStatus = "running" | "stopping" | "completed" | "failed" | "stopped";
export interface DesktopManagedProjectRunPreviewUrl {
    url: string;
    source: "stdout" | "stderr";
    firstSeenAt: string;
    lastSeenAt: string;
    line: string;
    count: number;
}
export interface DesktopManagedProjectRun {
    runId: string;
    projectPath: string;
    manifestPath: string;
    scriptName: string;
    packageManager: DesktopPackageManager;
    command: string;
    status: DesktopManagedProjectRunStatus;
    startedAt: string;
    updatedAt: string;
    pendingAction?: "stop" | "restart" | undefined;
    completedAt?: string | undefined;
    exitCode?: number | undefined;
    stopSignal?: string | undefined;
    previewUrls?: DesktopManagedProjectRunPreviewUrl[] | undefined;
    primaryPreviewUrl?: string | undefined;
    stdoutTail: string[];
    stderrTail: string[];
}
export type DesktopModelProvider = "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio";
export type DesktopDatabaseMode = "default" | "external";
export type DesktopShellPresetId = "desktop_dev_local";
export type DesktopCapabilityPackId = "balanced" | "filesystem" | "dev_shell" | "sandbox_code";
export type DesktopCapabilityCategory = "models" | "tools_services" | "local_capabilities" | "connections" | "workspace_data" | "permissions";
export type DesktopCapabilityId = "model.openrouter" | "model.openai" | "model.anthropic" | "model.ollama" | "model.lmstudio" | "tools.internet.tavily" | "tools.weather" | "tools.network.free" | "local.filesystem" | "local.developer_shell" | "local.sandbox_code" | "connections.mcp" | "data.workspace" | "data.database" | "permission.microphone";
export type DesktopCapabilityReadiness = "ready" | "optional" | "setup_required" | "unavailable" | "verification_failed" | "disabled";
export type DesktopCapabilityRequirementKind = "credential" | "configuration" | "connectivity" | "local_prerequisite" | "permission";
export interface DesktopCapabilityRequirement {
    kind: DesktopCapabilityRequirementKind;
    label: string;
    satisfied: boolean;
    detail?: string | undefined;
}
export interface DesktopCapabilitySettingField {
    key: string;
    label: string;
    kind: "text" | "url" | "secret" | "boolean" | "select";
    required: boolean;
    secret: boolean;
    value?: string | boolean | undefined;
    placeholder?: string | undefined;
    options?: Array<{
        value: string;
        label: string;
    }> | undefined;
}
export interface DesktopCapability {
    id: DesktopCapabilityId;
    category: DesktopCapabilityCategory;
    name: string;
    description: string;
    toolNames: string[];
    enabled: boolean;
    readiness: DesktopCapabilityReadiness;
    detail: string;
    requirements: DesktopCapabilityRequirement[];
    settings: DesktopCapabilitySettingField[];
    verificationStrategy: string;
    runtimeApplication: string;
    settingsSection: string;
    lastVerifiedAt?: string | undefined;
}
export interface DesktopCapabilityView {
    capabilities: DesktopCapability[];
    credentialStore: {
        available: boolean;
        backend: DesktopCredentialBackend;
    };
    refreshedAt: string;
}
export type DesktopCredentialBackend = "macos_keychain" | "unavailable";
export type DesktopCapabilitySettingValue = string | boolean | null;
export interface DesktopCapabilityConfigurationInput {
    capabilityId: DesktopCapabilityId;
    enabled?: boolean | undefined;
    settings?: Record<string, DesktopCapabilitySettingValue> | undefined;
    credential?: string | null | undefined;
}
export interface DesktopCapabilityConfigurationResult {
    capabilityId: DesktopCapabilityId;
    applied: boolean;
    runtimeRestarted: boolean;
    view: DesktopCapabilityView;
}
export declare function parseDesktopCapabilityConfigurationInput(value: unknown): DesktopCapabilityConfigurationInput;
export interface DesktopAgentStageConfig {
    modelByStage?: Record<string, string> | undefined;
}
export interface DesktopSettings {
    selectedProvider: DesktopModelProvider;
    databaseMode: DesktopDatabaseMode;
    presetId: DesktopShellPresetId;
    capabilityPacks: DesktopCapabilityPackId[];
    projects: DesktopProjectRegistration[];
    mcpServers: DesktopMcpServerConfig[];
    capabilityVerifications: Partial<Record<DesktopCapabilityId, string>>;
    developerShellPath?: string | undefined;
    developerPath?: string | undefined;
    developerShellEnvMode: "inherit" | "allowlist";
    developerShellAllowedEnvNames: string[];
    approvalPolicyPackId: "dev" | "ci_bot" | "production";
    agentStageConfig?: DesktopAgentStageConfig | undefined;
    modelTimeoutMs?: number | undefined;
    databaseUrl?: string | undefined;
    openrouterApiKey?: string | undefined;
    openrouterModel?: string | undefined;
    openrouterBaseUrl?: string | undefined;
    openrouterSiteUrl?: string | undefined;
    openrouterAppName?: string | undefined;
    openaiApiKey?: string | undefined;
    openaiModel?: string | undefined;
    openaiBaseUrl?: string | undefined;
    openaiOrgId?: string | undefined;
    openaiProjectId?: string | undefined;
    anthropicApiKey?: string | undefined;
    anthropicModel?: string | undefined;
    anthropicBaseUrl?: string | undefined;
    anthropicVersion?: string | undefined;
    ollamaModel?: string | undefined;
    ollamaBaseUrl?: string | undefined;
    lmstudioModel?: string | undefined;
    lmstudioBaseUrl?: string | undefined;
    tavilyApiKey?: string | undefined;
    tavilyBaseUrl?: string | undefined;
    tavilyProject?: string | undefined;
    tavilyHttpProxy?: string | undefined;
    tavilyHttpsProxy?: string | undefined;
    providerSelectionCompletedAt?: string | undefined;
    setupCompletedAt?: string | undefined;
    advancedWorkspaceEnabled: boolean;
}
export type DesktopShellCommand = "add-project" | "new-thread" | "stop-agent" | "toggle-left-sidebar" | "toggle-right-sidebar" | "restart-runtime";
export type DesktopFileEntryKind = "file" | "directory";
export type DesktopFileViewKind = "markdown" | "code" | "text" | "binary";
export interface DesktopFileEntry {
    path: string;
    name: string;
    kind: DesktopFileEntryKind;
    modifiedAt?: string | undefined;
    sizeBytes?: number | undefined;
}
export interface DesktopDirectoryListing {
    rootPath: string;
    directoryPath: string;
    entries: DesktopFileEntry[];
}
export interface DesktopFileSearchResult {
    path: string;
    name: string;
    directoryPath: string;
}
export interface DesktopFileSearchResponse {
    rootPath: string;
    query: string;
    results: DesktopFileSearchResult[];
    truncated: boolean;
    fullSearchAvailable: boolean;
}
export interface DesktopFileContent {
    path: string;
    content: string;
    viewKind: DesktopFileViewKind;
    language?: string | undefined;
    contentHash?: string | undefined;
    modifiedAt?: string | undefined;
  sizeBytes?: number | undefined;
  lineEnding?: "lf" | "crlf" | "cr" | "mixed" | "none" | undefined;
  editable?: boolean | undefined;
  readOnlyReason?: "large_file" | "mixed_line_endings" | undefined;
}
export interface DesktopPathTargetInput {
    rootPath: string;
    targetPath: string;
}
export interface DesktopFileReadInput extends DesktopPathTargetInput {
}
export interface DesktopFileWriteInput extends DesktopPathTargetInput {
    content: string;
    expectedContentHash?: string | undefined;
    lineEnding?: "lf" | "crlf" | "cr" | "none" | undefined;
}
export interface DesktopOpenFileEditorInput {
    filePath: string;
    projectPath: string;
    projectLabel: string;
}
export interface DesktopProjectFilesChangedEvent {
    rootPath: string;
    eventType: "change" | "rename" | "unknown";
    observedAt: string;
    changedPath?: string | undefined;
}
export type DesktopMcpTransport = "stdio" | "http" | "sse";
export type DesktopMcpDiscoverySourceKind = "desktop-managed" | "config-file" | "docker-toolkit";
export interface DesktopMcpToolSummary {
    name: string;
    description?: string | undefined;
    approvalMode?: "auto" | "ask" | undefined;
    allowedInteractionModes?: ("chat" | "plan" | "build")[] | undefined;
}
export type DesktopMcpCredentialKind = "bearer" | "header" | "environment";
export interface DesktopMcpCredentialBinding {
    kind: DesktopMcpCredentialKind;
    name?: string | undefined;
    credentialId: `mcp.${string}`;
    envKey: string;
    configured: boolean;
}
export interface DesktopMcpCredentialMutationInput {
    kind: DesktopMcpCredentialKind;
    name?: string | undefined;
    credentialId?: `mcp.${string}` | undefined;
    envKey?: string | undefined;
    secret?: string | undefined;
}
export interface DesktopMcpServerConfig {
    id: string;
    name: string;
    transport: DesktopMcpTransport;
    command?: string | undefined;
    args?: string[] | undefined;
    env?: Record<string, string> | undefined;
    url?: string | undefined;
    workingDirectory?: string | undefined;
    enabled: boolean;
    source: string;
    sourceKind?: DesktopMcpDiscoverySourceKind | undefined;
    sourcePath?: string | undefined;
    toolCount?: number | undefined;
    tools?: DesktopMcpToolSummary[] | undefined;
    credentials?: DesktopMcpCredentialBinding[] | undefined;
    setupWarning?: string | undefined;
    verifiedAt?: string | undefined;
}
export interface DesktopMcpDiscoveryDiagnostic {
    source: string;
    path: string;
    status: "missing" | "read" | "invalid" | "error";
    message?: string | undefined;
}
export interface DesktopMcpDiscoveryResult {
    servers: DesktopMcpServerConfig[];
    diagnostics: DesktopMcpDiscoveryDiagnostic[];
    discoveredAt: string;
}
export interface DesktopMcpServerMutationInput {
    id: string;
    name: string;
    transport: DesktopMcpTransport;
    command?: string | undefined;
    args?: string[] | undefined;
    url?: string | undefined;
    credentials?: DesktopMcpCredentialMutationInput[] | undefined;
    toolPolicies?: Record<string, {
        approvalMode: "auto" | "ask";
        allowedInteractionModes: ("chat" | "plan" | "build")[];
    }> | undefined;
    enabled: boolean;
}
export declare function parseDesktopMcpServerMutationInput(value: unknown): DesktopMcpServerMutationInput;
export type DesktopMicrophoneAccessState = "granted" | "denied" | "restricted" | "not-determined" | "unknown";
export interface DesktopMicrophoneAccess {
    state: DesktopMicrophoneAccessState;
    granted: boolean;
}
//# sourceMappingURL=contracts.d.ts.map
