import type { StepAgent, StepRegistry } from "../kestrel/contracts/execution.js";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

export class InMemoryStepRegistry implements StepRegistry {
  private readonly steps = new Map<string, StepAgent>();

  register(name: string, step: StepAgent): void {
    if (name.trim().length === 0) {
      throw createRuntimeFailure("STEP_NAME_INVALID", "Step name cannot be empty");
    }
    // Allow re-registration so agent tooling can refresh step implementations at runtime.
    this.steps.set(name, step);
  }

  resolve(name: string): StepAgent {
    const step = this.steps.get(name);
    if (step === undefined) {
      throw createRuntimeFailure("STEP_NOT_REGISTERED", `Step not registered: ${name}`, {
        stepName: name,
      });
    }
    return step;
  }
}
