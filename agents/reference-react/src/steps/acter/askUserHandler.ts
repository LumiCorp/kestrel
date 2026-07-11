import type { Transition } from "../../../../../src/kestrel/contracts/execution.js";

import {
  appendModelTranscriptItems,
  appendToolResultToTranscript,
  makeModelTranscriptItem,
  readActiveTaskGoalFromTranscript,
} from "../../../../../src/runtime/modelTranscript.js";
import { asRecord, asString } from "../../../../shared/valueAccess.js";
import {
  createReferenceReactEffectCollectCheckpoint,
  createReferenceReactWaitCheckpoint,
} from "../../commandProcessor.js";
import { createReferenceReactLastActionResultPatch } from "../../state.js";
import {
  appendAgentObservation,
  type ActerStepConfig,
  type AskUserAction,
  type CanonicalInteractionMode,
  withPromptMetadata,
} from "./shared.js";

export function handleAskUserAction(input: {
  action: AskUserAction;
  config: ActerStepConfig;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  currentStepAgent: string | undefined;
  interactionMode: CanonicalInteractionMode;
  stepIndex: number;
  eventType: string;
  eventPayload: unknown;
  resolveDeliberationStep: (interactionMode: CanonicalInteractionMode, config: ActerStepConfig) => string;
}): Transition {
  const waitFor = withPromptMetadata(input.action.waitFor, input.action.prompt);
  const waitingForUser = asRecord(input.reactState.waitingFor);
  const waitingEventType = asString(waitingForUser?.eventType);

  if (waitingEventType !== undefined && input.eventType === waitingEventType) {
    const resumeGoal = readActiveTaskGoalFromTranscript(input.reactState.modelTranscript);
    const lastActionResult = {
      ok: true,
      kind: "user_reply",
      status: "received",
      prompt: input.action.prompt,
      responseEventType: input.eventType,
      responsePayload: input.eventPayload,
      ...(resumeGoal !== undefined ? { resumeGoal } : {}),
      ts: new Date().toISOString(),
    };
    return createReferenceReactEffectCollectCheckpoint({
      reactState: input.reactState,
      currentStepAgent: input.currentStepAgent ?? input.config.acterStepId,
      nextStepAgent: input.resolveDeliberationStep(input.interactionMode, input.config),
      stepIndex: input.stepIndex,
      activeRegion: input.activeRegion,
      phase: "THINK",
      reactPatch: {
        ...createReferenceReactLastActionResultPatch(lastActionResult),
        observations: appendAgentObservation(input.reactState, lastActionResult),
        decisionTrace: [
          {
            eventType: "decision.executed",
            phase: "acter",
            decisionCode: "ask_user.resume",
          },
        ],
      },
      execPatch: {},
      regionExecPatch: {},
    });
  }

  return createReferenceReactWaitCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.config.acterStepId,
    nextStepAgent: input.config.acterStepId,
    stepIndex: input.stepIndex,
    waitFor,
    substate: "wait_user",
    emitEvents: [
      {
        type: "ui.prompt",
        payload: {
          text: input.action.prompt,
        },
      },
    ],
    activeRegion: input.activeRegion,
    phase: "ACT",
    reactPatch: {
      modelTranscript: appendModelTranscriptItems(
        appendToolResultToTranscript({
          transcript: input.reactState.modelTranscript,
          toolName: "kestrel.ask_user",
          toolInput: {
            prompt: input.action.prompt,
          },
          toolOutput: {
            ok: true,
            status: "waiting_for_user",
          },
          stepIndex: input.stepIndex,
        }),
        [
          makeModelTranscriptItem("assistant_text", {
            content: input.action.prompt,
            stepIndex: input.stepIndex,
          }),
        ],
      ),
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "ask_user.wait",
        },
      ],
    },
    execPatch: {},
    regionExecPatch: {},
  });
}
