import type { TuiProfile } from "../contracts.js";

/**
 * Local Core owns persistence. Client-supplied profiles can still describe
 * agent, model, tool, and interaction behavior, but cannot select a store.
 */
export function toCoreExecutionProfile(profile: TuiProfile): TuiProfile {
  const coreProfile = { ...profile };
  delete coreProfile.storeDriver;
  return coreProfile;
}
