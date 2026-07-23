import { createHash } from "node:crypto";

import type { ModelMessage } from "../../kestrel/contracts/model-io.js";
import type { ContextSectionCandidateV1 } from "../../economics/contracts.js";
import { countTextTokens, type ExactTokenCounter } from "../../economics/tokenCounting.js";

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
import { buildRuntimeContextFragment, buildRuntimeContextSections } from "./runtimeContext.js";
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
import {
  deriveActiveExecCommandSessions,
  deriveWorkspaceFreshness,
} from "../workspaceFreshness.js";

export type { KestrelBenchmarkContext, KestrelBenchmarkSource } from "./benchmarkContext.js";
export {
  buildKestrelAgentCompactedTranscript,
  buildKestrelAgentCompactionMessages,
  buildKestrelCompactionSummarySchema,
  buildKestrelCompactionSufficiencyMessages,
  buildKestrelTerminalBenchRepairPrompt,
  KESTREL_COMPACTION_SUMMARY_SCHEMA,
  KESTREL_COMPACTION_SUFFICIENCY_SCHEMA,
  parseKestrelCompactionSufficiencyVerdictV1,
  parseKestrelCompactionSummaryV1,
  planKestrelAgentCompaction,
  shouldCompactKestrelAgentContext,
  type KestrelCompactionSummaryV1,
  type KestrelAgentCompactedTranscriptInput,
  type KestrelAgentCompactionBuildInput,
  type KestrelAgentCompactionPlan,
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
  activeWorkspaceSkills?: unknown;
  activeProjectContext?: unknown;
  activeSkillPack?: unknown;
  retryContext?: Record<string, unknown> | undefined;
  systemPrompt?: KestrelAgentSystemPromptInput | undefined;
  stepIndex?: number | undefined;
  tokenCounter?: ExactTokenCounter | undefined;
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
  version: 2;
  sections: KestrelAgentContextSection[];
  manifestSections: ContextSectionCandidateV1[];
  pipelineSections: Array<{
    id: string;
    origin: string;
    revision?: string | undefined;
    contentHash: string;
    renderedContent: string;
    binding: "system" | "runtime" | "transcript";
    messageIndex: number;
  }>;
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
  const workspaceFreshness = deriveWorkspaceFreshness(input.reactState.evidenceLedger);
  const activeExecCommandSessions = deriveActiveExecCommandSessions(input.reactState.evidenceLedger);
  const activeProcessEvidence = buildActiveProcessEvidence(input.reactState, transcript);
  const recentFilesystemEvidence = buildRecentFilesystemEvidence(input.reactState);
  const recentToolResultEvidence = buildRecentToolResultEvidence({
    lastActionResult: input.reactState.lastActionResult,
    transcript,
    omitRunningExecCommand: activeProcessEvidence !== undefined,
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
    workspaceSkillsContext: input.activeWorkspaceSkills,
    projectContext: input.activeProjectContext,
    skillPackContext: input.activeSkillPack,
    ...(activeProcessEvidence !== undefined ? { activeProcessEvidence } : {}),
    ...(recentFilesystemEvidence !== undefined ? { recentFilesystemEvidence } : {}),
    ...(recentToolResultEvidence !== undefined ? { recentToolResultEvidence } : {}),
    ...(projectTaskQueueContext !== undefined ? { projectTaskQueueContext } : {}),
    ...(recoveryContext !== undefined ? { recoveryContext } : {}),
    ...(visibleTodos !== undefined ? { visibleTodos } : {}),
    workspaceFreshness,
    ...(activeExecCommandSessions.length > 0 ? { activeExecCommandSessions } : {}),
    ...(correction !== undefined ? { correction } : {}),
    activeWait: input.reactState.waitingFor,
  });
  const runtimeSections = buildRuntimeContextSections({
    ...(runtimeTaskInstruction !== undefined ? { taskInstruction: runtimeTaskInstruction } : {}),
    eventType: input.eventType,
    interactionMode: input.interactionMode,
    ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
    ...(input.promptVariant !== undefined ? { promptVariant: input.promptVariant } : {}),
    workspaceContext: input.activeWorkspace,
    workspaceSkillsContext: input.activeWorkspaceSkills,
    projectContext: input.activeProjectContext,
    skillPackContext: input.activeSkillPack,
    ...(activeProcessEvidence !== undefined ? { activeProcessEvidence } : {}),
    ...(recentFilesystemEvidence !== undefined ? { recentFilesystemEvidence } : {}),
    ...(recentToolResultEvidence !== undefined ? { recentToolResultEvidence } : {}),
    ...(projectTaskQueueContext !== undefined ? { projectTaskQueueContext } : {}),
    ...(recoveryContext !== undefined ? { recoveryContext } : {}),
    ...(visibleTodos !== undefined ? { visibleTodos } : {}),
    workspaceFreshness,
    ...(activeExecCommandSessions.length > 0 ? { activeExecCommandSessions } : {}),
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
  const transcriptMessages = contextMessages.slice(runtimeContext.trim().length > 0 ? 1 : 0);
  const systemOffset = systemMessage === undefined ? 0 : 1;
  const runtimeMessagePresent = runtimeContext.trim().length > 0;
  const runtimeMessageIndex = systemOffset;
  const transcriptOffset = systemOffset + (runtimeMessagePresent ? 1 : 0);
  const pipelineSections = [
    ...(systemMessage !== undefined
      ? [toPipelineSection("systemPrompt", "system-prompt", serializeMessageContent(systemMessage), "system" as const, 0)]
      : []),
    ...runtimeSections.map((section) => toPipelineSection(
      section.id,
      section.origin,
      section.content,
      "runtime" as const,
      runtimeMessageIndex,
      section.revision,
    )),
    ...transcriptMessages.map((message, index) => toPipelineSection(
      `transcript:${transcript.items[index]?.id ?? index}`,
      `model-transcript:${message.role}`,
      JSON.stringify(message),
      "transcript" as const,
      transcriptOffset + index,
      transcript.items[index]?.id,
    )),
  ];
  const manifestSections = withExactDuplicates([
    ...(systemMessage !== undefined
      ? [toManifestSection("systemPrompt", "system-prompt", serializeMessageContent(systemMessage), undefined, input.tokenCounter)]
      : []),
    ...runtimeSections.map((section) => toManifestSection(
      section.id,
      section.origin,
      section.content,
      section.revision,
      input.tokenCounter,
    )),
    ...transcriptMessages.map((message, index) => toManifestSection(
      `transcript:${transcript.items[index]?.id ?? index}`,
      `model-transcript:${message.role}`,
      JSON.stringify(message),
      transcript.items[index]?.id,
      input.tokenCounter,
    )),
  ]);
  return {
    transcript,
    messages,
    contextMessages,
    modelInput,
    metadata: {
      builder: "kestrel-agent-context",
      version: 2,
      manifestSections,
      pipelineSections,
      sections: [
        { id: "systemPrompt", origin: "system-prompt", rendered: systemMessage !== undefined },
        { id: "task", origin: "turn", rendered: input.goal.trim().length > 0 },
        { id: "benchmarkContext", origin: "benchmark", rendered: benchmarkContext !== undefined },
        { id: "mode", origin: "turn", rendered: input.interactionMode.trim().length > 0 },
        { id: "workspace", origin: "workspace", rendered: input.activeWorkspace !== undefined },
        { id: "workspaceSkills", origin: "workspace-skills", rendered: input.activeWorkspaceSkills !== undefined },
        { id: "projectContext", origin: "project", rendered: input.activeProjectContext !== undefined },
        { id: "activeProcessEvidence", origin: "runtime-state", rendered: activeProcessEvidence !== undefined },
        { id: "recentFilesystemEvidence", origin: "runtime-state", rendered: recentFilesystemEvidence !== undefined },
        { id: "recentToolResultEvidence", origin: "model-transcript", rendered: recentToolResultEvidence !== undefined },
        { id: "projectTaskQueue", origin: "project-snapshot", rendered: projectTaskQueueContext !== undefined },
        { id: "recovery", origin: "runtime-state", rendered: recoveryContext !== undefined },
        { id: "visibleTodos", origin: "runtime-state", rendered: visibleTodos !== undefined },
        {
          id: "workspaceFreshness",
          origin: "runtime-evidence",
          rendered: workspaceFreshness.status === "stale" ||
            workspaceFreshness.status === "attempted_unresolved" ||
            activeExecCommandSessions.length > 0,
        },
        { id: "correction", origin: "feedback", rendered: correction !== undefined },
        { id: "activeWait", origin: "runtime-state", rendered: asRecord(input.reactState.waitingFor) !== undefined },
        ...transcriptMessages.map((message, index) => ({
          id: `transcript:${transcript.items[index]?.id ?? index}`,
          origin: `model-transcript:${message.role}`,
          rendered: true,
        })),
      ],
    },
  };
}

function toPipelineSection(
  id: string,
  origin: string,
  renderedContent: string,
  binding: "system" | "runtime" | "transcript",
  messageIndex: number,
  revision?: string | undefined,
): KestrelAgentContextMetadata["pipelineSections"][number] {
  return {
    id,
    origin,
    ...(revision !== undefined ? { revision } : {}),
    contentHash: createHash("sha256").update(renderedContent).digest("hex"),
    renderedContent,
    binding,
    messageIndex,
  };
}

function toManifestSection(
  id: string,
  origin: string,
  content: string,
  revision?: string | undefined,
  counter?: ExactTokenCounter | undefined,
): ContextSectionCandidateV1 {
  return {
    id,
    origin,
    ...(revision !== undefined ? { revision } : {}),
    contentHash: createHash("sha256").update(content).digest("hex"),
    count: countTextTokens(content, counter),
  };
}

function withExactDuplicates(sections: ContextSectionCandidateV1[]): ContextSectionCandidateV1[] {
  const idsByHash = new Map<string, string[]>();
  for (const section of sections) {
    const ids = idsByHash.get(section.contentHash) ?? [];
    ids.push(section.id);
    idsByHash.set(section.contentHash, ids);
  }
  return sections.map((section) => {
    const duplicateOf = (idsByHash.get(section.contentHash) ?? []).filter((id) => id !== section.id);
    return duplicateOf.length > 0 ? { ...section, duplicateOf } : section;
  });
}

function serializeMessageContent(message: ModelMessage): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
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
    return ;
  }
  const goal = input.goal.trim();
  if (goal.length === 0) {
    return ;
  }
  if (goal === input.userMessage.trim()) {
    return ;
  }
  return goal;
}

function renderSystemPromptMessage(systemPrompt: KestrelAgentSystemPromptInput | undefined): ModelMessage | undefined {
  if (systemPrompt === undefined) {
    return ;
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
    return ;
  }
  const loopStall = asRecord(reactState.loopStall);
  if (loopStall?.reason !== "loop_visit_stall" || loopStall.status !== "resumed") {
    return ;
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
    return ;
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
