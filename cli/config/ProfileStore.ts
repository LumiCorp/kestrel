import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  CodeModeProfileConfig,
} from "../../src/code/contracts.js";
import {
  DEFAULT_CODE_MODE_DISABLED_CONFIG,
} from "../../src/code/contracts.js";
import type {
  DevShellProfileConfig,
} from "../../src/devshell/contracts.js";
import {
  DEFAULT_DEV_SHELL_DISABLED_CONFIG,
} from "../../src/devshell/contracts.js";
import type {
  GuardrailConfig,
} from "../../src/kestrel/contracts/execution.js";
import type {
  McpServerConfig,
} from "../../src/mcp/contracts.js";
import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
} from "../../src/mode/contracts.js";
import {
  ModelPolicyStore,
  resolveProfileWithModelPolicy,
} from "../../src/profile/modelPolicy.js";
import { resolveRuntimeProfileSelection } from "../../src/profile/runtimeProfile.js";
import type { ProfilesFile, ToolQueueProfileConfig, TuiProfile } from "../contracts.js";
import {
  isThemeTokenName,
  normalizeThemeColor,
  type ThemeOverrides,
} from "../ink/theme/tokens.js";
import { resolveKestrelHomePath } from "../../src/runtime/kestrelHome.js";
import { extractResponseField, resolveLocalCoreStoreClient } from "../localCoreStoreClient.js";

const PROFILE_FILE_NAME = "profiles.json";
const DEFAULT_PROFILE_GUARDRAILS: Partial<GuardrailConfig> = {
  maxStepVisits: 80,
};
const DEFAULT_PROFILE_TOOL_QUEUE: ToolQueueProfileConfig = {
  perRunConcurrency: 8,
  globalConcurrency: 24,
  maxQueuedJobsPerRun: 50,
  checkpointSize: 10,
  retryCount: 1,
};
const DEFAULT_DELEGATION_POLICY = {
  allowAgentSpawn: false,
  maxConcurrentChildSessions: 2,
  maxDepth: 2,
};
const DELEGATION_TOOL_NAMES = [
  "agent.spawn",
  "delegate.spawn_child",
  "delegate.list_children",
  "delegate.get_child_result",
] as const;
const KESTREL_ONE_PROFILE_ID = "kestrel-one";
const KESTREL_ONE_TOOL_NAME = "kestrel_one.search_knowledge_documents";

function createDefaultCliProfile(input: {
  id: string;
  label: string;
  sessionPrefix: string;
  default: boolean;
  extraToolAllowlist?: string[] | undefined;
}): TuiProfile {
  const resolved = resolveRuntimeProfileSelection({
    shellKind: "cli",
  });
  const toolAllowlist = [
    ...new Set([
      ...resolved.toolAllowlist,
      ...(input.extraToolAllowlist ?? []),
    ]),
  ];
  return {
    id: input.id,
    label: input.label,
    agent: "reference-react",
    sessionPrefix: input.sessionPrefix,
    shellKind: resolved.shellKind,
    presetId: resolved.presetId,
    capabilityPacks: [...resolved.capabilityPacks],
    storeDriver: "auto",
    approvalPolicyPackId: "dev",
    modeSystemV2Enabled: true,
    defaultInteractionMode: DEFAULT_INTERACTION_MODE,
    defaultActSubmode: DEFAULT_ACT_SUBMODE,
    toolAllowlist,
    mcpServers: [],
    toolQueue: { ...DEFAULT_PROFILE_TOOL_QUEUE },
    guardrails: { ...DEFAULT_PROFILE_GUARDRAILS },
    codeMode: resolved.codeMode,
    devShell: resolved.devShell,
    delegation: { ...DEFAULT_DELEGATION_POLICY },
    default: input.default,
  };
}

const DEFAULT_PROFILES: TuiProfile[] = [
  createDefaultCliProfile({
    id: "reference",
    label: "Reference React",
    sessionPrefix: "reference",
    default: true,
  }),
  createDefaultCliProfile({
    id: KESTREL_ONE_PROFILE_ID,
    label: "Kestrel-One",
    sessionPrefix: "kestrel-one",
    default: false,
    extraToolAllowlist: [KESTREL_ONE_TOOL_NAME],
  }),
];

const LEGACY_PROFILE_ALIASES: Readonly<Record<string, string>> = {
  "reference-openai": "reference",
  "reference-anthropic": "reference",
};

interface ParsedProfilesResult {
  profiles: TuiProfile[];
  migrated: boolean;
  notices: string[];
}

export class ProfileStore {
  private readonly baseDir: string;
  private readonly filePath: string;
  private readonly modelPolicyStore: ModelPolicyStore;
  private lastLoadNotices: string[] = [];

  constructor(baseDir = resolveKestrelHomePath()) {
    this.baseDir = baseDir;
    this.filePath = path.join(this.baseDir, PROFILE_FILE_NAME);
    this.modelPolicyStore = new ModelPolicyStore(baseDir);
  }

