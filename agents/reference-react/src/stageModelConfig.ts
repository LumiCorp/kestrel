import type { AgentRegistrationOptions } from "./types.js";

export type AgentModelOptionKey = keyof Pick<AgentRegistrationOptions, "agentModel">;

export interface AgentModelConfigStage {
  stageId: string;
  label: string;
  modelOptionKey: AgentModelOptionKey;
  modelConfigurable: true;
}

export const AGENT_MODEL_CONFIG_STAGES = [
  {
    stageId: "agent.loop",
    label: "Agent loop",
    modelOptionKey: "agentModel",
    modelConfigurable: true,
  },
] as const satisfies readonly AgentModelConfigStage[];

const AGENT_MODEL_OPTION_KEY_BY_STAGE_ID: Record<string, AgentModelOptionKey> =
  Object.fromEntries(
    AGENT_MODEL_CONFIG_STAGES.map((stage) => [stage.stageId, stage.modelOptionKey]),
  ) as Record<string, AgentModelOptionKey>;

export function applyStageModelOverridesToAgentOptions(
  modelByStage: Record<string, string | undefined> | undefined,
): Partial<AgentRegistrationOptions> {
  const overrides: Partial<AgentRegistrationOptions> = {};

  if (modelByStage === undefined) {
    return overrides;
  }

  for (const [stageId, modelValue] of Object.entries(modelByStage)) {
    const modelOptionKey = AGENT_MODEL_OPTION_KEY_BY_STAGE_ID[stageId];
    if (modelOptionKey === undefined) {
      continue;
    }

    const trimmedModel = modelValue?.trim();
    if (trimmedModel === undefined || trimmedModel.length === 0) {
      continue;
    }

    overrides[modelOptionKey] = trimmedModel;
  }

  return overrides;
}
