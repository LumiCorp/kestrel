import path from "node:path";

import { preflightDatabaseConnection } from "../../src/runtime/databasePreflight.js";
import { resolveKestrelHomePath } from "../../src/runtime/kestrelHome.js";
import { attemptLocalDatabaseSelfHeal } from "../../src/runtime/localDatabaseSelfHeal.js";
import {
  alignExecutionPolicyWithMode,
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  formatUserFacingModeLabel,
  normalizeInteractionMode,
} from "../../src/index.js";
import { loadShellAndDotEnv } from "../config/EnvLoader.js";
import { ProfileStore } from "../config/ProfileStore.js";
import { readRuntimeSettings, type RuntimeSettingsFile } from "../config/RuntimeSettings.js";
import { DiagnosticLogStore } from "../diagnostics/DiagnosticLogStore.js";
import { HistoryStore } from "../history/HistoryStore.js";
import { UiStateStore } from "../ink/persistence/UiStateStore.js";
import { buildInitialUiRuntimeState, UiStore } from "../ink/store/UiStore.js";
import { DEFAULT_THEME_MODE, resolveThemeSelection, type ThemeMode } from "../ink/theme/tokens.js";
import { SessionStore } from "../session/SessionStore.js";
import { WorkspaceStore } from "../workspace/WorkspaceStore.js";
import {
  describeResolvedWorkspace,
  resolveWorkspaceFromBinding,
  resolveWorkspaceFromCwd,
} from "../workspace/WorkspaceResolver.js";
import {
  decorateOperatorAffordance,
} from "../runtime/operatorAffordances.js";
import type {
  ResolvedWorkspace,
  SessionsFile,
  SplashPreflightState,
  TranscriptLine,
  TuiProfile,
  TuiSessionMeta,
  UiState,
} from "../contracts.js";
import {
  formatOperatorLaunchSummary,
  resolveOperatorStartTask,
  type OperatorResolvedStartTask,
} from "../../src/operatorShell.js";
import type { TuiAppOptions } from "./TuiAppContext.js";
import { shouldKeepEnvironmentDatabaseUrl } from "../localCoreEnv.js";
import { ensureCliLocalCoreReady, type CliLocalCoreStatus } from "../localCoreShell.js";

const PREFERRED_DOT_ENV_KEYS = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_VERSION",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_APP_NAME",
  "TAVILY_API_KEY",
  "TAVILY_BASE_URL",
  "TAVILY_PROJECT",
  "TAVILY_HTTP_PROXY",
  "TAVILY_HTTPS_PROXY",
] as const;

export interface TuiBootstrapResult {
  home: string;
  profileStore: ProfileStore;
  sessionStore: SessionStore;
  workspaceStore: WorkspaceStore;
  historyStore: HistoryStore;
  diagnosticsStore: DiagnosticLogStore;
  uiStateStore: UiStateStore;
  runtimeSettings: RuntimeSettingsFile;
  sessionsFile: SessionsFile;
  launchWorkspace?: ResolvedWorkspace | undefined;
  activeWorkspace?: ResolvedWorkspace | undefined;
  activeProfile: TuiProfile;
  activeSession: TuiSessionMeta;
  transcript: TranscriptLine[];
  persistedUi?: Partial<UiState> | undefined;
  splashPreflight: SplashPreflightState;
  uiStore: UiStore;
  startupNotices: string[];
  localCoreStatus: CliLocalCoreStatus;
  runnerTransportEnv: NodeJS.ProcessEnv;
}

