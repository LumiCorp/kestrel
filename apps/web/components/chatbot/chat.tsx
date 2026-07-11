"use client";

import { type UseChatHelpers, useChat } from "@ai-sdk/react";
import {
  type DataUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessagePart,
} from "ai";
import { formatISO } from "date-fns";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { ChatHeader } from "@/components/chatbot/chat-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/chatbot/ui/alert-dialog";
import { useArtifact, useArtifactSelector } from "@/hooks/use-artifact";
import { useChatVisibility } from "@/hooks/use-chat-visibility";
import { CompatibleChatTransport } from "@/lib/chat/compatible-chat-transport";
import {
  clearChatFirstTurnHandoff,
  readChatFirstTurnHandoff,
  writeChatFirstTurnHandoff,
} from "@/lib/chat/first-turn-handoff";
import { ChatbotError } from "@/lib/errors";
import type {
  Attachment,
  ChatFirstTurnHandoff,
  ChatMessage,
  ChatTools,
  CustomUIDataTypes,
  MessageFeedback,
} from "@/lib/types";
import { fetchWithErrorHandlers, generateUUID } from "@/lib/utils";
import { Artifact } from "./artifact";
import { useDataStream } from "./data-stream-provider";
import { Messages } from "./messages";
import { MultimodalInput } from "./multimodal-input";
import { getChatHistoryPaginationKey } from "./sidebar-history";
import { toast } from "./toast";
import type { VisibilityType } from "./visibility-selector";

type ChatController = {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  clearError: UseChatHelpers<ChatMessage>["clearError"];
  messages: ChatMessage[];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  status: UseChatHelpers<ChatMessage>["status"];
};

function createChatTransport(currentModelIdRef: { current: string }) {
  return new CompatibleChatTransport<ChatMessage>({
    api: "/api/chats",
    fetch: fetchWithErrorHandlers as typeof fetch,
    prepareSendMessagesRequest(request) {
      return {
        api: `/api/chats/${request.id}`,
        body: {
          model: currentModelIdRef.current,
          messages: request.messages,
          ...request.body,
        },
      };
    },
    prepareReconnectToStreamRequest({ id }) {
      return {
        api: `/api/chats/${id}/stream`,
      };
    },
  });
}

function buildFeedbackByMessageId(input: {
  chatId: string;
  feedbackOverrides: Record<string, "positive" | "negative" | null>;
  messages: ChatMessage[];
}) {
  return input.messages.reduce<Record<string, MessageFeedback | undefined>>(
    (accumulator, message) => {
      if (message.role !== "assistant") {
        return accumulator;
      }

      const feedback =
        input.feedbackOverrides[message.id] ??
        message.metadata?.feedback ??
        null;

      accumulator[message.id] = {
        chatId: input.chatId,
        messageId: message.id,
        feedback,
      };

      return accumulator;
    },
    {}
  );
}

function createHandoffMessage(
  handoff: ChatFirstTurnHandoff | null | undefined
): ChatMessage | null {
  if (!handoff || handoff.messageParts.length === 0) {
    return null;
  }

  return {
    id: handoff.messageId,
    role: "user",
    parts: handoff.messageParts,
    metadata: {
      createdAt: formatISO(new Date(handoff.createdAt)),
    },
  };
}

function mergeMessagesWithHandoff(
  messages: ChatMessage[],
  handoff: ChatFirstTurnHandoff | null | undefined
) {
  if (
    !handoff ||
    messages.some((message) => message.id === handoff.messageId)
  ) {
    return messages;
  }

  const handoffMessage = createHandoffMessage(handoff);
  if (!handoffMessage) {
    return messages;
  }

  return [...messages, handoffMessage];
}

function isUserPartsMessage(
  message: Parameters<UseChatHelpers<ChatMessage>["sendMessage"]>[0]
): message is { role: "user"; parts: ChatMessage["parts"]; id?: string } {
  const candidate = message as { role?: string; parts?: unknown } | undefined;

  return Boolean(
    candidate &&
      typeof candidate === "object" &&
      Array.isArray(candidate.parts) &&
      (candidate.role ?? "user") === "user"
  );
}

