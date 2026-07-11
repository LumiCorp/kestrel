import type { Kestrel } from "../../../src/kestrel/Kestrel.js";
import type { StepAgent, StepContractValidator } from "../../../src/kestrel/contracts/execution.js";

import { isCompiledExecutableNextAction } from "./actionValidation.js";
import { AGENT_STEP_IDS, resolveAgentOptions } from "./constants.js";
import {
  createExecCollectStep,
  createExecDispatchStep,
  createExecFinalizeStep,
  createExecWaitApprovalStep,
  createExecWaitEffectStep,
  createExecWaitUserStep,
} from "./steps/execStates.js";
import { createAgentLoopStep } from "./steps/deliberator.js";
import type { AgentRegistrationOptions, ResolvedAgentOptions } from "./types.js";

export interface AgentStepDefinition {
  id: string;
  createStep: () => StepAgent;
  contract?: StepContractValidator | undefined;
}

export interface AgentDefinition {
  id: string;
  entryStepAgent: string;
  steps: readonly AgentStepDefinition[];
}

export interface AgentInstance {
  definition: AgentDefinition;
  steps: ReadonlyMap<string, StepAgent>;
  stepContracts: ReadonlyMap<string, StepContractValidator>;
}

export function createReferenceReactAgentDefinition(
  options?: AgentRegistrationOptions,
): AgentDefinition {
  return createReferenceReactAgentDefinitionFromResolvedOptions(resolveAgentOptions(options));
}

export function createAgentInstance(definition: AgentDefinition): AgentInstance {
  const steps = new Map<string, StepAgent>();
  const stepContracts = new Map<string, StepContractValidator>();

  for (const step of definition.steps) {
    steps.set(step.id, step.createStep());
    if (step.contract !== undefined) {
      stepContracts.set(step.id, step.contract);
    }
  }

  return {
    definition,
    steps,
    stepContracts,
  };
}

export function registerAgentInstance(
  kestrel: Kestrel,
  instance: AgentInstance,
): { entryStepAgent: string; agentDefinition: AgentDefinition } {
  for (const [stepId, step] of instance.steps) {
    kestrel.registerStep(stepId, step);
  }

  for (const [stepId, contract] of instance.stepContracts) {
    kestrel.registerStepContract(stepId, contract);
  }

  return {
    entryStepAgent: instance.definition.entryStepAgent,
    agentDefinition: instance.definition,
  };
}

