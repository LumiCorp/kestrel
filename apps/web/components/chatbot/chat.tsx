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
  useCallback,
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
import {
  emptyThreadConversationState,
  type ThreadConversationState,
  threadConversationStateSchema,
} from "@/lib/turns/client-contract";
import {
  DEFAULT_KESTREL_ONE_INTERACTION_MODE,
  type KestrelOneInteractionMode,
} from "@/lib/turns/interaction-mode";
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
import {
  InteractionPanel,
  type RuntimeInteractionResponse,
} from "./interaction-panel";
import { Messages } from "./messages";
import { MultimodalInput } from "./multimodal-input";
import { getThreadHistoryPaginationKey } from "./sidebar-history";
import { ThreadRouteLoading } from "./thread-route-loading";
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

function createChatTransport(
  currentModelIdRef: { current: string },
  interactionModeRef: { current: KestrelOneInteractionMode },
  resumeTurnIdRef: { current: string | null },
  onSuccessfulResponse?: (response: Response) => void
) {
  return new CompatibleChatTransport<ChatMessage>({
    api: "/api/threads",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetchWithErrorHandlers(input, init);
      onSuccessfulResponse?.(response);
      return response;
    }) as typeof fetch,
    prepareSendMessagesRequest(request) {
      return {
        api: `/api/threads/${request.id}`,
        body: {
          model: currentModelIdRef.current,
          interactionMode: interactionModeRef.current,
          messages: request.messages,
          ...request.body,
        },
      };
    },
    prepareReconnectToStreamRequest({ id }) {
      const turnId = resumeTurnIdRef.current;
      return {
        api: `/api/threads/${id}/stream${
          turnId ? `?turnId=${encodeURIComponent(turnId)}` : ""
        }`,
      };
    },
  });
}

type QueuedUserMessage = {
  message: ChatMessage;
  turnId: string | null;
};