export async function bootstrapTuiApp(options: TuiAppOptions): Promise<TuiBootstrapResult> {
  await loadShellAndDotEnv(options.cwd, {
    preferDotEnvKeys: [...PREFERRED_DOT_ENV_KEYS],
  });

  const localCoreEnv = options.kestrelHome !== undefined
    ? {
        ...process.env,
        KESTREL_HOME: options.kestrelHome,
        KESTREL_CORE_HOME: undefined,
      }
    : process.env;
  const localCoreStatus = await ensureCliLocalCoreReady({ env: localCoreEnv });
  const home = options.kestrelHome ?? localCoreStatus.home.homePath ?? resolveKestrelHomePath();
  const profileStore = new ProfileStore(home);
  const sessionStore = new SessionStore(home);
  const workspaceStore = new WorkspaceStore(home);
  const historyStore = new HistoryStore(home);
  const diagnosticsStore = new DiagnosticLogStore(home);
  const uiStateStore = new UiStateStore(home);
  const startupNotices: string[] = [];
  startupNotices.push(
    `Kestrel Local Core ${localCoreStatus.state}: ${localCoreStatus.home.homePath} (${localCoreStatus.home.source}${localCoreStatus.home.isolated ? ", isolated/dev" : ""}).`,
  );
  const runtimeSettings = await readRuntimeSettings(home);
  if (
    runtimeSettings.defaults.storeDriver !== undefined
    || runtimeSettings.defaults.sqlitePath !== undefined
  ) {
    startupNotices.push(
      "Legacy client database settings are ignored; Local Core owns persistence selection.",
    );
  }
  if (runtimeSettings.defaults.minimalMode === true) {
    startupNotices.push("Setup minimal mode is enabled (plan+safe defaults).");
  }

  const profiles = await profileStore.load();
  startupNotices.push(...profileStore.consumeLoadNotices());
  let sessionsFile = await sessionStore.load();
  sessionsFile = await hydrateSessionHistoryMetadata({
    historyStore,
    sessionsFile,
    profiles,
  });

  const launchWorkspaceResolution = await resolveWorkspaceFromCwd(options.cwd, workspaceStore);
  startupNotices.push(...launchWorkspaceResolution.notices);
  const launchWorkspace = launchWorkspaceResolution.workspace;
  const selection = await resolveInitialSelection({
    options,
    profiles,
    runtimeSettings,
    profileStore,
    sessionStore,
    workspaceStore,
    sessionsFile,
    launchWorkspace,
    startupNotices,
  });
  sessionsFile = selection.sessionsFile;

  const transcript = await historyStore.readTranscript(selection.session.sessionId);
  const persistedUi = deriveStartupPersistedUiState(options, await uiStateStore.load());
  const splashPreflight = buildSplashPreflightState({
    profile: selection.profile,
    session: selection.session,
    themeMode: persistedUi?.themeMode ?? DEFAULT_THEME_MODE,
  });
  const uiStore = new UiStore(
    buildInitialUiRuntimeState({
      profile: selection.profile,
      activeSession: selection.session,
      sessions: sessionsFile.sessions,
      transcript,
      persisted: persistedUi,
      splashPreflight,
    }),
  );

  return {
    home,
    profileStore,
    sessionStore,
    workspaceStore,
    historyStore,
    diagnosticsStore,
    uiStateStore,
    runtimeSettings,
    sessionsFile,
    launchWorkspace,
    activeWorkspace: selection.workspace,
    activeProfile: selection.profile,
    activeSession: selection.session,
    transcript,
    persistedUi,
    splashPreflight,
    uiStore,
    startupNotices,
    localCoreStatus,
    runnerTransportEnv: pickRunnerTransportEnvironment(localCoreEnv),
  };
}

function pickRunnerTransportEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    "KESTREL_RUNNER_SERVICE_URL",
    "KESTREL_RUNNER_SERVICE_TOKEN",
    "KESTREL_LOCAL_CORE_API_SOCKET",
    "KESTREL_LOCAL_CORE_API_TOKEN",
  ] as const;
  const selected: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined) {
      selected[key] = value;
    }
  }
  return selected;
}

export function deriveStartupPersistedUiState(
  options: Pick<TuiAppOptions, "scripted" | "freshSessionName">,
  persisted: Partial<UiState> | undefined,
): Partial<UiState> | undefined {
  if (options.scripted !== true || options.freshSessionName === undefined) {
    return persisted;
  }
  return {
    ...(persisted ?? {}),
    activeView: "chat",
    activeRegion: "composer",
  };
}

