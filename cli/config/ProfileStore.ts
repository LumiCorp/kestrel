import { mkdir, readFile } from "node:fs/promises";
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
import { parseHarnessEconomicsControlV1 } from "../../src/economics/policy.js";
import { parseRuntimeEvaluationPolicyV1 } from "../../src/kestrel/contracts/evaluation.js";
import type {
  McpServerConfig,
} from "../../src/mcp/contracts.js";
import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  isInteractionMode,
} from "../../src/mode/contracts.js";
import {
  ModelPolicyStore,
  resolveProfileWithModelPolicy,
} from "../../src/profile/modelPolicy.js";
import {
  composeKestrelOneProfile,
  KESTREL_ONE_DIALOG_TOOL_NAMES,
  KESTREL_ONE_POLICY_ID,
  LEGACY_KESTREL_ONE_POLICY_ID,
  normalizeKestrelOneToolAllowlist,
  type KestrelOneProfileOverlay,
} from "../../src/profile/kestrelOnePolicy.js";
import { resolveRuntimeProfileSelection } from "../../src/profile/runtimeProfile.js";
import { isRuntimeId } from "../../src/runtimes/contracts.js";
import type {
  KestrelOneManagedProfileOverlay,
  ProfilesFileV10,
  ProfilesFileV9,
  ToolQueueProfileConfig,
  TuiProfile,
} from "../contracts.js";
import {
  isThemeTokenName,
  normalizeThemeColor,
  type ThemeOverrides,
} from "../ink/theme/tokens.js";
import { resolveKestrelHomePath } from "../../src/runtime/kestrelHome.js";
import {
  extractResponseField,
  resolveLocalCoreStoreClient,
} from "../localCoreStoreClient.js";
import {
  activateProfilesFileV10Migration,
  createDefaultProfilesFileV10,
  ensureProfilesFileV10Binding,
  parseProfilesFileV10,
  prepareProfilesFileV10Migration,
  resolveProfilesFileV10Profile,
  serializeProfilesFileV10,
  updateProfilesFileV10FromProfile,
  writeProfilesFileV10,
} from "./ProfilesFileV10.js";

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

const LOCAL_ISOLATION_MIGRATION_NOTICE =
  "Generated local profiles now use isolated execution. Select the cli_dev_local developer preset to restore host-shell access.";

type ManagedProfileOverlays = ProfilesFileV9["managedProfileOverlays"];

interface ParsedProfilesResult {
  profiles: TuiProfile[];
  managedProfileOverlays?: ManagedProfileOverlays | undefined;
  sourceVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  migrated: boolean;
  notices: string[];
}

export interface ProfileStoreOptions {
  managedEnvironmentPresetId?:
    | "cli_safe_local"
    | "cli_dev_local"
    | "workspace_hosted"
    | undefined;
}

export class ProfileStore {
  private readonly baseDir: string;
  private readonly filePath: string;
  private readonly modelPolicyStore: ModelPolicyStore;
  private readonly managedEnvironmentPresetId:
    | "cli_safe_local"
    | "cli_dev_local"
    | "workspace_hosted";
  private lastLoadNotices: string[] = [];
  private loadedProfilesFileV10: ProfilesFileV10 | undefined;

  constructor(
    baseDir = resolveKestrelHomePath(),
    options: ProfileStoreOptions = {},
  ) {
    this.baseDir = baseDir;
    this.filePath = path.join(this.baseDir, PROFILE_FILE_NAME);
    this.modelPolicyStore = new ModelPolicyStore(baseDir);
    this.managedEnvironmentPresetId =
      options.managedEnvironmentPresetId ??
      (process.env.KESTREL_PROFILE_ENVIRONMENT === "workspace_hosted"
        ? "workspace_hosted"
        : "cli_safe_local");
  }

  async load(): Promise<TuiProfile[]> {
    this.lastLoadNotices = [];
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      const response = await core.client.getJson("/v1/profiles");
      const notices =
        typeof response === "object" &&
        response !== null &&
        Array.isArray(response) === false
          ? (response as { notices?: unknown }).notices
          : undefined;
      if (Array.isArray(notices)) {
        this.lastLoadNotices.push(
          ...notices.filter(
            (notice): notice is string => typeof notice === "string",
          ),
        );
      }
      return extractResponseField<TuiProfile[]>(
        response,
        "profiles",
        "profiles",
      );
    }

    await mkdir(this.baseDir, { recursive: true });

