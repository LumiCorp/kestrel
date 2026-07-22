import type {
  RunnerInteractionRequestV1,
  RunnerRunStreamEvent,
  RunnerRunTerminalEvent,
} from "@kestrel-agents/sdk";
import type {
  KestrelArtifactPresentation,
  KestrelCitationPresentation,
  KestrelInteractionPresentation,
  KestrelMessageMetadata,
  KestrelPresentationPart,
  KestrelPresentationSnapshot,
  KestrelProgressPresentation,
  KestrelAgentProgressPresentation,
  KestrelProviderReasoningPresentation,
  KestrelTerminalStatus,
  KestrelToolPresentation,
  KestrelDialogMessagePresentation,
  KestrelUIMessage,
} from "./contracts.js";

const CONTRACT_FAILURE_CODE = "KESTREL_PRESENTATION_CONTRACT_FAILURE";

export class KestrelPresentationContractError extends Error {
  readonly code = CONTRACT_FAILURE_CODE;

  constructor(message: string) {
    super(message);
    this.name = "KestrelPresentationContractError";
  }
}

export interface KestrelPresentationAccumulator {
  append(event: RunnerRunStreamEvent): KestrelPresentationPart[];
  appendProgress(progress: KestrelProgressPresentation): KestrelPresentationPart[];
  fail(error: unknown): KestrelPresentationPart[];
  finish(event: RunnerRunTerminalEvent): KestrelPresentationSnapshot;
  snapshot(): KestrelPresentationSnapshot;
}

export function readKestrelTerminalInteraction(
  event: RunnerRunTerminalEvent,
): KestrelInteractionPresentation | null {
  if (
    event.type !== "run.completed" ||
    event.payload.result.output.status !== "WAITING"
  ) {
    return null;
  }
  const request = requireInteraction(
    event.payload.result.output.waitFor?.interaction,
  );
  const assistantText = requireNonEmptyString(
    event.payload.result.assistantText,
    "run.completed.payload.result.assistantText",
  );
  if (assistantText !== request.prompt) {
    throw new KestrelPresentationContractError(
      "Waiting assistantText must equal the durable interaction prompt.",
    );
  }
  return { ...request, source: "runtime", status: "pending" };
}

