import {
  type KestrelInteractionPresentation,
  type KestrelPresentationSnapshot,
  type KestrelTerminalStatus,
  type KestrelUIMessage,
  writeKestrelFailureToUIMessage,
  writeKestrelRunnerStreamToUIMessage,
} from "@kestrel-agents/ai-sdk";
import type {
  KestrelAgent,
  KestrelAgentResumeInput,
  KestrelAgentTurnInput,
  KestrelRequestContext,
  RunnerHistoryEntry,
  RunnerRunStreamEvent,
  RunnerRunTerminalEvent,
  RunnerTelemetry,
  RunnerStream,
} from "@kestrel-agents/sdk";
import type { RunnerTurnAttachment } from "@kestrel-agents/protocol";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type InferUIMessageChunk,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import { buildKestrelOneCapabilityDescriptors } from "@/lib/agent/kestrel-capabilities";
import type { EnvironmentRuntimeModelSelection } from "@/lib/agent/kestrel-runtime-model";
import type { Session } from "@/lib/auth-types";
import type { ChatMessage } from "@/lib/types";
import type { KestrelOneInteractionMode } from "@/lib/turns/interaction-mode";
import {
  attachmentIdsFromMessageParts,
  resolveThreadAttachmentsForExecution,
} from "@/lib/attachments/store";

const DEFAULT_PROFILE_ID = "kestrel";
type KestrelUiStreamChunk = InferUIMessageChunk<ChatMessage>;

export type KestrelOneRequestCorrelation = {
  requestId: string;
  correlationId: string;
};

export type KestrelOneRuntimeContextInput = {
  session: Session;
  organizationId: string;
  correlation: KestrelOneRequestCorrelation;
};

export type KestrelOneRequestContext = KestrelRequestContext;

export type KestrelOneHistoryEntry = RunnerHistoryEntry;

export type KestrelOneAgentTurnInput = KestrelAgentTurnInput & {
  interactionMode: KestrelOneInteractionMode;
  signal?: AbortSignal;
  abortBehavior?: "cancel" | "detach" | undefined;
  resumeRequestId?: string | undefined;
};

export type KestrelOneRunnerStreamEvent = RunnerRunStreamEvent;
export type KestrelOneRunnerTerminalEvent = RunnerRunTerminalEvent;
export type KestrelOneRunnerCompletedEvent = Extract<
  RunnerRunTerminalEvent,
  { type: "run.completed" }
>;
export type KestrelOneRunnerFailedEvent = Extract<
  RunnerRunTerminalEvent,
  { type: "run.failed" }
>;
export type KestrelOneRunnerCancelledEvent = Extract<
  RunnerRunTerminalEvent,
  { type: "run.cancelled" }
>;

export type KestrelOneRunnerStream = RunnerStream<
  KestrelOneRunnerStreamEvent,
  KestrelOneRunnerTerminalEvent
>;

export type KestrelOneAgent = {
  stream: (
    input: KestrelOneAgentTurnInput,
    context: KestrelOneRequestContext,
    runtimeModel?: EnvironmentRuntimeModelSelection
  ) => KestrelOneRunnerStream | Promise<KestrelOneRunnerStream>;
  close: () => Promise<void>;
};

export function adaptKestrelAgentForKestrelOne(
  agent: KestrelAgent
): KestrelOneAgent {
  return {
    stream(input, context) {
      const {
        abortBehavior: _abortBehavior,
        resumeRequestId,
        ...agentInput
      } = input;
      if (resumeRequestId !== undefined) {
        return agent.resumeStream(
          {
            ...(agentInput as KestrelAgentResumeInput),
            requestId: resumeRequestId,
          },
          context
        );
      }
      return agent.stream(agentInput, context);
    },
    close() {
      return agent.close();
    },
  };
}

export type KestrelOneAgentResponsePersistMeta = {
  model: string;
  title: string | null;
  errorMessage: string | null;
  errorCode?: string | undefined;
  errorDetails?: Record<string, unknown> | undefined;
  failureVisible: boolean;
  terminalStatus: KestrelTerminalStatus;
  interaction: KestrelInteractionPresentation | null;
  assistantMessageId: string;
  runId: string | null;
  selectedInteractionMode: KestrelOneInteractionMode | null;
  telemetry: RunnerTelemetry | null;
};

