import type {
  KestrelAgent,
  KestrelAgentResumeInput,
  KestrelAgentTurnInput,
  KestrelRequestContext,
  RunnerHistoryEntry,
  RunnerStream,
  RunnerRunStreamEvent,
  RunnerRunTerminalEvent,
} from "@kestrel-agents/sdk";
import {
  writeKestrelFailureToUIMessage,
  writeKestrelRunnerStreamToUIMessage,
  type KestrelPresentationSnapshot,
  type KestrelInteractionPresentation,
  type KestrelTerminalStatus,
  type KestrelUIMessage,
} from "@kestrel-agents/ai-sdk";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type InferUIMessageChunk,
  type UIMessageStreamWriter,
  type UIMessage,
} from "ai";
import { buildKestrelOneCapabilityDescriptors } from "@/lib/agent/kestrel-capabilities";
import type { KestrelOneRuntimeModelSelection } from "@/lib/agent/kestrel-runtime-model";
import type { ChatMessage } from "@/lib/types";
import type { Session } from "@/lib/auth-types";

const DEFAULT_PROFILE_ID = "kestrel-one";
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
  signal?: AbortSignal;
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
    runtimeModel?: KestrelOneRuntimeModelSelection
  ) => KestrelOneRunnerStream | Promise<KestrelOneRunnerStream>;
  close: () => Promise<void>;
};

export function adaptKestrelAgentForKestrelOne(
  agent: KestrelAgent
): KestrelOneAgent {
  return {
    stream(input, context) {
      if (input.resumeRequestId !== undefined) {
        const { resumeRequestId, ...turn } = input;
        return agent.resumeStream(
          {
            ...(turn as KestrelAgentResumeInput),
            requestId: resumeRequestId,
          },
          context,
        );
      }
      return agent.stream(input, context);
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
  failureVisible: boolean;
  terminalStatus: KestrelTerminalStatus;
  interaction: KestrelInteractionPresentation | null;
  assistantMessageId: string;
  runId: string | null;
};

export type KestrelOneAgentResponseInput = {
  request: Request;
  agent: KestrelOneAgent;
  ownsAgent: boolean;
  session: Session;
  organizationId: string;
  correlation: KestrelOneRequestCorrelation;
  threadId: string;
  messages: UIMessage[];
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
      }
    | undefined;
  modelId?: string;
  runtimeModel?: KestrelOneRuntimeModelSelection;
  projectContext?: {
    projectId: string;
    contextRevisionId: string;
    contextRevision: number;
    grantId: string;
    systemContext: string;
  };
  transientTitle?: Promise<string | null> | null;
  signal?: AbortSignal;
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
          const runStream = await input.agent.stream(
          {
            sessionId: input.threadId,
            message: latestUserMessage,
            eventType: interactionResponse?.eventType ?? "user.message",
            ...(interactionResponse !== undefined
              ? { resumeRequestId: interactionResponse.requestId }
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
                      contextRevisionId: input.projectContext.contextRevisionId,
                      contextRevision: input.projectContext.contextRevision,
                      contextGrantId: input.projectContext.grantId,
                    }
                  : {}),
                capabilities: buildKestrelOneCapabilityDescriptors({
                  request: input.request,
                }),
              },
            },
            signal: input.signal ?? input.request.signal,
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
            onEvent: input.onRuntimeEvent,
          });
        } catch (error) {
          streamResult = await writeKestrelFailureToUIMessage({
            writer: mirroredWriter as UIMessageStreamWriter<KestrelUIMessage>,
            error,
            assistantMessageId,
            textPartId,
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

      mirroredWriter.write({ type: "finish", finishReason: "stop" });

      await input.onFinishPersist?.(
        [streamResult.message],
        {
          model:
            input.modelId ||
            process.env.KESTREL_ONE_PROFILE_ID?.trim() ||
            DEFAULT_PROFILE_ID,
          title: title ?? null,
          errorMessage: streamResult.errorMessage,
          failureVisible: streamResult.failureVisible,
          terminalStatus: streamResult.terminalStatus,
          interaction: streamResult.interaction,
          assistantMessageId: streamResult.message.id,
          runId: streamResult.message.metadata?.kestrelRunId ?? null,
        }
      );
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

function getLatestUserText(messages: UIMessage[]): string {
  const latest = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const text = latest ? getMessageText(latest) : "";
  return text || "Continue.";
}

function toKestrelHistory(messages: UIMessage[]): RunnerHistoryEntry[] {
  return messages
    .filter(
      (
        message
      ): message is UIMessage & { role: "user" | "assistant" } =>
        message.role === "user" ||
        message.role === "assistant"
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