  async load(): Promise<TuiProfile[]> {
    this.lastLoadNotices = [];
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      const response = await core.client.getJson("/v1/profiles");
      const notices = typeof response === "object" && response !== null && Array.isArray(response) === false
        ? (response as { notices?: unknown }).notices
        : undefined;
      if (Array.isArray(notices)) {
        this.lastLoadNotices.push(...notices.filter((notice): notice is string => typeof notice === "string"));
      }
      return extractResponseField<TuiProfile[]>(response, "profiles", "profiles");
    }

    await mkdir(this.baseDir, { recursive: true });

    const raw = await this.readFile();
    if (raw === undefined) {
      const profiles = this.resolveProfilesWithSharedModelPolicy(DEFAULT_PROFILES);
      await this.save(profiles);
      return profiles;
    }

    let parsed: ParsedProfilesResult;
    try {
      parsed = parseProfilesFile(raw);
    } catch (error) {
      if (error instanceof ProfileSchemaVersionError) {
        const profiles = this.resolveProfilesWithSharedModelPolicy(DEFAULT_PROFILES);
        await this.save(profiles);
        return profiles;
      }
      throw error;
    }
    this.lastLoadNotices.push(...parsed.notices);

    if (parsed.profiles.length === 0) {
      const profiles = this.resolveProfilesWithSharedModelPolicy(DEFAULT_PROFILES);
      await this.save(profiles);
      return profiles;
    }

    const hydrated = parsed.profiles.map((profile) => {
      const normalized = applyProfileDefaults(profile);
      if (profile.agent === "reference-react" && profile.modeSystemV2Enabled !== true) {
        this.lastLoadNotices.push(
          `Migrated profile '${profile.id}' to mode-system v2 for the reference harness.`,
        );
      }
      return normalized;
    });
    const profiles = this.resolveProfilesWithSharedModelPolicy(ensureKestrelOneProfile(hydrated));
    if (parsed.migrated || profilesChanged(parsed.profiles, profiles)) {
      await this.save(profiles);
    }

    return profiles;
  }

  consumeLoadNotices(): string[] {
    const notices = [...this.lastLoadNotices];
    this.lastLoadNotices = [];
    return notices;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async save(profiles: TuiProfile[]): Promise<void> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      await core.client.putJson("/v1/profiles", { profiles });
      return;
    }

    const payload: ProfilesFile = {
      version: 3,
      profiles: profiles.map((profile) => sanitizeProfileForPersistence(profile)),
    };

    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  getDefault(profiles: TuiProfile[]): TuiProfile {
    const explicit = profiles.find((profile) => profile.default === true);
    if (explicit !== undefined) {
      return explicit;
    }

    const first = profiles[0];
    if (first === undefined) {
      throw new Error("No profiles configured");
    }

    return first;
  }

  findById(profiles: TuiProfile[], id: string): TuiProfile | undefined {
    const direct = profiles.find((profile) => profile.id === id);
    if (direct !== undefined) {
      return direct;
    }
    const canonicalId = LEGACY_PROFILE_ALIASES[id];
    return canonicalId === undefined
      ? undefined
      : profiles.find((profile) => profile.id === canonicalId);
  }

  private async readFile(): Promise<string | undefined> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  private resolveProfilesWithSharedModelPolicy(profiles: TuiProfile[]): TuiProfile[] {
    const modelPolicy = this.modelPolicyStore.read();
    return profiles.map((profile) => resolveProfileWithModelPolicy(profile, modelPolicy));
  }
}

