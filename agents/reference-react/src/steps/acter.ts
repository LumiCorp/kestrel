import { createHash } from "node:crypto";

import type { ArtifactIntent, StepAgent, StepIO, Transition, } from "../../../../src/kestrel/contracts/execution.js";
import type { AgentToolResult } from "../../../../src/kestrel/contracts/model-io.js";
import { isModelVisibleExecutableActionId } from "../../../../src/kestrel/executableActions.js";


import { createRuntimeFailure } from "../../../../src/runtime/RuntimeFailure.js";
import {
  defaultAutonomyPolicy,
} from "../../../../src/governance/autonomy.js";
import type { AutonomyPolicy } from "../../../../src/governance/contracts.js";
import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  normalizeInteractionMode,
  toCanonicalInteractionMode,
} from "../../../../src/mode/contracts.js";
import type { InteractionMode } from "../../../../src/mode/contracts.js";
import {
  sanitizeJsonValue,
  sanitizeUtf16String,
  stringifySanitizedJson,
} from "../../../../src/runtime/jsonSanitizer.js";
import { readActiveTaskGoalFromTranscript } from "../../../../src/runtime/modelTranscript.js";
import {
  isDevShellLifecycleTool,
  normalizeDevShellLifecycle,
} from "../../../../src/runtime/devshellLifecycle.js";
import { isPlanDocumentPath } from "../../../../src/runtime/planDocument.js";
import { asArray, asRecord, asString } from "../../../shared/valueAccess.js";
import {
  buildAgentToolFailedOutputResult,
  buildAgentToolFailureResult,
  buildAgentToolSuccessResult,
  isAgentToolResult,
  unwrapAgentToolOutput,
} from "../../../../tools/toolResult.js";
import {
  findReusableToolOutcome,
  hashToolInput,
  readReadOnlyResultDuplicateLedger,
} from "../memory/workingMemory.js";
import {
  applyFilesystemInspectionCacheAfterToolResult,
  findReusableFilesystemInspection,
  isFilesystemInspectionCacheInvalidatingTool,
  isFilesystemInspectionToolName,
} from "../filesystemInspection.js";
import { normalizeToolActionInput } from "../toolInputNormalization.js";
import type {
  ReactAction,
  ReadOnlyResultDuplicateLedgerEntry,
} from "../types.js";
import { getAgentStateFromRuntimeState } from "../state.js";
import {
  readCompiledActionKind,
  validateCompiledNextAction,
  type CompiledActionValidationFailure,
} from "../actionValidation.js";
import { checkToolBatchChunkPolicyGate, checkToolPolicyGate } from "./acter/policyGates.js";
import {
  annotateVerificationBatchItems,
  appendToolObservation,
  appendToolObservations,
  advanceDuplicateLedger,
  buildPostToolVerification,
  buildToolActionResultFeedback,
  capabilityEvidenceFromAgentFeedback,
  collectToolArtifacts,
  nextCapabilityEvidence,
  normalizeEffectResultForTool,
  toDuplicateResult,
} from "./acter/resultShaping.js";
export {
  buildToolOutputDigestForTests,
  compactInternetToolOutputForTests,
  shapeToolExecutionResultForTests,
} from "./acter/resultShaping.js";
import { applyReactStateEvent } from "../reactStateReducer.js";
import {
  deriveCommandExecutionRole,
  isHelperFailureCommandRole,
} from "../commandRole.js";
import {
  applyReferenceReactExecPatch,
  createReferenceReactEffectCollectCheckpoint,
  createReferenceReactEffectDispatchCheckpoint,
} from "../commandProcessor.js";
import { handleAskUserAction } from "./acter/askUserHandler.js";
import {
  handleCannotSatisfyAction,
  handleFinalizeAction,
} from "./acter/finalizeHandler.js";
import { handlePendingEffect } from "./acter/pendingEffectHandler.js";
import {
  handlePendingToolBatch,
  handleToolBatchAction,
} from "./acter/toolBatchHandler.js";
import type {
  ActerStepConfig,
  ExecutionActionContext,
  PendingToolBatchState,
} from "./acter/shared.js";

export type { ActerStepConfig } from "./acter/shared.js";

const MAX_CONSECUTIVE_DEDUPE_REUSE = 2;
/**
 * Acter is the execution step. It runs actions that were already compiled
 * by the decision compiler.
 */
export function createExecutionStepReducer(config: ActerStepConfig): StepAgent {
  return createExecutionStepReducerInternal(config);
}