export async function runSplashDatabasePreflight(input: {
  setSummary(summary: string): void;
  updateCheck(
    id: string,
    update: { state?: "pending" | "running" | "ok" | "warn" | "fail" | "skip"; detail?: string | undefined },
  ): void;
  truncateDetail(value: string): string;
  env?: NodeJS.ProcessEnv | undefined;
  autoStart?: (() => Promise<{ ok: boolean; detail: string }>) | undefined;
  selfHealDefaultEnabled?: boolean | undefined;
  localCoreStatus?: CliLocalCoreStatus | undefined;
  requireDatabaseUrl?: boolean | undefined;
}): Promise<void> {
  const env = input.env ?? process.env;
  input.setSummary("checking database");
  input.updateCheck("database", {
    state: "running",
    detail: "probing",
  });

  if (input.requireDatabaseUrl !== true && input.localCoreStatus?.state === "blocked") {
    const message = formatLocalCoreDatabaseBlockedMessage(input.localCoreStatus);
    input.updateCheck("database", {
      state: "fail",
      detail: input.truncateDetail(message),
    });
    throw new SplashPreflightError("database", message);
  }

  if (input.requireDatabaseUrl !== true && input.localCoreStatus?.state === "healthy") {
    input.updateCheck("database", {
      state: "ok",
      detail: `Local Core ${input.localCoreStatus.dbMode} at ${input.localCoreStatus.home.homePath}`,
    });
    return;
  }

  const databaseUrl = readEnvValue("DATABASE_URL", env);
  if (input.requireDatabaseUrl !== true && shouldKeepEnvironmentDatabaseUrl(env) === false) {
    input.updateCheck("database", {
      state: input.localCoreStatus?.state === "blocked" ? "fail" : "ok",
      detail: input.localCoreStatus !== undefined
        ? `Local Core ${input.localCoreStatus.dbMode} at ${input.localCoreStatus.home.homePath}`
        : "Local Core default",
    });
    if (input.localCoreStatus?.state === "blocked") {
      throw new SplashPreflightError("database", input.localCoreStatus.summary);
    }
    return;
  }
  if (databaseUrl.length === 0) {
    const message = "missing DATABASE_URL";
    input.updateCheck("database", {
      state: "fail",
      detail: message,
    });
    throw new SplashPreflightError("database", message);
  }

  const result = await preflightDatabaseConnection({
    descriptor: {
      databaseUrl,
      databaseUrlSource: "environment",
    },
    env,
    selfHealEnvValue: env.KCHAT_DB_SELF_HEAL,
    selfHealDefaultEnabled: input.selfHealDefaultEnabled ?? true,
    allowAutoStart: true,
    autoStart: input.autoStart ?? attemptLocalDatabaseSelfHeal,
    timeoutMs: 1200,
    retryTimeoutMs: 2500,
  });
  if (result.ok) {
    input.updateCheck("database", {
      state: "ok",
      detail: `${result.target.host}:${result.target.port}/${result.target.database}`,
    });
    return;
  }

  const detail = result.failure.autoStartAttempted === true
    ? `auto-start failed: ${result.failure.autoStartResult ?? result.failure.message}`
    : result.failure.message;
  input.updateCheck("database", {
    state: "fail",
    detail: input.truncateDetail(detail),
  });
  throw new SplashPreflightError("database", result.failure.message);
}

class SplashPreflightError extends Error {
  readonly checkId: string;

  constructor(checkId: string, message: string) {
    super(message);
    this.name = "SplashPreflightError";
    this.checkId = checkId;
  }
}

