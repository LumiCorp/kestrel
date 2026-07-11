import type {
  EffectFailurePolicy,
} from "../kestrel/contracts/base.js";
import type {
  Effect,
  StepTransition,
} from "../kestrel/contracts/execution.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

const VALID_FAILURE_POLICIES: ReadonlySet<EffectFailurePolicy> = new Set([
  "STOP",
  "CONTINUE",
  "WAIT",
]);

export function validateTransition(transition: StepTransition): void {
  if (transition.nextStepAgent !== undefined) {
    validateRequiredString(
      transition.nextStepAgent,
      "transition.nextStepAgent must be a non-empty string when provided.",
      "transition.nextStepAgent",
      transition.status,
    );
  }

  if (transition.status === "WAITING" && transition.waitFor === undefined) {
    throwTransitionValidationError(
      "Transition with WAITING status must include waitFor matcher.",
      "transition.waitFor",
      transition.status,
    );
  }

  if (transition.status === "RUNNING" && transition.nextStepAgent === undefined) {
    throwTransitionValidationError(
      "Transition with RUNNING status must include nextStepAgent.",
      "transition.nextStepAgent",
      transition.status,
    );
  }

  const effects = transition.effects ?? [];
  if (Array.isArray(effects) === false) {
    throwTransitionValidationError(
      "transition.effects must be an array when provided.",
      "transition.effects",
      transition.status,
    );
  }
  for (const effect of effects) {
    validateEffect(effect, transition.status);
  }

  if (transition.stateNode !== undefined) {
    const stateNode = validateRecord(
      transition.stateNode,
      "transition.stateNode must be an object when provided.",
      "transition.stateNode",
      transition.status,
    );
    validateRequiredString(
      stateNode.parent,
      "stateNode.parent and stateNode.child are required when stateNode is provided.",
      "transition.stateNode",
      transition.status,
    );
    validateRequiredString(
      stateNode.child,
      "stateNode.parent and stateNode.child are required when stateNode is provided.",
      "transition.stateNode",
      transition.status,
    );
    if (stateNode.region !== undefined) {
      validateRequiredString(
        stateNode.region,
        "stateNode.region must be a non-empty string when provided.",
        "transition.stateNode.region",
        transition.status,
      );
    }
  }

  if (transition.regionOps !== undefined) {
    const regionOps = validateRecord(
      transition.regionOps,
      "transition.regionOps must be an object when provided.",
      "transition.regionOps",
      transition.status,
    );
    const syncNode = regionOps.syncNode;
    if (syncNode !== undefined) {
      validateRequiredString(
        syncNode,
        "regionOps.syncNode cannot be empty.",
        "transition.regionOps.syncNode",
        transition.status,
      );
    }

    const spawn = regionOps.spawn ?? [];
    if (Array.isArray(spawn) === false) {
      throwTransitionValidationError(
        "regionOps.spawn must be an array when provided.",
        "transition.regionOps.spawn",
        transition.status,
      );
    }
    for (const itemValue of spawn) {
      const item = validateRecord(
        itemValue,
        "regionOps.spawn[] must contain objects.",
        "transition.regionOps.spawn[]",
        transition.status,
      );
      validateRequiredString(
        item.region,
        "regionOps.spawn[].region is required.",
        "transition.regionOps.spawn[].region",
        transition.status,
      );
      validateRequiredString(
        item.stepAgent,
        "regionOps.spawn[].stepAgent is required.",
        "transition.regionOps.spawn[].stepAgent",
        transition.status,
      );
    }

    const complete = regionOps.complete ?? [];
    if (Array.isArray(complete) === false) {
      throwTransitionValidationError(
        "regionOps.complete must be an array when provided.",
        "transition.regionOps.complete",
        transition.status,
      );
    }
    for (const region of complete) {
      validateRequiredString(
        region,
        "regionOps.complete[] cannot contain empty values.",
        "transition.regionOps.complete[]",
        transition.status,
      );
    }
  }

  const claims = transition.claims ?? [];
  if (Array.isArray(claims) === false) {
    throwTransitionValidationError(
      "transition.claims must be an array when provided.",
      "transition.claims",
      transition.status,
    );
  }
  for (const claim of claims) {
    const claimRecord = validateRecord(
      claim,
      "transition.claims[] must contain objects.",
      "transition.claims[]",
      transition.status,
    );
    validateRequiredString(
      claimRecord.text,
      "Claim text is required.",
      "transition.claims[].text",
      transition.status,
    );

    if (Array.isArray(claimRecord.evidenceIds) === false || claimRecord.evidenceIds.length === 0) {
      throwTransitionValidationError(
        "Claim evidenceIds must contain at least one evidence id.",
        "transition.claims[].evidenceIds",
        transition.status,
      );
    }
  }
}

function validateEffect(effect: Effect, status: StepTransition["status"]): void {
  const effectRecord = validateRecord(
    effect,
    "transition.effects[] must contain objects.",
    "transition.effects[]",
    status,
  );
  validateRequiredString(effectRecord.type, "Effect type is required.", "transition.effects[].type", status);

  if (
    effectRecord.failurePolicy !== undefined &&
    (typeof effectRecord.failurePolicy !== "string" ||
      VALID_FAILURE_POLICIES.has(effectRecord.failurePolicy as EffectFailurePolicy) === false)
  ) {
    throw createRuntimeFailure(
      "RUN_TRANSITION_INVALID",
      `Unsupported effect failurePolicy: ${effectRecord.failurePolicy}.`,
      {
        subsystem: "runtime",
        classification: "schema",
        contractPath: "transition.effects[].failurePolicy",
        failurePolicy: effectRecord.failurePolicy,
      },
    );
  }
}

function validateRecord(
  value: unknown,
  message: string,
  contractPath: string,
  status: StepTransition["status"],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throwTransitionValidationError(message, contractPath, status);
  }
  return value as Record<string, unknown>;
}

function validateRequiredString(
  value: unknown,
  message: string,
  contractPath: string,
  status: StepTransition["status"],
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throwTransitionValidationError(message, contractPath, status);
  }
  return value.trim();
}

function throwTransitionValidationError(
  message: string,
  contractPath: string,
  status: StepTransition["status"],
): never {
  throw createRuntimeFailure("RUN_TRANSITION_INVALID", message, {
    subsystem: "runtime",
    classification: "schema",
    contractPath,
    transitionStatus: status,
  });
}
