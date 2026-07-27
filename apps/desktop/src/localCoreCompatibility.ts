import {
  LOCAL_CORE_EXECUTION_PROFILE_RESOLUTION_CAPABILITY,
} from "../../../src/localCore/contracts.js";

import { createDesktopError } from "./errors.js";

export const DESKTOP_LOCAL_CORE_EXECUTION_PROFILE_INCOMPATIBLE =
  "desktop.local_core_execution_profile_incompatible";

export interface LocalCoreExecutionProfileCapabilityStatus {
  manifest?: {
    capabilities: readonly string[];
  } | undefined;
}

/**
 * Desktop must not defer this check until a user submits work. A live Core
 * that does not advertise the endpoint cannot prepare an execution safely.
 */
export function assertDesktopLocalCoreExecutionProfileCompatibility(
  status: LocalCoreExecutionProfileCapabilityStatus,
): void {
  if (
    status.manifest?.capabilities.includes(
      LOCAL_CORE_EXECUTION_PROFILE_RESOLUTION_CAPABILITY,
    )
  ) return;

  throw createDesktopError({
    code: DESKTOP_LOCAL_CORE_EXECUTION_PROFILE_INCOMPATIBLE,
    message: "Kestrel Local Core needs an update before Desktop can run work.",
    details:
      "The running Local Core does not support Desktop execution-profile resolution. Install the current Kestrel Desktop build, then relaunch Kestrel.",
  });
}