function formatLocalCoreDatabaseBlockedMessage(status: CliLocalCoreStatus): string {
  const code = status.lastError?.code;
  const base = code !== undefined ? `${status.summary} (${code})` : status.summary;
  if (code === "LOCAL_CORE_POSTGRES_BUNDLE_ROOT_REQUIRED" || code === "LOCAL_CORE_POSTGRES_BUNDLE_MISSING") {
    return `${base}. Source checkout runs need KESTREL_LOCAL_CORE_POSTGRES_BUNDLE pointing at apps/desktop/resources/postgres-bundle; packaged installs should include postgres-bundle in installed resources.`;
  }
  return base;
}

function buildSplashPreflightState(input: {
  profile: TuiProfile;
  session: TuiSessionMeta;
  themeMode: ThemeMode;
}): SplashPreflightState {
  const themeSelection = resolveThemeSelection({
    mode: input.themeMode,
    overrides: input.profile.theme,
  });
  return {
    phase: "running",
    summary: "pre-flight checks in progress",
    checks: [
      { id: "profiles", label: "profiles", state: "ok", detail: input.profile.id },
      { id: "session", label: "session", state: "ok", detail: input.session.name },
      { id: "theme", label: "theme", state: "ok", detail: `${themeSelection.mode}:${themeSelection.resolvedMode}` },
      { id: "runner", label: "runner", state: "pending", detail: "waiting" },
      { id: "handshake", label: "handshake", state: "pending", detail: input.session.sessionId },
      { id: "database", label: "database", state: "pending", detail: "waiting" },
      { id: "provider", label: "credentials", state: "pending", detail: input.profile.modelProvider ?? "openrouter" },
      { id: "mcp", label: "mcp", state: "pending", detail: "waiting" },
    ],
  };
}

async function hydrateSessionHistoryMetadata(input: {
  historyStore: HistoryStore;
  sessionsFile: SessionsFile;
  profiles: TuiProfile[];
}): Promise<SessionsFile> {
  const overviews = await input.historyStore.readSessionOverviews(
    input.sessionsFile.sessions.map((session) => session.sessionId),
  );
  return {
    ...input.sessionsFile,
    sessions: input.sessionsFile.sessions.map((session) => {
      const overview = overviews[session.sessionId];
      const profile = input.profiles.find((candidate) => candidate.id === session.profileId);
      return {
        ...session,
        ...(profile?.label !== undefined ? { profileLabel: profile.label } : {}),
        ...(session.workspaceLabel === undefined ? { workspaceLabel: describeSessionWorkspaceLabel(session) } : {}),
        ...(overview?.launchSummary !== undefined && session.launchSummary === undefined
          ? { launchSummary: overview.launchSummary }
          : {}),
        ...(overview?.lastPreview !== undefined && session.lastMessagePreview === undefined
          ? { lastMessagePreview: overview.lastPreview }
          : {}),
        ...(overview !== undefined
          ? {
              hasArtifacts: overview.hasArtifacts,
              hasSummary: overview.hasSummary,
            }
          : {}),
      };
    }),
  };
}

