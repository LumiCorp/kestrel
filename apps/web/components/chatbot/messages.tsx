import type { UseChatHelpers } from "@ai-sdk/react";
import { ArrowDownIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useMessages } from "@/hooks/use-messages";
import type { ChatMessage, MessageFeedback } from "@/lib/types";
import { useDataStream } from "./data-stream-provider";
import { Greeting } from "./greeting";
import { PreviewMessage, ThinkingMessage } from "./message";

type MessagesProps = {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  threadId: string;
  status: UseChatHelpers<ChatMessage>["status"];
  feedbackByMessageId: Record<string, MessageFeedback | undefined>;
  onFeedbackChange: (
    messageId: string,
    feedback: "positive" | "negative" | null
  ) => void;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  isArtifactVisible: boolean;
  selectedModelId: string;
  showPendingAssistant?: boolean;
};

function PureMessages({
  addToolApprovalResponse,
  threadId,
  status,
  feedbackByMessageId,
  onFeedbackChange,
  messages,
  setMessages,
  regenerate,
  isReadonly,
  selectedModelId,
  showPendingAssistant = false,
}: MessagesProps) {
  const latestAssistantMessageId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;
  const [ttsAvailable, setTtsAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let isCancelled = false;

    const loadSpeechAvailability = async () => {
      try {
        const response = await fetch(
          `/api/models/approved?pairedWith=${encodeURIComponent(selectedModelId)}&threadId=${encodeURIComponent(threadId)}`
        );

        if (!response.ok) {
          throw new Error("Failed to load approved models.");
        }

        const json = (await response.json()) as {
          pairedSpeechModel?: { id: string } | null;
        };

        if (!isCancelled) {
          setTtsAvailable(Boolean(json.pairedSpeechModel?.id));
        }
      } catch {
        if (!isCancelled) {
          setTtsAvailable(false);
        }
      }
    };

    void loadSpeechAvailability();

    return () => {
      isCancelled = true;
    };
  }, [selectedModelId]);

  const {
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    isAtBottom,
    scrollToBottom,
    hasSentMessage,
  } = useMessages({
    status,
  });

  useDataStream();

  return (
    <div className="relative flex-1 bg-background">
      <div
        className="absolute inset-0 touch-pan-y overflow-y-auto bg-background"
        ref={messagesContainerRef}
      >
        <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-4 px-2 py-4 md:gap-6 md:px-4">
          {messages.length === 0 && <Greeting />}

          {messages.map((message, index) => (
            <PreviewMessage
              addToolApprovalResponse={addToolApprovalResponse}
              feedback={feedbackByMessageId[message.id]}
              isLoading={
                status === "streaming" && messages.length - 1 === index
              }
              isReadonly={isReadonly}
              key={message.id}
              message={message}
              onFeedbackChange={onFeedbackChange}
              regenerate={regenerate}
              requiresScrollPadding={
                hasSentMessage && index === messages.length - 1
              }
              selectedLanguageModelId={selectedModelId}
              setMessages={setMessages}
              shouldAutoplaySpeech={message.id === latestAssistantMessageId}
              threadId={threadId}
              ttsAvailable={Boolean(ttsAvailable)}
            />
          ))}

          {((status === "submitted" &&
            !messages.some((msg) =>
              msg.parts?.some(
                (part) => "state" in part && part.state === "approval-responded"
              )
            )) ||
            (showPendingAssistant &&
              !messages.some((message) => message.role === "assistant"))) && (
            <ThinkingMessage />
          )}

          <div
            className="min-h-[24px] min-w-[24px] shrink-0"
            ref={messagesEndRef}
          />
        </div>
      </div>

      <button
        aria-label="Scroll to bottom"
        className={`-translate-x-1/2 absolute bottom-4 left-1/2 z-10 rounded-full border bg-background p-2 shadow-lg transition-all hover:bg-muted ${
          isAtBottom
            ? "pointer-events-none scale-0 opacity-0"
            : "pointer-events-auto scale-100 opacity-100"
        }`}
        onClick={() => scrollToBottom("smooth")}
        type="button"
      >
        <ArrowDownIcon className="size-4" />
      </button>
    </div>
  );
}

export const Messages = PureMessages;
