import test from "node:test";
import assert from "node:assert/strict";

import type { StepIO } from "../../src/kestrel/contracts/execution.js";
import {
  appendAssistantToolCallsToTranscript,
  appendUserTurnToTranscript,
  renderModelTranscriptMessages,
} from "../../src/runtime/modelTranscript.js";
import { handleAskUserAction } from "../../agents/reference-react/src/steps/acter/askUserHandler.js";
import {
  handleCannotSatisfyAction,
  handleFinalizeAction,
} from "../../agents/reference-react/src/steps/acter/finalizeHandler.js";
import type { ActerStepConfig } from "../../agents/reference-react/src/steps/acter/shared.js";
import { createContinuationHandoffWaitTransition } from "../../agents/reference-react/src/steps/planHandoffWait.js";

const config: ActerStepConfig = {
  acterStepId: "agent.exec.finalize",
  deliberationStepId: "agent.loop",
  loopStepId: "agent.loop",
  effectResultLookupTool: "effect_result_lookup",
  finalizeToolName: "FinalizeAnswer",
  capabilityManifestProvider: () => [],
};

const io: StepIO = {
  async useModel() {
    throw new Error("useModel is not expected in terminal-control transcript tests");
  },
  async useTool<T>(_name: string, input: unknown): Promise<T> {
    return {
      ok: true,
      input,
    } as T;
  },
};

test("finalize terminal control records function call output before the next model turn", async () => {
  const modelTranscript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_finalize",
        name: "kestrel.finalize",
        input: {
          status: "goal_satisfied",
          message: "Done.",
        },
      },
    ],
  });

  const transition = await handleFinalizeAction({
    action: {
      kind: "finalize",
      finalizeReason: "goal_satisfied",
      input: {
        message: "Done.",
      },
    },
    config,
    reactState: {
      modelTranscript,
      goal: "Say done.",
    },
    activeRegion: undefined,
    stepIndex: 2,
    io,
  });
  const reactState = transition.statePatch?.agent as Record<string, unknown>;
  const messages = renderModelTranscriptMessages({
    transcript: reactState.modelTranscript,
  });

  assert.equal(messages.some((message) =>
    message.role === "tool" &&
    message.toolCallId === "call_finalize"
  ), true);
});

test("ask-user terminal control records function call output before waiting", () => {
  const modelTranscript = appendAssistantToolCallsToTranscript({
    transcript: undefined,
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_ask",
        name: "kestrel.ask_user",
        input: {
          prompt: "Which file should I inspect?",
        },
      },
    ],
  });

  const transition = handleAskUserAction({
    action: {
      kind: "ask_user",
      prompt: "Which file should I inspect?",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
      },
    },
    config,
    reactState: {
      modelTranscript,
    },
    activeRegion: undefined,
    currentStepAgent: "agent.exec.finalize",
    interactionMode: "plan",
    stepIndex: 2,
    eventType: "user.message",
    eventPayload: {},
    resolveDeliberationStep: () => "agent.loop",
  });
  const reactState = transition.statePatch?.agent as Record<string, unknown>;
  const messages = renderModelTranscriptMessages({
    transcript: reactState.modelTranscript,
  });

  assert.equal(messages.some((message) =>
    message.role === "tool" &&
    message.toolCallId === "call_ask"
  ), true);
});

test("handoff terminal control records function call output before waiting", () => {
  const modelTranscript = appendAssistantToolCallsToTranscript({
    transcript: appendUserTurnToTranscript({
      transcript: undefined,
      message: "Build the newsletter.",
      stepIndex: 0,
    }),
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_handoff",
        name: "kestrel.handoff_to_build",
        input: {
          message: "The plan is ready for build.",
          continuation: {
            objective: "Build the newsletter.",
            requiredToolClass: "sandboxed_only",
            requiredCapabilities: ["workspace.write"],
          },
        },
      },
    ],
  });

  const transition = createContinuationHandoffWaitTransition({
    config: {
      finalizeStepId: "agent.exec.finalize",
      waitUserStepId: "agent.exec.wait_user",
    },
    reactState: {
      modelTranscript,
      goal: "Keep going.",
      nextAction: {
        kind: "handoff_to_build",
        message: "The plan is ready for build.",
        continuation: {
          version: "continuation_offer_v1",
          kind: "implementation",
          objective: "Build the newsletter.",
          requiredToolClass: "sandboxed_only",
          requiredCapabilities: ["workspace.write"],
          requiredMode: "build",
          sourceRunId: "run-1",
        },
      },
    },
    stepIndex: 2,
  });
  const reactState = transition?.statePatch?.agent as Record<string, unknown>;
  const messages = renderModelTranscriptMessages({
    transcript: reactState.modelTranscript,
  });

  assert.equal(messages.some((message) =>
    message.role === "tool" &&
    message.toolCallId === "call_handoff"
  ), true);
  const waitFor = reactState.waitingFor as Record<string, unknown> | undefined;
  const metadata = waitFor?.metadata as Record<string, unknown> | undefined;
  const handoff = metadata?.handoff as Record<string, unknown> | undefined;
  assert.equal(handoff?.goal, "Build the newsletter.");
});

test("cannot-satisfy terminal control records function call output before completion", async () => {
  let finalizeInput: unknown;
  const localIo: StepIO = {
    ...io,
    async useTool<T>(_name: string, input: unknown): Promise<T> {
      finalizeInput = input;
      return {
        ok: true,
        input,
      } as T;
    },
  };
  const modelTranscript = appendAssistantToolCallsToTranscript({
    transcript: appendUserTurnToTranscript({
      transcript: undefined,
      message: "Use unavailable tool.",
      stepIndex: 0,
    }),
    stepIndex: 1,
    toolCalls: [
      {
        id: "call_cannot",
        name: "kestrel.cannot_satisfy",
        input: {
          reasonCode: "requested_tool_unavailable",
          message: "That tool is unavailable.",
        },
      },
    ],
  });

  const transition = await handleCannotSatisfyAction({
    action: {
      kind: "cannot_satisfy",
      reasonCode: "requested_tool_unavailable",
      message: "That tool is unavailable.",
    },
    config,
    reactState: {
      modelTranscript,
      goal: "Keep going.",
    },
    activeRegion: undefined,
    stepIndex: 2,
    io: localIo,
  });
  const reactState = transition.statePatch?.agent as Record<string, unknown>;
  const messages = renderModelTranscriptMessages({
    transcript: reactState.modelTranscript,
  });

  assert.equal(messages.some((message) =>
    message.role === "tool" &&
    message.toolCallId === "call_cannot"
  ), true);
  const data = (finalizeInput as Record<string, unknown>).data as Record<string, unknown>;
  assert.equal(data.goal, "Use unavailable tool.");
});