function buildFeedbackByMessageId(input: {
  threadId: string;
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
        threadId: input.threadId,
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

function useSharedChatState(initialChatModel: string, threadId: string) {
  const { setDataStream } = useDataStream(threadId);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showCreditCardAlert, setShowCreditCardAlert] = useState(false);
  const [currentModelId, setCurrentModelId] = useState(initialChatModel);
  const currentModelIdRef = useRef(currentModelId);
  const [interactionMode, setInteractionMode] = useState<KestrelOneInteractionMode>(
    DEFAULT_KESTREL_ONE_INTERACTION_MODE
  );
  const interactionModeRef = useRef(interactionMode);
  const [feedbackOverrides, setFeedbackOverrides] = useState<
    Record<string, "positive" | "negative" | null>
  >({});

  useEffect(() => {
    currentModelIdRef.current = currentModelId;
  }, [currentModelId]);

  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);

  useEffect(() => {
    setInteractionMode(DEFAULT_KESTREL_ONE_INTERACTION_MODE);
  }, [threadId]);

  return {
    attachments,
    currentModelId,
    currentModelIdRef,
    feedbackOverrides,
    input,
    interactionMode,
    interactionModeRef,
    setAttachments,
    setCurrentModelId,
    setDataStream,
    setFeedbackOverrides,
    setInput,
    setInteractionMode,
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
  refreshConversationState?: () => Promise<void>;
  setDataStream: Dispatch<SetStateAction<unknown[]>>;
  setThreadTitle: (title: string) => void;
  threadId: string;
  setInteractionMode: (mode: KestrelOneInteractionMode) => void;
  setShowCreditCardAlert: Dispatch<SetStateAction<boolean>>;
}) {
  return {
    onData: (dataPart: DataUIPart<CustomUIDataTypes>) => {
      if (dataPart.type === "data-chat-title") {
        input.setThreadTitle(dataPart.data.title);
        return;
      }

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

      if (dataPart.type === "data-interaction-mode") {
        input.setInteractionMode(dataPart.data.mode);
        return;
      }

      input.setDataStream((current) => [...current, dataPart]);
    },
    onFinish: () => {
      input.mutate(`/api/threads/${input.threadId}`);
      input.mutate("/api/threads?limit=30");
      input.mutate("/api/threads?limit=100");
      input.mutate(unstable_serialize(getThreadHistoryPaginationKey));
      void input.refreshConversationState?.().catch(() => {});
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
  archived,
  attachments,
  canManage,
  threadId,
  clearError,
  currentModelId,
  feedbackByMessageId,
  headerReadonly,
  input,
  interactionMode,
  isReadonly,
  messages,
  onFeedbackChange,
  onModelChange,
  onInteractionModeChange,
  regenerate,
  selectedVisibilityType,
  sendMessage,
  queueMessage,
  conversationState,
  onInterrupt,
  onRefreshConversationState,
  onRuntimeInteractionResponse,
  setAttachments,
  setInput,
  setMessages,
  showPendingAssistant,
  status,
  activeEnvironment,
  modelScopeQuery,
  project,
  projects,
  threadTitle,
  threadExists,
  newTurnDisabledReason,
}: {
  addToolApprovalResponse: ChatController["addToolApprovalResponse"];
  archived: boolean;
  attachments: Attachment[];
  canManage: boolean;
  threadId: string;
  clearError: () => void;
  currentModelId: string;
  feedbackByMessageId: Record<string, MessageFeedback | undefined>;
  headerReadonly: boolean;
  input: string;
  interactionMode: KestrelOneInteractionMode;
  isReadonly: boolean;
  messages: ChatMessage[];
  onFeedbackChange: (
    messageId: string,
    feedback: "positive" | "negative" | null
  ) => void;
  onModelChange: (modelId: string) => void;
  onInteractionModeChange: (mode: KestrelOneInteractionMode) => void;
  regenerate: ChatController["regenerate"];
  selectedVisibilityType: VisibilityType;
  sendMessage: ChatController["sendMessage"];
  queueMessage?: (
    message: ChatMessage,
    interactionMode: KestrelOneInteractionMode
  ) => void;
  conversationState: ThreadConversationState;
  onInterrupt?: () => Promise<void>;
  onRefreshConversationState: () => Promise<void>;
  onRuntimeInteractionResponse: (
    interaction: RuntimeInteractionResponse
  ) => Promise<void>;
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  setInput: Dispatch<SetStateAction<string>>;
  setMessages: ChatController["setMessages"];
  showPendingAssistant?: boolean;
  status: ChatController["status"];
  activeEnvironment?: { id: string; name: string };
  modelScopeQuery?: string;
  project?: { id: string; name: string } | null;
  projects: Array<{ id: string; name: string }>;
  threadTitle?: string;
  threadExists: boolean;
  newTurnDisabledReason?: string;
}) {
  const isArtifactVisible = useArtifactSelector((state) => state.isVisible);

  return (
    <>
      <div
        className="overscroll-behavior-contain flex h-full min-h-0 min-w-0 touch-pan-y flex-col overflow-hidden bg-background"
        data-slot="thread-shell"
      >
        <ChatHeader
          archived={archived}
          canManage={canManage}
          isReadonly={headerReadonly}
          project={project}
          projects={projects}
          selectedVisibilityType={selectedVisibilityType}
          threadId={threadId}
          threadTitle={threadTitle}
        />

        <Messages
          addToolApprovalResponse={addToolApprovalResponse}
          conversationState={conversationState}
          feedbackByMessageId={feedbackByMessageId}
          isArtifactVisible={isArtifactVisible}
          isReadonly={isReadonly}
          messages={messages}
          onFeedbackChange={onFeedbackChange}
          onRefreshConversationState={onRefreshConversationState}
          onRuntimeInteractionResponse={onRuntimeInteractionResponse}
          regenerate={regenerate}
          selectedModelId={currentModelId}
          setMessages={setMessages}
          showPendingAssistant={showPendingAssistant}
          status={status}
          threadId={threadId}
        />

        {isReadonly || !threadExists ? null : (
          <InteractionPanel
            interactions={conversationState.interactions.filter(
              (interaction) =>
                interaction.status === "pending" && interaction.turnId === null
            )}
            onResolved={onRefreshConversationState}
            onRuntimeResponse={onRuntimeInteractionResponse}
            threadId={threadId}
          />
        )}

        <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 bg-background px-2 pb-3 md:px-4 md:pb-4">
          {!isReadonly && (
            <MultimodalInput
              activeEnvironmentName={activeEnvironment?.name}
              attachments={attachments}
              clearError={clearError}
              conversationState={conversationState}
              input={input}
              interactionMode={interactionMode}
              messages={messages}
              modelScopeQuery={modelScopeQuery}
              newTurnDisabledReason={newTurnDisabledReason}
              onInterrupt={onInterrupt}
              onModelChange={onModelChange}
              onInteractionModeChange={onInteractionModeChange}
              onRuntimeInteractionResponse={onRuntimeInteractionResponse}
              queueMessage={queueMessage}
              selectedModelId={currentModelId}
              selectedVisibilityType={selectedVisibilityType}
              sendMessage={sendMessage}
              setAttachments={setAttachments}
              setInput={setInput}
              setMessages={setMessages}
              status={status}
              threadId={threadId}
            />
          )}
        </div>
      </div>

      <Artifact
        addToolApprovalResponse={addToolApprovalResponse}
        feedbackByMessageId={feedbackByMessageId}
        isReadonly={isReadonly}
        messages={messages}
        onFeedbackChange={onFeedbackChange}
        regenerate={regenerate}
        selectedVisibilityType={selectedVisibilityType}
        sendMessage={sendMessage}
        setMessages={setMessages}
        status={status}
        threadId={threadId}
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
  projectId,
  projectName,
  activeEnvironment,
  newTurnDisabledReason,
}: {
  id: string;
  initialChatModel: string;
  projectId?: string;
  projectName?: string;
  activeEnvironment?: { id: string; name: string };
  newTurnDisabledReason?: string;
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
      newTurnDisabledReason ||
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
      threadId: id,
      ...(projectId ? { projectId } : {}),
      messageId,
      messageParts: userMessage.parts,
      modelId: shared.currentModelIdRef.current,
      interactionMode: shared.interactionModeRef.current,
      createdAt: Date.now(),
      pendingAssistant: true,
    });

    router.replace(`/threads/${id}`);
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
        activeEnvironment={activeEnvironment}
        addToolApprovalResponse={async () => {}}
        archived={false}
        attachments={shared.attachments}
        canManage={false}
        clearError={() => {
          shared.setDataStream([]);
        }}
        conversationState={emptyThreadConversationState}
        currentModelId={shared.currentModelId}
        feedbackByMessageId={{}}
        headerReadonly={true}
        input={shared.input}
        interactionMode={shared.interactionMode}
        isReadonly={false}
        messages={[]}
        modelScopeQuery={
          projectId ? `&projectId=${encodeURIComponent(projectId)}` : undefined
        }
        newTurnDisabledReason={newTurnDisabledReason}
        onFeedbackChange={() => {}}
        onModelChange={shared.setCurrentModelId}
        onInteractionModeChange={shared.setInteractionMode}
        onRefreshConversationState={async () => {}}
        onRuntimeInteractionResponse={async () => {}}
        project={
          projectId && projectName ? { id: projectId, name: projectName } : null
        }
        projects={[]}
        regenerate={async () => {}}
        selectedVisibilityType="private"
        sendMessage={sendBootstrapMessage}
        setAttachments={shared.setAttachments}
        setInput={shared.setInput}
        setMessages={() => {}}
        showPendingAssistant={false}
        status="ready"
        threadExists={false}
        threadId={id}
        threadTitle="New Thread"
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
  initialConversationState,
  isReadonly,
  canPublish = true,
  canManage = false,
  archived = false,
  activeEnvironment,
  project,
  projects = [],
  threadTitle,
  newTurnDisabledReason,
}: {
  id: string;
  initialMessages: ChatMessage[];
  initialChatModel: string;
  initialVisibilityType: VisibilityType;
  initialShareToken?: string | null;
  initialChatExists: boolean;
  initialConversationState: ThreadConversationState;
  isReadonly: boolean;
  canPublish?: boolean;
  canManage?: boolean;
  archived?: boolean;
  activeEnvironment?: { id: string; name: string };
  project?: { id: string; name: string } | null;
  projects?: Array<{ id: string; name: string }>;
  threadTitle?: string;
  newTurnDisabledReason?: string;
}) {
  const { resetArtifact, setMetadata } = useArtifact();
  const { setDataStream } = useDataStream(id);
  const { visibilityType } = useChatVisibility({
    threadId: id,
    initialVisibilityType,
    initialShareToken,
  });
  const { mutate } = useSWRConfig();
  const shared = useSharedChatState(initialChatModel, id);
  const hasShownResumeWarningRef = useRef(false);
  const hasShownResumedToastRef = useRef(false);
  const hasShownStreamWarningRef = useRef(false);
  const hasStartedHandoffRequestRef = useRef(false);
  const [liveThreadTitle, setLiveThreadTitle] = useState(threadTitle);
  const [chatExists, setChatExists] = useState(initialChatExists);
  const [queuedMessages, setQueuedMessages] = useState<QueuedUserMessage[]>([]);
  const [conversationState, setConversationState] = useState(
    initialConversationState
  );
  const resumeTurnIdRef = useRef<string | null>(null);
  const streamedTurnIdRef = useRef<string | null>(
    initialConversationState.turns.find(
      (turn) =>
        turn.id === initialConversationState.queue.activeTurnId &&
        (turn.status === "queued" || turn.status === "running")
    )?.id ?? null
  );
  const [handoff, setHandoff] = useState<
    ChatFirstTurnHandoff | null | undefined
  >(undefined);

  useEffect(() => {
    setChatExists(initialChatExists);
    setConversationState(initialConversationState);
  }, [id, initialChatExists, initialConversationState]);

  useEffect(() => {
    setLiveThreadTitle(threadTitle);
  }, [threadTitle]);

  useEffect(() => {
    hasStartedHandoffRequestRef.current = false;
    hasShownResumeWarningRef.current = false;
    hasShownResumedToastRef.current = false;
    hasShownStreamWarningRef.current = false;
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
    if (handoff?.interactionMode) {
      shared.setInteractionMode(handoff.interactionMode);
    }
  }, [
    handoff?.interactionMode,
    handoff?.modelId,
    shared.setCurrentModelId,
    shared.setInteractionMode,
  ]);

  const refreshConversationState = useCallback(async () => {
    if (!chatExists) return;
    const response = await fetch(`/api/threads/${id}/turns`, {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof payload.error === "string"
          ? payload.error
          : "Conversation state could not be refreshed."
      );
    }
    const nextState = threadConversationStateSchema.parse(payload);
    setConversationState((current) =>
      nextState.queue.version >= current.queue.version ? nextState : current
    );
  }, [chatExists, id]);

  const callbacks = useChatCallbacks({
    currentModelId: shared.currentModelId,
    currentModelIdRef: shared.currentModelIdRef,
    hasShownResumeWarningRef,
    hasShownResumedToastRef,
    hasShownStreamWarningRef,
    mutate,
    refreshConversationState,
    setDataStream: shared.setDataStream as Dispatch<SetStateAction<unknown[]>>,
    setThreadTitle: setLiveThreadTitle,
    threadId: id,
    setInteractionMode: shared.setInteractionMode,
    setShowCreditCardAlert: shared.setShowCreditCardAlert,
  });

  const chatTransport = useMemo(
    () =>
      createChatTransport(
        shared.currentModelIdRef,
        shared.interactionModeRef,
        resumeTurnIdRef,
        (response) => {
          setChatExists(true);
          const turnId = response.headers.get("x-kestrel-turn-id")?.trim();
          if (turnId) streamedTurnIdRef.current = turnId;
        }
      ),
    [shared.currentModelIdRef, shared.interactionModeRef]
  );

  const controller = useChat<ChatMessage>({
    id,
    messages: initialMessages,
    resume: Boolean(streamedTurnIdRef.current),
    generateId: generateUUID,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    transport: chatTransport,
    ...callbacks,
  });

  const hasActiveWork = Boolean(conversationState.queue.activeTurnId);
  useEffect(() => {
    if (!chatExists) return;
    void refreshConversationState().catch(() => {});
    if (
      !(
        hasActiveWork ||
        controller.status === "submitted" ||
        controller.status === "streaming"
      )
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshConversationState().catch(() => {});
    }, 1000);
    return () => window.clearInterval(interval);
  }, [chatExists, controller.status, hasActiveWork, refreshConversationState]);

  const respondToRuntimeInteraction = useCallback(
    async (interaction: RuntimeInteractionResponse) => {
      const messageId = generateUUID();
      const turnId = conversationState.interactions.find(
        (candidate) => candidate.requestId === interaction.requestId
      )?.turnId;
      if (turnId) streamedTurnIdRef.current = turnId;
      await controller.sendMessage(
        {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text: interaction.message }],
          metadata: turnId ? { kestrelTurnId: turnId } : undefined,
        },
        {
          body: {
            interactionResponse: {
              ...interaction,
              messageId,
            },
          },
        }
      );
    },
    [controller.sendMessage, conversationState.interactions]
  );

  const interruptActiveTurn = useCallback(async () => {
    const turnId = conversationState.queue.activeTurnId;
    if (!turnId) return;
    const response = await fetch(
      `/api/threads/${id}/turns/${turnId}/interrupt`,
      { method: "POST" }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof payload.error === "string"
          ? payload.error
          : "The interrupt request could not be recorded."
      );
    }
    toast({
      type: "success",
      description: "The agent will stop at the next safe boundary.",
    });
    await refreshConversationState();
  }, [conversationState.queue.activeTurnId, id, refreshConversationState]);

  const queueMessage = useCallback(
    (
      message: ChatMessage,
      interactionMode: KestrelOneInteractionMode
    ) => {
      const queuedMessage: ChatMessage = {
        ...message,
        metadata: { ...message.metadata, deliveryState: "sending" },
      };
      setQueuedMessages((current) => [
        ...current,
        { message: queuedMessage, turnId: null },
      ]);

      void fetch(`/api/threads/${id}/turns`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": message.id,
        },
        body: JSON.stringify({
          message: { id: message.id, parts: message.parts },
          model: shared.currentModelIdRef.current,
          interactionMode,
        }),
      })
        .then(async (response) => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || typeof payload.turn?.id !== "string") {
            throw new Error(
              payload.error || "The message could not be queued."
            );
          }
          setQueuedMessages((current) =>
            current.map((item) =>
              item.message.id === message.id
                ? {
                    message: {
                      ...item.message,
                      metadata: {
                        ...item.message.metadata,
                        deliveryState: "queued",
                        kestrelTurnId: payload.turn.id,
                      },
                    },
                    turnId: payload.turn.id,
                  }
                : item
            )
          );
          void refreshConversationState().catch(() => {});
        })
        .catch((error) => {
          setQueuedMessages((current) =>
            current.filter((item) => item.message.id !== message.id)
          );
          toast({
            type: "error",
            description:
              error instanceof Error
                ? error.message
                : "The message could not be queued.",
          });
        });
    },
    [id, refreshConversationState, shared.currentModelIdRef]
  );

  useEffect(() => {
    const nextQueued = queuedMessages[0];
    if (
      resumeTurnIdRef.current ||
      controller.status !== "ready" ||
      !nextQueued?.turnId ||
      nextQueued.message.metadata?.deliveryState !== "queued"
    ) {
      return;
    }

    const { deliveryState: _deliveryState, ...metadata } =
      nextQueued.message.metadata ?? {};
    resumeTurnIdRef.current = nextQueued.turnId;
    streamedTurnIdRef.current = nextQueued.turnId;
    controller.setMessages((current) => [
      ...current,
      { ...nextQueued.message, metadata },
    ]);
    setQueuedMessages((current) => current.slice(1));
    void controller.resumeStream().finally(() => {
      if (resumeTurnIdRef.current === nextQueued.turnId) {
        resumeTurnIdRef.current = null;
      }
    });
  }, [
    controller.resumeStream,
    controller.setMessages,
    controller.status,
    queuedMessages,
  ]);

  useEffect(() => {
    const activeTurn = conversationState.turns.find(
      (turn) => turn.id === conversationState.queue.activeTurnId
    );
    if (!activeTurn) {
      streamedTurnIdRef.current = null;
      return;
    }
    if (activeTurn.status === "waiting_for_input") {
      // The waiting assistant message is complete. A subsequent exact
      // interaction response resumes this same turn with a new stream.
      streamedTurnIdRef.current = null;
      return;
    }
    if (
      controller.status !== "ready" ||
      (activeTurn.status !== "queued" && activeTurn.status !== "running") ||
      streamedTurnIdRef.current === activeTurn.id
    ) {
      return;
    }
    resumeTurnIdRef.current = activeTurn.id;
    streamedTurnIdRef.current = activeTurn.id;
    void controller.resumeStream().finally(() => {
      if (resumeTurnIdRef.current === activeTurn.id) {
        resumeTurnIdRef.current = null;
      }
    });
  }, [
    controller.resumeStream,
    controller.status,
    conversationState.queue.activeTurnId,
    conversationState.turns,
  ]);

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

    if (hasAssistantResponse) {
      setChatExists(true);
    }

    if (handoff && hasPersistedFirstUserMessage) {
      clearChatFirstTurnHandoff(id);
      setHandoff(null);
    }
  }, [handoff, id, initialChatExists, controller.messages]);

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
    void controller.sendMessage(handoffMessage, {
      body: {
        ...(handoff.projectId ? { projectId: handoff.projectId } : {}),
        interactionMode: handoff.interactionMode,
      },
    });
  }, [
    controller.messages,
    controller.sendMessage,
    controller.status,
    handoff,
    handoffMessage,
  ]);

  const feedbackByMessageId = useMemo(
    () =>
      buildFeedbackByMessageId({
        threadId: id,
        feedbackOverrides: shared.feedbackOverrides,
        messages: controller.messages,
      }),
    [id, shared.feedbackOverrides, controller.messages]
  );

  const displayMessages = useMemo(
    () => [
      ...mergeMessagesWithHandoff(controller.messages, handoff),
      ...queuedMessages.map((item) => item.message),
    ],
    [controller.messages, handoff, queuedMessages]
  );
  const showPendingAssistant =
    (Boolean(handoff?.pendingAssistant) ||
      conversationState.turns.some(
        (turn) =>
          turn.id === conversationState.queue.activeTurnId &&
          (turn.status === "queued" || turn.status === "running")
      )) &&
    controller.status === "ready" &&
    controller.messages.at(-1)?.role !== "assistant";

  if (!chatExists && handoff === undefined) {
    return <ThreadRouteLoading threadId={id} />;
  }

  if (!(chatExists || handoff)) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background px-4">
        <div
          className="max-w-md rounded-lg border bg-muted/20 px-4 py-3 text-sm"
          role="alert"
        >
          This Thread could not be opened. Start a new Thread or return to your
          Project and try again.
        </div>
      </div>
    );
  }

  return (
    <>
      <ChatShell
        activeEnvironment={activeEnvironment}
        addToolApprovalResponse={controller.addToolApprovalResponse}
        archived={archived}
        attachments={shared.attachments}
        canManage={canManage}
        clearError={() => {
          controller.clearError();
          shared.setDataStream([]);
        }}
        conversationState={conversationState}
        currentModelId={shared.currentModelId}
        feedbackByMessageId={feedbackByMessageId}
        headerReadonly={isReadonly || !canPublish}
        input={shared.input}
        interactionMode={shared.interactionMode}
        isReadonly={isReadonly}
        messages={displayMessages}
        modelScopeQuery={`&threadId=${encodeURIComponent(id)}`}
        newTurnDisabledReason={newTurnDisabledReason}
        onFeedbackChange={(messageId, feedback) => {
          shared.setFeedbackOverrides((current) => ({
            ...current,
            [messageId]: feedback,
          }));
        }}
        onInterrupt={interruptActiveTurn}
        onInteractionModeChange={shared.setInteractionMode}
        onModelChange={shared.setCurrentModelId}
        onRefreshConversationState={refreshConversationState}
        onRuntimeInteractionResponse={respondToRuntimeInteraction}
        project={project}
        projects={projects}
        queueMessage={queueMessage}
        regenerate={controller.regenerate}
        selectedVisibilityType={visibilityType}
        sendMessage={controller.sendMessage}
        setAttachments={shared.setAttachments}
        setInput={shared.setInput}
        setMessages={controller.setMessages}
        showPendingAssistant={showPendingAssistant}
        status={controller.status}
        threadExists={chatExists}
        threadId={id}
        threadTitle={liveThreadTitle}
      />
      <ChatAlerts
        open={shared.showCreditCardAlert}
        setOpen={shared.setShowCreditCardAlert}
      />
    </>
  );
}
