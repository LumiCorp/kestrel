import type {
  DesktopBridge,
  DesktopAttachmentMetadata,
  DesktopFileContent,
  DesktopFileReadInput,
  DesktopFileWriteInput,
  DesktopLegacyUiStateEntries,
  DesktopManagedProjectRun,
  DesktopMcpServerMutationInput,
  DesktopPathTargetInput,
  DesktopProjectAction,
  DesktopProjectSnapshotResponse,
  DesktopRendererSettings,
  DesktopRendererSettingsUpdate,
  DesktopRunnerEvent,
  DesktopRuntimeRunIndex,
  DesktopRuntimeRunIndexQuery,
  DesktopRuntimeRunInspection,
  DesktopRuntimeThreadInspection,
  DesktopUserTerminal,
  DesktopWorkspaceChangeSnapshot,
  DesktopWorkspaceFeedbackSnapshot,
  DesktopWorkspaceGitSnapshot,
  DesktopWorkspaceReviewSnapshot,
  DesktopWorkspaceValidationSnapshot,
} from "../../src/contracts";
import type { ModelPolicyV1 } from "../../../../src/profile/modelPolicy";
import { resolveDesktopCapabilityView } from "../../../../src/desktopShell/capabilityRegistry";
import { LOCAL_CORE_CREDENTIAL_IDS } from "../../../../src/localCore/credentialStore";
import { createDesktopModelConfiguration, listDesktopAppDefinitions } from "../../../../src/desktopShell/configuration";

type PreviewSnapshot = DesktopProjectSnapshotResponse["snapshot"];
type PreviewTaskAction = Extract<
  DesktopProjectAction,
  { type: `task.${string}` }
>;
type PreviewBoardAction = Extract<
  DesktopProjectAction,
  { type: `board.${string}` }
>;
type PreviewBoard = PreviewSnapshot["board"];
type PreviewBoardCard = PreviewBoard["cards"][string];