function createExecutionStepReducerInternal(config: ActerStepConfig): StepAgent {
  return async (ctx, io) => {
    const capabilityManifest = config.capabilityManifestProvider(ctx);
    const toolCapabilityClassesByName = Object.fromEntries(
      capabilityManifest.map((tool) => [tool.name, tool.capabilityClasses]),
    );
    const toolApprovalCapabilitiesByName = Object.fromEntries(
      capabilityManifest.map((tool) => [tool.name, tool.approvalCapabilities ?? []]),
    );
    const toolExecutionClassByName = Object.fromEntries(
      capabilityManifest.map((tool) => [tool.name, tool.executionClass ?? "read_only"]),
    );
    const toolAllowedInteractionModesByName = Object.fromEntries(
      capabilityManifest.map((tool) => [tool.name, tool.allowedInteractionModes]),
    );
    const reactState = getAgentStateFromRuntimeState(ctx.session.state);
    const modeResolution = normalizeInteractionMode({
      interactionMode: ctx.event.payload.interactionMode ?? reactState.interactionMode,
      actSubmode: ctx.event.payload.actSubmode ?? reactState.actSubmode,
      defaultInteractionMode: DEFAULT_INTERACTION_MODE,
      defaultActSubmode: DEFAULT_ACT_SUBMODE,
    });
    const executionPolicy = readExecutionPolicy(
      ctx.event.payload.executionPolicy ?? reactState.executionPolicy,
    );
    const modeSystemV2Enabled =
      readBoolean(ctx.event.payload.modeSystemV2Enabled) ??
      readBoolean(reactState.modeSystemV2Enabled) ??
      false;
    const execState = asRecord(reactState.exec);
    const pendingAction = readPendingExecutableAction(execState);
    const legacyPendingEffectKey = asString(execState?.pendingEffectKey);
    const legacyPendingEffectType = asString(execState?.pendingEffectType);
    const pendingEffectKey = pendingAction?.idempotencyKey ?? legacyPendingEffectKey;
    const pendingEffectType = pendingAction?.actionId ?? legacyPendingEffectType;
    if (
      pendingAction !== undefined &&
      ((legacyPendingEffectKey !== undefined && legacyPendingEffectKey !== pendingAction.idempotencyKey) ||
        (legacyPendingEffectType !== undefined && legacyPendingEffectType !== pendingAction.actionId))
    ) {
      throw createRuntimeFailure(
        "AGENT_PENDING_ACTION_STATE_INVALID",
        "state.agent.exec.pendingAction disagrees with legacy pending effect state.",
        {
          subsystem: "react",
          step: "agent.exec.dispatch",
          classification: "schema",
          recoverable: false,
        },
      );
    }
    const activeRegion = ctx.region?.currentRegion;
    const eventPayload = asRecord(ctx.event.payload);
    const checkpointSize = resolveToolBatchCheckpointSize(
      eventPayload,
      reactState,
    );
    const autonomyPolicy = resolveAutonomyPolicy(
      eventPayload?.autonomyPolicy ?? reactState.autonomyPolicy,
      asString(eventPayload?.autonomyLevel) ?? asString(reactState.autonomyLevel),
    );
    const actionContext: ExecutionActionContext = {
      capabilityManifest,
      toolCapabilityClassesByName,
      toolApprovalCapabilitiesByName,
      toolExecutionClassByName,
      toolAllowedInteractionModesByName,
      reactState,
      activeRegion,
      checkpointSize,
      executionPolicy,
      autonomyPolicy,
      interactionMode: toCanonicalInteractionMode(modeResolution.interactionMode),
      actSubmode: modeResolution.actSubmode,
      modeSystemV2Enabled,
    };

    if (pendingEffectKey !== undefined) {
      if (pendingEffectType === undefined) {
        throw createActerPendingEffectTypeRequiredError();
      }

      return handlePendingEffect({
        config,
        runId: ctx.runId,
        sessionId: ctx.session.sessionId,
        stepIndex: ctx.stepIndex,
        reactState,
        activeRegion,
        pendingAction,
        pendingEffectKey,
        pendingEffectType,
        duplicateLedger: readReadOnlyResultDuplicateLedger(ctx.memory),
        io,
        toPendingExecutableActionRecord,
        resumePendingEffect,
        toolCapabilityClassesByName: actionContext.toolCapabilityClassesByName,
      });
    }

    const pendingBatch = readPendingToolBatch(execState?.pendingBatch);
    const pendingActionKind = readCompiledActionKind(reactState.nextAction);

    if (
      pendingBatch !== undefined &&
      (pendingActionKind === undefined || (pendingActionKind !== "finalize" && pendingActionKind !== "ask_user"))
    ) {
      return handlePendingToolBatch({
        runId: ctx.runId,
        sessionId: ctx.session.sessionId,
        stepIndex: ctx.stepIndex,
        pendingBatch,
        checkpointSize,
        reactState,
        activeRegion,
        config,
        toolCapabilityClassesByName: actionContext.toolCapabilityClassesByName,
        toolApprovalCapabilitiesByName: actionContext.toolApprovalCapabilitiesByName,
        toolExecutionClassByName: actionContext.toolExecutionClassByName,
        toolAllowedInteractionModesByName: actionContext.toolAllowedInteractionModesByName,
        interactionMode: actionContext.interactionMode,
        actSubmode: actionContext.actSubmode,
        modeSystemV2Enabled: actionContext.modeSystemV2Enabled,
        executionPolicy: actionContext.executionPolicy,
        duplicateLedger: readReadOnlyResultDuplicateLedger(ctx.memory),
        io,
        continueDurableToolBatch,
        executeToolBatchChunk,
      });
    }

    const action = normalizeCompiledAction(
      readCompiledAction(reactState.nextAction),
      readActiveWorkspaceRootFromExecState(execState),
    );

    if (action === undefined) {
      throw createActerMissingActionError();
    }

    if (action.kind === "tool") {
      const executableToolInput = hydrateToolInputFromExecState({
        toolName: action.name,
        toolInput: action.input,
        execState,
      });
      const executableAction =
        executableToolInput === action.input
          ? action
          : {
              ...action,
              input: executableToolInput,
            };
      const actionForDispatch = maybeBuildRequiredActiveDevShellReadAction({
        reactState,
        toolName: executableAction.name,
      }) ?? executableAction;
      const activeDevShellExecRedirect = maybeRedirectActiveDevShellExecAtDispatch({
        reactState,
        activeRegion,
        interactionMode: toCanonicalInteractionMode(modeResolution.interactionMode),
        config,
        toolName: actionForDispatch.name,
        toolInput: actionForDispatch.input,
      });
      if (activeDevShellExecRedirect !== undefined) {
        return activeDevShellExecRedirect;
      }
      const settledDevShellPollingRedirect = maybeRedirectSettledDevShellPollingAtDispatch({
        reactState,
        activeRegion,
        interactionMode: toCanonicalInteractionMode(modeResolution.interactionMode),
        config,
        toolName: actionForDispatch.name,
        toolInput: actionForDispatch.input,
      });
      if (settledDevShellPollingRedirect !== undefined) {
        return settledDevShellPollingRedirect;
      }
      const actionInputHash = hashToolInput(actionForDispatch.name, actionForDispatch.input);
      const workspaceRootForReducer = readActiveWorkspaceRootFromExecState(execState);
      const toolClass = toolExecutionClassByName[actionForDispatch.name] ?? "read_only";
      const policyGate = await checkToolPolicyGate({
        reactState,
        activeRegion,
        acterStepId: config.acterStepId,
        deliberationStepId: resolveDeliberationStep(modeResolution.interactionMode, config),
        loopStepId: config.loopStepId,
        currentStepAgent: asString(ctx.session.currentStepAgent) ?? config.acterStepId,
        runId: ctx.runId,
        sessionId: ctx.session.sessionId,
        stepIndex: ctx.stepIndex,
        eventType: ctx.event.type,
        eventPayload,
        toolName: actionForDispatch.name,
        toolInput: actionForDispatch.input,
        toolClass,
        allowedInteractionModes: toolAllowedInteractionModesByName[actionForDispatch.name],
        requiredApprovalCapabilities: toolApprovalCapabilitiesByName[actionForDispatch.name],
        interactionMode: toCanonicalInteractionMode(modeResolution.interactionMode),
        actSubmode: modeResolution.actSubmode,
        modeSystemV2Enabled,
        executionPolicy,
        autonomyPolicy,
        autonomyEvidence: collectAutonomyEvidence(reactState),
        autonomyRiskSignals: collectAutonomyRiskSignals({
          toolClass,
          decisionConfidence: readDecisionConfidence(reactState),
          missingCapabilities: readMissingCapabilities(reactState),
        }),
        proposalProvider: config.managedWorktreeProposalProvider,
        io,
      });
      if (policyGate.kind === "blocked") {
        return policyGate.transition;
      }

      const reusableFilesystemInspection = toolClass === "read_only" &&
          isFilesystemInspectionToolName(actionForDispatch.name)
        ? findReusableFilesystemInspection({
          reactState,
          toolName: actionForDispatch.name,
          toolInput: actionForDispatch.input,
        })
        : undefined;
      if (reusableFilesystemInspection !== undefined) {
        const reusableOutput = reusableFilesystemInspection.output;
        const capabilityClasses = toolCapabilityClassesByName[actionForDispatch.name] ?? [actionForDispatch.name];
        const nextCapabilities = nextCapabilityEvidence(
          capabilityEvidenceFromAgentFeedback(reactState),
          [
            {
              toolName: actionForDispatch.name,
              classes: capabilityClasses,
            },
          ],
          ctx.stepIndex,
        );
        const reducerResult = applyReactStateEvent({
          reactState,
          event: {
            type: "tool_result_observed",
            stepIndex: ctx.stepIndex,
            toolName: actionForDispatch.name,
            toolInput: actionForDispatch.input,
            toolOutput: reusableOutput,
            inputHash: actionInputHash,
            reused: true,
            workspaceRoot: workspaceRootForReducer,
          },
        });
        const postToolVerification = buildPostToolVerification({
          reactState,
          nextCapabilities,
          output: reusableOutput,
          toolName: actionForDispatch.name,
          action: actionForDispatch,
        });
        const lastActionResult = buildToolActionResultFeedback({
          toolName: actionForDispatch.name,
          input: compactToolInputForDecision(actionForDispatch.name, actionForDispatch.input),
          inputHash: actionInputHash,
          output: reusableOutput,
          capabilityClasses,
          reused: true,
          status: "cached",
        });
        const filesystemInspectionCache = applyFilesystemInspectionCacheAfterToolResult({
          reactState: reducerResult.reactState,
          toolName: actionForDispatch.name,
          toolInput: actionForDispatch.input,
          toolOutput: reusableOutput,
          stepIndex: ctx.stepIndex,
          inputHash: actionInputHash,
          executionClass: toolClass,
        });
        const latestEvidenceDelta = {
          kind: "filesystem_inspection_cached_result",
          toolName: actionForDispatch.name,
          cachedStepIndex: reusableFilesystemInspection.stepIndex,
        };
        const execPatch = {
          pendingApproval: undefined,
          pendingToolCall: undefined,
          dispatchReuseGuard: undefined,
        };
        return createReferenceReactEffectCollectCheckpoint({
          reactState: reducerResult.reactState,
          currentStepAgent: config.acterStepId,
          nextStepAgent: config.loopStepId,
          stepIndex: ctx.stepIndex,
          activeRegion,
          phase: "OBSERVE",
          reactPatch: {
            postToolVerification,
            lastActionResult,
            ...buildRetryContextPatchAfterActionResult({
              reactState: reducerResult.reactState,
              action: actionForDispatch,
              actionResult: lastActionResult,
            }),
            observations: appendToolObservation(reducerResult.reactState, {
              stepIndex: ctx.stepIndex,
              toolName: actionForDispatch.name,
              inputHash: actionInputHash,
              output: reusableOutput,
              capabilityClasses,
              reused: true,
              status: "cached",
            }),
            ...(filesystemInspectionCache !== undefined ? { filesystemInspectionCache } : {}),
            latestEvidenceDelta,
            decisionTrace: [
              {
                eventType: "decision.filesystem_inspection_reused",
                phase: "acter",
                decisionCode: "tool",
                metadata: {
                  toolName: actionForDispatch.name,
                  cachedStepIndex: reusableFilesystemInspection.stepIndex,
                },
              },
            ],
          },
          execPatch,
          regionReactPatch: {
            evidenceLedger: reducerResult.reactState.evidenceLedger,
            postToolVerification,
            lastActionResult,
            ...buildRetryContextPatchAfterActionResult({
              reactState: reducerResult.reactState,
              action: actionForDispatch,
              actionResult: lastActionResult,
            }),
            ...(filesystemInspectionCache !== undefined ? { filesystemInspectionCache } : {}),
            latestEvidenceDelta,
          },
          regionExecPatch: execPatch,
        });
      }

      const reusableOutcome = toolClass === "read_only"
        ? findReusableToolOutcome({
            memory: ctx.memory,
            reactState,
            toolName: actionForDispatch.name,
            toolInput: actionForDispatch.input,
          })
        : undefined;
      if (reusableOutcome !== undefined) {
        const duplicateLedger = readReadOnlyResultDuplicateLedger(ctx.memory);
        const duplicateResult = toDuplicateResult({
          toolName: actionForDispatch.name,
          output: reusableOutcome.output,
          ledger: duplicateLedger,
          fallbackMatchedPriorStep: reusableOutcome.stepIndex,
          kind: "duplicate_cached_result",
        });
        const capabilityClasses = toolCapabilityClassesByName[actionForDispatch.name] ?? [actionForDispatch.name];
        const nextCapabilities = capabilityEvidenceFromAgentFeedback(reactState);
        const dedupeGuard = nextDispatchReuseGuard({
          existing: readDispatchReuseGuard(execState?.dispatchReuseGuard),
          runId: ctx.runId,
          toolName: actionForDispatch.name,
          inputHash: actionInputHash,
        });
        if (dedupeGuard.consecutiveReuseCount >= MAX_CONSECUTIVE_DEDUPE_REUSE) {
          const stallError = createActerDispatchStallDetectedError({
            runId: ctx.runId,
            stepIndex: ctx.stepIndex,
            toolName: actionForDispatch.name,
            inputHash: actionInputHash,
            consecutiveReuseCount: dedupeGuard.consecutiveReuseCount,
          });
          const runtimeError = stallError as Error & {
            code?: string;
            details?: Record<string, unknown>;
          };
          const execPatch = {
            pendingApproval: undefined,
            pendingToolCall: undefined,
            dispatchReuseGuard: undefined,
          };
          return createReferenceReactEffectCollectCheckpoint({
            reactState,
            currentStepAgent: config.acterStepId,
            nextStepAgent: config.loopStepId,
            stepIndex: ctx.stepIndex,
            activeRegion,
            phase: "LOOP",
            reactPatch: {
              lastActionResult: {
                ok: false,
                kind: "validation_feedback",
                error: {
                  code: runtimeError.code ?? "AGENT_DISPATCH_STALL_DETECTED",
                  message: runtimeError.message,
                  details: runtimeError.details ?? {},
                },
              },
              retryContext: {
                failure: {
                  code: runtimeError.code ?? "AGENT_DISPATCH_STALL_DETECTED",
                  message: runtimeError.message,
                  details: runtimeError.details ?? {},
                },
                previousAction: actionForDispatch,
              },
            },
            execPatch,
            regionReactPatch: {
              lastActionResult: {
                ok: false,
                kind: "validation_feedback",
              },
            },
            regionExecPatch: execPatch,
          });
        }
        const reusableOutput = reusableOutcome.output ?? {
          status: reusableOutcome.status,
          summary: reusableOutcome.summary,
        };
        const postToolVerification = buildPostToolVerification({
          reactState,
          nextCapabilities,
          output: reusableOutput,
          toolName: actionForDispatch.name,
          action: actionForDispatch,
          duplicateResult,
        });
        const latestEvidenceDelta = {
          kind: "duplicate_cached_result",
          toolName: actionForDispatch.name,
          cachedStepIndex: reusableOutcome.stepIndex,
          ...(duplicateResult?.duplicateCount !== undefined
            ? { duplicateCount: duplicateResult.duplicateCount }
            : {}),
          ...(duplicateResult?.matchedPriorStep !== undefined
            ? { matchedPriorStep: duplicateResult.matchedPriorStep }
            : {}),
        };
        const execPatch = {
          pendingApproval: undefined,
          pendingToolCall: undefined,
          dispatchReuseGuard: dedupeGuard,
        };
        const lastActionResult = buildToolActionResultFeedback({
          toolName: actionForDispatch.name,
          inputHash: actionInputHash,
          output: reusableOutput,
          capabilityClasses,
          reused: true,
          status: "cached",
        });
        const reducerResult = applyReactStateEvent({
          reactState,
          event: {
            type: "tool_result_observed",
            stepIndex: ctx.stepIndex,
            toolName: actionForDispatch.name,
            toolInput: withActionExecutionRoleMetadata(
              actionForDispatch.input,
              "executionRole" in actionForDispatch ? actionForDispatch.executionRole : undefined,
            ),
            toolOutput: reusableOutput,
            inputHash: actionInputHash,
            reused: true,
            workspaceRoot: workspaceRootForReducer,
          },
        });
        const regionLastActionResult = buildToolActionResultFeedback({
          toolName: actionForDispatch.name,
          inputHash: actionInputHash,
          capabilityClasses,
          reused: true,
          status: "cached",
        });
        return createReferenceReactEffectCollectCheckpoint({
          reactState: reducerResult.reactState,
          currentStepAgent: config.acterStepId,
          nextStepAgent: config.loopStepId,
          stepIndex: ctx.stepIndex,
          activeRegion,
          phase: "OBSERVE",
          reactPatch: {
            postToolVerification,
            lastActionResult,
            ...buildRetryContextPatchAfterActionResult({
              reactState: reducerResult.reactState,
              action: actionForDispatch,
              actionResult: lastActionResult,
            }),
            observations: appendToolObservation(reducerResult.reactState, {
              stepIndex: ctx.stepIndex,
              toolName: actionForDispatch.name,
              inputHash: actionInputHash,
              output: reusableOutput,
              capabilityClasses,
              reused: true,
              status: "cached",
            }),
            latestEvidenceDelta,
            decisionTrace: [
              {
                eventType: "decision.deduped",
                phase: "acter",
                decisionCode: "tool",
                metadata: {
                  toolName: actionForDispatch.name,
                  cacheHit: true,
                  cachedStepIndex: reusableOutcome.stepIndex,
                },
              },
            ],
          },
          execPatch,
          regionReactPatch: {
            postToolVerification,
            lastActionResult: regionLastActionResult,
            ...buildRetryContextPatchAfterActionResult({
              reactState: reducerResult.reactState,
              action: actionForDispatch,
              actionResult: lastActionResult,
            }),
            latestEvidenceDelta,
          },
          regionExecPatch: execPatch,
        });
      }

      if (toolClass !== "read_only" && toolClass !== "planning_write") {
        return dispatchDurableToolCall({
          runId: ctx.runId,
          sessionId: ctx.session.sessionId,
          stepIndex: ctx.stepIndex,
          reactState,
          activeRegion,
          acterStepId: config.acterStepId,
          toolName: actionForDispatch.name,
          toolInput: actionForDispatch.input,
          toolExecutionClass: toolClass,
          executionRole: "executionRole" in actionForDispatch ? actionForDispatch.executionRole : undefined,
        });
      }

      let toolResult;
      try {
        toolResult = await io.useTool!(actionForDispatch.name, actionForDispatch.input);
      } catch (error) {
        if (
          shouldContinueToolFailure({
            reactState,
            toolName: actionForDispatch.name,
            toolInput: actionForDispatch.input,
          })
        ) {
          toolResult = buildAgentToolFailureResult({
            toolName: actionForDispatch.name,
            input: actionForDispatch.input,
            error,
          });
        } else {
          throw error;
        }
      }
      const rawOutput = unwrapAgentToolOutput(toolResult);
      const artifacts = collectToolArtifacts(actionForDispatch.name, rawOutput);
      const capabilityClasses = toolCapabilityClassesByName[actionForDispatch.name] ?? [actionForDispatch.name];
      const capabilityEvidence = nextCapabilityEvidence(
        capabilityEvidenceFromAgentFeedback(reactState),
        [
          {
            toolName: actionForDispatch.name,
            classes: capabilityClasses,
          },
        ],
        ctx.stepIndex,
      );
      const duplicateResult = toDuplicateResult({
        toolName: actionForDispatch.name,
        output: rawOutput,
        ledger: readReadOnlyResultDuplicateLedger(ctx.memory),
      });
      const reducerResult = applyReactStateEvent({
        reactState,
        event: {
          type: "tool_result_observed",
          stepIndex: ctx.stepIndex,
          toolName: actionForDispatch.name,
          toolInput: withActionExecutionRoleMetadata(
            actionForDispatch.input,
            "executionRole" in actionForDispatch ? actionForDispatch.executionRole : undefined,
          ),
          toolOutput: toolResult,
          inputHash: actionInputHash,
          workspaceRoot: workspaceRootForReducer,
        },
      });
      const postToolVerification = buildPostToolVerification({
        reactState,
        nextCapabilities: capabilityEvidence,
        output: rawOutput,
        toolName: actionForDispatch.name,
        action: actionForDispatch,
        duplicateResult,
      });
      const lastActionResult = buildToolActionResultFeedback({
        toolName: actionForDispatch.name,
        input: compactToolInputForDecision(actionForDispatch.name, actionForDispatch.input),
        inputHash: actionInputHash,
        output: rawOutput,
        capabilityClasses,
      });
      const latestEvidenceDelta = {
        kind: duplicateResult?.kind === "duplicate_executed_result"
          ? "duplicate_executed_result"
          : "fresh_result",
        toolName: actionForDispatch.name,
        ...(duplicateResult?.duplicateCount !== undefined
          ? { duplicateCount: duplicateResult.duplicateCount }
          : {}),
        ...(duplicateResult?.matchedPriorStep !== undefined
          ? { matchedPriorStep: duplicateResult.matchedPriorStep }
          : {}),
      };
      const filesystemInspectionCache = applyFilesystemInspectionCacheAfterToolResult({
        reactState: reducerResult.reactState,
        toolName: actionForDispatch.name,
        toolInput: actionForDispatch.input,
        toolOutput: rawOutput,
        stepIndex: ctx.stepIndex,
        inputHash: actionInputHash,
        executionClass: toolClass,
      });
      const planWritePatch = buildPlanWriteStatePatch({
        toolName: actionForDispatch.name,
        toolInput: actionForDispatch.input,
        toolOutput: rawOutput,
      });
      const execPatch = {
        pendingApproval: undefined,
        pendingToolCall: undefined,
        dispatchReuseGuard: undefined,
      };
      return createReferenceReactEffectCollectCheckpoint({
        reactState: reducerResult.reactState,
        currentStepAgent: config.acterStepId,
        nextStepAgent: config.loopStepId,
        stepIndex: ctx.stepIndex,
        activeRegion,
        phase: "OBSERVE",
        artifacts,
        reactPatch: {
          postToolVerification,
          lastActionResult,
          ...buildRetryContextPatchAfterActionResult({
            reactState: reducerResult.reactState,
            action: actionForDispatch,
            actionResult: lastActionResult,
          }),
          observations: appendToolObservation(reducerResult.reactState, {
            stepIndex: ctx.stepIndex,
            toolName: actionForDispatch.name,
            inputHash: actionInputHash,
            output: rawOutput,
            capabilityClasses,
          }),
          ...planWritePatch,
          ...(filesystemInspectionCache !== undefined ? { filesystemInspectionCache } : {}),
          latestEvidenceDelta,
          decisionTrace: [
            {
              eventType: "decision.executed",
              phase: "acter",
              decisionCode: "tool",
            },
          ],
        },
        execPatch,
        regionReactPatch: {
          evidenceLedger: reducerResult.reactState.evidenceLedger,
          postToolVerification,
          lastActionResult,
          ...buildRetryContextPatchAfterActionResult({
            reactState: reducerResult.reactState,
            action: actionForDispatch,
            actionResult: lastActionResult,
          }),
          ...(filesystemInspectionCache !== undefined ? { filesystemInspectionCache } : {}),
          ...planWritePatch,
          latestEvidenceDelta,
        },
        regionExecPatch: execPatch,
      });
    }

    if (action.kind === "tool_batch") {
      return handleToolBatchAction({
        action,
        runId: ctx.runId,
        sessionId: ctx.session.sessionId,
        currentStepAgent: asString(ctx.session.currentStepAgent) ?? config.acterStepId,
        stepIndex: ctx.stepIndex,
        eventType: ctx.event.type,
        eventPayload: asRecord(ctx.event.payload),
        reactState,
        activeRegion,
        config,
        checkpointSize,
        toolCapabilityClassesByName: actionContext.toolCapabilityClassesByName,
        toolApprovalCapabilitiesByName: actionContext.toolApprovalCapabilitiesByName,
        toolExecutionClassByName: actionContext.toolExecutionClassByName,
        toolAllowedInteractionModesByName: actionContext.toolAllowedInteractionModesByName,
        interactionMode: actionContext.interactionMode,
        actSubmode: actionContext.actSubmode,
        modeSystemV2Enabled: actionContext.modeSystemV2Enabled,
        executionPolicy: actionContext.executionPolicy,
        autonomyPolicy: actionContext.autonomyPolicy,
        autonomyEvidence: collectAutonomyEvidence(reactState),
        autonomyRiskSignals: collectAutonomyRiskSignals({
          toolClass: action.items.some(
            (item) => (actionContext.toolExecutionClassByName[item.name] ?? "read_only") === "external_side_effect",
          )
            ? "external_side_effect"
            : action.items.some(
                (item) => (actionContext.toolExecutionClassByName[item.name] ?? "read_only") === "sandboxed_only",
              )
              ? "sandboxed_only"
              : "read_only",
          decisionConfidence: readDecisionConfidence(reactState),
          missingCapabilities: readMissingCapabilities(reactState),
        }),
        duplicateLedger: readReadOnlyResultDuplicateLedger(ctx.memory),
        io,
        deliberationStepId: resolveDeliberationStep(actionContext.interactionMode, config),
        continueDurableToolBatch,
        executeToolBatchChunk,
      });
    }

    if (action.kind === "effect") {
      throw createActerRawEffectActionError();
    }

    if (action.kind === "ask_user") {
      return handleAskUserAction({
        action,
        config,
        reactState,
        activeRegion,
        currentStepAgent: asString(ctx.session.currentStepAgent),
        interactionMode: actionContext.interactionMode,
        stepIndex: ctx.stepIndex,
        eventType: ctx.event.type,
        eventPayload: ctx.event.payload,
        resolveDeliberationStep,
      });
    }

    if (action.kind === "resolve_tool") {
      throw createActerResolveActionError();
    }

    if (action.kind === "cannot_satisfy") {
      return handleCannotSatisfyAction({
        action,
        config,
        reactState,
        activeRegion,
        stepIndex: ctx.stepIndex,
        io,
      });
    }
    if (action.kind === "handoff_to_build") {
      throw createRuntimeFailure(
        "AGENT_HANDOFF_REACHED_EXEC_DISPATCH",
        "handoff_to_build must be converted into a continuation wait before execution dispatch.",
        {
          subsystem: "react",
          step: "agent.exec.finalize",
          classification: "state",
          recoverable: false,
        },
      );
    }

    return handleFinalizeAction({
      action,
      config,
      reactState,
      activeRegion,
      stepIndex: ctx.stepIndex,
      io,
    });
  };
}

