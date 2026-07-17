import type { RuntimeSettingsFile } from "../config/RuntimeSettings.js";
import type { DiagnosticLogStore } from "../diagnostics/DiagnosticLogStore.js";
import type { HistoryStore } from "../history/HistoryStore.js";
import type { UiStateStore } from "../ink/persistence/UiStateStore.js";
import type { UiStore } from "../ink/store/UiStore.js";
import type { createUiDerivedSelectors } from "../ink/store/selectors.js";
import type { ProtocolClient } from "../client/ProtocolClient.js";
import type { ProfileStore } from "../config/ProfileStore.js";
import type { RunnerCommandMetadata } from "../protocol/contracts.js";
import type {
  AppView,
  NormalizedOutput,
  ResolvedWorkspace,
  SessionsFile,
  TuiProfile,
  TuiSessionMeta,
  TranscriptLine,
} from "../contracts.js";
import type { SessionStore } from "../session/SessionStore.js";
import type { WorkspaceStore } from "../workspace/WorkspaceStore.js";
import type { LocalCoreClient } from "../../src/localCore/client.js";

export interface TuiAppOptions {
  cwd: string;
  profileId?: string | undefined;
  sessionName?: string | undefined;
  freshSessionName?: string | undefined;
  kestrelHome?: string | undefined;
  scripted?: boolean;
}

export interface TuiAppContext {
  readonly options: TuiAppOptions;
  readonly profileStore: ProfileStore;
  readonly sessionStore: SessionStore;
  readonly workspaceStore: WorkspaceStore;
  readonly historyStore: HistoryStore;
  readonly diagnosticsStore: DiagnosticLogStore;
  readonly uiStateStore: UiStateStore;
  readonly client: ProtocolClient;
  readonly uiStore: UiStore;
  readonly selectors: ReturnType<typeof createUiDerivedSelectors>;
  getRuntimeSettings(): RuntimeSettingsFile;
  getLocalCoreClient?(): LocalCoreClient | undefined;
  getSessionsFile(): SessionsFile;
  setSessionsFile(sessionsFile: SessionsFile): void;
  getActiveWorkspace(): ResolvedWorkspace | undefined;
  setActiveWorkspace(workspace: ResolvedWorkspace | undefined): void;
  getLaunchWorkspace(): ResolvedWorkspace | undefined;
  setLaunchWorkspace(workspace: ResolvedWorkspace | undefined): void;
  appendHistoryLine(
    role: TranscriptLine["role"],
    text: string,
    data?: Record<string, unknown> | undefined,
    output?: NormalizedOutput | undefined,
  ): Promise<void>;
  persistSessionAndUi(): Promise<void>;
  persistUiState(): Promise<void>;
  persistActiveProfile(profile: TuiProfile): Promise<void>;
  getActiveRunnerMetadata(): RunnerCommandMetadata;
  setActiveSessionState(patch: Partial<TuiSessionMeta>): Promise<void>;
  navigateToView(view: AppView, options?: { remember?: boolean | undefined }): void;
  withMcpSummary(statusLine: string): string;
  recordPersistenceFailure(scope: string, error: unknown): void;
}
