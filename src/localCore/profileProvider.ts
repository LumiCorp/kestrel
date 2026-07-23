import { ProfileStore } from "../../cli/config/ProfileStore.js";
import type { TuiProfile } from "../../cli/contracts.js";
import type { RunnerProfileProvider } from "../../cli/runner/RunnerHost.js";
import {
  ModelPolicyStore,
  resolveProfileWithModelPolicy,
} from "../profile/modelPolicy.js";
import { resolveDesktopKestrelOneProfile } from "../desktopShell/executionProfile.js";
import {
  createDesktopModelConfiguration,
  parseDesktopModelConfigurations,
} from "../desktopShell/configuration.js";
import {
  composeKestrelOneProfile,
  fingerprintResolvedProfile,
  KESTREL_ONE_ENVIRONMENT_PRESETS,
  KESTREL_ONE_POLICY_ID,
  KESTREL_ONE_POLICY_VERSION,
} from "../profile/kestrelOnePolicy.js";
import {
  LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION,
  LOCAL_CORE_DESKTOP_PROFILE_ID,
  type LocalCoreExecutionProfileResolution,
  type LocalCoreExecutionProfileResolveRequest,
  parseLocalCoreDesktopExecutionConfig,
  type LocalCoreDesktopExecutionConfig,
} from "./contracts.js";
import {
  LocalCoreExecutionProfileRegistry,
  type ExecutionProfileRevisionProvenance,
} from "./executionProfileRegistry.js";
import { readLocalCoreLocalSettings } from "./localSettings.js";
import type { LocalCoreRuntimeConfigurationV1 } from "./runtimeConfiguration.js";
import { createWebDemoProfile } from "../web/profile.js";

export interface LocalCoreProfileProviderOptions {
  /**
   * One immutable configuration snapshot shared with the execution bundle.
   * When omitted, callers retain the pre-0.6 compatibility path backed by the
   * legacy ModelPolicyStore.
   */
  runtimeConfiguration?: LocalCoreRuntimeConfigurationV1 | undefined;
}

export class LocalCoreReservedProfileIdError extends Error {
  constructor() {
    super(
      `Profile id '${LOCAL_CORE_DESKTOP_PROFILE_ID}' is reserved by Local Core. Rename the persisted profile before using the Core-owned Desktop profile.`,
    );
    this.name = "LocalCoreReservedProfileIdError";
  }
}

export function resolveLocalCoreDesktopProfile(
  homePath: string,
  options: LocalCoreProfileProviderOptions = {},
): TuiProfile {
  const baseProfile = composeKestrelOneProfile({
    environmentPresetId: "desktop_dev_local",
    resolvedProfileId: LOCAL_CORE_DESKTOP_PROFILE_ID,
  }).profile;
  return resolveProfileWithModelPolicy(
    {
      ...baseProfile,
      sessionPrefix: LOCAL_CORE_DESKTOP_PROFILE_ID,
      default: false,
    },
    options.runtimeConfiguration?.modelPolicy
      ?? new ModelPolicyStore(homePath).read(),
  );
}

export async function resolveLocalCoreExecutionProfile(
  homePath: string,
  request: LocalCoreExecutionProfileResolveRequest,
  options: LocalCoreProfileProviderOptions = {},
): Promise<LocalCoreExecutionProfileResolution> {
  const runtimeConfiguration = options.runtimeConfiguration;
  if (runtimeConfiguration === undefined) {
    throw new Error(
      "Local Core execution profile resolution requires a runtime configuration snapshot.",
    );
  }
  let profile: TuiProfile;
  let environmentPresetId:
    | "desktop_dev_local"
    | "cli_dev_local"
    | "web_balanced";
  if (request.client === "desktop") {
    profile = resolveDesktopKestrelOneProfile({
      settings: await readLocalCoreLocalSettings(homePath),
      fallbackModelPolicy: runtimeConfiguration.modelPolicy,
      selection: request.selection,
    }).profile;
    environmentPresetId = "desktop_dev_local";
  } else {
    if (
      request.profileId === LOCAL_CORE_DESKTOP_PROFILE_ID ||
      request.profileId.startsWith("reference-web")
    ) {
      throw new Error(
        `Legacy profile '${request.profileId}' is available for historical inspection only.`,
      );
    }
    const store = new ProfileStore(homePath, {
      managedEnvironmentPresetId: "cli_dev_local",
    });
    const configuredProfiles = resolveLocalCoreConfiguredProfiles(
      await store.load(),
      runtimeConfiguration,
    );
    const selected = store.findById(configuredProfiles, request.profileId);
    if (selected === undefined) {
      throw new Error(`Profile '${request.profileId}' was not found.`);
    }
    profile =
      request.client === "reference_web"
        ? resolveReferenceWebProfile(selected)
        : selected.id === KESTREL_ONE_POLICY_ID
          ? composeKestrelOneProfile({
              environmentPresetId: "cli_dev_local",
              overlay: {
                label: selected.label,
                modelProvider: selected.modelProvider,
                model: selected.model,
                modelCapabilities: selected.modelCapabilities,
                agentStageConfig: selected.agentStageConfig,
                modelTimeoutMs: selected.modelTimeoutMs,
                approvalPolicyPackId: selected.approvalPolicyPackId,
                additionalToolNames: selected.toolAllowlist,
                mcpServers: selected.mcpServers,
                toolQueue: selected.toolQueue,
                codeMode: selected.codeMode,
                devShell: selected.devShell,
                delegationLimits: selected.delegation,
                reasoning: selected.reasoning,
                default: selected.default,
              },
            }).profile
          : selected;
    environmentPresetId =
      request.client === "reference_web"
        ? "web_balanced"
        : "cli_dev_local";
  }
  const registered = await new LocalCoreExecutionProfileRegistry(
    homePath,
  ).register(
    profile,
    environmentPresetId,
    buildExecutionProfileRevisionProvenance(
      request,
      profile,
      environmentPresetId,
    ),
  );
  return {
    version: 1,
    profileId: registered.profileId,
    fingerprint: registered.fingerprint,
    resolvedProfile: registered.profile,
  };
}