function resolveDeliberationStep(
  _interactionMode: InteractionMode,
  config: ActerStepConfig,
): string {
  return config.deliberationStepId;
}

function dispatchDurableToolCall(input: {
  runId: string;
  sessionId: string;
  stepIndex: number;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  acterStepId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolExecutionClass?: "read_only" | "planning_write" | "sandboxed_only" | "external_side_effect" | undefined;
  executionRole?: unknown;
}) {
  const idempotencyKey = buildDurableToolIdempotencyKey(
    input.sessionId,
    input.runId,
    input.stepIndex,
    input.toolName,
    input.toolInput,
  );

  const pendingEffectPatch = {
    pendingApproval: undefined,
    pendingAction: buildPendingExecutableActionState({
      actionId: "execute_tool_call",
      idempotencyKey,
    }),
    pendingEffectKey: idempotencyKey,
    pendingEffectType: "execute_tool_call",
    pendingToolCall: {
      name: input.toolName,
      input: input.toolInput,
      ...(input.executionRole !== undefined ? { executionRole: input.executionRole } : {}),
      idempotencyKey,
    },
  };

  return createReferenceReactEffectDispatchCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.acterStepId,
    nextStepAgent: input.acterStepId,
    stepIndex: input.stepIndex,
    activeRegion: input.activeRegion,
    phase: "ACT",
    reactPatch: {
      ...(isFilesystemInspectionCacheInvalidatingTool(input.toolName, input.toolExecutionClass)
        ? { filesystemInspectionCache: [] }
        : {}),
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "tool.dispatch_durable",
          metadata: {
            toolName: input.toolName,
          },
        },
      ],
    },
    execPatch: pendingEffectPatch,
    regionReactPatch: {
      ...(isFilesystemInspectionCacheInvalidatingTool(input.toolName, input.toolExecutionClass)
        ? { filesystemInspectionCache: [] }
        : {}),
    },
    regionExecPatch: pendingEffectPatch,
    effects: [
      {
        type: "execute_tool_call",
        payload: {
          toolName: input.toolName,
          toolInput: input.toolInput,
        },
        idempotencyKey,
        failurePolicy: shouldContinueToolFailure(input) ? "CONTINUE" as const : "STOP" as const,
      },
    ],
  });
}

function shouldContinueToolFailure(input: {
  reactState: Record<string, unknown>;
  toolName: string;
  toolInput: Record<string, unknown>;
}): boolean {
  if (input.toolName.startsWith("fs.")) {
    return true;
  }
  return false;
}

function buildPlanWriteStatePatch(input: {
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
}): { plan?: { path: string; status: "draft" }; planDocument?: { path: string; exists: true; content: string } } {
  if (input.toolName !== "planning.write_document") {
    return {};
  }
  const output = asRecord(input.toolOutput);
  const toolInput = asRecord(input.toolInput);
  const planPath = asString(output?.path) ?? asString(toolInput?.path);
  const content = asString(toolInput?.content);
  if (planPath === undefined || content === undefined || isPlanDocumentPath(planPath) === false) {
    return {};
  }
  return {
    plan: {
      path: planPath,
      status: "draft",
    },
    planDocument: {
      path: planPath,
      exists: true,
      content,
    },
  };
}

function buildRetryContextPatchAfterActionResult(input: {
  reactState: Record<string, unknown>;
  action: unknown;
  actionResult: unknown;
}): { retryContext?: Record<string, unknown> | undefined } {
  const retryContext = asRecord(input.reactState.retryContext);
  if (retryContext === undefined) {
    return {};
  }
  void input.action;
  void input.actionResult;
  return { retryContext: undefined };
}

function continueDurableToolBatch(input: {
  runId: string;
  sessionId: string;
  stepIndex: number;
  pendingBatch: PendingToolBatchState;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  loopStepId: string;
  acterStepId: string;
  toolCapabilityClassesByName: Record<string, string[]>;
  duplicateLedger: ReadonlyArray<ReadOnlyResultDuplicateLedgerEntry>;
}) {
  const totalItems = input.pendingBatch.items.length;
  const nextIndex = clampIndex(input.pendingBatch.nextIndex, totalItems);
  if (nextIndex >= totalItems && input.pendingBatch.completedItems.length > 0) {
    return finalizeDurableToolBatch({
      stepIndex: input.stepIndex,
      pendingBatch: input.pendingBatch,
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      currentStepAgent: input.acterStepId,
      loopStepId: input.loopStepId,
      toolCapabilityClassesByName: input.toolCapabilityClassesByName,
      duplicateLedger: input.duplicateLedger,
    });
  }

  const nextItem = input.pendingBatch.items[nextIndex];
  if (nextItem === undefined) {
    throw createRuntimeFailure(
      "AGENT_DURABLE_BATCH_ITEM_MISSING",
      "Durable tool batch is missing the next item to execute.",
      {
        subsystem: "react",
        step: "agent.exec.dispatch",
        classification: "runtime",
        recoverable: false,
        nextIndex,
        totalItems,
      },
    );
  }
  const idempotencyKey = buildDurableToolIdempotencyKey(
    input.sessionId,
    input.runId,
    input.stepIndex,
    nextItem.name,
    nextItem.input,
  );

  const pendingEffectPatch = {
    pendingApproval: undefined,
    pendingAction: buildPendingExecutableActionState({
      actionId: "execute_tool_call",
      idempotencyKey,
    }),
    pendingEffectKey: idempotencyKey,
    pendingEffectType: "execute_tool_call",
    pendingBatch: {
      ...input.pendingBatch,
      executionMode: "durable",
      pendingItem: {
        name: nextItem.name,
        input: nextItem.input,
        ...(nextItem.toolCallId !== undefined ? { toolCallId: nextItem.toolCallId } : {}),
        idempotencyKey,
      },
    },
  };

  return createReferenceReactEffectDispatchCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.acterStepId,
    nextStepAgent: input.acterStepId,
    stepIndex: input.stepIndex,
    activeRegion: input.activeRegion,
    phase: "ACT",
    execPatch: pendingEffectPatch,
    regionExecPatch: pendingEffectPatch,
    effects: [
      {
        type: "execute_tool_call",
        payload: {
          toolName: nextItem.name,
          toolInput: nextItem.input,
        },
        idempotencyKey,
        failurePolicy: shouldContinueToolFailure({
          reactState: input.reactState,
          toolName: nextItem.name,
          toolInput: nextItem.input,
        }) ? "CONTINUE" as const : "STOP" as const,
      },
    ],
  });
}

function resumePendingEffect(input: {
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
  duplicateLedger: ReadonlyArray<ReadOnlyResultDuplicateLedgerEntry>;
}) {
  const effectRecord = asRecord(input.effectResult);
  const effectStatus = asString(effectRecord?.status);
  let collectedOutput =
    effectRecord !== undefined && "output" in effectRecord ? effectRecord.output : input.effectResult;
  if (input.pendingEffectType !== "execute_tool_call") {
    return createReferenceReactEffectCollectCheckpoint({
      reactState: input.reactState,
      currentStepAgent: input.acterStepId,
      nextStepAgent: input.loopStepId,
      stepIndex: input.stepIndex,
      activeRegion: input.activeRegion,
      phase: "OBSERVE",
      reactPatch: {
        lastActionResult: {
          kind: "effect",
          type: input.pendingEffectType,
          result: collectedOutput,
        },
        decisionTrace: [
          {
            eventType: "decision.executed",
            phase: "acter",
            decisionCode: "effect.collect",
          },
        ],
      },
      execPatch: {
        pendingAction: undefined,
        pendingEffectKey: undefined,
        pendingEffectType: undefined,
      },
      regionReactPatch: {
        lastActionResult: {
          kind: "effect",
          type: input.pendingEffectType,
        },
      },
    });
  }

  const pendingBatch = readPendingToolBatch(asRecord(input.reactState.exec)?.pendingBatch);
  if (
    pendingBatch?.executionMode === "durable" &&
    pendingBatch.pendingItem?.idempotencyKey === input.pendingEffectKey
  ) {
    return resumeDurableToolBatch({
      runId: input.runId,
      stepIndex: input.stepIndex,
      reactState: input.reactState,
      activeRegion: input.activeRegion,
      loopStepId: input.loopStepId,
      acterStepId: input.acterStepId,
      pendingBatch,
      effectResult: effectStatus === "FAILED" ? input.effectResult : collectedOutput,
      toolCapabilityClassesByName: input.toolCapabilityClassesByName,
      duplicateLedger: input.duplicateLedger,
    });
  }

  const pendingToolCall = asRecord(asRecord(input.reactState.exec)?.pendingToolCall);
  const toolName = asString(pendingToolCall?.name);
  if (toolName === undefined) {
    throw createRuntimeFailure(
      "AGENT_PENDING_TOOL_CALL_REQUIRED",
      "Durable tool execution is missing pendingToolCall state.",
      {
        subsystem: "react",
        step: "agent.exec.wait_effect",
        classification: "schema",
        recoverable: true,
        statePath: "state.agent.exec.pendingToolCall",
      },
    );
  }
  const pendingToolInput = asRecord(pendingToolCall?.input) ?? {};
  const pendingToolInputForReducer = withActionExecutionRoleMetadata(
    pendingToolInput,
    pendingToolCall?.executionRole,
  );
  collectedOutput = normalizeEffectResultForTool({
    toolName,
    toolInput: pendingToolInput,
    effectResult: input.effectResult,
    collectedOutput: unwrapAgentToolOutput(collectedOutput),
  });
  const toolResult = ensureAgentToolResult({
    toolName,
    toolInput: pendingToolInput,
    output: collectedOutput,
    candidate: input.effectResult,
  });
  const rawOutput = unwrapAgentToolOutput(toolResult);
  const pendingToolInputHash = hashToolInput(toolName, pendingToolInput);
  const capabilityClasses = input.toolCapabilityClassesByName[toolName] ?? [toolName];
  const capabilityEvidence = nextCapabilityEvidence(
    capabilityEvidenceFromAgentFeedback(input.reactState),
    [
      {
        toolName,
        classes: capabilityClasses,
      },
    ],
    input.stepIndex,
  );
  const duplicateResult = toDuplicateResult({
    toolName,
    output: rawOutput,
    ledger: [...input.duplicateLedger],
  });
  const devShellExecPatch = buildDevShellExecStatePatch({
    runId: input.runId,
    execState: asRecord(input.reactState.exec),
    decisionVerification: asRecord(input.reactState.decisionVerification),
    toolName,
    toolInput: pendingToolInputForReducer,
    toolOutput: rawOutput,
  });
  const reducerResult = applyReactStateEvent({
    reactState: input.reactState,
    event: {
      type: "tool_result_observed",
      stepIndex: input.stepIndex,
      toolName,
      toolInput: pendingToolInputForReducer,
      toolOutput: toolResult,
      inputHash: pendingToolInputHash,
      workspaceRoot: readActiveWorkspaceRootFromExecState(asRecord(input.reactState.exec)),
    },
  });
  const preservedDevShellReadEvidence = preservePriorDevShellReadEvidence({
    toolName,
    currentStoredOutput: rawOutput,
    verificationOutput: rawOutput,
    priorLastActionResult: input.reactState.lastActionResult,
    currentExecState: asRecord(input.reactState.exec),
  });
  const storedOutputForDecision = preservedDevShellReadEvidence.storedOutput;
  const reusedPriorDevShellReadEvidence = preservedDevShellReadEvidence.reusedPriorActionableOutput;
  const artifacts = collectToolArtifacts(toolName, rawOutput);
  const postToolVerification = buildPostToolVerification({
    reactState: input.reactState,
    nextCapabilities: capabilityEvidence,
    output: rawOutput,
    toolName,
    action: input.reactState.nextAction,
    duplicateResult,
  });
  const lastActionResult = buildToolActionResultFeedback({
    toolName,
    input: compactToolInputForDecision(toolName, pendingToolInput),
    inputHash: pendingToolInputHash,
    output: storedOutputForDecision,
    capabilityClasses,
  });
  const latestEvidenceDelta = {
    kind:
      duplicateResult?.kind === "duplicate_executed_result" ||
        reusedPriorDevShellReadEvidence
        ? "duplicate_executed_result"
        : "fresh_result",
    toolName,
    ...(duplicateResult?.duplicateCount !== undefined
      ? { duplicateCount: duplicateResult.duplicateCount }
      : {}),
    ...(duplicateResult?.matchedPriorStep !== undefined
      ? { matchedPriorStep: duplicateResult.matchedPriorStep }
      : {}),
  };
  const filesystemInspectionCache = applyFilesystemInspectionCacheAfterToolResult({
    reactState: reducerResult.reactState,
    toolName,
    toolInput: pendingToolInput,
    toolOutput: storedOutputForDecision,
    stepIndex: input.stepIndex,
    inputHash: pendingToolInputHash,
    executionClass: "external_side_effect",
  });
  const execPatch = {
    pendingAction: undefined,
    pendingEffectKey: undefined,
    pendingEffectType: undefined,
    pendingToolCall: undefined,
    ...(devShellExecPatch !== undefined ? devShellExecPatch : {}),
  };
  return createReferenceReactEffectCollectCheckpoint({
    reactState: reducerResult.reactState,
    currentStepAgent: input.acterStepId,
    nextStepAgent: input.loopStepId,
    stepIndex: input.stepIndex,
    activeRegion: input.activeRegion,
    phase: "OBSERVE",
    artifacts,
    reactPatch: {
      postToolVerification,
      lastActionResult,
      ...buildRetryContextPatchAfterActionResult({
        reactState: reducerResult.reactState,
        action: input.reactState.nextAction,
        actionResult: lastActionResult,
      }),
      observations: appendToolObservation(reducerResult.reactState, {
        stepIndex: input.stepIndex,
        toolName,
        inputHash: pendingToolInputHash,
        output: storedOutputForDecision,
        capabilityClasses,
      }),
      ...(filesystemInspectionCache !== undefined ? { filesystemInspectionCache } : {}),
      latestEvidenceDelta,
      decisionTrace: [
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "tool.collect_durable",
          metadata: {
            toolName,
            ...(reusedPriorDevShellReadEvidence
              ? { reusedPriorDevShellReadEvidence: true }
              : {}),
          },
        },
      ],
    },
    execPatch,
    regionReactPatch: {
      evidenceLedger: reducerResult.reactState.evidenceLedger,
      postToolVerification,
      lastActionResult,
      ...buildRetryContextPatchAfterActionResult({
        reactState: reducerResult.reactState,
        action: input.reactState.nextAction,
        actionResult: lastActionResult,
      }),
      ...(filesystemInspectionCache !== undefined ? { filesystemInspectionCache } : {}),
      latestEvidenceDelta,
    },
    regionExecPatch: execPatch,
  });
}

