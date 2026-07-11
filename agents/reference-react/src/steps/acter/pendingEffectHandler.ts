import type { StepIO, Transition } from "../../../../../src/kestrel/contracts/execution.js";

import {
  createReferenceReactWaitCheckpoint,
} from "../../commandProcessor.js";
import type {
  ActerStepConfig,
  DuplicateLedger,
} from "./shared.js";
import { unwrapAgentToolOutput } from "../../../../../tools/toolResult.js";

export async function handlePendingEffect(input: {
  config: ActerStepConfig;
  runId: string;
  sessionId: string;
  stepIndex: number;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  pendingAction:
    | {
        kind: "effect";
        actionId: string;
        idempotencyKey: string;
      }
    | undefined;
  pendingEffectKey: string;
  pendingEffectType: string;
  duplicateLedger: DuplicateLedger;
  io: StepIO;
  toPendingExecutableActionRecord: (action: {
    kind: "effect";
    actionId: string;
    idempotencyKey: string;
  }) => Record<string, unknown>;
  resumePendingEffect: (input: {
    runId: string;
    sessionId: string;
    stepIndex: number;
    reactState: Record<string, unknown>;
    activeRegion: string | undefined;
    loopStepId: string;
    acterStepId: string;
    pendingEffectKey: string;
    pendingEffectType: string;
    effectResult: unknown;
    toolCapabilityClassesByName: Record<string, string[]>;
    duplicateLedger: DuplicateLedger;
  }) => Transition;
  toolCapabilityClassesByName: Record<string, string[]>;
}): Promise<Transition> {
  const effectToolResult = await input.io.useTool!(input.config.effectResultLookupTool, {
    idempotencyKey: input.pendingEffectKey,
  });
  const effectResult = unwrapAgentToolOutput(effectToolResult);

  if (effectResult === null || effectResult === undefined) {
    const waitFor = {
      kind: "effect" as const,
      eventType: "effect.result.available",
      metadata: {
        idempotencyKey: input.pendingEffectKey,
      },
    };
    const pendingEffectPatch = {
      ...(input.pendingAction !== undefined
        ? { pendingAction: input.toPendingExecutableActionRecord(input.pendingAction) }
        : {}),
      pendingEffectKey: input.pendingEffectKey,
      pendingEffectType: input.pendingEffectType,
    };
    return createReferenceReactWaitCheckpoint({
      reactState: input.reactState,
      currentStepAgent: input.config.acterStepId,
      nextStepAgent: input.config.acterStepId,
      stepIndex: input.stepIndex,
      waitFor,
      substate: "wait_effect",
      activeRegion: input.activeRegion,
      phase: "ACT",
      reactPatch: {
        decisionTrace: [
          {
            eventType: "decision.executed",
            phase: "acter",
            decisionCode: "effect.wait",
          },
        ],
      },
      execPatch: pendingEffectPatch,
      regionExecPatch: pendingEffectPatch,
    });
  }

  return input.resumePendingEffect({
    runId: input.runId,
    sessionId: input.sessionId,
    stepIndex: input.stepIndex,
    reactState: input.reactState,
    activeRegion: input.activeRegion,
    loopStepId: input.config.loopStepId,
    acterStepId: input.config.acterStepId,
    pendingEffectKey: input.pendingEffectKey,
    pendingEffectType: input.pendingEffectType,
    effectResult,
    toolCapabilityClassesByName: input.toolCapabilityClassesByName,
    duplicateLedger: input.duplicateLedger,
  });
}