function useSharedChatState(initialChatModel: string, chatId: string) {
  const { setDataStream } = useDataStream(chatId);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showCreditCardAlert, setShowCreditCardAlert] = useState(false);
  const [currentModelId, setCurrentModelId] = useState(initialChatModel);
  const currentModelIdRef = useRef(currentModelId);
  const [feedbackOverrides, setFeedbackOverrides] = useState<
    Record<string, "positive" | "negative" | null>
  >({});

  useEffect(() => {
    currentModelIdRef.current = currentModelId;
  }, [currentModelId]);

  return {
    attachments,
    currentModelId,
    currentModelIdRef,
    feedbackOverrides,
    input,
    setAttachments,
    setCurrentModelId,
    setDataStream,
    setFeedbackOverrides,
    setInput,
    setShowCreditCardAlert,
    showCreditCardAlert,
  };
}

function useChatCallbacks(input: {
  currentModelId: string;
  currentModelIdRef: { current: string };
  hasShownResumeWarningRef?: { current: boolean };
  hasShownResumedToastRef?: { current: boolean };
  hasShownStreamWarningRef?: { current: boolean };
  mutate: ReturnType<typeof useSWRConfig>["mutate"];
  setDataStream: Dispatch<SetStateAction<unknown[]>>;
  setShowCreditCardAlert: Dispatch<SetStateAction<boolean>>;
}) {
  return {
    onData: (dataPart: DataUIPart<CustomUIDataTypes>) => {
      if (dataPart.type === "data-stream-resumed") {
        if (
          input.hasShownResumedToastRef &&
          !input.hasShownResumedToastRef.current
        ) {
          input.hasShownResumedToastRef.current = true;
          toast({
            type: "success",
            description: "Resumed the in-progress response.",
          });
        }
        return;
      }

      if (dataPart.type === "data-resume-warning") {
        if (
          input.hasShownResumeWarningRef &&
          !input.hasShownResumeWarningRef.current
        ) {
          input.hasShownResumeWarningRef.current = true;
          toast({
            type: "warning",
            description:
              dataPart.data?.message ??
              "Response recovery is temporarily unavailable.",
          });
        }
        return;
      }

      if (dataPart.type === "data-stream-warning") {
        if (
          input.hasShownStreamWarningRef &&
          !input.hasShownStreamWarningRef.current
        ) {
          input.hasShownStreamWarningRef.current = true;
          toast({
            type: "warning",
            description:
              "Some advanced stream details were skipped, but the response continued.",
          });
        }
        return;
      }

      input.setDataStream((current) => [...current, dataPart]);
    },
    onFinish: () => {
      input.mutate(unstable_serialize(getChatHistoryPaginationKey));
    },
    onError: (error: unknown) => {
      input.setDataStream([]);

      if (
        error instanceof Error &&
        error.message?.includes("AI Gateway requires a valid credit card")
      ) {
        input.setShowCreditCardAlert(true);
        return;
      }

      if (error instanceof ChatbotError) {
        toast({
          type: "error",
          description: error.message,
        });
        return;
      }

      toast({
        type: "error",
        description:
          error instanceof Error ? error.message : "Oops, an error occurred!",
      });
    },
  };
}

