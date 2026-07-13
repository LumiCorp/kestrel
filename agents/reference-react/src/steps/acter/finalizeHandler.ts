import type { StepIO, Transition } from "../../../../../src/kestrel/contracts/execution.js";

import {
  appendModelTranscriptItems,
  appendToolResultToTranscript,
  makeModelTranscriptItem,
  readActiveTaskGoalFromTranscript,
} from "../../../../../src/runtime/modelTranscript.js";
import { createReferenceReactFinalizeCheckpoint } from "../../commandProcessor.js";
import {
  createReferenceReactAssistantTextPatch,
  createReferenceReactFinalOutputPatch,
  createReferenceReactNextActionPatch,
} from "../../state.js";
import { buildFinalizePayload } from "./finalizePayload.js";
import { unwrapAgentToolOutput } from "../../../../../tools/toolResult.js";
import type {
  ActerStepConfig,
  CannotSatisfyAction,
  FinalizeAction,
} from "./shared.js";

export async function handleCannotSatisfyAction(input: {
  action: CannotSatisfyAction;
  config: ActerStepConfig;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  stepIndex: number;
  io: StepIO;
}): Promise<Transition> {
  const activeGoal = readActiveTaskGoalFromTranscript(input.reactState.modelTranscript);
  const finalToolResult = await input.io.useTool!(input.config.finalizeToolName, {
    message: input.action.message,
    data: {
      goal: activeGoal,
      plan: input.reactState.plan,
      lastActionResult: input.reactState.lastActionResult,
      cannotSatisfy: {
        reasonCode: input.action.reasonCode,
        ...(input.action.details !== undefined ? { details: input.action.details } : {}),
      },
    },
  });
  const finalOutput = unwrapAgentToolOutput(finalToolResult);
  const modelTranscript = appendModelTranscriptItems(
    appendToolResultToTranscript({
      transcript: input.reactState.modelTranscript,
      toolName: "kestrel.cannot_satisfy",
      toolInput: {
        reasonCode: input.action.reasonCode,
        message: input.action.message,
        ...(input.action.details !== undefined ? { details: input.action.details } : {}),
      },
      toolOutput: finalToolResult,
      stepIndex: input.stepIndex,
    }),
    [
      makeModelTranscriptItem("assistant_text", {
        content: input.action.message,
        stepIndex: input.stepIndex,
      }),
    ],
  );
  return createReferenceReactFinalizeCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.config.acterStepId,
    stepIndex: input.stepIndex,
    emitEvents: [
      {
        type: "agent.completed",
        payload: {
          goal: activeGoal,
          result: finalOutput,
        },
      },
    ],
    activeRegion: input.activeRegion,
    phase: "DONE",
    reactPatch: {
      ...createReferenceReactAssistantTextPatch(input.action.message.trim()),
      ...createReferenceReactFinalOutputPatch(finalOutput),
      modelTranscript,
      activeTurnIntent: undefined,
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "cannot_satisfy",
          metadata: {
            reasonCode: input.action.reasonCode,
            ...(input.action.details !== undefined ? input.action.details : {}),
          },
        },
      ],
    },
    execPatch: {
      pendingApproval: undefined,
      pendingAction: undefined,
      pendingEffectKey: undefined,
      pendingEffectType: undefined,
    },
    regionReactPatch: {
      ...createReferenceReactAssistantTextPatch(input.action.message.trim()),
      ...createReferenceReactFinalOutputPatch(finalOutput),
    },
    regionExecPatch: {
      pendingApproval: undefined,
      pendingAction: undefined,
      pendingEffectKey: undefined,
      pendingEffectType: undefined,
    },
    stateNode: {
      parent: "react",
      child: "act",
    },
  });
}