async function resolveInitialSelection(input: {
  options: TuiAppOptions;
  profiles: TuiProfile[];
  runtimeSettings: RuntimeSettingsFile;
  profileStore: ProfileStore;
  sessionStore: SessionStore;
  workspaceStore: WorkspaceStore;
  sessionsFile: SessionsFile;
  launchWorkspace?: ResolvedWorkspace | undefined;
  startupNotices: string[];
}): Promise<{
  profile: TuiProfile;
  session: TuiSessionMeta;
  workspace?: ResolvedWorkspace | undefined;
  sessionsFile: SessionsFile;
}> {
  if (input.options.freshSessionName !== undefined) {
    const selectedWorkspace = input.launchWorkspace;
    const resolvedProfile = await resolveProfileForStartup({
      ...input,
      workspace: selectedWorkspace,
    });
    const sessionName = buildUniqueSessionName(input.sessionStore, input.sessionsFile, input.options.freshSessionName);
    const initialLaunch = resolveOperatorStartTask({
      title: sessionName,
      workspaceBinding: selectedWorkspace !== undefined ? "active" : "detached",
      workspaceId: selectedWorkspace?.manifest.workspaceId,
      workspaceLabel: describeResolvedWorkspace(selectedWorkspace),
      workspaceRoot: selectedWorkspace?.rootPath,
      defaultProfileId: resolvedProfile.id,
      defaultProfileLabel: resolvedProfile.label,
      defaultInteractionMode: resolvedProfile.defaultInteractionMode,
      defaultActSubmode: resolvedProfile.defaultActSubmode,
      requireTitle: true,
    });
    const created = createSessionMeta(initialLaunch, resolvedProfile, selectedWorkspace);
    let sessionsFile = input.sessionStore.upsert(input.sessionsFile, created);
    sessionsFile = input.sessionStore.setActive(sessionsFile, created.name);
    await input.sessionStore.save(sessionsFile);
    input.startupNotices.push(`Started fresh session '${created.name}'.`);
    return {
      profile: resolvedProfile,
      session: created,
      workspace: selectedWorkspace,
      sessionsFile,
    };
  }

  const requestedSessionResolution =
    input.options.sessionName !== undefined
      ? input.sessionStore.resolveSelector(input.sessionsFile, input.options.sessionName)
      : undefined;
  const requestedSession = requestedSessionResolution?.status === "matched"
    ? requestedSessionResolution.session
    : undefined;
  if (input.options.sessionName !== undefined && requestedSessionResolution?.status === "ambiguous") {
    input.startupNotices.push(
      `Session id fragment '${input.options.sessionName}' matched multiple sessions; restored the active session instead.`,
    );
  } else if (input.options.sessionName !== undefined && requestedSessionResolution?.status === "not_found") {
    input.startupNotices.push(
      `Session '${input.options.sessionName}' was not found; restored the active session instead.`,
    );
  }
  const activeSession = requestedSession ?? input.sessionStore.getActive(input.sessionsFile);
  const boundWorkspace = activeSession === undefined
    ? undefined
    : await resolveWorkspaceForSession(activeSession, input.workspaceStore, input.startupNotices);
  const explicitDetachedWorkspace = activeSession?.workspaceBinding === "detached";
  const sessionHasWorkspaceBinding =
    activeSession?.workspaceId !== undefined ||
    activeSession?.workspaceRoot !== undefined;
  const staleSessionWorkspaceBinding =
    activeSession !== undefined &&
    explicitDetachedWorkspace === false &&
    sessionHasWorkspaceBinding &&
    boundWorkspace === undefined;
  const startupWorkspaceConflict =
    requestedSession === undefined &&
    activeSession !== undefined &&
    boundWorkspace !== undefined &&
    input.launchWorkspace !== undefined &&
    path.resolve(boundWorkspace.rootPath) !== path.resolve(input.launchWorkspace.rootPath);
  const selectedWorkspace = explicitDetachedWorkspace
    ? undefined
    : startupWorkspaceConflict || staleSessionWorkspaceBinding
      ? input.launchWorkspace
      : (boundWorkspace ?? input.launchWorkspace);

  const resolvedProfile = await resolveProfileForStartup({
    ...input,
    session: activeSession,
    workspace: selectedWorkspace,
  });

  if (activeSession !== undefined) {
    if (startupWorkspaceConflict && selectedWorkspace !== undefined) {
      const sessionName = buildUniqueSessionName(
        input.sessionStore,
        input.sessionsFile,
        buildStartupWorkspaceSessionTitle(selectedWorkspace),
      );
      const startupLaunch = resolveOperatorStartTask({
        title: sessionName,
        workspaceBinding: "active",
        workspaceId: selectedWorkspace.manifest.workspaceId,
        workspaceLabel: describeResolvedWorkspace(selectedWorkspace),
        workspaceRoot: selectedWorkspace.rootPath,
        defaultProfileId: resolvedProfile.id,
        defaultProfileLabel: resolvedProfile.label,
        defaultInteractionMode: resolvedProfile.defaultInteractionMode,
        defaultActSubmode: resolvedProfile.defaultActSubmode,
        requireTitle: true,
      });
      const created = createSessionMeta(startupLaunch, resolvedProfile, selectedWorkspace);
      const sessionsFile = input.sessionStore.upsert(input.sessionsFile, created);
      await input.sessionStore.save(sessionsFile);
      input.startupNotices.push(
        `Started new session '${created.name}' because launch workspace '${selectedWorkspace.manifest.workspaceId}' differed from restored session workspace '${boundWorkspace.manifest.workspaceId}'.`,
      );
      return {
        profile: resolvedProfile,
        session: created,
        workspace: selectedWorkspace,
        sessionsFile,
      };
    }

    const normalized = normalizeSessionMode(activeSession, resolvedProfile);
    const shouldBindLaunchWorkspace =
      explicitDetachedWorkspace === false &&
      input.launchWorkspace !== undefined &&
      (
        (normalized.workspaceId === undefined && normalized.workspaceRoot === undefined) ||
        staleSessionWorkspaceBinding
      );
    const workspaceBound = explicitDetachedWorkspace
      ? {
          ...normalized,
          workspaceBinding: "detached" as const,
          workspaceId: undefined,
          workspaceRoot: undefined,
          workspaceLabel: "Detached workspace",
        }
      : shouldBindLaunchWorkspace
      ? {
          ...normalized,
          workspaceBinding: "active" as const,
          workspaceId: input.launchWorkspace!.manifest.workspaceId,
          workspaceRoot: input.launchWorkspace!.rootPath,
          workspaceLabel: describeResolvedWorkspace(input.launchWorkspace),
        }
      : normalized;
    const patched =
      workspaceBound.profileId === resolvedProfile.id
        ? workspaceBound
        : {
            ...workspaceBound,
            profileId: resolvedProfile.id,
          };

    let sessionsFile = input.sessionsFile;
    if (patched !== activeSession) {
      if (normalized !== activeSession) {
        input.startupNotices.push(
          `Normalized session '${activeSession.name}' to explicit mode '${formatSessionMode(normalized)}'.`,
        );
      }
      if (shouldBindLaunchWorkspace) {
        const workspaceId = input.launchWorkspace?.manifest.workspaceId;
        input.startupNotices.push(staleSessionWorkspaceBinding
          ? `Workspace binding for session '${activeSession.name}' was stale; bound to launch workspace '${workspaceId}'.`
          : `Bound session '${activeSession.name}' to workspace '${workspaceId}'.`);
      }
      sessionsFile = input.sessionStore.upsert(sessionsFile, patched);
    }
    if (requestedSession !== undefined) {
      sessionsFile = input.sessionStore.setActive(sessionsFile, requestedSession.name);
    }
    await input.sessionStore.save(sessionsFile);
    return {
      profile: resolvedProfile,
      session: patched,
      workspace: explicitDetachedWorkspace ? undefined : shouldBindLaunchWorkspace ? input.launchWorkspace : selectedWorkspace,
      sessionsFile,
    };
  }

  const initialLaunch = resolveOperatorStartTask({
    title: "default",
    workspaceBinding: selectedWorkspace !== undefined ? "active" : "detached",
    workspaceId: selectedWorkspace?.manifest.workspaceId,
    workspaceLabel: describeResolvedWorkspace(selectedWorkspace),
    workspaceRoot: selectedWorkspace?.rootPath,
    defaultProfileId: resolvedProfile.id,
    defaultProfileLabel: resolvedProfile.label,
    defaultInteractionMode: resolvedProfile.defaultInteractionMode,
    defaultActSubmode: resolvedProfile.defaultActSubmode,
    requireTitle: true,
  });
  const created = createSessionMeta(initialLaunch, resolvedProfile, selectedWorkspace);
  const sessionsFile = input.sessionStore.upsert(input.sessionsFile, created);
  await input.sessionStore.save(sessionsFile);
  return {
    profile: resolvedProfile,
    session: created,
    workspace: selectedWorkspace,
    sessionsFile,
  };
}

