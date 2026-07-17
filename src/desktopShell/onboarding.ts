import type { DesktopModelProvider, DesktopSettings } from "./contracts.js";

export type DesktopOnboardingStep =
  | "provider"
  | "key"
  | "project"
  | "finish"
  | "complete";

export type DesktopProviderRequirementState =
  | "choice_required"
  | "credential_required"
  | "ready";

export interface DesktopProviderRequirement {
  state: DesktopProviderRequirementState;
  summary: string;
  detail: string;
}

export interface DesktopOnboardingState {
  providerSelectionCompleted: boolean;
  providerCredentialSatisfied: boolean;
  projectOnboardingCompleted: boolean;
  setupCompleted: boolean;
  providerRequirementState: DesktopProviderRequirementState;
  providerIssueOwnedBySetup: boolean;
  nextStep: DesktopOnboardingStep;
}

export const DESKTOP_SETUP_STEPS = [
  "welcome",
  "provider",
  "key",
  "project",
  "finish",
] as const;

export type DesktopSetupStep = (typeof DESKTOP_SETUP_STEPS)[number];

export const DESKTOP_SETUP_PROVIDERS: readonly DesktopModelProvider[] = [
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
  "lmstudio",
];

export interface DesktopSetupProjectLike {
  path: string;
  label: string;
  addedAt?: string | undefined;
}

type DesktopProviderCredentialSettings = Pick<
  DesktopSettings,
  "selectedProvider" | "openrouterApiKey" | "openaiApiKey" | "anthropicApiKey"
>;

const DESKTOP_PROVIDER_LABELS: Record<DesktopModelProvider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

const DESKTOP_PROVIDER_ENV_VARS: Partial<
  Record<DesktopModelProvider, string>
> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export function desktopProviderRequiresApiKey(
  provider: DesktopModelProvider,
): boolean {
  return (
    provider === "openrouter" ||
    provider === "openai" ||
    provider === "anthropic"
  );
}

export function hasConfiguredDesktopProviderCredential(
  settings: DesktopProviderCredentialSettings,
): boolean {
  if (desktopProviderRequiresApiKey(settings.selectedProvider) === false) {
    return true;
  }
  const key =
    settings.selectedProvider === "openai"
      ? settings.openaiApiKey
      : settings.selectedProvider === "anthropic"
        ? settings.anthropicApiKey
        : settings.openrouterApiKey;
  return typeof key === "string" && key.trim().length > 0;
}

export function toDesktopSetupStep(
  step: DesktopOnboardingState["nextStep"],
): DesktopSetupStep {
  return step === "complete" ? "welcome" : step;
}

export function getPreviousDesktopSetupStep(
  step: DesktopSetupStep,
): DesktopSetupStep {
  const index = DESKTOP_SETUP_STEPS.indexOf(step);
  return DESKTOP_SETUP_STEPS[Math.max(0, index - 1)] ?? "welcome";
}

export function getNextDesktopSetupStep(
  step: DesktopSetupStep,
): DesktopSetupStep {
  const index = DESKTOP_SETUP_STEPS.indexOf(step);
  return DESKTOP_SETUP_STEPS[
    Math.min(DESKTOP_SETUP_STEPS.length - 1, index + 1)
  ] ?? "finish";
}

export function getDesktopSetupAdvanceError(input: {
  step: DesktopSetupStep;
  settings: Pick<
    DesktopSettings,
    | "selectedProvider"
    | "providerSelectionCompletedAt"
    | "openrouterApiKey"
    | "openaiApiKey"
    | "anthropicApiKey"
  >;
  setupProject?: DesktopSetupProjectLike | undefined;
}): string | undefined {
  const onboarding = deriveDesktopOnboardingState({
    ...input.settings,
    projects: [],
    setupCompletedAt: undefined,
  });

  if (
    input.step === "provider" &&
    onboarding.providerSelectionCompleted === false
  ) {
    return "Choose a model provider before continuing.";
  }

  if (
    input.step === "key" &&
    desktopProviderRequiresApiKey(input.settings.selectedProvider)
  ) {
    const key =
      input.settings.selectedProvider === "openai"
        ? input.settings.openaiApiKey
        : input.settings.selectedProvider === "anthropic"
          ? input.settings.anthropicApiKey
          : input.settings.openrouterApiKey;
    if (typeof key !== "string" || key.trim().length === 0) {
      return `Enter ${DESKTOP_PROVIDER_ENV_VARS[input.settings.selectedProvider]} before continuing.`;
    }
  }

  if (input.step === "project" && input.setupProject === undefined) {
    return "Choose a project before continuing.";
  }

  return ;
}