export function createReferenceReactAgentDefinitionFromResolvedOptions(
  config: ResolvedAgentOptions,
): AgentDefinition {
  const execConfig = {
    loopStepId: AGENT_STEP_IDS.loop,
    effectResultLookupTool: config.effectResultLookupTool,
    finalizeToolName: config.finalizeToolName,
    capabilityManifestProvider: config.capabilityManifestProvider,
    ...(config.managedWorktreeProposalProvider !== undefined
      ? { managedWorktreeProposalProvider: config.managedWorktreeProposalProvider }
      : {}),
    dispatchStepId: AGENT_STEP_IDS.execDispatch,
    waitEffectStepId: AGENT_STEP_IDS.execWaitEffect,
    waitApprovalStepId: AGENT_STEP_IDS.execWaitApproval,
    waitUserStepId: AGENT_STEP_IDS.execWaitUser,
    collectStepId: AGENT_STEP_IDS.execCollect,
    finalizeStepId: AGENT_STEP_IDS.execFinalize,
  };

  return {
    id: "reference-react",
    entryStepAgent: AGENT_STEP_IDS.loop,
    steps: [
      {
        id: AGENT_STEP_IDS.loop,
        createStep: () =>
          createAgentLoopStep({
            agentModel: config.agentModel,
            agentToolsProvider: config.agentToolsProvider,
            capabilityManifestProvider: config.capabilityManifestProvider,
            defaultGoal: config.defaultGoal,
            execDispatchStepId: AGENT_STEP_IDS.execDispatch,
            loopStepId: AGENT_STEP_IDS.loop,
          }),
        contract: ({ transition }) => {
          const agent = asRecord(transition.statePatch?.agent);
          if (agent === undefined) {
            throw contractError("agent.loop must commit agent state");
          }
          if (transition.status === "FAILED") {
            if (!hasStructuredRuntimeFailure(agent)) {
              throw contractError("agent.loop FAILED transitions must commit a structured runtime failure");
            }
            return;
          }
          if (transition.nextStepAgent === AGENT_STEP_IDS.loop) {
            if (
              agent.retryContext === undefined &&
              hasAllowedLoopSelfTransitionTrace(agent) === false
            ) {
              throw contractError("agent.loop self-transition must commit retryContext");
            }
          } else if (isCompiledExecutableNextAction(agent.nextAction) === false) {
            throw contractError("agent.loop must commit a valid executable agent.nextAction");
          }
          if (
            transition.nextStepAgent !== AGENT_STEP_IDS.execDispatch &&
            transition.nextStepAgent !== AGENT_STEP_IDS.loop
          ) {
            throw contractError("agent.loop must transition to agent.exec.dispatch or agent.loop");
          }
        },
      },
      {
        id: AGENT_STEP_IDS.execDispatch,
        createStep: () => createExecDispatchStep(execConfig),
        contract: ({ transition }) => {
          const next = transition.nextStepAgent;
          if (
            next !== AGENT_STEP_IDS.execWaitEffect &&
            next !== AGENT_STEP_IDS.execWaitApproval &&
            next !== AGENT_STEP_IDS.execWaitUser &&
            next !== AGENT_STEP_IDS.execCollect &&
            next !== AGENT_STEP_IDS.execFinalize &&
            next !== AGENT_STEP_IDS.loop
          ) {
            throw contractError("agent.exec.dispatch nextStepAgent is invalid");
          }
        },
      },
      {
        id: AGENT_STEP_IDS.execWaitEffect,
        createStep: () => createExecWaitEffectStep(execConfig),
        contract: ({ transition }) => {
          const next = transition.nextStepAgent;
          if (transition.status === "WAITING") {
            if (next !== AGENT_STEP_IDS.execWaitEffect) {
              throw contractError("agent.exec.wait_effect WAITING transitions must resume at agent.exec.wait_effect");
            }
            return;
          }
          if (next !== AGENT_STEP_IDS.execCollect) {
            throw contractError("agent.exec.wait_effect RUNNING transitions must hand off to agent.exec.collect");
          }
        },
      },
      {
        id: AGENT_STEP_IDS.execWaitApproval,
        createStep: () => createExecWaitApprovalStep(execConfig),
        contract: ({ transition }) => {
          const next = transition.nextStepAgent;
          if (transition.status === "WAITING") {
            if (next !== AGENT_STEP_IDS.execWaitApproval) {
              throw contractError("agent.exec.wait_approval WAITING transitions must resume at agent.exec.wait_approval");
            }
            return;
          }
          if (
            next !== AGENT_STEP_IDS.execDispatch &&
            next !== AGENT_STEP_IDS.execWaitEffect &&
            next !== AGENT_STEP_IDS.execCollect &&
            next !== AGENT_STEP_IDS.loop
          ) {
            throw contractError("agent.exec.wait_approval RUNNING transition target is invalid");
          }
        },
      },
      {
        id: AGENT_STEP_IDS.execWaitUser,
        createStep: () => createExecWaitUserStep(execConfig),
        contract: ({ transition }) => {
          const next = transition.nextStepAgent;
          if (transition.status === "WAITING") {
            if (next !== AGENT_STEP_IDS.execWaitUser) {
              throw contractError("agent.exec.wait_user WAITING transitions must resume at agent.exec.wait_user");
            }
            return;
          }
          if (next !== AGENT_STEP_IDS.execDispatch && next !== AGENT_STEP_IDS.loop) {
            throw contractError("agent.exec.wait_user RUNNING transition target is invalid");
          }
        },
      },
      {
        id: AGENT_STEP_IDS.execCollect,
        createStep: () => createExecCollectStep(execConfig),
        contract: ({ transition }) => {
          if (
            transition.nextStepAgent !== AGENT_STEP_IDS.execDispatch &&
            transition.nextStepAgent !== AGENT_STEP_IDS.loop
          ) {
            throw contractError("agent.exec.collect must transition to agent.exec.dispatch or agent.loop");
          }
        },
      },
      {
        id: AGENT_STEP_IDS.execFinalize,
        createStep: () => createExecFinalizeStep(execConfig),
        contract: ({ transition }) => {
          if (transition.status === "WAITING") {
            const metadata = asRecord(transition.waitFor?.metadata);
            const handoff = asRecord(metadata?.handoff);
            const continuationId = asString(metadata?.continuationId);
            if (
              transition.nextStepAgent !== AGENT_STEP_IDS.execWaitUser ||
              transition.waitFor?.kind !== "user" ||
              transition.waitFor?.eventType !== "user.reply" ||
              metadata?.reason !== "continuation_handoff" ||
              handoff === undefined ||
              continuationId === undefined
            ) {
              throw contractError("agent.exec.finalize WAITING transitions must be continuation handoff user waits");
            }
            return;
          }
          if (transition.status !== "COMPLETED") {
            throw contractError("agent.exec.finalize must terminate with COMPLETED status");
          }
          const emitted = Array.isArray(transition.emitEvents) ? transition.emitEvents : [];
          if (emitted.some((event) => event.type === "agent.completed") === false) {
            throw contractError("agent.exec.finalize must emit agent.completed");
          }
        },
      },
    ],
  };
}

function hasAllowedLoopSelfTransitionTrace(agent: Record<string, unknown>): boolean {
  const traces = Array.isArray(agent.decisionTrace) ? agent.decisionTrace : [];
  return traces.some((trace) => {
    const record = asRecord(trace);
    return record?.eventType === "decision.executed" &&
      record?.decisionCode === "visible_todo_update";
  });
}

function hasStructuredRuntimeFailure(agent: Record<string, unknown>): boolean {
  const terminal = asRecord(agent.terminal);
  if (
    asString(terminal?.status) === "FAILED" &&
    asString(terminal?.reasonCode) !== undefined &&
    asString(terminal?.message) !== undefined
  ) {
    return true;
  }
  const lastActionResult = asRecord(agent.lastActionResult);
  const error = asRecord(lastActionResult?.error);
  return asString(error?.code) !== undefined && asString(error?.message) !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function contractError(message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = "AGENT_STEP_CONTRACT_ERROR";
  return error;
}