    const raw = await this.readFile();
    if (raw === undefined) {
      const profilesFile = createDefaultProfilesFileV10(
        this.managedEnvironmentPresetId,
      );
      await writeProfilesFileV10(this.filePath, profilesFile);
      return this.hydrateProfilesFileV10(profilesFile);
    }
    const decoded = JSON.parse(raw) as { version?: unknown };
    if (decoded.version === 10) {
      const parsed = parseProfilesFileV10(raw);
      const ensured = ensureProfilesFileV10Binding(
        parsed,
        this.managedEnvironmentPresetId,
      );
      if (serializeProfilesFileV10(ensured) !== serializeProfilesFileV10(parsed)) {
        await writeProfilesFileV10(this.filePath, ensured);
      }
      return this.hydrateProfilesFileV10(ensured);
    }
    if (
      typeof decoded.version !== "number" ||
      Number.isInteger(decoded.version) === false ||
      decoded.version < 2 ||
      decoded.version > 9
    ) {
      const profilesFile = createDefaultProfilesFileV10(
        this.managedEnvironmentPresetId,
      );
      await writeProfilesFileV10(this.filePath, profilesFile);
      this.lastLoadNotices.push(
        "Reset unsupported profiles.json schema to the canonical Kestrel profile.",
      );
      return this.hydrateProfilesFileV10(profilesFile);
    }
    const prepared = prepareProfilesFileV10Migration({
      raw,
      profilePath: this.filePath,
    });
    await activateProfilesFileV10Migration(prepared, this.filePath);
    this.lastLoadNotices.push(
      `Migrated profiles.json V${prepared.report.sourceVersion} to the canonical Kestrel profile.`,
    );
    return this.hydrateProfilesFileV10(
      ensureProfilesFileV10Binding(
        prepared.profilesFile,
        this.managedEnvironmentPresetId,
      ),
    );
  }

  consumeLoadNotices(): string[] {
    const notices = [...this.lastLoadNotices];
    this.lastLoadNotices = [];
    return notices;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async save(
    profiles: TuiProfile[],
    _preservedManagedProfileOverlays?: ManagedProfileOverlays,
  ): Promise<void> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      await core.client.putJson("/v1/profiles", { profiles });
      return;
    }

    const canonical = profiles.find(
      (profile) => profile.id === KESTREL_ONE_POLICY_ID,
    );
    if (canonical === undefined) {
      throw new Error("profiles.json V10 requires the canonical Kestrel profile");
    }
    const nonCanonical = profiles.find((profile) => profile !== canonical);
    if (nonCanonical !== undefined) {
      throw new Error(
        `profiles.json V10 rejects non-canonical profile '${nonCanonical.id}'`,
      );
    }
    if (this.loadedProfilesFileV10 === undefined) {
      await this.load();
    }
    const current = this.loadedProfilesFileV10;
    if (current === undefined) {
      throw new Error("profiles.json V10 could not be loaded for persistence");
    }
    const next = updateProfilesFileV10FromProfile({
      current,
      profile: canonical,
      presetId: this.managedEnvironmentPresetId,
    });
    await writeProfilesFileV10(this.filePath, next);
    this.loadedProfilesFileV10 = next;
  }

  getDefault(profiles: TuiProfile[]): TuiProfile {
    const kestrelOne = profiles.find(
      (profile) =>
        profile.id === KESTREL_ONE_POLICY_ID && profile.default === true,
    );
    if (kestrelOne !== undefined) {
      return kestrelOne;
    }
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
    return profiles.find((profile) => profile.id === id);
  }

  private async readFile(): Promise<string | undefined> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  private hydrateProfilesFileV10(value: ProfilesFileV10): TuiProfile[] {
    const ensured = ensureProfilesFileV10Binding(
      value,
      this.managedEnvironmentPresetId,
    );
    this.loadedProfilesFileV10 = ensured;
    return this.resolveProfilesWithSharedModelPolicy([
      resolveProfilesFileV10Profile(
        ensured,
        this.managedEnvironmentPresetId,
      ),
    ]);
  }

  private resolveProfilesWithSharedModelPolicy(
    profiles: TuiProfile[],
  ): TuiProfile[] {
    const modelPolicy = this.modelPolicyStore.read();
    return profiles.map((profile) =>
      resolveProfileWithModelPolicy(profile, modelPolicy),
    );
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

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new Error("profiles.json must be an object");
  }

  const root = decoded as Record<string, unknown>;
  const version = root.version;
  if (
    version !== 2 &&
    version !== 3 &&
    version !== 4 &&
    version !== 5 &&
    version !== 6 &&
    version !== 7 &&
    version !== 8 &&
    version !== 9
  ) {
    throw new ProfileSchemaVersionError(
      "profiles.json version must be 2, 3, 4, 5, 6, 7, 8, or 9",
    );
  }

  const profiles = root.profiles;
  if (Array.isArray(profiles) === false) {
    throw new Error("profiles.json profiles must be an array");
  }

  const validated: TuiProfile[] = profiles.map((profile) =>
    validateProfile(profile, version, notices),
  );
  const managedProfileOverlays =
    version === 5 || version === 6 || version === 7 || version === 8 || version === 9
      ? parseKestrelOneManagedOverlays(
          root.managedProfileOverlays,
          notices,
          version,
        )
      : undefined;
  if (version === 2) {
    return {
      profiles: validated.map((profile) => ({
        ...profile,
        mcpServers: [],
      })),
      sourceVersion: version,
      migrated: true,
      notices,
    };
  }

  return {
    profiles: validated,
    ...(managedProfileOverlays !== undefined
      ? { managedProfileOverlays }
      : {}),
    sourceVersion: version,
    migrated: version !== 9,
    notices,
  };
}

function migrateGeneratedLocalProfile(
  profile: TuiProfile,
  sourceVersion: ParsedProfilesResult["sourceVersion"],
  notices: string[],
): TuiProfile {
  if (sourceVersion >= 7) {
    return profile;
  }
  if (isGeneratedReferenceProfile(profile)) {
    addLocalIsolationMigrationNotice(notices);
    return {
      ...profile,
      shellKind: "cli",
      presetId: "cli_safe_local",
      capabilityPacks: ["balanced", "filesystem", "sandbox_code"],
    };
  }
  if (profile.presetId !== undefined) {
    return profile;
  }
  const shellKind = profile.shellKind ?? "cli";
  if (shellKind === "web") {
    return profile;
  }
  return {
    ...profile,
    shellKind,
    presetId:
      shellKind === "desktop" ? "desktop_dev_local" : "cli_dev_local",
    ...(profile.capabilityPacks === undefined
      ? {
          capabilityPacks:
            shellKind === "desktop"
              ? ["balanced", "filesystem", "dev_shell", "desktop_host"]
              : ["balanced", "filesystem", "dev_shell"],
        }
      : {}),
  };
}

function isGeneratedReferenceProfile(profile: TuiProfile): boolean {
  if (
    profile.id !== "reference" &&
    profile.id !== "reference-openai" &&
    profile.id !== "reference-anthropic"
  ) {
    return false;
  }
  if (
    profile.shellKind !== undefined &&
    profile.shellKind !== "cli"
  ) {
    return false;
  }
  if (
    profile.presetId !== undefined &&
    profile.presetId !== "cli_dev_local"
  ) {
    return false;
  }
  if (profile.capabilityPacks === undefined) {
    return true;
  }
  const packs = new Set(profile.capabilityPacks);
  return packs.size === 3 &&
    packs.has("balanced") &&
    packs.has("filesystem") &&
    packs.has("dev_shell");
}

function addLocalIsolationMigrationNotice(notices: string[]): void {
  if (notices.includes(LOCAL_ISOLATION_MIGRATION_NOTICE) === false) {
    notices.push(LOCAL_ISOLATION_MIGRATION_NOTICE);
  }
}

function applyManagedProfileInvariants(profile: TuiProfile): TuiProfile {
  if (isKestrelManagedProfileId(profile.id) === false) {
    return profile;
  }
  return createManagedKestrelOneProfile(
    profile.presetId === "workspace_hosted"
      ? "workspace_hosted"
      : profile.presetId === "cli_dev_local"
        ? "cli_dev_local"
        : "cli_safe_local",
    extractKestrelOneManagedOverlay(profile),
  );
}

class ProfileSchemaVersionError extends Error {}