export function createKestrelPresentationAccumulator(input: {
  assistantMessageId: string;
  turnId?: string | undefined;
}): KestrelPresentationAccumulator {
  const parts: KestrelPresentationPart[] = [];
  const seenPartIds = new Set<string>();
  let assistantText: string | null = null;
  let terminalStatus: KestrelTerminalStatus = "working";
  let runId: string | undefined;
  let errorMessage: string | null = null;
  let interaction: KestrelInteractionPresentation | null = null;
  let finalizedPayload: unknown | undefined;

  const appendPart = (part: KestrelPresentationPart): KestrelPresentationPart[] => {
    const id = "id" in part && typeof part.id === "string" ? part.id : undefined;
    if (id !== undefined && seenPartIds.has(id)) {
      return [];
    }
    if (id !== undefined) {
      seenPartIds.add(id);
    }
    parts.push(part);
    return [part];
  };

  const appendProgress = (progress: KestrelProgressPresentation) =>
    appendPart({ type: "data-kestrel-progress", id: progress.id, data: progress });

  const appendAgentProgress = (progress: KestrelAgentProgressPresentation) =>
    appendPart({ type: "data-kestrel-agent-progress", id: progress.id, data: progress });

  const transientProviderReasoning = (
    reasoning: KestrelProviderReasoningPresentation,
  ): KestrelPresentationPart[] => [
    { type: "data-kestrel-provider-reasoning", id: reasoning.id, data: reasoning },
  ];

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : "The Kestrel presentation contract failed.";
    terminalStatus = "contract_failure";
    errorMessage = message;
    return appendPart({
      type: "data-kestrel-status",
      id: "status:contract",
      data: {
        status: "contract_failure",
        ...(runId !== undefined ? { runId } : {}),
        errorCode: error instanceof KestrelPresentationContractError ? error.code : CONTRACT_FAILURE_CODE,
        errorMessage: message,
      },
    });
  };

  const snapshot = (): KestrelPresentationSnapshot => {
    const metadata: KestrelMessageMetadata = {
      kestrelTerminalStatus: terminalStatus,
      ...(input.turnId !== undefined ? { kestrelTurnId: input.turnId } : {}),
      ...(runId !== undefined ? { kestrelRunId: runId } : {}),
      ...(interaction !== null ? { kestrelRequestId: interaction.requestId } : {}),
      ...(terminalStatus === "contract_failure" && errorMessage !== null
        ? {
            kestrelContractFailure: {
              code: CONTRACT_FAILURE_CODE,
              message: errorMessage,
            },
          }
        : {}),
    };
    const message: KestrelUIMessage = {
      id: input.assistantMessageId,
      role: "assistant",
      metadata,
      parts: [
        ...parts,
        ...(assistantText !== null ? [{ type: "text" as const, text: assistantText }] : []),
      ],
    };
    return {
      message,
      assistantText,
      terminalStatus,
      errorMessage,
      failureVisible:
        terminalStatus === "failed" ||
        terminalStatus === "cancelled" ||
        terminalStatus === "contract_failure",
      interaction,
      ...(finalizedPayload !== undefined ? { finalizedPayload } : {}),
    };
  };

  return {
    append(event) {
      try {
        if (event.runId !== undefined) {
          runId = event.runId;
        }
        if (event.type === "run.started") {
          return [];
        }
        if (event.type === "task.updated") {
          const value = event.payload.dialogMessage;
          if (value === undefined) return [];
          const dialog = decodeDialogMessage(value);
          return appendPart({ type: "data-kestrel-dialog-message", id: dialog.messageId, data: dialog });
        }
        if (event.type === "run.progress") {
          const update = requireRecord(event.payload.update, `${event.type}.payload.update`);
          const code = requireNonEmptyString(update.code, `${event.type}.payload.update.code`);
          return appendProgress({
            id: `progress:${event.id}`,
            runId: requireNonEmptyString(update.runId, `${event.type}.payload.update.runId`),
            sequence: requireFiniteNumber(update.seq, `${event.type}.payload.update.seq`),
            timestamp: requireNonEmptyString(update.ts, `${event.type}.payload.update.ts`),
            source: "runtime",
            phase: requireNonEmptyString(update.phase, `${event.type}.payload.update.phase`),
            code,
            text: requireNonEmptyString(update.message, `${event.type}.payload.update.message`),
            severity: code.endsWith("FAILED") ? "error" : "info",
          });
        }
        if (event.type === "run.agent_progress") {
          const update = requireRecord(event.payload.update, `${event.type}.payload.update`);
          const text = requireNonEmptyString(update.message, `${event.type}.payload.update.message`);
          return appendAgentProgress({
            id: `agent-progress:${event.id}`,
            runId: requireNonEmptyString(update.runId, `${event.type}.payload.update.runId`),
            sequence: requireFiniteNumber(update.seq, `${event.type}.payload.update.seq`),
            timestamp: requireNonEmptyString(update.ts, `${event.type}.payload.update.ts`),
            text,
            stepAgent: requireNonEmptyString(update.stepAgent, `${event.type}.payload.update.stepAgent`),
            label: "Agent progress",
          });
        }
        if (
          event.type === "run.model.reasoning.started" ||
          event.type === "run.model.reasoning.delta" ||
          event.type === "run.model.reasoning.completed" ||
          event.type === "run.model.reasoning.failed" ||
          event.type === "run.model.reasoning.unavailable"
        ) {
          const update = requireRecord(event.payload.update, `${event.type}.payload.update`);
          const format = requireReasoningFormat(update.format, `${event.type}.payload.update.format`);
          const reasoningEvent = event.type.slice("run.model.reasoning.".length) as KestrelProviderReasoningPresentation["event"];
          const contentState = update.contentState === "not_retained" ? "not_retained" : "live";
          const delta = reasoningEvent === "delta" && contentState === "live"
            ? readNonEmptyString(update.delta)
            : undefined;
          return transientProviderReasoning({
            id: `provider-reasoning:${event.id}`,
            runId: requireNonEmptyString(update.runId, `${event.type}.payload.update.runId`),
            sequence: requireFiniteNumber(update.seq, `${event.type}.payload.update.seq`),
            timestamp: requireNonEmptyString(update.ts, `${event.type}.payload.update.ts`),
            attempt: requireFiniteNumber(update.attempt, `${event.type}.payload.update.attempt`),
            format,
            label: reasoningEvent === "unavailable"
              ? "Provider reasoning unavailable"
              : format === "summary"
                ? "Provider reasoning summary"
                : format === "provider_thinking"
                  ? "Provider-visible thinking"
                  : "Provider reasoning",
            event: reasoningEvent,
            contentState,
            ...(delta !== undefined ? { delta } : {}),
          });
        }
        if (
          event.type === "run.tool.started" ||
          event.type === "run.tool.completed" ||
          event.type === "run.tool.failed"
        ) {
          const tool = decodeTool(event.payload.update, event.type);
          const emitted = appendPart({ type: "data-kestrel-tool", id: tool.id, data: tool });
          const update = requireRecord(event.payload.update, `${event.type}.payload.update`);
          for (const citation of decodeCitations(update.presentation)) {
            emitted.push(...appendPart({
              type: "data-kestrel-citation",
              id: citation.id,
              data: citation,
            }));
          }
          for (const artifact of decodeArtifacts(update.presentation)) {
            emitted.push(...appendPart({
              type: "data-kestrel-artifact",
              id: artifact.id,
              data: artifact,
            }));
          }
          return emitted;
        }
        if (event.type === "runner.error") {
          return fail(new KestrelPresentationContractError(event.payload.message));
        }
        return [];
      } catch (error) {
        return fail(error);
      }
    },
    appendProgress,
    fail,
    finish(event) {
      try {
        if (event.runId !== undefined) {
          runId = event.runId;
        }
        if (event.type === "run.failed") {
          terminalStatus = "failed";
          errorMessage = event.payload.error.message;
        } else if (event.type === "run.cancelled") {
          terminalStatus = "cancelled";
          errorMessage = "The run was cancelled before it finished.";
        } else {
          const result = event.payload.result;
          finalizedPayload = result.finalizedPayload;
          runId = result.output.runId;
          if (result.output.status === "COMPLETED") {
            assistantText = requireNonEmptyString(
              result.assistantText,
              "run.completed.payload.result.assistantText",
            );
            terminalStatus = "completed";
            errorMessage = null;
          } else if (result.output.status === "WAITING") {
            const waitingAssistantText = requireNonEmptyString(
              result.assistantText,
              "run.completed.payload.result.assistantText",
            );
            interaction = readKestrelTerminalInteraction(event);
            if (!interaction) {
              throw new KestrelPresentationContractError(
                "Waiting runtime result is missing its interaction.",
              );
            }
            assistantText = waitingAssistantText;
            terminalStatus = "waiting";
            errorMessage = null;
            appendPart({
              type: "data-kestrel-interaction",
              id: `interaction:${interaction.requestId}`,
              data: interaction,
            });
          } else {
            throw new KestrelPresentationContractError(
              `run.completed carried unsupported runtime status '${result.output.status}'.`,
            );
          }
        }
      } catch (error) {
        fail(error);
      }
      appendPart({
        type: "data-kestrel-status",
        id: `status:${runId ?? input.assistantMessageId}`,
        data: {
          status: terminalStatus,
          ...(runId !== undefined ? { runId } : {}),
          ...(errorMessage !== null ? { errorMessage } : {}),
        },
      });
      return snapshot();
    },
    snapshot,
  };
}