function resumeDurableToolBatch(input: {
  runId: string;
  stepIndex: number;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  loopStepId: string;
  acterStepId: string;
  pendingBatch: PendingToolBatchState;
  effectResult: unknown;
  toolCapabilityClassesByName: Record<string, string[]>;
  duplicateLedger: ReadonlyArray<ReadOnlyResultDuplicateLedgerEntry>;
}) {
  const pendingItem = input.pendingBatch.pendingItem;
  if (pendingItem === undefined) {
    throw createRuntimeFailure(
      "AGENT_DURABLE_BATCH_PENDING_ITEM_REQUIRED",
      "Durable tool batch is missing pendingItem state.",
      {
        subsystem: "react",
        step: "agent.exec.wait_effect",
        classification: "schema",
        recoverable: true,
        statePath: "state.agent.exec.pendingBatch.pendingItem",
      },
    );
  }

  const normalizedOutput = normalizeEffectResultForTool({
    toolName: pendingItem.name,
    toolInput: pendingItem.input,
    effectResult: input.effectResult,
    collectedOutput: unwrapAgentToolOutput(input.effectResult),
  });
  const toolResult = ensureAgentToolResult({
    toolName: pendingItem.name,
    toolInput: pendingItem.input,
    output: normalizedOutput,
    candidate: input.effectResult,
  });
  const rawOutput = unwrapAgentToolOutput(toolResult);
  const duplicateResult = toDuplicateResult({
    toolName: pendingItem.name,
    output: rawOutput,
    ledger: [...input.duplicateLedger],
  });
  const completedItems = [
    ...input.pendingBatch.completedItems,
    {
      name: pendingItem.name,
      input: pendingItem.input,
      ...(pendingItem.toolCallId !== undefined ? { toolCallId: pendingItem.toolCallId } : {}),
      output: rawOutput,
    },
  ];
  const capabilityClasses = input.toolCapabilityClassesByName[pendingItem.name] ?? [pendingItem.name];
  const capabilityEvidence = nextCapabilityEvidence(
    capabilityEvidenceFromAgentFeedback(input.reactState),
    [
      {
        toolName: pendingItem.name,
        classes: capabilityClasses,
      },
    ],
    input.stepIndex,
  );
  const nextPendingBatch: PendingToolBatchState = {
    ...input.pendingBatch,
    nextIndex: input.pendingBatch.nextIndex + 1,
    completedItems,
    pendingItem: undefined,
  };
  const totalItems = input.pendingBatch.items.length;
  const hasRemaining = nextPendingBatch.nextIndex < totalItems;
  const artifacts = collectToolArtifacts(pendingItem.name, rawOutput);
  const devShellExecPatch = buildDevShellExecStatePatch({
    runId: input.runId,
    execState: asRecord(input.reactState.exec),
    decisionVerification: asRecord(input.reactState.decisionVerification),
    toolName: pendingItem.name,
    toolInput: pendingItem.input,
    toolOutput: rawOutput,
  });
  const reducerResult = applyReactStateEvent({
    reactState: input.reactState,
    event: {
      type: "tool_result_observed",
      stepIndex: input.stepIndex,
      toolName: pendingItem.name,
      toolInput: pendingItem.input,
      toolOutput: toolResult,
      toolCallId: pendingItem.toolCallId,
      inputHash: hashToolInput(pendingItem.name, pendingItem.input),
      workspaceRoot: readActiveWorkspaceRootFromExecState(asRecord(input.reactState.exec)),
    },
  });

  if (hasRemaining) {
    const postToolVerification = buildPostToolVerification({
      reactState: input.reactState,
      nextCapabilities: capabilityEvidence,
      output: rawOutput,
      toolName: pendingItem.name,
      action: input.reactState.nextAction,
      duplicateResult,
    });
    const lastActionResult = {
      kind: "tool_batch",
      status: "partial",
      ok: true,
      items: completedItems,
      chunk: {
        chunkIndex: nextPendingBatch.nextIndex,
        chunkSize: 1,
        totalChunks: totalItems,
        totalItems,
        remainingItems: totalItems - nextPendingBatch.nextIndex,
      },
    };
    const execPatch = {
      pendingAction: undefined,
      pendingEffectKey: undefined,
      pendingEffectType: undefined,
      pendingBatch: nextPendingBatch,
      ...(devShellExecPatch !== undefined ? devShellExecPatch : {}),
    };
    return createReferenceReactEffectCollectCheckpoint({
      reactState: reducerResult.reactState,
      currentStepAgent: input.acterStepId,
      nextStepAgent: input.acterStepId,
      stepIndex: input.stepIndex,
      activeRegion: input.activeRegion,
      phase: "ACT",
      artifacts,
      reactPatch: {
        postToolVerification,
        lastActionResult,
        ...buildRetryContextPatchAfterActionResult({
          reactState: reducerResult.reactState,
          action: input.reactState.nextAction,
          actionResult: lastActionResult,
        }),
        observations: appendToolObservation(reducerResult.reactState, {
          stepIndex: input.stepIndex,
          toolName: pendingItem.name,
          inputHash: hashToolInput(pendingItem.name, pendingItem.input),
          output: rawOutput,
          capabilityClasses,
          status: "partial",
        }),
        decisionTrace: [
          {
            eventType: "decision.executed",
            phase: "acter",
            decisionCode: "tool_batch.collect_durable",
            metadata: {
              toolName: pendingItem.name,
              remainingItems: totalItems - nextPendingBatch.nextIndex,
            },
          },
        ],
      },
      execPatch,
      regionReactPatch: {
        evidenceLedger: reducerResult.reactState.evidenceLedger,
        postToolVerification,
        lastActionResult,
        ...buildRetryContextPatchAfterActionResult({
          reactState: reducerResult.reactState,
          action: input.reactState.nextAction,
          actionResult: lastActionResult,
        }),
      },
      regionExecPatch: execPatch,
    });
  }

  return finalizeDurableToolBatch({
    runId: input.runId,
    stepIndex: input.stepIndex,
    pendingBatch: nextPendingBatch,
    reactState:
      devShellExecPatch === undefined
        ? reducerResult.reactState
        : withExecStatePatch(
            reducerResult.reactState,
            devShellExecPatch,
          ),
    activeRegion: input.activeRegion,
    currentStepAgent: input.acterStepId,
    loopStepId: input.loopStepId,
    toolCapabilityClassesByName: input.toolCapabilityClassesByName,
    duplicateLedger: advanceDuplicateLedger(input.duplicateLedger, duplicateResult, input.stepIndex),
    additionalArtifacts: artifacts,
    decisionTrace: [],
  });
}

function finalizeDurableToolBatch(input: {
  runId?: string | undefined;
  stepIndex: number;
  pendingBatch: PendingToolBatchState;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  currentStepAgent: string;
  loopStepId: string;
  toolCapabilityClassesByName: Record<string, string[]>;
  duplicateLedger: ReadonlyArray<ReadOnlyResultDuplicateLedgerEntry>;
  additionalArtifacts?: ArtifactIntent[] | undefined;
  decisionTrace?: Array<Record<string, unknown>> | undefined;
}) {
  const completedItems = input.pendingBatch.completedItems;
  const verificationItems = annotateVerificationBatchItems({
    items: completedItems,
    duplicateLedger: input.duplicateLedger,
    stepIndex: input.stepIndex,
  });
  const capabilityEvidence = completedItems.reduce(
    (acc, item) =>
      nextCapabilityEvidence(
        acc,
        [
          {
            toolName: item.name,
            classes: input.toolCapabilityClassesByName[item.name] ?? [item.name],
          },
        ],
        input.stepIndex,
      ),
    capabilityEvidenceFromAgentFeedback(input.reactState),
  );

  const postToolVerification = buildPostToolVerification({
    reactState: input.reactState,
    nextCapabilities: capabilityEvidence,
    output: {
      kind: "tool_batch",
      items: verificationItems,
      hasRemaining: false,
    },
    action: input.reactState.nextAction,
  });
  const execPatch = {
    pendingAction: undefined,
    pendingEffectKey: undefined,
    pendingEffectType: undefined,
    pendingBatch: undefined,
    pendingToolCall: undefined,
  };
  const lastActionResult = {
    kind: "tool_batch",
    status: "ok",
    ok: true,
    items: completedItems.map((item) => ({
      ...item,
      inputHash: hashToolInput(item.name, item.input),
      capabilityClasses: input.toolCapabilityClassesByName[item.name] ?? [item.name],
    })),
    chunk: {
      chunkIndex: completedItems.length,
      chunkSize: completedItems.length,
      totalChunks: completedItems.length,
      totalItems: completedItems.length,
      remainingItems: 0,
    },
  };
  return createReferenceReactEffectCollectCheckpoint({
    reactState: input.reactState,
    currentStepAgent: input.currentStepAgent,
    nextStepAgent: input.loopStepId,
    stepIndex: input.stepIndex,
    activeRegion: input.activeRegion,
    phase: "OBSERVE",
    artifacts: input.additionalArtifacts,
    reactPatch: {
      postToolVerification,
      lastActionResult,
      ...buildRetryContextPatchAfterActionResult({
        reactState: input.reactState,
        action: input.reactState.nextAction,
        actionResult: lastActionResult,
      }),
      observations: appendToolObservations(
        input.reactState,
        completedItems.map((item) => ({
          stepIndex: input.stepIndex,
          toolName: item.name,
          inputHash: hashToolInput(item.name, item.input),
          output: item.output,
          capabilityClasses: input.toolCapabilityClassesByName[item.name] ?? [item.name],
          reused: item.reused,
        })),
      ),
      decisionTrace: [
        ...(input.decisionTrace ?? []),
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: "tool_batch.collect_durable_complete",
        },
      ],
    },
    execPatch,
    regionReactPatch: {
      lastActionResult,
      ...buildRetryContextPatchAfterActionResult({
        reactState: input.reactState,
        action: input.reactState.nextAction,
        actionResult: lastActionResult,
      }),
    },
    regionExecPatch: execPatch,
  });
}