export type KestrelOneAgentResponseInput = {
  request: Request;
  agent: KestrelOneAgent;
  ownsAgent: boolean;
  session: Session;
  organizationId: string;
  correlation: KestrelOneRequestCorrelation;
  threadId: string;
  durableTurnId?: string | undefined;
  noninteractive?: boolean | undefined;
  messages: UIMessage[];
  /** Resolved by the durable worker's web-owned attachment boundary. `null`
   * intentionally skips legacy in-process storage resolution during reattach. */
  resolvedAttachments?: RunnerTurnAttachment[] | null | undefined;
  threadFileInventory?: Array<{
    fileId: string;
    filename: string;
    mediaType: string | null;
    sizeBytes: number;
  }>;
  approvalDecision?:
    | {
        approvalId: string;
        approved: boolean;
        reason?: string | undefined;
      }
    | undefined;
  interactionResponse?:
    | {
        requestId: string;
        eventType: string;
        message: string;
        approved?: boolean | undefined;
        reason?: string | undefined;
        recoveryOptionId?: string | undefined;
      }
    | undefined;
  modelId?: string;
  interactionMode: KestrelOneInteractionMode;
  runtimeModel?: EnvironmentRuntimeModelSelection;
  projectContext?: {
    projectId: string;
    contextRevisionId: string;
    contextRevision: number;
    grantId: string;
    systemContext: string;
  };
  transientTitle?: Promise<string | null> | null;
  signal?: AbortSignal;
  abortBehavior?: "cancel" | "detach" | undefined;
  onUiChunk?: (chunk: KestrelUiStreamChunk) => void;
  onRuntimeEvent?: (event: RunnerRunStreamEvent) => void;
  onFinishPersist?: (
    messages: UIMessage[],
    meta: KestrelOneAgentResponsePersistMeta
  ) => Promise<void>;
};

export function createKestrelOneRequestContext(
  input: KestrelOneRuntimeContextInput
): KestrelOneRequestContext {
  const user = input.session.user as {
    id: string;
    name?: string | null;
    email?: string | null;
  };
  const displayName = user.name || user.email || user.id;

  return {
    actor: {
      actorId: user.id,
      actorType: "end_user",
      displayName,
      tenantId: input.organizationId,
    },
    tenantId: input.organizationId,
    durability: "continue_on_disconnect",
  };
}

export function createKestrelOneAgentResponseFromAgent(
  input: KestrelOneAgentResponseInput
) {
  const context = createKestrelOneRequestContext({
    session: input.session,
    organizationId: input.organizationId,
    correlation: input.correlation,
  });
  const interactionResponse =
    input.interactionResponse ??
    (input.approvalDecision !== undefined
      ? {
          requestId: input.approvalDecision.approvalId,
          eventType: "user.approval" as const,
          message: input.approvalDecision.approved ? "approve" : "deny",
          approved: input.approvalDecision.approved,
          ...(input.approvalDecision.reason !== undefined
            ? { reason: input.approvalDecision.reason }
            : {}),
        }
      : undefined);
  const latestUserMessage =
    interactionResponse?.message ?? getLatestUserText(input.messages);
  const attachmentIds = interactionResponse === undefined
    ? attachmentIdsFromMessageParts(input.messages.at(-1)?.parts)
    : [];
  const history = toKestrelHistory(input.messages.slice(0, -1));
  const assistantMessageId = crypto.randomUUID();
  const textPartId = crypto.randomUUID();
  let streamErrorMessage: string | null = null;
  const transientTitle =
    input.transientTitle?.catch((error: unknown) => {
      console.warn(
        "Transient chat title generation failed; continuing without a title.",
        {
          message:
            error instanceof Error ? error.message : "Unknown title error",
        }
      );
      return null;
    }) ?? null;

  const stream = createUIMessageStream({
    originalMessages: input.messages,
    execute: async ({ writer }) => {
      const mirroredWriter = input.onUiChunk
        ? {
            write(chunk: KestrelUiStreamChunk) {
              input.onUiChunk?.(chunk);
              writer.write(chunk);
            },
          }
        : writer;
      let streamResult: KestrelPresentationSnapshot;

      try {
        try {
          const attachments = input.resolvedAttachments === undefined
            ? await resolveThreadAttachmentsForExecution({
                attachmentIds,
                threadId: input.threadId,
                organizationId: input.organizationId,
                userId: input.session.user.id,
              })
            : input.resolvedAttachments ?? [];
          const fileInventory = input.threadFileInventory ?? [];
          const runStream = await input.agent.stream(
            {
              sessionId: input.threadId,
              message: latestUserMessage,
              eventType: interactionResponse?.eventType ?? "user.message",
              ...(input.noninteractive === true ? { noninteractive: true } : {}),
              interactionMode: input.interactionMode,
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(fileInventory.length > 0
                ? { systemInstructions: [formatThreadFileInventory(fileInventory)] }
                : {}),
              ...(interactionResponse !== undefined
                ? {
                    resumeRequestId: interactionResponse.requestId,
                    ...(interactionResponse.recoveryOptionId !== undefined
                      ? { recoveryOptionId: interactionResponse.recoveryOptionId }
                      : {}),
                  }
                : {}),
              history,
              ...(input.projectContext
                ? {
                    projectContext: {
                      projectId: input.projectContext.projectId,
                      contextRevisionId: input.projectContext.contextRevisionId,
                      contextRevision: input.projectContext.contextRevision,
                      content: input.projectContext.systemContext,
                    },
                  }
                : {}),
              clientCapabilities: {
                kestrelOne: {
                  requestId: input.correlation.requestId,
                  correlationId: input.correlation.correlationId,
                  tenantId: input.organizationId,
                  ...(input.projectContext
                    ? {
                        projectId: input.projectContext.projectId,
                        contextRevisionId:
                          input.projectContext.contextRevisionId,
                        contextRevision: input.projectContext.contextRevision,
                        contextGrantId: input.projectContext.grantId,
                      }
                    : {}),
                  capabilities: buildKestrelOneCapabilityDescriptors({
                    request: input.request,
                    threadId: input.threadId,
                  }),
                },
              },
              signal: input.signal ?? input.request.signal,
              abortBehavior: input.abortBehavior,
            },
            context,
            input.runtimeModel
          );

          streamResult = await writeKestrelRunnerStreamToUIMessage({
            writer: mirroredWriter as UIMessageStreamWriter<KestrelUIMessage>,
            events: runStream,
            terminalEvent: runStream.result,
            assistantMessageId,
            textPartId,
            ...(input.durableTurnId !== undefined
              ? { turnId: input.durableTurnId }
              : {}),
            interactionMode: input.interactionMode,
            onEvent: input.onRuntimeEvent,
          });
        } catch (error) {
          streamResult = await writeKestrelFailureToUIMessage({
            writer: mirroredWriter as UIMessageStreamWriter<KestrelUIMessage>,
            error,
            assistantMessageId,
            textPartId,
            ...(input.durableTurnId !== undefined
              ? { turnId: input.durableTurnId }
              : {}),
          });
        }
      } finally {
        if (input.ownsAgent) {
          await input.agent.close();
        }
      }

      streamErrorMessage = streamResult.errorMessage;

      const title = await transientTitle;
      if (title) {
        mirroredWriter.write({
          type: "data-chat-title",
          data: { title },
          transient: true,
        });
      }

      const requestedInteractionMode = readRequestedInteractionMode(
        streamResult.finalizedPayload
      ) ?? readInteractionModeSwitch(streamResult.interaction?.metadata);
      if (requestedInteractionMode) {
        mirroredWriter.write({
          type: "data-interaction-mode",
          data: { mode: requestedInteractionMode },
          transient: true,
        });
      }

      mirroredWriter.write({ type: "finish", finishReason: "stop" });

      await input.onFinishPersist?.([streamResult.message], {
        model:
          input.modelId ||
          process.env.KESTREL_ONE_PROFILE_ID?.trim() ||
          DEFAULT_PROFILE_ID,
        title: title ?? null,
        errorMessage: streamResult.errorMessage,
        errorCode: streamResult.errorCode,
        errorDetails: streamResult.errorDetails,
        failureVisible: streamResult.failureVisible,
        terminalStatus: streamResult.terminalStatus,
        interaction: streamResult.interaction,
        assistantMessageId: streamResult.message.id,
        runId: streamResult.message.metadata?.kestrelRunId ?? null,
        selectedInteractionMode: requestedInteractionMode,
        telemetry: null,
      });
    },
    onError: (error) => {
      streamErrorMessage =
        error instanceof Error
          ? error.message
          : "The Kestrel runtime failed before it could finish.";
      return streamErrorMessage;
    },
  });

  return createUIMessageStreamResponse({ stream });
}