async function resolveProfileForStartup(input: {
  options: TuiAppOptions;
  profiles: TuiProfile[];
  runtimeSettings: RuntimeSettingsFile;
  profileStore: ProfileStore;
  session?: TuiSessionMeta | undefined;
  workspace?: ResolvedWorkspace | undefined;
  startupNotices: string[];
}): Promise<TuiProfile> {
  if (input.options.profileId !== undefined) {
    const explicit = input.profileStore.findById(input.profiles, input.options.profileId);
    if (explicit === undefined) {
      throw new Error(`Profile '${input.options.profileId}' not found`);
    }
    return explicit;
  }

  if (input.session !== undefined) {
    const sessionProfile = input.profileStore.findById(input.profiles, input.session.profileId);
    if (sessionProfile !== undefined) {
      return sessionProfile;
    }
    input.startupNotices.push(
      `Session profile '${input.session.profileId}' not found. Falling back to defaults.`,
    );
  }

  const settingsProfileId = input.runtimeSettings.defaults.profileId;
  if (settingsProfileId !== undefined) {
    const settingsProfile = input.profileStore.findById(input.profiles, settingsProfileId);
    if (settingsProfile !== undefined) {
      return applyRuntimeSettingsProfileDefaults(settingsProfile, input.runtimeSettings);
    }
    input.startupNotices.push(
      `Setup default profile '${settingsProfileId}' not found. Falling back to configured default profile.`,
    );
  }

  return applyRuntimeSettingsProfileDefaults(input.profileStore.getDefault(input.profiles), input.runtimeSettings);
}