function validateProfile(
  value: unknown,
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
  notices: string[],
): TuiProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("profile entries must be objects");
  }

  const item = value as Record<string, unknown>;
  const id = readRequiredString(item, "id");
  const label = readRequiredString(item, "label");
  const agent = readRequiredString(item, "agent");
  if (agent !== "kestrel" && agent !== "reference-react") {
    throw new Error(`Unsupported profile agent '${agent}' for profile '${id}'`);
  }

  const sessionPrefix = readRequiredString(item, "sessionPrefix");
  const shellKind =
    item.shellKind === "cli" ||
    item.shellKind === "web" ||
    item.shellKind === "desktop"
      ? item.shellKind
      : undefined;
  const presetId =
    item.presetId === "cli_safe_local" ||
    item.presetId === "cli_dev_local" ||
    item.presetId === "web_balanced" ||
    item.presetId === "desktop_safe_local" ||
    item.presetId === "desktop_dev_local" ||
    item.presetId === "workspace_hosted"
      ? item.presetId
      : undefined;
  const capabilityPacks =
    Array.isArray(item.capabilityPacks) &&
    item.capabilityPacks.every(
      (entry) =>
        entry === "balanced" ||
        entry === "filesystem" ||
        entry === "dev_shell" ||
        entry === "desktop_host" ||
        entry === "sandbox_code",
    )
      ? (item.capabilityPacks as Array<
          | "balanced"
          | "filesystem"
          | "dev_shell"
          | "desktop_host"
          | "sandbox_code"
        >)
      : undefined;
  const modelProvider = parseModelProvider(item.modelProvider, id);
  const model =
    typeof item.model === "string" && item.model.trim().length > 0
      ? item.model
      : undefined;
  const modelCredential = parseModelCredential(item.modelCredential, id);
  const evaluationPolicy =
    version >= 9 && item.evaluationPolicy !== undefined
      ? parseRuntimeEvaluationPolicyV1(item.evaluationPolicy)
      : undefined;
  const storeDriver = parseStoreDriver(item.storeDriver, id);
  const approvalPolicyPackId = parseApprovalPolicyPackId(
    item.approvalPolicyPackId,
    id,
  );
  const defaultInteractionMode = parseDefaultInteractionMode(
    item.defaultInteractionMode,
    id,
  );
  const defaultActSubmode = parseDefaultActSubmode(item.defaultActSubmode, id);
  const modeSystemV2Enabled =
    typeof item.modeSystemV2Enabled === "boolean"
      ? item.modeSystemV2Enabled
      : undefined;
  const defaultFlag =
    typeof item.default === "boolean" ? item.default : undefined;
  const toolAllowlist =
    Array.isArray(item.toolAllowlist) &&
    item.toolAllowlist.every((v) => typeof v === "string")
      ? (item.toolAllowlist as string[])
      : undefined;

  const guardrails = parseGuardrails(item.guardrails);
  const mcpServers =
    version >= 3 ? parseMcpServers(item.mcpServers, id) : undefined;
  const toolQueue =
    version >= 3 ? parseToolQueue(item.toolQueue, id) : undefined;
  const codeMode = version >= 3 ? parseCodeMode(item.codeMode, id) : undefined;
  const devShell = version >= 3 ? parseDevShell(item.devShell, id) : undefined;
  const agentStageConfig =
    version >= 3 ? parseAgentStageConfig(item.agentStageConfig, id) : undefined;
  const modelTimeoutMs =
    version >= 3 ? parseModelTimeoutMs(item.modelTimeoutMs, id) : undefined;
  const theme = version >= 3 ? parseTheme(item.theme, id, notices) : undefined;
  const delegation = version >= 3 ? parseDelegation(item.delegation) : undefined;
  const reasoning = version >= 4 ? parseReasoningPolicy(item.reasoning, id) : undefined;
  const harnessEconomics = item.harnessEconomics === undefined
    ? undefined
    : parseHarnessEconomicsControlV1(item.harnessEconomics);

  return {
    id,
    label,
    agent,
    sessionPrefix,
    ...(shellKind !== undefined ? { shellKind } : {}),
    ...(presetId !== undefined ? { presetId } : {}),
    ...(capabilityPacks !== undefined ? { capabilityPacks } : {}),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(modelCredential !== undefined ? { modelCredential } : {}),
    ...(evaluationPolicy !== undefined ? { evaluationPolicy } : {}),
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
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(harnessEconomics !== undefined ? { harnessEconomics } : {}),
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
  const legacyExtraTools = Array.isArray(profile.toolAllowlist)
    ? [...profile.toolAllowlist]
    : undefined;
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
    for (const name of KESTREL_ONE_DIALOG_TOOL_NAMES) {
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
      profile.agent === "kestrel" || profile.agent === "reference-react"
        ? true
        : (profile.modeSystemV2Enabled ?? false),
    defaultInteractionMode:
      profile.defaultInteractionMode ?? DEFAULT_INTERACTION_MODE,
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
    reasoning: profile.reasoning ?? {
      request: { mode: "provider_visible" },
      retention: { mode: "live_only", days: 7 },
    },
  };
}

function profilesChanged(before: TuiProfile[], after: TuiProfile[]): boolean {
  const normalize = (profiles: TuiProfile[]) =>
    profiles.map((profile) => sanitizeProfileForPersistence(profile));
  return JSON.stringify(normalize(before)) !== JSON.stringify(normalize(after));
}

function createManagedKestrelOneProfile(
  environmentPresetId:
    | "cli_safe_local"
    | "cli_dev_local"
    | "workspace_hosted",
  overlay: KestrelOneManagedProfileOverlay = {},
): TuiProfile {
  const composedOverlay: KestrelOneProfileOverlay = {
    ...(overlay.approvalPolicyPackId !== undefined
      ? { approvalPolicyPackId: overlay.approvalPolicyPackId }
      : {}),
    ...(overlay.additionalToolNames !== undefined
      ? { additionalToolNames: overlay.additionalToolNames }
      : {}),
    ...(overlay.mcpServers !== undefined
      ? { mcpServers: overlay.mcpServers }
      : {}),
    ...(overlay.toolQueue !== undefined
      ? { toolQueue: overlay.toolQueue }
      : {}),
    ...(overlay.codeMode !== undefined ? { codeMode: overlay.codeMode } : {}),
    ...(overlay.devShell !== undefined ? { devShell: overlay.devShell } : {}),
    ...(overlay.delegationLimits !== undefined
      ? { delegationLimits: overlay.delegationLimits }
      : {}),
    ...(overlay.reasoning !== undefined
      ? { reasoning: overlay.reasoning }
      : {}),
    ...(overlay.evaluationPolicy !== undefined
      ? { evaluationPolicy: overlay.evaluationPolicy }
      : {}),
    ...(overlay.theme !== undefined ? { theme: overlay.theme } : {}),
    default: true,
  };
  return composeKestrelOneProfile({
    environmentPresetId,
    overlay: composedOverlay,
    resolvedProfileId: KESTREL_ONE_POLICY_ID,
  }).profile;
}