function buildExecutionProfileRevisionProvenance(
  request: LocalCoreExecutionProfileResolveRequest,
  profile: TuiProfile,
  environmentPresetId:
    | "desktop_dev_local"
    | "cli_dev_local"
    | "web_balanced",
): ExecutionProfileRevisionProvenance {
  const policyId = profile.agentProfileId ?? profile.id;
  const policyVersion =
    policyId === KESTREL_ONE_POLICY_ID ? KESTREL_ONE_POLICY_VERSION : 1;
  const environmentPresetVersion =
    environmentPresetId === "web_balanced"
      ? 1
      : KESTREL_ONE_ENVIRONMENT_PRESETS[environmentPresetId].version;
  if (request.client === "desktop") {
    return {
      policy: { id: policyId, version: policyVersion },
      environmentPreset: {
        id: environmentPresetId,
        version: environmentPresetVersion,
      },
      modelConfiguration: {
        id: request.selection.modelConfiguration.id,
        revision: request.selection.modelConfiguration.revision,
      },
      integrationContracts: [...request.selection.apps]
        .map((app) => ({
          id: app.id,
          revision: app.contractVersion,
        }))
        .sort(
          (left, right) =>
            left.id.localeCompare(right.id) ||
            left.revision - right.revision,
        ),
    };
  }
  return {
    policy: { id: policyId, version: policyVersion },
    environmentPreset: {
      id: environmentPresetId,
      version: environmentPresetVersion,
    },
    authoringProfile: {
      id: request.profileId,
      revision: fingerprintResolvedProfile(profile),
    },
  };
}

export async function resolveLocalCoreDesktopExecutionConfig(
  homePath: string,
  options: LocalCoreProfileProviderOptions = {},
): Promise<LocalCoreDesktopExecutionConfig> {
  const runtimeConfiguration = options.runtimeConfiguration;
  if (runtimeConfiguration === undefined) {
    throw new Error(
      "Local Core Desktop execution config requires a runtime configuration snapshot.",
    );
  }
  const settings = await readLocalCoreLocalSettings(homePath);
  const configurations =
    settings.modelConfigurations === undefined
      ? [createDesktopModelConfiguration(runtimeConfiguration.modelPolicy)]
      : parseDesktopModelConfigurations(settings.modelConfigurations);
  const selectedConfiguration =
    configurations.find((configuration) => configuration.archivedAt === undefined)
      ?? configurations[0];
  if (selectedConfiguration === undefined) {
    throw new Error("Desktop has no model configuration available.");
  }
  const resolution = await resolveLocalCoreExecutionProfile(
    homePath,
    {
      client: "desktop",
      selection: {
        modelConfiguration: {
          id: selectedConfiguration.id,
          revision: selectedConfiguration.currentRevision,
        },
        apps: [],
      },
    },
    options,
  );
  const profile = resolution.resolvedProfile;
  return parseLocalCoreDesktopExecutionConfig({
    version: LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION,
    profileId: resolution.profileId,
    resolvedProfile: {
      id: profile.id,
      label: profile.label,
      agent: profile.agent,
      shellKind: profile.shellKind,
      presetId: profile.presetId,
      modelProvider: profile.modelProvider,
      model: profile.model,
      modeSystemV2Enabled: profile.modeSystemV2Enabled,
      defaultInteractionMode: profile.defaultInteractionMode,
      defaultActSubmode: profile.defaultActSubmode,
    },
  });
}

export function assertNoLocalCoreReservedProfileCollision(
  profiles: readonly Pick<TuiProfile, "id">[],
): void {
  if (profiles.some((profile) => profile.id === LOCAL_CORE_DESKTOP_PROFILE_ID)) {
    throw new LocalCoreReservedProfileIdError();
  }
}

export function resolveLocalCoreConfiguredProfiles(
  profiles: readonly TuiProfile[],
  runtimeConfiguration: LocalCoreRuntimeConfigurationV1,
): TuiProfile[] {
  return profiles.map((profile) =>
    resolveProfileWithModelPolicy(profile, runtimeConfiguration.modelPolicy)
  );
}

export function createLocalCoreProfileProvider(
  homePath: string,
  _options: LocalCoreProfileProviderOptions = {},
): RunnerProfileProvider {
  const registry = new LocalCoreExecutionProfileRegistry(homePath);
  return {
    async listProfiles() {
      return await registry.list();
    },
    async getProfile(profileId) {
      return await registry.get(profileId);
    },
  };
}

function resolveReferenceWebProfile(selected: TuiProfile): TuiProfile {
  if (
    selected.id === KESTREL_ONE_POLICY_ID ||
    selected.agentProfileId === KESTREL_ONE_POLICY_ID ||
    selected.id === LOCAL_CORE_DESKTOP_PROFILE_ID
  ) {
    throw new Error(
      `Profile '${selected.id}' is not selectable by the Reference React web harness.`,
    );
  }
  return {
    ...createWebDemoProfile(),
    label: selected.label,
    modelProvider: selected.modelProvider,
    model: selected.model,
    modelCapabilities: selected.modelCapabilities,
    agentStageConfig: selected.agentStageConfig,
    modelTimeoutMs: selected.modelTimeoutMs,
    approvalPolicyPackId: selected.approvalPolicyPackId,
    mcpServers: selected.mcpServers,
    toolQueue: selected.toolQueue,
    reasoning: selected.reasoning,
    default: selected.default,
  };
}
