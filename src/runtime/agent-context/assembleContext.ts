import type { ModelMessage } from "../../kestrel/contracts/model-io.js";

import {
  buildDeliberatorSystemPrompt,
  type DeliberatorPromptInput,
} from "./systemPrompts.js";
import {
  appendCorrectionToTranscript,
  appendUserTurnToTranscript,
  normalizeModelTranscript,
  readActiveTaskGoalFromTranscript,
  renderModelTranscriptMessages,
  type ModelTranscript,
} from "../modelTranscript.js";
import { buildRuntimeContextFragment } from "./runtimeContext.js";
import {
  readBenchmarkContext,
  renderTaskInstruction,
} from "./benchmarkContext.js";
import {
  buildActiveProcessEvidence,
  buildProjectTaskQueueContext,
  buildRecentFilesystemEvidence,
  buildRecentToolResultEvidence,
} from "./evidenceContext.js";
import {
  readCorrection,
} from "./retryContext.js";
import {
  normalizeVisibleTodoState,
} from "../visibleTodos.js";
import {
  resolveKestrelTurnObjective,
} from "../turnObjective.js";

export type { KestrelBenchmarkContext, KestrelBenchmarkSource } from "./benchmarkContext.js";
export {
  buildKestrelAgentCompactedTranscript,
  buildKestrelAgentCompactionMessages,
  buildKestrelTerminalBenchRepairPrompt,
  shouldCompactKestrelAgentContext,
  type KestrelAgentCompactedTranscriptInput,
  type KestrelAgentCompactionBuildInput,
  type KestrelAgentCompactionPolicyInput,
  type KestrelTerminalBenchRepairPromptInput,
} from "./maintenancePrompts.js";
export {
  buildKestrelAgentValidationFeedbackMessage,
  type KestrelAgentValidationFeedbackInput,
} from "./retryContext.js";
export {
  buildKestrelAgentToolModelContext,
  buildKestrelAgentToolResultSummary,
  buildKestrelAgentToolSurface,
  providerToolAliasForCanonicalName,
  type KestrelAgentCannotSatisfyReasonCode,
  type KestrelAgentFinalizeStatus,
  type KestrelAgentToolActionKind,
  type KestrelAgentToolAliasEntry,
  type KestrelAgentToolAliasRegistry,
  type KestrelAgentToolModelContextInput,
  type KestrelAgentToolResultStatus,
  type KestrelAgentToolResultSummaryInput,
  type KestrelAgentToolSurfaceInput,
} from "./toolContext.js";

export interface KestrelAgentContextBuildInput {
  reactState: Record<string, unknown>;
  eventPayload: Record<string, unknown>;
  projectSnapshot?: unknown;
  eventType: string;
  goal: string;
  interactionMode: string;
  actSubmode?: string | undefined;
  promptVariant?: string | undefined;
  activeWorkspace?: unknown;
  activeProjectContext?: unknown;
  activeSkillPack?: unknown;
  retryContext?: Record<string, unknown> | undefined;
  systemPrompt?: KestrelAgentSystemPromptInput | undefined;
  stepIndex?: number | undefined;
}

export type KestrelAgentSystemPromptInput =
  & {
    kind: "reference-react-deliberator";
  }
  & DeliberatorPromptInput;

export interface KestrelAgentContextBuildOutput {
  modelInput: Record<string, unknown>;
  messages: ModelMessage[];
  contextMessages: ModelMessage[];
  transcript: ModelTranscript;
  metadata: KestrelAgentContextMetadata;
}

export interface KestrelAgentContextMetadata {
  builder: "kestrel-agent-context";
  version: 1;
  sections: KestrelAgentContextSection[];
}

export interface KestrelAgentContextSection {
  id: string;
  origin: string;
  rendered: boolean;
}