function ChatShell({
  addToolApprovalResponse,
  attachments,
  chatId,
  clearError,
  currentModelId,
  feedbackByMessageId,
  headerReadonly,
  input,
  isReadonly,
  messages,
  onFeedbackChange,
  onModelChange,
  regenerate,
  selectedVisibilityType,
  sendMessage,
  setAttachments,
  setInput,
  setMessages,
  showPendingAssistant,
  status,
}: {
  addToolApprovalResponse: ChatController["addToolApprovalResponse"];
  attachments: Attachment[];
  chatId: string;
  clearError: () => void;
  currentModelId: string;
  feedbackByMessageId: Record<string, MessageFeedback | undefined>;
  headerReadonly: boolean;
  input: string;
  isReadonly: boolean;
  messages: ChatMessage[];
  onFeedbackChange: (
    messageId: string,
    feedback: "positive" | "negative" | null
  ) => void;
  onModelChange: (modelId: string) => void;
  regenerate: ChatController["regenerate"];
  selectedVisibilityType: VisibilityType;
  sendMessage: ChatController["sendMessage"];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  setInput: Dispatch<SetStateAction<string>>;
  setMessages: ChatController["setMessages"];
  showPendingAssistant?: boolean;
  status: ChatController["status"];
}) {
  const isArtifactVisible = useArtifactSelector((state) => state.isVisible);

  return (
    <>
      <div className="overscroll-behavior-contain flex h-dvh min-w-0 touch-pan-y flex-col bg-background">
        <ChatHeader
          chatId={chatId}
          isReadonly={headerReadonly}
          selectedVisibilityType={selectedVisibilityType}
        />

        <Messages
          addToolApprovalResponse={addToolApprovalResponse}
          chatId={chatId}
          feedbackByMessageId={feedbackByMessageId}
          isArtifactVisible={isArtifactVisible}
          isReadonly={isReadonly}
          messages={messages}
          onFeedbackChange={onFeedbackChange}
          regenerate={regenerate}
          selectedModelId={currentModelId}
          setMessages={setMessages}
          showPendingAssistant={showPendingAssistant}
          status={status}
        />

        <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 bg-background px-2 pb-3 md:px-4 md:pb-4">
          {!isReadonly && (
            <MultimodalInput
              attachments={attachments}
              chatId={chatId}
              clearError={clearError}
              input={input}
              messages={messages}
              onModelChange={onModelChange}
              selectedModelId={currentModelId}
              selectedVisibilityType={selectedVisibilityType}
              sendMessage={sendMessage}
              setAttachments={setAttachments}
              setInput={setInput}
              setMessages={setMessages}
              status={status}
            />
          )}
        </div>
      </div>

      <Artifact
        addToolApprovalResponse={addToolApprovalResponse}
        chatId={chatId}
        feedbackByMessageId={feedbackByMessageId}
        isReadonly={isReadonly}
        messages={messages}
        onFeedbackChange={onFeedbackChange}
        regenerate={regenerate}
        selectedVisibilityType={selectedVisibilityType}
        sendMessage={sendMessage}
        setMessages={setMessages}
        status={status}
      />
    </>
  );
}