function extractKestrelOneManagedOverlay(
  profile: TuiProfile,
): KestrelOneManagedProfileOverlay {
  const environmentPresetId =
    profile.presetId === "workspace_hosted"
      ? "workspace_hosted"
      : profile.presetId === "cli_dev_local"
        ? "cli_dev_local"
        : "cli_safe_local";
  const baseline = composeKestrelOneProfile({
    environmentPresetId,
    resolvedProfileId: KESTREL_ONE_POLICY_ID,
  }).profile;
  const baselineTools = new Set(baseline.toolAllowlist ?? []);
  const additionalToolNames = normalizeKestrelOneToolAllowlist(
    (profile.toolAllowlist ?? []).filter(
      (toolName) => baselineTools.has(toolName) === false,
    ),
  );
  return {
    ...(profile.approvalPolicyPackId !== undefined
      ? { approvalPolicyPackId: profile.approvalPolicyPackId }
      : {}),
    ...(additionalToolNames.length > 0 ? { additionalToolNames } : {}),
    ...(profile.mcpServers !== undefined
      ? { mcpServers: structuredClone(profile.mcpServers) }
      : {}),
    ...(profile.toolQueue !== undefined
      ? { toolQueue: structuredClone(profile.toolQueue) }
      : {}),
    ...(profile.codeMode !== undefined
      ? { codeMode: structuredClone(profile.codeMode) }
      : {}),
    ...(profile.devShell !== undefined
      ? { devShell: structuredClone(profile.devShell) }
      : {}),
    delegationLimits: {
      ...(profile.delegation?.maxConcurrentChildSessions !== undefined
        ? {
            maxConcurrentChildSessions:
              profile.delegation.maxConcurrentChildSessions,
          }
        : {}),
      ...(profile.delegation?.maxDepth !== undefined
        ? { maxDepth: profile.delegation.maxDepth }
        : {}),
    },
    ...(profile.reasoning !== undefined
      ? { reasoning: structuredClone(profile.reasoning) }
      : {}),
    ...(profile.evaluationPolicy !== undefined
      ? { evaluationPolicy: structuredClone(profile.evaluationPolicy) }
      : {}),
    ...(profile.theme !== undefined
      ? { theme: structuredClone(profile.theme) }
      : {}),
    ...(profile.default !== undefined ? { default: profile.default } : {}),
  };
}

function parseKestrelOneManagedOverlays(
  value: unknown,
  notices: string[],
  sourceVersion: 5 | 6 | 7 | 8 | 9,
): ManagedProfileOverlays | undefined {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("profiles.json managedProfileOverlays must be an object");
  }
  const overlays = value as Record<string, unknown>;
  const unsupportedKey = Object.keys(overlays).find(
    (key) =>
      key !== "kestrel@cli_safe_local" &&
      key !== "kestrel@cli_dev_local" &&
      key !== "kestrel@workspace_hosted" &&
      key !== "kestrel-one@cli_dev_local" &&
      key !== "kestrel-one@workspace_hosted",
  );
  if (unsupportedKey !== undefined) {
    throw new Error(
      `profiles.json managedProfileOverlays contains unsupported key '${unsupportedKey}'`,
    );
  }
  const parsed: ProfilesFileV9["managedProfileOverlays"] = {};
  const legacyLocalRaw =
    overlays["kestrel@cli_dev_local"] ??
    overlays["kestrel-one@cli_dev_local"];
  if (sourceVersion >= 7) {
    for (const key of [
      "kestrel@cli_safe_local",
      "kestrel@cli_dev_local",
    ] as const) {
      if (overlays[key] !== undefined) {
        parsed[key] = parseKestrelOneManagedOverlayValue(
          overlays[key],
          notices,
        );
      }
    }
  } else if (legacyLocalRaw !== undefined) {
    parsed["kestrel@cli_safe_local"] =
      parseKestrelOneManagedOverlayValue(legacyLocalRaw, notices);
  }
  const hostedRaw =
    overlays["kestrel@workspace_hosted"] ??
    overlays["kestrel-one@workspace_hosted"];
  if (hostedRaw !== undefined) {
    parsed["kestrel@workspace_hosted"] =
      parseKestrelOneManagedOverlayValue(hostedRaw, notices);
  }
  if (sourceVersion < 7 && legacyLocalRaw !== undefined) {
    addLocalIsolationMigrationNotice(notices);
  }
  return parsed;
}

const KESTREL_MANAGED_OVERLAY_FIELDS = new Set([
  "approvalPolicyPackId",
  "additionalToolNames",
  "mcpServers",
  "toolQueue",
  "codeMode",
  "devShell",
  "delegationLimits",
  "reasoning",
  "evaluationPolicy",
  "theme",
  "default",
]);

const KESTREL_MANAGED_CONFIGURATION_FIELDS = new Set([
  ...KESTREL_MANAGED_OVERLAY_FIELDS,
  "runtimeId",
  "label",
  "modelProvider",
  "model",
  "modelCredential",
  "evaluationPolicy",
  "modelCapabilities",
  "agentStageConfig",
  "modelTimeoutMs",
  "storeDriver",
  "kestrelOneAppApprovalModes",
]);