export function buildKestrelAgentContext(
  input: KestrelAgentContextBuildInput,
): KestrelAgentContextBuildOutput {
  const benchmarkContext = readBenchmarkContext(input.eventPayload);
  const existingTranscript = normalizeModelTranscript(input.reactState.modelTranscript) ?? {
    version: 1 as const,
    windowId: 1,
    items: [],
  };
  const activeTaskGoal = resolveKestrelTurnObjective({
    reactState: input.reactState,
    eventType: input.eventType,
    eventPayload: input.eventPayload,
    fallbackGoal: input.goal,
  }).goal ?? input.goal;
  const taskInstruction = renderTaskInstruction({
    goal: activeTaskGoal,
    benchmarkContext,
  });
  const userMessage = readUserMessage(input.eventPayload) ?? input.goal;
  const seedTaskMessage = shouldSeedInitialTaskMessage({
    transcript: existingTranscript,
    goal: input.goal,
    userMessage,
  });
  let transcript = appendUserTurnToTranscript({
    transcript: seedTaskMessage === undefined
      ? existingTranscript
      : appendUserTurnToTranscript({
          transcript: existingTranscript,
          message: seedTaskMessage,
          stepIndex: input.stepIndex,
        }),
    message: userMessage,
    stepIndex: input.stepIndex,
  });
  const correction = readCorrection(input.retryContext);
  if (correction !== undefined) {
    const existingCorrection = transcript.items.some((item) =>
      item.kind === "correction" && item.content === correction
    );
    if (existingCorrection === false) {
      transcript = appendCorrectionToTranscript({
        transcript,
        message: correction,
        stepIndex: input.stepIndex,
      });
    }
  }
  const visibleTodos = normalizeVisibleTodoState(input.reactState.visibleTodos);
  const activeProcessEvidence = buildActiveProcessEvidence(input.reactState, transcript);
  const recentFilesystemEvidence = buildRecentFilesystemEvidence(input.reactState);
  const recentToolResultEvidence = buildRecentToolResultEvidence({
    lastActionResult: input.reactState.lastActionResult,
    transcript,
  });
  const projectTaskQueueContext = buildProjectTaskQueueContext(input.projectSnapshot);
  const recoveryContext = buildRecoveryContext(input.reactState);
  const runtimeTaskInstruction = transcriptHasUserMessage(transcript, activeTaskGoal)
    ? taskInstruction !== activeTaskGoal ? taskInstruction : undefined
    : taskInstruction;
  const runtimeContext = buildRuntimeContextFragment({
    ...(runtimeTaskInstruction !== undefined ? { taskInstruction: runtimeTaskInstruction } : {}),
    eventType: input.eventType,
    interactionMode: input.interactionMode,
    ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
    ...(input.promptVariant !== undefined ? { promptVariant: input.promptVariant } : {}),
    workspaceContext: input.activeWorkspace,
    projectContext: input.activeProjectContext,
    skillPackContext: input.activeSkillPack,
    ...(activeProcessEvidence !== undefined ? { activeProcessEvidence } : {}),
    ...(recentFilesystemEvidence !== undefined ? { recentFilesystemEvidence } : {}),
    ...(recentToolResultEvidence !== undefined ? { recentToolResultEvidence } : {}),
    ...(projectTaskQueueContext !== undefined ? { projectTaskQueueContext } : {}),
    ...(recoveryContext !== undefined ? { recoveryContext } : {}),
    ...(visibleTodos !== undefined ? { visibleTodos } : {}),
    ...(correction !== undefined ? { correction } : {}),
    activeWait: input.reactState.waitingFor,
  });
  const contextMessages = renderModelTranscriptMessages({
    transcript,
    runtimeContext,
    ...(correction !== undefined ? { suppressCorrectionContent: correction } : {}),
  });
  const systemMessage = renderSystemPromptMessage(input.systemPrompt);
  const messages = systemMessage !== undefined
    ? [systemMessage, ...contextMessages]
    : contextMessages;
  const modelInput = {
    version: "transcript-v1",
    taskInstruction,
    eventType: input.eventType,
    interactionMode: input.interactionMode,
    ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
    ...(input.promptVariant !== undefined ? { promptVariant: input.promptVariant } : {}),
    ...(visibleTodos !== undefined ? { visibleTodos } : {}),
    ...(projectTaskQueueContext !== undefined ? { projectTaskQueueContext } : {}),
    ...(recoveryContext !== undefined ? { recoveryContext } : {}),
    transcript: normalizeModelTranscript(transcript),
  };
  return {
    transcript,
    messages,
    contextMessages,
    modelInput,
    metadata: {
      builder: "kestrel-agent-context",
      version: 1,
      sections: [
        { id: "systemPrompt", origin: "system-prompt", rendered: systemMessage !== undefined },
        { id: "task", origin: "turn", rendered: input.goal.trim().length > 0 },
        { id: "benchmarkContext", origin: "benchmark", rendered: benchmarkContext !== undefined },
        { id: "mode", origin: "turn", rendered: input.interactionMode.trim().length > 0 },
        { id: "workspace", origin: "workspace", rendered: input.activeWorkspace !== undefined },
        { id: "projectContext", origin: "project", rendered: input.activeProjectContext !== undefined },
        { id: "skillPack", origin: "skill-pack", rendered: input.activeSkillPack !== undefined },
        { id: "activeProcessEvidence", origin: "runtime-state", rendered: activeProcessEvidence !== undefined },
        { id: "recentFilesystemEvidence", origin: "runtime-state", rendered: recentFilesystemEvidence !== undefined },
        { id: "recentToolResultEvidence", origin: "model-transcript", rendered: recentToolResultEvidence !== undefined },
        { id: "projectTaskQueue", origin: "project-snapshot", rendered: projectTaskQueueContext !== undefined },
        { id: "recovery", origin: "runtime-state", rendered: recoveryContext !== undefined },
        { id: "visibleTodos", origin: "runtime-state", rendered: visibleTodos !== undefined },
        { id: "correction", origin: "feedback", rendered: correction !== undefined },
        { id: "activeWait", origin: "runtime-state", rendered: asRecord(input.reactState.waitingFor) !== undefined },
        { id: "transcript", origin: "model-transcript", rendered: transcript.items.length > 0 },
      ],
    },
  };
}