function applyRuntimeSettingsProfileDefaults(
  profile: TuiProfile,
  runtimeSettings: RuntimeSettingsFile,
): TuiProfile {
  const defaults = runtimeSettings.defaults;
  return {
    ...profile,
    ...(defaults.approvalPolicyPackId !== undefined
      ? { approvalPolicyPackId: defaults.approvalPolicyPackId }
      : {}),
    ...(defaults.minimalMode === true
      ? {
          defaultInteractionMode: "plan" as const,
          defaultActSubmode: "safe" as const,
        }
      : {}),
  };
}

async function resolveWorkspaceForSession(
  session: TuiSessionMeta,
  workspaceStore: WorkspaceStore,
  startupNotices: string[],
): Promise<ResolvedWorkspace | undefined> {
  const resolved = await resolveWorkspaceFromBinding({
    workspaceId: session.workspaceId,
    workspaceRoot: session.workspaceRoot,
  }, workspaceStore);
  startupNotices.push(...resolved.notices);
  return resolved.workspace;
}

function buildStartupWorkspaceSessionTitle(workspace: ResolvedWorkspace): string {
  const basename = path.basename(workspace.rootPath).trim();
  return basename.length > 0 ? `default-${basename}` : `default-${workspace.manifest.workspaceId}`;
}

function buildUniqueSessionName(
  sessionStore: SessionStore,
  sessionsFile: SessionsFile,
  baseName: string,
): string {
  if (sessionStore.findByName(sessionsFile, baseName) === undefined) {
    return baseName;
  }
  let index = 2;
  while (sessionStore.findByName(sessionsFile, `${baseName}-${index}`) !== undefined) {
    index += 1;
  }
  return `${baseName}-${index}`;
}