export function parseKestrelManagedConfiguration(
  value: unknown,
): KestrelOneProfileOverlay {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "execution-profile.resolve managedConfiguration must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find(
    (key) => KESTREL_MANAGED_CONFIGURATION_FIELDS.has(key) === false,
  );
  if (unknown !== undefined) {
    throw new Error(
      `execution-profile.resolve managedConfiguration contains unsupported field '${unknown}'`,
    );
  }
  const overlay = parseKestrelOneManagedOverlayValue(
    pickRecordFields(record, KESTREL_MANAGED_OVERLAY_FIELDS),
    [],
  );
  const label = parseOptionalNonEmptyString(
    record.label,
    "execution-profile.resolve managedConfiguration.label",
  );
  const model = parseOptionalNonEmptyString(
    record.model,
    "execution-profile.resolve managedConfiguration.model",
  );
  return {
    ...(record.runtimeId !== undefined
      ? {
          runtimeId: parseManagedRuntimeId(record.runtimeId),
        }
      : {}),
    ...(label !== undefined ? { label } : {}),
    ...(record.modelProvider !== undefined
      ? {
          modelProvider: parseModelProvider(
            record.modelProvider,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...(model !== undefined ? { model } : {}),
    ...(record.modelCredential !== undefined
      ? {
          modelCredential: parseModelCredential(
            record.modelCredential,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...(record.evaluationPolicy !== undefined
      ? {
          evaluationPolicy: parseRuntimeEvaluationPolicyV1(
            record.evaluationPolicy,
          ),
        }
      : {}),
    ...(record.modelCapabilities !== undefined
      ? {
          modelCapabilities: parseModelCapabilities(
            record.modelCapabilities,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...(record.agentStageConfig !== undefined
      ? {
          agentStageConfig: parseAgentStageConfig(
            record.agentStageConfig,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...(record.modelTimeoutMs !== undefined
      ? {
          modelTimeoutMs: parseModelTimeoutMs(
            record.modelTimeoutMs,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...(record.storeDriver !== undefined
      ? {
          storeDriver: parseStoreDriver(
            record.storeDriver,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...(record.kestrelOneAppApprovalModes !== undefined
      ? {
          kestrelOneAppApprovalModes: parseKestrelOneAppApprovalModes(
            record.kestrelOneAppApprovalModes,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...overlay,
  };
}

function parseManagedRuntimeId(value: unknown) {
  if (!isRuntimeId(value)) {
    throw new Error(
      "execution-profile.resolve managedConfiguration.runtimeId must be kestrel, codex, or claude",
    );
  }
  return value;
}

function parseKestrelOneManagedOverlayValue(
  raw: unknown,
  notices: string[],
): KestrelOneManagedProfileOverlay {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      "profiles.json Kestrel One managed overlay must be an object",
    );
  }
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).find(
    (key) => KESTREL_MANAGED_OVERLAY_FIELDS.has(key) === false,
  );
  if (unknown !== undefined) {
    throw new Error(
      `profiles.json Kestrel One managed overlay contains unsupported field '${unknown}'`,
    );
  }
  const additionalToolNames =
    record.additionalToolNames === undefined
      ? undefined
      : Array.isArray(record.additionalToolNames) &&
          record.additionalToolNames.every(
            (toolName) => typeof toolName === "string",
          )
        ? normalizeKestrelOneToolAllowlist(record.additionalToolNames)
        : undefined;
  if (
    record.additionalToolNames !== undefined &&
    additionalToolNames === undefined
  ) {
    throw new Error(
      "profiles.json Kestrel One additionalToolNames must be an array of strings",
    );
  }
  const delegation = parseDelegation(record.delegationLimits);
  return {
    ...(record.approvalPolicyPackId !== undefined
      ? {
          approvalPolicyPackId: parseApprovalPolicyPackId(
            record.approvalPolicyPackId,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...(additionalToolNames !== undefined ? { additionalToolNames } : {}),
    ...(record.mcpServers !== undefined
      ? {
          mcpServers: parseMcpServers(
            record.mcpServers,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...(record.toolQueue !== undefined
      ? {
          toolQueue: parseToolQueue(
            record.toolQueue,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...(record.codeMode !== undefined
      ? {
          codeMode: parseCodeMode(record.codeMode, KESTREL_ONE_POLICY_ID),
        }
      : {}),
    ...(record.devShell !== undefined
      ? {
          devShell: parseDevShell(record.devShell, KESTREL_ONE_POLICY_ID),
        }
      : {}),
    ...(delegation !== undefined
      ? {
          delegationLimits: {
            ...(delegation.maxConcurrentChildSessions !== undefined
              ? {
                  maxConcurrentChildSessions:
                    delegation.maxConcurrentChildSessions,
                }
              : {}),
            ...(delegation.maxDepth !== undefined
              ? { maxDepth: delegation.maxDepth }
              : {}),
          },
        }
      : {}),
    ...(record.reasoning !== undefined
      ? {
          reasoning: parseReasoningPolicy(
            record.reasoning,
            KESTREL_ONE_POLICY_ID,
          ),
        }
      : {}),
    ...(record.evaluationPolicy !== undefined
      ? {
          evaluationPolicy: parseRuntimeEvaluationPolicyV1(
            record.evaluationPolicy,
          ),
        }
      : {}),
    ...(record.theme !== undefined
      ? {
          theme: parseTheme(
            record.theme,
            KESTREL_ONE_POLICY_ID,
            notices,
          ),
        }
      : {}),
    ...(record.default !== undefined
      ? {
          default:
            typeof record.default === "boolean"
              ? record.default
              : (() => {
                  throw new Error(
                    "profiles.json Kestrel One default must be a boolean",
                  );
                })(),
        }
      : {}),
  };
}

function parseKestrelOneAppApprovalModes(
  value: unknown,
  profileId: string,
): TuiProfile["kestrelOneAppApprovalModes"] {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' field 'kestrelOneAppApprovalModes' must be an object`,
    );
  }
  const parsed: Record<string, "auto" | "ask"> = {};
  for (const [toolName, approvalMode] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (toolName.trim().length === 0) {
      throw new Error(
        `Profile '${profileId}' field 'kestrelOneAppApprovalModes' contains an empty tool name`,
      );
    }
    if (approvalMode !== "auto" && approvalMode !== "ask") {
      throw new Error(
        `Profile '${profileId}' field 'kestrelOneAppApprovalModes.${toolName}' must be 'auto' or 'ask'`,
      );
    }
    parsed[toolName] = approvalMode;
  }
  return parsed;
}

function managedOverlayKey(
  environmentPresetId:
    | "cli_safe_local"
    | "cli_dev_local"
    | "workspace_hosted",
):
  | "kestrel@cli_safe_local"
  | "kestrel@cli_dev_local"
  | "kestrel@workspace_hosted" {
  return `kestrel@${environmentPresetId}`;
}

function isKestrelManagedProfileId(profileId: string): boolean {
  return (
    profileId === KESTREL_ONE_POLICY_ID ||
    profileId === LEGACY_KESTREL_ONE_POLICY_ID
  );
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

function pickRecordFields(
  record: Record<string, unknown>,
  fields: ReadonlySet<string>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of fields) {
    if (record[key] !== undefined) {
      picked[key] = record[key];
    }
  }
  return picked;
}

function parseOptionalNonEmptyString(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string when present`);
  }
  return value.trim();
}

function parseModelProvider(
  value: unknown,
  profileId: string,
): TuiProfile["modelProvider"] {
  if (value === undefined) {
    return;
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
  throw new Error(
    `Profile '${profileId}' has unsupported modelProvider '${String(value)}'`,
  );
}

function parseModelCredential(
  value: unknown,
  profileId: string,
): TuiProfile["modelCredential"] {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Profile '${profileId}' modelCredential must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.source !== "kestrel-one" ||
    typeof candidate.runId !== "string" ||
    candidate.runId.trim().length === 0 ||
    typeof candidate.gatewayId !== "string" ||
    candidate.gatewayId.trim().length === 0 ||
    typeof candidate.organizationId !== "string" ||
    candidate.organizationId.trim().length === 0 ||
    typeof candidate.environmentId !== "string" ||
    candidate.environmentId.trim().length === 0 ||
    typeof candidate.rawModelId !== "string" ||
    candidate.rawModelId.trim().length === 0 ||
    (candidate.provider !== "openai" &&
      candidate.provider !== "openrouter" &&
      candidate.provider !== "anthropic" &&
      candidate.provider !== "ollama")
  ) {
    throw new Error(`Profile '${profileId}' has invalid modelCredential`);
  }
  return {
    source: "kestrel-one",
    runId: candidate.runId.trim(),
    gatewayId: candidate.gatewayId.trim(),
    organizationId: candidate.organizationId.trim(),
    environmentId: candidate.environmentId.trim(),
    rawModelId: candidate.rawModelId.trim(),
    provider: candidate.provider,
  };
}

function parseStoreDriver(
  value: unknown,
  profileId: string,
): TuiProfile["storeDriver"] {
  if (value === undefined) {
    return;
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
    return;
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
    return;
  }
  const record = value as Record<string, unknown>;
  const allowAgentSpawn =
    typeof record.allowAgentSpawn === "boolean"
      ? record.allowAgentSpawn
      : undefined;
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

function parseReasoningPolicy(
  value: unknown,
  profileId: string,
): TuiProfile["reasoning"] {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' field 'reasoning' must be an object`,
    );
  }
  const record = value as Record<string, unknown>;
  const request =
    typeof record.request === "object" &&
    record.request !== null &&
    !Array.isArray(record.request)
      ? (record.request as Record<string, unknown>)
      : undefined;
  const retention =
    typeof record.retention === "object" &&
    record.retention !== null &&
    !Array.isArray(record.retention)
      ? (record.retention as Record<string, unknown>)
      : undefined;
  const mode = request?.mode;
  const effort = request?.effort;
  const retentionMode = retention?.mode;
  const days = retention?.days;
  if (mode !== "off" && mode !== "summary" && mode !== "provider_visible") {
    throw new Error(`Profile '${profileId}' reasoning.request.mode is invalid`);
  }
  if (
    effort !== undefined &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high"
  ) {
    throw new Error(
      `Profile '${profileId}' reasoning.request.effort is invalid`,
    );
  }
  if (retentionMode !== "live_only" && retentionMode !== "provider_visible") {
    throw new Error(
      `Profile '${profileId}' reasoning.retention.mode is invalid`,
    );
  }
  if (
    typeof days !== "number" ||
    Number.isInteger(days) === false ||
    days < 1 ||
    days > 30
  ) {
    throw new Error(
      `Profile '${profileId}' reasoning.retention.days must be an integer from 1 to 30`,
    );
  }
  return {
    request: { mode, ...(effort !== undefined ? { effort } : {}) },
    retention: { mode: retentionMode, days },
  };
}

function parseAgentStageConfig(
  value: unknown,
  profileId: string,
): TuiProfile["agentStageConfig"] {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' field 'agentStageConfig' must be an object`,
    );
  }
  const record = value as Record<string, unknown>;
  if (record.modelByStage === undefined) {
    return;
  }
  if (
    typeof record.modelByStage !== "object" ||
    record.modelByStage === null ||
    Array.isArray(record.modelByStage)
  ) {
    throw new Error(
      `Profile '${profileId}' field 'agentStageConfig.modelByStage' must be an object`,
    );
  }
  const parsed: Record<string, string> = {};
  for (const [stageId, modelValue] of Object.entries(
    record.modelByStage as Record<string, unknown>,
  )) {
    if (typeof modelValue !== "string") {
      throw new Error(
        `Profile '${profileId}' field 'agentStageConfig.modelByStage.${stageId}' must be a string`,
      );
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

function parseModelTimeoutMs(
  value: unknown,
  profileId: string,
): number | undefined {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== "number" ||
    Number.isInteger(value) === false ||
    value <= 0
  ) {
    throw new Error(
      `Profile '${profileId}' field 'modelTimeoutMs' must be a positive integer`,
    );
  }
  return value;
}

function parseGuardrails(value: unknown): Partial<GuardrailConfig> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }

  const input = value as Record<string, unknown>;
  const maxStepsPerRun =
    typeof input.maxStepsPerRun === "number" ? input.maxStepsPerRun : undefined;
  const maxToolCallsPerRun =
    typeof input.maxToolCallsPerRun === "number"
      ? input.maxToolCallsPerRun
      : undefined;
  const maxModelCallsPerRun =
    typeof input.maxModelCallsPerRun === "number"
      ? input.maxModelCallsPerRun
      : undefined;
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
    typeof input.maxQueuedToolJobsPerRun === "number"
      ? input.maxQueuedToolJobsPerRun
      : undefined;
  const toolBatchCheckpointSize =
    typeof input.toolBatchCheckpointSize === "number"
      ? input.toolBatchCheckpointSize
      : undefined;
  const toolCallRetryCount =
    typeof input.toolCallRetryCount === "number"
      ? input.toolCallRetryCount
      : undefined;

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
    return;
  }

  return {
    ...(maxStepsPerRun !== undefined ? { maxStepsPerRun } : {}),
    ...(maxToolCallsPerRun !== undefined ? { maxToolCallsPerRun } : {}),
    ...(maxModelCallsPerRun !== undefined ? { maxModelCallsPerRun } : {}),
    ...(maxStepVisits !== undefined ? { maxStepVisits } : {}),
    ...(maxConcurrentToolJobsPerRun !== undefined
      ? { maxConcurrentToolJobsPerRun }
      : {}),
    ...(maxConcurrentToolJobsGlobal !== undefined
      ? { maxConcurrentToolJobsGlobal }
      : {}),
    ...(maxQueuedToolJobsPerRun !== undefined
      ? { maxQueuedToolJobsPerRun }
      : {}),
    ...(toolBatchCheckpointSize !== undefined
      ? { toolBatchCheckpointSize }
      : {}),
    ...(toolCallRetryCount !== undefined ? { toolCallRetryCount } : {}),
  };
}

function parseModelCapabilities(
  value: unknown,
  profileId: string,
): TuiProfile["modelCapabilities"] {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' field 'modelCapabilities' must be an object`,
    );
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find(
    (key) => key !== "visionInputEnabled",
  );
  if (unknown !== undefined) {
    throw new Error(
      `Profile '${profileId}' field 'modelCapabilities' contains unsupported field '${unknown}'`,
    );
  }
  if (
    record.visionInputEnabled !== undefined &&
    typeof record.visionInputEnabled !== "boolean"
  ) {
    throw new Error(
      `Profile '${profileId}' field 'modelCapabilities.visionInputEnabled' must be a boolean`,
    );
  }
  return {
    ...(record.visionInputEnabled !== undefined
      ? { visionInputEnabled: record.visionInputEnabled }
      : {}),
  };
}

function parseToolQueue(
  value: unknown,
  profileId: string,
): ToolQueueProfileConfig | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' field 'toolQueue' must be an object`,
    );
  }

  const input = value as Record<string, unknown>;
  const perRunConcurrency =
    typeof input.perRunConcurrency === "number"
      ? input.perRunConcurrency
      : undefined;
  const globalConcurrency =
    typeof input.globalConcurrency === "number"
      ? input.globalConcurrency
      : undefined;
  const maxQueuedJobsPerRun =
    typeof input.maxQueuedJobsPerRun === "number"
      ? input.maxQueuedJobsPerRun
      : undefined;
  const checkpointSize =
    typeof input.checkpointSize === "number" ? input.checkpointSize : undefined;
  const retryCount =
    typeof input.retryCount === "number" ? input.retryCount : undefined;

  if (
    perRunConcurrency === undefined &&
    globalConcurrency === undefined &&
    maxQueuedJobsPerRun === undefined &&
    checkpointSize === undefined &&
    retryCount === undefined
  ) {
    return;
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
    return;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' field 'codeMode' must be an object`,
    );
  }

  const input = value as Record<string, unknown>;
  const enabled =
    typeof input.enabled === "boolean" ? input.enabled : undefined;
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
    throw new Error(
      `Profile '${profileId}' field 'codeMode.approvalMode' must be 'auto'`,
    );
  }

  if (
    enabled === undefined &&
    languages === undefined &&
    sandbox === undefined &&
    retention === undefined &&
    approvalMode === undefined
  ) {
    return;
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
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' field 'devShell' must be an object`,
    );
  }

  const input = value as Record<string, unknown>;
  const enabled =
    typeof input.enabled === "boolean" ? input.enabled : undefined;
  const idleTimeoutMs =
    typeof input.idleTimeoutMs === "number"
      ? Math.trunc(input.idleTimeoutMs)
      : undefined;
  const maxReadBytes =
    typeof input.maxReadBytes === "number"
      ? Math.trunc(input.maxReadBytes)
      : undefined;
  const allowedEnvNames =
    Array.isArray(input.allowedEnvNames) &&
    input.allowedEnvNames.every((item) => typeof item === "string")
      ? input.allowedEnvNames
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : undefined;
  const envMode = input.envMode;
  if (
    envMode !== undefined &&
    envMode !== "inherit" &&
    envMode !== "allowlist"
  ) {
    throw new Error(
      `Profile '${profileId}' field 'devShell.envMode' must be 'inherit' or 'allowlist'`,
    );
  }

  if (
    enabled === undefined &&
    idleTimeoutMs === undefined &&
    maxReadBytes === undefined &&
    allowedEnvNames === undefined &&
    envMode === undefined
  ) {
    return;
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
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' field 'codeMode.sandbox' must be an object`,
    );
  }

  const input = value as Record<string, unknown>;
  const executor = input.executor;
  if (executor !== undefined && executor !== "docker") {
    throw new Error(
      `Profile '${profileId}' field 'codeMode.sandbox.executor' must be 'docker'`,
    );
  }

  const timeoutMs =
    typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;
  const memoryMb =
    typeof input.memoryMb === "number" ? input.memoryMb : undefined;
  const cpuShares =
    typeof input.cpuShares === "number" ? input.cpuShares : undefined;
  const pidsLimit =
    typeof input.pidsLimit === "number" ? input.pidsLimit : undefined;
  const workspaceSizeMb = parseOptionalPositiveInteger(
    input.workspaceSizeMb,
    `Profile '${profileId}' field 'codeMode.sandbox.workspaceSizeMb'`,
  );
  const workspaceInodes = parseOptionalPositiveInteger(
    input.workspaceInodes,
    `Profile '${profileId}' field 'codeMode.sandbox.workspaceInodes'`,
  );
  const tmpSizeMb = parseOptionalPositiveInteger(
    input.tmpSizeMb,
    `Profile '${profileId}' field 'codeMode.sandbox.tmpSizeMb'`,
  );
  const tmpInodes = parseOptionalPositiveInteger(
    input.tmpInodes,
    `Profile '${profileId}' field 'codeMode.sandbox.tmpInodes'`,
  );
  const networkDefault = input.networkDefault;
  if (
    networkDefault !== undefined &&
    networkDefault !== "off" &&
    networkDefault !== "on"
  ) {
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
    typeof input.maxArtifactBytes === "number"
      ? input.maxArtifactBytes
      : undefined;

  if (
    executor === undefined &&
    timeoutMs === undefined &&
    memoryMb === undefined &&
    cpuShares === undefined &&
    pidsLimit === undefined &&
    workspaceSizeMb === undefined &&
    workspaceInodes === undefined &&
    tmpSizeMb === undefined &&
    tmpInodes === undefined &&
    networkDefault === undefined &&
    allowDependencyInstall === undefined &&
    maxOutputBytes === undefined &&
    maxArtifacts === undefined &&
    maxArtifactBytes === undefined
  ) {
    return;
  }

  return {
    ...(executor !== undefined ? { executor } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(memoryMb !== undefined ? { memoryMb } : {}),
    ...(cpuShares !== undefined ? { cpuShares } : {}),
    ...(pidsLimit !== undefined ? { pidsLimit } : {}),
    ...(workspaceSizeMb !== undefined ? { workspaceSizeMb } : {}),
    ...(workspaceInodes !== undefined ? { workspaceInodes } : {}),
    ...(tmpSizeMb !== undefined ? { tmpSizeMb } : {}),
    ...(tmpInodes !== undefined ? { tmpInodes } : {}),
    ...(networkDefault !== undefined ? { networkDefault } : {}),
    ...(allowDependencyInstall !== undefined ? { allowDependencyInstall } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(maxArtifacts !== undefined ? { maxArtifacts } : {}),
    ...(maxArtifactBytes !== undefined ? { maxArtifactBytes } : {}),
  };
}

function parseOptionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== "number" ||
    Number.isSafeInteger(value) === false ||
    value <= 0
  ) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseTheme(
  value: unknown,
  profileId: string,
  notices: string[],
): ThemeOverrides | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    notices.push(
      `Ignored invalid theme config for profile '${profileId}': theme must be an object.`,
    );
    return;
  }

  const input = value as Record<string, unknown>;
  const parsed: ThemeOverrides = {};
  for (const [key, raw] of Object.entries(input)) {
    if (isThemeTokenName(key) === false) {
      notices.push(
        `Ignored unknown theme token '${key}' for profile '${profileId}'.`,
      );
      continue;
    }
    if (typeof raw !== "string") {
      notices.push(
        `Ignored invalid theme token '${key}' for profile '${profileId}': expected #RRGGBB.`,
      );
      continue;
    }
    const normalized = normalizeThemeColor(raw);
    if (normalized === undefined) {
      notices.push(
        `Ignored invalid theme color '${raw}' for token '${key}' in profile '${profileId}'.`,
      );
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
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' field 'codeMode.retention' must be an object`,
    );
  }

  const input = value as Record<string, unknown>;
  const persistSummary =
    typeof input.persistSummary === "boolean"
      ? input.persistSummary
      : undefined;
  const persistArtifacts =
    typeof input.persistArtifacts === "boolean"
      ? input.persistArtifacts
      : undefined;

  if (persistSummary === undefined && persistArtifacts === undefined) {
    return;
  }

  return {
    ...(persistSummary !== undefined ? { persistSummary } : {}),
    ...(persistArtifacts !== undefined ? { persistArtifacts } : {}),
  };
}

function parseMcpServers(
  value: unknown,
  profileId: string,
): McpServerConfig[] | undefined {
  if (value === undefined) {
    return;
  }

  if (Array.isArray(value) === false) {
    throw new Error(
      `Profile '${profileId}' field 'mcpServers' must be an array`,
    );
  }

  return value.map((entry, index) =>
    validateMcpServer(entry, profileId, index),
  );
}

function validateMcpServer(
  value: unknown,
  profileId: string,
  index: number,
): McpServerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' mcpServers[${index}] must be an object`,
    );
  }

  const input = value as Record<string, unknown>;
  const id = readRequiredString(input, "id");
  if (/^[a-zA-Z0-9._-]+$/u.test(id) === false) {
    throw new Error(
      `Profile '${profileId}' mcpServers[${index}] id must match [a-zA-Z0-9._-]+`,
    );
  }
  const transport = readRequiredString(input, "transport");
  const enabled =
    typeof input.enabled === "boolean" ? input.enabled : undefined;
  const toolMetadata = parseMcpToolMetadataMap(
    input.toolMetadata,
    profileId,
    index,
  );

  if (transport === "stdio") {
    const command = readRequiredString(input, "command");
    const args =
      Array.isArray(input.args) &&
      input.args.every((item) => typeof item === "string")
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
    const oauthCredentialPrefix = readOptionalString(
      input,
      "oauthCredentialPrefix",
    );
    if (
      oauthCredentialPrefix !== undefined &&
      /^mcp\.[a-zA-Z0-9._-]{1,128}$/u.test(oauthCredentialPrefix) === false
    ) {
      throw new Error(
        `Profile '${profileId}' mcpServers[${index}] OAuth credential prefix is invalid`,
      );
    }
    if (
      oauthCredentialPrefix !== undefined &&
      (authTokenEnv !== undefined || headerEnvs !== undefined)
    ) {
      throw new Error(
        `Profile '${profileId}' mcpServers[${index}] cannot combine OAuth and static credentials`,
      );
    }

    return {
      id,
      transport,
      url,
      ...(authTokenEnv !== undefined ? { authTokenEnv } : {}),
      ...(headerEnvs !== undefined ? { headerEnvs } : {}),
      ...(oauthCredentialPrefix !== undefined
        ? { oauthCredentialPrefix: oauthCredentialPrefix as `mcp.${string}` }
        : {}),
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
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Profile '${profileId}' mcpServers[${index}] field 'toolMetadata' must be an object`,
    );
  }

  const input = value as Record<string, unknown>;
  const output: NonNullable<McpServerConfig["toolMetadata"]> = {};
  for (const [toolName, metadata] of Object.entries(input)) {
    if (toolName.trim().length === 0) {
      throw new Error(
        `Profile '${profileId}' mcpServers[${index}] toolMetadata contains empty tool key`,
      );
    }
    output[toolName] = parseMcpToolMetadata(
      metadata,
      profileId,
      index,
      toolName,
    );
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
  const approvalMode = input.approvalMode;
  if (
    approvalMode !== undefined &&
    approvalMode !== "auto" &&
    approvalMode !== "ask"
  ) {
    throw new Error(
      `Profile '${profileId}' mcpServers[${index}] toolMetadata['${toolName}'].approvalMode must be 'auto' or 'ask'`,
    );
  }
  const allowedInteractionModes =
    input.allowedInteractionModes === undefined
      ? undefined
      : parseMcpToolMetadataStringArray(
          input.allowedInteractionModes,
          profileId,
          index,
          toolName,
          "allowedInteractionModes",
        ).map((mode, modeIndex) => {
          if (!isInteractionMode(mode)) {
            throw new Error(
              `Profile '${profileId}' mcpServers[${index}] toolMetadata['${toolName}'].allowedInteractionModes[${modeIndex}] must be 'chat', 'plan', or 'build'`,
            );
          }
          return mode;
        });
  return {
    displayName: readRequiredString(input, "displayName"),
    aliases: parseMcpToolMetadataStringArray(
      input.aliases,
      profileId,
      index,
      toolName,
      "aliases",
    ),
    keywords: parseMcpToolMetadataStringArray(
      input.keywords,
      profileId,
      index,
      toolName,
      "keywords",
    ),
    provider: readRequiredString(input, "provider"),
    toolFamily: readRequiredString(input, "toolFamily"),
    capabilityClasses: parseMcpToolMetadataStringArray(
      input.capabilityClasses,
      profileId,
      index,
      toolName,
      "capabilityClasses",
    ),
    ...(approvalMode !== undefined ? { approvalMode } : {}),
    ...(allowedInteractionModes !== undefined
      ? { allowedInteractionModes: [...new Set(allowedInteractionModes)] }
      : {}),
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
    return;
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
    return;
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
    return;
  }

  if (value === "strict" || value === "safe" || value === "full_auto") {
    return value;
  }

  throw new Error(
    `Profile '${profileId}' field 'defaultActSubmode' must be strict, safe, or full_auto`,
  );
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
): string {
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
    return;
  }

  if (typeof maybe !== "string" || maybe.trim().length === 0) {
    throw new Error(
      `Profile field '${key}' must be a non-empty string when present`,
    );
  }

  return maybe;
}
