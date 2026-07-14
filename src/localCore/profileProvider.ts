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

export class LocalCoreReservedProfileIdError extends Error {
  constructor() {
    super(
      `Profile id '${LOCAL_CORE_DESKTOP_PROFILE_ID}' is reserved by Local Core. Rename the persisted profile before using the Core-owned Desktop profile.`,
    );
    this.name = "LocalCoreReservedProfileIdError";
  }
}

export function resolveLocalCoreDesktopProfile(homePath: string): TuiProfile {
  const baseProfile = createWebDemoProfile("desktop");
  return resolveProfileWithModelPolicy(
    {
      ...baseProfile,
      id: LOCAL_CORE_DESKTOP_PROFILE_ID,
      sessionPrefix: LOCAL_CORE_DESKTOP_PROFILE_ID,
      default: false,
    },
    new ModelPolicyStore(homePath).read(),
  );
}

export async function resolveLocalCoreDesktopExecutionConfig(
  homePath: string,
): Promise<LocalCoreDesktopExecutionConfig> {
  assertNoLocalCoreReservedProfileCollision(await new ProfileStore(homePath).load());
  const profile = resolveLocalCoreDesktopProfile(homePath);
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

export function createLocalCoreProfileProvider(homePath: string): RunnerProfileProvider {
  const store = new ProfileStore(homePath);
  return {
    async listProfiles() {
      const configuredProfiles = await store.load();
      assertNoLocalCoreReservedProfileCollision(configuredProfiles);
      return [
        ...configuredProfiles,
        resolveLocalCoreDesktopProfile(homePath),
      ];
    },
    async getProfile(profileId) {
      const configuredProfiles = await store.load();
      assertNoLocalCoreReservedProfileCollision(configuredProfiles);
      if (profileId === LOCAL_CORE_DESKTOP_PROFILE_ID) {
        return resolveLocalCoreDesktopProfile(homePath);
      }
      return store.findById(configuredProfiles, profileId);
    },
  };
}
