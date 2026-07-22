import { defaultToolCatalog } from "../../../tools/catalog.js";
import type { AgentRegistrationOptions, ResolvedAgentOptions } from "./types.js";

export const AGENT_STEP_IDS = {
  loop: "agent.loop",
  execDispatch: "agent.exec.dispatch",
  execWaitEffect: "agent.exec.wait_effect",
  execWaitApproval: "agent.exec.wait_approval",
  execWaitUser: "agent.exec.wait_user",
  execCollect: "agent.exec.collect",
  execFinalize: "agent.exec.finalize",
} as const;

const DEFAULT_OPTIONS: Required<
  Pick<
    AgentRegistrationOptions,
    | "decisionModel"
    | "agentModel"
    | "effectResultLookupTool"
    | "finalizeToolName"
    | "defaultGoal"
    | "reasoningRequest"
    | "reasoningRetention"
  >
> = {
  decisionModel: "z-ai/glm-5.2",
  agentModel: "z-ai/glm-5.2",
  effectResultLookupTool: "effect_result_lookup",
  finalizeToolName: "FinalizeAnswer",
  defaultGoal: "Resolve the request successfully.",
  reasoningRequest: { mode: "provider_visible" },
  reasoningRetention: { mode: "live_only", days: 7 },
};

export const DEFAULT_AGENT_TOOL_NAMES = [
  "free.weather.current",
  "free.weather.forecast",
  "free.time.current",
  "free.geocode.lookup",
  "free.exchange.rate",
  "internet.search",
  "internet.news",
  "internet.images",
  "internet.search_advanced",
  "internet.extract",
  "internet.research",
  "internet.research_status",
  "internet.crawl",
  "internet.map",
  "evidence.extract",
] as const;

export const REACT_DELIBERATOR_TOOL_NAMES = DEFAULT_AGENT_TOOL_NAMES;

export function resolveAgentOptions(
  options?: AgentRegistrationOptions,
): ResolvedAgentOptions {
  const config = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const agentToolNames = options?.agentToolNames ?? options?.deliberatorToolNames ?? options?.thinkerToolNames;
  const agentTools =
    options?.agentTools ??
    options?.deliberatorTools ??
    options?.thinkerTools ??
    defaultToolCatalog.toModelTools(
      agentToolNames ?? [...DEFAULT_AGENT_TOOL_NAMES],
    );
  const capabilityManifest =
    options?.capabilityManifest ??
    defaultToolCatalog.toCapabilityManifest(
      agentToolNames ?? [...DEFAULT_AGENT_TOOL_NAMES],
    );
  const agentToolsProvider =
    options?.agentToolsProvider ??
    options?.deliberatorToolsProvider ??
    options?.thinkerToolsProvider ??
    ((_ctx) => agentTools);
  const capabilityManifestProvider =
    options?.capabilityManifestProvider ?? ((_ctx) => capabilityManifest);

  return {
    ...(options?.agentProvider !== undefined ? { agentProvider: options.agentProvider } : {}),
    agentModel:
      options?.agentModel ??
      options?.deliberatorModel ??
      (options?.decisionModel !== undefined ? config.decisionModel : config.agentModel),
    agentToolsProvider,
    capabilityManifestProvider,
    ...(options?.managedWorktreeProposalProvider !== undefined
      ? { managedWorktreeProposalProvider: options.managedWorktreeProposalProvider }
      : {}),
    effectResultLookupTool: config.effectResultLookupTool,
    finalizeToolName: config.finalizeToolName,
    defaultGoal: config.defaultGoal,
    reasoningRequest: options?.reasoningRequest ?? { mode: "provider_visible" },
    reasoningRetention: options?.reasoningRetention ?? { mode: "live_only", days: 7 },
    reasoningRetentionScope: options?.reasoningRetentionScope?.trim() || "default",
  };
}