export function readRequestedInteractionMode(
  finalizedPayload: unknown
): KestrelOneInteractionMode | null {
  if (!finalizedPayload || typeof finalizedPayload !== "object") {
    return null;
  }
  const finalized = finalizedPayload as Record<string, unknown>;
  const payload =
    finalized.payload && typeof finalized.payload === "object"
      ? (finalized.payload as Record<string, unknown>)
      : finalized;
  const data =
    payload.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : null;
  const modeSwitch =
    data?.modeSwitch && typeof data.modeSwitch === "object"
      ? (data.modeSwitch as Record<string, unknown>)
      : null;
  return readInteractionModeSwitch(modeSwitch);
}

export function readInteractionModeSwitch(
  value: unknown
): KestrelOneInteractionMode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const nested =
    record.modeSwitch &&
    typeof record.modeSwitch === "object" &&
    !Array.isArray(record.modeSwitch)
      ? (record.modeSwitch as Record<string, unknown>)
      : record;
  const mode = nested.mode;
  return mode === "chat" || mode === "plan" || mode === "build" ? mode : null;
}

function getLatestUserText(messages: UIMessage[]): string {
  const latest = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const text = latest ? getMessageText(latest) : "";
  return text;
}

function formatThreadFileInventory(files: Array<{
  fileId: string;
  filename: string;
  mediaType: string | null;
  sizeBytes: number;
}>): string {
  const entries = files.map((file) =>
    `- ${file.fileId}: ${JSON.stringify(file.filename)} (${file.mediaType ?? "application/octet-stream"}, ${file.sizeBytes} bytes)`,
  );
  return [
    "Files previously attached in this Thread remain visible for its lifetime.",
    "Use kestrel.files.search to find visible Thread, Project, or organization files and kestrel.files.open to inspect one by stable file ID.",
    ...entries,
  ].join("\n");
}

function toKestrelHistory(messages: UIMessage[]): RunnerHistoryEntry[] {
  return messages
    .filter(
      (message): message is UIMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant"
    )
    .map((message) => ({
      role: message.role,
      text: getMessageText(message),
      timestamp: new Date().toISOString(),
    }))
    .filter((entry) => entry.text.length > 0);
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .map((part) => {
      if (
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}
