import type { Kestrel } from "../../../src/kestrel/Kestrel.js";
import { resolveAgentOptions } from "./constants.js";
import type { AgentRegistrationOptions } from "./types.js";
import {
  type AgentDefinition,
  createAgentInstance,
  createReferenceReactAgentDefinitionFromResolvedOptions,
  registerAgentInstance,
} from "./agentDefinition.js";

export function registerAgentReferenceRuntime(
  kestrel: Kestrel,
  options?: AgentRegistrationOptions,
): { entryStepAgent: string; agentDefinition: AgentDefinition } {
  const managedWorktreeService = kestrel.getManagedTaskWorktreeService();
  const config = resolveAgentOptions({
    ...options,
    ...(options?.managedWorktreeProposalProvider === undefined && managedWorktreeService !== undefined
      ? { managedWorktreeProposalProvider: (request) => managedWorktreeService.prepare(request) }
      : {}),
  });
  const definition = createReferenceReactAgentDefinitionFromResolvedOptions(config);
  const instance = createAgentInstance(definition);
  return registerAgentInstance(kestrel, instance);
}
