import type {
  DesktopLegacyUiStateEntries,
  DesktopModelProvider,
  DesktopOnboardingRecordV1,
  DesktopSettings,
} from "./contracts.js";

const DESKTOP_THREADS_STORAGE_KEY = "kchat:web:threads:v2" as const;

export function desktopUiStateContainsOnboardingHandoff(
  entries: DesktopLegacyUiStateEntries,
  handoffId: string,
): boolean {
  const raw = entries[DESKTOP_THREADS_STORAGE_KEY];
  if (typeof raw !== "string") {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    const states = (parsed as { states?: unknown }).states;
    if (
      typeof states !== "object" ||
      states === null ||
      Array.isArray(states)
    ) {
      return false;
    }
    return Object.values(states).some(
      (state) =>
        typeof state === "object" &&
        state !== null &&
        Array.isArray(state) === false &&
        (state as { onboardingHandoffId?: unknown }).onboardingHandoffId ===
          handoffId,
    );
  } catch {
    return false;
  }
}

export function deriveDesktopOnboardingRouteV1(input: {
  record?: DesktopOnboardingRecordV1 | undefined;
  providerVerified: boolean;
  projectReady: boolean;
  hasExistingState: boolean;
}): {
  mode: "first_run" | "resume" | "repair";
  step: "welcome" | "provider" | "project" | "review";
} {
  const mode =
    input.record?.status === "complete" &&
    (!input.providerVerified || !input.projectReady)
      ? "repair"
      : input.hasExistingState
        ? "resume"
        : "first_run";
  const step =
    mode === "first_run" &&
    input.providerVerified === false &&
    input.record?.provider === undefined
      ? "welcome"
      : input.providerVerified === false
        ? "provider"
        : input.projectReady === false
          ? "project"
          : "review";
  return { mode, step };
}

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