async function executeToolBatchChunk(input: {
  runId?: string | undefined;
  pendingBatch: PendingToolBatchState;
  checkpointSize: number;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  stepIndex: number;
  loopStepId: string;
  acterStepId: string;
  toolCapabilityClassesByName: Record<string, string[]>;
  toolApprovalCapabilitiesByName: Record<string, string[]>;
  toolExecutionClassByName: Record<string, "read_only" | "planning_write" | "sandboxed_only" | "external_side_effect">;
  toolAllowedInteractionModesByName: Record<string, Array<"chat" | "plan" | "build"> | undefined>;
  interactionMode: "chat" | "plan" | "build";
  actSubmode: "strict" | "safe" | "full_auto" | undefined;
  modeSystemV2Enabled: boolean;
  executionPolicy:
    | {
        toolClassPolicy?: Partial<Record<"read_only" | "planning_write" | "sandboxed_only" | "external_side_effect", boolean>> | undefined;
        capabilityPolicy?: Record<string, boolean> | undefined;
        approvalPolicy?: {
          strictApprovalPerCall?: boolean | undefined;
        } | undefined;
      }
    | undefined;
  duplicateLedger: ReadonlyArray<ReadOnlyResultDuplicateLedgerEntry>;
  io: StepIO;
}) {
  const normalizedCheckpointSize = normalizePositiveInt(
    input.pendingBatch.checkpointSize,
    normalizePositiveInt(input.checkpointSize, 5),
  );
  const totalItems = input.pendingBatch.items.length;
  const nextIndex = clampIndex(input.pendingBatch.nextIndex, totalItems);
  const chunkEnd = Math.min(totalItems, nextIndex + normalizedCheckpointSize);
  const chunk = input.pendingBatch.items.slice(nextIndex, chunkEnd);
  const chunkIndex = totalItems === 0 ? 1 : Math.floor(nextIndex / normalizedCheckpointSize) + 1;
  const totalChunks = totalItems === 0 ? 1 : Math.ceil(totalItems / normalizedCheckpointSize);
  const policyGate = checkToolBatchChunkPolicyGate({
    reactState: input.reactState,
    activeRegion: input.activeRegion,
    acterStepId: input.acterStepId,
    stepIndex: input.stepIndex,
    items: chunk,
    toolApprovalCapabilitiesByName: input.toolApprovalCapabilitiesByName,
    toolExecutionClassByName: input.toolExecutionClassByName,
    toolAllowedInteractionModesByName: input.toolAllowedInteractionModesByName,
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    modeSystemV2Enabled: input.modeSystemV2Enabled,
    executionPolicy: input.executionPolicy,
  });
  if (policyGate.kind === "blocked") {
    return policyGate.transition;
  }

  const chunkResults = await executeToolBatchItemsWithFilesystemReuse({
    chunk,
    reactState: input.reactState,
    stepIndex: input.stepIndex,
    toolExecutionClassByName: input.toolExecutionClassByName,
    io: input.io,
  });
  const toolResults = chunkResults.map((item) => ({
    ...item,
    toolResult: item.toolResult ??
      buildAgentToolSuccessResult({
        toolName: item.name,
        input: item.input,
        output: item.output,
      }),
  }));
  let filesystemInspectionCache: unknown[] | undefined;
  let cacheState = input.reactState;
  for (const [index, item] of toolResults.entries()) {
    const nextCache = applyFilesystemInspectionCacheAfterToolResult({
      reactState: cacheState,
      toolName: item.name,
      toolInput: item.input,
      toolOutput: item.output,
      stepIndex: input.stepIndex + index,
      inputHash: hashToolInput(item.name, item.input),
      executionClass: input.toolExecutionClassByName[item.name],
    });
    if (nextCache !== undefined) {
      filesystemInspectionCache = nextCache;
      cacheState = {
        ...cacheState,
        filesystemInspectionCache: nextCache,
      };
    }
  }
  const verificationItems = annotateVerificationBatchItems({
    items: toolResults.map((item) => ({
      name: item.name,
      input: item.input,
      output: item.output,
    })),
    duplicateLedger: input.duplicateLedger,
    stepIndex: input.stepIndex,
  });
  const artifactIntents = toolResults.flatMap((item) => [
    ...collectToolArtifacts(item.name, item.output),
  ]);

  const completedItems = [
    ...input.pendingBatch.completedItems,
    ...toolResults.map((item) => ({
      name: item.name,
      input: item.input,
      ...(item.toolCallId !== undefined ? { toolCallId: item.toolCallId } : {}),
      output: item.output,
      ...(item.reused === true ? { reused: true, cachedStepIndex: item.cachedStepIndex } : {}),
    })),
  ];
  const hasRemaining = chunkEnd < totalItems;
  const capabilityEvidence = nextCapabilityEvidence(
    capabilityEvidenceFromAgentFeedback(input.reactState),
    chunk.map((item) => ({
      toolName: item.name,
      classes: input.toolCapabilityClassesByName[item.name] ?? [item.name],
    })),
    input.stepIndex,
  );

  const nextPendingBatch = hasRemaining
    ? {
        items: input.pendingBatch.items,
        nextIndex: chunkEnd,
        completedItems,
        checkpointSize: normalizedCheckpointSize,
      }
    : undefined;
  const reducedReactState = toolResults.reduce<Record<string, unknown>>((state, item, index) => applyReactStateEvent({
      reactState: state,
      event: {
        type: "tool_result_observed",
        stepIndex: input.stepIndex + index,
        toolName: item.name,
        toolInput: item.input,
        toolOutput: item.toolResult,
        toolCallId: item.toolCallId,
        inputHash: hashToolInput(item.name, item.input),
        reused: item.reused,
        workspaceRoot: readActiveWorkspaceRootFromExecState(asRecord(state.exec)),
      },
    }).reactState, input.reactState);

  const postToolVerification = buildPostToolVerification({
    reactState: input.reactState,
    nextCapabilities: capabilityEvidence,
    output: {
      kind: "tool_batch",
      items: verificationItems,
      hasRemaining,
    },
    action: input.reactState.nextAction,
  });
  const lastActionResult = {
    kind: "tool_batch",
    status: hasRemaining ? "partial" : "ok",
    ok: true,
    items: hasRemaining
      ? toolResults.map((item) => ({
          name: item.name,
          inputHash: hashToolInput(item.name, item.input),
          capabilityClasses: input.toolCapabilityClassesByName[item.name] ?? [item.name],
          output: item.output,
          ...(item.reused === true ? { reused: true, cachedStepIndex: item.cachedStepIndex } : {}),
        }))
      : completedItems.map((item) => ({
          ...item,
          inputHash: hashToolInput(item.name, item.input),
          capabilityClasses: input.toolCapabilityClassesByName[item.name] ?? [item.name],
    })),
    chunk: {
      chunkIndex,
      chunkSize: toolResults.length,
      totalChunks,
      totalItems,
      remainingItems: Math.max(0, totalItems - chunkEnd),
    },
  };
  const execPatch = {
    pendingBatch: nextPendingBatch,
  };
  return createReferenceReactEffectCollectCheckpoint({
    reactState: reducedReactState,
    currentStepAgent: input.acterStepId,
    nextStepAgent: input.loopStepId,
    stepIndex: input.stepIndex,
    activeRegion: input.activeRegion,
    phase: "OBSERVE",
    artifacts: artifactIntents,
    reactPatch: {
      postToolVerification,
      lastActionResult,
      ...buildRetryContextPatchAfterActionResult({
        reactState: reducedReactState,
        action: input.reactState.nextAction,
        actionResult: lastActionResult,
      }),
      observations: appendToolObservations(
        reducedReactState,
        toolResults.map((item, index) => ({
          stepIndex: input.stepIndex + index,
          toolName: item.name,
          inputHash: hashToolInput(item.name, item.input),
          output: item.output,
          capabilityClasses: input.toolCapabilityClassesByName[item.name] ?? [item.name],
          status: hasRemaining ? "partial" : "ok",
          reused: item.reused,
        })),
      ),
      ...(filesystemInspectionCache !== undefined ? { filesystemInspectionCache } : {}),
      decisionTrace: [
        {
          eventType: "tool.chunk.started",
          phase: "acter",
          decisionCode: "tool_batch_chunk",
          metadata: {
            chunkIndex,
              chunkSize: toolResults.length,
            totalChunks,
            totalItems,
          },
        },
        {
          eventType: "tool.chunk.completed",
          phase: "acter",
          decisionCode: "tool_batch_chunk",
          metadata: {
            chunkIndex,
            chunkSize: toolResults.length,
            totalChunks,
            totalItems,
            remainingItems: Math.max(0, totalItems - chunkEnd),
          },
        },
        {
          eventType: "decision.executed",
          phase: "acter",
          decisionCode: hasRemaining ? "tool_batch.chunk" : "tool_batch",
          metadata: {
            chunkIndex,
            chunkSize: toolResults.length,
            totalChunks,
            totalItems,
            remainingItems: Math.max(0, totalItems - chunkEnd),
          },
        },
      ],
    },
    execPatch,
    regionReactPatch: {
      evidenceLedger: reducedReactState.evidenceLedger,
      postToolVerification,
      lastActionResult,
      ...buildRetryContextPatchAfterActionResult({
        reactState: reducedReactState,
        action: input.reactState.nextAction,
        actionResult: lastActionResult,
      }),
      ...(filesystemInspectionCache !== undefined ? { filesystemInspectionCache } : {}),
    },
    regionExecPatch: execPatch,
  });
}

async function executeToolBatchItemsWithFilesystemReuse(input: {
  reactState: Record<string, unknown>;
  stepIndex: number;
  chunk: Array<{ name: string; input: Record<string, unknown>; toolCallId?: string | undefined }>;
  toolExecutionClassByName: Record<string, "read_only" | "planning_write" | "sandboxed_only" | "external_side_effect">;
  io: StepIO;
}): Promise<Array<{
  name: string;
  input: Record<string, unknown>;
  toolCallId?: string | undefined;
  toolResult?: AgentToolResult | undefined;
  output: unknown;
  reused?: boolean | undefined;
  cachedStepIndex?: number | undefined;
}>> {
  if (
    input.chunk.some((item) =>
      isFilesystemInspectionToolName(item.name) ||
      isFilesystemInspectionCacheInvalidatingTool(item.name, input.toolExecutionClassByName[item.name])
    ) === false
  ) {
    return Promise.all(
      input.chunk.map(async (item) => executeToolBatchItem({
        reactState: input.reactState,
        item,
        io: input.io,
      })),
    );
  }

  const results: Array<{
    name: string;
    input: Record<string, unknown>;
    toolCallId?: string | undefined;
    toolResult?: AgentToolResult | undefined;
    output: unknown;
    reused?: boolean | undefined;
    cachedStepIndex?: number | undefined;
  }> = [];
  let cacheState = input.reactState;
  for (const [index, item] of input.chunk.entries()) {
    const toolClass = input.toolExecutionClassByName[item.name] ?? "read_only";
    if (toolClass === "read_only" && isFilesystemInspectionToolName(item.name)) {
      const reusable = findReusableFilesystemInspection({
        reactState: cacheState,
        toolName: item.name,
        toolInput: item.input,
      });
      if (reusable !== undefined) {
        results.push({
          name: item.name,
          input: item.input,
          ...(item.toolCallId !== undefined ? { toolCallId: item.toolCallId } : {}),
          output: reusable.output,
          reused: true,
          cachedStepIndex: reusable.stepIndex,
        });
        continue;
      }
    }

    const result = await executeToolBatchItem({
      reactState: input.reactState,
      item,
      io: input.io,
    });
    results.push(result);
    const nextCache = applyFilesystemInspectionCacheAfterToolResult({
      reactState: cacheState,
      toolName: item.name,
      toolInput: item.input,
      toolOutput: result.output,
      stepIndex: input.stepIndex + index,
      inputHash: hashToolInput(item.name, item.input),
      executionClass: toolClass,
    });
    if (nextCache !== undefined) {
      cacheState = {
        ...cacheState,
        filesystemInspectionCache: nextCache,
      };
    }
  }
  return results;
}

async function executeToolBatchItem(input: {
  reactState: Record<string, unknown>;
  item: { name: string; input: Record<string, unknown>; toolCallId?: string | undefined };
  io: StepIO;
}): Promise<{
  name: string;
  input: Record<string, unknown>;
  toolCallId?: string | undefined;
  toolResult?: AgentToolResult | undefined;
  output: unknown;
}> {
  try {
    const toolResult = await input.io.useTool!(input.item.name, input.item.input);
    return {
      name: input.item.name,
      input: input.item.input,
      ...(input.item.toolCallId !== undefined ? { toolCallId: input.item.toolCallId } : {}),
      toolResult,
      output: unwrapAgentToolOutput(toolResult),
    };
  } catch (error) {
    if (
      shouldContinueToolFailure({
        reactState: input.reactState,
        toolName: input.item.name,
        toolInput: input.item.input,
      })
    ) {
      const toolResult = buildAgentToolFailureResult({
        toolName: input.item.name,
        input: input.item.input,
        error,
      });
      return {
        name: input.item.name,
        input: input.item.input,
        ...(input.item.toolCallId !== undefined ? { toolCallId: input.item.toolCallId } : {}),
        toolResult,
        output: unwrapAgentToolOutput(toolResult),
      };
    }
    throw error;
  }
}

function ensureAgentToolResult(input: {
  toolName: string;
  toolInput: unknown;
  output: unknown;
  candidate?: unknown | undefined;
}): AgentToolResult {
  if (isAgentToolResult(input.candidate)) {
    return input.candidate;
  }
  const outputRecord = asRecord(input.output);
  if (asString(outputRecord?.status) === "FAILED") {
    return buildAgentToolFailedOutputResult({
      toolName: input.toolName,
      input: input.toolInput,
      output: input.output,
      error: {
        code: asString(outputRecord?.errorCode) ?? "TOOL_EXECUTION_FAILED",
        message: asString(outputRecord?.message) ?? "Tool execution failed.",
      },
    });
  }
  return buildAgentToolSuccessResult({
    toolName: input.toolName,
    input: input.toolInput,
    output: input.output,
  });
}

function resolveAutonomyPolicy(
  value: unknown,
  fallbackLevel: string | undefined,
): AutonomyPolicy | undefined {
  const record = asRecord(value);
  if (record === undefined && fallbackLevel === undefined) {
    return ;
  }
  const level = normalizeAutonomyLevel(asString(record?.level) ?? fallbackLevel ?? "L2");
  const base = defaultAutonomyPolicy(level);
  if (record === undefined) {
    return base;
  }
  const allowedActions = asArray(record.allowed_actions)
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined);
  const requiredEvidence = asArray(record.required_evidence)
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined);
  const mandatoryEscalations = asArray(record.mandatory_escalations)
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined);
  return {
    level,
    allowed_actions: allowedActions.length > 0 ? allowedActions : base.allowed_actions,
    required_evidence: requiredEvidence.length > 0 ? requiredEvidence : base.required_evidence,
    mandatory_escalations:
      mandatoryEscalations.length > 0 ? mandatoryEscalations : base.mandatory_escalations,
  };
}

function normalizeAutonomyLevel(value: string): AutonomyPolicy["level"] {
  if (value === "L0" || value === "L1" || value === "L2" || value === "L3" || value === "L4") {
    return value;
  }
  return "L2";
}

function collectAutonomyEvidence(reactState: Record<string, unknown>): string[] {
  const evidence = new Set<string>();
  const transcriptGoal = readActiveTaskGoalFromTranscript(reactState.modelTranscript);
  if (transcriptGoal !== undefined) {
    evidence.add("goal");
  }
  if (hasActiveRuntimePlanEvidence(reactState.plan)) {
    evidence.add("plan");
  }
  if (asArray(reactState.observations).length > 0 || reactState.lastActionResult !== undefined) {
    evidence.add("observation_or_tool_result");
  }
  if (Object.keys(capabilityEvidenceFromAgentFeedback(reactState)).length > 0) {
    evidence.add("capability_evidence");
  }
  return [...evidence];
}

function hasActiveRuntimePlanEvidence(value: unknown): boolean {
  const plan = asRecord(value);
  const status = asString(plan?.status);
  return (
    isPlanDocumentPath(asString(plan?.path)) &&
    (status === "approved" || status === "executing")
  );
}

function collectAutonomyRiskSignals(input: {
  toolClass: "read_only" | "planning_write" | "sandboxed_only" | "external_side_effect";
  decisionConfidence: number;
  missingCapabilities: string[];
}): string[] {
  const signals = new Set<string>();
  if (input.toolClass === "external_side_effect") {
    signals.add("external_side_effect");
  }
  if (input.decisionConfidence < 0.6) {
    signals.add("low_confidence");
  }
  if (input.missingCapabilities.length > 0) {
    signals.add("missing_capability");
  }
  return [...signals];
}

function readDecisionConfidence(reactState: Record<string, unknown>): number {
  return typeof reactState.decisionConfidence === "number" ? reactState.decisionConfidence : 1;
}

function readMissingCapabilities(reactState: Record<string, unknown>): string[] {
  return asArray(asRecord(reactState.decisionVerification)?.missingCapabilities)
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined);
}

