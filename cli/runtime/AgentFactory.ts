import {
  applyStageModelOverridesToAgentOptions,
  registerAgentReferenceRuntime,
  type ModelToolSpec,
  type AgentRegistrationOptions,
  type Kestrel,
} from "../../src/index.js";
import type { SupportedAgent } from "../contracts.js";

export interface RegisterAgentOptions {
  agentProvider?: AgentRegistrationOptions["agentProvider"] | undefined;
  thinkerTools?: ModelToolSpec[] | undefined;
  thinkerToolsProvider?: AgentRegistrationOptions["thinkerToolsProvider"] | undefined;
  resolverTools?: ModelToolSpec[] | undefined;
  resolverToolsProvider?: AgentRegistrationOptions["deliberatorToolsProvider"] | undefined;
  capabilityManifest?: AgentRegistrationOptions["capabilityManifest"] | undefined;
  capabilityManifestProvider?:
    | AgentRegistrationOptions["capabilityManifestProvider"]
    | undefined;
  managedWorktreeProposalProvider?:
    | AgentRegistrationOptions["managedWorktreeProposalProvider"]
    | undefined;
  agentStageModelByStage?: Record<string, string> | undefined;
  reasoningRequest?: AgentRegistrationOptions["reasoningRequest"] | undefined;
  reasoningRetention?: AgentRegistrationOptions["reasoningRetention"] | undefined;
  reasoningRetentionScope?: AgentRegistrationOptions["reasoningRetentionScope"] | undefined;
}

export function registerAgent(
  kestrel: Kestrel,
  agent: SupportedAgent,
  options?: RegisterAgentOptions,
): { entryStepAgent: string } {
  if (agent === "reference-react") {
    return registerAgentReferenceRuntime(kestrel, {
      ...(options?.agentProvider !== undefined ? { agentProvider: options.agentProvider } : {}),
      ...(options?.thinkerTools !== undefined ? { thinkerTools: options.thinkerTools } : {}),
      ...(options?.thinkerToolsProvider !== undefined
        ? { thinkerToolsProvider: options.thinkerToolsProvider }
        : {}),
      ...(options?.resolverTools !== undefined ? { resolverTools: options.resolverTools } : {}),
      ...(options?.resolverToolsProvider !== undefined
        ? { resolverToolsProvider: options.resolverToolsProvider }
        : {}),
      ...(options?.capabilityManifest !== undefined
        ? { capabilityManifest: options.capabilityManifest }
        : {}),
      ...(options?.capabilityManifestProvider !== undefined
        ? { capabilityManifestProvider: options.capabilityManifestProvider }
        : {}),
      ...(options?.managedWorktreeProposalProvider !== undefined
        ? { managedWorktreeProposalProvider: options.managedWorktreeProposalProvider }
        : {}),
      ...(options?.reasoningRequest !== undefined
        ? { reasoningRequest: options.reasoningRequest }
        : {}),
      ...(options?.reasoningRetention !== undefined
        ? { reasoningRetention: options.reasoningRetention }
        : {}),
      ...(options?.reasoningRetentionScope !== undefined
        ? { reasoningRetentionScope: options.reasoningRetentionScope }
        : {}),
      ...applyStageModelOverridesToAgentOptions(options?.agentStageModelByStage),
    });
  }

  throw new Error(`Unsupported agent '${agent}'`);
}
