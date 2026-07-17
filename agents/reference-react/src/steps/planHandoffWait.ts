import type { Transition, WaitForMatcher } from "../../../../src/kestrel/contracts/execution.js";

import { asArray, asRecord, asString } from "../../../shared/valueAccess.js";
import {
  normalizeRuntimePlanDocumentSnapshot,
  normalizeRuntimePlanState,
} from "../../../../src/runtime/planDocument.js";
import {
  createRuntimeContinuationState,
} from "../../../../src/runtime/continuationState.js";
import { normalizeContinuationOffer } from "../../../../src/runtime/continuationOffer.js";
import {
  appendModelTranscriptItems,
  appendToolResultToTranscript,
  makeModelTranscriptItem,
  readActiveTaskGoalFromTranscript,
} from "../../../../src/runtime/modelTranscript.js";
import { createReferenceReactWaitCheckpoint } from "../commandProcessor.js";

export interface PlanHandoffWaitConfig {
  finalizeStepId: string;
  waitUserStepId: string;
}

export function createContinuationHandoffWaitTransition(input: {
  config: PlanHandoffWaitConfig;
  reactState: Record<string, unknown>;
  stepIndex: number;
}): Transition | undefined {
  const action = asRecord(input.reactState.nextAction);
  if (action?.kind !== "handoff_to_build") {
    return ;
  }
  const message = asString(action.message)?.trim();
  if (message === undefined || message.length === 0) {
    return ;
  }
  const data = asRecord(action.data);
  const activePlan = normalizeRuntimePlanState(input.reactState.plan);
  const activePlanDocument = normalizeRuntimePlanDocumentSnapshot(input.reactState.planDocument);
  const transcriptGoal = readActiveTaskGoalFromTranscript(input.reactState.modelTranscript)?.trim();
  const objective = transcriptGoal ??
    message;
  const proposedNextMode = "build";
  const proposedNextAction = asString(data?.proposedNextAction)?.trim() ?? message;
  const continuationOffer = normalizeContinuationOffer(action.continuation, "handoff-run");
  if (continuationOffer === undefined) {
    return ;
  }
  const activeContinuation = createRuntimeContinuationState({
    offer: continuationOffer,
    resumeStepAgent: input.config.waitUserStepId,
    planDocumentPath: activePlanDocument?.path ?? activePlan?.path,
    proposedNextAction,
    handoffMessage: message,
  });
  const nextPassLabel = readNextPassLabelFromPlanAction(proposedNextAction);
  const planHandoffPrompt = [
    message,
    "",
    `Would you like me to proceed with ${nextPassLabel} now?`,
    "Reply naturally when you want me to start building.",
  ].join("\n");
  const waitFor: WaitForMatcher = {
    kind: "user",
    eventType: "user.reply",
    metadata: {
      reason: "continuation_handoff",
      continuationId: activeContinuation.id,
      handoff: {
        goal: objective,
        proposedApproach: message,
        assumptions: asArray(data?.assumptions).map((item) => asString(item)).filter((item): item is string => item !== undefined),
        blockers: asArray(data?.blockers).map((item) => asString(item)).filter((item): item is string => item !== undefined),
        readiness: asString(data?.readiness) ?? "ready_to_build",
        proposedNextMode,
      },
      proposedNextAction,
      resumeStepAgent: input.config.waitUserStepId,
      prompt: planHandoffPrompt,
    },
  };
  const askUserAction = {
    kind: "ask_user",
    prompt: planHandoffPrompt,
    waitFor,
  };
  const modelTranscript = appendModelTranscriptItems(
    appendToolResultToTranscript({
      transcript: input.reactState.modelTranscript,
      toolName: "kestrel.handoff_to_build",
      toolInput: action,
      toolOutput: {
        ok: true,
        status: "waiting_for_user",
        reason: "continuation_handoff",
        continuationId: activeContinuation.id,
        prompt: planHandoffPrompt,
      },
      stepIndex: input.stepIndex,
    }),
    [
      makeModelTranscriptItem("assistant_text", {
        content: planHandoffPrompt,
        stepIndex: input.stepIndex,
      }),
    ],
  );
  return createReferenceReactWaitCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.config.finalizeStepId,
    nextStepAgent: input.config.waitUserStepId,
    stepIndex: input.stepIndex,
    waitFor,
    substate: "wait_user",
    emitEvents: [
      {
        type: "ui.prompt",
        payload: {
          text: planHandoffPrompt,
        },
      },
    ],
    phase: "ACT",
    reactPatch: {
      nextAction: askUserAction,
      activeContinuation,
      modelTranscript,
      ...(activePlan !== undefined
        ? { plan: { ...activePlan, status: "approved" } }
        : {}),
      ...(activePlanDocument !== undefined ? { planDocument: activePlanDocument } : {}),
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "continuation_handoff.wait",
          metadata: {
            reason: "continuation_handoff",
            continuationId: activeContinuation.id,
          },
        },
      ],
    },
    execPatch: {
      pendingBatch: undefined,
    },
    regionExecPatch: {},
  });
}

function readNextPassLabelFromPlanAction(value: string): string {
  const passMatch = /\bpass\s+([1-9][0-9]*)\b/i.exec(value);
  if (passMatch !== null) {
    return `pass ${passMatch[1]}`;
  }
  return "the next pass";
}