function transcriptHasUserMessage(transcript: ModelTranscript, message: string): boolean {
  const normalized = message.trim();
  return normalized.length > 0 &&
    transcript.items.some((item) => item.kind === "user" && item.content?.trim() === normalized);
}

function shouldSeedInitialTaskMessage(input: {
  transcript: ModelTranscript;
  goal: string;
  userMessage: string;
}): string | undefined {
  if (readActiveTaskGoalFromTranscript(input.transcript) !== undefined) {
    return undefined;
  }
  const goal = input.goal.trim();
  if (goal.length === 0) {
    return undefined;
  }
  if (goal === input.userMessage.trim()) {
    return undefined;
  }
  return goal;
}

function renderSystemPromptMessage(systemPrompt: KestrelAgentSystemPromptInput | undefined): ModelMessage | undefined {
  if (systemPrompt === undefined) {
    return undefined;
  }
  if (systemPrompt.kind === "reference-react-deliberator") {
    return {
      role: "system",
      content: buildDeliberatorSystemPrompt(systemPrompt),
    };
  }
}

function readUserMessage(eventPayload: Record<string, unknown>): string | undefined {
  return asString(eventPayload.message);
}

function buildRecoveryContext(reactState: Record<string, unknown>): Record<string, unknown> | undefined {
  if (asRecord(reactState.waitingFor) !== undefined) {
    return undefined;
  }
  const loopStall = asRecord(reactState.loopStall);
  if (loopStall?.reason !== "loop_visit_stall" || loopStall.status !== "resumed") {
    return undefined;
  }
  const blockedAction = asRecord(loopStall.blockedAction);
  const diagnostic = asRecord(loopStall.diagnostic);
  const target = asRecord(loopStall.target);
  const resumeInstruction = asString(loopStall.resumeInstruction);
  if (
    blockedAction === undefined &&
    diagnostic === undefined &&
    target === undefined &&
    resumeInstruction === undefined
  ) {
    return undefined;
  }
  return {
    reason: "loop_visit_stall",
    status: "resumed",
    ...(resumeInstruction !== undefined ? { resumeInstruction } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(diagnostic !== undefined ? { diagnostic } : {}),
    ...(blockedAction !== undefined ? { blockedAction } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
