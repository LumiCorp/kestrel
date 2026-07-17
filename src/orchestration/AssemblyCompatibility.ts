import type { SupportedAgent, TuiProfile } from "../../cli/contracts.js";
import type { InteractionMode } from "../mode/contracts.js";

export type AssemblyCompatibilityStatus = "compatible" | "downgraded" | "incompatible";
export type AssemblyCompatibilityDecisionSource = "profile" | "policy" | "operator" | "model" | "runtime";

export interface AssemblyCompatibilityMetadata {
  modelProvider?: TuiProfile["modelProvider"] | undefined;
  model?: string | undefined;
  promptVariant?: string | undefined;
  compatibilityProfile?: string | undefined;
  compatibilityStatus?: AssemblyCompatibilityStatus | undefined;
  compatibilityDecisionSource?: AssemblyCompatibilityDecisionSource | undefined;
  downgradeReason?: string | undefined;
  capabilityLossReason?: string | undefined;
}

export interface AssemblyCompatibilityDecision {
  provider?: TuiProfile["modelProvider"] | undefined;
  model?: string | undefined;
  promptVariant?: string | undefined;
  compatibilityProfile?: string | undefined;
  compatibilityStatus: AssemblyCompatibilityStatus;
  compatibilityDecisionSource: AssemblyCompatibilityDecisionSource;
  downgradeReason?: string | undefined;
  capabilityLossReason?: string | undefined;
}

export function buildCompatibilityDecision(input: {
  agent: SupportedAgent;
  interactionMode: InteractionMode;
  provider?: TuiProfile["modelProvider"] | undefined;
  model?: string | undefined;
  requestedPromptVariant?: string | undefined;
  currentPromptVariant?: string | undefined;
  decisionSource: AssemblyCompatibilityDecisionSource;
  capabilityLossReason?: string | undefined;
}): AssemblyCompatibilityDecision {
  const provider = input.provider;
  const model = input.model;
  const compatibilityProfile = resolveCompatibilityProfile(provider, model);
  const supportedPromptVariants = buildSupportedPromptVariants({
    agent: input.agent,
    interactionMode: input.interactionMode,
    provider,
  });

  const requestedPromptVariant = input.requestedPromptVariant?.trim();
  if (
    requestedPromptVariant !== undefined &&
    requestedPromptVariant.length > 0 &&
    supportedPromptVariants.includes(requestedPromptVariant) === false
  ) {
    return {
      provider,
      model,
      promptVariant: requestedPromptVariant,
      compatibilityProfile,
      compatibilityStatus: "incompatible",
      compatibilityDecisionSource: input.decisionSource,
      downgradeReason:
        provider === undefined
          ? `Prompt variant '${requestedPromptVariant}' requires a recorded provider selection.`
          : `Prompt variant '${requestedPromptVariant}' is not compatible with provider '${provider}'.`,
      ...(input.capabilityLossReason !== undefined ? { capabilityLossReason: input.capabilityLossReason } : {}),
    };
  }

  const fallbackPromptVariant =
    firstNonEmptyString(requestedPromptVariant, input.currentPromptVariant, supportedPromptVariants[0]) ?? undefined;
  const defaultPromptVariant = buildCanonicalPromptVariant({
    agent: input.agent,
    interactionMode: input.interactionMode,
  });
  const isProviderSpecificVariant =
    fallbackPromptVariant !== undefined && fallbackPromptVariant !== defaultPromptVariant;

  return {
    provider,
    model,
    promptVariant: fallbackPromptVariant,
    compatibilityProfile,
    compatibilityStatus: input.capabilityLossReason !== undefined ? "downgraded" : "compatible",
    compatibilityDecisionSource: input.decisionSource,
    ...(isProviderSpecificVariant
      ? {
          downgradeReason:
            input.capabilityLossReason === undefined
              ? `Runtime selected provider-specific prompt variant '${fallbackPromptVariant}'.`
              : undefined,
        }
      : {}),
    ...(input.capabilityLossReason !== undefined ? { capabilityLossReason: input.capabilityLossReason } : {}),
  };
}

