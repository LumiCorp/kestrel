import { ProfileStore } from "../../cli/config/ProfileStore.js";
import type { TuiProfile } from "../../cli/contracts.js";
import type { RunnerProfileProvider } from "../../cli/runner/RunnerHost.js";
import {
  ModelPolicyStore,
  resolveProfileWithModelPolicy,
} from "../profile/modelPolicy.js";
import { createWebDemoProfile } from "../web/profile.js";
import {
  LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION,
  LOCAL_CORE_DESKTOP_PROFILE_ID,
  parseLocalCoreDesktopExecutionConfig,
  type LocalCoreDesktopExecutionConfig,
} from "./contracts.js";
import type { LocalCoreRuntimeConfigurationV1 } from "./runtimeConfiguration.js";

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
  const baseProfile = createWebDemoProfile("desktop");
  return resolveProfileWithModelPolicy(
    {
      ...baseProfile,
      id: LOCAL_CORE_DESKTOP_PROFILE_ID,
      sessionPrefix: LOCAL_CORE_DESKTOP_PROFILE_ID,
      default: false,
    },
    options.runtimeConfiguration?.modelPolicy
      ?? new ModelPolicyStore(homePath).read(),
  );
}

export async function resolveLocalCoreDesktopExecutionConfig(
  homePath: string,
  options: LocalCoreProfileProviderOptions = {},
): Promise<LocalCoreDesktopExecutionConfig> {
  assertNoLocalCoreReservedProfileCollision(await new ProfileStore(homePath).load());
  const profile = resolveLocalCoreDesktopProfile(homePath, options);
  return parseLocalCoreDesktopExecutionConfig({
    version: LOCAL_CORE_DESKTOP_EXECUTION_CONFIG_VERSION,
    profileId: LOCAL_CORE_DESKTOP_PROFILE_ID,
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
  options: LocalCoreProfileProviderOptions = {},
): RunnerProfileProvider {
  const store = new ProfileStore(homePath);
  const resolveConfiguredProfiles = (profiles: readonly TuiProfile[]): TuiProfile[] => {
    const runtimeConfiguration = options.runtimeConfiguration;
    return runtimeConfiguration === undefined
      ? [...profiles]
      : resolveLocalCoreConfiguredProfiles(profiles, runtimeConfiguration);
  };
  return {
    async listProfiles() {
      const configuredProfiles = await store.load();
      assertNoLocalCoreReservedProfileCollision(configuredProfiles);
      return [
        ...resolveConfiguredProfiles(configuredProfiles),
        resolveLocalCoreDesktopProfile(homePath, options),
      ];
    },
    async getProfile(profileId) {
      const configuredProfiles = await store.load();
      assertNoLocalCoreReservedProfileCollision(configuredProfiles);
      if (profileId === LOCAL_CORE_DESKTOP_PROFILE_ID) {
        return resolveLocalCoreDesktopProfile(homePath, options);
      }
      return store.findById(resolveConfiguredProfiles(configuredProfiles), profileId);
    },
  };
}