function decodeDialogMessage(value: unknown): KestrelDialogMessagePresentation {
  const record = requireRecord(value, "task.updated.payload.dialogMessage");
  const sender = record.sender;
  if (sender !== "kestrel" && sender !== "collaborator" && sender !== "system") {
    throw new KestrelPresentationContractError("task.updated.payload.dialogMessage.sender is invalid.");
  }
  const status = record.status === "failed" || record.status === "cancelled" ? record.status : undefined;
  if (record.dialogStatus !== "open" && record.dialogStatus !== "closed") {
    throw new KestrelPresentationContractError("task.updated.payload.dialogMessage.dialogStatus is invalid.");
  }
  return {
    version: "v1",
    messageId: requireNonEmptyString(record.messageId, "task.updated.payload.dialogMessage.messageId"),
    dialogId: requireNonEmptyString(record.dialogId, "task.updated.payload.dialogMessage.dialogId"),
    name: requireNonEmptyString(record.name, "task.updated.payload.dialogMessage.name"),
    childSessionId: requireNonEmptyString(record.childSessionId, "task.updated.payload.dialogMessage.childSessionId"),
    sender,
    text: requireNonEmptyString(record.text, "task.updated.payload.dialogMessage.text"),
    createdAt: requireNonEmptyString(record.createdAt, "task.updated.payload.dialogMessage.createdAt"),
    dialogStatus: record.dialogStatus,
    ...(status !== undefined ? { status } : {}),
  };
}