export async function handleFinalizeAction(input: {
  action: FinalizeAction;
  config: ActerStepConfig;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  stepIndex: number;
  io: StepIO;
}): Promise<Transition> {
  const finalized = buildFinalizePayload(input.reactState, input.action.input);
  const finalToolResult = await input.io.useTool!(input.config.finalizeToolName, finalized.payload);
  const finalOutput = unwrapAgentToolOutput(finalToolResult);
  const assistantText = String(input.action.input.message).trim();
  const modelTranscript = appendModelTranscriptItems(
    appendToolResultToTranscript({
      transcript: input.reactState.modelTranscript,
      toolName: "kestrel.finalize",
      toolInput: {
        status: input.action.finalizeReason,
        ...input.action.input,
      },
      toolOutput: finalToolResult,
      stepIndex: input.stepIndex,
    }),
    [
      makeModelTranscriptItem("assistant_text", {
        content: String(input.action.input.message ?? ""),
        stepIndex: input.stepIndex,
      }),
    ],
  );
  const finalizeTrace = [
    {
      eventType: "decision.executed",
      phase: "acter",
      decisionCode: "finalize",
      metadata: {
        artifactManifestStatus: finalized.telemetry.manifestStatus,
        artifactExplicitCount: finalized.telemetry.explicitCount,
        artifactPromotedCount: finalized.telemetry.promotedCount,
        artifactInputCount: finalized.telemetry.inputCount,
        artifactCanonicalCount: finalized.telemetry.canonicalCount,
        artifactDuplicatesMerged: finalized.telemetry.duplicatesMerged,
        artifactConflictCount: finalized.telemetry.conflictCount,
        artifactTotalCount: finalized.telemetry.totalCount,
      },
    },
    ...(finalized.telemetry.manifestStatus === "parsed"
      ? [
          {
            eventType: "decision.executed" as const,
            phase: "acter" as const,
            decisionCode: "artifact_manifest_parsed",
          },
        ]
      : []),
    ...(finalized.telemetry.manifestStatus === "invalid"
      ? [
          {
            eventType: "decision.executed" as const,
            phase: "acter" as const,
            decisionCode: "artifact_manifest_invalid",
          },
        ]
      : []),
    ...(finalized.telemetry.manifestStatus === "missing"
      ? [
          {
            eventType: "decision.executed" as const,
            phase: "acter" as const,
            decisionCode: "artifact_manifest_missing",
          },
        ]
      : []),
    ...(finalized.telemetry.duplicatesMerged > 0
      ? [
          {
            eventType: "decision.executed" as const,
            phase: "acter" as const,
            decisionCode: "artifact_duplicate_merged",
            metadata: {
              count: finalized.telemetry.duplicatesMerged,
            },
          },
        ]
      : []),
    ...(finalized.telemetry.conflictCount > 0
      ? [
          {
            eventType: "decision.executed" as const,
            phase: "acter" as const,
            decisionCode: "artifact_merge_conflict",
            metadata: {
              count: finalized.telemetry.conflictCount,
            },
          },
        ]
      : []),
    ...(finalized.telemetry.totalCount > 0
      ? [
          {
            eventType: "decision.executed" as const,
            phase: "acter" as const,
            decisionCode: "artifact_render_payload_emitted",
            metadata: {
              count: finalized.telemetry.totalCount,
            },
          },
        ]
      : []),
  ];

  return createReferenceReactFinalizeCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.config.acterStepId,
    stepIndex: input.stepIndex,
    emitEvents: [
      {
        type: "agent.completed",
        payload: {
          finalizedBy: input.config.finalizeToolName,
          output: finalOutput,
        },
      },
    ],
    activeRegion: input.activeRegion,
    phase: "ACT",
    reactPatch: {
      ...createReferenceReactNextActionPatch(undefined),
      modelTranscript,
      decisionTrace: finalizeTrace,
      finalized: true,
      ...createReferenceReactAssistantTextPatch(assistantText),
      ...createReferenceReactFinalOutputPatch(finalOutput),
      activeTurnIntent: undefined,
    },
    execPatch: {
      pendingBatch: undefined,
    },
    regionReactPatch: {
      finalized: true,
      ...createReferenceReactAssistantTextPatch(assistantText),
    },
    regionExecPatch: {
      pendingBatch: undefined,
    },
  });
}