function createSessionMeta(
  launch: OperatorResolvedStartTask,
  profile: TuiProfile,
  workspace?: ResolvedWorkspace | undefined,
): TuiSessionMeta {
  const now = new Date().toISOString();
  const slug = slugify(launch.title);
  const sessionId = `${profile.sessionPrefix}-${slug}-${Date.now()}`;
  const modeResolution = normalizeInteractionMode({
    interactionMode: launch.interactionMode,
    actSubmode: launch.actSubmode,
    defaultInteractionMode: DEFAULT_INTERACTION_MODE,
    defaultActSubmode: DEFAULT_ACT_SUBMODE,
  });
  const session: TuiSessionMeta = {
    name: launch.title,
    sessionId,
    profileId: profile.id,
    profileLabel: profile.label,
    ...(launch.presetId !== undefined ? { launchPresetId: launch.presetId } : {}),
    ...(launch.templateId !== undefined ? { launchTemplateId: launch.templateId } : {}),
    workspaceBinding: launch.workspace.binding,
    ...(workspace !== undefined ? { workspaceId: workspace.manifest.workspaceId } : {}),
    ...(workspace !== undefined ? { workspaceRoot: workspace.rootPath } : {}),
    workspaceLabel: launch.workspace.label,
    createdAt: now,
    updatedAt: now,
    interactionMode: modeResolution.interactionMode,
    ...(modeResolution.actSubmode !== undefined ? { actSubmode: modeResolution.actSubmode } : {}),
    executionPolicy: alignExecutionPolicyWithMode({
      executionPolicy: undefined,
      interactionMode: modeResolution.interactionMode,
      actSubmode: modeResolution.actSubmode,
    }),
    started: false,
    launchSummary: formatOperatorLaunchSummary(launch),
    hasArtifacts: false,
    hasSummary: false,
    autoCompactionEnabled: true,
  };
  return {
    ...session,
    operatorState: decorateOperatorAffordance({
      base: session.operatorState,
      runtimeAuthoritative: false,
      profile,
      session,
    }),
  };
}

function normalizeSessionMode(session: TuiSessionMeta, profile: TuiProfile): TuiSessionMeta {
  const resolved = normalizeInteractionMode({
    interactionMode: session.interactionMode ?? profile.defaultInteractionMode,
    actSubmode: session.actSubmode ?? profile.defaultActSubmode,
    defaultInteractionMode: profile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
    defaultActSubmode: profile.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
  });
  const alignedExecutionPolicy = alignExecutionPolicyWithMode({
    executionPolicy: session.executionPolicy,
    interactionMode: resolved.interactionMode,
    actSubmode: resolved.actSubmode,
  });
  const changed =
    session.interactionMode !== resolved.interactionMode ||
    (session.actSubmode ?? undefined) !== (resolved.actSubmode ?? undefined) ||
    session.executionPolicy !== alignedExecutionPolicy ||
    session.autoCompactionEnabled === undefined;
  if (changed === false) {
    return session;
  }
  return {
    ...session,
    interactionMode: resolved.interactionMode,
    autoCompactionEnabled: session.autoCompactionEnabled ?? true,
    ...(resolved.actSubmode !== undefined ? { actSubmode: resolved.actSubmode } : { actSubmode: undefined }),
    ...(alignedExecutionPolicy !== undefined ? { executionPolicy: alignedExecutionPolicy } : {}),
  };
}

function formatSessionMode(session: Pick<TuiSessionMeta, "interactionMode" | "actSubmode">): string {
  return formatUserFacingModeLabel({
    interactionMode: session.interactionMode ?? DEFAULT_INTERACTION_MODE,
    actSubmode: session.actSubmode ?? DEFAULT_ACT_SUBMODE,
  });
}

function readEnvValue(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return typeof env[name] === "string" ? env[name]?.trim() ?? "" : "";
}

function describeSessionWorkspaceLabel(session: TuiSessionMeta): string {
  if (session.workspaceLabel !== undefined && session.workspaceLabel.trim().length > 0) {
    return session.workspaceLabel;
  }
  if (session.workspaceId !== undefined) {
    return `workspace=${session.workspaceId}`;
  }
  if (session.workspaceRoot !== undefined) {
    return session.workspaceRoot;
  }
  return "Detached workspace";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : "session";
}
