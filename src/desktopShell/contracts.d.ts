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
export interface DesktopAgentStageConfig {
    modelByStage?: Record<string, string> | undefined;
}
export interface DesktopSettings {
    selectedProvider: DesktopModelProvider;
    databaseMode: DesktopDatabaseMode;
    presetId: DesktopShellPresetId;
    capabilityPacks: DesktopCapabilityPackId[];
    projects: DesktopProjectRegistration[];
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
    sourcePath?: string | undefined;
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
export type DesktopMicrophoneAccessState = "granted" | "denied" | "restricted" | "not-determined" | "unknown";
export interface DesktopMicrophoneAccess {
    state: DesktopMicrophoneAccessState;
    granted: boolean;
}
//# sourceMappingURL=contracts.d.ts.map