export function parseProfilesFile(raw: string): ParsedProfilesResult {
  let decoded: unknown;
  const notices: string[] = [];

  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid profiles JSON: ${error instanceof Error ? error.message : "unknown parse error"}`,
    );
  }

  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("profiles.json must be an object");
  }

  const root = decoded as Record<string, unknown>;
  const version = root.version;
  if (version !== 2 && version !== 3) {
    throw new ProfileSchemaVersionError("profiles.json version must be 2 or 3");
  }

  const profiles = root.profiles;
  if (Array.isArray(profiles) === false) {
    throw new Error("profiles.json profiles must be an array");
  }

  const validated: TuiProfile[] = profiles.map((profile) => validateProfile(profile, version, notices));
  if (version === 2) {
    return {
      profiles: validated.map((profile) => ({
        ...profile,
        mcpServers: [],
      })),
      migrated: true,
      notices,
    };
  }

  return {
    profiles: validated,
    migrated: false,
    notices,
  };
}

function ensureKestrelOneProfile(profiles: TuiProfile[]): TuiProfile[] {
  if (profiles.some((profile) => profile.id === KESTREL_ONE_PROFILE_ID)) {
    return profiles;
  }
  const profile = DEFAULT_PROFILES.find((item) => item.id === KESTREL_ONE_PROFILE_ID);
  return profile === undefined ? profiles : [...profiles, { ...profile }];
}

class ProfileSchemaVersionError extends Error {}

function validateProfile(value: unknown, version: 2 | 3, notices: string[]): TuiProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("profile entries must be objects");
  }

  const item = value as Record<string, unknown>;
  const id = readRequiredString(item, "id");
  const label = readRequiredString(item, "label");
  const agent = readRequiredString(item, "agent");
  if (agent !== "reference-react") {
    throw new Error(`Unsupported profile agent '${agent}' for profile '${id}'`);
  }

  const sessionPrefix = readRequiredString(item, "sessionPrefix");
  const shellKind =
    item.shellKind === "cli" || item.shellKind === "web" || item.shellKind === "desktop"
      ? item.shellKind
      : undefined;
  const presetId =
    item.presetId === "cli_dev_local" ||
    item.presetId === "web_balanced" ||
    item.presetId === "desktop_dev_local"
      ? item.presetId
      : undefined;
  const capabilityPacks =
    Array.isArray(item.capabilityPacks) &&
    item.capabilityPacks.every(
      (entry) =>
        entry === "balanced" ||
        entry === "filesystem" ||
        entry === "dev_shell" ||
        entry === "sandbox_code",
    )
      ? item.capabilityPacks as Array<"balanced" | "filesystem" | "dev_shell" | "sandbox_code">
      : undefined;
  const modelProvider = parseModelProvider(item.modelProvider, id);
  const model = typeof item.model === "string" && item.model.trim().length > 0 ? item.model : undefined;
  const modelCredential = parseModelCredential(item.modelCredential, id);
  const storeDriver = parseStoreDriver(item.storeDriver, id);
  const approvalPolicyPackId = parseApprovalPolicyPackId(item.approvalPolicyPackId, id);
  const defaultInteractionMode = parseDefaultInteractionMode(item.defaultInteractionMode, id);
  const defaultActSubmode = parseDefaultActSubmode(item.defaultActSubmode, id);
  const modeSystemV2Enabled =
    typeof item.modeSystemV2Enabled === "boolean" ? item.modeSystemV2Enabled : undefined;
  const defaultFlag = typeof item.default === "boolean" ? item.default : undefined;
  const toolAllowlist =
    Array.isArray(item.toolAllowlist) && item.toolAllowlist.every((v) => typeof v === "string")
      ? (item.toolAllowlist as string[])
      : undefined;

  const guardrails = parseGuardrails(item.guardrails);
  const mcpServers = version === 3 ? parseMcpServers(item.mcpServers, id) : undefined;
  const toolQueue = version === 3 ? parseToolQueue(item.toolQueue, id) : undefined;
  const codeMode = version === 3 ? parseCodeMode(item.codeMode, id) : undefined;
  const devShell = version === 3 ? parseDevShell(item.devShell, id) : undefined;
  const agentStageConfig = version === 3 ? parseAgentStageConfig(item.agentStageConfig, id) : undefined;
  const modelTimeoutMs = version === 3 ? parseModelTimeoutMs(item.modelTimeoutMs, id) : undefined;
  const theme = version === 3 ? parseTheme(item.theme, id, notices) : undefined;
  const delegation = version === 3 ? parseDelegation(item.delegation) : undefined;

  return {
    id,
    label,
    agent: "reference-react",
    sessionPrefix,
    ...(shellKind !== undefined ? { shellKind } : {}),
    ...(presetId !== undefined ? { presetId } : {}),
    ...(capabilityPacks !== undefined ? { capabilityPacks } : {}),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(modelCredential !== undefined ? { modelCredential } : {}),
    ...(storeDriver !== undefined ? { storeDriver } : {}),
    ...(approvalPolicyPackId !== undefined ? { approvalPolicyPackId } : {}),
    ...(modeSystemV2Enabled !== undefined ? { modeSystemV2Enabled } : {}),
    ...(defaultInteractionMode !== undefined ? { defaultInteractionMode } : {}),
    ...(defaultActSubmode !== undefined ? { defaultActSubmode } : {}),
    ...(guardrails !== undefined ? { guardrails } : {}),
    ...(toolAllowlist !== undefined ? { toolAllowlist } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(toolQueue !== undefined ? { toolQueue } : {}),
    ...(codeMode !== undefined ? { codeMode } : {}),
    ...(devShell !== undefined ? { devShell } : {}),
    ...(agentStageConfig !== undefined ? { agentStageConfig } : {}),
    ...(modelTimeoutMs !== undefined ? { modelTimeoutMs } : {}),
    ...(delegation !== undefined ? { delegation } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(defaultFlag !== undefined ? { default: defaultFlag } : {}),
  };
}

export function applyProfileDefaults(profile: TuiProfile): TuiProfile {
  const guardrails: Partial<GuardrailConfig> = {
    ...DEFAULT_PROFILE_GUARDRAILS,
    ...(profile.guardrails ?? {}),
  };
  const hasCanonicalSelection =
    profile.shellKind !== undefined ||
    profile.presetId !== undefined ||
    profile.capabilityPacks !== undefined;
  const legacyExtraTools = Array.isArray(profile.toolAllowlist) ? [...profile.toolAllowlist] : undefined;
  const resolvedProfile = resolveRuntimeProfileSelection({
    shellKind: profile.shellKind ?? "cli",
    presetId: profile.presetId,
    capabilityPacks: profile.capabilityPacks,
    toolAllowlist: hasCanonicalSelection ? profile.toolAllowlist : undefined,
    codeMode: profile.codeMode,
    devShell: profile.devShell,
  });
  const codeMode = resolvedProfile.codeMode;
  const devShell = resolvedProfile.devShell;
  const toolAllowlist = [...resolvedProfile.toolAllowlist];
  if (profile.id === KESTREL_ONE_PROFILE_ID && toolAllowlist.includes(KESTREL_ONE_TOOL_NAME) === false) {
    toolAllowlist.push(KESTREL_ONE_TOOL_NAME);
  }
  if (hasCanonicalSelection === false && legacyExtraTools !== undefined) {
    for (const toolName of legacyExtraTools) {
      if (toolAllowlist.includes(toolName) === false) {
        toolAllowlist.push(toolName);
      }
    }
  }
  const delegation = {
    ...DEFAULT_DELEGATION_POLICY,
    ...(profile.delegation ?? {}),
  };
  if (delegation.allowAgentSpawn === true) {
    for (const name of DELEGATION_TOOL_NAMES) {
      if (toolAllowlist.includes(name) === false) {
        toolAllowlist.push(name);
      }
    }
  }

  return {
    ...profile,
    shellKind: resolvedProfile.shellKind,
    presetId: resolvedProfile.presetId,
    capabilityPacks: [...resolvedProfile.capabilityPacks],
    modelProvider: profile.modelProvider ?? "openrouter",
    storeDriver: profile.storeDriver ?? "auto",
    approvalPolicyPackId: profile.approvalPolicyPackId ?? "dev",
    modeSystemV2Enabled:
      profile.agent === "reference-react" ? true : (profile.modeSystemV2Enabled ?? false),
    defaultInteractionMode: profile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
    defaultActSubmode: profile.defaultActSubmode ?? DEFAULT_ACT_SUBMODE,
    guardrails,
    toolAllowlist,
    mcpServers: profile.mcpServers ?? [],
    toolQueue: {
      ...DEFAULT_PROFILE_TOOL_QUEUE,
      ...(profile.toolQueue ?? {}),
    },
    codeMode,
    devShell,
    delegation,
  };
}

function profilesChanged(before: TuiProfile[], after: TuiProfile[]): boolean {
  const normalize = (profiles: TuiProfile[]) => profiles.map((profile) => sanitizeProfileForPersistence(profile));
  return JSON.stringify(normalize(before)) !== JSON.stringify(normalize(after));
}

function sanitizeProfileForPersistence(profile: TuiProfile): TuiProfile {
  const persisted = structuredClone(profile);
  delete persisted.environmentShellKind;
  delete persisted.environmentPresetId;
  delete persisted.environmentCapabilityPackIds;
  delete persisted.modelProvider;
  delete persisted.model;
  delete persisted.modelCredential;
  delete persisted.modelCapabilities;
  delete persisted.agentStageConfig;
  delete persisted.modelTimeoutMs;
  return persisted;
}

function parseModelProvider(value: unknown, profileId: string): TuiProfile["modelProvider"] {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === "openrouter" ||
    value === "openai" ||
    value === "anthropic" ||
    value === "ollama" ||
    value === "lmstudio"
  ) {
    return value;
  }
  throw new Error(`Profile '${profileId}' has unsupported modelProvider '${String(value)}'`);
}

function parseModelCredential(
  value: unknown,
  profileId: string,
): TuiProfile["modelCredential"] {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Profile '${profileId}' modelCredential must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.source !== "kestrel-one" ||
    typeof candidate.gatewayId !== "string" ||
    candidate.gatewayId.trim().length === 0 ||
    typeof candidate.organizationId !== "string" ||
    candidate.organizationId.trim().length === 0 ||
    typeof candidate.rawModelId !== "string" ||
    candidate.rawModelId.trim().length === 0
  ) {
    throw new Error(`Profile '${profileId}' has invalid modelCredential`);
  }
  return {
    source: "kestrel-one",
    gatewayId: candidate.gatewayId.trim(),
    organizationId: candidate.organizationId.trim(),
    rawModelId: candidate.rawModelId.trim(),
  };
}

function parseStoreDriver(value: unknown, profileId: string): TuiProfile["storeDriver"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === "auto" || value === "postgres" || value === "sqlite") {
    return value;
  }
  throw new Error(
    `Profile '${profileId}' field 'storeDriver' must be auto, postgres, or sqlite`,
  );
}

function parseApprovalPolicyPackId(
  value: unknown,
  profileId: string,
): TuiProfile["approvalPolicyPackId"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === "dev" || value === "ci_bot" || value === "production") {
    return value;
  }
  throw new Error(
    `Profile '${profileId}' field 'approvalPolicyPackId' must be dev, ci_bot, or production`,
  );
}

function parseDelegation(value: unknown): TuiProfile["delegation"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const allowAgentSpawn =
    typeof record.allowAgentSpawn === "boolean" ? record.allowAgentSpawn : undefined;
  const maxConcurrentChildSessions =
    typeof record.maxConcurrentChildSessions === "number" &&
    Number.isFinite(record.maxConcurrentChildSessions)
      ? Math.max(1, Math.trunc(record.maxConcurrentChildSessions))
      : undefined;
  const maxDepth =
    typeof record.maxDepth === "number" && Number.isFinite(record.maxDepth)
      ? Math.max(0, Math.trunc(record.maxDepth))
      : undefined;

  return {
    ...(allowAgentSpawn !== undefined ? { allowAgentSpawn } : {}),
    ...(maxConcurrentChildSessions !== undefined
      ? { maxConcurrentChildSessions }
      : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  };
}

function parseAgentStageConfig(value: unknown, profileId: string): TuiProfile["agentStageConfig"] {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Profile '${profileId}' field 'agentStageConfig' must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.modelByStage === undefined) {
    return undefined;
  }
  if (typeof record.modelByStage !== "object" || record.modelByStage === null || Array.isArray(record.modelByStage)) {
    throw new Error(`Profile '${profileId}' field 'agentStageConfig.modelByStage' must be an object`);
  }
  const parsed: Record<string, string> = {};
  for (const [stageId, modelValue] of Object.entries(record.modelByStage as Record<string, unknown>)) {
    if (typeof modelValue !== "string") {
      throw new Error(`Profile '${profileId}' field 'agentStageConfig.modelByStage.${stageId}' must be a string`);
    }
    const trimmedStageId = stageId.trim();
    const trimmedModelValue = modelValue.trim();
    if (trimmedStageId.length === 0 || trimmedModelValue.length === 0) {
      continue;
    }
    parsed[trimmedStageId] = trimmedModelValue;
  }
  return {
    modelByStage: parsed,
  };
}

function parseModelTimeoutMs(value: unknown, profileId: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isInteger(value) === false || value <= 0) {
    throw new Error(`Profile '${profileId}' field 'modelTimeoutMs' must be a positive integer`);
  }
  return value;
}

function parseGuardrails(value: unknown): Partial<GuardrailConfig> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const maxStepsPerRun =
    typeof input.maxStepsPerRun === "number" ? input.maxStepsPerRun : undefined;
  const maxToolCallsPerRun =
    typeof input.maxToolCallsPerRun === "number" ? input.maxToolCallsPerRun : undefined;
  const maxModelCallsPerRun =
    typeof input.maxModelCallsPerRun === "number" ? input.maxModelCallsPerRun : undefined;
  const maxStepVisits =
    typeof input.maxStepVisits === "number" ? input.maxStepVisits : undefined;
  const maxConcurrentToolJobsPerRun =
    typeof input.maxConcurrentToolJobsPerRun === "number"
      ? input.maxConcurrentToolJobsPerRun
      : undefined;
  const maxConcurrentToolJobsGlobal =
    typeof input.maxConcurrentToolJobsGlobal === "number"
      ? input.maxConcurrentToolJobsGlobal
      : undefined;
  const maxQueuedToolJobsPerRun =
    typeof input.maxQueuedToolJobsPerRun === "number" ? input.maxQueuedToolJobsPerRun : undefined;
  const toolBatchCheckpointSize =
    typeof input.toolBatchCheckpointSize === "number" ? input.toolBatchCheckpointSize : undefined;
  const toolCallRetryCount =
    typeof input.toolCallRetryCount === "number" ? input.toolCallRetryCount : undefined;

  if (
    maxStepsPerRun === undefined &&
    maxToolCallsPerRun === undefined &&
    maxModelCallsPerRun === undefined &&
    maxStepVisits === undefined &&
    maxConcurrentToolJobsPerRun === undefined &&
    maxConcurrentToolJobsGlobal === undefined &&
    maxQueuedToolJobsPerRun === undefined &&
    toolBatchCheckpointSize === undefined &&
    toolCallRetryCount === undefined
  ) {
    return undefined;
  }

  return {
    ...(maxStepsPerRun !== undefined ? { maxStepsPerRun } : {}),
    ...(maxToolCallsPerRun !== undefined ? { maxToolCallsPerRun } : {}),
    ...(maxModelCallsPerRun !== undefined ? { maxModelCallsPerRun } : {}),
    ...(maxStepVisits !== undefined ? { maxStepVisits } : {}),
    ...(maxConcurrentToolJobsPerRun !== undefined ? { maxConcurrentToolJobsPerRun } : {}),
    ...(maxConcurrentToolJobsGlobal !== undefined ? { maxConcurrentToolJobsGlobal } : {}),
    ...(maxQueuedToolJobsPerRun !== undefined ? { maxQueuedToolJobsPerRun } : {}),
    ...(toolBatchCheckpointSize !== undefined ? { toolBatchCheckpointSize } : {}),
    ...(toolCallRetryCount !== undefined ? { toolCallRetryCount } : {}),
  };
}

function parseToolQueue(
  value: unknown,
  profileId: string,
): ToolQueueProfileConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Profile '${profileId}' field 'toolQueue' must be an object`);
  }

  const input = value as Record<string, unknown>;
  const perRunConcurrency =
    typeof input.perRunConcurrency === "number" ? input.perRunConcurrency : undefined;
  const globalConcurrency =
    typeof input.globalConcurrency === "number" ? input.globalConcurrency : undefined;
  const maxQueuedJobsPerRun =
    typeof input.maxQueuedJobsPerRun === "number" ? input.maxQueuedJobsPerRun : undefined;
  const checkpointSize =
    typeof input.checkpointSize === "number" ? input.checkpointSize : undefined;
  const retryCount = typeof input.retryCount === "number" ? input.retryCount : undefined;

  if (
    perRunConcurrency === undefined &&
    globalConcurrency === undefined &&
    maxQueuedJobsPerRun === undefined &&
    checkpointSize === undefined &&
    retryCount === undefined
  ) {
    return undefined;
  }

  return {
    ...(perRunConcurrency !== undefined ? { perRunConcurrency } : {}),
    ...(globalConcurrency !== undefined ? { globalConcurrency } : {}),
    ...(maxQueuedJobsPerRun !== undefined ? { maxQueuedJobsPerRun } : {}),
    ...(checkpointSize !== undefined ? { checkpointSize } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
  };
}