function ChatAlerts({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Activate AI Gateway</AlertDialogTitle>
          <AlertDialogDescription>
            This application requires{" "}
            {process.env.NODE_ENV === "production" ? "the owner" : "you"} to
            activate Vercel AI Gateway.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              window.open(
                "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card",
                "_blank"
              );
              window.location.href = "/";
            }}
          >
            Activate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function BootstrapChat({
  id,
  initialChatModel,
}: {
  id: string;
  initialChatModel: string;
}) {
  const router = useRouter();
  const { resetArtifact, setMetadata } = useArtifact();
  const shared = useSharedChatState(initialChatModel, id);
  const hasStartedHandoffRef = useRef(false);
  const searchParams = useSearchParams();
  const query = searchParams.get("query");
  const [hasAppendedQuery, setHasAppendedQuery] = useState(false);

  useEffect(() => {
    resetArtifact();
    setMetadata(null);
    shared.setDataStream([]);
    // Only reset ephemeral UI state when a fresh bootstrap chat id is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const sendBootstrapMessage: ChatController["sendMessage"] = async (
    message,
    _options
  ) => {
    if (
      !message ||
      hasStartedHandoffRef.current ||
      !isUserPartsMessage(message)
    ) {
      return;
    }

    hasStartedHandoffRef.current = true;

    const messageId = message.id ?? generateUUID();
    const userMessage: ChatMessage = {
      id: messageId,
      role: "user",
      parts: message.parts as UIMessagePart<CustomUIDataTypes, ChatTools>[],
    };

    writeChatFirstTurnHandoff({
      chatId: id,
      messageId,
      messageParts: userMessage.parts,
      modelId: shared.currentModelIdRef.current,
      createdAt: Date.now(),
      pendingAssistant: true,
    });

    router.replace(`/chat/${id}`);
  };

  useEffect(() => {
    if (query && !hasAppendedQuery) {
      void sendBootstrapMessage({
        role: "user",
        parts: [{ type: "text", text: query }],
      });

      setHasAppendedQuery(true);
    }
  }, [query, hasAppendedQuery, sendBootstrapMessage]);

  return (
    <>
      <ChatShell
        addToolApprovalResponse={async () => {}}
        attachments={shared.attachments}
        chatId={id}
        clearError={() => {
          shared.setDataStream([]);
        }}
        currentModelId={shared.currentModelId}
        feedbackByMessageId={{}}
        headerReadonly={true}
        input={shared.input}
        isReadonly={false}
        messages={[]}
        onFeedbackChange={() => {}}
        onModelChange={shared.setCurrentModelId}
        regenerate={async () => {}}
        selectedVisibilityType="private"
        sendMessage={sendBootstrapMessage}
        setAttachments={shared.setAttachments}
        setInput={shared.setInput}
        setMessages={() => {}}
        showPendingAssistant={false}
        status="ready"
      />
      <ChatAlerts
        open={shared.showCreditCardAlert}
        setOpen={shared.setShowCreditCardAlert}
      />
    </>
  );
}

export function Chat({
  id,
  initialMessages,
  initialChatModel,
  initialVisibilityType,
  initialShareToken,
  initialChatExists,
  isReadonly,
}: {
  id: string;
  initialMessages: ChatMessage[];
  initialChatModel: string;
  initialVisibilityType: VisibilityType;
  initialShareToken?: string | null;
  initialChatExists: boolean;
  isReadonly: boolean;
}) {
  const router = useRouter();
  const { resetArtifact, setMetadata } = useArtifact();
  const { setDataStream } = useDataStream(id);
  const { visibilityType } = useChatVisibility({
    chatId: id,
    initialVisibilityType,
    initialShareToken,
  });
  const { mutate } = useSWRConfig();
  const shared = useSharedChatState(initialChatModel, id);
  const hasShownResumeWarningRef = useRef(false);
  const hasShownResumedToastRef = useRef(false);
  const hasShownStreamWarningRef = useRef(false);
  const hasStartedHandoffRequestRef = useRef(false);
  const [handoff, setHandoff] = useState<
    ChatFirstTurnHandoff | null | undefined
  >(undefined);

  useEffect(() => {
    hasStartedHandoffRequestRef.current = false;
    resetArtifact();
    setMetadata(null);
    setDataStream([]);
    // Reset scoped ephemeral state when navigating to a different chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    setHandoff(readChatFirstTurnHandoff(id));
  }, [id]);

  useEffect(() => {
    if (handoff?.modelId) {
      shared.setCurrentModelId(handoff.modelId);
    }
  }, [handoff?.modelId, shared.setCurrentModelId]);

  const callbacks = useChatCallbacks({
    currentModelId: shared.currentModelId,
    currentModelIdRef: shared.currentModelIdRef,
    hasShownResumeWarningRef,
    hasShownResumedToastRef,
    hasShownStreamWarningRef,
    mutate,
    setDataStream: shared.setDataStream as Dispatch<SetStateAction<unknown[]>>,
    setShowCreditCardAlert: shared.setShowCreditCardAlert,
  });

  const controller = useChat<ChatMessage>({
    id,
    messages: initialMessages,
    resume: initialChatExists,
    generateId: generateUUID,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    transport: createChatTransport(shared.currentModelIdRef),
    ...callbacks,
  });

  const handoffMessage = useMemo(
    () => createHandoffMessage(handoff),
    [handoff]
  );

  useEffect(() => {
    const hasPersistedFirstUserMessage =
      initialChatExists &&
      handoff &&
      controller.messages.some((message) => message.id === handoff.messageId);
    const hasAssistantResponse = controller.messages.some(
      (message) => message.role === "assistant"
    );

    if (handoff && (hasPersistedFirstUserMessage || hasAssistantResponse)) {
      clearChatFirstTurnHandoff(id);
      setHandoff(null);
    }
  }, [handoff, id, initialChatExists, controller.messages]);

  useEffect(() => {
    if (controller.status === "submitted") {
      hasShownResumedToastRef.current = false;
      hasShownStreamWarningRef.current = false;
      hasShownResumeWarningRef.current = false;
    }
  }, [controller.status]);

  useEffect(() => {
    if (
      controller.status === "error" &&
      handoff &&
      !controller.messages.some((message) => message.id === handoff.messageId)
    ) {
      hasStartedHandoffRequestRef.current = false;
    }
  }, [controller.messages, controller.status, handoff]);

  useEffect(() => {
    if (!(handoff && handoffMessage)) {
      return;
    }

    if (hasStartedHandoffRequestRef.current) {
      return;
    }

    if (
      controller.messages.some((message) => message.id === handoff.messageId)
    ) {
      return;
    }

    if (controller.status !== "ready") {
      return;
    }

    hasStartedHandoffRequestRef.current = true;
    void controller.sendMessage(handoffMessage);
  }, [
    controller.messages,
    controller.sendMessage,
    controller.status,
    handoff,
    handoffMessage,
  ]);

  useEffect(() => {
    if (initialChatExists || handoff !== null) {
      return;
    }

    if (
      hasStartedHandoffRequestRef.current ||
      controller.status !== "ready" ||
      controller.messages.length > 0
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (!hasStartedHandoffRequestRef.current) {
        router.replace("/chat");
      }
    }, 400);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    controller.messages.length,
    controller.status,
    handoff,
    initialChatExists,
    router,
  ]);

  const feedbackByMessageId = useMemo(
    () =>
      buildFeedbackByMessageId({
        chatId: id,
        feedbackOverrides: shared.feedbackOverrides,
        messages: controller.messages,
      }),
    [id, shared.feedbackOverrides, controller.messages]
  );

  const displayMessages = useMemo(
    () => mergeMessagesWithHandoff(controller.messages, handoff),
    [controller.messages, handoff]
  );
  const showPendingAssistant =
    Boolean(handoff?.pendingAssistant) &&
    controller.status === "ready" &&
    !controller.messages.some((message) => message.role === "assistant");

  if (!initialChatExists && handoff === undefined) {
    return null;
  }

  if (!(initialChatExists || handoff)) {
    return null;
  }

  return (
    <>
      <ChatShell
        addToolApprovalResponse={controller.addToolApprovalResponse}
        attachments={shared.attachments}
        chatId={id}
        clearError={() => {
          controller.clearError();
          shared.setDataStream([]);
        }}
        currentModelId={shared.currentModelId}
        feedbackByMessageId={feedbackByMessageId}
        headerReadonly={isReadonly}
        input={shared.input}
        isReadonly={isReadonly}
        messages={displayMessages}
        onFeedbackChange={(messageId, feedback) => {
          shared.setFeedbackOverrides((current) => ({
            ...current,
            [messageId]: feedback,
          }));
        }}
        onModelChange={shared.setCurrentModelId}
        regenerate={controller.regenerate}
        selectedVisibilityType={visibilityType}
        sendMessage={controller.sendMessage}
        setAttachments={shared.setAttachments}
        setInput={shared.setInput}
        setMessages={controller.setMessages}
        showPendingAssistant={showPendingAssistant}
        status={controller.status}
      />
      <ChatAlerts
        open={shared.showCreditCardAlert}
        setOpen={shared.setShowCreditCardAlert}
      />
    </>
  );
}