export function buildCompletedDesktopSetupSettings(input: {
  settings: DesktopSettings;
  workspaceProjects: readonly DesktopSetupProjectLike[];
  setupProject: DesktopSetupProjectLike;
  completedAt: string;
}): DesktopSettings {
  const projectAlreadyPresent = input.workspaceProjects.some(
    (project) => project.path === input.setupProject.path,
  );
  const projects = projectAlreadyPresent
    ? input.workspaceProjects
    : [...input.workspaceProjects, input.setupProject];

  return {
    ...input.settings,
    projects: projects.map((project) => ({
      path: project.path,
      label: project.label,
      addedAt: project.addedAt ?? input.completedAt,
    })),
    setupCompletedAt: input.completedAt,
    advancedWorkspaceEnabled: false,
  };
}

export function deriveDesktopOnboardingState(
  settings: Pick<
    DesktopSettings,
    | "selectedProvider"
    | "projects"
    | "providerSelectionCompletedAt"
    | "setupCompletedAt"
    | "openrouterApiKey"
    | "openaiApiKey"
    | "anthropicApiKey"
  >,
): DesktopOnboardingState {
  const setupCompleted =
    typeof settings.setupCompletedAt === "string" &&
    settings.setupCompletedAt.trim().length > 0;
  const providerSelectionCompleted =
    typeof settings.providerSelectionCompletedAt === "string" &&
    settings.providerSelectionCompletedAt.trim().length > 0;
  const providerCredentialSatisfied =
    providerSelectionCompleted &&
    hasConfiguredDesktopProviderCredential(settings);
  const projectOnboardingCompleted =
    setupCompleted ||
    (Array.isArray(settings.projects) && settings.projects.length > 0);
  const providerRequirementState = providerSelectionCompleted
    ? providerCredentialSatisfied
      ? "ready"
      : "credential_required" : "choice_required";
  const nextStep: DesktopOnboardingStep =
    providerRequirementState === "choice_required"
      ? "provider"
      : providerRequirementState === "credential_required" &&
          setupCompleted === false
        ? "key"
        : projectOnboardingCompleted === false &&
            setupCompleted === false
          ? "project"
          : setupCompleted === false
            ? "finish"
            : "complete";

  return {
    providerSelectionCompleted,
    providerCredentialSatisfied,
    projectOnboardingCompleted,
    setupCompleted,
    providerRequirementState,
    providerIssueOwnedBySetup:
      providerRequirementState !== "ready" && setupCompleted === false,
    nextStep,
  };
}

export function describeDesktopProviderRequirement(
  settings: Pick<
    DesktopSettings,
    | "selectedProvider"
    | "projects"
    | "providerSelectionCompletedAt"
    | "setupCompletedAt"
    | "openrouterApiKey"
    | "openaiApiKey"
    | "anthropicApiKey"
  >,
): DesktopProviderRequirement | undefined {
  const onboarding = deriveDesktopOnboardingState(settings);
  if (onboarding.providerRequirementState === "ready") {
    return ;
  }
  if (onboarding.providerRequirementState === "choice_required") {
    return {
      state: "choice_required",
      summary: "Provider choice required.",
      detail:
        "Choose a model provider to finish Desktop setup before starting a run.",
    };
  }

  const providerLabel = DESKTOP_PROVIDER_LABELS[settings.selectedProvider];
  const envVar = DESKTOP_PROVIDER_ENV_VARS[settings.selectedProvider];
  return {
    state: "credential_required",
    summary: "Provider key required.",
    detail:
      envVar !== undefined
        ? `${providerLabel} is selected, but ${envVar} is not configured yet. Open settings or finish setup before starting a run.`
        : `${providerLabel} is selected, but its local endpoint is not ready yet. Open settings or finish setup before starting a run.`,
  };
}