function decodeTool(value: unknown, eventType: string): KestrelToolPresentation {
  const update = requireRecord(value, `${eventType}.payload.update`);
  const phase = requireNonEmptyString(update.phase, `${eventType}.payload.update.phase`);
  if (phase !== "started" && phase !== "completed" && phase !== "failed") {
    throw new KestrelPresentationContractError(`${eventType}.payload.update.phase is invalid.`);
  }
  const runId = requireNonEmptyString(update.runId, `${eventType}.payload.update.runId`);
  const toolCallId = requireNonEmptyString(update.toolCallId, `${eventType}.payload.update.toolCallId`);
  return {
    id: `tool:${runId}:${toolCallId}:${phase}`,
    runId,
    sequence: requireFiniteNumber(update.seq, `${eventType}.payload.update.seq`),
    timestamp: requireNonEmptyString(update.ts, `${eventType}.payload.update.ts`),
    toolCallId,
    toolName: requireNonEmptyString(update.toolName, `${eventType}.payload.update.toolName`),
    phase,
    ...(readNonEmptyString(update.displayName) !== undefined
      ? { displayName: readNonEmptyString(update.displayName) }
      : {}),
    ...(readNonEmptyString(update.provider) !== undefined
      ? { provider: readNonEmptyString(update.provider) }
      : {}),
    ...(Object.hasOwn(update, "input") ? { input: update.input } : {}),
    ...(Object.hasOwn(update, "output") ? { output: update.output } : {}),
    ...(isRecord(update.error) && typeof update.error.message === "string"
      ? {
          error: {
            ...(readNonEmptyString(update.error.code) !== undefined
              ? { code: readNonEmptyString(update.error.code) }
              : {}),
            message: update.error.message,
          },
        }
      : {}),
  };
}

function requireInteraction(value: unknown): RunnerInteractionRequestV1 & { requestId: string } {
  const interaction = requireRecord(value, "run.completed.payload.result.output.waitFor.interaction");
  const requestId = requireNonEmptyString(interaction.requestId, "interaction.requestId");
  const kind = interaction.kind;
  if (kind !== "user_input" && kind !== "approval") {
    throw new KestrelPresentationContractError("interaction.kind is invalid.");
  }
  return {
    ...interaction,
    version: "v1",
    requestId,
    kind,
    eventType: requireNonEmptyString(interaction.eventType, "interaction.eventType"),
    prompt: requireNonEmptyString(interaction.prompt, "interaction.prompt"),
  } as RunnerInteractionRequestV1 & { requestId: string };
}

function decodeCitations(value: unknown): KestrelCitationPresentation[] {
  const presentation = isRecord(value) ? value : undefined;
  if (!Array.isArray(presentation?.citations)) {
    return [];
  }
  return presentation.citations.map((value, index) => {
    const citation = requireRecord(value, `presentation.citations[${index}]`);
    return {
      id: requireNonEmptyString(citation.id, `presentation.citations[${index}].id`),
      title: requireNonEmptyString(citation.title, `presentation.citations[${index}].title`),
      ...(readNonEmptyString(citation.url) !== undefined ? { url: readNonEmptyString(citation.url) } : {}),
      ...(readNonEmptyString(citation.documentId) !== undefined
        ? { documentId: readNonEmptyString(citation.documentId) }
        : {}),
      ...(readNonEmptyString(citation.excerpt) !== undefined
        ? { excerpt: readNonEmptyString(citation.excerpt) }
        : {}),
    };
  });
}

function decodeArtifacts(value: unknown): KestrelArtifactPresentation[] {
  const presentation = isRecord(value) ? value : undefined;
  if (!Array.isArray(presentation?.artifacts)) {
    return [];
  }
  return presentation.artifacts.map((value, index) => {
    const artifact = requireRecord(value, `presentation.artifacts[${index}]`);
    return {
      id: requireNonEmptyString(artifact.id, `presentation.artifacts[${index}].id`),
      title: requireNonEmptyString(artifact.title, `presentation.artifacts[${index}].title`),
      kind: requireNonEmptyString(artifact.kind, `presentation.artifacts[${index}].kind`),
      ...(readNonEmptyString(artifact.url) !== undefined ? { url: readNonEmptyString(artifact.url) } : {}),
      ...(readNonEmptyString(artifact.mediaType) !== undefined
        ? { mediaType: readNonEmptyString(artifact.mediaType) }
        : {}),
      ...(isRecord(artifact.metadata) ? { metadata: artifact.metadata } : {}),
    };
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new KestrelPresentationContractError(`${label} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  const normalized = readNonEmptyString(value);
  if (normalized === undefined) {
    throw new KestrelPresentationContractError(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new KestrelPresentationContractError(`${label} must be a finite number.`);
  }
  return value;
}

function requireReasoningFormat(
  value: unknown,
  label: string,
): KestrelProviderReasoningPresentation["format"] {
  if (value === "summary" || value === "provider_thinking" || value === "provider_reasoning_text") {
    return value;
  }
  throw new KestrelPresentationContractError(`${label} is invalid.`);
}
