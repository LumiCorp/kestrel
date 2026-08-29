import type { TuiSessionMeta } from "../contracts.js";
import type { LocalCoreExecutionProfileResolution } from "../../src/localCore/contracts.js";

export type TuiEnvironmentPresetId = "cli_safe_local" | "cli_dev_local";

export class TuiEnvironmentIdentityError extends Error {
  readonly code: "TUI_ENVIRONMENT_UNKNOWN" | "TUI_ENVIRONMENT_CONFLICT";

  constructor(
    code: "TUI_ENVIRONMENT_UNKNOWN" | "TUI_ENVIRONMENT_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "TuiEnvironmentIdentityError";
    this.code = code;
  }
}

export function defaultTuiEnvironmentPresetId(
  session: Pick<TuiSessionMeta, "workspaceBinding" | "workspaceId" | "workspaceRoot">,
): TuiEnvironmentPresetId {
  if (session.workspaceBinding === "active") return "cli_dev_local";
  if (session.workspaceBinding === "detached") return "cli_safe_local";
  return session.workspaceId !== undefined || session.workspaceRoot !== undefined
    ? "cli_dev_local"
    : "cli_safe_local";
}

export function readTuiEnvironmentPresetId(
  value: unknown,
): TuiEnvironmentPresetId | undefined {
  return value === "cli_safe_local" || value === "cli_dev_local"
    ? value
    : undefined;
}

export function resolveTuiSessionEnvironment(input: {
  session: TuiSessionMeta;
  runtimeEnvironmentPresetId?: unknown;
  requireRuntimeIdentity?: boolean | undefined;
}): TuiEnvironmentPresetId {
  const persisted = readTuiEnvironmentPresetId(input.session.environmentPresetId);
  const runtime = readTuiEnvironmentPresetId(input.runtimeEnvironmentPresetId);

  if (input.runtimeEnvironmentPresetId !== undefined && runtime === undefined) {
    throw new TuiEnvironmentIdentityError(
      "TUI_ENVIRONMENT_UNKNOWN",
      `Environment unknown for session '${input.session.name}': runtime reported unsupported identity '${String(input.runtimeEnvironmentPresetId)}'.`,
    );
  }
  if (persisted !== undefined && runtime !== undefined && persisted !== runtime) {
    throw new TuiEnvironmentIdentityError(
      "TUI_ENVIRONMENT_CONFLICT",
      `Environment consistency failure for session '${input.session.name}': persisted '${persisted}' conflicts with runtime '${runtime}'.`,
    );
  }
  if (input.requireRuntimeIdentity === true && runtime === undefined) {
    throw new TuiEnvironmentIdentityError(
      "TUI_ENVIRONMENT_UNKNOWN",
      `Environment unknown for session '${input.session.name}': the started runtime has no exact environment identity.`,
    );
  }
  if (runtime !== undefined) return runtime;
  if (persisted !== undefined) return persisted;
  if (input.session.started) {
    throw new TuiEnvironmentIdentityError(
      "TUI_ENVIRONMENT_UNKNOWN",
      `Environment unknown for session '${input.session.name}': no persisted or runtime identity is available.`,
    );
  }
  return defaultTuiEnvironmentPresetId(input.session);
}

export function toResolvedSessionIdentity(
  resolution: LocalCoreExecutionProfileResolution,
  expectedEnvironmentPresetId: TuiEnvironmentPresetId,
): Pick<
  TuiSessionMeta,
  | "agentProfileId"
  | "agentProfileLabel"
  | "environmentShellKind"
  | "environmentPresetId"
  | "environmentCapabilityPackIds"
> {
  const profile = resolution.resolvedProfile;
  const environmentPresetId = readTuiEnvironmentPresetId(
    resolution.environmentPreset.id,
  );
  if (environmentPresetId === undefined) {
    throw new TuiEnvironmentIdentityError(
      "TUI_ENVIRONMENT_UNKNOWN",
      `Environment unknown: Local Core resolved unsupported CLI identity '${resolution.environmentPreset.id}'.`,
    );
  }
  if (environmentPresetId !== expectedEnvironmentPresetId) {
    throw new TuiEnvironmentIdentityError(
      "TUI_ENVIRONMENT_CONFLICT",
      `Environment consistency failure: Local Core resolved '${environmentPresetId}' instead of requested '${expectedEnvironmentPresetId}'.`,
    );
  }
  if (
    profile.environmentPresetId !== undefined &&
    profile.environmentPresetId !== environmentPresetId
  ) {
    throw new TuiEnvironmentIdentityError(
      "TUI_ENVIRONMENT_CONFLICT",
      `Environment consistency failure: resolved profile records '${profile.environmentPresetId}' while Local Core reports '${environmentPresetId}'.`,
    );
  }
  return {
    ...(profile.agentProfileId !== undefined
      ? { agentProfileId: profile.agentProfileId }
      : {}),
    ...(profile.agentProfileLabel !== undefined
      ? { agentProfileLabel: profile.agentProfileLabel }
      : {}),
    ...(profile.environmentShellKind !== undefined
      ? { environmentShellKind: profile.environmentShellKind }
      : {}),
    environmentPresetId,
    ...(profile.environmentCapabilityPackIds !== undefined
      ? {
          environmentCapabilityPackIds: [
            ...profile.environmentCapabilityPackIds,
          ],
        }
      : {}),
  };
}