function parseCodeMode(
  value: unknown,
  profileId: string,
): CodeModeProfileConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Profile '${profileId}' field 'codeMode' must be an object`);
  }

  const input = value as Record<string, unknown>;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : undefined;
  const languages =
    Array.isArray(input.languages) &&
    input.languages.every(
      (item) => item === "javascript" || item === "python" || item === "bash",
    )
      ? (input.languages as Array<"javascript" | "python" | "bash">)
      : undefined;
  const sandbox = parseCodeModeSandbox(input.sandbox, profileId);
  const retention = parseCodeModeRetention(input.retention, profileId);
  const approvalMode = input.approvalMode;
  if (approvalMode !== undefined && approvalMode !== "auto") {
    throw new Error(`Profile '${profileId}' field 'codeMode.approvalMode' must be 'auto'`);
  }

  if (
    enabled === undefined &&
    languages === undefined &&
    sandbox === undefined &&
    retention === undefined &&
    approvalMode === undefined
  ) {
    return undefined;
  }

  return {
    enabled: enabled ?? DEFAULT_CODE_MODE_DISABLED_CONFIG.enabled,
    languages: languages ?? [...DEFAULT_CODE_MODE_DISABLED_CONFIG.languages],
    sandbox: {
      ...DEFAULT_CODE_MODE_DISABLED_CONFIG.sandbox,
      ...(sandbox ?? {}),
    },
    retention: {
      ...DEFAULT_CODE_MODE_DISABLED_CONFIG.retention,
      ...(retention ?? {}),
    },
    approvalMode: "auto",
  };
}

function parseDevShell(
  value: unknown,
  profileId: string,
): DevShellProfileConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Profile '${profileId}' field 'devShell' must be an object`);
  }

  const input = value as Record<string, unknown>;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : undefined;
  const idleTimeoutMs =
    typeof input.idleTimeoutMs === "number" ? Math.trunc(input.idleTimeoutMs) : undefined;
  const maxReadBytes =
    typeof input.maxReadBytes === "number" ? Math.trunc(input.maxReadBytes) : undefined;
  const allowedEnvNames =
    Array.isArray(input.allowedEnvNames) && input.allowedEnvNames.every((item) => typeof item === "string")
      ? input.allowedEnvNames.map((item) => item.trim()).filter((item) => item.length > 0)
      : undefined;
  const envMode = input.envMode;
  if (envMode !== undefined && envMode !== "inherit" && envMode !== "allowlist") {
    throw new Error(`Profile '${profileId}' field 'devShell.envMode' must be 'inherit' or 'allowlist'`);
  }

  if (
    enabled === undefined &&
    idleTimeoutMs === undefined &&
    maxReadBytes === undefined &&
    allowedEnvNames === undefined &&
    envMode === undefined
  ) {
    return undefined;
  }

  return {
    enabled: enabled ?? DEFAULT_DEV_SHELL_DISABLED_CONFIG.enabled,
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(maxReadBytes !== undefined ? { maxReadBytes } : {}),
    ...(allowedEnvNames !== undefined ? { allowedEnvNames } : {}),
    ...(envMode !== undefined ? { envMode } : {}),
  };
}