export function readAssemblyCompatibilityMetadata(
  metadata: Record<string, unknown> | undefined,
): AssemblyCompatibilityMetadata {
  return {
    ...(asProviderId(metadata?.modelProvider) !== undefined ? { modelProvider: asProviderId(metadata?.modelProvider) } : {}),
    ...(typeof metadata?.model === "string" ? { model: metadata.model } : {}),
    ...(typeof metadata?.promptVariant === "string" ? { promptVariant: metadata.promptVariant } : {}),
    ...(typeof metadata?.compatibilityProfile === "string"
      ? { compatibilityProfile: metadata.compatibilityProfile }
      : {}),
    ...(isCompatibilityStatus(metadata?.compatibilityStatus)
      ? { compatibilityStatus: metadata.compatibilityStatus }
      : {}),
    ...(isDecisionSource(metadata?.compatibilityDecisionSource)
      ? { compatibilityDecisionSource: metadata.compatibilityDecisionSource }
      : {}),
    ...(typeof metadata?.downgradeReason === "string" ? { downgradeReason: metadata.downgradeReason } : {}),
    ...(typeof metadata?.capabilityLossReason === "string"
      ? { capabilityLossReason: metadata.capabilityLossReason }
      : {}),
  };
}

export function mergeAssemblyCompatibilityMetadata(
  metadata: Record<string, unknown> | undefined,
  decision: AssemblyCompatibilityDecision,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    ...(decision.provider !== undefined ? { modelProvider: decision.provider } : {}),
    ...(decision.model !== undefined ? { model: decision.model } : {}),
    ...(decision.promptVariant !== undefined ? { promptVariant: decision.promptVariant } : {}),
    ...(decision.compatibilityProfile !== undefined
      ? { compatibilityProfile: decision.compatibilityProfile }
      : {}),
    compatibilityStatus: decision.compatibilityStatus,
    compatibilityDecisionSource: decision.compatibilityDecisionSource,
    ...(decision.downgradeReason !== undefined ? { downgradeReason: decision.downgradeReason } : {}),
    ...(decision.capabilityLossReason !== undefined
      ? { capabilityLossReason: decision.capabilityLossReason }
      : {}),
  };
}

export function buildCanonicalPromptVariant(input: {
  agent: SupportedAgent;
  interactionMode: InteractionMode;
}): string {
  return `${input.agent}:${input.interactionMode}`;
}

function buildSupportedPromptVariants(input: {
  agent: SupportedAgent;
  interactionMode: InteractionMode;
  provider?: TuiProfile["modelProvider"] | undefined;
}): string[] {
  const canonical = buildCanonicalPromptVariant(input);
  if (input.provider === "openai") {
    return [canonical, `${canonical}:responses`];
  }
  if (input.provider === "anthropic") {
    return [canonical, `${canonical}:messages`];
  }
  if (input.provider === "ollama" || input.provider === "lmstudio") {
    return [canonical, `${canonical}:chat`];
  }
  return [canonical, `${canonical}:router`];
}

function resolveCompatibilityProfile(
  provider?: TuiProfile["modelProvider"] | undefined,
  model?: string | undefined,
): string | undefined {
  if (provider === undefined) {
    return ;
  }
  if (provider === "openai") {
    return "openai.responses";
  }
  if (provider === "anthropic") {
    return "anthropic.messages";
  }
  if (provider === "ollama" || provider === "lmstudio") {
    return "openai.chat_compatible.local";
  }
  const normalizedModel = model?.toLowerCase();
  if (normalizedModel?.includes("gpt-5") === true || normalizedModel?.includes("gpt-4.1") === true) {
    return "router.openai_compatible";
  }
  if (normalizedModel?.includes("claude") === true) {
    return "router.anthropic_compatible";
  }
  return "router.chat";
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return ;
}

function isCompatibilityStatus(value: unknown): value is AssemblyCompatibilityStatus {
  return value === "compatible" || value === "downgraded" || value === "incompatible";
}

function isDecisionSource(value: unknown): value is AssemblyCompatibilityDecisionSource {
  return value === "profile" || value === "policy" || value === "operator" || value === "model" || value === "runtime";
}

function asProviderId(value: unknown): TuiProfile["modelProvider"] | undefined {
  return value === "openrouter" ||
      value === "openai" ||
      value === "anthropic" ||
      value === "ollama" ||
      value === "lmstudio"
    ? value
    : undefined;
}
