import type {
  KestrelAgent,
  KestrelAgentTurnInput,
  KestrelRequestContext,
  RunnerHistoryEntry,
  RunnerStream,
  RunnerStreamEvent,
} from "@kestrel-agents/sdk";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { buildKestrelOneCapabilityDescriptors } from "@/lib/agent/kestrel-capabilities";
import type { KestrelOneRuntimeModelSelection } from "@/lib/agent/kestrel-runtime-model";
import type { KestrelTerminalStatus } from "@/lib/agent/kestrel-stream-events";
import { writeKestrelRunnerEventsToUi } from "@/lib/agent/kestrel-ui-stream";
import type { Session } from "@/lib/auth-types";

const DEFAULT_PROFILE_ID = "kestrel-one";

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
};

export type KestrelOneRunnerStreamEvent = {
  type: RunnerStreamEvent["type"];
  payload?: unknown;
  id?: RunnerStreamEvent["id"];
  ts?: RunnerStreamEvent["ts"];
  runId?: RunnerStreamEvent["runId"];
  sessionId?: RunnerStreamEvent["sessionId"];
  threadId?: RunnerStreamEvent["threadId"];
  commandId?: RunnerStreamEvent["commandId"];
};

export type KestrelOneRunnerCompletedEvent = KestrelOneRunnerStreamEvent & {
  type: "run.completed";
};

export type KestrelOneRunnerFailedEvent = KestrelOneRunnerStreamEvent & {
  type: "run.failed";
};

export type KestrelOneRunnerCancelledEvent = KestrelOneRunnerStreamEvent & {
  type: "run.cancelled";
};

export type KestrelOneRunnerTerminalEvent =
  | KestrelOneRunnerCompletedEvent
  | KestrelOneRunnerFailedEvent
  | KestrelOneRunnerCancelledEvent;

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
  const latestUserMessage = getLatestUserText(input.messages);
  const history = toKestrelHistory(input.messages.slice(0, -1));
  const assistantMessageId = crypto.randomUUID();
  const textPartId = crypto.randomUUID();
  const reasoningPartId = crypto.randomUUID();
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
      let streamResult = {
        finalText: "",
        errorMessage: null as string | null,
        failureVisible: false,
        terminalStatus: "empty" as KestrelTerminalStatus,
      };

      try {
        const runStream = await input.agent.stream(
          {
            sessionId: input.threadId,
            message: latestUserMessage,
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
            signal: input.request.signal,
          },
          context,
          input.runtimeModel
        );

        streamResult = await writeKestrelRunnerEventsToUi({
          writer,
          events: runStream,
          terminalEvent: runStream.result,
          assistantMessageId,
          textPartId,
          reasoningPartId,
        });
      } finally {
        if (input.ownsAgent) {
          await input.agent.close();
        }
      }

      streamErrorMessage = streamResult.errorMessage;

      const title = await transientTitle;
      if (title) {
        writer.write({
          type: "data-chat-title",
          data: { title },
          transient: true,
        });
      }

      writer.write({ type: "finish", finishReason: "stop" });

      await input.onFinishPersist?.(
        [
          {
            id: assistantMessageId,
            role: "assistant",
            parts: [{ type: "text", text: streamResult.finalText }],
          },
        ],
        {
          model:
            input.modelId ||
            process.env.KESTREL_ONE_PROFILE_ID?.trim() ||
            DEFAULT_PROFILE_ID,
          title: title ?? null,
          errorMessage: streamResult.errorMessage,
          failureVisible: streamResult.failureVisible,
          terminalStatus: streamResult.terminalStatus,
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