function readExecutionPolicy(
  value: unknown,
):
  | {
      toolClassPolicy?: Partial<Record<"read_only" | "planning_write" | "sandboxed_only" | "external_side_effect", boolean>> | undefined;
      capabilityPolicy?: Record<string, boolean> | undefined;
      approvalPolicy?: {
        strictApprovalPerCall?: boolean | undefined;
      } | undefined;
    }
  | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }

  const toolClassPolicyRaw = asRecord(record.toolClassPolicy);
  const toolClassPolicy = toolClassPolicyRaw === undefined
    ? undefined
    : {
        ...(typeof toolClassPolicyRaw.read_only === "boolean"
          ? { read_only: toolClassPolicyRaw.read_only }
          : {}),
        ...(typeof toolClassPolicyRaw.planning_write === "boolean"
          ? { planning_write: toolClassPolicyRaw.planning_write }
          : {}),
        ...(typeof toolClassPolicyRaw.sandboxed_only === "boolean"
          ? { sandboxed_only: toolClassPolicyRaw.sandboxed_only }
          : {}),
        ...(typeof toolClassPolicyRaw.external_side_effect === "boolean"
          ? { external_side_effect: toolClassPolicyRaw.external_side_effect }
          : {}),
      };
  const capabilityPolicyRaw = asRecord(record.capabilityPolicy);
  const capabilityPolicy = capabilityPolicyRaw === undefined
    ? undefined
    : {
        ...(typeof capabilityPolicyRaw["workspace.read"] === "boolean"
          ? { "workspace.read": capabilityPolicyRaw["workspace.read"] }
          : {}),
        ...(typeof capabilityPolicyRaw["workspace.write"] === "boolean"
          ? { "workspace.write": capabilityPolicyRaw["workspace.write"] }
          : {}),
        ...(typeof capabilityPolicyRaw["shell.exec"] === "boolean"
          ? { "shell.exec": capabilityPolicyRaw["shell.exec"] }
          : {}),
        ...(typeof capabilityPolicyRaw["project.board.write"] === "boolean"
          ? { "project.board.write": capabilityPolicyRaw["project.board.write"] }
          : {}),
        ...(typeof capabilityPolicyRaw["project.task_queue.write"] === "boolean"
          ? { "project.task_queue.write": capabilityPolicyRaw["project.task_queue.write"] }
          : {}),
        ...(typeof capabilityPolicyRaw["network.call"] === "boolean"
          ? { "network.call": capabilityPolicyRaw["network.call"] }
          : {}),
        ...(typeof capabilityPolicyRaw["code.execute"] === "boolean"
          ? { "code.execute": capabilityPolicyRaw["code.execute"] }
          : {}),
        ...(typeof capabilityPolicyRaw["mcp.invoke"] === "boolean"
          ? { "mcp.invoke": capabilityPolicyRaw["mcp.invoke"] }
          : {}),
        ...(typeof capabilityPolicyRaw["delegation.control"] === "boolean"
          ? { "delegation.control": capabilityPolicyRaw["delegation.control"] }
          : {}),
      };
  const approvalPolicyRaw = asRecord(record.approvalPolicy);
  const approvalPolicy = approvalPolicyRaw === undefined
    ? undefined
    : {
        ...(typeof approvalPolicyRaw.strictApprovalPerCall === "boolean"
          ? { strictApprovalPerCall: approvalPolicyRaw.strictApprovalPerCall }
          : {}),
      };

  if (
    toolClassPolicy === undefined &&
    capabilityPolicy === undefined &&
    approvalPolicy === undefined
  ) {
    return ;
  }

  return {
    ...(toolClassPolicy !== undefined ? { toolClassPolicy } : {}),
    ...(capabilityPolicy !== undefined ? { capabilityPolicy } : {}),
    ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
  };
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function withRegionPatch(
  reactPatch: Record<string, unknown>,
  region: string | undefined,
  regionPatch: Record<string, unknown>,
): Record<string, unknown> {
  if (region === undefined || region.trim().length === 0) {
    return {
      agent: reactPatch,
    };
  }

  return {
    agent: reactPatch,
    regions: {
      [region]: regionPatch,
    },
  };
}

function readCompiledAction(value: unknown): ReactAction | undefined {
  const validation = validateCompiledNextAction(value);
  if (validation.ok) {
    return validation.action;
  }
  if (validation.failure.details.reason === "missing_compiled_next_action") {
    return ;
  }
  throw createActerInvalidCompiledActionError(validation.failure);
}

function normalizeCompiledAction(
  action: ReactAction | undefined,
  workspaceRoot: string | undefined,
): ReactAction | undefined {
  if (action === undefined) {
    return ;
  }
  if (action.kind === "effect" && isModelVisibleExecutableActionId(action.type) === false) {
    throw createRuntimeFailure(
      "AGENT_EXECUTABLE_ACTION_INVALID",
      `Action '${action.type}' is not a registered executable action.`,
      {
        subsystem: "react",
        step: "agent.exec.dispatch",
        classification: "schema",
        recoverable: false,
        actionId: action.type,
      },
    );
  }
  if (action.kind === "tool") {
    return {
      ...action,
      input: normalizeToolActionInput(action.name, action.input, workspaceRoot),
    };
  }
  if (action.kind === "tool_batch") {
    return {
      ...action,
      items: action.items.map((item) => ({
        ...item,
        input: normalizeToolActionInput(item.name, item.input, workspaceRoot),
      })),
    };
  }
  return action;
}

function readActiveWorkspaceRootFromExecState(execState: Record<string, unknown> | undefined): string | undefined {
  const devShell = asRecord(execState?.devShell);
  const workspaceRoot = asString(devShell?.workspaceRoot)?.trim();
  if (workspaceRoot !== undefined) {
    return workspaceRoot;
  }
  const devShellProcessRecord = asRecord(asRecord(devShell)?.processes);
  if (devShellProcessRecord !== undefined) {
    const workspaceRoots = Object.values(devShellProcessRecord)
      .map((process) => asRecord(process))
      .map((process) => asString(process?.workspaceRoot)?.trim())
      .filter((value): value is string => value !== undefined);
    if (workspaceRoots.length > 0) {
      return workspaceRoots[0];
    }
  }
  const lastCommand = asRecord(asRecord(devShell)?.lastCommand);
  return asString(lastCommand?.workspaceRoot)?.trim() ?? asString(lastCommand?.cwd)?.trim();
}

function buildPendingExecutableActionState(input: {
  actionId: string;
  idempotencyKey: string;
}): Record<string, unknown> {
  return {
    kind: "effect",
    actionId: input.actionId,
    idempotencyKey: input.idempotencyKey,
  };
}

function readPendingExecutableAction(
  value: unknown,
): { kind: "effect"; actionId: string; idempotencyKey: string } | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }
  const kind = asString(record.kind);
  const actionId = asString(record.actionId);
  const idempotencyKey = asString(record.idempotencyKey);
  if (kind !== "effect" || actionId === undefined || idempotencyKey === undefined) {
    return ;
  }
  if (isModelVisibleExecutableActionId(actionId) === false) {
    throw createRuntimeFailure(
      "AGENT_PENDING_ACTION_INVALID",
      `Pending executable action '${actionId}' is not registered.`,
      {
        subsystem: "react",
        step: "agent.exec.collect",
        classification: "schema",
        recoverable: false,
        actionId,
      },
    );
  }
  return {
    kind: "effect",
    actionId,
    idempotencyKey,
  };
}

function toPendingExecutableActionRecord(input: {
  kind: "effect";
  actionId: string;
  idempotencyKey: string;
}): Record<string, unknown> {
  return {
    kind: input.kind,
    actionId: input.actionId,
    idempotencyKey: input.idempotencyKey,
  };
}

