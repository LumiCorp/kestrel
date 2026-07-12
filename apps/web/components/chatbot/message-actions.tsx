import equal from "fast-deep-equal";
import { memo } from "react";
import { toast } from "sonner";
import { useCopyToClipboard } from "usehooks-ts";
import type { ChatMessage, MessageFeedback } from "@/lib/types";
import { Action, Actions } from "./elements/actions";
import { CopyIcon, PencilEditIcon, ThumbDownIcon, ThumbUpIcon } from "./icons";
import { MessageSpeechControl } from "./message-speech-control";

export function PureMessageActions({
  threadId,
  message,
  feedback,
  onFeedbackChange,
  isLoading,
  setMode,
  shouldAutoplaySpeech = false,
  selectedLanguageModelId,
  ttsAvailable = true,
}: {
  threadId: string;
  message: ChatMessage;
  feedback: MessageFeedback | undefined;
  onFeedbackChange: (
    messageId: string,
    feedback: "positive" | "negative" | null
  ) => void;
  isLoading: boolean;
  setMode?: (mode: "view" | "edit") => void;
  shouldAutoplaySpeech?: boolean;
  selectedLanguageModelId?: string;
  ttsAvailable?: boolean;
}) {
  const [_, copyToClipboard] = useCopyToClipboard();

  if (isLoading) {
    return null;
  }

  const textFromParts = message.parts
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  const handleCopy = async () => {
    if (!textFromParts) {
      toast.error("There's no text to copy!");
      return;
    }

    await copyToClipboard(textFromParts);
    toast.success("Copied to clipboard!");
  };

  // User messages get edit (on hover) and copy actions
  if (message.role === "user") {
    return (
      <Actions className="-mr-0.5 justify-end">
        <div className="relative">
          {setMode && (
            <Action
              className="-left-10 absolute top-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/message:opacity-100"
              data-testid="message-edit-button"
              onClick={() => setMode("edit")}
              tooltip="Edit"
            >
              <PencilEditIcon />
            </Action>
          )}
          <Action onClick={handleCopy} tooltip="Copy">
            <CopyIcon />
          </Action>
        </div>
      </Actions>
    );
  }

  return (
    <Actions className="-ml-0.5">
      {ttsAvailable ? (
        <MessageSpeechControl
          autoPlay={shouldAutoplaySpeech}
          languageModelId={selectedLanguageModelId}
          messageId={message.id}
        />
      ) : null}
      <Action onClick={handleCopy} tooltip="Copy">
        <CopyIcon />
      </Action>

      <Action
        data-testid="message-upvote"
        disabled={feedback?.feedback === "positive"}
        onClick={() => {
          const nextFeedback =
            feedback?.feedback === "positive" ? null : "positive";
          const upvote = fetch(`/api/messages/${message.id}/feedback`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              threadId,
              feedback: nextFeedback,
            }),
          });

          toast.promise(upvote, {
            loading: "Upvoting Response...",
            success: () => {
              onFeedbackChange(message.id, nextFeedback);

              return "Upvoted Response!";
            },
            error: "Failed to upvote response.",
          });
        }}
        tooltip="Upvote Response"
      >
        <ThumbUpIcon />
      </Action>

      <Action
        data-testid="message-downvote"
        disabled={feedback?.feedback === "negative"}
        onClick={() => {
          const nextFeedback =
            feedback?.feedback === "negative" ? null : "negative";
          const downvote = fetch(`/api/messages/${message.id}/feedback`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              threadId,
              feedback: nextFeedback,
            }),
          });

          toast.promise(downvote, {
            loading: "Downvoting Response...",
            success: () => {
              onFeedbackChange(message.id, nextFeedback);

              return "Downvoted Response!";
            },
            error: "Failed to downvote response.",
          });
        }}
        tooltip="Downvote Response"
      >
        <ThumbDownIcon />
      </Action>
    </Actions>
  );
}

export const MessageActions = memo(
  PureMessageActions,
  (prevProps, nextProps) => {
    if (!equal(prevProps.feedback, nextProps.feedback)) {
      return false;
    }
    if (prevProps.isLoading !== nextProps.isLoading) {
      return false;
    }
    if (prevProps.shouldAutoplaySpeech !== nextProps.shouldAutoplaySpeech) {
      return false;
    }
    if (
      prevProps.selectedLanguageModelId !== nextProps.selectedLanguageModelId
    ) {
      return false;
    }
    if (prevProps.ttsAvailable !== nextProps.ttsAvailable) {
      return false;
    }

    return true;
  }
);
