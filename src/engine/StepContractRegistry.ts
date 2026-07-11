import type { StepContext, Transition } from "../kestrel/contracts/execution.js";


export interface StepContractValidationInput {
  stepName: string;
  transition: Transition;
  context: StepContext;
}

export type StepContractValidator = (input: StepContractValidationInput) => void;

export interface StepContractRegistry {
  register(stepName: string, validator: StepContractValidator): void;
  validate(input: StepContractValidationInput): void;
}

export class InMemoryStepContractRegistry implements StepContractRegistry {
  private readonly validators = new Map<string, StepContractValidator>();

  register(stepName: string, validator: StepContractValidator): void {
    this.validators.set(stepName, validator);
  }

  validate(input: StepContractValidationInput): void {
    const validator = this.validators.get(input.stepName);
    if (validator === undefined) {
      return;
    }

    validator(input);
  }
}