export function ensureBrowserPreviewBridge(): void {
  const previewWindow = window as unknown as { kestrelDesktop?: DesktopBridge };
  if (
    import.meta.env.DEV === false ||
    previewWindow.kestrelDesktop !== undefined
  ) {
    return;
  }

  const previewModelConfiguration = createDesktopModelConfiguration({
    version: 1,
    provider: "openrouter",
    model: "openai/gpt-5.2",
    modelByStage: {},
    modelCapabilities: { visionInputEnabled: false },
  });
  let settings: DesktopRendererSettings = {
    selectedProvider: "openrouter",
    databaseMode: "default",
    presetId: "desktop_dev_local",
    capabilityPacks: ["balanced", "filesystem", "dev_shell"],
    projects: [
      { path: "/workspace/kestrel", label: "kestrel" },
      { path: "/workspace/demo-agent", label: "demo-agent" },
    ],
    advancedWorkspaceEnabled: false,
    setupCompletedAt: new Date().toISOString(),
    modelConfigurations: [previewModelConfiguration],
    defaultModelConfigurationId: previewModelConfiguration.id,
    defaultEnabledAppIds: ["weather"],
    appearanceTheme: "system",
    apps: listDesktopAppDefinitions(),
    providerReadiness: [
      { provider: "openrouter", configured: true, requiresCredential: true },
      { provider: "openai", configured: false, requiresCredential: true },
      { provider: "anthropic", configured: false, requiresCredential: true },
      { provider: "ollama", configured: true, requiresCredential: false },
      { provider: "lmstudio", configured: true, requiresCredential: false },
    ],
  };
  let entries: DesktopLegacyUiStateEntries = {};
  const modelPolicy: ModelPolicyV1 = {
    version: 1,
    provider: "openrouter",
    model: "openai/gpt-5.2",
    modelByStage: {},
    modelCapabilities: { visionInputEnabled: false },
  };
  let weatherCredentialConfigured = false;
  let managedMcpServers: import("../../src/contracts").DesktopMcpServerConfig[] = [];
  let previewProjectSnapshot = createPreviewProjectSnapshot();
  let previewFileContent = [
    'import { createKestrelClient } from "@kestrel/sdk";',
    "",
    "const client = createKestrelClient();",
    'await client.run({ message: "Inspect this workspace" });',
    "",
  ].join("\n");
  const runnerListeners = new Set<(event: DesktopRunnerEvent) => void>();
  const projectRunListeners = new Set<
    (runs: DesktopManagedProjectRun[]) => void
  >();
  let projectRuns: DesktopManagedProjectRun[] = [
    {
      runId: "preview-run-1",
      projectPath: "/workspace/kestrel",
      manifestPath: "/workspace/kestrel/package.json",
      scriptName: "dev",
      packageManager: "pnpm",
      command: "pnpm run dev",
      status: "running",
      startedAt: new Date(Date.now() - 42_000).toISOString(),
      updatedAt: new Date().toISOString(),
      primaryPreviewUrl: "http://127.0.0.1:43103",
      previewUrls: [],
      stdoutTail: ["Local: http://127.0.0.1:43103", "ready in 412ms"],
      stderrTail: [],
    },
  ];
  const previewCandidateFingerprint =
    "sha256:desktop-preview-candidate-4f19a0d8";
  let previewFeedback: DesktopWorkspaceFeedbackSnapshot = {
    sessionId: "preview-session",
    threadId: "preview-session",
    candidateFingerprint: previewCandidateFingerprint,
    comments: [],
  };
  let previewTerminal: DesktopUserTerminal | undefined;
  const previewAttachments = new Map<string, DesktopAttachmentMetadata[]>();

  const emit = (event: DesktopRunnerEvent) => {
    for (const listener of runnerListeners) {
      listener(event);
    }
  };
  const getPreviewRuntimeStatus = () => ({
    running: true,
    pid: 43_103,
    recentStdout: [
      "Runner service listening on 127.0.0.1",
      "Local Core connected",
    ],
    recentStderr: [],
    logPath: "/tmp/kestrel-preview/runtime.log",
  });
  const getPreviewDatabaseStatus = () => ({
    state: "healthy" as const,
    summary: "Local Core database is ready.",
    managed: true,
    initialized: true,
    running: true,
    host: "127.0.0.1",
    port: 54_329,
    database: "kestrel",
    logPath: "/tmp/kestrel-preview/database.log",
  });
  const startPreviewProjectRun = async (input: {
    projectPath: string;
    scriptName: string;
  }) => {
    const nextRun: DesktopManagedProjectRun = {
      runId: crypto.randomUUID(),
      projectPath: input.projectPath,
      manifestPath: `${input.projectPath}/package.json`,
      scriptName: input.scriptName,
      packageManager: "pnpm",
      command: `pnpm run ${input.scriptName}`,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      previewUrls: [],
      stdoutTail: ["starting preview run"],
      stderrTail: [],
    };
    projectRuns = [nextRun, ...projectRuns];
    for (const listener of projectRunListeners) {
      listener(projectRuns);
    }
    return nextRun;
  };
  const bridge = {
    async getBridgeInfo() {
      return {
        connected: true,
        version: "4-preview",
        capabilities: [
          "ui_state",
          "runner_commands",
          "settings",
          "capability_registry",
          "provider_credentials",
          "project_picker",
          "runtime_control",
          "mission_control",
          "runtime_inspection",
          "model_configurations",
          "app_selection",
        ],
      };
    },
    async getUiState() {
      return null;
    },
    async saveUiState(nextEntries: DesktopLegacyUiStateEntries) {
      entries = nextEntries;
      return {
        updated: true,
        state: {
          version: "desktop-ui-state-v1",
          source: "vite-renderer",
          sourceAppVersion: "preview",
          capturedAt: new Date().toISOString(),
          entries,
        },
      };
    },
    async getSettings() {
      return settings;
    },
    async getCapabilities() {
      return resolveDesktopCapabilityView({
        settings: {
          selectedProvider: settings.selectedProvider,
          databaseMode: settings.databaseMode,
          presetId: settings.presetId,
          capabilityPacks: [...settings.capabilityPacks],
          projects: settings.projects.map((project) => ({ ...project })),
          mcpServers: managedMcpServers,
          capabilityVerifications: {},
          developerShellEnvMode: "inherit",
          developerShellAllowedEnvNames: [],
          approvalPolicyPackId: "dev",
          providerSelectionCompletedAt: settings.providerSelectionCompletedAt,
          setupCompletedAt: settings.setupCompletedAt,
          advancedWorkspaceEnabled: settings.advancedWorkspaceEnabled,
          modelConfigurations: settings.modelConfigurations,
          defaultModelConfigurationId: settings.defaultModelConfigurationId,
          defaultEnabledAppIds: settings.defaultEnabledAppIds,
          appearanceTheme: settings.appearanceTheme,
        },
        credentials: {
          backend: "macos_keychain",
          available: true,
          credentials: LOCAL_CORE_CREDENTIAL_IDS.map((id) => ({
            id,
            configured:
              id === "provider.openrouter.default"
              || (id === "tool.visual-crossing.default" && weatherCredentialConfigured),
          })),
        },
        probes: {
          filesystemAccessible: settings.projects.length > 0,
          shellAvailable: true,
          shellPath: "/bin/zsh",
          executablePath: "/usr/local/bin:/usr/bin:/bin",
          languageRuntimes: [{ name: "node", available: true }, { name: "python3", available: true }],
          packageManagers: [{ name: "pnpm", available: true }, { name: "npm", available: true }],
          dockerInstalled: true,
          dockerDaemonReachable: true,
          dockerImages: [{ name: "node:20-alpine", available: true }, { name: "python:3.12-alpine", available: true }, { name: "bash:5.2", available: true }],
          databaseReady: true,
          microphone: "not-determined",
          mcpServers: [],
          localModelProviders: { ollama: true, lmstudio: true },
        },
      });
    },
    async configureCapability(input: import("../../src/contracts").DesktopCapabilityConfigurationInput) {
      if (input.enabled === true && input.capabilityId.startsWith("model.")) {
        const provider = input.capabilityId.slice("model.".length) as DesktopRendererSettings["selectedProvider"];
        settings = {
          ...settings,
          selectedProvider: provider,
        };
      }
      if (input.capabilityId === "tools.weather") {
        if (input.credential === null) weatherCredentialConfigured = false;
        else if (typeof input.credential === "string") weatherCredentialConfigured = true;
      }
      return {
        capabilityId: input.capabilityId,
        applied: true,
        runtimeRestarted: true,
        view: await bridge.getCapabilities(),
      };
    },
    async saveSettings(update: DesktopRendererSettingsUpdate) {
      settings = {
        ...settings,
        ...(update.projects !== undefined ? { projects: update.projects } : {}),
        ...(update.modelConfigurations !== undefined ? { modelConfigurations: update.modelConfigurations } : {}),
        ...(update.defaultModelConfigurationId !== undefined ? { defaultModelConfigurationId: update.defaultModelConfigurationId } : {}),
        ...(update.defaultEnabledAppIds !== undefined ? { defaultEnabledAppIds: update.defaultEnabledAppIds } : {}),
        ...(update.appearanceTheme !== undefined ? { appearanceTheme: update.appearanceTheme } : {}),
      };
      return settings;
    },
    async getModelPolicy() {
      return modelPolicy;
    },
    async getModelCatalog(provider: DesktopRendererSettings["selectedProvider"]) {
      return {
        provider,
        models: provider === "openrouter" ? ["openai/gpt-5.2", "anthropic/claude-sonnet-4.5"] : [modelPolicy.model],
        source: "fallback" as const,
      };
    },
    async getRuntimeHealth() {
      return {
        state: "healthy",
        summary: "Local runtime is ready.",
        running: true,
      };
    },
    async getRuntimeStatus() {
      return getPreviewRuntimeStatus();
    },
    async getDatabaseStatus() {
      return getPreviewDatabaseStatus();
    },
    async getBootState() {
      return {
        phase: "ready" as const,
        message: "Kestrel is ready.",
        readiness: {
          summary: {
            state: "ready" as const,
            title: "Ready",
            detail: "Desktop services are ready.",
          },
          items: [
            {
              id: "resources" as const,
              label: "Resources",
              state: "ready" as const,
              detail: "Packaged resources verified.",
            },
            {
              id: "provider" as const,
              label: "Provider",
              state: "ready" as const,
              detail: "OpenRouter credential configured.",
            },
            {
              id: "database" as const,
              label: "Database",
              state: "ready" as const,
              detail: "Local Core database is healthy.",
            },
            {
              id: "runner" as const,
              label: "Runner",
              state: "ready" as const,
              detail: "Runner service is accepting commands.",
            },
          ],
        },
      };
    },
    onRuntimeHealth() {
      return () => {};
    },
    onRunnerEvent(listener: (event: DesktopRunnerEvent) => void) {
      runnerListeners.add(listener);
      return () => runnerListeners.delete(listener);
    },
    async runTurn(request: { sessionId: string; message: string }) {
      const commandId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const started = {
        id: crypto.randomUUID(),
        type: "run.started",
        ts: new Date().toISOString(),
        commandId,
        runId,
        sessionId: request.sessionId,
        payload: {
          sessionId: request.sessionId,
          eventType: "user.message",
          interactionMode: "build",
          stepAgent: "kestrel-agent-1",
        },
      } as DesktopRunnerEvent;
      emit(started);
      await new Promise((resolve) => setTimeout(resolve, 450));
      const assistantText = `Preview response for: ${request.message.trim()}`;
      const completed: Extract<DesktopRunnerEvent, { type: "run.completed" }> =
        {
          id: crypto.randomUUID(),
          type: "run.completed",
          ts: new Date().toISOString(),
          commandId,
          runId,
          sessionId: request.sessionId,
          payload: {
            result: {
              assistantText,
              output: {
                status: "COMPLETED",
                sessionId: request.sessionId,
                runId,
                quality: {
                  citationCoverage: 1,
                  unresolvedClaims: 0,
                  reworkRate: 0,
                  thrashIndex: 0,
                },
                errors: [],
                telemetry: {
                  stepsExecuted: 1,
                  toolCalls: 0,
                  modelCalls: 1,
                  durationMs: 450,
                },
              },
              finalizedPayload: {
                message: assistantText,
              },
            },
          },
        };
      emit(completed);
      return completed;
    },
    async selectAttachments(threadId: string) {
      const attachment: DesktopAttachmentMetadata = {
        attachmentId: crypto.randomUUID(),
        threadId,
        filename: "desktop-preview.png",
        mimeType: "image/png",
        sizeBytes: 48_120,
        sha256: "sha256:desktop-preview-attachment",
        kind: "image",
        createdAt: new Date().toISOString(),
      };
      const attachments = [...(previewAttachments.get(threadId) ?? []), attachment];
      previewAttachments.set(threadId, attachments);
      return attachments;
    },
    async listAttachments(threadId: string) {
      return previewAttachments.get(threadId) ?? [];
    },
    async removeAttachment(threadId: string, attachmentId: string) {
      const attachments = previewAttachments.get(threadId) ?? [];
      const remaining = attachments.filter(
        (attachment) => attachment.attachmentId !== attachmentId,
      );
      if (remaining.length === attachments.length) return false;
      previewAttachments.set(threadId, remaining);
      return true;
    },
    async cancelRun(request: { sessionId: string; runId?: string }) {
      const runId = request.runId ?? crypto.randomUUID();
      const cancelled: Extract<DesktopRunnerEvent, { type: "run.cancelled" }> =
        {
          id: crypto.randomUUID(),
          type: "run.cancelled",
          ts: new Date().toISOString(),
          runId,
          sessionId: request.sessionId,
          payload: {
            sessionId: request.sessionId,
            runId,
            result: {
              assistantText: null,
              output: {
                status: "FAILED",
                sessionId: request.sessionId,
                runId,
                quality: {
                  citationCoverage: 0,
                  unresolvedClaims: 0,
                  reworkRate: 0,
                  thrashIndex: 0,
                },
                errors: [],
                telemetry: {
                  stepsExecuted: 0,
                  toolCalls: 0,
                  modelCalls: 0,
                  durationMs: 0,
                },
              },
            },
          },
        };
      return cancelled;
    },
    async restartRuntime() {
      return {
        running: true,
        recentStdout: [],
        recentStderr: [],
        logPath: "/tmp/kestrel.log",
      };
    },
    async restartDatabase() {
      return getPreviewDatabaseStatus();
    },
    async repairDatabase() {
      return getPreviewDatabaseStatus();
    },
    async resetRuntimeStore() {
      return {
        storePath: "/tmp/kestrel-preview/runtime.db",
        archivedStorePath: "/tmp/kestrel-preview/runtime.db.bak",
        resetAt: new Date().toISOString(),
        runtimeStatus: getPreviewRuntimeStatus(),
      };
    },
    async getSupportBundle() {
      return {
        generatedAt: new Date().toISOString(),
        runtime: getPreviewRuntimeStatus(),
      };
    },
    async openDiagnostics() {
      return;
    },
    async revealDatabaseFiles() {
      return;
    },
    async restartApp() {
      return;
    },
    async pickProjectFolder() {
      return;
    },
    async listDirectory(rootPath: string, directoryPath?: string) {
      const resolvedDirectory = directoryPath ?? rootPath;
      const inSourceDirectory = resolvedDirectory.endsWith("/src");
      return {
        rootPath,
        directoryPath: resolvedDirectory,
        entries: inSourceDirectory
          ? [
              {
                path: `${rootPath}/src/index.ts`,
                name: "index.ts",
                kind: "file" as const,
                sizeBytes: 1842,
              },
              {
                path: `${rootPath}/src/runtime.ts`,
                name: "runtime.ts",
                kind: "file" as const,
                sizeBytes: 6250,
              },
            ]
          : [
              {
                path: `${rootPath}/src`,
                name: "src",
                kind: "directory" as const,
              },
              {
                path: `${rootPath}/README.md`,
                name: "README.md",
                kind: "file" as const,
                sizeBytes: 3920,
              },
              {
                path: `${rootPath}/package.json`,
                name: "package.json",
                kind: "file" as const,
                sizeBytes: 1260,
              },
            ],
      };
    },
    async searchProjectFiles(rootPath: string, query: string) {
      return {
        rootPath,
        query,
        results: [
          {
            path: `${rootPath}/src/runtime.ts`,
            name: "runtime.ts",
            directoryPath: `${rootPath}/src`,
          },
        ].filter((entry) =>
          entry.name.toLowerCase().includes(query.toLowerCase()),
        ),
        truncated: false,
        fullSearchAvailable: true,
      };
    },
    async watchProjectFiles() {
      return;
    },
    async unwatchProjectFiles() {
      return;
    },
    onProjectFilesChanged() {
      return () => {};
    },
    async openFileEditor() {
      return;
    },
    async readProjectLauncher(projectPath: string) {
      return {
        projectPath,
        manifestPath: `${projectPath}/package.json`,
        scripts: [
          { name: "dev", command: "vite --host 127.0.0.1" },
          { name: "test", command: "vitest run" },
          { name: "build", command: "tsc -b && vite build" },
        ],
        packageManager: "pnpm" as const,
        packageManagerSelectionRequired: false,
      };
    },
    async listProjectRuns() {
      return projectRuns;
    },
    async startProjectRun(input: { projectPath: string; scriptName: string }) {
      return startPreviewProjectRun(input);
    },
    async stopProjectRun(runId: string) {
      projectRuns = projectRuns.map((run) =>
        run.runId === runId
          ? {
              ...run,
              status: "stopped" as const,
              updatedAt: new Date().toISOString(),
            }
          : run,
      );
      for (const listener of projectRunListeners) {
        listener(projectRuns);
      }
      return projectRuns.find((run) => run.runId === runId);
    },
    async restartProjectRun(runId: string) {
      const existing = projectRuns.find((run) => run.runId === runId)!;
      return startPreviewProjectRun({
        projectPath: existing.projectPath,
        scriptName: existing.scriptName,
      });
    },
    async getProjectSnapshot(
      sessionId: string,
    ): Promise<DesktopProjectSnapshotResponse> {
      return { sessionId, snapshot: previewProjectSnapshot };
    },
    async runProjectAction(
      action: DesktopProjectAction,
    ): Promise<DesktopProjectSnapshotResponse> {
      previewProjectSnapshot = applyPreviewProjectAction(
        previewProjectSnapshot,
        action,
      );
      return { sessionId: action.sessionId, snapshot: previewProjectSnapshot };
    },
    async getOperatorThread(
      threadId: string,
    ): Promise<DesktopRuntimeThreadInspection> {
      return createPreviewRuntimeThreadInspection(threadId);
    },
    async listOperatorRuns(
      query: DesktopRuntimeRunIndexQuery = {},
    ): Promise<DesktopRuntimeRunIndex> {
      return createPreviewRuntimeRunIndex(query);
    },
    async getOperatorRun(runId: string): Promise<DesktopRuntimeRunInspection> {
      return createPreviewRuntimeRunInspection(runId);
    },
    async inspectWorkspaceChanges(input: {
      sessionId: string;
      threadId: string;
    }) {
      return createPreviewWorkspaceChanges(
        input.sessionId,
        input.threadId,
        previewCandidateFingerprint,
      );
    },
    async mutateWorkspaceChanges(input: {
      sessionId: string;
      threadId: string;
      mutation: { operation: string };
    }) {
      return {
        operation: input.mutation.operation,
        previousFingerprint: previewCandidateFingerprint,
        snapshot: createPreviewWorkspaceChanges(
          input.sessionId,
          input.threadId,
          previewCandidateFingerprint,
        ),
      };
    },
    async listWorkspaceFeedback(input: {
      sessionId: string;
      threadId: string;
    }) {
      return {
        ...previewFeedback,
        sessionId: input.sessionId,
        threadId: input.threadId,
      };
    },
    async addWorkspaceFeedback(input: {
      sessionId: string;
      threadId: string;
      candidateFingerprint: string;
      path: string;
      line: number;
      side: "LEFT" | "RIGHT";
      body: string;
    }) {
      const now = new Date().toISOString();
      previewFeedback = {
        sessionId: input.sessionId,
        threadId: input.threadId,
        candidateFingerprint: input.candidateFingerprint,
        comments: [
          ...previewFeedback.comments,
          {
            commentId: crypto.randomUUID(),
            sessionId: input.sessionId,
            threadId: input.threadId,
            candidateFingerprint: input.candidateFingerprint,
            path: input.path,
            line: input.line,
            side: input.side,
            body: input.body,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      return previewFeedback;
    },
    async removeWorkspaceFeedback(input: { commentId: string }) {
      previewFeedback = {
        ...previewFeedback,
        comments: previewFeedback.comments.filter(
          (comment) => comment.commentId !== input.commentId,
        ),
      };
      return previewFeedback;
    },
    async submitWorkspaceFeedback(input: { commentIds: string[] }) {
      previewFeedback = {
        ...previewFeedback,
        comments: previewFeedback.comments.map((comment) =>
          input.commentIds.includes(comment.commentId)
            ? {
                ...comment,
                status: "submitted" as const,
                submittedAt: new Date().toISOString(),
                submissionRunId: "preview-follow-up",
              }
            : comment,
        ),
      };
      return { snapshot: previewFeedback, runId: "preview-follow-up" };
    },
    async listWorkspaceReviews(input: { sessionId: string; threadId: string }) {
      return createPreviewWorkspaceReview(
        input.sessionId,
        input.threadId,
        previewCandidateFingerprint,
      );
    },
    async runWorkspaceReview(input: { sessionId: string; threadId: string }) {
      return createPreviewWorkspaceReview(
        input.sessionId,
        input.threadId,
        previewCandidateFingerprint,
      );
    },
    async updateWorkspaceReviewFinding(input: {
      sessionId: string;
      threadId: string;
    }) {
      return createPreviewWorkspaceReview(
        input.sessionId,
        input.threadId,
        previewCandidateFingerprint,
      );
    },
    async submitWorkspaceReviewFindings(input: {
      sessionId: string;
      threadId: string;
    }) {
      return {
        snapshot: createPreviewWorkspaceReview(
          input.sessionId,
          input.threadId,
          previewCandidateFingerprint,
        ),
        runId: "preview-review-follow-up",
      };
    },
    async inspectWorkspaceValidation(input: {
      sessionId: string;
      threadId: string;
    }) {
      return createPreviewWorkspaceValidation(
        input.sessionId,
        input.threadId,
        previewCandidateFingerprint,
      );
    },
    async runWorkspaceValidation(input: {
      sessionId: string;
      threadId: string;
    }) {
      return createPreviewWorkspaceValidation(
        input.sessionId,
        input.threadId,
        previewCandidateFingerprint,
      );
    },
    async cancelWorkspaceValidation(input: {
      sessionId: string;
      threadId: string;
    }) {
      return createPreviewWorkspaceValidation(
        input.sessionId,
        input.threadId,
        previewCandidateFingerprint,
      );
    },
    async submitWorkspaceValidationFailures(input: {
      sessionId: string;
      threadId: string;
    }) {
      return {
        snapshot: createPreviewWorkspaceValidation(
          input.sessionId,
          input.threadId,
          previewCandidateFingerprint,
        ),
        runId: "preview-validation-follow-up",
      };
    },
    async inspectWorkspaceGit(input: { sessionId: string; threadId: string }) {
      return createPreviewWorkspaceGit(
        input.sessionId,
        input.threadId,
        previewCandidateFingerprint,
      );
    },
    async performWorkspaceGitAction(input: {
      sessionId: string;
      threadId: string;
    }) {
      return createPreviewWorkspaceGit(
        input.sessionId,
        input.threadId,
        previewCandidateFingerprint,
      );
    },
    async listUserTerminals() {
      return previewTerminal ? [previewTerminal] : [];
    },
    async startUserTerminal(input: {
      sessionId: string;
      threadId: string;
      cols?: number;
      rows?: number;
    }) {
      const now = new Date().toISOString();
      previewTerminal = {
        terminalId: crypto.randomUUID(),
        kind: "user_terminal",
        sessionId: input.sessionId,
        threadId: input.threadId,
        workspaceRoot: "/workspace/kestrel",
        cwd: "/workspace/kestrel",
        shellPath: "/bin/zsh",
        pid: 43_109,
        status: "running",
        cols: input.cols ?? 120,
        rows: input.rows ?? 32,
        startedAt: now,
        updatedAt: now,
      };
      return previewTerminal;
    },
    async readUserTerminal(input: { cursor?: number }) {
      if (!previewTerminal) throw new Error("Preview terminal is not running.");
      const output =
        (input.cursor ?? 0) === 0 ? "$ pnpm test\r\nTests ready.\r\n" : "";
      return {
        terminal: previewTerminal,
        output,
        cursor: input.cursor ?? 0,
        nextCursor: 31,
        truncated: false,
      };
    },
    async writeUserTerminal() {
      if (!previewTerminal) throw new Error("Preview terminal is not running.");
      return previewTerminal;
    },
    async resizeUserTerminal(input: { cols: number; rows: number }) {
      if (!previewTerminal) throw new Error("Preview terminal is not running.");
      previewTerminal = {
        ...previewTerminal,
        cols: input.cols,
        rows: input.rows,
        updatedAt: new Date().toISOString(),
      };
      return previewTerminal;
    },
    async stopUserTerminal() {
      if (!previewTerminal) throw new Error("Preview terminal is not running.");
      previewTerminal = {
        ...previewTerminal,
        status: "stopped",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      return previewTerminal;
    },
    onPreviewDiagnostic() {
      return () => {};
    },
    async openExternal() {
      return;
    },
    onProjectRuns(listener: (runs: DesktopManagedProjectRun[]) => void) {
      projectRunListeners.add(listener);
      return () => projectRunListeners.delete(listener);
    },
    async openProjectRunPreview() {
      return;
    },
    async discoverMcpServers() {
      return {
        discoveredAt: new Date().toISOString(),
        diagnostics: [],
        servers: [
          ...managedMcpServers,
          {
            id: "filesystem",
            name: "Filesystem",
            transport: "stdio" as const,
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
            enabled: true,
            source: "Claude Desktop",
            sourceKind: "config-file" as const,
            sourcePath: "~/.config/claude/claude_desktop_config.json",
            toolCount: 3,
            tools: [
              {
                name: "read_file",
                description: "Read a file from an allowed root.",
              },
              {
                name: "list_directory",
                description: "List an allowed directory.",
              },
              { name: "search_files", description: "Search files by name." },
            ],
          },
          {
            id: "docker-toolkit",
            name: "Docker MCP Toolkit",
            transport: "stdio" as const,
            command: "docker",
            enabled: false,
            source: "Docker Desktop",
            sourceKind: "docker-toolkit" as const,
            toolCount: 0,
            tools: [],
          },
        ],
      };
    },
    async saveMcpServer(input: DesktopMcpServerMutationInput) {
      const server: import("../../src/contracts").DesktopMcpServerConfig = {
        id: input.id,
        name: input.name,
        transport: input.transport,
        ...(input.transport === "stdio" ? { command: input.command, args: input.args } : { url: input.url }),
        enabled: input.enabled,
        credentials: input.credentials?.map((binding) => ({
          kind: binding.kind,
          ...(binding.name !== undefined ? { name: binding.name } : {}),
          credentialId: binding.credentialId ?? `mcp.${input.id}.${binding.kind}.preview`,
          envKey: binding.envKey ?? (binding.name ?? "KESTREL_MCP_PREVIEW"),
          configured: binding.secret !== undefined || binding.credentialId !== undefined,
        })),
        source: "Kestrel Desktop",
        sourceKind: "desktop-managed",
        tools: [],
        toolCount: 0,
      };
      managedMcpServers = [...managedMcpServers.filter((entry) => entry.id !== input.id), server];
      return await bridge.discoverMcpServers();
    },
    async deleteMcpServer(id: string) {
      managedMcpServers = managedMcpServers.filter((server) => server.id !== id);
      return await bridge.discoverMcpServers();
    },
    async readFile(input: DesktopFileReadInput): Promise<DesktopFileContent> {
      return {
        path: input.targetPath,
        content: previewFileContent,
        viewKind: "code",
        language: "typescript",
        contentHash: `preview-${previewFileContent.length}`,
        lineEnding: "lf",
        editable: true,
        sizeBytes: new TextEncoder().encode(previewFileContent).byteLength,
      };
    },
    async writeFile(input: DesktopFileWriteInput): Promise<DesktopFileContent> {
      previewFileContent = input.content;
      return {
        path: input.targetPath,
        content: previewFileContent,
        viewKind: "code",
        language: "typescript",
        contentHash: `preview-${previewFileContent.length}`,
        lineEnding: input.lineEnding ?? "lf",
        editable: true,
        sizeBytes: new TextEncoder().encode(previewFileContent).byteLength,
      };
    },
    async openPath(_input: DesktopPathTargetInput) {
      return;
    },
  } as unknown as DesktopBridge;

  previewWindow.kestrelDesktop = bridge;
}

function createPreviewWorkspaceChanges(
  sessionId: string,
  threadId: string,
  candidateFingerprint: string,
): DesktopWorkspaceChangeSnapshot {
  return {
    sessionId,
    threadId,
    workspaceRoot: "/workspace/kestrel",
    repoRoot: "/workspace/kestrel",
    scope: { kind: "uncommitted" },
    options: { contextLines: 3, whitespace: "show" },
    readOnly: false,
    candidateFingerprint,
    currentBranch: "asher/desktop-m2",
    headSha: "4f19a0d8e136f4c89d2ad5f71ab53a6b9502b7c0",
    baseRef: "main",
    mergeBase: "18d8be20a62a2cf8f45aa00965203459a095b862",
    upstream: "origin/asher/desktop-m2",
    ahead: 2,
    behind: 0,
    conflicted: false,
    files: [
      {
        path: "apps/desktop/renderer/src/GitWorkspace.tsx",
        status: "modified",
        staged: true,
        unstaged: false,
        additions: 84,
        deletions: 7,
        binary: false,
      },
      {
        path: "apps/desktop/renderer/src/styles.css",
        status: "modified",
        staged: false,
        unstaged: true,
        additions: 126,
        deletions: 18,
        binary: false,
      },
    ],
    hunks: [
      {
        hunkId: "preview-hunk-1",
        filePath: "apps/desktop/renderer/src/styles.css",
        header: "@@ -2908,6 +2908,18 @@",
        lines: ["+ .git-card {", "+   border: 1px solid var(--border);", "+ }"],
        oldStart: 2908,
        newStart: 2908,
        origin: "unstaged",
      },
    ],
    diff: [
      "diff --git a/apps/desktop/renderer/src/styles.css b/apps/desktop/renderer/src/styles.css",
      "@@ -2908,6 +2908,18 @@",
      "+.git-card {",
      "+  border: 1px solid var(--border);",
      "+}",
    ].join("\n"),
    diffBytes: 214,
    truncated: false,
    generatedAt: new Date().toISOString(),
  };
}

function createPreviewWorkspaceReview(
  sessionId: string,
  threadId: string,
  candidateFingerprint: string,
): DesktopWorkspaceReviewSnapshot {
  const now = new Date().toISOString();
  return {
    sessionId,
    threadId,
    candidateFingerprint,
    reviews: [
      {
        reviewId: "preview-review-1",
        sessionId,
        threadId,
        candidateFingerprint,
        scopeLabel: "All uncommitted changes",
        scope: { kind: "uncommitted" },
        mode: "current_thread",
        status: "completed",
        findings: [
          {
            findingId: "preview-finding-1",
            reviewId: "preview-review-1",
            severity: "medium",
            confidence: 0.93,
            path: "apps/desktop/renderer/src/styles.css",
            line: 2910,
            problem:
              "Workspace controls do not share the established Desktop control treatment.",
            impact:
              "The new surfaces look disconnected and toolbars are difficult to scan.",
            evidence:
              "Native controls use browser defaults while established surfaces use compact bordered controls.",
            remediation:
              "Apply shared tokens, control sizing, and responsive toolbar behavior.",
            verification:
              "Capture the same surface at desktop and narrow workspace widths.",
            status: "open",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
    ],
  };
}

function createPreviewWorkspaceValidation(
  sessionId: string,
  threadId: string,
  candidateFingerprint: string,
): DesktopWorkspaceValidationSnapshot {
  const now = new Date().toISOString();
  return {
    sessionId,
    threadId,
    workspaceRoot: "/workspace/kestrel",
    candidateFingerprint,
    actions: [
      {
        actionId: "typecheck",
        label: "Desktop typecheck",
        kind: "typecheck",
        command: "pnpm",
        args: ["--filter", "@kestrel/desktop", "typecheck"],
        cwd: "/workspace/kestrel",
        required: true,
        artifactPaths: [],
        source: "package_script",
      },
      {
        actionId: "desktop-tests",
        label: "Desktop tests",
        kind: "test",
        command: "pnpm",
        args: ["--filter", "@kestrel/desktop", "test"],
        cwd: "/workspace/kestrel",
        required: true,
        artifactPaths: ["apps/desktop/test-results.json"],
        source: "package_script",
      },
      {
        actionId: "desktop-build",
        label: "Desktop build",
        kind: "build",
        command: "pnpm",
        args: ["--filter", "@kestrel/desktop", "build"],
        cwd: "/workspace/kestrel",
        required: true,
        artifactPaths: ["apps/desktop/dist"],
        source: "package_script",
      },
    ],
    suites: [
      {
        suiteId: "desktop-ready",
        label: "Desktop ready",
        actionIds: ["typecheck", "desktop-tests", "desktop-build"],
        stopOnFailure: true,
      },
    ],
    results: [
      {
        resultId: "preview-validation-result-1",
        sessionId,
        threadId,
        actionId: "typecheck",
        actionLabel: "Desktop typecheck",
        kind: "typecheck",
        candidateFingerprint,
        outcome: "passed",
        command: "pnpm",
        args: ["--filter", "@kestrel/desktop", "typecheck"],
        cwd: "/workspace/kestrel",
        startedAt: now,
        completedAt: now,
        durationMs: 1832,
        exitCode: 0,
        output: [
          {
            seq: 1,
            at: now,
            stream: "stdout",
            text: "Desktop typecheck passed.\n",
          },
        ],
        outputTruncated: false,
        evidence: [],
        locations: [],
      },
    ],
    readiness: {
      state: "not_run",
      required: 3,
      passed: 1,
      failed: 0,
      stale: 0,
      message: "Run the remaining required Desktop checks.",
    },
    generatedAt: now,
  };
}

function createPreviewWorkspaceGit(
  sessionId: string,
  threadId: string,
  candidateFingerprint: string,
): DesktopWorkspaceGitSnapshot {
  const now = new Date().toISOString();
  return {
    sessionId,
    threadId,
    workspaceRoot: "/workspace/kestrel",
    repoRoot: "/workspace/kestrel",
    candidateFingerprint,
    validationReadiness: "ready",
    deliveryReady: true,
    deliveryReadinessMessage:
      "Required validation is fresh for this candidate.",
    branch: "asher/desktop-m2",
    headSha: "4f19a0d8e136f4c89d2ad5f71ab53a6b9502b7c0",
    upstream: "origin/asher/desktop-m2",
    relation: "ahead",
    pushState: "not_pushed",
    ahead: 2,
    behind: 0,
    files: [
      {
        path: "apps/desktop/renderer/src/GitWorkspace.tsx",
        status: "modified",
        staged: true,
        unstaged: false,
      },
      {
        path: "apps/desktop/renderer/src/styles.css",
        status: "modified",
        staged: false,
        unstaged: true,
      },
    ],
    branches: ["main", "asher/desktop-m2"],
    remotes: [
      {
        name: "origin",
        fetchUrl: "git@github.com:kestrel-agents/kestrel.git",
        pushUrl: "git@github.com:kestrel-agents/kestrel.git",
      },
    ],
    recentCommits: [
      {
        sha: "4f19a0d8e136f4c89d2ad5f71ab53a6b9502b7c0",
        summary: "Complete Desktop workspace delivery surfaces",
        authoredAt: now,
      },
      {
        sha: "18d8be20a62a2cf8f45aa00965203459a095b862",
        summary: "Harden Local Core workspace contracts",
        authoredAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    ],
    github: {
      available: true,
      authenticated: true,
      account: "kestrel-preview",
      repository: "kestrel-agents/kestrel",
    },
    pullRequest: {
      number: 214,
      title: "Complete Desktop Milestone 2",
      body: "Adds Local Core-authoritative workspace delivery surfaces.",
      url: "https://github.com/kestrel-agents/kestrel/pull/214",
      state: "OPEN",
      isDraft: true,
      baseBranch: "main",
      headBranch: "asher/desktop-m2",
      headSha: "4f19a0d8e136f4c89d2ad5f71ab53a6b9502b7c0",
      mergeable: "MERGEABLE",
      mergeState: "CLEAN",
      reviewDecision: "REVIEW_REQUIRED",
      changedFiles: [
        {
          path: "apps/desktop/renderer/src/GitWorkspace.tsx",
          additions: 84,
          deletions: 7,
        },
      ],
      checks: [
        {
          id: "check-1",
          name: "Desktop",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
        { id: "check-2", name: "Runtime", status: "IN_PROGRESS" },
      ],
      comments: [
        {
          id: "comment-1",
          body: "Validation evidence looks good; UI polish is the remaining pass.",
          author: "reviewer",
          createdAt: now,
        },
      ],
    },
    audits: [
      {
        auditId: "audit-1",
        sessionId,
        threadId,
        operation: "fetch",
        status: "succeeded",
        summary: "Fetched origin.",
        at: now,
        candidateFingerprint,
      },
    ],
    notifications: [],
    generatedAt: now,
  };
}

function createPreviewProjectSnapshot(): DesktopProjectSnapshotResponse["snapshot"] {
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 48_000).toISOString();
  return {
    version: 1,
    graphVersion: 1,
    setup: {
      workspaceRoot: "/workspace/kestrel",
      repoRoot: "/workspace/kestrel",
      repoLabel: "kestrel",
      defaultBranch: "main",
      providerProfileId: "reference-web",
      githubConnected: true,
      browserReady: true,
      codeReady: true,
      mcpReady: true,
    },
    policy: {
      sandboxMode: "workspace_write",
      approvalMode: "on_request",
      toolClassPolicy: {},
      browserScope: "project",
      githubScope: "project",
      mcpScope: "project",
      taskOverrides: {},
      recentDecisions: [],
    },
    board: {
      version: 1,
      boardVersion: 5,
      nextCardNumber: 5,
      lanes: ["idea", "planned", "wip", "testing", "done"],
      settings: { autopilotEnabled: false, wipLimit: 2 },
      cards: {
        "K-1": {
          id: "K-1",
          title: "Define hosted app cutover",
          prompt:
            "Document the path, package, and deployment transition from Web Client to Kestrel One.",
          lane: "idea",
          order: 1,
          createdAt: earlier,
          updatedAt: earlier,
          threads: [],
          evidence: [
            {
              id: "preview-board-evidence-1",
              timestamp: earlier,
              source: "operator",
              outcome: "created",
              summary: "Card created for the 0.6 repository split.",
            },
          ],
        },
        "K-2": {
          id: "K-2",
          title: "Retire legacy web cockpit",
          prompt:
            "Move retained local workflows into Desktop before promoting Kestrel One to apps/web.",
          lane: "planned",
          order: 1,
          createdAt: earlier,
          updatedAt: now,
          threads: [],
          evidence: [
            {
              id: "preview-board-evidence-2",
              timestamp: now,
              source: "operator",
              outcome: "moved",
              summary: "Cutover work is ready for implementation.",
            },
          ],
        },
        "K-3": {
          id: "K-3",
          title: "Package Desktop state bridge",
          prompt:
            "Verify the 0.5.1 bridge migrates local state before the hosted path cutover.",
          lane: "wip",
          order: 1,
          createdAt: earlier,
          updatedAt: now,
          activeClaim: {
            threadId: "thread-main:preview-desktop-bridge",
            sessionId: "preview-desktop-bridge",
            kind: "implementation",
            claimedAt: now,
            claimReason: "copilot",
          },
          threads: [
            {
              threadId: "thread-main:preview-desktop-bridge",
              sessionId: "preview-desktop-bridge",
              kind: "implementation",
              startedAt: now,
              status: "active",
            },
          ],
          evidence: [
            {
              id: "preview-board-evidence-3",
              timestamp: now,
              source: "copilot",
              outcome: "thread_started",
              summary: "Implementation thread started.",
              threadId: "thread-main:preview-desktop-bridge",
            },
          ],
        },
        "K-4": {
          id: "K-4",
          title: "Verify public clone boundary",
          prompt:
            "Run release package, source sanitation, and fresh-clone gates from public dependencies.",
          lane: "testing",
          order: 1,
          createdAt: earlier,
          updatedAt: now,
          threads: [],
          evidence: [
            {
              id: "preview-board-evidence-4",
              timestamp: now,
              source: "implementation_thread",
              outcome: "success",
              summary: "Implementation completed and is ready for testing.",
            },
          ],
        },
      },
    },
    taskQueue: {
      version: 1,
      queueVersion: 4,
      nextTaskNumber: 4,
      tasks: {
        "T-1": {
          id: "T-1",
          title: "Verify public package boundary",
          instructions:
            "Run packed consumer checks for protocol, SDK, and Next.",
          priority: "high",
          status: "running",
          createdBy: "user",
          createdAt: earlier,
          updatedAt: now,
          order: 1,
          threadId: "thread-package-verification",
          evidence: [
            {
              id: "evidence-1",
              timestamp: now,
              summary: "Package verification is running.",
              source: "runtime",
            },
          ],
        },
        "T-2": {
          id: "T-2",
          title: "Review Desktop parity",
          instructions:
            "Confirm the static renderer owns retained cockpit workflows.",
          priority: "medium",
          status: "ready_for_review",
          createdBy: "agent",
          createdAt: earlier,
          updatedAt: now,
          order: 2,
          evidence: [
            {
              id: "evidence-2",
              timestamp: now,
              summary: "Mission Control bridge implemented.",
              source: "agent",
            },
          ],
          review: {
            submittedAt: now,
            summary: "Ready for operator review.",
          },
        },
        "T-3": {
          id: "T-3",
          title: "Archive obsolete web routes",
          instructions:
            "Wait for the 0.5.1 Desktop bridge release before path cutover.",
          priority: "urgent",
          status: "proposed",
          createdBy: "agent",
          createdAt: now,
          updatedAt: now,
          order: 3,
          evidence: [
            {
              id: "evidence-3",
              timestamp: now,
              summary: "Task proposed by migration planner.",
              source: "agent",
            },
          ],
        },
      },
    },
    review: {
      branches: [],
      worktrees: [],
      pullRequests: [],
      recentCommits: [],
    },
    workspaceCheckpoints: {
      recentActivity: [],
    },
    activity: [],
  };
}

function createPreviewRuntimeThreadInspection(
  threadId: string,
): DesktopRuntimeThreadInspection {
  const now = new Date().toISOString();
  const createdAt = new Date(Date.now() - 420_000).toISOString();
  const isChild = threadId.startsWith("thread-child:");
  const parentThreadId = "thread-main:preview-runtime-cutover";
  const title = threadId.includes("package-verification")
    ? "Verify public package boundary"
    : threadId.includes("desktop-bridge")
      ? "Package Desktop state bridge"
      : isChild
        ? "Verify packaged Electron navigation"
        : "Inspect canonical web cutover";
  return {
    thread: {
      threadId,
      sessionId: "preview-session",
      title,
      status: isChild ? "WAITING" : "RUNNING",
      agentProfileId: "reference",
      agentProfileLabel: "Kestrel build",
      ...(isChild ? { parentThreadId } : {}),
      activeRunId: isChild
        ? "run-preview-electron-smoke"
        : "run-preview-web-cutover",
      lastRunStatus: isChild ? "WAITING" : "RUNNING",
      createdAt,
      updatedAt: now,
    },
    focusedThreadId: threadId,
    ...(isChild
      ? {
          parentThread: {
            threadId: parentThreadId,
            sessionId: "preview-session",
            title: "Inspect canonical web cutover",
            status: "RUNNING" as const,
            activeRunId: "run-preview-web-cutover",
            createdAt,
            updatedAt: now,
          },
        }
      : {}),
    childThreads: isChild
      ? []
      : [
          {
            threadId: "thread-child:preview-electron-smoke",
            sessionId: "preview-session",
            title: "Verify packaged Electron navigation",
            status: "WAITING",
            parentThreadId: threadId,
            activeRunId: "run-preview-electron-smoke",
            createdAt,
            updatedAt: now,
          },
        ],
    operatorPhase: isChild ? "wait" : "act",
    ...(isChild
      ? {
          blocker: {
            kind: "checkpoint" as const,
            summary: "Packaged Electron smoke has not run yet.",
            actionable: true,
            threadId,
            checkpointId: "checkpoint-electron-smoke",
          },
          nextAction: {
            kind: "resolve_context_checkpoint" as const,
            summary: "Run packaged Electron smoke and record the artifact.",
            threadId,
            checkpointId: "checkpoint-electron-smoke",
          },
        }
      : {
          nextAction: {
            kind: "wait" as const,
            summary: "Wait for the packaged Desktop verification child thread.",
            childThreadId: "thread-child:preview-electron-smoke",
          },
        }),
    runtimePlan: {
      phase: "verify",
      currentChunk: isChild ? "Packaged Desktop smoke" : "Web Client parity",
      status: isChild ? "waiting" : "running",
      expectedNextCommand: isChild
        ? "pnpm --filter @kestrel/desktop package"
        : "operator.thread",
      ...(isChild ? { waitReason: "Package artifact required." } : {}),
      commandNames: isChild
        ? ["pnpm --filter @kestrel/desktop package"]
        : ["operator.thread", "project.snapshot.get"],
    },
    latestSteering: {
      message:
        "Keep the hosted app and Desktop runtime boundaries independent.",
      issuedBy: "operator",
      at: now,
      runId: isChild ? "run-preview-electron-smoke" : "run-preview-web-cutover",
    },
    activeRun: {
      runId: isChild ? "run-preview-electron-smoke" : "run-preview-web-cutover",
      status: isChild ? "WAITING" : "RUNNING",
    },
    followUpQueue: { state: "ready", items: [] },
    inboxItems: [],
  };
}

function createPreviewRuntimeRunInspection(
  runId: string,
): DesktopRuntimeRunInspection {
  const waiting = runId.includes("electron-smoke");
  const startedAt = new Date(
    Date.now() - (waiting ? 195_000 : 82_000),
  ).toISOString();
  const now = new Date().toISOString();
  const threadId = waiting
    ? "thread-child:preview-electron-smoke"
    : "thread-main:preview-runtime-cutover";
  return {
    version: "operator-run-v1",
    run: {
      runId,
      sessionId: "preview-session",
      eventType: waiting
        ? "operator.package_verification"
        : "operator.web_cutover",
      status: waiting ? "WAITING" : "RUNNING",
      startedAt,
    },
    threadId,
    summary: {
      eventCount: 5,
      firstEventAt: startedAt,
      lastEventAt: now,
      stepsObserved: waiting ? 2 : 3,
      progressToolCalls: waiting ? 1 : 2,
      waitingMilestones: waiting ? 1 : 0,
      truncated: false,
    },
    diagnosis: waiting
      ? {
          status: "WAITING",
          finalStep: "exec.wait_approval",
          actionable: true,
          wait: {
            kind: "approval",
            actionable: true,
            eventType: "operator.approval",
            threadId,
            requestId: "request-electron-package-proof",
            enteredAt: now,
          },
          latestReasoning: {
            message:
              "The package boundary is ready; the installable Electron artifact still needs smoke evidence.",
            at: new Date(Date.now() - 18_000).toISOString(),
          },
        }
      : {
          status: "RUNNING",
          actionable: false,
          latestReasoning: {
            message:
              "Runtime inspection is moving behind the runner-owned protocol before the legacy Web route is removed.",
            at: new Date(Date.now() - 9000).toISOString(),
          },
        },
    modelProvenance: {
      retention: "hash_only",
      callCount: waiting ? 2 : 4,
      actionCallCount: waiting ? 2 : 3,
      maintenanceCallCount: waiting ? 0 : 1,
      providers: ["openai"],
      models: ["gpt-5"],
    },
    runtimePlan: {
      phase: "verify",
      currentChunk: waiting ? "Packaged Desktop smoke" : "Web Client parity",
      status: waiting ? "waiting" : "running",
      expectedNextCommand: waiting
        ? "pnpm --filter @kestrel/desktop package"
        : "operator.run",
      ...(waiting
        ? { waitReason: "Installable artifact approval required." }
        : {}),
      commandNames: waiting
        ? [
            "pnpm --filter @kestrel/desktop package",
            "pnpm run check:desktop-release",
          ]
        : ["operator.thread", "operator.run", "project.snapshot.get"],
    },
    timeline: [
      {
        seq: 1,
        at: startedAt,
        label: "run.started",
        source: "engine",
      },
      {
        seq: 2,
        at: new Date(new Date(startedAt).getTime() + 2000).toISOString(),
        label: "step started",
        detail: "from=runtime to=exec status=RUNNING",
        source: "engine",
        step: "exec.deliberate",
        stepIndex: 1,
      },
      {
        seq: 3,
        at: new Date(new Date(startedAt).getTime() + 11_000).toISOString(),
        label: "reasoning update",
        detail: waiting
          ? "Package proof requires an installable artifact."
          : "The runner owns runtime inspection.",
        source: "agent",
        step: "exec.deliberate",
        stepIndex: 1,
      },
      {
        seq: 4,
        at: new Date(new Date(startedAt).getTime() + 29_000).toISOString(),
        label: "tool completed",
        detail: waiting
          ? "pnpm --filter @kestrel/desktop package"
          : "operator.run",
        source: "tooling",
        step: "exec.dispatch",
        stepIndex: 2,
      },
      ...(waiting
        ? [
            {
              seq: 5,
              at: now,
              label: "wait entered",
              detail: "eventType=operator.approval",
              source: "wait" as const,
              step: "exec.wait_approval",
              stepIndex: 3,
            },
          ]
        : [
            {
              seq: 5,
              at: now,
              label: "step committed",
              detail: "status=RUNNING",
              source: "engine" as const,
              step: "exec.observe",
              stepIndex: 3,
            },
          ]),
    ],
  };
}

function createPreviewRuntimeRunIndex(
  query: DesktopRuntimeRunIndexQuery,
): DesktopRuntimeRunIndex {
  const active = createPreviewRuntimeRunInspection("run-preview-web-cutover");
  const waiting = createPreviewRuntimeRunInspection(
    "run-preview-electron-smoke",
  );
  const completedBase = createPreviewRuntimeRunInspection(
    "run-preview-public-sdk",
  );
  const completed: DesktopRuntimeRunInspection = {
    ...completedBase,
    run: {
      ...completedBase.run,
      sessionId: "preview-session-archive",
      eventType: "operator.public_sdk_boundary",
      status: "COMPLETED",
      completedAt: new Date(Date.now() - 290_000).toISOString(),
    },
    threadId: "thread-main:preview-public-sdk",
    diagnosis: {
      status: "COMPLETED",
      finalStep: "exec.finalize",
      actionable: false,
    },
  };
  const limit = query.limit ?? 25;
  const all = [active, waiting, completed]
    .filter(
      (entry) =>
        query.sessionId === undefined ||
        entry.run.sessionId === query.sessionId,
    )
    .filter(
      (entry) =>
        query.status === undefined || entry.run.status === query.status,
    );
  const selected = all.slice(0, limit);
  const runs = selected.map((entry) => ({
    run: entry.run,
    ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
    summary: {
      eventCount: entry.summary.eventCount,
      truncated: entry.summary.truncated,
    },
    diagnosis: {
      status: entry.diagnosis.status,
      ...(entry.diagnosis.finalStep !== undefined
        ? { finalStep: entry.diagnosis.finalStep }
        : {}),
      ...(entry.diagnosis.terminalReasonCode !== undefined
        ? { terminalReasonCode: entry.diagnosis.terminalReasonCode }
        : {}),
      actionable: entry.diagnosis.actionable,
      ...(entry.diagnosis.dominantFailure !== undefined
        ? { dominantFailure: entry.diagnosis.dominantFailure }
        : {}),
      ...(entry.diagnosis.wait !== undefined
        ? { wait: entry.diagnosis.wait }
        : {}),
    },
  }));
  const sessions = [...new Set(runs.map((entry) => entry.run.sessionId))].map(
    (sessionId) => {
      const sessionRuns = runs.filter(
        (entry) => entry.run.sessionId === sessionId,
      );
      const latest = sessionRuns[0]!;
      return {
        sessionId,
        runCount: sessionRuns.length,
        statusCounts: {
          RUNNING: sessionRuns.filter((entry) => entry.run.status === "RUNNING")
            .length,
          WAITING: sessionRuns.filter((entry) => entry.run.status === "WAITING")
            .length,
          COMPLETED: sessionRuns.filter(
            (entry) => entry.run.status === "COMPLETED",
          ).length,
          FAILED: sessionRuns.filter((entry) => entry.run.status === "FAILED")
            .length,
        },
        latestRunId: latest.run.runId,
        latestStatus: latest.run.status,
        latestStartedAt: latest.run.startedAt,
      };
    },
  );
  return {
    version: "operator-run-index-v1",
    generatedAt: new Date().toISOString(),
    filters: {
      ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      limit,
    },
    hasMore: all.length > limit,
    runs,
    sessions,
  };
}

function applyPreviewProjectAction(
  snapshot: PreviewSnapshot,
  action: DesktopProjectAction,
): PreviewSnapshot {
  return isPreviewBoardAction(action)
    ? applyPreviewBoardAction(snapshot, action)
    : applyPreviewTaskAction(snapshot, action);
}

function applyPreviewTaskAction(
  snapshot: PreviewSnapshot,
  action: PreviewTaskAction,
): PreviewSnapshot {
  const tasks = { ...snapshot.taskQueue.tasks };
  if (action.type === "task.create" || action.type === "task.propose") {
    const taskId = `T-${snapshot.taskQueue.nextTaskNumber}`;
    tasks[taskId] = {
      id: taskId,
      title: action.title,
      instructions: action.instructions,
      ...(action.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: action.acceptanceCriteria }
        : {}),
      ...(action.projectPath !== undefined
        ? { projectPath: action.projectPath }
        : {}),
      ...(action.projectLabel !== undefined
        ? { projectLabel: action.projectLabel }
        : {}),
      priority: action.priority ?? "medium",
      status: action.type === "task.create" ? "queued" : "proposed",
      createdBy: action.type === "task.create" ? "user" : "agent",
      createdAt: action.actionTs,
      updatedAt: action.actionTs,
      order: Object.keys(tasks).length + 1,
      evidence: [
        {
          id: `${action.actionId}:evidence`,
          timestamp: action.actionTs,
          summary: action.summary ?? "Task created.",
          source: action.type === "task.create" ? "user" : "agent",
        },
      ],
    };
    return {
      ...snapshot,
      taskQueue: {
        ...snapshot.taskQueue,
        queueVersion: snapshot.taskQueue.queueVersion + 1,
        nextTaskNumber: snapshot.taskQueue.nextTaskNumber + 1,
        tasks,
      },
    };
  }

  if (action.taskId === undefined || tasks[action.taskId] === undefined) {
    return snapshot;
  }
  const current = tasks[action.taskId]!;
  const status =
    action.type === "task.approve" ||
    action.type === "task.retry" ||
    action.type === "task.request_changes"
      ? "queued"
      : action.type === "task.claim" || action.type === "task.mark_running"
        ? "running"
        : action.type === "task.needs_attention" || action.type === "task.stop"
          ? "needs_attention"
          : action.type === "task.submit_review"
            ? "ready_for_review"
            : action.type === "task.accept"
              ? "done"
              : action.type === "task.discard"
                ? "discarded"
                : current.status;
  tasks[action.taskId] = {
    ...current,
    status,
    updatedAt: action.actionTs,
    evidence: [
      ...current.evidence,
      {
        id: `${action.actionId}:evidence`,
        timestamp: action.actionTs,
        summary: action.summary ?? action.type.replaceAll("_", " "),
        source: "runtime",
      },
    ],
  };
  return {
    ...snapshot,
    taskQueue: {
      ...snapshot.taskQueue,
      queueVersion: snapshot.taskQueue.queueVersion + 1,
      tasks,
    },
  };
}

function isPreviewBoardAction(
  action: DesktopProjectAction,
): action is PreviewBoardAction {
  return action.type.startsWith("board.");
}

function applyPreviewBoardAction(
  snapshot: PreviewSnapshot,
  action: PreviewBoardAction,
): PreviewSnapshot {
  if (
    action.expectedBoardVersion !== undefined &&
    action.expectedBoardVersion !== snapshot.board.boardVersion
  ) {
    throw Object.assign(
      new Error(
        `Project board version conflict: expected=${action.expectedBoardVersion} actual=${snapshot.board.boardVersion}.`,
      ),
      { code: "PROJECT_BOARD_VERSION_CONFLICT" },
    );
  }

  switch (action.type) {
    case "board.autopilot.configure":
      return replacePreviewBoard(snapshot, {
        ...snapshot.board,
        settings: {
          ...snapshot.board.settings,
          ...(action.autopilotEnabled !== undefined
            ? { autopilotEnabled: action.autopilotEnabled }
            : {}),
          ...(action.autopilotConfirmedAt !== undefined
            ? { autopilotConfirmedAt: action.autopilotConfirmedAt }
            : {}),
          ...(action.wipLimit !== undefined
            ? { wipLimit: action.wipLimit }
            : {}),
        },
      });
    case "board.autopilot.tick":
      return applyPreviewAutopilotTick(snapshot, action);
    case "board.card.create": {
      const cardId = `K-${snapshot.board.nextCardNumber}`;
      const card: PreviewBoardCard = {
        id: cardId,
        title: action.title,
        prompt: action.prompt,
        lane: "idea",
        order: nextPreviewLaneOrder(snapshot.board, "idea"),
        createdAt: action.actionTs,
        updatedAt: action.actionTs,
        threads: [],
        evidence: [
          previewBoardEvidence(
            action,
            "created",
            action.summary ?? "Card created.",
          ),
        ],
      };
      return replacePreviewBoard(snapshot, {
        ...snapshot.board,
        nextCardNumber: snapshot.board.nextCardNumber + 1,
        cards: { ...snapshot.board.cards, [cardId]: card },
      });
    }
    case "board.card.update": {
      const card = snapshot.board.cards[action.cardId];
      if (card === undefined) {
        return snapshot;
      }
      return replacePreviewBoardCard(snapshot, {
        ...card,
        ...(action.title !== undefined ? { title: action.title } : {}),
        ...(action.prompt !== undefined ? { prompt: action.prompt } : {}),
        updatedAt: action.actionTs,
        evidence: [
          ...card.evidence,
          previewBoardEvidence(
            action,
            "updated",
            action.summary ?? "Card updated.",
          ),
        ],
      });
    }
    case "board.card.move": {
      const card = snapshot.board.cards[action.cardId];
      if (card === undefined) {
        return snapshot;
      }
      return replacePreviewBoardCard(snapshot, {
        ...card,
        lane: action.targetLane,
        order:
          action.order ??
          nextPreviewLaneOrder(snapshot.board, action.targetLane, card.id),
        updatedAt: action.actionTs,
        evidence: [
          ...card.evidence,
          previewBoardEvidence(
            action,
            "moved",
            action.summary ??
              `Moved from ${card.lane} to ${action.targetLane}.`,
          ),
        ],
      });
    }
    case "board.card.manual_done": {
      const card = snapshot.board.cards[action.cardId];
      if (card === undefined) {
        return snapshot;
      }
      return replacePreviewBoardCard(snapshot, {
        ...card,
        lane: "done",
        order: nextPreviewLaneOrder(snapshot.board, "done", card.id),
        activeClaim: undefined,
        updatedAt: action.actionTs,
        evidence: [
          ...card.evidence,
          previewBoardEvidence(
            action,
            "manual_done",
            action.reason ?? "Card marked done.",
          ),
        ],
      });
    }
    case "board.card.delete": {
      if (snapshot.board.cards[action.cardId] === undefined) {
        return snapshot;
      }
      const cards = { ...snapshot.board.cards };
      delete cards[action.cardId];
      return replacePreviewBoard(snapshot, { ...snapshot.board, cards });
    }
    case "board.card.start_implementation":
      return startPreviewBoardThread(snapshot, action, "implementation");
    case "board.card.start_testing":
      return startPreviewBoardThread(snapshot, action, "testing");
    case "board.card.thread_completed":
      return finishPreviewBoardThread(snapshot, action, "completed");
    case "board.card.thread_failed":
      return finishPreviewBoardThread(snapshot, action, "failed");
    case "board.card.thread_stopped":
      return finishPreviewBoardThread(snapshot, action, "stopped");
    case "board.card.testing_verdict":
      return applyPreviewTestingVerdict(snapshot, action);
  }
}

function applyPreviewAutopilotTick(
  snapshot: PreviewSnapshot,
  action: Extract<PreviewBoardAction, { type: "board.autopilot.tick" }>,
): PreviewSnapshot {
  if (snapshot.board.settings.autopilotEnabled === false) {
    return snapshot;
  }
  const testingCard = previewLaneCards(snapshot.board, "testing").find(
    (card) => card.activeClaim === undefined,
  );
  if (testingCard !== undefined) {
    return startPreviewBoardThread(
      snapshot,
      {
        ...action,
        type: "board.card.start_testing",
        cardId: testingCard.id,
        source: "autopilot",
      },
      "testing",
    );
  }
  if (
    previewLaneCards(snapshot.board, "wip").length >=
    snapshot.board.settings.wipLimit
  ) {
    return snapshot;
  }
  const plannedCard = previewLaneCards(snapshot.board, "planned").find(
    (card) => card.activeClaim === undefined,
  );
  return plannedCard === undefined
    ? snapshot
    : startPreviewBoardThread(
        snapshot,
        {
          ...action,
          type: "board.card.start_implementation",
          cardId: plannedCard.id,
          source: "autopilot",
        },
        "implementation",
      );
}

function startPreviewBoardThread(
  snapshot: PreviewSnapshot,
  action:
    | Extract<PreviewBoardAction, { type: "board.card.start_implementation" }>
    | Extract<PreviewBoardAction, { type: "board.card.start_testing" }>,
  kind: "implementation" | "testing",
): PreviewSnapshot {
  const card = snapshot.board.cards[action.cardId];
  if (card === undefined || card.activeClaim !== undefined) {
    return snapshot;
  }
  const sessionId = `${action.sessionId}:${card.id}:${kind}:${action.actionId}`;
  const threadId = `thread-main:${sessionId}`;
  const source = action.source === "autopilot" ? "autopilot" : "copilot";
  return replacePreviewBoardCard(snapshot, {
    ...card,
    lane: kind === "implementation" ? "wip" : "testing",
    order: nextPreviewLaneOrder(
      snapshot.board,
      kind === "implementation" ? "wip" : "testing",
      card.id,
    ),
    activeClaim: {
      threadId,
      sessionId,
      kind,
      claimedAt: action.actionTs,
      claimReason: source,
    },
    threads: [
      ...card.threads,
      {
        threadId,
        sessionId,
        kind,
        startedAt: action.actionTs,
        status: "active",
      },
    ],
    updatedAt: action.actionTs,
    evidence: [
      ...card.evidence,
      previewBoardEvidence(
        action,
        "thread_started",
        `${kind} thread started.`,
        threadId,
      ),
    ],
  });
}

function finishPreviewBoardThread(
  snapshot: PreviewSnapshot,
  action:
    | Extract<PreviewBoardAction, { type: "board.card.thread_completed" }>
    | Extract<PreviewBoardAction, { type: "board.card.thread_failed" }>
    | Extract<PreviewBoardAction, { type: "board.card.thread_stopped" }>,
  status: "completed" | "failed" | "stopped",
): PreviewSnapshot {
  const card = snapshot.board.cards[action.cardId];
  if (card?.activeClaim === undefined) {
    return snapshot;
  }
  const activeClaim = card.activeClaim;
  const implementationCompleted =
    status === "completed" && activeClaim.kind === "implementation";
  const targetLane = implementationCompleted ? "testing" : "planned";
  const outcome =
    status === "completed"
      ? "success"
      : status === "failed"
        ? "failure"
        : "thread_stopped";
  return replacePreviewBoardCard(snapshot, {
    ...card,
    lane: targetLane,
    order: nextPreviewLaneOrder(snapshot.board, targetLane, card.id),
    activeClaim: undefined,
    threads: card.threads.map((thread) =>
      thread.threadId === activeClaim.threadId
        ? { ...thread, status, completedAt: action.actionTs }
        : thread,
    ),
    updatedAt: action.actionTs,
    evidence: [
      ...card.evidence,
      previewBoardEvidence(
        action,
        outcome,
        action.summary ?? `Thread ${status}.`,
        activeClaim.threadId,
      ),
    ],
  });
}

function applyPreviewTestingVerdict(
  snapshot: PreviewSnapshot,
  action: Extract<PreviewBoardAction, { type: "board.card.testing_verdict" }>,
): PreviewSnapshot {
  const card = snapshot.board.cards[action.cardId];
  if (card?.activeClaim?.kind !== "testing") {
    return snapshot;
  }
  const activeClaim = card.activeClaim;
  const passed = action.testingVerdict === "pass";
  const targetLane = passed ? "done" : "planned";
  return replacePreviewBoardCard(snapshot, {
    ...card,
    lane: targetLane,
    order: nextPreviewLaneOrder(snapshot.board, targetLane, card.id),
    activeClaim: undefined,
    threads: card.threads.map((thread) =>
      thread.threadId === activeClaim.threadId
        ? {
            ...thread,
            status: passed ? "completed" : "failed",
            completedAt: action.actionTs,
          }
        : thread,
    ),
    updatedAt: action.actionTs,
    evidence: [
      ...card.evidence,
      previewBoardEvidence(
        action,
        passed ? "verdict_pass" : "verdict_fail",
        action.summary ?? `Testing ${action.testingVerdict}.`,
        activeClaim.threadId,
      ),
    ],
  });
}

function replacePreviewBoard(
  snapshot: PreviewSnapshot,
  board: PreviewBoard,
): PreviewSnapshot {
  return {
    ...snapshot,
    board: { ...board, boardVersion: snapshot.board.boardVersion + 1 },
  };
}

function replacePreviewBoardCard(
  snapshot: PreviewSnapshot,
  card: PreviewBoardCard,
): PreviewSnapshot {
  return replacePreviewBoard(snapshot, {
    ...snapshot.board,
    cards: { ...snapshot.board.cards, [card.id]: card },
  });
}

function previewLaneCards(
  board: PreviewBoard,
  lane: PreviewBoardCard["lane"],
): PreviewBoardCard[] {
  return Object.values(board.cards)
    .filter((card) => card.lane === lane)
    .sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    );
}

function nextPreviewLaneOrder(
  board: PreviewBoard,
  lane: PreviewBoardCard["lane"],
  excludeCardId?: string,
): number {
  return (
    previewLaneCards(board, lane)
      .filter((card) => card.id !== excludeCardId)
      .reduce((highest, card) => Math.max(highest, card.order), 0) + 1
  );
}

function previewBoardEvidence(
  action: PreviewBoardAction,
  outcome: PreviewBoardCard["evidence"][number]["outcome"],
  summary: string,
  threadId?: string,
): PreviewBoardCard["evidence"][number] {
  return {
    id: `${action.actionId}:${outcome}`,
    timestamp: action.actionTs,
    source: action.source ?? "operator",
    outcome,
    summary,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}