function readPendingToolBatch(value: unknown): PendingToolBatchState | undefined {
  const record = asRecord(value);
  const items = asArray(record?.items)
    .map((entry) => {
      const item = asRecord(entry);
      const name = asString(item?.name);
      const rawInput = asRecord(item?.input);
      if (name === undefined || rawInput === undefined) {
        return ;
      }
      const toolCallId = asString(item?.toolCallId);
      return {
        name,
        input: rawInput,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  if (items.length === 0) {
    return ;
  }

  const nextIndex = normalizeNonNegativeInt(record?.nextIndex, 0);
  const checkpointSize = normalizePositiveInt(record?.checkpointSize, 5);
  const completedItems = asArray(record?.completedItems)
    .map((entry) => {
      const item = asRecord(entry);
      const name = asString(item?.name);
      const rawInput = asRecord(item?.input);
      if (name === undefined || rawInput === undefined) {
        return ;
      }
      const toolCallId = asString(item?.toolCallId);
      return {
        name,
        input: rawInput,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        output: item?.output,
        ...(item?.reused === true ? { reused: true } : {}),
        ...(typeof item?.cachedStepIndex === "number" && Number.isFinite(item.cachedStepIndex)
          ? { cachedStepIndex: Math.trunc(item.cachedStepIndex) }
          : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined);

  return {
    items,
    nextIndex,
    completedItems,
    checkpointSize,
    executionMode:
      record?.executionMode === "durable" || record?.executionMode === "inline"
        ? record.executionMode
        : undefined,
    pendingItem: (() => {
      const pending = asRecord(record?.pendingItem);
      const name = asString(pending?.name);
      const input = asRecord(pending?.input);
      const idempotencyKey = asString(pending?.idempotencyKey);
      if (name === undefined || input === undefined || idempotencyKey === undefined) {
        return ;
      }
      const toolCallId = asString(pending?.toolCallId);
      return {
        name,
        input,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        idempotencyKey,
      };
    })(),
  };
}

function resolveToolBatchCheckpointSize(
  eventPayload: Record<string, unknown> | undefined,
  reactState: Record<string, unknown>,
): number {
  const fromEvent = normalizePositiveInt(eventPayload?.toolBatchCheckpointSize, undefined);
  if (fromEvent !== undefined) {
    return fromEvent;
  }
  const fromState = normalizePositiveInt(reactState.toolBatchCheckpointSize, undefined);
  if (fromState !== undefined) {
    return fromState;
  }
  return 5;
}

function normalizePositiveInt(value: unknown, fallback: number): number;
function normalizePositiveInt(value: unknown, fallback: number | undefined): number | undefined;
function normalizePositiveInt(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clampIndex(value: number, max: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function buildDurableToolIdempotencyKey(
  sessionId: string,
  runId: string,
  stepIndex: number,
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const inputHash = createHash("sha256")
    .update(stableStringify(toolInput))
    .digest("hex")
    .slice(0, 16);
  return `${sessionId}:${runId}:${stepIndex}:${toolName}:${inputHash}`;
}

function compactToolInputForDecision(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const keysByTool: Record<string, string[]> = {
    "fs.list": ["path", "recursive", "includeHidden", "maxDepth"],
    "fs.read_text": ["path", "maxBytes"],
    "fs.search_text": ["path", "query", "glob", "caseSensitive", "maxResults", "maxPreviewChars", "maxTotalPreviewChars"],
    "repo.trace": ["path", "seeds", "includeGlobs", "excludeGlobs", "maxResults", "contextLines"],
    "fs.write_text": ["path"],
    "fs.replace_text": ["path", "find", "replace", "all"],
    "exec_command": ["command", "cwd", "workspaceRoot", "sessionId", "stdin", "stop", "yieldTimeMs", "timeoutMs", "maxOutputBytes"],
    "dev.shell.run": ["command", "cwd", "workspaceRoot", "timeoutMs", "maxOutputBytes"],
    "dev.process.start": ["command", "cwd", "workspaceRoot", "yieldTimeMs", "maxOutputBytes"],
    "dev.process.read": ["processId", "cursor", "waitMs", "maxBytes"],
    "dev.process.write": ["processId", "data"],
    "dev.process.write_and_read": ["processId", "data", "cursor", "waitMs", "maxBytes"],
    "dev.process.stop": ["processId", "signal", "cursor", "waitMs", "maxBytes"],
  };
  const keys = keysByTool[toolName];
  if (keys === undefined) {
    return ;
  }
  const compact: Record<string, unknown> = {};
  for (const key of keys) {
    if (input[key] !== undefined) {
      compact[key] = compactDecisionToolInputValue(toolName, key, input[key]);
      if (typeof input[key] === "string" && typeof compact[key] === "string" && input[key].length > compact[key].length) {
        compact[`${key}Truncated`] = true;
      }
    }
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function compactDecisionToolInputValue(
  toolName: string,
  key: string,
  value: unknown,
): unknown {
  if (
    toolName === "fs.replace_text" &&
    (key === "find" || key === "replace") &&
    typeof value === "string"
  ) {
    return value.length <= 1000 ? value : `${value.slice(0, 997)}...`;
  }
  return value;
}

function safeSerialize(value: unknown): string {
  try {
    return stableStringify(value);
  } catch {
    return stringifySanitizedJson({ value: sanitizeUtf16String(String(value)) });
  }
}

function stableStringify(value: unknown): string {
  return stringifySanitizedJson(sortValue(sanitizeJsonValue(value)));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}

function summarizeText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripDevShellCompletionMarkers(value: string): string {
  const cleaned = value
    .split(/\r?\n/u)
    .filter((line) => /^__KESTREL_CMD_DONE__:([^:\s]+):(-?\d+)$/u.test(line.trim()) === false)
    .join("\n")
    .trimEnd();
  return cleaned;
}

function isDevShellArtifactValidationCommand(command: string | undefined): boolean {
  if (command === undefined) {
    return false;
  }
  return command.includes("artifact_exists:%s") && command.includes("artifact_missing:%s");
}

function readDevShellArtifactValidation(input: {
  command: string | undefined;
  chunk: string | undefined;
  lastControllerCommand: string | undefined;
}): Record<string, unknown> | undefined {
  if (
    isDevShellArtifactValidationCommand(input.command) === false ||
    input.chunk === undefined ||
    input.lastControllerCommand === undefined
  ) {
    return ;
  }
  const lines = input.chunk.split(/\r?\n/u);
  const markerIndex = lines.findIndex(
    (line) => line.startsWith("artifact_exists:") || line.startsWith("artifact_missing:"),
  );
  if (markerIndex < 0) {
    return ;
  }
  const marker = lines[markerIndex] ?? "";
  const exists = marker.startsWith("artifact_exists:");
  const artifactPath = marker.slice(marker.indexOf(":") + 1).trim();
  if (artifactPath.length === 0) {
    return ;
  }
  let byteCount: number | undefined;
  let contentLines: string[] = [];
  if (exists) {
    const wcLine = lines[markerIndex + 1] ?? "";
    const byteMatch = wcLine.match(/^\s*(\d+)\s+/u);
    if (byteMatch?.[1] !== undefined) {
      byteCount = Number.parseInt(byteMatch[1], 10);
    }
    contentLines = lines.slice(markerIndex + 2);
    const doneIndex = contentLines.findIndex((line) => line.startsWith("__KESTREL_CMD_DONE__:"));
    if (doneIndex >= 0) {
      contentLines = contentLines.slice(0, doneIndex);
    }
    while (contentLines.length > 0 && (contentLines[contentLines.length - 1] ?? "").length === 0) {
      contentLines.pop();
    }
  }
  const content = contentLines.join("\n");
  return {
    version: "v1",
    artifactPath,
    exists,
    lastControllerCommand: input.lastControllerCommand,
    ...(byteCount !== undefined && Number.isFinite(byteCount) ? { byteCount } : {}),
    ...(exists ? { contentHash: hashString(content), contentPreview: summarizeText(content, 400) } : {}),
  };
}

function hydrateToolInputFromExecState(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  execState: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  if (isDevShellLifecycleTool(input.toolName) === false) {
    return input.toolInput;
  }

  const devShell = asRecord(input.execState?.devShell);
  if (devShell === undefined) {
    return input.toolInput;
  }

  let changed = false;
  const nextInput: Record<string, unknown> = {
    ...input.toolInput,
  };
  const workspaceRoot = asString(devShell.workspaceRoot);

  if (
    (input.toolName === "exec_command" || input.toolName === "dev.shell.run" || input.toolName === "dev.process.start") &&
    asString(nextInput.workspaceRoot) === undefined &&
    workspaceRoot !== undefined
  ) {
    nextInput.workspaceRoot = workspaceRoot;
    changed = true;
  }

  return changed ? nextInput : input.toolInput;
}

function withActionExecutionRoleMetadata(
  toolInput: Record<string, unknown>,
  executionRole: unknown,
): Record<string, unknown> {
  return executionRole !== undefined
    ? {
        ...toolInput,
        executionRole,
      }
    : toolInput;
}

function maybeBuildRequiredActiveDevShellReadAction(input: {
  reactState: Record<string, unknown>;
  toolName: string;
}): { kind: "tool"; name: "dev.process.read"; input: Record<string, unknown> } | undefined {
  if (
    (input.toolName.startsWith("dev.shell.") === false && input.toolName.startsWith("dev.process.") === false) ||
    input.toolName === "dev.process.read"
  ) {
    return ;
  }
  void input;
  return ;
}

function maybeRedirectActiveDevShellExecAtDispatch(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  interactionMode: "chat" | "plan" | "build";
  config: ActerStepConfig;
  toolName: string;
  toolInput: Record<string, unknown>;
}): Transition | undefined {
  void input;
  return ;
}

function maybeRedirectSettledDevShellPollingAtDispatch(input: {
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  interactionMode: "chat" | "plan" | "build";
  config: ActerStepConfig;
  toolName: string;
  toolInput: Record<string, unknown>;
}): Transition | undefined {
  void input;
  return ;
}

function buildDevShellExecStatePatch(input: {
  runId: string;
  execState: Record<string, unknown> | undefined;
  decisionVerification?: Record<string, unknown> | undefined;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
}): Record<string, unknown> | undefined {
  if (isDevShellLifecycleTool(input.toolName) === false) {
    return ;
  }
  const current = asRecord(input.execState?.devShell);
  const output = asRecord(input.toolOutput);
  const lifecycle = normalizeDevShellLifecycle(input.toolName, input.toolInput, output);
  if (lifecycle === undefined) {
    return ;
  }
  const next: Record<string, unknown> = {
    ...(current ?? {}),
  };
  const commandRole = deriveCommandExecutionRole({
    toolName: input.toolName,
    toolInput: input.toolInput,
  })?.effective;
  const helperFailureRole =
    isHelperFailureCommandRole(commandRole?.role) &&
    helperCommandRoleHasConcreteTarget(commandRole);
  const helperLifecycleMode = helperFailureRole;
  const requiredArtifact = undefined;
  const processId = lifecycle.processId ?? asString(output?.processId) ?? asString(input.toolInput.processId);
  const status = lifecycle.status ?? asString(output?.status);
  const workspaceFromInput = asString(input.toolInput.workspaceRoot);
  if (workspaceFromInput !== undefined) {
    next.workspaceRoot = workspaceFromInput;
  }
  if (processId !== undefined) {
    next.processId = processId;
  }
  if (status !== undefined) {
    next.status = status;
  }
  if (lifecycle.kind === "start") {
    const commandContext = normalizeDevShellCommandContext(input.toolInput);
    if (commandContext !== undefined) {
      next.lastCommand = commandContext;
      const commandText = asString(commandContext.command)?.trim();
      if (commandText !== undefined && commandText.length > 0) {
        next.recentCommands = appendRecentDevShellCommand(
          readDevShellRecentCommands(current?.recentCommands),
          commandText,
        );
      }
    }
    const exitCode = asPositiveNumber(output?.exitCode);
    if (helperLifecycleMode && helperFailureRole && (status === "FAILED" || (exitCode !== undefined && exitCode !== 0))) {
      next.helperOutcome = {
        status: "failed_runtime",
        summary: extractDevShellErrorPreview(stripDevShellCompletionMarkers(asString(output?.text) ?? asString(output?.chunk) ?? "")) ??
          "Helper command failed during execution.",
        ...(processId !== undefined ? { processId } : {}),
        ...(asString(commandContext?.command) !== undefined ? { command: asString(commandContext?.command) } : {}),
        ...(requiredArtifact !== undefined ? { artifactTarget: requiredArtifact } : {}),
        remainingWork: "Choose the next evidence or derivation tactic from exact error evidence.",
        nextSuggestedAction: "replan",
      };
      next.helperFailure = mergeDevShellHelperFailure(
        asRecord(current?.helperFailure),
        buildDevShellHelperFailure({
        commandContext: commandContext ?? normalizeDevShellCommandContext(output),
        output,
        exitCode,
        }),
        requiredArtifact,
      );
      delete next.helperStall;
    } else if (helperLifecycleMode && status === "COMPLETED" && exitCode === 0) {
      delete next.helperFailure;
      next.helperOutcome = {
        status: "completed_incomplete",
        summary: requiredArtifact !== undefined
          ? `Helper command exited successfully, but required artifact ${requiredArtifact} still needs explicit completion or verification evidence.`
          : "Helper command exited successfully, but helper job completion still needs explicit evidence.",
        ...(processId !== undefined ? { processId } : {}),
        ...(asString(commandContext?.command) !== undefined ? { command: asString(commandContext?.command) } : {}),
        ...(requiredArtifact !== undefined ? { artifactTarget: requiredArtifact } : {}),
        ...(readDevShellChunkBytes(output) > 0 ? { progressEvidence: summarizeText(asString(output?.text) ?? asString(output?.chunk) ?? "", 600) } : {}),
        remainingWork: "Judge helper output and artifact evidence before verifying or continuing; exit 0 alone is not job completion.",
        nextSuggestedAction: "replan",
      };
      if (devShellRequiredArtifactKnownToExist(next, requiredArtifact) || readDevShellChunkBytes(output) > 0) {
        delete next.helperStall;
      }
    } else if (status === "COMPLETED" && exitCode === 0) {
      delete next.helperFailure;
      delete next.helperStall;
    }
  }
  if (lifecycle.kind === "write") {
    const chars = lifecycle.stdin ?? asString(input.toolInput.data) ?? asString(input.toolInput.input) ?? asString(input.toolInput.chars);
    if (chars !== undefined) {
      next.lastProcessInput = {
        chars,
        ...(processId !== undefined ? { processId } : {}),
      };
    }
  }
  if (processId !== undefined) {
    const currentProcesses = asRecord(current?.processes) ?? {};
    const currentProcess = asRecord(currentProcesses[processId]) ?? {};
    const commandContext =
      normalizeDevShellCommandContext(output) ??
      (lifecycle.kind === "start" ? normalizeDevShellCommandContext(input.toolInput) : undefined) ??
      normalizeDevShellCommandContext(currentProcess) ??
      normalizeDevShellCommandContext(current?.lastCommand);
    const chunkBytes = readDevShellChunkBytes(output);
    const lastInput = asRecord(next.lastProcessInput);
    const lastStdin =
      asString(lastInput?.processId) === processId
        ? asString(lastInput?.chars)
        : undefined;
    const processRecord: Record<string, unknown> = {
      ...currentProcess,
      processId,
      ...(lifecycle.kind === "start" ? { ownerRunId: input.runId } : {}),
      ...(asString(commandContext?.command) !== undefined ? { command: asString(commandContext?.command) } : {}),
      ...(asString(commandContext?.cwd) !== undefined ? { cwd: asString(commandContext?.cwd) } : {}),
      ...(asString(commandContext?.workspaceRoot) !== undefined ? { workspaceRoot: asString(commandContext?.workspaceRoot) } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(asString(output?.submittedAt) !== undefined ? { submittedAt: asString(output?.submittedAt) } : {}),
      ...(asString(output?.startedAt) !== undefined ? { startedAt: asString(output?.startedAt) } : {}),
      ...(asString(output?.updatedAt) !== undefined ? { updatedAt: asString(output?.updatedAt) } : {}),
      ...(asString(output?.completedAt) !== undefined ? { completedAt: asString(output?.completedAt) } : {}),
      ...(typeof output?.exitCode === "number" ? { exitCode: Math.trunc(output.exitCode) } : {}),
      ...(output?.truncated === true ? { truncated: true } : {}),
      chunkBytes,
      ...(lastStdin !== undefined ? { lastStdinPreview: summarizeText(lastStdin, 240) } : {}),
      ...(lastStdin !== undefined ? { lastStdinAt: asString(output?.updatedAt) ?? new Date().toISOString() } : {}),
    };
    next.processes = {
      ...currentProcesses,
      [processId]: processRecord,
    };
    if (helperLifecycleMode && readDevShellChunkBytes(output) > 0) {
      delete next.helperStall;
    }
    if (
      helperLifecycleMode &&
      input.toolName === "dev.process.read" &&
      status === "RUNNING" &&
      chunkBytes === 0 &&
      devShellRequiredArtifactKnownToExist(next, requiredArtifact) === false
    ) {
      const helperStall = buildDevShellHelperStall({
        processId,
        processRecord,
        requiredArtifact,
        output,
      });
      next.helperOutcome = {
        status: "stalled",
        summary: "Process produced no output on read and no artifact proof is known.",
        ...(processId !== undefined ? { processId } : {}),
        ...(asString(helperStall.command) !== undefined ? { command: asString(helperStall.command) } : {}),
        ...(requiredArtifact !== undefined ? { artifactTarget: requiredArtifact } : {}),
        remainingWork: "Stop, collect different evidence, or replan the evidence tactic; do not turn silence into a helper workflow phase.",
        nextSuggestedAction: "stop_process",
      };
      delete next.helperStall;
    }
  }
  if (
    lifecycle.kind === "read" ||
    lifecycle.kind === "write" ||
    lifecycle.kind === "start"
  ) {
    next.lastReadTruncated = output?.truncated === true;
    const chunkBytes = readDevShellChunkBytes(output);
    if (chunkBytes > 0) {
      next.lastNonEmptyReadChunkBytes = chunkBytes;
    }
    next.lastReadNoProgress = chunkBytes === 0;
  }
  const liveProcessIds = new Set(readDevShellLiveProcessIds(current?.liveProcessIds));
  if (status === "RUNNING" && processId !== undefined) {
    liveProcessIds.add(processId);
    if (liveProcessIds.size === 1) {
      next.activeProcessId = processId;
    } else {
      delete next.activeProcessId;
    }
    next.liveProcessIds = [...liveProcessIds];
    next.lastCommandLifecycle = "active_streaming";
  } else {
    if (processId !== undefined) {
      liveProcessIds.delete(processId);
    }
    if (liveProcessIds.size === 1) {
      next.activeProcessId = [...liveProcessIds][0];
    } else {
      delete next.activeProcessId;
    }
    next.liveProcessIds = [...liveProcessIds];
    next.lastCommandLifecycle = status === "COMPLETED" ? "settled_terminal" : "settled_nonterminal";
    const exitCode = asPositiveNumber(output?.exitCode);
    if (exitCode !== undefined) {
      next.lastCompletedExitCode = exitCode;
    }
  }
  delete next.activeShellSessionId;
  delete next.lastCommandId;
  delete next.activeInputCount;
  delete next.foregroundLease;
  delete next.statefulInteraction;

  return {
    devShell: next,
  };
}

function sourcePathMatches(candidatePath: string | undefined, sourcePath: string): boolean {
  const normalize = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) {
      return ;
    }
    return trimmed
      .replace(/\\/gu, "/")
      .replace(/\/+/gu, "/")
      .replace(/^\.\//u, "")
      .replace(/\/\.\//gu, "/");
  };
  const candidate = normalize(candidatePath);
  const expected = normalize(sourcePath);
  if (candidate === undefined || expected === undefined) {
    return false;
  }
  return candidate === expected ||
    candidate.endsWith(`/${expected}`) ||
    expected.endsWith(`/${candidate}`);
}

function buildDevShellHelperStall(input: {
  processId: string;
  processRecord: Record<string, unknown>;
  requiredArtifact: string | undefined;
  output: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const command = asString(input.processRecord.command);
  return {
    processId: input.processId,
    ...(command !== undefined ? { command } : {}),
    ...(asString(input.processRecord.cwd) !== undefined ? { cwd: asString(input.processRecord.cwd) } : {}),
    ...(asString(input.processRecord.workspaceRoot) !== undefined
      ? { workspaceRoot: asString(input.processRecord.workspaceRoot) }
      : {}),
    ...(inferHelperSourcePath(command) !== undefined ? { sourcePath: inferHelperSourcePath(command) } : {}),
    ...(input.requiredArtifact !== undefined ? { requiredArtifact: input.requiredArtifact } : {}),
    ...(asString(input.processRecord.startedAt) !== undefined ? { startedAt: asString(input.processRecord.startedAt) } : {}),
    lastReadAt:
      asString(input.output?.updatedAt) ??
      asString(input.output?.submittedAt) ??
      new Date().toISOString(),
    lastChunkBytes: 0,
    reason: "no_output_after_read",
    correction: "stop_or_replan_helper",
  };
}

function buildDevShellHelperFailure(input: {
  commandContext: Record<string, unknown> | undefined;
  output: Record<string, unknown> | undefined;
  exitCode: number | undefined;
}): Record<string, unknown> {
  const command = asString(input.commandContext?.command);
  const chunk = stripDevShellCompletionMarkers(asString(input.output?.text) ?? asString(input.output?.chunk) ?? "");
  const errorPreview = extractDevShellErrorPreview(chunk);
  return {
    ...(command !== undefined ? { command } : {}),
    ...(asString(input.commandContext?.cwd) !== undefined ? { cwd: asString(input.commandContext?.cwd) } : {}),
    ...(asString(input.commandContext?.workspaceRoot) !== undefined
      ? { workspaceRoot: asString(input.commandContext?.workspaceRoot) }
      : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(inferHelperSourcePath(command) !== undefined ? { sourcePath: inferHelperSourcePath(command) } : {}),
    ...(errorPreview !== undefined ? { errorPreview } : {}),
  };
}

function buildDevShellHelperFailureFromStall(stall: Record<string, unknown>): Record<string, unknown> {
  const requiredArtifact = asString(stall.requiredArtifact);
  return {
    ...(asString(stall.command) !== undefined ? { command: asString(stall.command) } : {}),
    ...(asString(stall.cwd) !== undefined ? { cwd: asString(stall.cwd) } : {}),
    ...(asString(stall.workspaceRoot) !== undefined ? { workspaceRoot: asString(stall.workspaceRoot) } : {}),
    ...(asString(stall.sourcePath) !== undefined ? { sourcePath: asString(stall.sourcePath) } : {}),
    ...(requiredArtifact !== undefined ? { requiredArtifact } : {}),
    errorPreview: [
      "Helper/controller process stalled with no output after read.",
      requiredArtifact !== undefined ? `The required artifact is not known to exist: ${requiredArtifact}.` : undefined,
      "Stop any still-live helper process, then repair or replace the helper source before rerunning it.",
    ]
      .filter((line): line is string => line !== undefined)
      .join(" "),
  };
}

function mergeDevShellHelperFailure(
  prior: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  requiredArtifact: string | undefined,
): Record<string, unknown> {
  return {
    ...next,
    ...(asString(next.sourcePath) === undefined && asString(prior?.sourcePath) !== undefined
      ? { sourcePath: asString(prior?.sourcePath) }
      : {}),
    ...(asString(next.errorPreview) === undefined && asString(prior?.errorPreview) !== undefined
      ? { errorPreview: asString(prior?.errorPreview) }
      : {}),
    ...(requiredArtifact !== undefined ? { requiredArtifact } : asString(prior?.requiredArtifact) !== undefined
      ? { requiredArtifact: asString(prior?.requiredArtifact) }
      : {}),
  };
}

function extractDevShellErrorPreview(chunk: string): string | undefined {
  const lines = chunk
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return ;
  }
  const relevant = lines.filter((line) =>
    /(?:traceback|error|exception|failed|not found|can't open file|syntaxerror|nameerror|runtimeerror|file ".*", line \d+)/iu.test(line),
  );
  const selected = relevant.length > 0 ? relevant : lines.slice(-12);
  return summarizeText(selected.slice(-12).join("\n"), 1200);
}

function inferHelperSourcePath(command: string | undefined): string | undefined {
  if (command === undefined) {
    return ;
  }
  const interpreterMatch = command.match(/(?:^|[\s;&|])(?:python(?:3(?:\.\d+)?)?|node|tsx|ts-node|bash|sh|ruby|go\s+run|cargo\s+run\s+--bin)\s+(['"]?)([^\s'";&|]+\.(?:py|js|jsx|ts|tsx|mjs|cjs|sh|rb|go|rs))\1/u);
  if (interpreterMatch?.[2] !== undefined) {
    return interpreterMatch[2];
  }
  const executableScriptMatch = command.match(/^\s*(?:env\s+)?(['"]?)(\.?\/?[^\s'";&|]+\.(?:py|js|jsx|ts|tsx|mjs|cjs|sh|rb|go|rs))\1(?:\s|$)/u);
  return executableScriptMatch?.[2];
}

function devShellRequiredArtifactKnownToExist(
  devShell: Record<string, unknown>,
  requiredArtifact: string | undefined,
): boolean {
  if (requiredArtifact === undefined) {
    return false;
  }
  const validation =
    asRecord(devShell.artifactValidation) ??
    asRecord(devShell.lastArtifactValidation) ??
    asRecord(devShell.requiredArtifactValidation);
  if (validation === undefined) {
    return false;
  }
  return validation.exists === true && asString(validation.artifactPath) === requiredArtifact;
}

function readDevShellChunkBytes(record: Record<string, unknown> | undefined): number {
  const chunkBytes =
    typeof record?.chunkBytes === "number" && Number.isFinite(record.chunkBytes)
      ? Math.max(0, Math.trunc(record.chunkBytes))
      : undefined;
  if (chunkBytes !== undefined) {
    return chunkBytes;
  }
  const chunk = asString(record?.text) ?? asString(record?.chunk) ?? asString(record?.output) ?? "";
  return Buffer.byteLength(chunk, "utf8");
}

function preservePriorDevShellReadEvidence(input: {
  toolName: string;
  currentStoredOutput: unknown;
  verificationOutput: unknown;
  priorLastActionResult: unknown;
  currentExecState: Record<string, unknown> | undefined;
}): {
  storedOutput: unknown;
  reusedPriorActionableOutput: boolean;
} {
  if (input.toolName !== "dev.process.read") {
    return {
      storedOutput: input.currentStoredOutput,
      reusedPriorActionableOutput: false,
    };
  }
  const verificationOutput = asRecord(input.verificationOutput);
  if (verificationOutput === undefined) {
    return {
      storedOutput: input.currentStoredOutput,
      reusedPriorActionableOutput: false,
    };
  }
  if (asString(verificationOutput.processId) !== undefined && asString(verificationOutput.status) === "RUNNING") {
    return {
      storedOutput: input.currentStoredOutput,
      reusedPriorActionableOutput: false,
    };
  }
  if (readDevShellChunkBytes(verificationOutput) > 0) {
    return {
      storedOutput: input.currentStoredOutput,
      reusedPriorActionableOutput: false,
    };
  }

  const priorLastAction = asRecord(input.priorLastActionResult);
  if (asString(priorLastAction?.kind) !== "tool" || asString(priorLastAction?.name) !== "dev.process.read") {
    return {
      storedOutput: input.currentStoredOutput,
      reusedPriorActionableOutput: false,
    };
  }
  const priorOutput = asRecord(priorLastAction?.output);
  if (priorOutput === undefined) {
    return {
      storedOutput: input.currentStoredOutput,
      reusedPriorActionableOutput: false,
    };
  }
  const currentDevShell = asRecord(input.currentExecState?.devShell);
  const currentIdentity = readDevShellReadCommandIdentity({
    output: verificationOutput,
    fallbackProcessId:
      asString(currentDevShell?.lastCompletedProcessId) ?? asString(currentDevShell?.processId),
    fallbackExitCode: asPositiveNumber(currentDevShell?.lastCompletedExitCode),
  });
  const priorIdentity = readDevShellReadCommandIdentity({
    output: priorOutput,
  });
  if (
    currentIdentity.processId !== undefined &&
    priorIdentity.processId !== undefined &&
    currentIdentity.processId !== priorIdentity.processId
  ) {
    return {
      storedOutput: input.currentStoredOutput,
      reusedPriorActionableOutput: false,
    };
  }
  if (currentIdentity.processId !== undefined && priorIdentity.processId === undefined) {
    return {
      storedOutput: input.currentStoredOutput,
      reusedPriorActionableOutput: false,
    };
  }
  if (
    currentIdentity.exitCode !== undefined &&
    priorIdentity.exitCode !== undefined &&
    currentIdentity.exitCode !== priorIdentity.exitCode
  ) {
    return {
      storedOutput: input.currentStoredOutput,
      reusedPriorActionableOutput: false,
    };
  }
  const priorChunkBytes = readDevShellChunkBytes(priorOutput);
  const priorChunkPreview = asString(priorOutput.chunkPreview);
  const priorChunk = asString(priorOutput.chunk);
  const hasPriorActionableOutput = priorChunkBytes > 0 || (priorChunkPreview?.trim().length ?? 0) > 0;
  if (hasPriorActionableOutput === false) {
    return {
      storedOutput: input.currentStoredOutput,
      reusedPriorActionableOutput: false,
    };
  }

  const currentStoredRecord = asRecord(input.currentStoredOutput) ?? {};
  const mergedOutput: Record<string, unknown> = {
    ...currentStoredRecord,
    ...(priorChunkPreview !== undefined ? { chunkPreview: priorChunkPreview } : {}),
    ...(priorChunk !== undefined ? { chunk: priorChunk } : {}),
    ...(priorChunkBytes > 0 ? { chunkBytes: priorChunkBytes } : {}),
    ...(currentIdentity.processId !== undefined
      ? { completionProcessId: currentIdentity.processId }
      : {}),
    ...(currentIdentity.exitCode !== undefined
      ? { completionExitCode: currentIdentity.exitCode }
      : {}),
  };
  return {
    storedOutput: mergedOutput,
    reusedPriorActionableOutput: true,
  };
}

function readDevShellReadCommandIdentity(input: {
  output: Record<string, unknown> | undefined;
  fallbackProcessId?: string | undefined;
  fallbackExitCode?: number | undefined;
}): { processId?: string | undefined; exitCode?: number | undefined } {
  const completion = readDevShellCompletionMarker(input.output);
  const processId =
    completion?.processId ??
    asString(input.output?.completionProcessId) ??
    asString(input.output?.processId) ??
    input.fallbackProcessId;
  const exitCode =
    completion?.exitCode ??
    asPositiveNumber(input.output?.completionExitCode) ??
    asPositiveNumber(input.output?.completedExitCode) ??
    asPositiveNumber(input.output?.exitCode) ??
    input.fallbackExitCode;
  return {
    ...(processId !== undefined ? { processId } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function helperCommandRoleHasConcreteTarget(
  commandRole: NonNullable<ReturnType<typeof deriveCommandExecutionRole>>["effective"] | undefined,
): boolean {
  return commandRole?.sourcePath !== undefined ||
    commandRole?.artifactTarget !== undefined;
}

function normalizeDevShellCommandContext(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }
  const command = asString(record.command);
  const cwd = asString(record.cwd);
  const workspaceRoot = asString(record.workspaceRoot);
  const envMode = asString(record.envMode);
  const requiredTools = asArray(record.requiredTools)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  const context: Record<string, unknown> = {
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(envMode !== undefined ? { envMode } : {}),
    ...(requiredTools.length > 0 ? { requiredTools } : {}),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}

function readDevShellCommandSegments(command: unknown): string[] {
  if (typeof command !== "string") {
    return [];
  }
  return command
    .split("&&")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .slice(0, 12);
}

const MAX_DEV_SHELL_RECENT_COMMANDS = 24;

function readDevShellRecentCommands(value: unknown): string[] {
  return asArray(value)
    .map((item) => asString(item)?.trim())
    .filter((item): item is string => item !== undefined && item.length > 0)
    .slice(-MAX_DEV_SHELL_RECENT_COMMANDS);
}

function readDevShellLiveProcessIds(value: unknown): string[] {
  return asArray(value)
    .map((item) => asString(item)?.trim())
    .filter((item): item is string => item !== undefined && item.length > 0);
}

function appendRecentDevShellCommand(previous: string[], command: string): string[] {
  const next = [...previous, command.trim()].filter((entry) => entry.length > 0);
  return next.slice(-MAX_DEV_SHELL_RECENT_COMMANDS);
}

function readDevShellCompletionMarker(
  output: Record<string, unknown> | undefined,
): { processId?: string | undefined; exitCode?: number | undefined } | undefined {
  const completionProcessId = asString(output?.completionProcessId);
  const completionExitCode =
    typeof output?.completionExitCode === "number" && Number.isFinite(output.completionExitCode)
      ? Math.trunc(output.completionExitCode)
      : undefined;
  if (completionProcessId !== undefined || completionExitCode !== undefined) {
    return {
      ...(completionProcessId !== undefined ? { processId: completionProcessId } : {}),
      ...(completionExitCode !== undefined ? { exitCode: completionExitCode } : {}),
    };
  }
  const text = asString(output?.text) ?? asString(output?.chunk) ?? asString(output?.chunkPreview);
  if (text === undefined || text.length === 0) {
    return ;
  }
  const matches = [...text.matchAll(/__KESTREL_CMD_DONE__:([^:\s]+):(-?\d+)/g)];
  if (matches.length === 0) {
    return ;
  }
  const marker = matches[matches.length - 1];
  if (marker === undefined) {
    return ;
  }
  const processId = typeof marker[1] === "string" ? marker[1] : undefined;
  const parsedExitCode =
    typeof marker[2] === "string" ? Number.parseInt(marker[2], 10) : Number.NaN;
  const exitCode = Number.isFinite(parsedExitCode) ? Math.trunc(parsedExitCode) : undefined;
  if (processId === undefined && exitCode === undefined) {
    return ;
  }
  return {
    ...(processId !== undefined ? { processId } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function withExecStatePatch(
  reactPatch: Record<string, unknown>,
  execPatch: Record<string, unknown>,
): Record<string, unknown> {
  return applyReferenceReactExecPatch(reactPatch, execPatch);
}

function createActerMissingActionError(): Error {
  return createRuntimeFailure(
    "DECISION_PARSE_FAILED",
    "Acter requires a valid compiled nextAction in state.agent.nextAction.",
    {
      subsystem: "react",
      step: "agent.exec.dispatch",
      classification: "schema",
      recoverable: true,
      statePath: "state.agent.nextAction",
    },
  );
}

function createActerInvalidCompiledActionError(failure: CompiledActionValidationFailure): Error {
  return createRuntimeFailure(
    failure.code,
    failure.message,
    {
      subsystem: "react",
      step: "agent.exec.dispatch",
      classification: "schema",
      recoverable: true,
      schemaCategory: failure.schemaCategory,
      ...failure.details,
    },
  );
}

function createActerRawEffectActionError(): Error {
  return createRuntimeFailure(
    "DECISION_POLICY_FAILED",
    "Agent exec cannot execute raw effect actions; agent.loop must choose tool, tool_batch, ask_user, finalize, or cannot_satisfy.",
    {
      subsystem: "react",
      step: "agent.exec.dispatch",
      classification: "policy",
      recoverable: true,
      requiredStep: "agent.loop",
    },
  );
}

function createActerResolveActionError(): Error {
  return createRuntimeFailure(
    "DECISION_POLICY_FAILED",
    "Agent exec cannot execute resolve_tool; agent.loop must choose an executable action directly.",
    {
      subsystem: "react",
      step: "agent.exec.dispatch",
      classification: "policy",
      recoverable: true,
      requiredStep: "agent.loop",
    },
  );
}

function createActerPendingEffectTypeRequiredError(): Error {
  return createRuntimeFailure(
    "AGENT_ACTER_PENDING_EFFECT_TYPE_REQUIRED",
    "Execution effect collect requires state.agent.exec.pendingEffectType when pendingEffectKey is set.",
    {
      subsystem: "react",
      step: "agent.exec.wait_effect",
      classification: "schema",
      recoverable: true,
      statePath: "state.agent.exec.pendingEffectType",
      relatedStatePath: "state.agent.exec.pendingEffectKey",
    },
  );
}

interface DispatchReuseGuardState {
  runId: string;
  toolName: string;
  inputHash: string;
  consecutiveReuseCount: number;
}

function readDispatchReuseGuard(value: unknown): DispatchReuseGuardState | undefined {
  const record = asRecord(value);
  const runId = asString(record?.runId);
  const toolName = asString(record?.toolName);
  const inputHash = asString(record?.inputHash);
  const consecutiveReuseCount =
    typeof record?.consecutiveReuseCount === "number" ? record.consecutiveReuseCount : undefined;
  if (
    runId === undefined ||
    toolName === undefined ||
    inputHash === undefined ||
    consecutiveReuseCount === undefined
  ) {
    return ;
  }
  if (consecutiveReuseCount < 1) {
    return ;
  }
  return {
    runId,
    toolName,
    inputHash,
    consecutiveReuseCount,
  };
}

function nextDispatchReuseGuard(input: {
  existing: DispatchReuseGuardState | undefined;
  runId: string;
  toolName: string;
  inputHash: string;
}): DispatchReuseGuardState {
  const isSameKey =
    input.existing?.runId === input.runId &&
    input.existing?.toolName === input.toolName &&
    input.existing?.inputHash === input.inputHash;
  return {
    runId: input.runId,
    toolName: input.toolName,
    inputHash: input.inputHash,
    consecutiveReuseCount: isSameKey ? (input.existing?.consecutiveReuseCount ?? 0) + 1 : 1,
  };
}

function createActerDispatchStallDetectedError(input: {
  runId: string;
  stepIndex: number;
  toolName: string;
  inputHash: string;
  consecutiveReuseCount: number;
}): Error {
  return createRuntimeFailure(
    "AGENT_DISPATCH_STALL_DETECTED",
    "Execution dispatch detected repeated deduped tool reuse without new evidence and aborted to prevent a loop.",
    {
      subsystem: "react",
      step: "agent.exec.dispatch",
      classification: "runtime",
      recoverable: true,
      runId: input.runId,
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      inputHash: input.inputHash,
      consecutiveReuseCount: input.consecutiveReuseCount,
    },
  );
}