function parseCodeModeSandbox(
  value: unknown,
  profileId: string,
): Partial<CodeModeProfileConfig["sandbox"]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Profile '${profileId}' field 'codeMode.sandbox' must be an object`);
  }

  const input = value as Record<string, unknown>;
  const executor = input.executor;
  if (executor !== undefined && executor !== "docker") {
    throw new Error(`Profile '${profileId}' field 'codeMode.sandbox.executor' must be 'docker'`);
  }

  const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;
  const memoryMb = typeof input.memoryMb === "number" ? input.memoryMb : undefined;
  const cpuShares = typeof input.cpuShares === "number" ? input.cpuShares : undefined;
  const networkDefault = input.networkDefault;
  if (networkDefault !== undefined && networkDefault !== "off" && networkDefault !== "on") {
    throw new Error(
      `Profile '${profileId}' field 'codeMode.sandbox.networkDefault' must be 'off' or 'on'`,
    );
  }
  const allowDependencyInstall =
    typeof input.allowDependencyInstall === "boolean"
      ? input.allowDependencyInstall
      : undefined;
  const maxOutputBytes =
    typeof input.maxOutputBytes === "number" ? input.maxOutputBytes : undefined;
  const maxArtifacts =
    typeof input.maxArtifacts === "number" ? input.maxArtifacts : undefined;
  const maxArtifactBytes =
    typeof input.maxArtifactBytes === "number" ? input.maxArtifactBytes : undefined;

  if (
    executor === undefined &&
    timeoutMs === undefined &&
    memoryMb === undefined &&
    cpuShares === undefined &&
    networkDefault === undefined &&
    allowDependencyInstall === undefined &&
    maxOutputBytes === undefined &&
    maxArtifacts === undefined &&
    maxArtifactBytes === undefined
  ) {
    return undefined;
  }

  return {
    ...(executor !== undefined ? { executor } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(memoryMb !== undefined ? { memoryMb } : {}),
    ...(cpuShares !== undefined ? { cpuShares } : {}),
    ...(networkDefault !== undefined ? { networkDefault } : {}),
    ...(allowDependencyInstall !== undefined ? { allowDependencyInstall } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(maxArtifacts !== undefined ? { maxArtifacts } : {}),
    ...(maxArtifactBytes !== undefined ? { maxArtifactBytes } : {}),
  };
}

function parseTheme(
  value: unknown,
  profileId: string,
  notices: string[],
): ThemeOverrides | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    notices.push(`Ignored invalid theme config for profile '${profileId}': theme must be an object.`);
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const parsed: ThemeOverrides = {};
  for (const [key, raw] of Object.entries(input)) {
    if (isThemeTokenName(key) === false) {
      notices.push(`Ignored unknown theme token '${key}' for profile '${profileId}'.`);
      continue;
    }
    if (typeof raw !== "string") {
      notices.push(`Ignored invalid theme token '${key}' for profile '${profileId}': expected #RRGGBB.`);
      continue;
    }
    const normalized = normalizeThemeColor(raw);
    if (normalized === undefined) {
      notices.push(`Ignored invalid theme color '${raw}' for token '${key}' in profile '${profileId}'.`);
      continue;
    }
    parsed[key] = normalized;
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseCodeModeRetention(
  value: unknown,
  profileId: string,
): Partial<CodeModeProfileConfig["retention"]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Profile '${profileId}' field 'codeMode.retention' must be an object`);
  }

  const input = value as Record<string, unknown>;
  const persistSummary =
    typeof input.persistSummary === "boolean" ? input.persistSummary : undefined;
  const persistArtifacts =
    typeof input.persistArtifacts === "boolean" ? input.persistArtifacts : undefined;

  if (persistSummary === undefined && persistArtifacts === undefined) {
    return undefined;
  }

  return {
    ...(persistSummary !== undefined ? { persistSummary } : {}),
    ...(persistArtifacts !== undefined ? { persistArtifacts } : {}),
  };
}

function parseMcpServers(value: unknown, profileId: string): McpServerConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value) === false) {
    throw new Error(`Profile '${profileId}' field 'mcpServers' must be an array`);
  }

  return value.map((entry, index) => validateMcpServer(entry, profileId, index));
}

function validateMcpServer(
  value: unknown,
  profileId: string,
  index: number,
): McpServerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Profile '${profileId}' mcpServers[${index}] must be an object`);
  }

  const input = value as Record<string, unknown>;
  const id = readRequiredString(input, "id");
  if (/^[a-zA-Z0-9._-]+$/u.test(id) === false) {
    throw new Error(
      `Profile '${profileId}' mcpServers[${index}] id must match [a-zA-Z0-9._-]+`,
    );
  }
  const transport = readRequiredString(input, "transport");
  const enabled = typeof input.enabled === "boolean" ? input.enabled : undefined;
  const toolMetadata = parseMcpToolMetadataMap(input.toolMetadata, profileId, index);

  if (transport === "stdio") {
    const command = readRequiredString(input, "command");
    const args =
      Array.isArray(input.args) && input.args.every((item) => typeof item === "string")
        ? (input.args as string[])
        : undefined;

    return {
      id,
      transport,
      command,
      ...(args !== undefined ? { args } : {}),
      ...(toolMetadata !== undefined ? { toolMetadata } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
  }

  if (transport === "http" || transport === "sse") {
    const url = readRequiredString(input, "url");
    const authTokenEnv = readOptionalString(input, "authTokenEnv");
    const headerEnvs = parseHeaderEnvMap(input.headerEnvs, profileId, index);

    return {
      id,
      transport,
      url,
      ...(authTokenEnv !== undefined ? { authTokenEnv } : {}),
      ...(headerEnvs !== undefined ? { headerEnvs } : {}),
      ...(toolMetadata !== undefined ? { toolMetadata } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
  }

  throw new Error(
    `Profile '${profileId}' mcpServers[${index}] has unsupported transport '${transport}'`,
  );
}

function parseMcpToolMetadataMap(
  value: unknown,
  profileId: string,
  index: number,
): McpServerConfig["toolMetadata"] {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Profile '${profileId}' mcpServers[${index}] field 'toolMetadata' must be an object`);
  }

  const input = value as Record<string, unknown>;
  const output: NonNullable<McpServerConfig["toolMetadata"]> = {};
  for (const [toolName, metadata] of Object.entries(input)) {
    if (toolName.trim().length === 0) {
      throw new Error(`Profile '${profileId}' mcpServers[${index}] toolMetadata contains empty tool key`);
    }
    output[toolName] = parseMcpToolMetadata(metadata, profileId, index, toolName);
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function parseMcpToolMetadata(
  value: unknown,
  profileId: string,
  index: number,
  toolName: string,
): NonNullable<McpServerConfig["toolMetadata"]>[string] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' mcpServers[${index}] toolMetadata['${toolName}'] must be an object`,
    );
  }

  const input = value as Record<string, unknown>;
  return {
    displayName: readRequiredString(input, "displayName"),
    aliases: parseMcpToolMetadataStringArray(input.aliases, profileId, index, toolName, "aliases"),
    keywords: parseMcpToolMetadataStringArray(input.keywords, profileId, index, toolName, "keywords"),
    provider: readRequiredString(input, "provider"),
    toolFamily: readRequiredString(input, "toolFamily"),
    capabilityClasses: parseMcpToolMetadataStringArray(
      input.capabilityClasses,
      profileId,
      index,
      toolName,
      "capabilityClasses",
    ),
  };
}

function parseMcpToolMetadataStringArray(
  value: unknown,
  profileId: string,
  index: number,
  toolName: string,
  field: string,
): string[] {
  if (Array.isArray(value) === false) {
    throw new Error(
      `Profile '${profileId}' mcpServers[${index}] toolMetadata['${toolName}'].${field} must be an array`,
    );
  }

  return value.map((entry, entryIndex) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        `Profile '${profileId}' mcpServers[${index}] toolMetadata['${toolName}'].${field}[${entryIndex}] must be a non-empty string`,
      );
    }
    return entry.trim();
  });
}

