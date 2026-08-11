"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { deleteTrailingMessages } from "@/lib/chat/actions";
import {
  buildEditedMessageParts,
  hasEditedMessageContent,
} from "@/lib/chat/message-editor-model";
import type { ChatMessage } from "@/lib/types";
import { getTextFromMessage } from "@/lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export type MessageEditorProps = {
  message: ChatMessage;
  setMode: Dispatch<SetStateAction<"view" | "edit">>;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
};

export function MessageEditor({
  message,
  setMode,
  setMessages,
  regenerate,
}: MessageEditorProps) {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const [draftContent, setDraftContent] = useState<string>(
    getTextFromMessage(message)
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasContent = hasEditedMessageContent(message.parts, draftContent);

  const adjustHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`;
    }
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      adjustHeight();
    }
  }, [adjustHeight]);

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraftContent(event.target.value);
    adjustHeight();
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        aria-label="Edit message"
        className="w-full resize-none overflow-hidden rounded-xl bg-transparent text-base! outline-hidden"
        data-testid="message-editor"
        onChange={handleInput}
        ref={textareaRef}
        value={draftContent}
      />

      <div className="flex flex-row justify-end gap-2">
        <Button
          className="h-fit px-3 py-2"
          disabled={isSubmitting}
          onClick={() => {
            setMode("view");
          }}
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          className="h-fit px-3 py-2"
          data-testid="message-editor-send-button"
          disabled={isSubmitting || !hasContent}
          onClick={async () => {
            setIsSubmitting(true);
            try {
              await deleteTrailingMessages({
                id: message.id,
              });

              setMessages((messages) => {
                const index = messages.findIndex((m) => m.id === message.id);

                if (index !== -1) {
                  const updatedMessage: ChatMessage = {
                    ...message,
                    parts: buildEditedMessageParts(
                      message.parts,
                      draftContent
                    ),
                  };

                  return [...messages.slice(0, index), updatedMessage];
                }

                return messages;
              });

              await regenerate();
              setMode("view");
            } catch (error) {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "The edited message could not be sent."
              );
            } finally {
              setIsSubmitting(false);
            }
          }}
          variant="default"
        >
          {isSubmitting ? "Sending..." : "Send"}
        </Button>
      </div>
    </div>
  );
}
