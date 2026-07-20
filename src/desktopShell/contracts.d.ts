import type { RunnerEvent } from "../../cli/protocol/contracts.js";
import type { RunnerAssistantTextHistoryDataV2, RunnerWaitingPromptHistoryDataV2 } from "@kestrel-agents/protocol";
import type { TaskAction } from "../missionControl/contracts.js";
import type { ProductProjectBoardAction, ProductProjectSnapshot } from "../project/contracts.js";
export type DesktopRuntimeHealthState = "healthy" | "degraded" | "blocked";
export type DesktopDatabaseState = "starting" | "healthy" | "degraded" | "blocked";
export type { SupportBundle as DesktopSupportBundle } from "../diagnostics/supportBundle.js";
export type DesktopBridgeCapabilityId = "app_info" | "settings" | "provider_credentials" | "ui_state" | "runner_commands" | "support_bundle" | "project_picker" | "workspace_picker" | "runtime_control" | "database_control" | "file_browser" | "file_editor" | "file_write" | "file_watch" | "mcp_discovery" | "project_launcher" | "project_runs" | "project_run_preview" | "mission_control" | "runtime_inspection" | "attachments" | "operator_control" | "external_open" | "path_open" | "microphone" | "commands";
export interface DesktopBridgeInfo {
    connected: boolean;
    version: string;
    capabilities: DesktopBridgeCapabilityId[];
}
export declare const DESKTOP_BRIDGE_VERSION = "4";
export declare const DESKTOP_BRIDGE_CAPABILITIES: DesktopBridgeCapabilityId[];
export declare const DESKTOP_UI_STATE_VERSION: "desktop-ui-state-v1";
export declare const DESKTOP_UI_STATE_SOURCE: "legacy-local-storage";
export declare const DESKTOP_UI_STATE_RENDERER_SOURCE: "vite-renderer";
export declare const DESKTOP_UI_STATE_MAX_BYTES: number;
export declare const DESKTOP_LEGACY_UI_STORAGE_KEYS: readonly ["kchat:web:composer-drafts:v1", "kchat:web:prompt-history:v1", "kestrel:desktop-interaction-state:v1", "kchat:web:theme-mode", "kchat:web:task-graph:v1", "kchat:web:threads:v2", "kchat:web:active-thread:v1", "kestrel:desktop-workspace:v5", "kestrel:desktop-workspace:v4", "kestrel:desktop-workspace:v3", "kestrel:desktop-workspace:v2", "kestrel.desktop.rail.v2", "kestrel.missionControl.taskQueue"];
export type DesktopLegacyUiStorageKey = typeof DESKTOP_LEGACY_UI_STORAGE_KEYS[number];
export type DesktopLegacyUiStateEntries = Partial<Record<DesktopLegacyUiStorageKey, string>>;
export interface DesktopUiStateV1 {
    version: typeof DESKTOP_UI_STATE_VERSION;
    source: typeof DESKTOP_UI_STATE_SOURCE | typeof DESKTOP_UI_STATE_RENDERER_SOURCE;
    sourceAppVersion: string;
    capturedAt: string;
    entries: DesktopLegacyUiStateEntries;
}
export interface DesktopUiStateSyncResult {
    state: DesktopUiStateV1;
    updated: boolean;
}
interface DesktopRunHistoryLineBase {
    text: string;
    timestamp: string;
}
export type DesktopRunHistoryLine = DesktopRunHistoryLineBase & ({
    role: "user";
    data?: undefined;
} | {
    role: "assistant";
    data?: RunnerAssistantTextHistoryDataV2 | undefined;
} | {
    role: "system";
    data: RunnerWaitingPromptHistoryDataV2;
});
export interface DesktopRunTurnRequest {
    sessionId: string;
    threadId?: string | undefined;
    message: string;
    eventType: string;
    projectPath?: string | undefined;
    history?: DesktopRunHistoryLine[] | undefined;
    interactionMode?: "chat" | "plan" | "build" | undefined;
    actSubmode?: "strict" | "safe" | "full_auto" | undefined;
    resumeFromWait?: boolean | undefined;
    resumeBlockedRun?: boolean | undefined;
    attachmentIds?: string[] | undefined;
}
export interface DesktopAttachmentMetadata {
    attachmentId: string;
    threadId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    kind: "image" | "text";
    createdAt: string;
    submittedAt?: string | undefined;
}
export interface DesktopOperatorInboxItem {
    itemId: string;
    kind: "approval_request" | "user_input_request" | "context_checkpoint" | "child_thread_blocker" | "stalled_thread_attention" | "assembly_change_proposal" | "compatibility_downgrade_attention" | "fan_in_checkpoint" | "child_outcome_review";
    threadId: string;
    sessionId: string;
    title: string;
    actionable: boolean;
    createdAt: string;
    requestId?: string | undefined;
    checkpointId?: string | undefined;
    delegationId?: string | undefined;
    childThreadId?: string | undefined;
    recommendedAction?: string | undefined;
    detail?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
}
export interface DesktopFollowUpQueueEntry {
    followUpId: string;
    message: string;
    attachmentIds: string[];
    interactionMode?: "chat" | "plan" | "build" | undefined;
    actSubmode?: "strict" | "safe" | "full_auto" | undefined;
    createdAt: string;
    state: "queued" | "starting";
}
export interface DesktopOperatorControlRequest {
    action: "approve" | "reject" | "reply" | "steer" | "retry" | "continue_waiting" | "focus_thread" | "resolve_context_checkpoint" | "approve_assembly_change" | "reject_assembly_change" | "supersede_child_thread" | "resolve_fan_in_checkpoint" | "enqueue_follow_up" | "edit_follow_up" | "cancel_follow_up" | "resume_follow_up_queue";
    threadId: string;
    followUpId?: string | undefined;
    requestId?: string | undefined;
    proposalId?: string | undefined;
    checkpointId?: string | undefined;
    delegationId?: string | undefined;
    actionValue?: "continue" | "compact" | "summarize_forward" | "handoff" | "split_into_child_thread" | "operator_checkpoint" | "accept" | "defer" | undefined;
    message?: string | undefined;
    attachmentIds?: string[] | undefined;
    interactionMode?: "chat" | "plan" | "build" | undefined;
    actSubmode?: "strict" | "safe" | "full_auto" | undefined;
}
export declare function parseDesktopOperatorControlRequest(value: unknown): DesktopOperatorControlRequest;
export interface DesktopRunCancelRequest {
    sessionId: string;
    runId?: string | undefined;
    commandId?: string | undefined;
}
export type DesktopProjectAction = TaskAction | ProductProjectBoardAction;
export interface DesktopProjectSnapshotResponse {
    sessionId: string;
    snapshot: ProductProjectSnapshot;
}
export type DesktopRuntimeThreadStatus = "IDLE" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
export interface DesktopRuntimeThreadSummary {
    threadId: string;
    sessionId: string;
    title: string;
    status: DesktopRuntimeThreadStatus;
    agentProfileId?: string | undefined;
    agentProfileLabel?: string | undefined;
    parentThreadId?: string | undefined;
    activeRunId?: string | undefined;
    currentRequestId?: string | undefined;
    lastRunStatus?: string | undefined;
    createdAt: string;
    updatedAt: string;
}
export interface DesktopRuntimeThreadBlocker {
    kind: "wait" | "child_thread" | "checkpoint" | "stalled";
    summary: string;
    actionable: boolean;
    threadId?: string | undefined;
    childThreadId?: string | undefined;
    requestId?: string | undefined;
    checkpointId?: string | undefined;
    delegationId?: string | undefined;
    eventType?: string | undefined;
}
export interface DesktopRuntimeThreadNextAction {
    kind: "approve" | "reply" | "retry" | "focus_thread" | "resolve_context_checkpoint" | "resolve_fan_in_checkpoint" | "approve_assembly_change" | "switch_thread" | "wait";
    summary: string;
    threadId?: string | undefined;
    requestId?: string | undefined;
    checkpointId?: string | undefined;
    proposalId?: string | undefined;
    childThreadId?: string | undefined;
}
export interface DesktopRuntimeThreadPlan {
    phase?: string | undefined;
    currentChunk?: string | undefined;
    status?: string | undefined;
    expectedNextCommand?: string | undefined;
    waitReason?: string | undefined;
    blocker?: string | undefined;
    commandNames?: string[] | undefined;
}
export interface DesktopRuntimeThreadInspection {
    thread: DesktopRuntimeThreadSummary;
    focusedThreadId?: string | undefined;
    parentThread?: DesktopRuntimeThreadSummary | undefined;
    childThreads: DesktopRuntimeThreadSummary[];
    operatorPhase?: "assemble" | "decide" | "act" | "observe" | "wait" | "finalize" | undefined;
    blocker?: DesktopRuntimeThreadBlocker | undefined;
    nextAction?: DesktopRuntimeThreadNextAction | undefined;
    runtimePlan?: DesktopRuntimeThreadPlan | undefined;
    activeRun?: {
        runId: string;
        status: "RUNNING" | "WAITING";
    } | undefined;
    followUpQueue: {
        state: "ready" | "paused";
        pauseReason?: "waiting" | "failed" | "cancelled" | "operator" | undefined;
        items: DesktopFollowUpQueueEntry[];
    };
    inboxItems: DesktopOperatorInboxItem[];
    latestSteering?: {
        message: string;
        issuedBy?: string | undefined;
        at: string;
        runId?: string | undefined;
    } | undefined;
}
export type DesktopRuntimeRunStatus = "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
export interface DesktopRuntimeRunTimelineEntry {
    seq: number;
    at: string;
    label: string;
    detail?: string | undefined;
    source: "engine" | "agent" | "wait" | "scheduler" | "terminal" | "tooling";
    step?: string | undefined;
    stepIndex?: number | undefined;
}
export interface DesktopRuntimeRunInspection {
    version: "operator-run-v1";
    run: {
        runId: string;
        sessionId: string;
        eventType: string;
        status: DesktopRuntimeRunStatus;
        startedAt: string;
        completedAt?: string | undefined;
        error?: {
            code: string;
            message: string;
        } | undefined;
    };
    threadId?: string | undefined;
    summary: {
        eventCount: number;
        firstEventAt?: string | undefined;
        lastEventAt?: string | undefined;
        terminalStatus?: DesktopRuntimeRunStatus | undefined;
        stepsObserved: number;
        progressToolCalls: number;
        waitingMilestones: number;
        truncated: boolean;
        requestedLimit?: number | undefined;
    };
    diagnosis: {
        status: DesktopRuntimeRunStatus | "UNKNOWN" | "STALLED";
        finalStep?: string | undefined;
        terminalReasonCode?: string | undefined;
        actionable: boolean;
        dominantFailure?: {
            classification: string;
            message: string;
        } | undefined;
        wait?: {
            kind: "approval" | "user_input" | "delegation" | "scheduler_wait" | "compaction_checkpoint" | "unknown";
            actionable: boolean;
            eventType?: string | undefined;
            threadId?: string | undefined;
            delegationId?: string | undefined;
            requestId?: string | undefined;
            enteredAt?: string | undefined;
        } | undefined;
        latestReasoning?: {
            message: string;
            at: string;
        } | undefined;
    };
    modelProvenance: {
        retention: "hash_only";
        callCount: number;
        actionCallCount: number;
        maintenanceCallCount: number;
        providers: string[];
        models: string[];
    };
    runtimePlan?: DesktopRuntimeThreadPlan | undefined;
    timeline: DesktopRuntimeRunTimelineEntry[];
}
export interface DesktopRuntimeRunIndexQuery {
    sessionId?: string | undefined;
    status?: DesktopRuntimeRunStatus | undefined;
    limit?: number | undefined;
}
export interface DesktopRuntimeRunIndexEntry {
    run: DesktopRuntimeRunInspection["run"];
    threadId?: string | undefined;
    summary: {
        eventCount: number;
        truncated: boolean;
    };
    diagnosis: {
        status: DesktopRuntimeRunInspection["diagnosis"]["status"];
        finalStep?: string | undefined;
        terminalReasonCode?: string | undefined;
        actionable: boolean;
        dominantFailure?: DesktopRuntimeRunInspection["diagnosis"]["dominantFailure"] | undefined;
        wait?: DesktopRuntimeRunInspection["diagnosis"]["wait"] | undefined;
    };
}
export interface DesktopRuntimeSessionIndexEntry {
    sessionId: string;
    runCount: number;
    statusCounts: Record<DesktopRuntimeRunStatus, number>;
    latestRunId: string;
    latestStatus: DesktopRuntimeRunStatus;
    latestStartedAt: string;
}
export interface DesktopRuntimeRunIndex {
    version: "operator-run-index-v1";
    generatedAt: string;
    filters: {
        sessionId?: string | undefined;
        status?: DesktopRuntimeRunStatus | undefined;
        limit: number;
    };
    hasMore: boolean;
    runs: DesktopRuntimeRunIndexEntry[];
    sessions: DesktopRuntimeSessionIndexEntry[];
}
export type DesktopRunnerEvent = RunnerEvent;
export declare function parseDesktopRunTurnRequest(value: unknown): DesktopRunTurnRequest;
export declare function parseDesktopRunCancelRequest(value: unknown): DesktopRunCancelRequest;
export declare function parseDesktopLegacyUiStateEntries(value: unknown): DesktopLegacyUiStateEntries;
export declare function parseDesktopUiStateV1(value: unknown): DesktopUiStateV1;
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
export interface DesktopRendererSettings {
    selectedProvider: DesktopModelProvider;
    databaseMode: DesktopDatabaseMode;
    presetId: DesktopShellPresetId;
    capabilityPacks: DesktopCapabilityPackId[];
    projects: DesktopProjectRegistration[];
    providerCredentialConfigured: boolean;
    providerSelectionCompletedAt?: string | undefined;
    setupCompletedAt?: string | undefined;
    advancedWorkspaceEnabled: boolean;
}
export interface DesktopRendererSettingsUpdate {
    selectedProvider?: DesktopModelProvider | undefined;
    projects?: DesktopProjectRegistration[] | undefined;
}
export type DesktopCredentialedModelProvider = "openrouter" | "openai" | "anthropic";
export interface DesktopProviderCredentialInput {
    provider: DesktopCredentialedModelProvider;
    apiKey: string;
}
export type DesktopToolCredentialProvider = "visual-crossing";
export type DesktopCredentialBackend = "macos_keychain" | "unavailable";
export interface DesktopToolCredentialStatus {
    provider: DesktopToolCredentialProvider;
    configured: boolean;
    available: boolean;
    backend: DesktopCredentialBackend;
}
export interface DesktopToolCredentialInput {
    provider: DesktopToolCredentialProvider;
    apiKey: string;
}
export declare function parseDesktopRendererSettingsUpdate(value: unknown): DesktopRendererSettingsUpdate;
export declare function parseDesktopProviderCredentialInput(value: unknown): DesktopProviderCredentialInput;
export declare function parseDesktopToolCredentialProvider(value: unknown): DesktopToolCredentialProvider;
export declare function parseDesktopToolCredentialInput(value: unknown): DesktopToolCredentialInput;
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