function parseHeaderEnvMap(
  value: unknown,
  profileId: string,
  index: number,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' mcpServers[${index}] field 'headerEnvs' must be an object`,
    );
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const [header, envName] of Object.entries(input)) {
    if (header.trim().length === 0) {
      throw new Error(
        `Profile '${profileId}' mcpServers[${index}] header name must be non-empty`,
      );
    }
    if (typeof envName !== "string" || envName.trim().length === 0) {
      throw new Error(
        `Profile '${profileId}' mcpServers[${index}] header '${header}' must map to a non-empty env var name`,
      );
    }
    output[header] = envName;
  }

  return output;
}

function parseDefaultInteractionMode(
  value: unknown,
  profileId: string,
): "chat" | "plan" | "build" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "chat" || value === "plan" || value === "build") {
    return value;
  }
  // Legacy input normalization only; new profiles must emit "build".
  if (value === "act") {
    return "build";
  }

  throw new Error(
    `Profile '${profileId}' field 'defaultInteractionMode' must be chat, plan, or build`,
  );
}

function parseDefaultActSubmode(
  value: unknown,
  profileId: string,
): "strict" | "safe" | "full_auto" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "strict" || value === "safe" || value === "full_auto") {
    return value;
  }

  throw new Error(
    `Profile '${profileId}' field 'defaultActSubmode' must be strict, safe, or full_auto`,
  );
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const maybe = value[key];
  if (typeof maybe !== "string" || maybe.trim().length === 0) {
    throw new Error(`Profile field '${key}' must be a non-empty string`);
  }

  return maybe;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const maybe = value[key];
  if (maybe === undefined) {
    return undefined;
  }

  if (typeof maybe !== "string" || maybe.trim().length === 0) {
    throw new Error(`Profile field '${key}' must be a non-empty string when present`);
  }

  return maybe;
}
