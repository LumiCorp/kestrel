import type { ShellPresetId } from "../../src/profile/runtimeProfile.js";

export type TuiProductEnvironmentPresetId = Extract<
  ShellPresetId,
  "cli_dev_local" | "workspace_hosted" | "cli_safe_local"
>;

export interface TuiEnvironmentPresentation {
  label: string;
  detail: string;
}

const ENVIRONMENT_PRESENTATION = {
  cli_dev_local: {
    label: "Developer workspace",
    detail:
      "Uses tools installed in the selected local workspace, subject to the active execution policy.",
  },
  workspace_hosted: {
    label: "Developer workspace (hosted)",
    detail:
      "Uses tools installed in the hosted developer workspace, subject to the active execution policy.",
  },
  cli_safe_local: {
    label: "Safe sandbox",
    detail:
      "Runs isolated snippets in a fresh scratch container, not the project workspace; it cannot install, build, test, or validate the selected project.",
  },
} satisfies Record<TuiProductEnvironmentPresetId, TuiEnvironmentPresentation>;

const UNKNOWN_ENVIRONMENT_PRESENTATION: TuiEnvironmentPresentation = {
  label: "Environment unknown",
  detail: "No supported execution environment identity is available.",
};

export function describeTuiEnvironmentPreset(
  presetId: unknown,
): TuiEnvironmentPresentation {
  if (isTuiProductEnvironmentPresetId(presetId)) {
    return ENVIRONMENT_PRESENTATION[presetId];
  }
  return UNKNOWN_ENVIRONMENT_PRESENTATION;
}

export function formatTuiEnvironmentLabel(presetId: unknown): string {
  return describeTuiEnvironmentPreset(presetId).label;
}

export function formatTuiAssemblyLabel(presetId: unknown): string {
  return `Kestrel on ${formatTuiEnvironmentLabel(presetId)}`;
}

function isTuiProductEnvironmentPresetId(
  value: unknown,
): value is TuiProductEnvironmentPresetId {
  return value === "cli_dev_local"
    || value === "workspace_hosted"
    || value === "cli_safe_local";
}
