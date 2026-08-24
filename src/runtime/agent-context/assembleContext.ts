import { createHash } from "node:crypto";

import type { ModelContentPart, ModelMessage } from "../../kestrel/contracts/model-io.js";
import type { RunTurnAttachment } from "../../kestrel/contracts/orchestration.js";
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
  readSubmissionKind,
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
  buildKestrelCompactionSourceUnits,
  buildKestrelCompactionSummarySchema,
  buildKestrelCompactionSufficiencyMessages,
  estimateKestrelCompactionSourceTokens,
  buildKestrelTerminalBenchRepairPrompt,
  KESTREL_COMPACTION_SUMMARY_SCHEMA,
  KESTREL_COMPACTION_SUFFICIENCY_SCHEMA,
  parseKestrelCompactionSufficiencyVerdictV1,
  parseKestrelCompactionSummaryV2,
  planKestrelAgentCompaction,
  shouldCompactKestrelAgentContext,
  type KestrelCompactionSummaryV2,
  type KestrelAgentCompactedTranscriptInput,
  type KestrelAgentCompactionBuildInput,
  type KestrelAgentCompactionCorrectionV1,
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
    kind: "kestrel-deliberator";
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

const MODEL_IMAGE_INPUT_UNAVAILABLE_REASON =
  "The selected model does not accept image input; the original remains available read-only to Workspace tools.";

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
  const explicitUserMessage = readUserMessage(input.eventPayload);
  const attachments = adaptAttachmentsForSelectedModel(
    readTurnAttachments(input.eventPayload.attachments),
    readSelectedModelVisionInput(input.eventPayload),
  );
  const attachmentContext = renderAttachmentContext(attachments);
  const userMessage = [explicitUserMessage ?? input.goal, attachmentContext]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  const eventMetadata = asRecord(input.eventPayload.metadata);
  const submissionKind = readSubmissionKind(input.eventPayload);
  const hasCanonicalFreshMessage = submissionKind === "initial" || submissionKind === "follow_up";
  const sourceEventId = explicitUserMessage !== undefined || hasCanonicalFreshMessage
    ? asString(eventMetadata?.sourceEventId)
    : undefined;
  const sourceTurnId = asString(eventMetadata?.turnId);
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
          ...(sourceEventId !== undefined ? { sourceEventId: `${sourceEventId}:seed` } : {}),
          ...(sourceTurnId !== undefined ? { sourceTurnId } : {}),
        }),
    message: userMessage,
    stepIndex: input.stepIndex,
    ...(sourceEventId !== undefined ? { sourceEventId } : {}),
    ...(sourceTurnId !== undefined ? { sourceTurnId } : {}),
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
  attachTurnRepresentationsToLatestUserMessage(contextMessages, attachments);
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
        { id: "attachments", origin: "turn-attachments", rendered: attachments.length > 0 },
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
  if (systemPrompt.kind === "kestrel-deliberator") {
    return {
      role: "system",
      content: buildDeliberatorSystemPrompt(systemPrompt),
    };
  }
}

function readUserMessage(eventPayload: Record<string, unknown>): string | undefined {
  return asString(eventPayload.message);
}

function readTurnAttachments(value: unknown): RunTurnAttachment[] {
  if (value === undefined) return [];
  if (Array.isArray(value) === false) throw new Error("Turn attachments must be an array.");
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (record === undefined) throw new Error(`Turn attachment ${index} must be an object.`);
    const attachmentId = asString(record.fileId)?.trim() ?? asString(record.attachmentId)?.trim();
    const filename = asString(record.filename)?.trim();
    const mimeType = asString(record.mimeType)?.trim();
    const sha256 = asString(record.sha256)?.trim();
    const kind = record.kind;
    const representationStatus = record.representationStatus;
    if (
      !attachmentId || !filename || !mimeType || !sha256
      || typeof record.sizeBytes !== "number"
      || (kind !== "image" && kind !== "text" && kind !== "file")
      || (
        representationStatus !== "native_image"
        && representationStatus !== "extracted_text"
        && representationStatus !== "staged_file"
        && representationStatus !== "metadata_only"
      )
    ) {
      throw new Error(`Turn attachment ${index} does not satisfy the execution-protocol-v4 contract.`);
    }
    return {
      ...record,
      fileId: attachmentId,
      attachmentId,
    } as unknown as RunTurnAttachment;
  });
}

function renderAttachmentContext(attachments: RunTurnAttachment[]): string {
  if (attachments.length === 0) return "";
  const inventory = attachments.map((attachment) => JSON.stringify({
    fileId: attachment.fileId ?? attachment.attachmentId,
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    mediaType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    inlineRepresentation: attachment.representationStatus,
    ...(attachment.path !== undefined
      ? {
          originalAccess: "materialized_read_only",
          readOnlyPath: attachment.path,
        }
      : {}),
    ...(attachment.metadataOnlyReason !== undefined ? { note: attachment.metadataOnlyReason } : {}),
  }));
  const extractedText = attachments.flatMap((attachment) => attachment.text === undefined
    ? []
    : [
        `<file_text file_id=${JSON.stringify(attachment.fileId ?? attachment.attachmentId)} filename=${JSON.stringify(attachment.filename)} truncated=${attachment.textTruncated === true ? "true" : "false"}>`,
        attachment.text,
        "</file_text>",
      ]);
  return [
    "<attachments>",
    ...inventory,
    "</attachments>",
    ...extractedText,
  ].join("\n");
}

function adaptAttachmentsForSelectedModel(
  attachments: RunTurnAttachment[],
  visionInputEnabled: boolean,
): RunTurnAttachment[] {
  if (visionInputEnabled) return attachments;
  return attachments.map((attachment) => attachment.kind !== "image"
    ? attachment
    : {
        ...attachment,
        kind: "file",
        representationStatus: "metadata_only",
        metadataOnlyReason: MODEL_IMAGE_INPUT_UNAVAILABLE_REASON,
        data: undefined,
      });
}

function readSelectedModelVisionInput(eventPayload: Record<string, unknown>): boolean {
  const metadata = asRecord(eventPayload.metadata);
  const runtimeAssembly = asRecord(metadata?.runtimeAssembly) ?? asRecord(eventPayload.runtimeAssembly);
  const modelCapabilities = asRecord(runtimeAssembly?.modelCapabilities);
  return modelCapabilities?.visionInputEnabled === true;
}

function attachTurnRepresentationsToLatestUserMessage(
  messages: ModelMessage[],
  attachments: RunTurnAttachment[],
): void {
  const images = attachments.filter((attachment) =>
    attachment.kind === "image" && typeof attachment.data === "string" && attachment.data.length > 0
  );
  if (attachments.length === 0) return;
  const target = [...messages].reverse().find((message) => message.role === "user");
  if (target === undefined) throw new Error("Attachment turn has no model-visible user message.");
  const current = typeof target.content === "string"
    ? [{ type: "text", text: target.content } satisfies ModelContentPart]
    : target.content;
  const materialized = attachments.flatMap((attachment) => attachment.path === undefined
      ? []
    : [{
        fileId: attachment.fileId ?? attachment.attachmentId,
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        readOnlyPath: attachment.path,
      }]);
  target.content = [
    ...(materialized.length > 0
      ? [{
          type: "text" as const,
          text: `<materialized_attachments>\n${materialized.map((entry) => JSON.stringify(entry)).join("\n")}\n</materialized_attachments>`,
        }]
      : []),
    ...current,
    ...images.map((attachment): ModelContentPart => ({
      type: "image",
      mimeType: attachment.mimeType,
      data: attachment.data as string,
    })),
  ];
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
