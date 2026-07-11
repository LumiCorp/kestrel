import type { StepCommit } from "../kestrel/contracts/execution.js";

import type { StepCommitStore } from "../kestrel/contracts/store.js";

export interface StepCommitPipelineDependencies {
  store: StepCommitStore;
}

export class StepCommitPipeline {
  private readonly store: StepCommitPipelineDependencies["store"];

  constructor(deps: StepCommitPipelineDependencies) {
    this.store = deps.store;
  }

  async commitTransition(input: StepCommit) {
    return this.store.commitStep({
      runId: input.runId,
      event: input.event,
      sessionId: input.session.sessionId,
      expectedVersion: input.session.version,
      stepAgent: input.stepName,
      nextStepAgent: input.transition.nextStepAgent,
      statePatch: input.statePatch,
      effects: input.resolvedEffects,
      emitEvents: input.emitEvents ?? [],
      ...(input.stepFrame !== undefined
        ? {
            runLogs: input.stepFrame.runLogs,
            runEvents: input.stepFrame.runEvents,
          }
        : {}),
      stateNode: input.transition.stateNode,
      artifacts: input.artifacts ?? [],
      claims: input.claims ?? [],
      memory: input.memory,
      budget: input.budget,
      stepIndex: input.stepIndex,
    });
  }
}
