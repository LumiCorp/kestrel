import equal from "fast-deep-equal";
import { memo, useState } from "react";
import { toast } from "sonner";
import { useCopyToClipboard } from "usehooks-ts";
import type { ChatMessage, MessageFeedback } from "@/lib/types";
import {
  type AssistantMessageFeedback,
  nextMessageFeedback,
  patchMessageFeedback,
} from "@/lib/chat/message-feedback";
import { cn } from "@/lib/utils";
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
  const [feedbackPending, setFeedbackPending] = useState(false);

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

  const submitFeedback = async (
    selected: Exclude<AssistantMessageFeedback, null>
  ) => {
    if (feedbackPending) return;
    const nextFeedback = nextMessageFeedback(
      feedback?.feedback ?? null,
      selected
    );
    setFeedbackPending(true);
    try {
      await patchMessageFeedback({
        messageId: message.id,
        threadId,
        feedback: nextFeedback,
      });
      onFeedbackChange(message.id, nextFeedback);
      toast.success(
        nextFeedback === null
          ? "Feedback removed"
          : nextFeedback === "positive"
            ? "Response upvoted"
            : "Response downvoted"
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Feedback could not be saved."
      );
    } finally {
      setFeedbackPending(false);
    }
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
        aria-pressed={feedback?.feedback === "positive"}
        className={cn(
          feedback?.feedback === "positive" && "text-foreground"
        )}
        data-testid="message-upvote"
        disabled={feedbackPending}
        onClick={() => void submitFeedback("positive")}
        tooltip={
          feedback?.feedback === "positive" ? "Remove upvote" : "Upvote response"
        }
      >
        <ThumbUpIcon />
      </Action>

      <Action
        aria-pressed={feedback?.feedback === "negative"}
        className={cn(
          feedback?.feedback === "negative" && "text-foreground"
        )}
        data-testid="message-downvote"
        disabled={feedbackPending}
        onClick={() => void submitFeedback("negative")}
        tooltip={
          feedback?.feedback === "negative"
            ? "Remove downvote"
            : "Downvote response"
        }
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
